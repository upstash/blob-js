import { BlobError } from '../shared/errors.ts';
import type { CompletedBlob, UploadFile, UploadRouteTypes } from '../shared/types.ts';
import type { CacheOption, Size } from '../shared/units.ts';
import type { Bucket } from './bucket.ts';
import { handleProxyUpload } from './handle-proxy-upload.ts';
import { answerError, deriveRouteId, handleUpload, resolveConstraints, type ErrorDetails, type StandardSchema, type UploadConstraints } from './handle-upload.ts';

/**
 * One upload endpoint. With no `routes` it is the route: the client calls `useUpload()` and nothing
 * names anything twice. With `routes` it mounts several at the same endpoint, the name in the query
 * -- `useUpload('avatar')` -- and the client reads each route's input, its data and its transport off
 * `typeof uploads`, so a page never spells out a url and a typo does not compile.
 *
 * `bucket`, `constraints`, `input`, `proxy`, `field`, `onBeforeUpload`, `onUploadComplete` and `onError`
 * at the top are DEFAULTS: a route replaces them key by key and inherits the rest.
 *
 * One rule about `context`: write it above the callbacks that read `ctx`. `(request) =>` with no
 * annotation is fine there. Written below `routes`, TypeScript has already typed the routes with
 * `ctx: undefined` by the time it reads what `context` returns, and the error lands on `context`
 * itself: "Promise<Session> is not assignable to undefined". Annotating the parameter,
 * `(request: Request) =>`, lifts the order rule, because TypeScript reads an annotated function's
 * return before it types anything else in the literal.
 */

type InferOutput<S> = S extends StandardSchema<any, infer O> ? O : never;
type RouteInputOf<TSchema> = TSchema extends StandardSchema<any, any> ? InferOutput<TSchema> : undefined;

/** A route's constraints REPLACE the handler's per key; `null` clears a key the handler set. */
export interface RouteConstraints {
  contentTypes?: readonly string[] | null;
  maxBytes?: Size | null;
}

/**
 * The ctx a handler hands every callback. Takes the handler -- `UploadContext<typeof uploads>` -- or
 * a ctx type, which passes straight through, so a callback written beside the handler and one
 * written in another file are annotated the same way.
 */
export type UploadContext<T> = [T] extends [{ readonly __upstashUploadContext: infer TCtx }] ? TCtx : T;

/* --------------------------------------------------------- callback args -- */

interface BeforeArgs<TCtx, TInput> {
  /** Whatever `context` returned for this request. */
  ctx: TCtx;
  /** The route this file was sent to. '' when the handler mounts no named routes. */
  route: string;
  request: Request;
  file: UploadFile;
  input: TInput;
}

interface BeforeResult<TState, TProxy extends boolean> {
  path: string;
  cache?: CacheOption;
  metadata?: Record<string, string>;
  /** May narrow the route's constraints per user, never widen them. */
  constraints?: UploadConstraints;
  /** Carried to onUploadComplete and to onError. `metadata` is the way to carry an id. */
  state?: TState;
  /** Proxy routes only. false: If-None-Match: * server-side, so a second upload is a real 412. */
  overwrite?: TProxy extends true ? boolean : never;
}

interface CompleteBase<TCtx, TState> extends CompletedBlob {
  ctx: TCtx;
  route: string;
  request: Request;
  /** What the browser declared before a byte was sent: the name is the only place it survives. */
  file: UploadFile;
  /** Identifies this upload. Direct completion retries preserve it across callback deliveries. */
  uploadId: string;
  metadata: Record<string, string>;
  state: TState;
}

interface DirectCompleteExtras {
  /** R2's own multipart id, for a bucket.abortMultipart(). */
  multipartUploadId: string;
}

interface ErrorArgs<TCtx> {
  ctx: TCtx | undefined;
  route: string;
  request: Request;
  error: unknown;
  /** As much as the request had reached before it failed. */
  file?: UploadFile;
  path?: string;
  metadata?: Record<string, string>;
  state?: unknown;
}

