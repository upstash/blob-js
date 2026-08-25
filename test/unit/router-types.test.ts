import { expect, test } from 'bun:test';
import * as z from 'zod';
import { handleProxyUpload, handleUpload, uploadRouter, type Bucket } from '../../src/index.ts';
import { createUploadHooks, type RoutesOf } from '../../src/react/index.ts';

// Compile-only. Nothing below the router definitions ever runs: the @ts-expect-error lines are the
// assertions, and a signature that stops being wrong fails the build.

declare const bucket: Bucket;
declare const file: File;

function _uploads(bucket: Bucket) {
  return uploadRouter({
    bucket,
    limits: { maxBytes: '20mb', allowedContentTypes: ['image/png'] },
    context: (request: Request) => Promise.resolve({ id: request.headers.get('x') ?? 'anon' }),
    onUploadCompleted: ({ route, path, size }) => void [route, path, size],
    onError: ({ route, error }) => void [route, error],
    routes: (upload) => ({
      attachment: upload({
        input: z.object({ threadId: z.string() }),
        onBeforeUpload: ({ ctx, input, file: picked }) => {
          const owner: string = ctx.id;
          const thread: string = input.threadId;
          return { path: `${owner}/${thread}/${picked.name}`, state: { rowId: 'r1' } };
        },
        onUploadCompleted: ({ ctx, state, uploadId, versionedUrl }) => ({ owner: ctx.id, rowId: state.rowId, uploadId, url: versionedUrl }),
      }),
      large: upload({
        limits: { maxBytes: '2gb', allowedContentTypes: null },
        onBeforeUpload: ({ ctx }) => ({ path: `${ctx.id}/big` }),
      }),
      avatar: upload({
        proxy: true,
        limits: { maxBytes: '2mb' },
        onBeforeUpload: ({ ctx }) => ({ path: `avatar/${ctx.id}`, overwrite: false }),
        onUploadCompleted: ({ ctx, versionedUrl }) => ({ owner: ctx.id, url: versionedUrl }),
      }),
    }),
  });
}

type Uploads = ReturnType<typeof _uploads>;

const { useUpload, useUploadProxy } = createUploadHooks<Uploads>({ headers: () => ({ authorization: 'x' }) });

/* ------------------------------------------------------------------ names -- */

function _names() {
  useUpload('attachment');
  useUpload('large');
  useUpload('avatar');
  // @ts-expect-error 'attachmnt' is not a route this router mounts
  useUpload('attachmnt');
  // @ts-expect-error a url is not a route name here; use the explicit generic for one
  useUpload('/api/upload');

  const keys: RoutesOf<Uploads> extends Record<'attachment' | 'large' | 'avatar', unknown> ? true : false = true;
  void keys;
}

/* ------------------------------------------------------------------ input -- */

function _input() {
  const attachment = useUpload('attachment');
  attachment.start({ file, input: { threadId: 't1' } });
  // @ts-expect-error this route's schema makes input required
  attachment.start({ file });
  // @ts-expect-error input must match the schema
  attachment.start({ file, input: { threadId: 1 } });

  const large = useUpload('large');
  large.start({ file });
  large.start({ files: [file] });
  // @ts-expect-error a route with no input schema takes none
  large.start({ file, input: { threadId: 't1' } });
}

/* ------------------------------------------------------------------- data -- */

function _data() {
  const { upload, uploads: list } = useUpload('attachment');
  if (upload?.status === 'done') {
    const rowId: string = upload.blob.data.rowId;
    const owner: string = upload.blob.data.owner;
    const dedupe: string = upload.blob.data.uploadId;
    // uploadedAt is a Date on both transports.
    const at: number = upload.blob.uploadedAt.getTime();
    void [rowId, owner, dedupe, at];
    // @ts-expect-error the route's data has no such member
    void upload.blob.data.nope;
  }
  void list.length;

  const { upload: task } = useUpload('large');
  // @ts-expect-error a route with no onUploadCompleted returns nothing to read
  if (task?.status === 'done') void task.blob.data.anything;
}

/* ------------------------------------------------------------ transports -- */

