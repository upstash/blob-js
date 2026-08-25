import type { HeadersProvider } from '../browser/task.ts';
import type { BlobError } from '../shared/errors.ts';
import type { AnyUploadRoute, RouteAt, RouteKey } from './routes.ts';
import { useUploadProxy, type UseUploadProxyOptions, type UseUploadProxyResult } from './use-upload-proxy.ts';
import { useUpload, type RoutePath, type UseUploadOptions, type UseUploadResult } from './use-upload.ts';

/** The part of a failed upload both hooks agree on. */
export interface FailedAnyUpload {
  readonly id: string;
  readonly file: File | null;
  readonly error: BlobError;
}

export interface UploadDefaults {
  /** Re-read per request. A throw from it ends the upload carrying that error. */
  headers?: HeadersProvider;
  /** Files in flight. The rest queue. */
  concurrency?: number;
  /** Where the router is mounted; a route *name* resolves against it. Default '/api/upload'. */
  endpoint?: string;
  /**
   * Runs for every failed upload from either hook, before the call's own onError rather than instead
   * of it: a session that expired is the app's business wherever it happens, and a page still gets
   * to say what to show. Set it here once instead of on every hook.
   */
  onError?: (upload: FailedAnyUpload) => void;
}

/**
 * `useUpload` bound to a route map: the name is checked against it, and the record, the data and the
 * input come from the route that name belongs to.
 */
export interface BoundUseUpload<T> {
  <K extends RouteKey<T>>(route: K, options?: UseUploadOptions<RouteAt<T, K>>): UseUploadResult<RouteAt<T, K>>;
  /** @deprecated pass the route positionally: `useUpload(route, options)`. */
  <K extends RouteKey<T>>(options: UseUploadOptions<RouteAt<T, K>> & { route: K }): UseUploadResult<RouteAt<T, K>>;
  /**
   * The escape hatch for a url the map does not name -- a dynamic route, or one from another app.
   * The type argument is required: without it there is nothing to check the url against, and an
   * overload that inferred it would take any string and turn the typo check off for everyone.
   */
  <R extends AnyUploadRoute = never>(route: [R] extends [never] ? never : string, options?: UseUploadOptions<NoInfer<R>>): UseUploadResult<R>;
}

/**
 * `useUploadProxy` bound to the same map. It stays loose on purpose: its reason to exist is a target
 * this SDK did not write, and those have no entry in any map.
 */
export interface BoundUseUploadProxy<T> {
  <K extends RouteKey<T>>(route: K, options?: UseUploadProxyOptions<RouteAt<T, K>>): UseUploadProxyResult<RouteAt<T, K>>;
  <R = unknown>(route: string, options?: UseUploadProxyOptions<R>): UseUploadProxyResult<R>;
  /** @deprecated pass the route positionally: `useUploadProxy(route, options)`. */
  <R = unknown>(options: UseUploadProxyOptions<R> & { route: RoutePath<R> }): UseUploadProxyResult<R>;
}

export interface UploadHooks<T> {
  useUpload: BoundUseUpload<T>;
  useUploadProxy: BoundUseUploadProxy<T>;
}

export interface UnboundUploadHooks {
  useUpload: typeof useUpload;
  useUploadProxy: typeof useUploadProxy;
}

/**
 * The hooks with your app's defaults already applied, and -- given the router's type -- its route
 * names too. No context and no provider, so there is no client boundary to add at the root of the
 * tree and nothing to render before an upload can start; call-site options still win.
 *
 * ```ts
 * export const { useUpload } = createUploadHooks<typeof uploads>({
 *   headers: () => ({ authorization: `Bearer ${getToken()}` }),
 *   onError: ({ error }) => { if (error.code === 'unauthorized') signOut(); },
 * });
 *
 * const { start, upload } = useUpload('avatar');
 * ```
 *
 * `T` is a router (`typeof uploads`), a branded handler (`typeof POST`), or a union of those. With
 * no type argument the hooks keep their unbound signatures exactly.
 */
export function createUploadHooks<T = never>(defaults?: UploadDefaults): [T] extends [never] ? UnboundUploadHooks : UploadHooks<T>;
export function createUploadHooks(defaults: UploadDefaults = {}): any {
  const merge = (options: any) => ({
    ...options,
    endpoint: options?.endpoint ?? defaults.endpoint,
    headers: options?.headers ?? defaults.headers,
    concurrency: options?.concurrency ?? defaults.concurrency,
    onError: defaults.onError
      ? (upload: FailedAnyUpload) => {
          // Isolated: this runs inside the queue's settle loop, so a throw here would skip the
          // call site's handler and stop the tasks still waiting to start.
          try {
            defaults.onError!(upload);
          } catch (e) {
            console.error('[upstash-blob] createUploadHooks onError threw', e);
          }
          options?.onError?.(upload);
        }
      : options?.onError,
  });

  // Both call shapes reach the same hook: a name or url first, or the old single options object.
  const bind =
    (hook: any) =>
    (routeOrOptions: any, maybeOptions?: any): any =>
      typeof routeOrOptions === 'string' ? hook(routeOrOptions, merge(maybeOptions ?? {})) : hook(merge(routeOrOptions ?? {}));

  return { useUpload: bind(useUpload), useUploadProxy: bind(useUploadProxy) };
}

/** @deprecated renamed to `createUploadHooks`, which also takes the router type. Identical otherwise. */
export function configureUpload(defaults: UploadDefaults): UnboundUploadHooks {
  return createUploadHooks(defaults);
}
