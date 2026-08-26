import { expect, test } from 'bun:test';
import type { UploadRoute } from '../../src/index.ts';
import { createUploadHooks, useUpload, useUploadProxy } from '../../src/react/index.ts';

// Compile-only. Nothing below the route declarations ever runs: the @ts-expect-error lines are the
// assertions, and a signature that stops being wrong fails the build.
//
// This file is the UNBOUND hooks: one route at a time, named by its brand. handleUpload is internal
// now, so a route is written out as the `UploadRoute` it always was -- input, data, the url it
// declared, and whether it proxies. The bound hooks and their route maps live in handler-types.

/** An input schema, and an onUploadComplete that returned a row id. */
type Chat = UploadRoute<{ threadId: string }, { rowId: string }>;
/** No input schema, and no url of its own. */
type Large = UploadRoute<undefined, { name: string }>;
/** A route that declared the url it is mounted at. */
type Bound = UploadRoute<undefined, { rowId: string }, '/api/upload/attachments'>;
/** A proxy route: the bytes go through the app's own function as one POST. */
type Avatar = UploadRoute<undefined, { owner: string }, '/api/avatar', true>;

function _withInput(file: File, threadId: string) {
  const { start } = useUpload<Chat>('/api/upload', {
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
  const { start, upload } = useUpload<Large>('/api/upload/large');
  start({ file });
  start({ file: null });

  // @ts-expect-error a route with no input schema takes none
  start({ file, input: { threadId: 'x' } });

  if (upload?.status === 'done') {
    const url: string | undefined = upload.blob.url;
    void url;
  }
  // @ts-expect-error blob exists only on the done member
  const blob: unknown = upload?.blob;
  void blob;
}

function _proxy(file: File) {
  const { start, upload } = useUploadProxy<{ url: string }>('/api/avatar');
  start({ file });
  start({ body: file });
  start({ body: new FormData() });

  // @ts-expect-error response exists only on the done member
  const early: unknown = upload?.response;
  void early;

  if (upload?.status === 'done') {
    const url: string = upload.response.url;
    void url;
  }
}

/* -------------------------------------------- route strings match handlers -- */

function _routeStrings(file: File) {
  useUpload<Bound>('/api/upload/attachments');
  // @ts-expect-error the route declared a different url
  useUpload<Bound>('/api/upload/large');
  // A route with no declared url stays a plain string, as before.
  useUpload<Large>('/anything');

  const { start, upload, accept } = useUploadProxy<Avatar>('/api/avatar');
  const list: string = accept;
  void list;
  start({ file });

  // @ts-expect-error the route declared a different url
  useUploadProxy<Avatar>('/api/upload');

  if (upload?.status === 'done') {
    // The route's envelope: what onUploadComplete returned, plus the stored object as JSON.
    const owner: string = upload.response.data.owner;
    const size: number = upload.response.blob.size;
    // A string, not a Date: this is the JSON the route wrote, handed back untouched.
    const at: string = upload.response.blob.uploadedAt;
    void [owner, size, at];
  }
}

/**
 * The unbound hook's default route declares no url, so any string is one it may be pointed at.
 * Only the hooks bound to a handler check the string against that handler's route names, which is
 * what handler-types asserts.
 */
function _anyUrl() {
  useUpload('/api/anything');
  useUpload(`/api/upload/${String(Math.random())}`);
  useUploadProxy('/api/whatever');
}

function _configured(file: File) {
  // No type argument, so the hooks keep their unbound signatures: the defaults are applied and the
  // url is still checked against whatever route type the call site names.
  const { useUpload: bound, useUploadProxy: boundProxy } = createUploadHooks({
    headers: () => ({ authorization: 'Bearer x' }),
    onError: ({ error }) => void error.code,
  });
  bound<Bound>('/api/upload/attachments').start({ file });
  boundProxy<Avatar>('/api/avatar').start({ file });
  // @ts-expect-error the wrapped hooks keep the url check
  bound<Bound>('/nope');
}

// A route the app wrote itself is not an SDK proxy route, whatever its call signature.
async function _plainRoute(request: Request): Promise<Response> {
  void request;
  return Response.json({ file: { id: 'r1' } });
}

function _plainProxy() {
  const { upload } = useUploadProxy<typeof _plainRoute>('/api/whatever');
  if (upload?.status === 'done') {
    // Handed back as written. It must NOT be narrowed to the SDK's { blob, data } envelope.
    const fn: typeof _plainRoute = upload.response;
    void fn;
  }
}

test('the react hook types compile', () => {
  expect(typeof useUpload).toBe('function');
  expect(typeof useUploadProxy).toBe('function');
});
