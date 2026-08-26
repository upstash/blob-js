import { expect, test } from 'bun:test';
import * as z from 'zod';
import { upload, uploadHandler, type Bucket, type BeforeUploadArgs, type UploadCompleteArgs, type UploadContext, type UploadFile, type UploadRoute } from '../../src/index.ts';
import { createUploadHooks, useUpload, useUploadProxy, type RoutesOf } from '../../src/react/index.ts';

// Compile-only. Nothing below the handler definitions ever runs: the @ts-expect-error lines are the
// assertions, and a signature that stops being wrong fails the build.

declare const bucket: Bucket;
declare const file: File;
declare function requireUser(request: Request): Promise<Session>;
declare function saveRow(args: { ctx: Session; path: string }): Promise<{ id: string }>;

interface Session {
  id: string;
}

function _uploads(bucket: Bucket) {
  return uploadHandler({
    bucket,
    constraints: { maxBytes: '20mb', contentTypes: ['image/png'] },
    // Unannotated, above the callbacks: the shape the README shows.
    context: (request) => Promise.resolve({ id: request.headers.get('x') ?? 'anon' }),
    onBeforeUpload: ({ ctx, route, file: picked }) => ({ path: `${route}/${ctx.id}/${picked.name}` }),
    onUploadComplete: ({ ctx, route, path, size }) => ({ owner: ctx.id, route, path, size }),
    routes: {
      // Inherits both defaults, so its data is the handler's.
      attachment: {},
      large: { constraints: { maxBytes: '2gb', contentTypes: null } },
      // Its own completion, so its own data.
      audit: { onUploadComplete: ({ ctx, uploadId }) => ({ owner: ctx.id, dedupe: uploadId }) },
      avatar: {
        proxy: true,
        constraints: { maxBytes: '2mb' },
        onBeforeUpload: ({ ctx }) => ({ path: `avatar/${ctx.id}`, overwrite: false }),
        onUploadComplete: ({ ctx, versionedUrl }) => ({ owner: ctx.id, url: versionedUrl }),
      },
      // The builder, for the two things a plain object cannot carry: an input schema and a state.
      thread: upload<Session>()({
        input: z.object({ threadId: z.string() }),
        onBeforeUpload: ({ ctx, input, file: picked }) => ({ path: `${ctx.id}/${input.threadId}`, state: { name: picked.name } }),
        onUploadComplete: ({ ctx, state, uploadId }) => ({ owner: ctx.id, name: state.name, dedupe: uploadId }),
      }),
    },
  });
}

type Uploads = ReturnType<typeof _uploads>;

const { useUpload: useBound, useUploadProxy: useBoundProxy } = createUploadHooks<Uploads>({ headers: () => ({ authorization: 'x' }) });

/* --------------------------------------------------------------- ctx -- */

function _ctx() {
  // What `context` returned, carried on the handler for a callback written in another file.
  const session: UploadContext<Uploads> = { id: 'demo' };
  // @ts-expect-error ctx is what the handler's context returned, not anything
  const wrong: UploadContext<Uploads> = { nope: true };
  // A ctx type passes straight through, so both annotations are written the same way.
  const same: UploadContext<Session> = session;
  const audit = ({ ctx, file: picked }: BeforeUploadArgs<Uploads>) => `${ctx.id}:${picked.name}`;
  const picked: UploadFile = { name: 'a.png', type: 'image/png', size: 10 };
  void [session, wrong, same, audit, picked];

  // No context at all: ctx is undefined everywhere, in the defaults and in a route.
  uploadHandler({
    bucket,
    onBeforeUpload: ({ ctx }) => ({ path: String(ctx satisfies undefined) }),
    routes: { a: { onBeforeUpload: ({ ctx }) => ({ path: String(ctx satisfies undefined) }) } },
  });
}

/**
 * The one rule about `context`, as a test: written above the callbacks, an unannotated
 * `(request) => ...` types ctx in every route, with or without a handler-level callback between.
 */
