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

## Uploads

Every upload route in one file, mounted at one endpoint, with the name in the query. The browser
names the route and nothing else: `useUpload('avatar')` is checked against the router's own type, so
a typo does not compile and a page never spells out a url.

```ts
// lib/uploads.ts
import 'server-only';
import { Bucket, uniquePath, uploadRouter } from '@upstash/blob';

const pub = Bucket.fromEnv('UPSTASH_BLOB_PUBLIC');
const priv = Bucket.fromEnv('UPSTASH_BLOB_PRIVATE');

export const uploads = uploadRouter({
  // every route inherits these. A route's `limits` replaces per key; `null` clears one.
  bucket: pub,
  limits: { maxBytes: '20mb', allowedContentTypes: ['image/*', 'application/pdf'] },

  // runs once per request, before the route and before any body is read. What it returns is `ctx`
  // in every callback, typed. Throw to refuse: a BlobError('unauthorized') is the 401.
  context: (request) => requireUser(request),

  // observers: they hear about every route, and cannot change the answer
  onUploadCompleted: ({ route, path, size }) => log.info(route, path, size),
  onError: ({ route, error }) => log.error(route, error),

  routes: (upload) => ({
    attachment: upload({
      onBeforeUpload: async ({ ctx, file }) => {
        const row = await db.files.insert({ owner: ctx.id, name: file.name, status: 'pending' });
        return { path: uniquePath`${ctx.id}/${file.name}`, metadata: { rowId: row.id } };
      },
      onUploadCompleted: ({ metadata, url, size }) => db.files.update(metadata.rowId, { status: 'ready', url, size }),
    }),
    large: upload({
      bucket: priv,
      limits: { maxBytes: '2gb', allowedContentTypes: null },
      onBeforeUpload: ({ ctx, file }) => ({ path: uniquePath`${ctx.id}/${file.name}` }),
    }),
    avatar: upload({
      // the bytes go through your function instead of straight to storage
      proxy: true,
      limits: { maxBytes: '2mb' },
      onBeforeUpload: ({ ctx }) => ({ path: `avatar/${ctx.id}` }),
      onUploadCompleted: ({ ctx, versionedUrl }) => db.users.update(ctx.id, { avatar: versionedUrl }),
    }),
  }),
});
```

```ts
// app/api/upload/route.ts
import { uploads } from '@/lib/uploads';

export const runtime = 'nodejs';
export const { GET, POST } = uploads;
```

```ts
// lib/upload.ts
'use client';
import { createUploadHooks } from '@upstash/blob/react';
// a type-only import: the router's types cross the client boundary, its code does not
import type { uploads } from './uploads';

export const { useUpload } = createUploadHooks<typeof uploads>({
  headers: () => ({ authorization: `Bearer ${getToken()}` }),
  onError: ({ error }) => {
    if (error.code === 'unauthorized') signOut();
  },
});
```

```tsx
// app/large/page.tsx
'use client';
import { useUpload } from '@/lib/upload';

export default function Page() {
  const { start, upload, accept } = useUpload('large', { onDone: (u) => console.log(u.blob.url) });

  return (
    <>
      <input type="file" accept={accept} onChange={(e) => start({ file: e.target.files?.[0] })} />
      {upload ? `${upload.percent}% (${upload.status})` : null}
    </>
  );
}
```

- **One flat endpoint.** The name is in the query, `?route=avatar`, for GET and POST alike: a proxied
  body *is* the file, so the query is the only place it can go. Nothing is ever read from the body to
  decide where a request goes, the table has a null prototype, and a name it does not mount is a
  `not_found` -- never a 500, and never a list of the names it does mount.
- **Route names** must match `/^[A-Za-z_][\w-]*$/`; `uploadRouter()` throws otherwise. The name is
  also the completion token's route id, so two routes with identical limits no longer collide. Set
  `endpoint` when two routers share one bucket.
