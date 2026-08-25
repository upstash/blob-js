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
blob.url; // https://b<hash>.blob.upstash.io/avatars/me.png
blob.contentType; // what it was stored as

await bucket.get('avatars/me.png');
await bucket.list({ prefix: 'avatars/' });
await bucket.del('avatars/me.png');
```

`Bucket.fromEnv(name?, options?)` takes the same options as the constructor.

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
import { Bucket, handleUpload } from '@upstash/blob';

export const { GET, POST } = handleUpload({
  bucket: Bucket.fromEnv(),
  id: 'avatars', // which route a completion token belongs to
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

- **`id`** binds completion tokens to this route. Every route on one bucket signs with the same key,
  so without it a token minted by one route is spendable at another. It defaults to a hash of the
  route's limits, which collides when two routes declare the same ones: name them then.
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

const { start } = useUpload<typeof POST>({ route: '/api/upload' });
```

## Telemetry

Requests to Upstash carry the SDK version, runtime, and platform. Set `UPSTASH_DISABLE_TELEMETRY`
in the environment or pass `new Bucket({ token, enableTelemetry: false })` to turn it off. Setting
the variable to `false`, `0`, `no` or `off` does not turn it off, it leaves it on.

## License

[MIT](./LICENSE)
