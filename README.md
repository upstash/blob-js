# @upstash/blob

SDK for [Upstash Blob](https://upstash.com): server uploads, direct browser uploads, and React hooks.

```bash
npm install @upstash/blob
```

## Server

```ts
import { Bucket } from '@upstash/blob';

const bucket = Bucket.fromEnv(); // reads UPSTASH_BLOB_TOKEN, or new Bucket({ token })

const blob = await bucket.put('avatars/me.png', file, { contentType: 'image/png' });
blob.url;                                    // undefined on a private bucket
blob.etag;

await bucket.get('avatars/me.png');          // record + ReadableStream body
await bucket.info('avatars/me.png');         // same record, no bytes
await bucket.exists('avatars/me.png');       // false instead of a throw
await bucket.list({ prefix: 'avatars/', limit: 100 });   // { blobs, cursor }
await bucket.copy('tmp/9f3c', 'avatars/7.png');
await bucket.move('tmp/9f3c', 'avatars/7.png', { contentType: 'image/png' });
await bucket.del('a.png');                   // or ['a.png', 'b.png'], or { prefix: 'tmp/' }
await bucket.updateJson<Settings>('u/7.json', (prev) => ({ ...(prev ?? {}), theme: 'dark' }));
```

- `get` and `info` throw `not_found` rather than returning `undefined`; `list` returns keys, sizes,
  etags and urls, without metadata. `cursor` is set only while more remains.
- A body over 16 MB goes up as multipart; `{ multipart: '100mb' | true | false }` moves the line.
  `allowOverwrite: false` and `ifUnchanged` are single-PUT only.
- `updateJson` is a compare-and-set loop (`If-Match`, or `If-None-Match: *` when nothing is there),
  retried on conflict with a short jittered pause, up to `maxAttempts` times (default 6).
- `copy` and `move` take `{ contentType, cache, metadata }`; whatever is not given is carried over
  from the source. Storage has no rename, so `move` is a copy plus a delete: a failed delete throws
  `move_left_a_copy`, destination kept.
- `del({ prefix: '' })` needs `all: true`. A partial array delete throws `partial_delete`.
- Metadata is printable ASCII; anything else is refused with `invalid_input`.
- `cache` takes `'immutable'`, `'revalidate'`, `'no-store'`, a duration, or a verbatim header.
- `Bucket.fromEnv()` reads `UPSTASH_BLOB_TOKEN`. It takes the constructor's options alone,
  `fromEnv({ cache: 'immutable' })`, or a variable name first, `fromEnv('MEDIA_TOKEN', { cache })`.

### Signed URLs

```ts
const { url, expiresAt } = await bucket.signedReadUrl('private/report.pdf', { downloadAs: 'report.pdf' });
const upload = await bucket.signedUploadUrl('u/7/report.pdf', { contentType: 'application/pdf', size });
await fetch(upload.url, { method: 'PUT', headers: upload.headers, body });
```

Links are signed with the bucket's short-lived credential and cannot outlive it, so `expiresAt` is
the answer per link (default read: 5 minutes, capped). `headers` on an upload URL are pinned into
the signature. `bucket.publicUrl(path)` is `undefined` on a private bucket.

Whether a bucket is private is decided in the console, not in code: the SDK learns it from the
backend on the first request, and a private bucket has no `url` or `versionedUrl` on any
BlobObject. Reads there go through `signedReadUrl()`.

### Incomplete uploads

A multipart upload that was never finished is invisible to `list()` and blocks bucket deletion. The
SDK aborts the ones it knows about; a closed tab leaves one behind, so run a cron:

```ts
await bucket.abortStaleMultipartUploads({ olderThan: '1d', prefix: 'uploads/' });
```

Under the threshold there is nothing to abort: the browser's PUT already stored the object, so an
abandoned upload is an ordinary, billed, listable object. The `upstash-upload` metadata key stays on
accepted objects too, so it says "came from that upload", never "no callback took it" -- track state
in your own rows (pending in `onBeforeUpload`, ready last in `onUploadComplete`, sweep the rest), or
set `multipart: true` so nothing is stored until the handler completes it.

## Direct browser uploads

Bytes go straight to storage; your server only authorizes, signs, and records.

```ts
// lib/uploads.ts
import 'server-only';
import { BlobError, uniquePath, uploadHandler } from '@upstash/blob';

export const uploads = uploadHandler({
  constraints: { maxSize: '20mb', contentTypes: ['image/*', 'application/pdf'] },

  onBeforeUpload: async ({ request, file }) => {
    const user = await getUser(request);
    if (!user) throw new BlobError('unauthorized'); // the 401; nothing is signed
    return { path: uniquePath`${user.id}/${file.name}`, metadata: { owner: user.id } };
  },

  onUploadComplete: async ({ metadata, url, uploadId }) => {
    // uploadId is stable across retries, so the same completion twice writes one row
    await sql`insert into files (upload_id, owner, url)
              values (${uploadId}, ${metadata.owner}, ${url})
              on conflict (upload_id) do nothing`;
  },
});

// app/api/upload/route.ts
export const { GET, POST } = uploads;
```

```tsx
'use client';
import { uploadHooks } from '@upstash/blob/react';
export const { useUpload } = uploadHooks<typeof uploads>();

const { start, upload, accept } = useUpload();
<input type="file" accept={accept} onChange={(e) => start({ file: e.target.files?.[0] })} />;
```

- `routes: { attachment: {...}, large: {...} }` mounts several routes at one endpoint;
  `useUpload('attachment')` picks one. Route options replace handler defaults key by key.
- `context: (request) => ...` runs once per POST, before any body is read, and its value is `ctx` in
  every callback. `onBeforeUpload` only runs on the first request of an upload, so `context` is how
  the user reaches `onUploadComplete` and `onError` too, and how several routes share one auth check.
  With a single route, authorizing in `onBeforeUpload` and carrying an id in `metadata` is shorter.
- No `bucket` reads `UPSTASH_BLOB_TOKEN`, like `Bucket.fromEnv()`. Pass `bucket:` when the token is
  under another variable, the bucket needs `cache`, or you are on Workers, where the
  token only exists on the request's `env`.
- `GET` serves the constraints with an ETag and `max-age=60`, for `accept` and an early refusal. The
  server is authoritative.
- A file under 16 MB is one presigned PUT, larger is multipart; only parts can pause, resume and
  retry, so `canPause` is false for a single PUT. `multipart` moves that line per handler or route.
- Records carry `status`, `percent`, `blob`, `error`, and `pending` (queued, uploading, finishing,
  paused). `blob.data` is typed from that route's `onUploadComplete`.
- `contentTypes` also checks the file's first bytes at `begin`. Ergonomics, not a control: part
  bodies never reach your server. Not malware scanning.
- The signed PUT sends `Content-Type`, `Cache-Control` and `x-amz-meta-*` as real headers, so bucket
  CORS must allow them from your origin.
- `onUploadComplete` is at-least-once, keyed by a stable `uploadId`. A throw deletes the completed
  object, so catch your own database errors instead of letting them escape.
- `uploadRoute()` adds a Standard Schema `input` and typed `state`. Without React:
  `upload(file, { route: '/api/upload' })` from `@upstash/blob/browser`.

## Explicit server uploads

For bytes that must pass through your app, write an ordinary route and call `bucket.put`. Keep the
cap under the platform's body limit; pass `size` for an unknown-length stream to avoid buffering.
`useServerUpload('/api/avatar')` from `@upstash/blob/react` sends one POST with progress,
cancellation and `BlobError` decoding, and returns the route's JSON unchanged.

## The S3 escape hatch

```ts
const { endpoint, region, bucket: name, credentials } = bucket.s3();
const s3 = new S3Client({ endpoint, region, credentials });
```

`endpoint` and `credentials` are async providers, so the aws-sdk re-reads the short-lived credential
on expiry.

## Errors

Everything throws a `BlobError` with a `code` from a closed list, a `status`, and a printable
`message`. Use `BlobError.is(e)`, not `instanceof`: an ESM and a CJS copy are two classes. A route
answers with `e.toJSON()` and the browser rebuilds it, so `error.code` in a hook is the code the
server raised. `formatBytes` is exported from all three entrypoints; sizes are decimal.

```ts
if (BlobError.is(e) && e.code === 'too_large') showError(e.message);
```

## Telemetry

Requests carry the SDK version, runtime, and platform. Set `UPSTASH_DISABLE_TELEMETRY` or pass
`enableTelemetry: false`.

## License

[MIT](./LICENSE)
