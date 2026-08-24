import { useCallback, useEffect, useRef, useState } from 'react';
import { clock } from '../browser/clock.ts';
import { createTask, resolveHeaders, type HeadersProvider, type InternalTask } from '../browser/task.ts';
import { BlobError } from '../shared/errors.ts';
import type { BlobObject, UploadRoute, UploadRouteTypes, WireLimits } from '../shared/types.ts';
import { useTaskList, type ListEntry } from './task-list.ts';

/** The input schema of a handleUpload POST handler, or undefined when it has none. */
export type RouteInput<R> = R extends { readonly __types?: UploadRouteTypes<infer TInput, any> } ? TInput : undefined;
/** What onUploadCompleted returned, which reaches the browser as blob.data. */
export type RouteData<R> = R extends { readonly __types?: UploadRouteTypes<any, infer TData> } ? TData : unknown;

export interface UploadRecordBase {
  readonly id: string;
  readonly file: File;
  pause(): boolean;
  resume(): boolean;
  cancel(): boolean;
  loaded: number;
  total: number;
  percent: number;
  canPause: boolean;
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
  route: string;
  /** A function is re-read per call to the route, so a rotated JWT still ends the upload. */
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

const limitsCache = new Map<string, WireLimits>();
const limitsInFlight = new Map<string, Promise<WireLimits | undefined>>();

let staticCounter = 0;

async function loadLimits(route: string, headers: HeadersProvider | undefined): Promise<WireLimits | undefined> {
  const cached = limitsCache.get(route);
  if (cached) return cached;
  let pending = limitsInFlight.get(route);
  if (!pending) {
    pending = (async () => {
      try {
        const res = await fetch(route, { headers: await resolveHeaders(headers) });
        if (!res.ok) return undefined;
        const body = (await res.json()) as { limits?: WireLimits } | undefined;
        const limits = body?.limits;
        if (!limits || typeof limits !== 'object') return undefined;
        limitsCache.set(route, limits);
        return limits;
      } catch {
        // A route that will not say what it allows still uploads; the picker just has no accept.
        return undefined;
      } finally {
        limitsInFlight.delete(route);
      }
    })();
    limitsInFlight.set(route, pending);
  }
  return pending;
}

function acceptOf(limits: WireLimits | undefined): string {
  return limits?.allowedContentTypes?.join(',') ?? '';
}

// Size only. accept carries the types, and the route canonicalises aliases before comparing
// (image/jpg is image/jpeg), so a type check against the served list refuses files it accepts.
function deny(file: File, limits: WireLimits | undefined): BlobError | undefined {
  if (limits?.maxBytes !== undefined && file.size > limits.maxBytes) {
    return new BlobError('too_large', { message: `${file.name} is ${file.size} bytes, over the limit of ${limits.maxBytes}` });
  }
  return undefined;
}

function taskEntry<TData>(task: InternalTask): ListEntry<UploadRecord<TData>> {
  const pause = () => task.pause();
  const resume = () => task.resume();
  const cancel = () => task.cancel();
  return {
    id: task.id,
    subscribe: (onChange) => task.subscribe(onChange),
    status: () => task.snapshot().status,
    record: () => ({ id: task.id, file: task.file, pause, resume, cancel, ...task.snapshot() }) as unknown as UploadRecord<TData>,
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
    loaded: 0,
    total: file.size,
    percent: 0,
    canPause: false,
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

function entryFor<TData>(file: File, input: unknown, route: string, headers: HeadersProvider | undefined, limits: WireLimits | undefined): ListEntry<UploadRecord<TData>> {
  const refusal = deny(file, limits);
  if (refusal) return refusedEntry<TData>(file, refusal);
  return taskEntry<TData>(createTask(file, { route, headers, input }, false));
}

/** Browser uploads straight to R2 through a handleUpload route. Three requests, bytes to storage. */
export function useUpload<R extends UploadRoute<any, any> = UploadRoute<undefined, unknown>>(options: UseUploadOptions<R>): UseUploadResult<R> {
  type TData = RouteData<R>;
  const { route } = options;

  const headersRef = useRef<HeadersProvider | undefined>(options.headers);
  headersRef.current = options.headers;
  const handlers = useRef(options);
  handlers.current = options;

  const limitsRef = useRef<WireLimits | undefined>(limitsCache.get(route));
  const [accept, setAccept] = useState(() => acceptOf(limitsCache.get(route)));

  const { uploads, task, add, clear } = useTaskList<UploadRecord<TData>>({
    concurrency: options.concurrency,
    onDone: (record) => {
      if (record.status === 'done') handlers.current.onDone?.(record);
    },
    onError: (record) => {
      if (record.status === 'error') handlers.current.onError?.(record);
    },
  });

  useEffect(() => {
    let alive = true;
    limitsRef.current = limitsCache.get(route);
    setAccept(acceptOf(limitsRef.current));
    void loadLimits(route, headersRef.current).then((limits) => {
      if (!alive || !limits) return;
      limitsRef.current = limits;
      setAccept(acceptOf(limits));
    });
    return () => {
      alive = false;
    };
  }, [route]);

  const start = useCallback(
    (args: AnyStartArgs) => {
      const input = args.input;
      const make = (file: File) => entryFor<TData>(file, input, route, headersRef.current, limitsRef.current);
      if ('files' in args) return add(args.files ? Array.from(args.files).map(make) : []);
      const file = args.file;
      if (!file) return null;
      return add([make(file)])[0] ?? null;
    },
    [add, route],
  ) as UploadStart<RouteInput<R>, TData>;

  return { start, uploads, task, clear, accept };
}