/**
 * The args a route's `onBeforeUpload` is called with. Inside the handler they are contextual and
 * nothing needs writing; this is for the callback two routes share, written once elsewhere:
 * `({ ctx, file }: BeforeUploadArgs<typeof uploads>) => ...`.
 */
export type BeforeUploadArgs<TCtx = unknown, TInput = undefined, TRoute extends string = string> = BeforeArgs<UploadContext<TCtx>, TInput> & { route: TRoute };
export type BeforeUploadResult<TState = undefined, TProxy extends boolean = boolean> = BeforeResult<TState, TProxy>;

/**
 * Flat: the stored object, plus what this route knows about it. Both transports receive an
 * `uploadId`; direct completion retries preserve it as an idempotency key. Pass a route union as
 * the second argument when a shared callback is declared outside its handler:
 * `UploadCompleteArgs<Session, 'attachment' | 'large'>`.
 */
export type UploadCompleteArgs<TCtx = unknown, TRoute extends string = string, TState = undefined, TProxy extends boolean = boolean> = CompleteBase<UploadContext<TCtx>, TState> & { route: TRoute } & (TProxy extends true ? unknown : DirectCompleteExtras);

/** What `onError` is handed. Return a BlobError or a Response to answer with it; return nothing to fall through. */
export type UploadErrorArgs<TCtx = unknown, TRoute extends string = string> = ErrorArgs<UploadContext<TCtx>> & { route: TRoute };

type ErrorReturn = BlobError | Response | void | Promise<BlobError | Response | void>;

/* --------------------------------------------------------- plain routes -- */

interface PlainRouteBase<TCtx, TInput, TProxy extends boolean> {
  /** Defaults to the handler's. */
  bucket?: Bucket;
  /** Replaces the handler's per key; `null` clears one the handler set. */
  constraints?: RouteConstraints;
  /** Replaces the handler's. */
  onBeforeUpload?: (args: BeforeArgs<TCtx, TInput>) => BeforeResult<undefined, TProxy> | Promise<BeforeResult<undefined, TProxy>>;
  /** Replaces the handler's. What it returns is `upload.blob.data` in the browser, typed. */
  onUploadComplete?: (args: CompleteBase<TCtx, undefined> & (TProxy extends true ? unknown : DirectCompleteExtras)) => unknown;
  /** Replaces the handler's. */
  onError?: (args: ErrorArgs<TCtx>) => ErrorReturn;
}

/** A route written as a plain object. Presigned: the bytes go straight to storage. */
export interface DirectUploadRoute<TCtx = unknown, TInput = undefined> extends PlainRouteBase<TCtx, TInput, false> {
  proxy?: false;
  /**
   * Proxy only. Typed out here rather than left off: `routes` is checked as an intersection, and
   * TypeScript skips the "no properties in common" check inside one, so an absent key would let
   * `{ field: 'x' }` through on a direct route.
   */
  field?: never;
}

/** A route written as a plain object whose bytes go through your function as one POST. */
export interface ProxyUploadRoute<TCtx = unknown, TInput = undefined> extends PlainRouteBase<TCtx, TInput, true> {
  proxy: true;
  /** The multipart field the file arrives in. Default 'file'. */
  field?: string;
}

/**
 * What `upload()` returns. The brand is types only: it is how `createUploadHooks<typeof uploads>`
 * knows this route's input, its data and whether it is proxied. `proxy?: never` is what keeps it out
 * of the plain-object union's discriminant.
 */
export interface UploadRouteDefinition<TInput = undefined, TData = void, TProxy extends boolean = false> {
  readonly __upstashUploadRoute: UploadRouteTypes<TInput, TData, string, TProxy>;
  readonly proxy?: never;
}

/** Anything `routes` accepts for one key. */
export type AnyUploadRouteConfig<TCtx = unknown, TInput = undefined> = DirectUploadRoute<TCtx, TInput> | ProxyUploadRoute<TCtx, TInput> | UploadRouteDefinition<any, any, any>;

export type UploadRouteMap = Record<string, UploadRouteDefinition<any, any, any>>;

