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

A body over 16 MB goes up as a multipart upload: that is the only way past R2's ~5 GiB single-PUT
cap, and a part that fails can be retried on its own. `{ multipart: false }` forces one PUT, and
`overwrite: false` / `ifUnchanged` are single-PUT only, so they turn it off by themselves. A
multipart put that fails aborts itself rather than leaving parts behind.

Object metadata is printable ASCII: R2 hands anything else back re-encoded (`café` reads as
`=?utf-8?Q?caf=C3=A9?=`), so the SDK refuses it with `invalid_input` rather than storing a value you
cannot read back. Percent-encode first.

### Signed reads

```ts
const { url, expiresAt } = await bucket.signedRead('private/report.pdf');
await bucket.signedReadUrl('private/report.pdf'); // the url alone
```

The link is signed with the bucket's temporary credential and cannot outlive it. That cap moves:
the credential service serves one credential until it is nearly out, so `signedReadCap()` is
anywhere from ~30 s to ~10 min (measured 2026-08-25: a fresh mint came back with 199 s on it).

- No `expiresIn` asks for the shorter of 5 minutes and the cap, and never throws.
- An `expiresIn` over the cap throws `invalid_input` naming the cap. Pass `{ clamp: true }` to take
  the cap instead. Either way `expiresAt` is when the link really dies, so cache it until then.
- If the backend later ships a long-lived signing credential, it is used for reads automatically and
  the cap goes up.

### Private buckets

`new Bucket({ token, visibility: 'private' })` drops `url` and `versionedUrl` from every
`BlobObject`: nothing serves a private bucket over the public host, so a url there is a link that
404s. Reads go through `signedRead()`. If the credential service reports the visibility itself, that
wins over the option.

### Incomplete uploads

A multipart upload that was started and never finished is billed storage that `list()` cannot see,
and a bucket cannot be deleted while one exists. Nothing in storage expires them:

```ts
await bucket.listMultipartUploads({ prefix: 'uploads/' });
await bucket.abortMultipart(uploadId, path);
// list + abort, for a cron: sweepMultipart() is the same call under the name people look for
await bucket.abortStaleUploads({ olderThan: '1d' });
```

`del({ prefix })` refuses an empty prefix unless you say you mean it: `del({ prefix: '', all: true })`.

## Browser uploads

The file goes straight from the browser to storage, so it never passes through your server. Your
server only authorizes the upload and hears about it afterwards.

Route handler:

```ts
// app/api/upload/route.ts
import { BlobError, Bucket, handleUpload } from '@upstash/blob';

export const { GET, POST } = handleUpload({
  bucket: Bucket.fromEnv(),
  path: '/api/upload', // where it is mounted, so the client cannot name a different route
  limits: { maxBytes: '10mb', allowedContentTypes: ['image/*'] },
  onBeforeUpload: async ({ request, file }) => {
    // throw to reject the upload
    return { path: `uploads/${file.name}`, context: { rowId: await db.reserve() } };
  },
  onBeforeUploadFailed: async ({ decided }) => {
    // the upload was accepted but storage refused to start it: nothing will ever complete
    await db.release(decided.context.rowId);
  },
  onUploadCompleted: async ({ path, url, uploadId, multipartUploadId }) => {
    await db.insert({ path, url });
  },
  onError: (e) => (isPrismaTimeout(e) ? new BlobError('not_ready') : undefined),
});
```

- **`path`** is where the route is mounted. `route` on the hooks is typed to it, so naming one
  endpoint while importing another's handler type stops compiling.
- **`id`** binds completion tokens to this route. Every route on one bucket signs with the same key,
  so without it a token minted by one route is spendable at another. It defaults to a hash of the
  route's path, limits and input, which collides only when two routes declare all three the same:
  name them then.
- **`onError`** maps anything a callback threw that is not a `BlobError`. Return a `BlobError` or a
  `Response`, or nothing to let it through to the framework. An error carrying a numeric `status`
  becomes that status without this hook.
