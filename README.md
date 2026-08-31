# @upstash/blob

SDK for [Upstash Blob](https://upstash.com): server uploads, direct browser uploads, and React hooks.

```bash
npm install @upstash/blob
```

## Server

```ts
import { Bucket } from '@upstash/blob';

const bucket = Bucket.fromEnv(); // reads UPSTASH_BLOB_TOKEN
// or: new Bucket({ token: '...' })

const blob = await bucket.put('avatars/me.png', file, { contentType: 'image/png' });
blob.url; // https://b<hash>.blob.upstash.io/avatars/me.png — undefined on a private bucket
blob.contentType; // what it was stored as

await bucket.get('avatars/me.png');
await bucket.list({ prefix: 'avatars/' });
await bucket.del('avatars/me.png');
```

`Bucket.fromEnv(name?, options?)` takes the same options as the constructor. Credentials are cached
per token for the whole process, so calling it per request does not mint one per request. If the
credential service asks for a backoff longer than a request can sit through, the call fails with
`mint_backoff` carrying `retryAfter` rather than blocking on it.

A `put()` body over 16 MB goes up as a multipart upload: that is the only way past R2's ~5 GiB
single-PUT cap, and a part that fails can be retried on its own. (A browser upload is always
multipart, whatever it weighs: see below.) `{ multipart: false }` forces one PUT, and
`overwrite: false` / `ifUnchanged` are single-PUT only, so they turn it off by themselves. A
multipart put that fails aborts itself rather than leaving parts behind.

Object metadata is printable ASCII: R2 hands anything else back re-encoded (`café` reads as
`=?utf-8?Q?caf=C3=A9?=`), so the SDK refuses it with `invalid_input` rather than storing a value you
cannot read back. Percent-encode first.

### Signed reads

```ts
const { url, expiresAt } = await bucket.signedRead('private/report.pdf');
await bucket.signedReadUrl('private/report.pdf'); // the url alone

// saves as report.pdf instead of opening in the tab
await bucket.signedReadUrl('u/7/9f3c2a', { downloadAs: 'report.pdf' });
```

The link is signed with the bucket's temporary credential and cannot outlive it. That cap moves:
the credential service serves one credential until it is nearly out, so the longest signable link is
anywhere from ~30 s to ~10 min (measured 2026-08-25: a fresh mint came back with 199 s on it).
Nothing has to be asked in advance -- `expiresAt` is the answer, per link.

- No `expiresIn` asks for the shorter of 5 minutes and the cap.
- If `expiresIn` is longer than the credential can currently sign, the SDK transparently uses the
  available duration. `expiresAt` is when the link really dies, so cache it until then.
- If the backend later ships a long-lived signing credential, it is used for reads automatically and
  the cap goes up.
- `downloadAs` puts the file name on the link as `response-content-disposition`, signed with the
  rest of it: send the browser straight to storage and the file saves under that name, with no route
  of your own to stream the bytes through. It is written the RFC 6266 way -- an ASCII `filename` and
  an RFC 8187 `filename*` --
  so a name with a space, a quote, an emoji or a newline in it arrives whole and cannot add a header.
- `contentType` overrides what the object answers with as `Content-Type`, for a blob stored as
  `application/octet-stream` that you want a browser to render.

A public URL needs no request: `bucket.publicUrl(path)` computes it from the bucket token and returns
`undefined` for a bucket declared private.

### Private buckets

`new Bucket({ token, private: true })` drops `url` and `versionedUrl` from every
`BlobObject`: nothing serves a private bucket over the public host, so a url there is a link that
404s. Reads go through `signedRead()`. If the credential service reports the visibility itself, that
wins over the option.

### Incomplete uploads

A multipart upload that was started and never finished is billed storage that `list()` cannot see,
and a bucket cannot be deleted while one exists. The SDK aborts the ones it knows about: a `put()`
that throws mid-stream, an upload the browser cancels, an upload a callback refuses. The one that
survives is the tab that closed, so a cron reaps it:

```ts
// list + abort, in one call: returns the uploads it aborted
await bucket.abortStaleUploads({ olderThan: '1d', prefix: 'uploads/' });

// or look first, and abort a specific one
const open = await bucket.listMultipartUploads({ prefix: 'uploads/' });
await bucket.abortMultipart(open[0]);   // { path, uploadId }
```

`del({ prefix })` refuses an empty prefix unless you say you mean it: `del({ prefix: '', all: true })`.

## Direct browser uploads

`uploadHandler` is the direct-browser-upload path. It authorizes and presigns an upload, the browser
sends multipart parts straight to storage, and the handler completes the object and runs your
callback. Application servers do not carry the file bytes.

```ts
// lib/uploads.ts
import 'server-only';
import { Bucket, uniquePath, uploadHandler } from '@upstash/blob';

export const uploads = uploadHandler({
  bucket: Bucket.fromEnv(),
  constraints: { maxBytes: '20mb', contentTypes: ['image/*', 'application/pdf'] },
  context: (request) => requireUser(request),
  onBeforeUpload: ({ ctx, file }) => ({ path: uniquePath`${ctx.id}/${file.name}` }),
  onUploadComplete: ({ ctx, path, url, size, uploadId }) =>
    db.files.insertOrReturn({ uploadId, owner: ctx.id, path, url, size }),
});
```

```ts
// app/api/upload/route.ts
import { uploads } from '@/lib/uploads';
export const runtime = 'nodejs';
export const { GET, POST } = uploads;
```

```ts
// lib/upload-client.ts
'use client';
import { createUploadHooks } from '@upstash/blob/react';
import type { uploads } from './uploads';

export const { useUpload } = createUploadHooks<typeof uploads>({
  headers: () => ({ authorization: `Bearer ${getToken()}` }),
  onError: ({ error }) => { if (error.code === 'unauthorized') signOut(); },
});
```

```tsx
const { start, upload, accept } = useUpload();
<input type="file" accept={accept} onChange={(event) => start({ file: event.target.files?.[0] })} />;
```

`useUpload(route, options?)` takes a named route first; a handler with no `routes` uses
`useUpload(options?)`. A route name resolves against `/api/upload` by default, while a string
starting with `/` or `http` is used as an explicit URL. `createUploadHooks` can set another
`endpoint`, shared `headers`, concurrency, and `onError`; call-site options win, and both error
handlers run. Headers functions are re-read for every request so rotated credentials are not cached.

The result includes the newest `upload`, the full `uploads` list, and `clear(id?)`. `accept` joins the
route's content types for a picker, while `constraints` exposes the same document numerically after
GET answers. A done record carries `blob`, `uploadedAt` as a `Date`, and `blob.data` typed from that
route's `onUploadComplete`. Direct records expose `pause`, `resume`, `retry`, `cancel`, `canPause`,
and `stalled`.

`status` is for display. Gate on `pending` and read the payload with `?.`: a state that carries no
`blob`, `response` or `error` declares it `undefined` rather than omitting it, so no narrowing is
needed. `pending` covers queued, uploading, finishing and paused, which is the partition a picker or
a progress bar actually wants -- spelling it out from `status` is how an input gets re-enabled during
`finishing` and how a progress bar ends up drawn under an error line.

Every direct upload is multipart, including a file that fits in one part. The object does not exist
until completion. Upload records support progress, pause, resume, cancel, retry, and a `finishing`
state while the route completes the multipart upload and runs
`onUploadComplete`. `percent` remains at 99 during that state.

`onUploadComplete` delivery is at-least-once: a successful response can be lost and retried. Its
`uploadId` is stable, so enforce it as a unique database key and atomically insert-or-return.
If the callback throws, the handler attempts to delete the completed object before answering the
error. As with every cross-service operation, abrupt process death cannot make object storage and
your database transactional.

### Named routes

A handler can mount several direct upload routes at one endpoint:

```ts
export const uploads = uploadHandler({
  bucket: publicBucket,
  constraints: { maxBytes: '20mb' },
  context: (request) => requireUser(request),
  onBeforeUpload: ({ ctx, route, file }) => ({ path: uniquePath`${route}/${ctx.id}/${file.name}` }),
  onUploadComplete: saveRow,
  routes: {
    attachment: { constraints: { contentTypes: ['image/*', 'application/pdf'] } },
    large: { bucket: privateBucket, constraints: { maxBytes: '2gb' } },
  },
});
```

```tsx
const attachment = useUpload('attachment');
const large = useUpload('large');
```

The name is sent as `?route=attachment`. Handler-level `bucket`, `constraints`, `input`, and
callbacks are defaults; a route replaces them key by key. A route constraint set may use `null` to
clear a handler default. Route names must match `/^[A-Za-z_][\w-]*$/`.

`GET` serves `{ constraints }` with an ETag and `max-age=60`. The hook uses it for `accept`, the
numeric `constraints` result, and an early size refusal; the server is authoritative.

`contentTypes` is an allow list checked against the media type the browser declares. The client also
sends the file's first bytes with phase 'begin', so a file whose bytes prove a different type is
refused before a multipart exists. Treat that byte check as ergonomics, not a control: the part
bodies go straight to storage and never reach your server, so a client is free to send an honest
head and upload something else. What is stored and served is the declared type either way. It is
not malware scanning or a general security scan.

`context` runs once per POST request and does not run for the public cacheable GET. Write it above
callbacks that read `ctx`; TypeScript reads an object literal top to bottom. `onError` can map an
error to a `BlobError` or `Response` and receives as much state as the request reached.

### Inputs and typed state

`upload()` adds a Standard Schema input and typed per-route state:

```ts
const thread = upload<Session>()({
  input: z.object({ threadId: z.string() }),
  onBeforeUpload: ({ ctx, input, file }) => ({
    path: uniquePath`${ctx.id}/${input.threadId}/${file.name}`,
    state: { originalName: file.name },
  }),
  onUploadComplete: ({ ctx, state, path }) =>
    db.files.insert({ owner: ctx.id, name: state.originalName, path }),
});
```

`start({ file, input })` is typed to that schema and the server validates it before
`onBeforeUpload`. Use `BeforeUploadArgs`, `UploadCompleteArgs`, and `UploadContext` for callbacks
extracted into another file.

### Without React

```ts
import { upload } from '@upstash/blob/browser';
const task = upload(file, { route: '/api/upload' });
const blob = await task.done;
```

The browser task also exposes progress, pause, resume, cancel, retry, and subscriptions. A part PUT
with no progress for 60 seconds is aborted and retried. A cross-origin PUT refused before sending
bytes fails after three attempts with a CORS-oriented message instead of backing off for minutes.

## Explicit server uploads

For a small upload whose bytes must pass through your application before storage, write an ordinary
server route and call `Bucket.put(path, body, options)`. This is intentionally separate from
`uploadHandler`: your route owns its request encoding, body cap, authentication, state changes, and
response JSON.

```ts
// app/api/avatar/route.ts
import { BlobError, Bucket } from '@upstash/blob';

const bucket = Bucket.fromEnv();

export async function POST(request: Request) {
  try {
    const user = await requireUser(request);
    const form = await request.formData();
    const file = form.get('file');
    if (!(file instanceof File)) throw new BlobError('invalid_input', { message: 'file field required' });

    const blob = await bucket.put(`avatar/${user.id}`, file, {
      contentType: file.type,
      contentTypes: ['image/png', 'image/jpeg', 'image/webp'],
      maxBytes: '2mb',
      // A stable path that is overwritten: keep the copy, check it. An unchanged avatar is a 304
      // with no body. 'immutable' belongs on a versioned path, a max-age on neither.
      cache: 'revalidate',
    });
    await db.users.update(user.id, { avatarEtag: blob.etag });
    return Response.json({ blob });
  } catch (error) {
    if (BlobError.is(error)) return Response.json(error.toJSON(), { status: error.status });
    throw error;
  }
}
```

`cache` takes `'immutable'`, `'revalidate'`, `'no-store'` or a duration, and emits `private` instead
of `public` when the bucket is private. Anything containing `=` or `,` is a cache-control header and
is stored exactly as written, so `s-maxage`, `stale-while-revalidate` and `no-transform` need no
option of their own:

```ts
cache: '1h'                                        // public, max-age=3600
cache: 'revalidate'                                // public, max-age=0, must-revalidate
cache: 'public, max-age=60, s-maxage=31536000'     // yours, verbatim
```

Keep the limit below the hosting platform's request-body cap. `request.formData()` buffers the
multipart body. `Bucket.put` also buffers an unknown-length `Request` or `ReadableStream` up to
`maxBytes` to determine the content length; pass `size` when it is known to avoid that buffering.
`contentTypes` here is checked against the bytes themselves, which `put` has in hand before it
stores anything, so a mislabelled body is refused rather than stored. The check refuses only a
proven conflict: bytes that prove nothing pass, and a type whose signature names a container passes
too, because a .docx really is a zip. It is not malware scanning.

A stable key gives last-write-wins behavior under concurrent requests. If a database update after
`put` fails, blindly deleting the key can delete a newer concurrent upload. Use an immutable/versioned
key plus a conditional pointer update when that transaction matters, or reconcile the stable key
instead of claiming callback-style rollback.

`useServerUpload` sends one ordinary POST with upload progress, cancellation, configurable headers,
a concurrency queue, `File`/raw `Blob`/`FormData` support, platform body-cap hints for bare 413s, and
`BlobError` JSON decoding. The successful route JSON is returned unchanged:

```tsx
import { useServerUpload } from '@upstash/blob/react';

const { start, upload } = useServerUpload<{ blob: { versionedUrl?: string } }>('/api/avatar', {
  headers: () => ({ authorization: `Bearer ${getToken()}` }),
});
start({ file }); // multipart field "file"
start({ body: file }); // raw body
console.log(upload?.response?.blob.versionedUrl, upload?.error?.message, upload?.pending);
```

Configure `useServerUpload` directly; it is not part of `HandlerRoutes` or `createUploadHooks`.

## Errors and sizes

Everything that fails, on either side of the wire, throws a `BlobError` with a `code` from a closed
list, a `status`, and a `message` written to be printed as it stands: it is sentence-cased at
construction, and the hint (when there is one) is already folded into it. A message that opens with
an identifier -- a MIME type, a file name, a metadata key -- keeps its case, so `text/html is not
allowed` is never `Text/html`.

```ts
import { BlobError } from '@upstash/blob'; // also from /react and /browser

try {
  await bucket.put(path, body, { maxBytes: '2mb' });
} catch (e) {
  if (BlobError.is(e) && e.code === 'too_large') showError(e.message); // "The body is 3.1 MB, over the 2 MB limit"
  else throw e;
}
```

An upload route names the file instead -- `cat.png is 3.1 MB, over the 2 MB limit` -- and that one
keeps its lowercase `c`, because the first word is the file, not a sentence.

`BlobError.is()` rather than `instanceof`: an ESM and a CJS copy of the package are two classes. A
route answers with `e.toJSON()` and the browser rebuilds it, so `error.code` in a hook is the code
the server raised, not a status number to match on.

`formatBytes(bytes)` is the size formatter the SDK's own messages use, exported from
`@upstash/blob`, `@upstash/blob/react` and `@upstash/blob/browser` so a page states a limit the same
way the refusal does. Decimal, like every size the SDK parses and every provider's bill:
`formatBytes(20_000_000)` is `'20 MB'`, `formatBytes(512)` is `'512 B'`. The `Size` strings that go
the other way (`'20mb'`, `'2gb'`) are decimal for the same reason.

## Telemetry

Requests to Upstash carry the SDK version, runtime, and platform. Set `UPSTASH_DISABLE_TELEMETRY`
in the environment or pass `new Bucket({ token, enableTelemetry: false })` to turn it off. Setting
the variable to `false`, `0`, `no` or `off` does not turn it off, it leaves it on.

## License

[MIT](./LICENSE)