/**
 * What `routes` is checked against: every route as a plain object or an `upload()`, with the ctx
 * the handler's `context` returned. Written as a separate type so that TypeScript keeps `TCtx` in
 * the route callbacks' contextual type (see the note at `routes` in UploadHandlerOptions).
 */
export type UploadRoutes<TCtx = unknown, TInput = undefined> = Record<string, AnyUploadRouteConfig<TCtx, TInput>>;

/* -------------------------------------------------------------- builder -- */

/**
 * The options `upload()` takes: a plain object plus the two things it cannot express -- an `input`
 * schema and a `state` typed from what onBeforeUpload returned.
 */
export interface UploadRouteOptions<TCtx, TSchema extends StandardSchema<any, any> | undefined, TState, TData, TProxy extends boolean> {
  /** The bytes go through this route as one POST. Bounded by the platform's request body cap. */
  proxy?: TProxy;
  bucket?: Bucket;
  constraints?: RouteConstraints;
  /** A Standard Schema the browser's `input` is validated against before onBeforeUpload runs. */
  input?: TSchema;
  /** Proxy routes only: the multipart field the file arrives in. Default 'file'. */
  field?: TProxy extends true ? string : never;
  onBeforeUpload?: (args: BeforeArgs<TCtx, RouteInputOf<TSchema>>) => BeforeResult<TState, TProxy> | Promise<BeforeResult<TState, TProxy>>;
  onUploadComplete?: (args: CompleteBase<TCtx, TState> & (TProxy extends true ? unknown : DirectCompleteExtras)) => TData | Promise<TData>;
  onError?: (args: ErrorArgs<TCtx>) => ErrorReturn;
}

export interface UploadBuilder<TCtx> {
  <TSchema extends StandardSchema<any, any> | undefined = undefined, TState = undefined, TData = void, TProxy extends boolean = false>(
    options: UploadRouteOptions<TCtx, TSchema, TState, TData, TProxy>,
    // NoInfer, all three: this builder is written inside the `routes` literal, whose element type is
    // a union that includes an `UploadRouteDefinition<any, any, any>`. Without it TypeScript infers
    // TProxy from that contextual `any` and `uploadId` disappears from onUploadComplete.
  ): UploadRouteDefinition<NoInfer<RouteInputOf<TSchema>>, NoInfer<TData>, NoInfer<TProxy>>;
}

/**
 * A route that needs what a plain object cannot carry: an `input` schema, or a `state` typed from
 * what its own onBeforeUpload returned. Curried, because the ctx has to be named -- the plain object
 * gets it from the handler it sits in, and this one is written on its own:
 *
 * ```ts
 * const thread = upload<Owner>()({
 *   input: z.object({ threadId: z.string() }),
 *   onBeforeUpload: ({ ctx, input, file }) => ({ path: `${ctx}/${input.threadId}`, state: { name: file.name } }),
 *   onUploadComplete: ({ state, url }) => db.files.insert({ name: state.name, url }),
 * });
 * ```
 */
export function upload<TCtx = undefined>(): UploadBuilder<TCtx> {
  return ((options: object) => ({ [BUILT]: options })) as unknown as UploadBuilder<TCtx>;
}

/** Where the builder parks its options. Types only see the brand; the runtime only reads this. */
const BUILT = '__upstashUploadOptions';

/* --------------------------------------------------------- the handler -- */

/** True for `{ proxy: true }` and for an `upload({ proxy: true })`; otherwise the handler's own. */
type ProxyOf<R, TDefault extends boolean> = R extends UploadRouteDefinition<any, any, infer TProxy> ? TProxy : R extends { proxy: true } ? true : R extends { proxy: false } ? false : TDefault;
/** A route's own onUploadComplete wins; a route without one answers with whatever the handler's returned. */
type DataOf<R, TDefault> = R extends UploadRouteDefinition<any, infer TData, any> ? TData : R extends { onUploadComplete: (...args: any) => infer TData } ? Awaited<TData> : TDefault;
type InputOf<R, TDefault> = R extends UploadRouteDefinition<infer TInput, any, any> ? TInput : TDefault;

