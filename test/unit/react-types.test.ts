import { expect, test } from 'bun:test';
import type { UploadRoute } from '../../src/index.ts';
import { createUploadHooks, useServerUpload, useUpload } from '../../src/react/index.ts';

// Compile-only. The @ts-expect-error lines are assertions.
type Chat = UploadRoute<{ threadId: string }, { rowId: string }>;
type Large = UploadRoute<undefined, { name: string }>;
type Bound = UploadRoute<undefined, { rowId: string }, '/api/upload/attachments'>;

function _direct(file: File, threadId: string) {
  const { start } = useUpload<Chat>('/api/upload', {
    onDone: (upload) => void (upload.blob.data.rowId satisfies string),
    onError: (upload) => void (upload.error.message satisfies string),
  });
  const one = start({ file, input: { threadId } });
  const many = start({ files: [file], input: { threadId } });
  void one?.percent;
  void many.length;
  // @ts-expect-error schema input is required
  start({ file });
  // @ts-expect-error input must match the schema
  start({ file, input: { threadId: 1 } });
  // @ts-expect-error raw bodies belong to useServerUpload
  start({ body: file, input: { threadId } });

  const plain = useUpload<Large>('/api/upload/large');
  plain.start({ file: null });
  // @ts-expect-error a route with no schema takes no input
  plain.start({ file, input: { threadId } });
  const currentUrl: string | undefined = plain.upload?.blob?.url;
  void currentUrl;
  void (plain.upload?.error?.message satisfies string | undefined);
  void (plain.upload?.pending satisfies boolean | undefined);
}

function _routeStrings() {
  useUpload<Bound>('/api/upload/attachments');
  // @ts-expect-error this branded route declared another URL
  useUpload<Bound>('/api/upload/large');
  useUpload<Large>('/anything');
  useUpload('/api/anything');
  useUpload(`/api/upload/${String(Math.random())}`);
}

function _server(file: File) {
  const server = useServerUpload<{ file: { id: string } }>('/api/avatar', {
    field: 'avatar',
    concurrency: 2,
    onDone: (upload) => void (upload.response.file.id satisfies string),
  });
  server.start({ file });
  server.start({ body: file });
  server.start({ body: new Blob([]) });
  server.start({ body: new FormData() });
  if (server.upload?.status === 'done') void (server.upload.response.file.id satisfies string);
  // No narrowing needed: every other member declares response and error as `?: undefined`.
  void (server.upload?.response?.file.id satisfies string | undefined);
  void (server.upload?.error?.message satisfies string | undefined);
  void (server.upload?.pending satisfies boolean | undefined);

  // @ts-expect-error the route is always positional
  useServerUpload<{ ok: boolean }>({ route: '/api/avatar' });
  // @ts-expect-error there is no legacy task alias
  void server.task;
}

function _configured(file: File) {
  const configured = createUploadHooks({
    headers: () => ({ authorization: 'Bearer x' }),
    onError: ({ error }) => void error.code,
  });
  configured.useUpload<Bound>('/api/upload/attachments').start({ file });
  // @ts-expect-error wrapped direct hook retains the declared URL
  configured.useUpload<Bound>('/nope');
  // @ts-expect-error generic server routes are configured separately
  void configured.useServerUpload;
}

test('the react hook types compile', () => {
  expect(typeof useUpload).toBe('function');
  expect(typeof useServerUpload).toBe('function');
  void [_direct, _routeStrings, _server, _configured];
});
