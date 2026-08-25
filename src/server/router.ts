import { BlobError } from '../shared/errors.ts';
import type { BlobObject, UploadFile, UploadRouteTypes } from '../shared/types.ts';
import type { CacheOption, Size } from '../shared/units.ts';
import type { Bucket } from './bucket.ts';
import { handleProxyUpload } from './handle-proxy-upload.ts';
import { answerError, handleUpload, type StandardSchema, type UploadLimits } from './handle-upload.ts';

/**
 * Every upload route in one place, mounted at one endpoint, with the name in the query. The client
 * hooks take that name -- `useUpload('avatar')` -- and read the route's input, its data and its
 * transport off `typeof uploads`, so a page never spells out a url and a typo does not compile.
 *
 * handleUpload and handleProxyUpload stay exactly as they are: this composes them, and a single
 * route in its own file is still theirs to serve.
 */

type InferOutput<S> = S extends StandardSchema<any, infer O> ? O : never;
type RouteInputOf<TSchema> = TSchema extends StandardSchema<any, any> ? InferOutput<TSchema> : undefined;

/** A route's limits REPLACE the router's per key; `null` clears one the router set. */
export interface RouteLimits {
  allowedContentTypes?: readonly string[] | null;
  maxBytes?: Size | null;
}

/**
 * The ctx a router hands every callback. Takes the router -- `UploadContext<typeof uploads>` -- or a
 * ctx type, which passes straight through, so a callback written beside the router and one written
 * in another file are annotated the same way.
 */
export type UploadContext<T> = [T] extends [{ readonly __upstashUploadContext: infer TCtx }] ? TCtx : T;

/**
 * The args a route's `onBeforeUpload` is called with. Inside `upload({ ... })` they are contextual
 * and nothing needs writing; this is for the callback two routes share, written once elsewhere:
 * `({ ctx, file }: RouteBeforeUploadArgs<typeof uploads>) => ...`.
 */
export interface RouteBeforeUploadArgs<TCtx = unknown, TInput = undefined> {
  request: Request;
  file: UploadFile;
  input: TInput;
  /** Whatever the router's `context` returned for this request. */
  ctx: UploadContext<TCtx>;
}

export interface RouteBeforeUploadResult<TState, TProxy extends boolean> {
  path: string;
  cache?: CacheOption;
  metadata?: Record<string, string>;
  /** May narrow the route's limits per user, never widen them. */
  limits?: UploadLimits;
  /** Carried to onUploadCompleted and onBeforeUploadFailed. `metadata` is the way to carry an id. */
  state?: TState;
  /** Proxy routes only. false: If-None-Match: * server-side, so a second upload is a real 412. */
  overwrite?: TProxy extends true ? boolean : never;
}

export interface RouteBeforeUploadFailedArgs<TCtx = unknown, TInput = undefined, TState = undefined, TProxy extends boolean = boolean> extends RouteBeforeUploadArgs<TCtx, TInput> {
  /** What onBeforeUpload returned: the row it reserved is reachable through its state. */
  decided: RouteBeforeUploadResult<TState, TProxy>;
  error: BlobError;
}

interface CompletedBase<TCtx, TState> extends BlobObject {
  request: Request;
  /** What was stored, canonicalised and proven by the leading bytes: not what the browser claimed. */
  contentType: string;
  metadata: Record<string, string>;
  state: TState;
  ctx: UploadContext<TCtx>;
}

interface DirectCompletedExtras {
  /** Stable for one upload across a retried phase 'end': the key to dedupe on. */
  uploadId: string;
  /** R2's own multipart id, for a bucket.abortMultipart(). Undefined for a single PUT. */
  multipartUploadId: string | undefined;
}

/**
 * Flat: the stored object, plus what this route knows about it. Absent on proxy: the two ids, which
 * is why `TProxy` defaults to `boolean` -- the fields both transports carry, so one annotation fits
 * a shared callback mounted on either. Pass `false` to reach `uploadId` on a direct route.
 */
export type RouteUploadCompletedArgs<TCtx = unknown, TState = undefined, TProxy extends boolean = boolean> = CompletedBase<TCtx, TState> & (TProxy extends true ? unknown : DirectCompletedExtras);

export interface RouteErrorArgs<TCtx = unknown> {
  error: unknown;
  request: Request;
  ctx: UploadContext<TCtx> | undefined;
}