- **`limits`** replace the router's per key, and `null` clears one: `{ maxBytes: '2gb',
  allowedContentTypes: null }` raises the cap and drops the type list the router set.
- **`GET ?route=x`** serves that route's limits and its transport, with `max-age=60` and an ETag, so
  a file picker is filled from the same list that does the refusing and a deploy that widens the
  limits reaches it.
- **`proxy: true`** is the only difference between the two transports on the client: the browser
  learns which one to run from the route's own GET, so a page names a route and never a strategy. A
  file picked before that GET has answered waits for it as `queued`; if the GET cannot be reached or
  refuses, the upload fails with that error rather than guessing a transport.
- **`context`** runs once per request, before the route. It does not run for GET, which serves a
  public, cacheable document and reads nothing. With a `context`, `routes` must be the function form
  so `upload` sees `ctx`; without one the plain object form and the exported `upload` are fine.
- **Per-route callbacks** are `onBeforeUpload` (required), `onBeforeUploadFailed`,
  `onUploadCompleted` and `onError`, and all of them get `ctx`. What `onUploadCompleted` returns is
  `upload.blob.data` in the browser, typed. `onBeforeUpload` returns `{ path, metadata?, limits?,
  cache?, state?, overwrite? }`: `metadata` is the way to carry an id, `state` is anything else the
  later callbacks need, and per-request `limits` may only narrow.
- **`onError` on a route** maps: return a `BlobError` or a `Response` to answer with it. **`onError`
  on the router** observes: it hears about every refusal either way and cannot change the answer.

### Callbacks two routes share

Inside `upload({ ... })` the callbacks are contextually typed and nothing needs writing. A pair
written once and mounted on several routes is annotated instead, with one type each:
`RouteBeforeUploadArgs` and `RouteUploadCompletedArgs`, keyed on the router or on the ctx type.
`UploadContext<typeof uploads>` is what the router's `context` returned, and `UploadFile` is the file
as the browser described it.

```ts
import type { RouteBeforeUploadArgs, RouteUploadCompletedArgs } from '@upstash/blob';

// The ctx is named once and the transport is not named at all, so this fits a direct route and a
// proxied one; each route still infers its own state and its own data from the pair.
const stored = (prefix: string) => ({
  onBeforeUpload: ({ ctx, file }: RouteBeforeUploadArgs<Session>) => ({ path: uniquePath`${prefix}/${ctx.id}/${file.name}`, state: { name: file.name } }),
  onUploadCompleted: ({ ctx, state, path, size }: RouteUploadCompletedArgs<Session, { name: string }>) => db.files.insert({ owner: ctx.id, name: state.name, path, size }),
});

routes: (upload) => ({
  attachment: upload({ ...stored('attachment') }),
  avatar: upload({ proxy: true, ...stored('avatar'), onBeforeUpload: ({ ctx }) => ({ path: `avatar/${ctx.id}` }) }),
});
```

`RouteUploadCompletedArgs` defaults to the fields both transports carry, which is what lets one
annotation serve both; pass `false` as its third argument for the direct-only `uploadId` and
`multipartUploadId`. A helper written outside the router file takes the router itself --
`RouteBeforeUploadArgs<typeof uploads>` -- so the ctx has one source of truth.

### Proxied routes

`proxy: true` sends the bytes through your function, and `put()` checks them before anything reaches
the bucket: the leading bytes against `allowedContentTypes`, the stream against `maxBytes`. That is
what a stable path needs -- an avatar overwritten in place -- because a direct upload is checked once
it is already stored, by which time a refused file has replaced the one it was refused in favour of.

Every byte crosses your function, so it is bounded by the platform's request body cap (Vercel 4.5MB,
AWS Lambda 6MB, Cloudflare 100MB): keep `maxBytes` well inside it, and leave anything larger direct.

- **`maxBytes` is what bounds memory.** A raw body is streamed into `put()` and cut off there, so a
  chunked request cannot spend more than the limit. A `multipart/form-data` body is buffered by the
  platform's own form parser before this code sees it, so for those the `Content-Length` pre-check is
  the only guard; with no `maxBytes` at all a raw body is buffered too.
- **`field`** is the form field the file arrives in, `'file'` by default. Pass the same string to
  `useUpload(route, { field })`, or a request that is not multipart is taken as the body itself.
- `input` crosses as a JSON form field beside the file, and `onBeforeUploadFailed` fires when the
  `put()` after `onBeforeUpload` throws, so the row it reserved is released.

## Single routes: the primitives

`handleUpload` and `handleProxyUpload` are what the router composes, and a single route in its own
file is still theirs to serve. Use them when a route needs its own file-level config -- `export const
maxDuration`, `preferredRegion` -- or when there is only one.

```ts
// app/api/upload/route.ts
import { BlobError, Bucket, handleUpload } from '@upstash/blob';