interface RouteBrand<TInput, TData, TProxy extends boolean> {
  readonly __upstashUploadRoute: UploadRouteTypes<TInput, TData, string, TProxy>;
}

/**
 * The map `createUploadHooks<typeof uploads>` reads. No `routes` means one route under the empty
 * name, which is what makes the bound `useUpload()` take no argument.
 */
export type HandlerRoutes<TRoutes, TData, TInput, TProxy extends boolean> = string extends keyof TRoutes
  ? { readonly '': RouteBrand<TInput, TData, TProxy> }
  : { readonly [K in keyof TRoutes]: RouteBrand<InputOf<TRoutes[K], TInput>, DataOf<TRoutes[K], TData>, ProxyOf<TRoutes[K], TProxy>> };

export interface UploadHandlerOptions<TCtx, TRoutes, TData, TSchema extends StandardSchema<any, any> | undefined, TProxy extends boolean> {
  /** Every route inherits it; a route may name its own. */
  bucket?: Bucket;
  /** Every route inherits it; a route's `constraints` replaces per key and `null` clears one. */
  constraints?: RouteConstraints;
  /**
   * Where this handler is mounted. Only used to separate two handlers on one bucket, whose route
   * names would otherwise derive the same completion-token id.
   */
  endpoint?: string;
  /**
   * Runs once per request, before the route does and before any body is read. It may be synchronous
   * or async; its resolved value is `ctx` in every callback, typed. Throw to refuse: a
   * BlobError('unauthorized') is the 401.
   * Not run for GET, which serves a public, cacheable constraints document and reads nothing.
   *
   * Write it above the callbacks: see the note at the top of this file.
   */
  context?: (request: Request) => TCtx;
  /** Every route inherits it. A Standard Schema for the browser's `input`. */
  input?: TSchema;
  /**
   * Whether the bytes go through your function as one POST. With no `routes` it is the one route's
   * transport; with them it is the default, and a route's own `proxy` replaces it.
   */
  proxy?: TProxy;
  /** Every proxy route inherits it: the multipart field the file arrives in. Default 'file'. */
  field?: string;
  /** The default. A route with its own onBeforeUpload replaces it. */
  onBeforeUpload?: (args: BeforeArgs<Awaited<TCtx>, RouteInputOf<TSchema>>) => BeforeResult<undefined, boolean> | Promise<BeforeResult<undefined, boolean>>;
  /**
   * The default. A route with its own onUploadComplete replaces it, and answers the browser with its
   * own return instead of this one. Direct completion is at-least-once; use `uploadId` atomically.
   */
  onUploadComplete?: (args: CompleteBase<Awaited<TCtx>, undefined>) => TData | Promise<TData>;
  /**
   * The default. Sees every refusal, this handler's own included: return a BlobError or a Response to
   * answer with it, return nothing to leave the answer alone. It is the one place to log.
   */
  onError?: (args: ErrorArgs<Awaited<TCtx>>) => ErrorReturn;
  /**
   * Omit it and the handler is one route, reached with no `?route=` and no name on the client.
   *
   * The intersection is not decoration. `TRoutes` alone is a type parameter, and TypeScript
   * instantiates a type parameter in a contextual type eagerly, with whatever it has inferred for
   * `TCtx` at that moment -- which, when `context` is `(request) => ...`, is nothing yet: the return
   * of an unannotated function only reaches the inference when something forces `TCtx` to be fixed.
   * An object type in the intersection is left alone, so the route callbacks are contextually typed
   * with `Awaited<TCtx>` still in them, and typing the first one fixes `TCtx` from what `context`
   * returned. That is what lets `context: (request) => requireUser(request)` stay unannotated, as
   * long as it is written above `routes`.
   */
  routes?: TRoutes & UploadRoutes<Awaited<TCtx>, RouteInputOf<TSchema>>;
}