- **`onUploadCompleted`** gets `uploadId` (stable across a retried completion: dedupe on it) and
  `multipartUploadId` (R2's own id, for `bucket.abortMultipart()`; undefined for a single PUT).
- Bytes that are refused at the end, because they lied about their size or their type, are deleted
  before the error is returned: on a public bucket they were already being served.
- `GET` serves the route's limits with `max-age=60` and an ETag, so a deploy that widens them
  reaches the picker.

Client:

```ts
import { upload } from '@upstash/blob/browser';

const task = upload(file, { route: '/api/upload' });
const blob = await task.done;
blob.url;
```

`task` also gives you `pause()`, `resume()`, `cancel()` and `subscribe()` for progress. A failed
upload is not lost: `task.retry()` runs it again from the parts that already landed, and so does
picking the same file again after a reload.

A PUT that goes 60 s without a progress event is dropped and retried rather than left hanging. A PUT
the browser refuses before sending a single byte is almost always CORS, so it fails after three
attempts with that in the message instead of backing off for four minutes.

## Uploads through your own route

`handleUpload` presigns and the browser PUTs, so the bytes are checked once they are already stored.
At a path that is overwritten in place -- an avatar -- that is too late: a refused file has already
replaced the one it was refused in favour of. `handleProxyUpload` sends the bytes through your
function instead, and `put()` checks them before anything reaches the bucket.

```ts
// app/api/avatar/route.ts
import { handleProxyUpload } from '@upstash/blob';

export const { GET, POST } = handleProxyUpload({
  bucket,
  path: '/api/avatar',
  limits: { maxBytes: '2mb', allowedContentTypes: ['image/png', 'image/jpeg'] },
  onBeforeUpload: ({ request, file }) => ({ path: `avatar/${userId(request)}`, cache: '1m' }),
  onUploadCompleted: async ({ path, versionedUrl, contentType, size }) => db.upsert({ path, versionedUrl }),
});
```

Every byte crosses your function, so this is bounded by the platform's request body cap (Vercel
4.5MB, AWS Lambda 6MB, Cloudflare 100MB): keep `maxBytes` well inside it and use `handleUpload` for
anything larger. `GET` serves the same limits document, so `useUploadProxy` fills the file picker
from the route's own list and refuses an oversize file before it is sent.

## React

```tsx
import { useUpload } from '@upstash/blob/react';

function Uploader() {
  const { start, uploads } = useUpload({ route: '/api/upload' });

  return (
    <>
      <input type="file" multiple onChange={(e) => start({ files: e.target.files })} />
      {uploads.map((u) => (
        <div key={u.id}>
          {u.file.name}: {u.percent}% ({u.status})
        </div>
      ))}
    </>
  );
}
```

Pass `typeof POST` to `useUpload` to type the route's input and the data returned by
`onUploadCompleted`:

```tsx
import type { POST } from './api/upload/route';

const { start, accept } = useUpload<typeof POST>({ route: '/api/upload' });
```

`accept` is the route's own `allowedContentTypes`, for the file input, so there is no second list to
fall out of step with the one that does the refusing. `useUploadProxy` is the same hook against a
`handleProxyUpload` route:

```tsx
const { start, task } = useUploadProxy<typeof POST>({ route: '/api/avatar' });
// task.response.data is what onUploadCompleted returned; task.response.blob is the stored object
```

### Defaults

`configureUpload` returns the two hooks with your app's headers and error handling already applied.
No context and no provider, so there is nothing to render at the root of the tree; call-site options
still win, and the configured `onError` runs before the call's own rather than instead of it.

```ts
// lib/upload.ts
export const { useUpload, useUploadProxy } = configureUpload({
  headers: () => ({ authorization: `Bearer ${getToken()}` }),
  onError: ({ error }) => {
    if (error.code === 'unauthorized') signOut();
  },
});
```

`headers` is re-read per request, so an upload that outlives the current token still ends. It is
also where an app refuses its own upload: a throw from it ends the upload immediately carrying that
error, rather than being retried as a network fault.

## Telemetry

Requests to Upstash carry the SDK version, runtime, and platform. Set `UPSTASH_DISABLE_TELEMETRY`
in the environment or pass `new Bucket({ token, enableTelemetry: false })` to turn it off. Setting
the variable to `false`, `0`, `no` or `off` does not turn it off, it leaves it on.

## License

[MIT](./LICENSE)