export const { GET, POST } = handleUpload({
  bucket: Bucket.fromEnv(),
  route: '/api/upload', // where it is mounted; the hooks' `route` is typed to this literal
  limits: { maxBytes: '10mb', allowedContentTypes: ['image/*'] },
  onBeforeUpload: async ({ request, file }) => {
    // throw to reject the upload
    return { path: `uploads/${file.name}`, state: { rowId: await db.reserve() } };
  },
  onBeforeUploadFailed: async ({ decided }) => {
    // the upload was accepted but storage refused to start it: nothing will ever complete
    await db.release(decided.state.rowId);
  },
  onUploadCompleted: async ({ path, url, uploadId, multipartUploadId }) => {
    await db.insert({ path, url });
  },
  onError: (e) => (isPrismaTimeout(e) ? new BlobError('not_ready') : undefined),
});
```

- **`route`** is where this route is mounted, the same string the hooks take. It types the hooks'
  `route` as that string literal, so naming one endpoint while importing another's handler type
  stops compiling. A compile-time check only: nothing binds a token to a URL at runtime, and it also
  feeds the derived `id`, so two routes with identical limits no longer collide. Not the `path`
  `onBeforeUpload` returns, which is the object's key.
- **`id`** binds completion tokens to this route. Every route on one bucket signs with the same key,
  so without it a token minted by one route is spendable at another. It defaults to a hash of the
  route's url, limits and input, which collides only when two routes declare all three the same:
  name them then.
- **`onError`** maps anything a callback threw that is not a `BlobError`. Return a `BlobError` or a
  `Response`, or nothing to let it through to the framework. An error carrying a numeric `status`
  becomes that status without this hook.
- **`onUploadCompleted`** gets `uploadId` (stable across a retried completion: dedupe on it) and
  `multipartUploadId` (R2's own id, for `bucket.abortMultipart()`; undefined for a single PUT).
- **`state`** is whatever `onBeforeUpload` returned under that name, handed back to
  `onUploadCompleted` and `onBeforeUploadFailed`. It used to be called `context`, which still works
  and is deprecated.
- Bytes that are refused at the end, because they lied about their size or their type, are deleted
  before the error is returned: on a public bucket they were already being served.

`handleProxyUpload` takes the same options and proxies the bytes, as `proxy: true` does above:

```ts
// app/api/avatar/route.ts
import { handleProxyUpload } from '@upstash/blob';

export const { GET, POST } = handleProxyUpload({
  bucket,
  route: '/api/avatar',
  limits: { maxBytes: '2mb', allowedContentTypes: ['image/png', 'image/jpeg'] },
  onBeforeUpload: ({ request, file }) => ({ path: `avatar/${userId(request)}`, cache: '1m' }),
  onUploadCompleted: async ({ path, versionedUrl, contentType, size }) => db.upsert({ path, versionedUrl }),
});
```

`onBeforeUpload` may return `limits` to narrow the route's per user. They are merged, so narrowing
`maxBytes` alone keeps the route's `allowedContentTypes` and the byte sniff that goes with it.

### Without React

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

One hook, both transports. The route says which one it is, so the only thing that changes between a
2 GB resumable upload and a proxied avatar is the name you pass.

```tsx
import { useUpload } from '@upstash/blob/react';

