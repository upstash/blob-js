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
the credential service serves one credential until it is nearly out, so `signedReadCap()` is
anywhere from ~30 s to ~10 min (measured 2026-08-25: a fresh mint came back with 199 s on it).

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
and a bucket cannot be deleted while one exists. The bucket's lifecycle rule aborts them; these are
here for a bucket without one, and for a cron that wants to be sure:

```ts
await bucket.listMultipartUploads({ prefix: 'uploads/' });
await bucket.abortMultipart(uploadId, path);
// list + abort, for a cron: sweepMultipart() is the same call under the name people look for
await bucket.abortStaleUploads({ olderThan: '1d' });
```

`del({ prefix })` refuses an empty prefix unless you say you mean it: `del({ prefix: '', all: true })`.

## Uploads

One endpoint, one function. `uploadHandler` presigns, checks and completes an upload the browser
drives; the React hooks read what it accepts, what it answers with and which transport it speaks
straight off `typeof uploads`, so a page never spells out a url and a typo does not compile.

```ts
// lib/upload-routes.ts
import 'server-only';
import { Bucket, uniquePath, uploadHandler } from '@upstash/blob';

export const uploads = uploadHandler({
  bucket: Bucket.fromEnv(),
  constraints: { maxBytes: '20mb', contentTypes: ['image/*', 'application/pdf'] },

  // runs once per request, before any body is read. What it returns is `ctx` in every callback,
  // typed. Throw to refuse: a BlobError('unauthorized') is the 401.
  context: (request) => requireUser(request),

  onBeforeUpload: ({ ctx, file }) => ({ path: uniquePath`${ctx.id}/${file.name}` }),
  onUploadComplete: ({ ctx, path, url, size }) => db.files.insert({ owner: ctx.id, path, url, size }),
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
// a type-only import: the handler's types cross the client boundary, its code does not
import type { uploads } from './uploads';

export const { useUpload } = createUploadHooks<typeof uploads>({
  headers: () => ({ authorization: `Bearer ${getToken()}` }),
  onError: ({ error }) => {
    if (error.code === 'unauthorized') signOut();
  },
});
```

```tsx
// app/page.tsx
'use client';
import { useUpload } from '@/lib/upload';

export default function Page() {
  // no name: this handler is the route
  const { start, upload, accept } = useUpload({ onDone: (u) => console.log(u.blob.url) });

  return (
    <>
      <input type="file" accept={accept} onChange={(e) => start({ file: e.target.files?.[0] })} />
      {upload ? `${upload.percent}% (${upload.status})` : null}
    </>
  );
}
```

### More than one route

Add `routes` and the same handler mounts several at the same endpoint, the name in the query. What
is written at the top -- `bucket`, `constraints`, `input`, `proxy`, `field`, `onBeforeUpload`,
`onUploadComplete`, `onError` -- is the DEFAULT: a route replaces a key and inherits the rest.

```ts
export const uploads = uploadHandler({
  bucket: pub,
  constraints: { maxBytes: '20mb', contentTypes: ['image/*', 'application/pdf'] },
  context: (request) => requireUser(request),

  // inherited by every route below, and `route` is the name the browser asked for
  onBeforeUpload: ({ ctx, route, file }) => ({ path: uniquePath`${route}/${ctx.id}/${file.name}` }),
  onUploadComplete: ({ ctx, route, path, url, size }) => db.files.insert({ owner: ctx.id, route, path, url, size }),
  onError: ({ route, error }) => log.error(route, error),

  routes: {
    // writes nothing: the defaults are the whole route
    attachment: {},

    // its own bucket and its own constraints; `null` clears a key the handler set
    large: { bucket: priv, constraints: { maxBytes: '2gb', contentTypes: null } },

    // the bytes go through your function instead of straight to storage
    avatar: {
      proxy: true,
      constraints: { maxBytes: '2mb' },
      onBeforeUpload: ({ ctx }) => ({ path: `avatar/${ctx.id}`, cache: '1m' }),
      onUploadComplete: ({ ctx, versionedUrl }) => db.users.update(ctx.id, { avatar: versionedUrl }),
    },
  },
});
```

```tsx
const { start, upload, accept } = useUpload('avatar');
```