/**
 * One builder for both transports. `proxy: true` sends the bytes through your function instead of
 * presigning; everything else -- limits, input, state, the four callbacks -- is written the same way.
 */
export interface UploadRouteOptions<TCtx, TSchema extends StandardSchema<any, any> | undefined, TState, TData, TProxy extends boolean> {
  /** The bytes go through this route as one POST. Bounded by the platform's request body cap. */
  proxy?: TProxy;
  /** Defaults to the router's. */
  bucket?: Bucket;
  /** Replaces the router's per key; `null` clears one the router set. */
  limits?: RouteLimits;
  /** A Standard Schema the browser's `input` is validated against before onBeforeUpload runs. */
  input?: TSchema;
  /** Proxy routes only: the multipart field the file arrives in. Default 'file'. */
  field?: TProxy extends true ? string : never;
  onBeforeUpload: (args: RouteBeforeUploadArgs<TCtx, RouteInputOf<TSchema>>) => RouteBeforeUploadResult<TState, TProxy> | Promise<RouteBeforeUploadResult<TState, TProxy>>;
  /**
   * onBeforeUpload accepted the upload but storage refused it, so nothing will ever complete:
   * release the row it reserved here. The error is rethrown to the client afterwards.
   */
  onBeforeUploadFailed?: (args: RouteBeforeUploadFailedArgs<TCtx, RouteInputOf<TSchema>, TState, TProxy>) => void | Promise<void>;
  /** What this returns is `upload.blob.data` in the browser, typed. */
  onUploadCompleted?: (args: RouteUploadCompletedArgs<TCtx, TState, TProxy>) => TData | Promise<TData>;
  /**
   * Maps anything a callback threw that is not a BlobError. Return a BlobError or a Response to
   * answer with it; return nothing to fall through. An error carrying a numeric `status` becomes
   * that status without this hook. The router's own `onError` observes either way.
   */
  onError?: (args: RouteErrorArgs<TCtx>) => BlobError | Response | void | Promise<BlobError | Response | void>;
}

/**
 * What `upload()` returns. The brand is types only: it is how `createUploadHooks<typeof uploads>`
 * knows this route's input, its data and whether it is proxied.
 */
export interface UploadRouteDefinition<TInput = undefined, TData = void, TProxy extends boolean = false> {
  readonly __upstashUploadRoute: UploadRouteTypes<TInput, TData, string, TProxy>;
}

export type UploadRouteMap = Record<string, UploadRouteDefinition<any, any, any>>;

export interface UploadBuilder<TCtx> {
  <TSchema extends StandardSchema<any, any> | undefined = undefined, TState = undefined, TData = void, TProxy extends boolean = false>(
    options: UploadRouteOptions<TCtx, TSchema, TState, TData, TProxy>,
  ): UploadRouteDefinition<RouteInputOf<TSchema>, TData, TProxy>;
}

/** Fires for every route, cannot change the answer, and never takes part in inference. */
export interface RouterUploadCompletedEvent extends BlobObject {
  route: string;
  request: Request;
  contentType: string;
  metadata: Record<string, string>;
  ctx: unknown;
  /** What the route's own onUploadCompleted returned. */
  data: unknown;
}

export interface RouterErrorEvent {
  /** The route the request named, or '' when it named none this router mounts. */
  route: string;
  error: unknown;
  request: Request;
  ctx: unknown;
}

export interface UploadRouterOptions<TCtx, TRoutes> {
  /** Every route inherits it; a route may name its own. */
  bucket?: Bucket;
  /** Every route inherits it; a route's `limits` replaces per key and `null` clears one. */
  limits?: RouteLimits;
  /**
   * Where this router is mounted. Only used to separate two routers on one bucket, whose route
   * names would otherwise derive the same completion-token id.
   */
  endpoint?: string;
  /**
   * Runs once per request, before the route does and before any body is read. What it returns is
   * `ctx` in every callback, typed. Throw to refuse: a BlobError('unauthorized') is the 401.
   * Not run for GET, which serves a public, cacheable limits document and reads nothing.
   */
  context?: (request: Request) => TCtx;
  /** Observer. Fires after the route's own onUploadCompleted, and cannot change the answer. */
  onUploadCompleted?: (event: RouterUploadCompletedEvent) => void | Promise<void>;
  /** Observer. Fires for every refusal, including one the route's own onError mapped. */
  onError?: (event: RouterErrorEvent) => void | Promise<void>;
  /**
   * The function form exists so `upload` is contextually typed with `ctx`. A plain object is fine
   * when the router has no `context`.
   */
  routes: TRoutes | ((upload: UploadBuilder<Awaited<TCtx>>) => TRoutes);
}