function Uploader() {
  const { start, uploads, accept } = useUpload('attachment');

  return (
    <>
      <input type="file" accept={accept} multiple onChange={(e) => start({ files: e.target.files })} />
      {uploads.map((u) => (
        <div key={u.id}>
          {u.file?.name}: {u.percent}% ({u.status})
        </div>
      ))}
    </>
  );
}
```

- **`useUpload(route, options?)`** takes the route first. A name resolves against `endpoint`
  (`/api/upload` by default, and settable in `createUploadHooks`); a string starting with `/` or
  `http` is used as the url as it stands. The old `useUpload({ route, ...options })` still works and
  is deprecated.
- **`upload`** is the newest record, **`uploads`** is all of them, and **`clear(id?)`** drops one or
  all. `task` is `upload` under its old name, deprecated.
- **`accept`** is the route's own `allowedContentTypes`, for the file input, so there is no second
  list to fall out of step with the one that does the refusing.
- **`limits`** is the same document unjoined -- `limits.maxBytes` in bytes, `limits.allowedContentTypes`
  as the list -- for a page that states the cap it is about to enforce. Undefined until the route's
  GET answers, and when the route serves no limits, so nothing renders a number the route did not
  give.
- A **done** record carries `blob`, whichever transport ran: the stored object, `uploadedAt` as a
  `Date`, and `blob.data` typed to whatever the route's `onUploadCompleted` returned.
- A **direct** record has `pause()`, `resume()`, `retry()`, `canPause` and `stalled`. A **proxy**
  record has none of them -- one POST has no parts to pause -- and takes `start({ body })` and a
  `field` option instead. The types say so per route, so a Pause button that cannot work does not
  compile.

```tsx
const { start, upload } = useUpload('avatar');

start({ file }); // multipart, under `field`
start({ body: blob }); // the request body as it stands, a File included

if (upload?.status === 'done') {
  upload.blob.url; // where it landed
  upload.blob.data; // what onUploadCompleted returned
}
```

Without a router, pass the handler type instead. `RoutesOf` accepts a router, a handler, or a union
of both, so a codebase can move one route at a time:

```tsx
import type { POST } from './api/upload/route';

const { start, accept } = useUpload<typeof POST>('/api/upload');
```

`useUploadProxy` stays for a route this SDK did not write: its `response` is handed back exactly as
it arrived, untouched.

```tsx
const { upload } = useUploadProxy<{ url: string }>('/api/whatever');
if (upload?.status === 'done') upload.response.url;
```

### Defaults

`createUploadHooks` returns the hooks with your app's headers and error handling already applied,
and -- given the router's type -- its route names too. No context and no provider, so there is
nothing to render at the root of the tree; call-site options still win, and the configured `onError`
runs before the call's own rather than instead of it.

```ts
// lib/upload.ts
export const { useUpload, useUploadProxy } = createUploadHooks<typeof uploads>({
  endpoint: '/api/upload',
  headers: () => ({ authorization: `Bearer ${getToken()}` }),
  onError: ({ error }) => {
    if (error.code === 'unauthorized') signOut();
  },
});
```

`headers` is re-read per request, so an upload that outlives the current token still ends. It is
also where an app refuses its own upload: a throw from it ends the upload immediately carrying that
error, rather than being retried as a network fault.

With no type argument the hooks keep their unbound signatures, and `configureUpload` is the same
call under its old name, deprecated.


## Telemetry

Requests to Upstash carry the SDK version, runtime, and platform. Set `UPSTASH_DISABLE_TELEMETRY`
in the environment or pass `new Bucket({ token, enableTelemetry: false })` to turn it off. Setting
the variable to `false`, `0`, `no` or `off` does not turn it off, it leaves it on.

## License

[MIT](./LICENSE)
