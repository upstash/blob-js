import { expect, test } from 'bun:test';
import * as z from 'zod';
import {
  upload,
  uploadHandler,
  type BeforeUploadArgs,
  type Bucket,
  type UploadCompleteArgs,
  type UploadContext,
  type UploadFile,
  type UploadRoute,
} from '../../src/index.ts';
import { createUploadHooks, useServerUpload, useUpload, type RoutesOf } from '../../src/react/index.ts';

// Compile-only. Nothing below the handler definitions runs: @ts-expect-error lines are assertions,
// and a signature that stops being wrong fails typecheck.
declare const bucket: Bucket;
declare const file: File;
declare function requireUser(request: Request): Promise<Session>;
declare function saveRow(args: { ctx: Session; path: string }): Promise<{ id: string }>;

interface Session {
  id: string;
}

function _uploads(value: Bucket) {
  return uploadHandler({
    bucket: value,
    constraints: { maxBytes: '20mb', contentTypes: ['image/png'] },
    context: (request) => Promise.resolve({ id: request.headers.get('x') ?? 'anon' }),
    onBeforeUpload: ({ ctx, route, file: picked }) => ({ path: `${route}/${ctx.id}/${picked.name}` }),
    onUploadComplete: ({ ctx, route, path, size, multipartUploadId }) => ({
      owner: ctx.id,
      route,
      path,
      size,
      multipartUploadId,
    }),
    routes: {
      attachment: {},
      large: { constraints: { maxBytes: '2gb', contentTypes: null } },
      audit: { onUploadComplete: ({ ctx, uploadId }) => ({ owner: ctx.id, dedupe: uploadId }) },
      thread: upload<Session>()({
        input: z.object({ threadId: z.string() }),
        onBeforeUpload: ({ ctx, input, file: picked }) => ({
          path: `${ctx.id}/${input.threadId}`,
          state: { name: picked.name },
        }),
        onUploadComplete: ({ ctx, state, uploadId, multipartUploadId }) => ({
          owner: ctx.id,
          name: state.name,
          dedupe: uploadId,
          multipartUploadId,
        }),
      }),
    },
  });
}

type Uploads = ReturnType<typeof _uploads>;
const { useUpload: useBound } = createUploadHooks<Uploads>({ headers: () => ({ authorization: 'x' }) });

function _ctx() {
  const session: UploadContext<Uploads> = { id: 'demo' };
  // @ts-expect-error ctx is what the handler context returned
  const wrong: UploadContext<Uploads> = { nope: true };
  const same: UploadContext<Session> = session;
  const audit = ({ ctx, file: picked }: BeforeUploadArgs<Uploads>) => `${ctx.id}:${picked.name}`;
  const picked: UploadFile = { name: 'a.png', type: 'image/png', size: 10 };
  void [session, wrong, same, audit, picked];

  uploadHandler({
    bucket,
    onBeforeUpload: ({ ctx }) => ({ path: String(ctx satisfies undefined) }),
    routes: { a: { onBeforeUpload: ({ ctx }) => ({ path: String(ctx satisfies undefined) }) } },
  });
}

function _contextInference() {
  uploadHandler({
    bucket,
    context: (request) => requireUser(request),
    routes: { a: { onBeforeUpload: ({ ctx }) => ({ path: `${ctx satisfies Session}` }) } },
  });
  uploadHandler({
    bucket,
    context: (request) => requireUser(request),
    onBeforeUpload: ({ ctx }) => ({ path: `${ctx satisfies Session}` }),
    routes: {
      a: { onUploadComplete: ({ ctx, uploadId, multipartUploadId }) => ({ owner: ctx.id, uploadId, multipartUploadId }) },
      b: { onUploadComplete: ({ ctx }) => ctx.id },
    },
  });
  uploadHandler({
    bucket,
    context: (request) => requireUser(request),
    routes: {
      a: { onUploadComplete: saveRow },
      t: upload<Session>()({ onBeforeUpload: ({ ctx }) => ({ path: ctx.id }) }),
    },
  });
  uploadHandler({
    routes: { a: { onBeforeUpload: ({ ctx }) => ({ path: `${ctx satisfies Session}` }) } },
    bucket,
    context: () => ({ id: 'x' }),
  });
}

function _contextBelowRoutes() {
  uploadHandler({
    bucket,
    routes: { a: { onBeforeUpload: ({ ctx }) => ({ path: `${ctx satisfies undefined}` }) } },
    // @ts-expect-error unannotated context below routes was inferred too late
    context: (request) => requireUser(request),
  });
  uploadHandler({
    routes: { a: { onBeforeUpload: ({ ctx }) => ({ path: `${ctx satisfies Session}` }) } },
    bucket,
    context: (request: Request) => requireUser(request),
  });
}