function _transports() {
  const direct = useUpload('large');
  direct.upload?.pause();
  direct.upload?.resume();
  void direct.upload?.stalled;
  // @ts-expect-error a direct route has no raw body form
  direct.start({ body: new Blob([]) });
  // @ts-expect-error field belongs to a proxy route
  useUpload('large', { field: 'x' });

  const proxy = useUpload('avatar');
  proxy.start({ file });
  proxy.start({ body: new Blob([]) });
  useUpload('avatar', { field: 'avatar' });
  // @ts-expect-error a proxied upload is one POST: there are no parts to pause
  proxy.upload?.pause();
  // @ts-expect-error and nothing to stall on
  void proxy.upload?.stalled;
  if (proxy.upload?.status === 'done') {
    // The envelope, merged: one shape for both transports.
    const url: string | undefined = proxy.upload.blob.data.url;
    const at: Date = proxy.upload.blob.uploadedAt;
    void [url, at];
  }
  // The File is optional on a proxy record, because start({ body }) has none.
  const named: File | null | undefined = proxy.upload?.file;
  void named;
}

/* --------------------------------------------------- handlers in the map -- */

function _handlerRoutes(b: Bucket) {
  const bound = handleUpload({
    bucket: b,
    route: '/api/legacy',
    onBeforeUpload: () => ({ path: 'a/1' }),
    onUploadCompleted: () => ({ legacy: true }),
  });
  const proxied = handleProxyUpload({
    bucket: b,
    route: '/api/legacy-avatar',
    onBeforeUpload: () => ({ path: 'a/2' }),
    onUploadCompleted: () => ({ owner: 'demo' }),
  });
  const unnamed = handleUpload({ bucket: b, onBeforeUpload: () => ({ path: 'a/3' }) });
  return { bound: bound.POST, proxied: proxied.POST, unnamed: unnamed.POST };
}

type Handlers = ReturnType<typeof _handlerRoutes>;

function _union() {
  const hooks = createUploadHooks<Uploads | Handlers['bound'] | Handlers['proxied']>({});

  // A router name and a handler url in one map.
  hooks.useUpload('attachment', { onDone: (u) => void (u.blob.data.rowId as string) });
  hooks.useUpload('/api/legacy', { onDone: (u) => void (u.blob.data.legacy as boolean) });
  hooks.useUpload('/api/legacy-avatar', { onDone: (u) => void (u.blob.data.owner as string) });
  // @ts-expect-error still checked against the union, so a typo is still a typo
  hooks.useUpload('/api/legacy-avatr');

  // The handler brand carries the transport too.
  const legacyProxy = hooks.useUpload('/api/legacy-avatar');
  legacyProxy.start({ body: new Blob([]) });
  // @ts-expect-error the proxied handler has no parts to pause either
  legacyProxy.upload?.pause();
}

function _unnamedHandlerContributesNothing() {
  // A handler that declared no `route` must not widen the key union to `string`, which would turn
  // the typo check off for every other route in the map.
  const hooks = createUploadHooks<Uploads | Handlers['unnamed']>({});
  hooks.useUpload('large');
  // @ts-expect-error the unnamed handler contributed no key, so this is still a typo
  hooks.useUpload('larg');

  const only = createUploadHooks<Handlers['unnamed']>({});
  // @ts-expect-error nothing named it, so there is nothing to name
  only.useUpload('anything');
}

/* --------------------------------------------------------- escape hatches -- */

function _escapeHatch() {
  const _legacy = _handlerRoutes(bucket);
  type Legacy = typeof _legacy.bound;
  const dynamic = useUpload<Legacy>(`/api/upload/${String(Math.random())}`);
  if (dynamic.upload?.status === 'done') void (dynamic.upload.blob.data.legacy as boolean);

  // Without the type argument there is nothing to check the url against, so it is refused rather
  // than quietly accepting any string and turning the typo check off.
  // @ts-expect-error a bare url needs the explicit handler type
  useUpload('/api/upload/whatever');

  // useUploadProxy stays loose: its reason to exist is a target this SDK did not write.
  const plain = useUploadProxy<{ url: string }>('/api/whatever');
  if (plain.upload?.status === 'done') void (plain.upload.response.url as string);
}

/* ------------------------------------------------------ unbound, as before -- */

function _unbound() {
  const hooks = createUploadHooks({ headers: () => ({}) });
  const _legacy = _handlerRoutes(bucket);
  type Legacy = typeof _legacy.bound;
  hooks.useUpload<Legacy>({ route: '/api/legacy' });
  hooks.useUpload<Legacy>('/api/legacy');
  // @ts-expect-error the handler declared a different path
  hooks.useUpload<Legacy>('/api/nope');
}

test('the router types compile', () => {
  expect(typeof uploadRouter).toBe('function');
  expect(typeof useUpload).toBe('function');
});
