import { expect, test } from 'bun:test';
import * as z from 'zod';
import { handleProxyUpload, handleUpload, type Bucket } from '../../src/index.ts';
import { configureUpload, useUpload, useUploadProxy } from '../../src/react/index.ts';

// Compile-only. Nothing below the route definitions ever runs: the @ts-expect-error lines are the
// assertions, and a signature that stops being wrong fails the build.

function _chatRoutes(bucket: Bucket) {
  return handleUpload({
    bucket,
    limits: { allowedContentTypes: ['image/png'], maxBytes: '20mb' },
    input: z.object({ threadId: z.string() }),
    onBeforeUpload: async ({ input }) => ({ path: `chat/${input.threadId}`, context: { rowId: 'r1' } }),
    onUploadCompleted: async ({ context }) => ({ rowId: context.rowId }),
  });
}

function _largeRoutes(bucket: Bucket) {
  return handleUpload({
    bucket,
    limits: { maxBytes: '5gb' },
    onBeforeUpload: async () => ({ path: 'large/x' }),
  });
}

type ChatPost = ReturnType<typeof _chatRoutes>['POST'];
type LargePost = ReturnType<typeof _largeRoutes>['POST'];

function _withInput(file: File, threadId: string) {
  const { start } = useUpload<ChatPost>({
    route: '/api/upload',
    onDone: (u) => {
      const rowId: string = u.blob.data.rowId;
      void rowId;
    },
    onError: (u) => {
      const message: string = u.error.message;
      void message;
    },
  });

  const one = start({ file, input: { threadId } });
  const many = start({ files: [file], input: { threadId } });
  void one?.percent;
  void many.length;

  // @ts-expect-error this route's schema makes input required
  start({ file });
  // @ts-expect-error input must match the schema
  start({ file, input: { threadId: 1 } });
}

function _withoutInput(file: File) {
  const { start, task } = useUpload<LargePost>({ route: '/api/upload/large' });
  start({ file });
  start({ file: null });

  // @ts-expect-error a route with no input schema takes none
  start({ file, input: { threadId: 'x' } });

  if (task?.status === 'done') {
    const url: string | undefined = task.blob.url;
    void url;
  }
  // @ts-expect-error blob exists only on the done member
  const blob: unknown = task?.blob;
  void blob;
}

function _proxy(file: File) {
  const { start, task } = useUploadProxy<{ url: string }>({ route: '/api/avatar' });
  start({ file });
  start({ body: file });
  start({ body: new FormData() });

  // @ts-expect-error response exists only on the done member
  const early: unknown = task?.response;
  void early;

  if (task?.status === 'done') {
    const url: string = task.response.url;
    void url;
  }
}

/* -------------------------------------------- route strings match handlers -- */

function _pathBound(bucket: Bucket) {
  return handleUpload({
    bucket,
    route: '/api/upload/attachments',
    limits: { maxBytes: '20mb' },
    onBeforeUpload: async () => ({ path: 'a/1' }),
    onUploadCompleted: async () => ({ rowId: 'r1' }),
  });
}
type BoundPost = ReturnType<typeof _pathBound>['POST'];

function _avatarRoutes(bucket: Bucket) {
  return handleProxyUpload({
    bucket,
    route: '/api/avatar',
    limits: { allowedContentTypes: ['image/png'], maxBytes: '2mb' },
    onBeforeUpload: () => ({ path: 'avatar/demo', context: { owner: 'demo' } }),
    onUploadCompleted: ({ context }) => ({ owner: context.owner }),
  });
}
type AvatarPost = ReturnType<typeof _avatarRoutes>['POST'];

function _routeStrings(file: File) {
  useUpload<BoundPost>({ route: '/api/upload/attachments' });
  // @ts-expect-error the handler declared a different path
  useUpload<BoundPost>({ route: '/api/upload/large' });
  // A route with no declared path stays a plain string, as before.
  useUpload<LargePost>({ route: '/anything' });

  const { start, task, accept } = useUploadProxy<AvatarPost>({ route: '/api/avatar' });
  const list: string = accept;
  void list;
  start({ file });

  // @ts-expect-error the handler declared a different path
  useUploadProxy<AvatarPost>({ route: '/api/upload' });

  if (task?.status === 'done') {
    // The route's envelope: what onUploadCompleted returned, plus the stored object as JSON.
    const owner: string = task.response.data.owner;
    const size: number = task.response.blob.size;
    // A string, not a Date: this is the JSON the route wrote, handed back untouched.
    const at: string = task.response.blob.uploadedAt;
    void [owner, size, at];
  }
}

function _configured(file: File) {
  const { useUpload: bound, useUploadProxy: boundProxy } = configureUpload({
    headers: () => ({ authorization: 'Bearer x' }),
    onError: ({ error }) => void error.code,
  });
  bound<BoundPost>({ route: '/api/upload/attachments' }).start({ file });
  boundProxy<AvatarPost>({ route: '/api/avatar' }).start({ file });
  // @ts-expect-error the wrapped hooks keep the path check
  bound<BoundPost>({ route: '/nope' });
}

// A route the app wrote itself is not a handleProxyUpload route, whatever its call signature.
async function _plainRoute(request: Request): Promise<Response> {
  void request;
  return Response.json({ file: { id: 'r1' } });
}

function _plainProxy() {
  const { task } = useUploadProxy<typeof _plainRoute>({ route: '/api/whatever' });
  if (task?.status === 'done') {
    // Handed back as written. It must NOT be narrowed to the SDK's { blob, data } envelope.
    const fn: typeof _plainRoute = task.response;
    void fn;
  }
}

test('the react hook types compile', () => {
  expect(typeof useUpload).toBe('function');
  expect(typeof useUploadProxy).toBe('function');
});
