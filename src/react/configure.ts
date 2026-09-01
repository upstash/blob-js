import type { HeadersProvider } from '../browser/task.ts';
import type { BlobError } from '../shared/errors.ts';
import type { AnyUploadRoute, RouteAt, RouteKey, SoleRoute } from './routes.ts';
import { useUpload, type UseUploadOptions, type UseUploadResult } from './use-upload.ts';

export interface FailedAnyUpload {
  readonly id: string;
  readonly file: File;
  readonly error: BlobError;
}

export interface UploadDefaults {
  /** Re-read per request. A throw from it ends the upload carrying that error. */
  headers?: HeadersProvider;
  /** Files in flight. The rest queue. */
  concurrency?: number;
  /** Where the handler is mounted; a route name resolves against it. Default '/api/upload'. */
  endpoint?: string;
  /** Runs before a hook call's own handler. */
  onError?: (upload: FailedAnyUpload) => void;
}

/** `useUpload` bound to the route names and data carried by an upload handler type. */
export interface BoundUseUpload<T> {
  (...args: [SoleRoute<T>] extends [never] ? [route: never] : [options?: UseUploadOptions<SoleRoute<T>>]): UseUploadResult<SoleRoute<T>>;
  <K extends RouteKey<T>>(route: K, options?: UseUploadOptions<RouteAt<T, K>>): UseUploadResult<RouteAt<T, K>>;
  <R extends AnyUploadRoute = never>(route: [R] extends [never] ? never : string, options?: UseUploadOptions<NoInfer<R>>): UseUploadResult<R>;
}

export interface UploadHooks<T> {
  useUpload: BoundUseUpload<T>;
}

export interface UnboundUploadHooks {
  useUpload: typeof useUpload;
}

/** Configure defaults and, optionally, bind `useUpload` to an upload handler's route map. */
export function uploadHooks<T = never>(defaults?: UploadDefaults): [T] extends [never] ? UnboundUploadHooks : UploadHooks<T>;
export function uploadHooks(defaults: UploadDefaults = {}): any {
  const merge = (options: any) => ({
    ...options,
    endpoint: options?.endpoint ?? defaults.endpoint,
    headers: options?.headers ?? defaults.headers,
    concurrency: options?.concurrency ?? defaults.concurrency,
    onError: defaults.onError
      ? (upload: FailedAnyUpload) => {
          try {
            defaults.onError!(upload);
          } catch (e) {
            console.error('[upstash-blob] uploadHooks onError threw', e);
          }
          options?.onError?.(upload);
        }
      : options?.onError,
  });

  const boundUseUpload = (routeOrOptions?: any, maybeOptions?: any): any =>
    typeof routeOrOptions === 'string' ? useUpload(routeOrOptions, merge(maybeOptions ?? {})) : useUpload('', merge(routeOrOptions ?? {}));

  return { useUpload: boundUseUpload };
}
