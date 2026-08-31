import { useCallback, useRef } from 'react';
import { clock } from '../browser/clock.ts';
import { createTask, type HeadersProvider, type InternalTask } from '../browser/task.ts';
import type { BlobError } from '../shared/errors.ts';
import type { CompletedBlob, UploadRoute, UploadRouteTypes, WireConstraints } from '../shared/types.ts';
import { deny, useConstraints } from './constraints.ts';
import { resolveRouteUrl, type AnyUploadRoute } from './routes.ts';
import { useTaskList, type ListEntry } from './task-list.ts';

/** The input schema of an upload route, or undefined when it has none. */
export type RouteInput<R> = R extends { readonly __upstashUploadRoute: UploadRouteTypes<infer TInput, any, any> } ? TInput : undefined;
/** What onUploadComplete returned, which reaches the browser as blob.data. */
export type RouteData<R> = R extends { readonly __upstashUploadRoute: UploadRouteTypes<any, infer TData, any> } ? TData : unknown;
/** The URL declared by a branded route, or any string for an unbound route. */
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
  /** Not settled: queued, uploading, finishing or paused. */
  pending: boolean;
  /** Every in-flight part is waiting on a backoff. */
  stalled: boolean;
}

export type DoneUpload<TData> = UploadRecordBase & { status: 'done'; blob: CompletedBlob & { data: TData }; error?: undefined };
export type FailedUpload = UploadRecordBase & { status: 'error'; error: BlobError; blob?: undefined };

export type UploadRecord<TData = unknown> =
  | (UploadRecordBase & { status: 'queued' | 'uploading' | 'finishing' | 'paused'; blob?: undefined; error?: undefined })
  | DoneUpload<TData>
  | (UploadRecordBase & { status: 'canceled'; blob?: undefined; error?: undefined })
  | FailedUpload;

export type RecordOf<R> = UploadRecord<RouteData<R>>;
export type DoneRecordOf<R> = DoneUpload<RouteData<R>>;
export type FailedRecordOf<_R> = FailedUpload;

type InputArg<TInput> = [TInput] extends [undefined] ? { input?: undefined } : { input: TInput };

export interface UploadStart<TInput, TData> {
  (args: { file: File | null | undefined } & InputArg<TInput>): UploadRecord<TData> | null;
  (args: { files: File[] | FileList | null | undefined } & InputArg<TInput>): UploadRecord<TData>[];
}

export type StartOf<R> = UploadStart<RouteInput<R>, RouteData<R>>;

export interface UseUploadOptions<R> {
  /** Where the handler is mounted, for a route named rather than spelled out. Default '/api/upload'. */
  endpoint?: string;
  /** Re-read for every handler request, so rotated credentials are not cached in the hook. */
  headers?: HeadersProvider;
  /** Files in flight. The rest queue. */
  concurrency?: number;
  onDone?: (upload: DoneRecordOf<R>) => void;
  onError?: (upload: FailedRecordOf<R>) => void;
}

export interface UseUploadResult<R> {
  start: StartOf<R>;
  uploads: RecordOf<R>[];
  /** The newest record. */
  upload: RecordOf<R> | null;
  clear(id?: string): void;
  /** The route's contentTypes, joined. Empty until GET lands, or when it serves none. */
  accept: string;
  /** The constraints served by the route's GET endpoint. */
  constraints: WireConstraints | undefined;
}

type AnyRecord = UploadRecord<unknown>;
let staticCounter = 0;

function taskEntry(task: InternalTask): ListEntry<AnyRecord> {
  const pause = () => task.pause();
  const resume = () => task.resume();
  const cancel = () => task.cancel();
  const retry = () => task.retry();
  return {
    id: task.id,
    subscribe: (onChange) => task.subscribe(onChange),
    status: () => task.snapshot().status,
    record: () => ({ id: task.id, file: task.file, pause, resume, cancel, retry, ...task.snapshot() }) as AnyRecord,
    start: () => task.start(),
  };
}

function refusedEntry(file: File, error: BlobError): ListEntry<AnyRecord> {
  const id = `r${++staticCounter}-${clock.now().toString(36)}`;
  const no = () => false;
  const record: AnyRecord = {
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
    pending: false,
    stalled: false,
    status: 'error',
    error,
  };
  return { id, subscribe: () => () => {}, status: () => 'error', record: () => record, start: () => {} };
}

/** Direct browser upload: the handler presigns and the bytes go straight to storage. */
export function useUpload<R extends AnyUploadRoute = UploadRoute<undefined, unknown>>(route: RoutePath<R>, options?: UseUploadOptions<R>): UseUploadResult<R>;
export function useUpload(route: string, maybeOptions?: any): any {
  const options: UseUploadOptions<any> = maybeOptions ?? {};
  const url = resolveRouteUrl(route, options.endpoint);
  const headersRef = useRef<HeadersProvider | undefined>(options.headers);
  headersRef.current = options.headers;
  const handlers = useRef(options);
  handlers.current = options;
  const { constraintsRef, constraints, accept } = useConstraints(url, options.headers);

  const { uploads, task: newest, add, clear } = useTaskList<AnyRecord>({
    concurrency: options.concurrency,
    onDone: (record) => {
      if (record.status === 'done') handlers.current.onDone?.(record);
    },
    onError: (record) => {
      if (record.status === 'error') handlers.current.onError?.(record);
    },
  });

  const start = useCallback(
    (args: { file?: File | null; files?: File[] | FileList | null; input?: unknown }) => {
      const make = (file: File): ListEntry<AnyRecord> => {
        const refusal = deny(file, constraintsRef.current);
        return refusal ? refusedEntry(file, refusal) : taskEntry(createTask(file, { route: url, headers: headersRef.current, input: args.input }, false));
      };
      if ('files' in args) return add(args.files ? Array.from(args.files).map(make) : []);
      if (!args.file) return null;
      return add([make(args.file)])[0] ?? null;
    },
    [add, url, constraintsRef],
  );

  return { start, uploads, upload: newest, clear, accept, constraints };
}
