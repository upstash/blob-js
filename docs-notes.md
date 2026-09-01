# Docs notes

Things the docs must say about the single-PUT path, and the API changes worth making around them.
Not the docs themselves. Line references are to this branch.

## The single-PUT orphan window

A file over the multipart threshold is created at completion, so a browser that dies mid-upload
leaves parts and nothing else: invisible to `list`, and `abortStaleMultipartUploads()` on a cron
reaps them. Under the threshold the presigned PUT stores the object the moment the last byte lands,
and the completion request that runs `onUploadComplete` is a separate call from the browser. An
explicit `cancel()` is covered -- the browser posts phase `cancel` and the handler deletes the object
when the marker matches (`src/server/handle-upload.ts:328`). A crash or a closed tab is not: there is
no `beforeunload` or `sendBeacon` anywhere in `src/`, so nothing is posted at all, and what is left is
a whole object no callback ever accepted: ordinary, `list()`-visible, billed, and already readable on
a public bucket.

The `upstash-upload` marker (`:86`) does not close this. It is signed into the PUT as
`x-amz-meta-upstash-upload` (`:179`, signed at `:358`, so the browser cannot forge it on this path)
purely so completion can prove the object at that path came from this upload (`:246`) and a refusal
deletes only what this upload wrote (`:248` → `:281`). It stays on the stored object after
completion: `:247` deletes it from the record `headFromHeaders` built for the callbacks, not from
storage, and nothing on the completion path rewrites metadata. So a marker match proves "same
upload", never "never accepted", and the SDK cannot tell an abandoned object from a finished one.
Only the app's own rows can.

This is the price the threshold bought. It is worth paying, but it has to be written down.

## What the docs must say

**1. Document the pending row. One pattern, not two.** Write the row in `onBeforeUpload`, flip it to
ready in `onUploadComplete`, and run a cron over rows still pending past a grace window. The sweep is
an indexed query, not a bucket scan, and the row names the exact path. This is what Rails Active
Storage ships (`unattached` blobs plus `active_storage:purge_unattached`), and what apps on Vercel
Blob and UploadThing end up writing anyway. Two constraints the docs have to state with it:

- Verify before deleting. `bucket.info(path)` returns `metadata` unstripped, so the cron can confirm
  the object is the one the row reserved. It throws `not_found` rather than returning undefined, so
  the example needs a `BlobError.is(e) && e.code === 'not_found'` catch.
- Flipping the row must be the last thing `onUploadComplete` does. Because the marker survives on
  accepted objects, the sweep's only safe premise is "row still pending implies the callback never
  finished". Do work before the flip, never after.

The `list()`-and-compare sweep is the fallback for an app that will not take a write on the hot path,
and it is strictly weaker: `list()` returns `BlobObject` with no metadata (`src/server/bucket.ts:356`),
so it can only diff keys against rows.

**2. `onUploadComplete` is at-least-once, and the docs must say what that costs on this path.** The
browser retries `end` up to `ROUTE_ATTEMPTS` on network failure and on 408/429/5xx
(`src/browser/task.ts:32`, `src/browser/retry.ts:21`). `uploadId` is stable across those retries and
is the idempotency key. The sharp edge is that any throw out of `onUploadComplete` runs `discard`
(`:281`), so **a plain database error deletes bytes that uploaded fine**, the browser retries `end`,
the object is gone, and the user is shown 404 `the upload never landed`. A ten-second DB blip costs
the upload and reports it as a phantom. Tell apps to catch their own storage errors and answer with a
retryable error rather than letting the callback throw.

**3. Unique paths, unless overwrite is the intent.** Two single-PUT uploads to the same path: the
second overwrites the first, and the first upload's `end` then fails the marker check at `:246` with
`not_found` even though its bytes landed. The marker stops a delete from hitting someone else's file;
it does not stop a lost update or the spurious 404.

**4. Say the escape hatch out loud.** `multipart: true` pins parts at every size and shrinks the
orphan class to the retried-`end` case (`completeMultipart` throws `NoSuchUpload`, `completedEtag`
stays undefined at `:229`, and a refusal then deliberately leaves the object rather than delete one
it cannot identify, `:295`). That leftover is a completed object, so `abortStaleMultipartUploads()`
cannot reap it either -- but for an app that will not run a cron, it is one option value that removes
the common case. The cost is not extra browser requests: the browser makes `begin`, the PUT, `end` in
both modes. It is two extra server→storage round trips, `createMultipart` (`:174`) and
`completeMultipart` (`:232`), landing as latency inside `begin` and `end`.

Placement: next to `abortStaleMultipartUploads` in the API overview, as one sentence with two halves.
Over the threshold the SDK sweeps it; under it you do, and here is the ten-line cron.

## One API change worth making

Pass `uploadId` to `onBeforeUpload`. Today the id is minted at `:170`, after the callback returns
(`:140`), and reaches the app only in `onUploadComplete` as `uploadId` (`:270`); `BeforeArgs`
(`src/server/handler.ts:43`) carries only `ctx, route, request, file, input`.

This is ergonomics, not capability. The pattern above is fully writable today: `metadata` returned by
`onBeforeUpload` is written as `x-amz-meta-*` (`:165`) and signed into the PUT, and `state` reaches
`onUploadComplete` (`:194` → `:274`), so an app can carry its own row id and check
`info(path).metadata.rowId === row.id`. `handler.ts:60` already says as much. Handing over the
`uploadId` just means one fewer app-minted id, one fewer reserved metadata key, and one key for the
row end to end.

## Where this should go instead, later

The better fix is a server-side upload record: the service mints the upload id and holds the pending
state, so an abandoned upload is a record it can expire rather than an object someone has to find.
Prior art, all three shipping it:

- **Uploadcare** -- every uploaded file is temporary and deleted within 24 hours unless explicitly
  stored (`UPLOADCARE_STORE`). Abandoned uploads clean themselves up; there is no sweep to write.
- **Cloudflare Images / Stream** -- the server creates a draft record first (`draft: true`,
  `pendingupload`) and gets the upload URL back; state is checked by id later. Do not copy the Images
  half: drafts are invisible to `list`, which forces the app to persist the id anyway.
- **Mux** -- direct uploads are their own object with `waiting` / `asset_created` / `errored` /
  `cancelled` / `timed_out` and a server-enforced timeout. Their warning is worth keeping: reconcile
  by listing with a filter, never by polling one upload at a time.

For us that collapses the API rather than growing it, since `listMultipartUploads` /
`abortStaleMultipartUploads` already model exactly this shape (`{ path, uploadId, initiatedAt }`).
Registering a single PUT the same way makes it one `abortStaleUploads()` over both, and it fixes the
root problem the marker cannot: the record, not the object, holds the state. The cost is a call to
Upstash inside `begin`, where today the handler only signs locally against cached credentials
(`:158`).
