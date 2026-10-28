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

Upstash signs each link for one operation on one object, and it lives at most 10 minutes (default
read: 5 minutes, upload: 10; a longer `expiresIn` gets 10). `headers` on an upload URL are pinned
into the signature. A path with an empty segment (`dir/`, `a//b`) cannot be signed.
`bucket.publicUrl(path)` is `undefined` on a private bucket.

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
abandoned upload is an ordinary, billed, listable object. An app that lists files from the rows it
writes in `onUploadComplete` never shows one; it only costs storage. `multipart: true` stores
nothing until the handler completes the upload.

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
    return { path: uniquePath(`${user.id}/${file.name}`), metadata: { owner: user.id } };
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

`uniquePath` adds an eight-character random suffix to the final filename and keeps everything
else as given: `Alice_123/Q3 Report.pdf` becomes `Alice_123/Q3 Report-<random>.pdf`. It does not
lowercase, normalize Unicode, trim or truncate values, and it accepts slashes anywhere, so a
prefix goes in as is: ``uniquePath(`${prefix}${user.id}/${file.name}`)``. Paths with `.` or `..` segments are refused
when used. Store the returned path and authorize reads and deletes using the stored owner and
exact path.

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
on expiry. Do not presign with it: the URL would carry the credential, and with it every object in
the bucket until it expires. Use `signedReadUrl()` and `signedUploadUrl()`.

## Errors

Everything throws a `BlobError` with a `code` from a closed list, a `status`, and a printable
`message`. Use `BlobError.is(e)`, not `instanceof`: an ESM and a CJS copy are two classes. A route
answers with `e.toJSON()` and the browser rebuilds it, so `error.code` in a hook is the code the
server raised. `formatBytes` is exported from all three entrypoints and displays decimal byte units.

Size options always count bytes, never bits. Decimal units (`KB`, `MB`, `GB`, `TB`) use powers of
1,000; explicit binary units (`KiB`, `MiB`, `GiB`, `TiB`) use powers of 1,024. Unit names ignore
case. For a 32 MiB file limit, use `constraints: { maxSize: '32MiB' }` or `maxSize: 33_554_432`.
`'32mb'` remains 32,000,000 bytes; it is not large enough for a 32 MiB file.

```ts
if (BlobError.is(e) && e.code === 'too_large') showError(e.message);
```

## Telemetry

Requests carry the SDK version, runtime, and platform. Set `UPSTASH_DISABLE_TELEMETRY` or pass
`enableTelemetry: false`.

## AI agents

Use the API below; you do not need to read `src/`. Bundled docs are in
`node_modules/@upstash/blob/docs/`.

| Task | Use |
| --- | --- |
| Browser uploads (progress, cancel, retry, large files) | `uploadHandler` in a route, plus `useUpload` from `@upstash/blob/react` (the recipe below) |
| Bytes your server already has | `Bucket.fromEnv().put(path, body)` |
| Bytes that must pass through your route | an ordinary route with `bucket.put`, plus `useServerUpload` |
| Private downloads | `bucket.signedReadUrl(path)` (`url` is undefined on a private bucket) |
| Read, list, delete, copy | `bucket.get`, `info`, `list`, `del`, `copy`, `move` |

### Recipe: private, signed-in browser uploads

This is the whole feature: progress, cancel, retry and large files included. Swap `getUser` and
`db` for your own; `upstash blob create --name files --env-file .env.local` makes the private bucket.

