import type { UploadTask } from '../shared/types.ts';
import { createTask, type UploadOptions } from './task.ts';

export { BlobError } from '../shared/errors.ts';
export { formatBytes } from '../shared/units.ts';
export type { Size } from '../shared/units.ts';
export type { BlobErrorCode } from '../shared/errors.ts';
export type { BlobObject, UploadSnapshot, UploadTask } from '../shared/types.ts';
export type { UploadOptions, HeadersProvider } from './task.ts';

/** Starts the upload and returns the observable task. `await task.done` for the result. */
export function upload<TInput = unknown>(file: File, options: UploadOptions<TInput>): UploadTask {
  return createTask(file, options, true);
}