function _contextUnannotated() {
  // Only routes read ctx: nothing between `context` and them.
  uploadHandler({
    bucket,
    context: (request) => requireUser(request),
    routes: { a: { onBeforeUpload: ({ ctx }) => ({ path: `${ctx satisfies Session}` }) } },
  });
  // A handler-level callback reads it too.
  uploadHandler({
    bucket,
    context: (request) => requireUser(request),
    onBeforeUpload: ({ ctx }) => ({ path: `${ctx satisfies Session}` }),
    routes: { a: { onUploadComplete: ({ ctx, uploadId }) => ({ owner: ctx.id, uploadId }) }, b: { proxy: true, onUploadComplete: ({ ctx }) => ctx.id } },
  });
  // A callback passed by reference, and an `upload()` route, beside plain ones.
  uploadHandler({
    bucket,
    context: (request) => requireUser(request),
    routes: { a: { onUploadComplete: saveRow }, t: upload<Session>()({ onBeforeUpload: ({ ctx }) => ({ path: ctx.id }) }) },
  });
  // No parameter at all is not context-sensitive, so it needs neither the order nor an annotation.
  uploadHandler({ routes: { a: { onBeforeUpload: ({ ctx }) => ({ path: `${ctx satisfies Session}` }) } }, bucket, context: () => ({ id: 'x' }) });
}

/**
 * Below the callbacks, an unannotated `context` is read after the routes were typed with
 * `ctx: undefined`, and the error lands on `context` itself: never a silent `unknown`, and never
 * an error on a callback that has nothing wrong with it.
 */
function _contextBelowRoutesFailsOnContext() {
  uploadHandler({
    bucket,
    routes: { a: { onBeforeUpload: ({ ctx }) => ({ path: `${ctx satisfies undefined}` }) } },
    // @ts-expect-error Promise<Session> is not assignable to undefined: the routes above were typed first
    context: (request) => requireUser(request),
  });
  // Annotated, the order rule is lifted: TypeScript reads an annotated function's return first.
  uploadHandler({
    routes: { a: { onBeforeUpload: ({ ctx }) => ({ path: `${ctx satisfies Session}` }) } },
    bucket,
    context: (request: Request) => requireUser(request),
  });
}

/* ------------------------------------------------------------- routes -- */

function _routeShapes() {
  uploadHandler({
    bucket,
    context: () => 'u',
    routes: {
      // @ts-expect-error field belongs to a proxy route
      a: { field: 'x' },
      // @ts-expect-error overwrite belongs to a proxy route
      b: { onBeforeUpload: () => ({ path: 'p', overwrite: false }) },
      c: { proxy: true, onBeforeUpload: () => ({ path: 'p', overwrite: false }) },
      // Both transports expose the SDK's logical upload id.
      d: { proxy: true, onUploadComplete: ({ uploadId }) => uploadId },
      // A direct route reaches it through the same discriminated union.
      e: { onUploadComplete: ({ uploadId }) => uploadId satisfies string },
    },
  });

  uploadHandler({
    bucket,
    routes: { a: { onBeforeUpload: () => ({ path: 'p' }) } },
    // A shared default receives the logical upload id on either transport.
    onUploadComplete: ({ uploadId }) => uploadId,
  });

  // The key order of `routes` changes nothing: the same three routes, written backwards.
  const _forwards = uploadHandler({ bucket, onBeforeUpload: () => ({ path: 'p' }), routes: { a: {}, b: { proxy: true }, c: { onUploadComplete: () => 7 } } });
  const _backwards = uploadHandler({ bucket, onBeforeUpload: () => ({ path: 'p' }), routes: { c: { onUploadComplete: () => 7 }, b: { proxy: true }, a: {} } });
  type Forwards = RoutesOf<typeof _forwards>;
  type Backwards = RoutesOf<typeof _backwards>;
  const sameKeys: keyof Forwards extends keyof Backwards ? (keyof Backwards extends keyof Forwards ? true : false) : false = true;
  const sameProxy: Forwards['b']['__upstashUploadRoute']['proxy'] extends Backwards['b']['__upstashUploadRoute']['proxy'] ? true : false = true;
  const sameData: Forwards['c']['__upstashUploadRoute']['data'] extends Backwards['c']['__upstashUploadRoute']['data'] ? true : false = true;
  void [sameKeys, sameProxy, sameData];
}

