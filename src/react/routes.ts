import type { UploadRouteTypes } from '../shared/types.ts';

/**
 * The route map behind `createUploadHooks<T>()`. `T` is an upload handler (`typeof uploads`), a
 * branded POST handler, or a union of those; this is the record of names the hooks accept.
 */

/** Anything carrying the SDK's brand: a handler's route, or a branded POST. */
export type AnyUploadRoute = { readonly __upstashUploadRoute: UploadRouteTypes<any, any, any, any> };

/** What uploadHandler() returns. The map is a phantom on the object, so `typeof uploads` carries it. */
export type AnyUploadHandler = { readonly __upstashUploadHandler: Record<string, AnyUploadRoute> };

type UnionToIntersection<U> = (U extends unknown ? (k: U) => void : never) extends (k: infer I) => void ? I : never;

/**
 * Every route `T` names, keyed by what `useUpload` takes for it: a router contributes its route
 * names, a handler contributes the url it declared. A handler that declared none contributes
 * nothing at all -- returning `{ [k: string]: R }` for it would widen the key union to `string` and
 * silently turn off the typo check for every other route in the union.
 */
export type RoutesOf<T> = UnionToIntersection<
  T extends AnyUploadHandler
    ? T['__upstashUploadHandler']
    : T extends { readonly __upstashUploadRoute: UploadRouteTypes<any, any, infer TRoute, any> }
      ? string extends TRoute
        ? never
        : { [K in TRoute]: T }
      : never
>;

/** The names `useUpload` accepts for `T`. */
export type RouteKey<T> = Extract<keyof RoutesOf<T>, string>;

/** One route by name. Indexed, never distributed: a union of routes must not become a union of data. */
export type RouteAt<T, K> = K extends keyof RoutesOf<T> ? RoutesOf<T>[K] : never;

/**
 * The route of a handler written with no `routes`: it mounts one, under the empty name, and the
 * bound `useUpload()` takes no argument at all. `never` for anything that names its routes.
 */
export type SoleRoute<T> = RoutesOf<T> extends { readonly '': infer R } ? R : never;

/** True for a handleProxyUpload route, or a router route declared with `proxy: true`. */
export type IsProxyRoute<R> = [R] extends [{ readonly __upstashUploadRoute: UploadRouteTypes<any, any, any, infer TProxy> }] ? ([TProxy] extends [true] ? true : false) : false;

/** Where a router is mounted when nothing says otherwise. One flat endpoint, names in the query. */
export const DEFAULT_ENDPOINT = '/api/upload';

/**
 * A route *name* is resolved against the endpoint the router is mounted at; anything that already
 * looks like a url is used as it stands, which is what an unrouted `handleUpload` route passes.
 */
export function resolveRouteUrl(route: string, endpoint?: string): string {
  const base = endpoint || DEFAULT_ENDPOINT;
  if (!route) return base;
  if (route.startsWith('/') || route.startsWith('http')) return route;
  return `${base}${base.includes('?') ? '&' : '?'}route=${encodeURIComponent(route)}`;
}