export interface UploadRouter<TRoutes = UploadRouteMap, TCtx = unknown> {
  GET: (request: Request) => Promise<Response>;
  POST: (request: Request) => Promise<Response>;
  /** The route map, as types. This is what `createUploadHooks<typeof uploads>` reads. */
  readonly __upstashUploadRouter: TRoutes;
  /** What `context` returned, as types. This is what `UploadContext<typeof uploads>` reads. */
  readonly __upstashUploadContext: TCtx;
}

/** Route names live in a url query, so they are limited to what reads back as one word. */
const ROUTE_NAME = /^[A-Za-z_][\w-]*$/;

type AnyRouteOptions = UploadRouteOptions<any, any, any, any, boolean>;

interface Definition {
  options: AnyRouteOptions;
}

/**
 * One route. Standalone it is nothing: `uploadRouter` mounts it, and until then this only records
 * what was asked for.
 */
export const upload: UploadBuilder<undefined> = ((options: AnyRouteOptions) => ({ options }) as Definition) as unknown as UploadBuilder<undefined>;

interface Mounted {
  GET: (request: Request) => Promise<Response>;
  POST: (request: Request) => Promise<Response>;
  mapError: (error: unknown, request: Request) => BlobError | Response | void | Promise<BlobError | Response | void>;
}

/** What the request carries between the router and the callbacks the primitives own. */
interface Slot {
  ctx: unknown;
  /** The error as it was thrown, before answerError turned it into a status. */
  error?: unknown;
  seen?: boolean;
}