- **One flat endpoint.** The name is in the query, `?route=avatar`, for GET and POST alike: a proxied
  body *is* the file, so the query is the only place it can go. Nothing is ever read from the body to
  decide where a request goes, the table has a null prototype, and a name it does not mount is a
  `not_found` -- never a 500, and never a list of the names it does mount. With no `routes` there is
  no query at all and the client calls `useUpload()` with no name; a `?route=` that reaches such a
  handler anyway is a client bound to some other handler, and is a `not_found` too.
- **Route names** must match `/^[A-Za-z_][\w-]*$/`; `uploadHandler()` throws otherwise. The name is
  also the completion token's route id, so two routes with identical constraints do not collide. Set
  `endpoint` when two handlers share one bucket.
- **`constraints`** replace the handler's per key, and `null` clears one: `{ maxBytes: '2gb',
  contentTypes: null }` raises the cap and drops the type list the handler set.
- **`GET`** serves the route's constraints and its transport, with `max-age=60` and an ETag, so a file
  picker is filled from the same list that does the refusing and a deploy that widens the constraints
  reaches it.
- **`proxy: true`** is the only difference between the two transports on the client: the browser
  learns which one to run from the route's own GET, so a page names a route and never a strategy. A
  file picked before that GET has answered waits for it as `queued`; if the GET cannot be reached or
  refuses, the upload fails with that error rather than guessing a transport.
- **`context`** may be synchronous or async and runs once per request, before the route. It does not
  run for GET, which serves a public, cacheable document and reads nothing. **Write it above the
  callbacks that read `ctx`.**
  TypeScript types an object literal top to bottom, and a `context` written below `routes` reaches
  it after the routes were typed with `ctx: undefined`; the error then lands on `context` itself
  ("Promise<Session> is not assignable to undefined"), never as a silent `unknown`. Annotating the
  parameter, `(request: Request) =>`, lifts the order rule if you need it lifted.
- **Callbacks** are `onBeforeUpload`, `onUploadComplete` and `onError`, at the top as defaults or on
  a route to replace one. All of them get `ctx`, `route`, `request` and `file`. What
  `onUploadComplete` returns is `upload.blob.data` in the browser, typed per route: a route with its
  own gets its own, a route without gets the handler's. `onBeforeUpload` returns `{ path, metadata?,
  constraints?, cache?, state?, overwrite? }`: `metadata` is the way to carry an id, `state` is anything
  else the completion needs, and per-request `constraints` may only narrow.
- **`onError`** sees every refusal, the SDK's own included, with as much as the request had reached:
  `{ ctx, route, request, error, file?, path?, metadata?, state? }`. Return a `BlobError` or a
  `Response` to answer with it, return nothing to leave the answer alone. It is the one place to log,
  and the `path` is how the row a failed `onBeforeUpload` reserved is released.
- **Direct `onUploadComplete` delivery is at-least-once.** A successful `phase: 'end'` response can
  be lost and retried. Its `uploadId` stays stable, so enforce it as a unique key and atomically
  insert-or-return the ready row. A proxy upload is one POST; sending another POST is another upload.
  Both transports receive an `uploadId`; `multipartUploadId` is direct-only and belongs to R2.

### Every upload is multipart

There is no size threshold and no single-PUT path. A file that fits one part is a multipart of one.

- **The object does not exist until all parts complete.** A half-written object is never served or
  listed. The callback then records the finished object directly as ready, with no pending row.
- **If `onUploadComplete` throws, the object is deleted** and the error is answered. As with every
  cross-service write, an abrupt process death between object storage and the app database cannot be
  transactional; a retried completion recovers it.
- **Pause, resume and retry work at every size**, because there is always a part boundary to stop on.
  `task.retry()` runs a failed upload again from the parts that landed, and so does picking the same
  file again after a reload.
- **An abandoned upload leaves incomplete parts.** They are billed storage that `list()` cannot see.
  The bucket's own lifecycle rule aborts them, which is the assumption this design rests on;
  `bucket.abortStaleUploads({ olderThan: '1d' })` is still exported for a bucket without one, and for
  a cron that wants to be sure.

### A route that needs more than a plain object

`upload()` is the builder for the two things a plain object cannot carry: an `input` schema, and a
`state` typed from what its own `onBeforeUpload` returned. It is curried because the ctx has to be
named -- a plain object gets it from the handler it sits in, and this one is written on its own.

```ts
import { upload, uploadHandler } from '@upstash/blob';

type Session = { id: string };