function _routeShapes() {
  uploadHandler({
    bucket,
    context: () => 'u',
    routes: {
      // @ts-expect-error removed transport flags are rejected rather than silently uploading direct
      a: { proxy: true },
      // @ts-expect-error arbitrary route fields are rejected
      b: { field: 'x' },
      c: { onBeforeUpload: () => ({ path: 'p' }) },
      d: { onUploadComplete: ({ uploadId, multipartUploadId }) => [uploadId, multipartUploadId] },
    },
  });
  uploadHandler({
    bucket,
    routes: { a: { onBeforeUpload: () => ({ path: 'p' }) } },
    onUploadComplete: ({ uploadId, multipartUploadId }) => [uploadId, multipartUploadId],
  });

  const _forwards = uploadHandler({
    bucket,
    onBeforeUpload: () => ({ path: 'p' }),
    routes: { a: {}, b: {}, c: { onUploadComplete: () => 7 } },
  });
  const _backwards = uploadHandler({
    bucket,
    onBeforeUpload: () => ({ path: 'p' }),
    routes: { c: { onUploadComplete: () => 7 }, b: {}, a: {} },
  });
  type Forwards = RoutesOf<typeof _forwards>;
  type Backwards = RoutesOf<typeof _backwards>;
  const sameKeys: keyof Forwards extends keyof Backwards
    ? keyof Backwards extends keyof Forwards
      ? true
      : false
    : false = true;
  const sameData: Forwards['c']['__upstashUploadRoute']['data'] extends Backwards['c']['__upstashUploadRoute']['data']
    ? true
    : false = true;
  void [sameKeys, sameData];
}

function _boundHooks() {
  useBound('attachment');
  useBound('large');
  // @ts-expect-error typo is not a route this handler mounts
  useBound('attachmnt');
  // @ts-expect-error a URL is not one of this handler's route names
  useBound('/api/upload');
  // @ts-expect-error this handler has named routes
  useBound();

  const thread = useBound('thread');
  thread.start({ file, input: { threadId: 't1' } });
  // @ts-expect-error schema input is required
  thread.start({ file });
  // @ts-expect-error input must match the schema
  thread.start({ file, input: { threadId: 1 } });

  const large = useBound('large');
  large.start({ file });
  large.start({ files: [file] });
  large.upload?.pause();
  large.upload?.resume();
  void large.upload?.stalled;
  // @ts-expect-error direct routes accept files, not arbitrary request bodies
  large.start({ body: new Blob([]) });

  const inherited = useBound('attachment').upload;
  if (inherited?.status === 'done') {
    void (inherited.blob.data.owner satisfies string);
    void (inherited.blob.uploadedAt.getTime() satisfies number);
    // @ts-expect-error default completion data has no such member
    void inherited.blob.data.nope;
  }
  const own = useBound('audit').upload;
  if (own?.status === 'done') {
    void (own.blob.data.dedupe satisfies string);
    // @ts-expect-error route completion replaces default completion data
    void own.blob.data.path;
  }
}

function _single(value: Bucket) {
  const _one = uploadHandler({
    bucket: value,
    context: (request: Request) => ({ id: request.url }),
    input: z.object({ threadId: z.string() }),
    onBeforeUpload: ({ ctx, input, file: picked }) => ({ path: `${ctx.id}/${input.threadId}/${picked.name}` }),
    onUploadComplete: ({ ctx, path }) => ({ owner: ctx.id, path }),
  });
  const hooks = createUploadHooks<typeof _one>({});
  const only = hooks.useUpload();
  only.start({ file, input: { threadId: 't1' } });
  // @ts-expect-error the sole route's schema makes input required
  only.start({ file });
  if (only.upload?.status === 'done') void (only.upload.blob.data.owner satisfies string);
  hooks.useUpload({ concurrency: 2, onDone: (record) => void (record.blob.data.path satisfies string) });
}

type Legacy = UploadRoute<undefined, { legacy: boolean }, '/api/legacy'>;
type Unnamed = UploadRoute<undefined, { any: true }>;
type Dynamic = UploadRoute<undefined, { legacy: boolean }>;

function _routeUnions() {
  const hooks = createUploadHooks<Uploads | Legacy>({});
  hooks.useUpload('attachment', { onDone: (record) => void (record.blob.data.owner satisfies string) });
  hooks.useUpload('/api/legacy', { onDone: (record) => void (record.blob.data.legacy satisfies boolean) });
  // @ts-expect-error URL typo remains checked against the union
  hooks.useUpload('/api/legcy');

  const mixed = createUploadHooks<Uploads | Unnamed>({});
  mixed.useUpload('large');
  // @ts-expect-error unnamed route does not widen all keys to string
  mixed.useUpload('larg');
  const unnamed = createUploadHooks<Unnamed>({});
  // @ts-expect-error an unnamed brand contributes no key
  unnamed.useUpload('anything');
}

function _escapeHatches() {
  const dynamic = useUpload<Dynamic>(`/api/upload/${String(Math.random())}`);
  if (dynamic.upload?.status === 'done') void (dynamic.upload.blob.data.legacy satisfies boolean);
  // @ts-expect-error this brand declared another URL
  useUpload<Legacy>(`/api/upload/${String(Math.random())}`);

  const server = useServerUpload<{ url: string }>('/api/avatar');
  server.start({ file });
  server.start({ body: new Blob([]) });
  if (server.upload?.status === 'done') void (server.upload.response.url satisfies string);

  // @ts-expect-error the route is positional; there is no compatibility object form
  useServerUpload<{ ok: boolean }>({ route: '/api/avatar', concurrency: 1 });

  const configured = createUploadHooks({ headers: () => ({}) });
  configured.useUpload<Legacy>('/api/legacy');
  // @ts-expect-error the route declared a different path
  configured.useUpload<Legacy>('/api/nope');
  // @ts-expect-error createUploadHooks configures direct useUpload only
  const missing = configured.useServerUpload;
  void missing;
}

test('the handler types compile', () => {
  expect(typeof uploadHandler).toBe('function');
  expect(typeof useServerUpload).toBe('function');
  void [_ctx, _contextInference, _contextBelowRoutes, _routeShapes, _boundHooks, _single, _routeUnions, _escapeHatches];
  void ({} as UploadCompleteArgs<Uploads>);
});