```ts
// lib/uploads.ts
import 'server-only';
import { BlobError, uniquePath, uploadHandler } from '@upstash/blob';
import { db, getUser } from '@/lib/app'; // your session lookup and database

export const uploads = uploadHandler({
  constraints: { maxSize: '1gb' },
  // Runs on every request of an upload: a signed-out caller gets a 401.
  context: async (request: Request) => {
    const user = await getUser(request);
    if (!user) throw new BlobError('unauthorized');
    return user;
  },
  onBeforeUpload: ({ ctx, file }) => ({ path: uniquePath(`${ctx.id}/${file.name}`) }),
  // Runs once the file is stored, before the browser sees 'done'. Keyed by path: a repeat is a no-op.
  onUploadComplete: async ({ ctx, path, size, file }) => {
    await db.files.upsert({ path, ownerId: ctx.id, name: file.name, size });
    return { path, name: file.name };
  },
});

// app/api/upload/route.ts
import { uploads } from '@/lib/uploads';
export const { GET, POST } = uploads;

// app/api/files/route.ts: downloads, checked against the stored owner
import { Bucket } from '@upstash/blob';
import { db, getUser } from '@/lib/app';

export async function GET(request: Request) {
  const user = await getUser(request);
  if (!user) return new Response('sign in', { status: 401 });
  const path = new URL(request.url).searchParams.get('path') ?? '';
  const file = await db.files.get(path);
  if (file?.ownerId !== user.id) return new Response('not found', { status: 404 });
  const { url } = await Bucket.fromEnv().signedReadUrl(path, { downloadAs: file.name });
  return Response.redirect(url);
}
```

```tsx
// app/uploader.tsx
'use client';
import { uploadHooks } from '@upstash/blob/react';
import type { uploads } from '@/lib/uploads';

const { useUpload } = uploadHooks<typeof uploads>();

export function Uploader() {
  const { start, uploads: list } = useUpload();
  return (
    <>
      <input type="file" multiple onChange={(e) => start({ files: e.target.files })} />
      {list.map((u) => (
        <p key={u.id}>
          {u.file.name} <progress max={100} value={u.percent} /> {u.status}
          {u.pending && u.status !== 'finishing' && <button onClick={() => u.cancel()}>Cancel</button>}
          {u.status === 'error' && <> {u.error.message} <button onClick={() => u.retry()}>Retry</button></>}
          {u.status === 'done' && <a href={`/api/files?path=${encodeURIComponent(u.blob.data.path)}`}>{u.blob.data.name}</a>}
        </p>
      ))}
    </>
  );
}
```

After a reload, list the user's rows from `db.files`: a row exists only for a completed upload.

What the SDK already does, so you do not have to:

- You need no presign, complete or cancel routes and no client-side IDs: every request after the
  first carries a signed token for that one upload, and `context` still checks the session.
- You need no pending rows: `onUploadComplete` runs only once the stored object has the declared
  size, and the record turns `done` only after it returns.
- You need no multipart code: files over 16 MB go up in parts, 4 at a time, each retried and
  re-signed on its own.
- You need no cancel or retry plumbing: `cancel()` aborts what is in flight and has the route
  remove what landed; `retry()` continues the same upload from the parts that landed.
- An error saying the browser blocked the request before sending any bytes is CORS: add the page
  origin with `upstash blob cors <bucket> <origins...>`, which replaces the bucket's list, or in the
  Upstash Console under the bucket's CORS settings (the route logs this too).

### Edge cases the recipe already handles

- `onUploadComplete` can run twice for one upload when its last request is retried; the upsert keyed
  by path makes the second run a no-op.
- `cancel()` during `finishing` is local only and the file may still be recorded, which is why the
  recipe hides Cancel there.
- Picking a file again after a failure resumes the same upload; `context` still checks every
  request.
- A closed tab, or a cancel request that never arrives, can leave a stored file with no row (under
  16 MB) or an unfinished multipart. Neither shows, since the list comes from rows; see
  [Incomplete uploads](#incomplete-uploads).

For SDK guidance in your coding agent, install the Blob agent skill:

```bash
pnpx skills add upstash/skills --skill upstash-blob-js
```

See [installation instructions](https://upstash.com/docs/agent-resources/skills#installation) for agent-specific options.

### Development

Use pnpm 10.33.0 for dependency management and Bun for the test runner, matching the
other SDKs. Dependencies have a seven-day minimum release age.

```bash
pnpm install --frozen-lockfile
pnpm run check
pnpm run test:unit
```

`pnpm run test:live` runs against a real bucket and requires Blob credentials.

### Maintaining the docs bundle

`prepack` fetches the latest Blob docs with giget when packing or publishing. The generated
`docs/` folder is gitignored and replaced on each pack.

## License

[MIT](./LICENSE)
