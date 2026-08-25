import { useCallback, useRef } from 'react';
import { clock } from '../browser/clock.ts';
import { createTask, type HeadersProvider, type InternalTask } from '../browser/task.ts';
import type { BlobError } from '../shared/errors.ts';
import type { BlobObject, UploadRoute, UploadRouteTypes } from '../shared/types.ts';
import { deny, useLimits } from './limits.ts';
import { useTaskList, type ListEntry } from './task-list.ts';

/** The input schema of a handleUpload POST handler, or undefined when it has none. */
export type RouteInput<R> = R extends { readonly __upstashUploadRoute: UploadRouteTypes<infer TInput, any, any> } ? TInput : undefined;
/** What onUploadCompleted returned, which reaches the browser as blob.data. */
export type RouteData<R> = R extends { readonly __upstashUploadRoute: UploadRouteTypes<any, infer TData, any> } ? TData : unknown;
/**
 * The url the route was declared with, so `route` cannot name one endpoint while the handler type
 * describes another. A route that declared none types as plain string, as before.
 */
export type RoutePath<R> = R extends { readonly __upstashUploadRoute: UploadRouteTypes<any, any, infer TRoute> } ? (string extends TRoute ? string : TRoute) : string;

export interface UploadRecordBase {
  readonly id: string;
  readonly file: File;
  pause(): boolean;
  resume(): boolean;
  cancel(): boolean;
  /** Only from 'error': runs the same upload again from the parts that landed. */
  retry(): boolean;
  loaded: number;
  total: number;
  percent: number;
  canPause: boolean;
  /** Every byte is sent and the route is completing the upload. percent sits at 99 here. */
  finishing: boolean;
  /** Every in-flight part is waiting on a backoff. */
  stalled: boolean;
}

export type DoneUpload<TData> = UploadRecordBase & { status: 'done'; blob: BlobObject & { data: TData } };
export type FailedUpload = UploadRecordBase & { status: 'error'; error: BlobError };

export type UploadRecord<TData = unknown> =
  | (UploadRecordBase & { status: 'queued' | 'uploading' | 'paused' })
  | DoneUpload<TData>
  | (UploadRecordBase & { status: 'canceled' })
  | FailedUpload;

type InputArg<TInput> = [TInput] extends [undefined] ? { input?: undefined } : { input: TInput };

export interface UploadStart<TInput, TData> {
  (args: { file: File | null | undefined } & InputArg<TInput>): UploadRecord<TData> | null;
  (args: { files: File[] | FileList | null | undefined } & InputArg<TInput>): UploadRecord<TData>[];
}

export interface UseUploadOptions<R> {
  route: RoutePath<R>;
  /**
   * A function is re-read per call to the route, so a rotated JWT still ends the upload. A throw
   * from it ends the upload carrying that error, which is how an app refuses its own upload.
   */
  headers?: HeadersProvider;
  /** Files in flight. The rest queue. */
  concurrency?: number;
  onDone?: (upload: DoneUpload<RouteData<R>>) => void;
  onError?: (upload: FailedUpload) => void;
}

export interface UseUploadResult<R> {
  start: UploadStart<RouteInput<R>, RouteData<R>>;
  uploads: UploadRecord<RouteData<R>>[];
  task: UploadRecord<RouteData<R>> | null;
  clear(id?: string): void;
  /** The route's allowedContentTypes, joined. Empty until GET lands, or when it serves none. */
  accept: string;
}

interface AnyStartArgs {
  file?: File | null;
  files?: File[] | FileList | null;
  input?: unknown;
}

let staticCounter = 0;

function taskEntry<TData>(task: InternalTask): ListEntry<UploadRecord<TData>> {
  const pause = () => task.pause();
  const resume = () => task.resume();
  const cancel = () => task.cancel();
  const retry = () => task.retry();
  return {
    id: task.id,
    subscribe: (onChange) => task.subscribe(onChange),
    status: () => task.snapshot().status,
    record: () => ({ id: task.id, file: task.file, pause, resume, cancel, retry, ...task.snapshot() }) as unknown as UploadRecord<TData>,
    start: () => task.start(),
  };
}

// A file the route's own limits already refuse never becomes a Task, so it never calls begin.
function refusedEntry<TData>(file: File, error: BlobError): ListEntry<UploadRecord<TData>> {
  const id = `r${++staticCounter}-${clock.now().toString(36)}`;
  const no = () => false;
  const record: UploadRecord<TData> = {
    id,
    file,
    pause: no,
    resume: no,
    cancel: no,
    retry: no,
    loaded: 0,
    total: file.size,
    percent: 0,
    canPause: false,
    finishing: false,
    stalled: false,
    status: 'error',
    error,
  };
  return {
    id,
    subscribe: () => () => {},
    status: () => 'error',
    record: () => record,
    start: () => {},
  };
}

/** Browser uploads straight to R2 through a handleUpload route. Three requests, bytes to storage. */
export function useUpload<R extends UploadRoute<any, any, any> = UploadRoute<undefined, unknown>>(options: UseUploadOptions<R>): UseUploadResult<R> {
  type TData = RouteData<R>;
  const route = options.route as string;

  const headersRef = useRef<HeadersProvider | undefined>(options.headers);
  headersRef.current = options.headers;
  const handlers = useRef(options);
  handlers.current = options;

  const { limitsRef, accept } = useLimits(route, options.headers);

  const { uploads, task, add, clear } = useTaskList<UploadRecord<TData>>({
    concurrency: options.concurrency,
    onDone: (record) => {
      if (record.status === 'done') handlers.current.onDone?.(record);
    },
    onError: (record) => {
      if (record.status === 'error') handlers.current.onError?.(record);
    },
  });

  const start = useCallback(
    (args: AnyStartArgs) => {
      const input = args.input;
      const make = (file: File) => {
        const refusal = deny(file, limitsRef.current);
        return refusal ? refusedEntry<TData>(file, refusal) : taskEntry<TData>(createTask(file, { route, headers: headersRef.current, input }, false));
      };
      if ('files' in args) return add(args.files ? Array.from(args.files).map(make) : []);
      const file = args.file;
      if (!file) return null;
      return add([make(file)])[0] ?? null;
    },
    [add, route, limitsRef],
  ) as UploadStart<RouteInput<R>, TData>;

  return { start, uploads, task, clear, accept };
}