const thread = upload<Session>()({
  input: z.object({ threadId: z.string() }), // any Standard Schema
  onBeforeUpload: ({ ctx, input, file }) => ({
    path: uniquePath`${ctx.id}/${input.threadId}/${file.name}`,
    state: { name: file.name }, // the picked name, which the stored object drops
  }),
  onUploadComplete: ({ ctx, state, path, uploadId }) => db.files.insert({ owner: ctx.id, name: state.name, path, uploadId }),
});

export const uploads = uploadHandler({ bucket, context: (request) => getSession(request), routes: { thread } });
```

A handler-level `onBeforeUpload` and `onUploadComplete` are shared by both transports, so they carry
no route-specific typed `state`; they do carry the common `uploadId`. A route that needs typed state
names itself and uses the builder, even when it is the only one.

The browser sends `input` with the file and `start({ file, input })` is typed to the schema; it is
validated before `onBeforeUpload` runs and a route with no schema refuses input rather than dropping
it. A callback written outside any handler is annotated with `BeforeUploadArgs` and
`UploadCompleteArgs`, keyed on the handler or on the ctx type: `UploadContext<typeof uploads>` is
what `context` returned, and `UploadFile` is the file as the browser described it.
`UploadCompleteArgs<Context, Route>` lets an extracted shared callback retain its route union while
still serving either transport.

### Proxied routes

`proxy: true` sends the bytes through your function, and `put()` checks them before anything reaches
the bucket: the leading bytes against `contentTypes`, the stream against `maxBytes`. That is
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
- `input` crosses as a JSON form field beside the file. `overwrite: false` from `onBeforeUpload` sets
  `If-None-Match: *` server-side, so a second upload to the same path is a real 412.
- `onBeforeUpload` may return `constraints` to narrow the route's per user. They are merged, so narrowing
  `maxBytes` alone keeps the route's `contentTypes` and the byte sniff that goes with it.

### Without React

```ts
import { upload } from '@upstash/blob/browser';

const task = upload(file, { route: '/api/upload' });
const blob = await task.done;
blob.url;
```

`task` also gives you `pause()`, `resume()`, `cancel()` and `subscribe()` for progress.

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
  `http` is used as the url as it stands. A handler written with no `routes` has one route and no
  name: `useUpload()`, or `useUpload(options)`. Which of the two forms compiles is the handler's to
  say, so a client and a server cannot disagree about whether there is a name.
- **`upload`** is the newest record, **`uploads`** is all of them, and **`clear(id?)`** drops one or
  all.
- **`accept`** is the route's own `contentTypes`, for the file input, so there is no second
  list to fall out of step with the one that does the refusing.
- **`constraints`** is the same document unjoined -- `constraints.maxBytes` in bytes, `constraints.contentTypes`
  as the list -- for a page that states the cap it is about to enforce. Undefined until the route's
  GET answers, and when the route serves no constraints, so nothing renders a number the route did not
  give.
- **`status`** is `'queued' | 'uploading' | 'finishing' | 'paused' | 'done' | 'canceled' | 'error'`
  (a proxy record has no `'paused'`). `'finishing'` is the stretch after the last byte is sent while
  the route completes the upload -- completing the multipart, sniffing it, running
  `onUploadComplete` -- where
  `percent` sits at 99 and nothing is moving; naming it is the difference between a bar that is
  working and one that looks stuck. The words are machine-readable: what to *print* for each is the
  app's, and the SDK ships no labels.
- A **done** record carries `blob`, whichever transport ran: the stored object, `uploadedAt` as a
  `Date`, and `blob.data` typed to whatever the route's `onUploadComplete` returned (or the
  handler's, for a route that did not write one).
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
  upload.blob.data; // what onUploadComplete returned
}
```

For a route this SDK did not mount -- another app's, or one whose url is only known at runtime --
name its type. `RoutesOf` accepts a handler, a branded route, or a union of both, so a codebase can
move one route at a time:

```tsx
import type { UploadRoute } from '@upstash/blob';

type Legacy = UploadRoute<undefined, { rowId: string }, '/api/legacy'>;
const { start, accept } = useUpload<Legacy>('/api/legacy');
```

`useUploadProxy` stays for a route this SDK did not write: its `response` is handed back exactly as
it arrived, untouched.

```tsx
const { upload } = useUploadProxy<{ url: string }>('/api/whatever');
if (upload?.status === 'done') upload.response.url;
```

### Defaults

`createUploadHooks` returns the hooks with your app's headers and error handling already applied,
and -- given the handler's type -- its route names too. No context and no provider, so there is
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

With no type argument the hooks keep their unbound signatures.


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
