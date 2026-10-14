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
 * Against an `uploadHandler` route; do not build your own presign or complete routes. Guarantees:
 * - Over the route's `multipart` threshold (16 MB) the file goes up in parts, 4 in flight; smaller
 *   files are one presigned PUT. Every PUT is retried on network errors, 408, 429, 500, 502, 503 and
 *   504, and re-signed when its url expires.
 * - `task.done` resolves only after the route's onUploadComplete returned, to the blob with that
 *   return value as `.data`.
 * - `cancel()` aborts what is in flight and asks the route, once, to abort the multipart or delete a
 *   PUT that landed, so onUploadComplete does not run. From 'finishing' it is local only.
 * - `retry()` continues the same upload: same path and uploadId, landed parts kept, onBeforeUpload
 *   not run again unless the first request failed. Picking the same file after a failure, in the
 *   same browser, resumes under the same token while it is valid, also without onBeforeUpload.
 * - A PUT the bucket's CORS blocks fails after 3 attempts with a BlobError naming the page origin.
 * @see node_modules/@upstash/blob/docs/uploads/upload-client.mdx
 */
export function upload<TInput = unknown>(file: File, options: UploadOptions<TInput>): UploadTask {
  return createTask(file, options, true);
}