export interface UploadHandler<TRoutes = UploadRouteMap, TCtx = unknown> {
  GET: (request: Request) => Promise<Response>;
  POST: (request: Request) => Promise<Response>;
  /** The route map, as types. This is what `createUploadHooks<typeof uploads>` reads. */
  readonly __upstashUploadHandler: TRoutes;
  /** What `context` returned, as types. This is what `UploadContext<typeof uploads>` reads. */
  readonly __upstashUploadContext: TCtx;
}

/** Route names live in a url query, so they are limited to what reads back as one word. */
const ROUTE_NAME = /^[A-Za-z_][\w-]*$/;

interface Mounted {
  GET: (request: Request) => Promise<Response>;
  POST: (request: Request) => Promise<Response>;
  onError: (error: unknown, request: Request, details: ErrorDetails) => ErrorReturn;
}

/** What the request carries between the handler and the callbacks the transports own. */
interface Slot {
  ctx: unknown;
}

interface AnyRouteSpec {
  bucket?: Bucket;
  constraints?: RouteConstraints;
  input?: StandardSchema<any, any>;
  proxy?: boolean;
  field?: string;
  onBeforeUpload?: (args: any) => any;
  onUploadComplete?: (args: any) => any;
  onError?: (args: any) => ErrorReturn;
}

/**
 * `TRoutes` is first and has no default on purpose: with a default, or behind `TCtx`, TypeScript
 * stops reading the route literal and every route's data comes back `unknown`. Its constraint is
 * deliberately shapeless: the route shape, with the ctx, is the `UploadRoutes` half of `routes`,
 * and a constraint that repeated it would be intersected with that half in every callback's
 * contextual type, which TypeScript cannot discriminate by `proxy`.
 */
export function uploadHandler<
  TRoutes extends Record<string, object>,
  TCtx = undefined,
  TData = void,
  TSchema extends StandardSchema<any, any> | undefined = undefined,
  TProxy extends boolean = false,
