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

await bucket.get('avatars/me.png');
await bucket.list({ prefix: 'avatars/' });
await bucket.del('avatars/me.png');
await bucket.signedReadUrl('private/report.pdf', { expiresIn: '1h' });
```

## Browser uploads

The file goes straight from the browser to storage, so it never passes through your server. Your
server only authorizes the upload and hears about it afterwards.

Route handler:

```ts
// app/api/upload/route.ts
import { Bucket, handleUpload } from '@upstash/blob';

export const { GET, POST } = handleUpload({
  bucket: Bucket.fromEnv(),
  limits: { maxBytes: '10mb', allowedContentTypes: ['image/*'] },
  onBeforeUpload: async ({ request, file }) => {
    // throw to reject the upload
    return { path: `uploads/${file.name}` };
  },
  onUploadCompleted: async ({ path, url }) => {
    await db.insert({ path, url });
  },
});
```

Client:

```ts
import { upload } from '@upstash/blob/browser';

const task = upload(file, { route: '/api/upload' });
const blob = await task.done;
blob.url;
```

`task` also gives you `pause()`, `resume()`, `cancel()` and `subscribe()` for progress.

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
in the environment or pass `new Bucket({ token, enableTelemetry: false })` to turn it off.

## License

[MIT](./LICENSE)