/** With a `context`, `routes` must be the function form: the plain object cannot see `ctx`. */
export function uploadRouter<TCtx, TRoutes extends Record<string, unknown>>(
  options: UploadRouterOptions<TCtx, TRoutes> & { context: (request: Request) => TCtx; routes: (upload: UploadBuilder<Awaited<TCtx>>) => TRoutes },
): UploadRouter<TRoutes, Awaited<TCtx>>;
export function uploadRouter<TRoutes extends Record<string, unknown>>(options: UploadRouterOptions<undefined, TRoutes> & { context?: undefined }): UploadRouter<TRoutes, undefined>;
export function uploadRouter<TCtx = undefined, TRoutes extends Record<string, unknown> = Record<string, never>>(options: UploadRouterOptions<TCtx, TRoutes>): UploadRouter<TRoutes, Awaited<TCtx>> {
  const definitions = (typeof options.routes === 'function' ? (options.routes as (u: UploadBuilder<any>) => TRoutes)(upload as UploadBuilder<any>) : options.routes) as unknown as Record<string, Definition>;

  // The request is the key, so `ctx` reaches callbacks the primitives own without either of them
  // learning about the other. Weak: nothing here outlives the request it belongs to.
  const slots = new WeakMap<Request, Slot>();

  // Object.create(null), not {}: `?route=toString` on a plain object literal finds Object.prototype's
  // and dispatches to a function with no onBeforeUpload. Object.hasOwn below is the second lock.
  const table: Record<string, Mounted> = Object.create(null) as Record<string, Mounted>;
  for (const name of Object.keys(definitions)) {
    if (!ROUTE_NAME.test(name)) throw new TypeError(`upload route names must match ${String(ROUTE_NAME)}: ${JSON.stringify(name)} does not`);
    const definition = definitions[name] as Definition | undefined;
    if (!definition?.options) throw new TypeError(`routes.${name} is not an upload(): every route is built with upload({ ... })`);
    table[name] = mount(name, definition.options);
  }

  function mount(name: string, route: AnyRouteOptions): Mounted {
    const bucket = route.bucket ?? options.bucket;
    if (!bucket) throw new TypeError(`upload route ${JSON.stringify(name)} has no bucket: name one on the route or on the router`);

    const ctxOf = (request: Request): unknown => slots.get(request)?.ctx;
    const mapError = async (error: unknown, request: Request) => {
      const slot = slots.get(request);
      if (slot) slot.error = error;
      return route.onError ? await route.onError({ error, request, ctx: slot?.ctx }) : undefined;
    };

    const completed = async (args: any): Promise<unknown> => {
      const ctx = ctxOf(args.request);
      const data = route.onUploadCompleted ? await route.onUploadCompleted({ ...args, ctx }) : undefined;
      await observeCompleted({ ...args, route: name, ctx, data });
      return data;
    };
    const beforeUpload = (args: any) => route.onBeforeUpload({ ...args, ctx: ctxOf(args.request) });
    const beforeUploadFailed = route.onBeforeUploadFailed ? (args: any) => route.onBeforeUploadFailed!({ ...args, ctx: ctxOf(args.request) }) : undefined;

    const shared = {
      bucket,
      // The name is the token's route id, so two routes with identical limits no longer collide.
      // An endpoint separates two routers sharing one bucket.
      route: options.endpoint ? `${options.endpoint}?route=${name}` : name,
      limits: mergeLimits(options.limits, route.limits),
      input: route.input,
      onBeforeUpload: beforeUpload,
      onBeforeUploadFailed: beforeUploadFailed,
      onUploadCompleted: completed,
      onError: mapError,
    };

    const handlers = route.proxy ? handleProxyUpload({ ...shared, field: route.field as string | undefined }) : handleUpload(shared);
    return { GET: handlers.GET, POST: handlers.POST, mapError };
  }

  async function observeCompleted(event: RouterUploadCompletedEvent): Promise<void> {
    if (!options.onUploadCompleted) return;
    try {
      await options.onUploadCompleted(event);
    } catch (e) {
      // An observer is not allowed to fail an upload that already landed.
      console.error('[upstash-blob] uploadRouter onUploadCompleted threw', e);
    }
  }

  async function observeError(route: string, error: unknown, request: Request): Promise<void> {
    const slot = slots.get(request);
    if (slot?.seen) return;
    if (slot) slot.seen = true;
    if (!options.onError) return;
    try {
      await options.onError({ route, error, request, ctx: slot?.ctx });
    } catch (e) {
      console.error('[upstash-blob] uploadRouter onError threw', e);
    }
  }

  const notFound = async (name: string, request: Request): Promise<Response> => {
    // Never the names it does mount, and never a 500: an unknown route is a 404 like any other.
    const error = new BlobError('not_found', { message: 'unknown upload route' });
    await observeError(name, error, request);
    return await answerError(error, request, undefined);
  };

  function pick(request: Request): { name: string; mounted: Mounted | undefined } {
    let name = '';
    try {
      name = new URL(request.url).searchParams.get('route') ?? '';
    } catch {
      // A url the runtime will not parse names no route.
    }
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
        await observeError(name, e, request);
        return await answerError(e, request, mounted.mapError);
      }
    }

    let response: Response;
    try {
      response = await mounted.POST(request);
    } catch (e) {
      // Nothing claimed it, so it stays the framework's to log: observe it and let it through.
      await observeError(name, e, request);
      throw e;
    }
    // Every refusal left the route as a status; the error itself only survives when a callback threw
    // something that is not a BlobError, which mapError recorded on the way past.
    if (!response.ok) await observeError(name, slot.error ?? (await errorOf(response)), request);
    return response;
  };

  // Types only, never read: the two brands are how `typeof uploads` carries its routes and its ctx.
  return { GET, POST, __upstashUploadRouter: undefined as unknown as TRoutes, __upstashUploadContext: undefined as unknown as Awaited<TCtx> };
}

/** The route's own limits, key by key, over the router's. `null` clears one the router set. */
function mergeLimits(base: RouteLimits | undefined, own: RouteLimits | undefined): UploadLimits {
  const pick = <T>(fallback: T | null | undefined, value: T | null | undefined): T | undefined => (value === undefined ? (fallback ?? undefined) : (value ?? undefined));
  return {
    allowedContentTypes: pick(base?.allowedContentTypes, own?.allowedContentTypes),
    maxBytes: pick(base?.maxBytes, own?.maxBytes),
  };
}

/** The BlobError a route answered with, rebuilt from the body it wrote. */
async function errorOf(response: Response): Promise<BlobError> {
  try {
    const body = await response.clone().json();
    const error = BlobError.fromJSON(body, response.status);
    if (error) return error;
  } catch {
    // Not a JSON body: the status is all there is.
  }
  return BlobError.fromStatus(response.status);
}