>(options: UploadHandlerOptions<TCtx, TRoutes, TData, TSchema, TProxy>): UploadHandler<HandlerRoutes<TRoutes, TData, RouteInputOf<TSchema>, TProxy>, Awaited<TCtx>> {
  const named = options.routes !== undefined;
  const definitions = (options.routes ?? { '': {} }) as unknown as Record<string, unknown>;
  if (named && Object.keys(definitions).length === 0) throw new TypeError('uploadHandler was given an empty routes map: name at least one route, or omit routes to make the handler the route');

  // The request is the key, so `ctx` reaches callbacks the transports own without either of them
  // learning about the other. Weak: nothing here outlives the request it belongs to.
  const slots = new WeakMap<Request, Slot>();

  // Object.create(null), not {}: `?route=toString` on a plain object literal finds Object.prototype's
  // and dispatches to a function with no onBeforeUpload. Object.hasOwn below is the second lock.
  const table: Record<string, Mounted> = Object.create(null) as Record<string, Mounted>;
  for (const name of Object.keys(definitions)) {
    if (named && !ROUTE_NAME.test(name)) throw new TypeError(`upload route names must match ${String(ROUTE_NAME)}: ${JSON.stringify(name)} does not`);
    table[name] = mount(name, specOf(definitions[name]));
  }
  const sole = named ? undefined : table['']!;

  function mount(name: string, route: AnyRouteSpec): Mounted {
    const bucket = route.bucket ?? options.bucket;
    if (!bucket) throw new TypeError(named ? `upload route ${JSON.stringify(name)} has no bucket: name one on the route or on the handler` : 'uploadHandler needs a bucket');
    const onBeforeUpload = route.onBeforeUpload ?? (options.onBeforeUpload as ((args: any) => any) | undefined);
    if (!onBeforeUpload) throw new TypeError(named ? `upload route ${JSON.stringify(name)} has no onBeforeUpload: write one on the route or on the handler` : 'uploadHandler needs an onBeforeUpload');
    const onUploadComplete = route.onUploadComplete ?? (options.onUploadComplete as ((args: any) => any) | undefined);
    const onRouteError = route.onError ?? (options.onError as ((args: any) => ErrorReturn) | undefined);
    const input = route.input ?? options.input;
    const constraints = mergeConstraints(options.constraints, route.constraints);

    const ctxOf = (request: Request): unknown => slots.get(request)?.ctx;
    const onError = onRouteError
      ? (error: unknown, request: Request, details: ErrorDetails) => onRouteError({ ctx: ctxOf(request), route: name, request, error, ...details })
      : undefined;

    const shared = {
      bucket,
      route: name,
      // The name is the token's route id, so two routes with identical constraints no longer collide.
      // An endpoint separates two handlers sharing one bucket.
      id: deriveRouteId(resolveConstraints(constraints), input !== undefined, options.endpoint ? `${options.endpoint}?route=${name}` : name),
      constraints,
      input,
      onBeforeUpload: (args: any) => onBeforeUpload({ ...args, ctx: ctxOf(args.request as Request) }),
      onUploadComplete: onUploadComplete ? (args: any) => onUploadComplete({ ...args, ctx: ctxOf(args.request as Request) }) : undefined,
      onError,
    };

    const proxy = route.proxy ?? options.proxy;
    const handlers = proxy ? handleProxyUpload({ ...shared, field: route.field ?? options.field }) : handleUpload(shared);
    return { GET: handlers.GET, POST: handlers.POST, onError: onError ?? (() => undefined) };
  }

  const notFound = async (name: string, request: Request): Promise<Response> => {
    // Never the names it does mount, and never a 500: an unknown route is a 404 like any other.
    const error = new BlobError('not_found', { message: 'unknown upload route' });
    const mapper = options.onError ? (e: unknown, r: Request) => options.onError!({ ctx: undefined, route: name, request: r, error: e }) : undefined;
    return await answerError(error, request, mapper);
  };

  function pick(request: Request): { name: string; mounted: Mounted | undefined } {
    let name = '';
    try {
      name = new URL(request.url).searchParams.get('route') ?? '';
    } catch {
      // A url the runtime will not parse names no route.
    }
    // A handler with no routes is reached with no name. A name on its query is a client bound to
    // a different handler, and serving it here would upload through a route it never asked for.
    if (sole) return { name, mounted: name ? undefined : sole };
    return { name, mounted: name && Object.hasOwn(table, name) ? table[name] : undefined };
  }

  const GET = async (request: Request): Promise<Response> => {
    const { name, mounted } = pick(request);
    if (!mounted) return await notFound(name, request);
    return await mounted.GET(request);
  };

  const POST = async (request: Request): Promise<Response> => {
    const { name, mounted } = pick(request);
    if (!mounted) return await notFound(name, request);

    const slot: Slot = { ctx: undefined };
    slots.set(request, slot);
    if (options.context) {
      try {
        slot.ctx = await options.context(request);
      } catch (e) {
        return await answerError(e, request, mounted.onError);
      }
    }
    return await mounted.POST(request);
  };

  // Types only, never read: the two brands are how `typeof uploads` carries its routes and its ctx.
  return {
    GET,
    POST,
    __upstashUploadHandler: undefined as unknown as HandlerRoutes<TRoutes, TData, RouteInputOf<TSchema>, TProxy>,
    __upstashUploadContext: undefined as unknown as Awaited<TCtx>,
  };
}

/** A plain object is its own spec; an `upload()` parked its options under the builder's key. */
function specOf(route: unknown): AnyRouteSpec {
  if (!route || typeof route !== 'object') throw new TypeError('every route is a plain object or an upload({ ... })');
  const built = (route as Record<string, unknown>)[BUILT];
  return (built ?? route) as AnyRouteSpec;
}

/** The route's own constraints, key by key, over the handler's. `null` clears one the handler set. */
function mergeConstraints(base: RouteConstraints | undefined, own: RouteConstraints | undefined): UploadConstraints {
  const pick = <T>(fallback: T | null | undefined, value: T | null | undefined): T | undefined => (value === undefined ? (fallback ?? undefined) : (value ?? undefined));
  return {
    contentTypes: pick(base?.contentTypes, own?.contentTypes),
    maxBytes: pick(base?.maxBytes, own?.maxBytes),
  };
}
