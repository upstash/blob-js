import type { HeadersProvider } from '../browser/task.ts';
import type { BlobError } from '../shared/errors.ts';
import { useUpload } from './use-upload.ts';
import { useUploadProxy } from './use-upload-proxy.ts';

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
  /**
   * Runs for every failed upload from either hook, before the call's own onError rather than instead
   * of it: a session that expired is the app's business wherever it happens, and a page still gets
   * to say what to show. Set it here once instead of on every hook.
   */
  onError?: (upload: FailedAnyUpload) => void;
}

/**
 * The two hooks with your app's defaults already applied. No context and no provider, so there is no
 * client boundary to add at the root of the tree and nothing to render before an upload can start;
 * call-site options still win.
 *
 * ```ts
 * export const { useUpload, useUploadProxy } = configureUpload({
 *   headers: () => ({ authorization: `Bearer ${getToken()}` }),
 *   onError: ({ error }) => { if (error.code === 'unauthorized') signOut(); },
 * });
 * ```
 */
export function configureUpload(defaults: UploadDefaults): { useUpload: typeof useUpload; useUploadProxy: typeof useUploadProxy } {
  const merge = (options: any) => ({
    ...options,
    headers: options.headers ?? defaults.headers,
    concurrency: options.concurrency ?? defaults.concurrency,
    onError: defaults.onError
      ? (upload: FailedAnyUpload) => {
          // Isolated: this runs inside the queue's settle loop, so a throw here would skip the
          // call site's handler and stop the tasks still waiting to start.
          try {
            defaults.onError!(upload);
          } catch (e) {
            console.error('[upstash-blob] configureUpload onError threw', e);
          }
          options.onError?.(upload);
        }
      : options.onError,
  });

  return {
    useUpload: ((options: any) => useUpload(merge(options))) as typeof useUpload,
    useUploadProxy: ((options: any) => useUploadProxy(merge(options))) as typeof useUploadProxy,
  };
}
