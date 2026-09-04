---
name: blob
description: Store and serve files with Upstash Blob using the @upstash/blob SDK. Use when uploading, reading, listing, deleting or signing URLs for files, building browser or React file uploads, or handling multipart, private buckets and upload callbacks. Triggers on "upstash blob", "@upstash/blob", "blob storage", "file upload", "presigned url", "signed url", "uploadHandler", "useUpload".
metadata:
  author: Upstash
  version: '1.0'
---

## *CRITICAL*: Always Use the Bundled `@upstash/blob` Documentation

Your knowledge of `@upstash/blob` is outdated.

The installed package ships the docs that match its version. Read them before writing any
`@upstash/blob` code:

1. **Index**: `cat node_modules/@upstash/blob/docs/README.md`
2. **Find pages**: `glob "node_modules/@upstash/blob/docs/**/*.mdx"`
3. **Search**: `grep -r "your query" node_modules/@upstash/blob/docs/`

Layout of `node_modules/@upstash/blob/docs/`:

- `overall/` - quickstart, pricing and limits
- `bucket/` - server-side `Bucket` API: writing, reading, deleting, caching
- `uploads/` - direct browser uploads: upload handler, upload client, constraints, large files, abandoned uploads
- `reference/` - error codes, how signing works
- `recipes/` - end-to-end patterns: avatars, attachments, private documents, AI images, video, exports, product images, site assets

If the package is not installed yet, install it first (`npm install @upstash/blob`) and then read
the docs. If `docs/` is missing, the installed version predates bundled docs: upgrade, or read
https://upstash.com/docs/blob.

### Official Resources

- **Docs**: https://upstash.com/docs/blob
- **GitHub**: https://github.com/upstash/blob-js

### Quick Reference

**Entrypoints:**

```typescript
import { Bucket, uploadHandler, uploadRoute, uniquePath, BlobError, formatBytes } from '@upstash/blob'; // server
import { upload } from '@upstash/blob/browser';                                                        // browser, no React
import { uploadHooks, useUpload, useServerUpload } from '@upstash/blob/react';                          // React
```

**Server:**

```typescript
const bucket = Bucket.fromEnv(); // UPSTASH_BLOB_TOKEN, or new Bucket({ token, visibility: 'private' })

await bucket.put(path, body, { contentType, metadata, cache, overwrite, multipart });
await bucket.get(path);   // record + ReadableStream body, throws not_found
await bucket.info(path);  // record only
await bucket.exists(path);
await bucket.list({ prefix, limit, cursor });
await bucket.copy(from, to);  await bucket.move(from, to);
await bucket.del(path | paths | { prefix });
await bucket.updateJson<T>(path, (prev) => next);
await bucket.signedReadUrl(path, { downloadAs });
await bucket.signedUploadUrl(path, { contentType, size });
await bucket.abortStaleMultipartUploads({ olderThan: '1d' });
bucket.publicUrl(path);  bucket.s3();
```

**Direct browser uploads:**

```typescript
// server: one route, GET serves constraints, POST signs and completes
export const uploads = uploadHandler({
  constraints: { maxBytes: '20mb', contentTypes: ['image/*'] },
  onBeforeUpload: async ({ request, file }) => ({ path: uniquePath`${userId}/${file.name}`, metadata: {} }),
  onUploadComplete: async ({ url, metadata, uploadId }) => { /* at-least-once, keyed by uploadId */ },
});
export const { GET, POST } = uploads;

// client
export const { useUpload } = uploadHooks<typeof uploads>();
const { start, upload, accept } = useUpload();
```

**Errors:** everything throws `BlobError` with a closed `code` list. Check with `BlobError.is(e)`,
never `instanceof`.
