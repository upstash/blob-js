import { expect, test } from 'bun:test';
import * as z from 'zod';
import { handleUpload, type Bucket } from '../../src/index.ts';
import { useUpload, useUploadProxy } from '../../src/react/index.ts';

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
    const url: string = task.blob.url;
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

test('the react hook types compile', () => {
  expect(typeof useUpload).toBe('function');
  expect(typeof useUploadProxy).toBe('function');
});