/* -------------------------------------------------------------- names -- */

function _names() {
  useBound('attachment');
  useBound('large');
  useBound('avatar');
  // @ts-expect-error 'attachmnt' is not a route this handler mounts
  useBound('attachmnt');
  // @ts-expect-error a url is not a route name here; use the explicit generic for one
  useBound('/api/upload');
  // @ts-expect-error this handler names its routes, so one has to be named
  useBound();

  const keys: RoutesOf<Uploads> extends Record<'attachment' | 'large' | 'avatar' | 'audit' | 'thread', unknown> ? true : false = true;
  void keys;
  void useBoundProxy;
}

/* -------------------------------------------------------------- input -- */

function _input() {
  const thread = useBound('thread');
  thread.start({ file, input: { threadId: 't1' } });
  // @ts-expect-error this route's schema makes input required
  thread.start({ file });
  // @ts-expect-error input must match the schema
  thread.start({ file, input: { threadId: 1 } });

  const large = useBound('large');
  large.start({ file });
  large.start({ files: [file] });
  // @ts-expect-error a route with no input schema takes none
  large.start({ file, input: { threadId: 't1' } });
}

/* --------------------------------------------------------------- data -- */

function _data() {
  // A route with no onUploadComplete of its own answers with what the handler's default returned.
  const { upload: inherited } = useBound('attachment');
  if (inherited?.status === 'done') {
    const owner: string = inherited.blob.data.owner;
    const at: number = inherited.blob.uploadedAt.getTime();
    void [owner, at];
    // @ts-expect-error the default's data has no such member
    void inherited.blob.data.nope;
  }

  // A route with its own replaces it, and its own is the only one the browser sees.
  const { upload: own } = useBound('audit');
  if (own?.status === 'done') {
    const dedupe: string = own.blob.data.dedupe;
    void dedupe;
    // @ts-expect-error the route replaced the default, so the default's members are gone
    void own.blob.data.path;
  }

  const { upload: built } = useBound('thread');
  if (built?.status === 'done') {
    const name: string = built.blob.data.name;
    void name;
    // @ts-expect-error the builder route's data is its own too
    void built.blob.data.path;
  }
}

/* --------------------------------------------------------- transports -- */

function _transports() {
  const direct = useBound('large');
  direct.upload?.pause();
  direct.upload?.resume();
  void direct.upload?.stalled;
  // @ts-expect-error a direct route has no raw body form
  direct.start({ body: new Blob([]) });
  // @ts-expect-error field belongs to a proxy route
  useBound('large', { field: 'x' });

  const proxy = useBound('avatar');
  proxy.start({ file });
  proxy.start({ body: new Blob([]) });
  useBound('avatar', { field: 'avatar' });
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

  // The `proxy: true` literal survives the whole trip from the route object to the hook.
  type R = RoutesOf<Uploads>;
  const isProxy: R['avatar']['__upstashUploadRoute']['proxy'] = true;
  const isDirect: R['large']['__upstashUploadRoute']['proxy'] = false;
  // @ts-expect-error avatar is the proxied one
  const wrong: R['avatar']['__upstashUploadRoute']['proxy'] = false;
  void [isProxy, isDirect, wrong];
}

/* -------------------------------------------------------- one route -- */

function _single(b: Bucket) {
  const _one = uploadHandler({
    bucket: b,
    context: (request: Request) => ({ id: request.url }),
    input: z.object({ threadId: z.string() }),
    onBeforeUpload: ({ ctx, input, file: picked }) => ({ path: `${ctx.id}/${input.threadId}/${picked.name}` }),
    onUploadComplete: ({ ctx, path }) => ({ owner: ctx.id, path }),
  });
  const hooks = createUploadHooks<typeof _one>({});

  // No name: the handler is the route.
  const only = hooks.useUpload();
  only.start({ file, input: { threadId: 't1' } });
  // @ts-expect-error the one route's schema makes input required
  only.start({ file });
  if (only.upload?.status === 'done') {
    const owner: string = only.upload.blob.data.owner;
    void owner;
    // @ts-expect-error the one route's data is what its onUploadComplete returned
    void only.upload.blob.data.nope;
  }
  // Options still work without a name.
  hooks.useUpload({ concurrency: 2, onDone: (u) => void (u.blob.data.path as string) });

  // A single-route handler that proxies keeps the literal too.
  const _oneProxy = uploadHandler({ bucket: b, proxy: true, onBeforeUpload: () => ({ path: 'avatar/demo', overwrite: false }) });
  const proxyHooks = createUploadHooks<typeof _oneProxy>({});
  proxyHooks.useUpload().start({ body: new Blob([]) });
  // @ts-expect-error a proxied upload has no parts to pause
  proxyHooks.useUpload().upload?.pause();
}

