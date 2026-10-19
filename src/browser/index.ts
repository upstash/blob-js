import type { UploadTask } from '../shared/types.ts';
import { createTask, type UploadOptions } from './task.ts';

export { BlobError } from '../shared/errors.ts';
export { formatBytes } from '../shared/units.ts';
export type { Size } from '../shared/units.ts';
export type { BlobErrorCode } from '../shared/errors.ts';
export type { BlobObject, UploadSnapshot, UploadTask } from '../shared/types.ts';
export type { UploadOptions, HeadersProvider } from './task.ts';

/**
 * Starts the upload and returns the observable task. `await task.done` for the result.
 * Against an `uploadHandler` route; no presign or complete routes of your own. Files over 16 MB go
 * up in parts, every PUT is retried, `task.cancel()` and `task.retry()` handle the server side, and
 * `task.done` resolves after the route's onUploadComplete returned, its value on `.data`. In React,
 * use `useUpload` instead.
 * @see node_modules/@upstash/blob/docs/uploads/upload-client.mdx
 */
export function upload<TInput = unknown>(file: File, options: UploadOptions<TInput>): UploadTask {
  return createTask(file, options, true);
}