/* -------------------------------------------------- routes in a union -- */

// handleUpload is internal now, so a route this SDK did not mount is declared by its brand.
type Legacy = UploadRoute<undefined, { legacy: boolean }, '/api/legacy', false>;
type LegacyProxy = UploadRoute<undefined, { owner: string }, '/api/legacy-avatar', true>;
type Unnamed = UploadRoute<undefined, { any: true }>;
/** A route whose url is only known at runtime: its brand names no path, so any string fits it. */
type Dynamic = UploadRoute<undefined, { legacy: boolean }>;

function _union() {
  const hooks = createUploadHooks<Uploads | Legacy | LegacyProxy>({});

  // A handler's route name and a branded url in one map.
  hooks.useUpload('attachment', { onDone: (u) => void (u.blob.data.owner as string) });
  hooks.useUpload('/api/legacy', { onDone: (u) => void (u.blob.data.legacy as boolean) });
  hooks.useUpload('/api/legacy-avatar', { onDone: (u) => void (u.blob.data.owner as string) });
  // @ts-expect-error still checked against the union, so a typo is still a typo
  hooks.useUpload('/api/legacy-avatr');

  const legacyProxy = hooks.useUpload('/api/legacy-avatar');
  legacyProxy.start({ body: new Blob([]) });
  // @ts-expect-error the proxied route has no parts to pause either
  legacyProxy.upload?.pause();
}

function _unnamedContributesNothing() {
  // A route that declared no url must not widen the key union to `string`, which would turn the
  // typo check off for every other route in the map.
  const hooks = createUploadHooks<Uploads | Unnamed>({});
  hooks.useUpload('large');
  // @ts-expect-error the unnamed route contributed no key, so this is still a typo
  hooks.useUpload('larg');

  const only = createUploadHooks<Unnamed>({});
  // @ts-expect-error nothing named it, so there is nothing to name
  only.useUpload('anything');
}

/* --------------------------------------------------------- escape hatches -- */

function _escapeHatch() {
  const dynamic = useUpload<Dynamic>(`/api/upload/${String(Math.random())}`);
  if (dynamic.upload?.status === 'done') void (dynamic.upload.blob.data.legacy as boolean);

  // A route that named its url is checked against it, so the escape hatch cannot point elsewhere.
  // @ts-expect-error this branded route declared /api/legacy
  useUpload<Legacy>(`/api/upload/${String(Math.random())}`);

  // useUploadProxy stays loose: its reason to exist is a target this SDK did not write.
  const plain = useUploadProxy<{ url: string }>('/api/whatever');
  if (plain.upload?.status === 'done') void (plain.upload.response.url as string);
}

/* ------------------------------------------------------ unbound, as before -- */

function _unbound() {
  const hooks = createUploadHooks({ headers: () => ({}) });
  hooks.useUpload<Legacy>('/api/legacy');
  // @ts-expect-error the route declared a different path
  hooks.useUpload<Legacy>('/api/nope');
}

test('the handler types compile', () => {
  expect(typeof uploadHandler).toBe('function');
  expect(typeof useUpload).toBe('function');
  void [_ctx, _contextUnannotated, _contextBelowRoutesFailsOnContext, _routeShapes, _names, _input, _data, _transports, _single, _union, _unnamedContributesNothing, _escapeHatch, _unbound];
  void ({} as UploadCompleteArgs<Uploads>);
});
