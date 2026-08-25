import { useCallback, useRef } from 'react';
import { clock } from '../browser/clock.ts';
import { createTask, type HeadersProvider, type InternalTask } from '../browser/task.ts';
import { BlobError } from '../shared/errors.ts';
import type { BlobObject, ProxyUploadResponse, UploadRoute, UploadRouteTypes, WireLimits } from '../shared/types.ts';
import { deny, useLimits } from './limits.ts';
import { ProxyTask } from './proxy-task.ts';
import { resolveRouteUrl, type AnyUploadRoute, type IsProxyRoute } from './routes.ts';
import { useTaskList, type ListEntry } from './task-list.ts';

/** The input schema of an upload route, or undefined when it has none. */
export type RouteInput<R> = R extends { readonly __upstashUploadRoute: UploadRouteTypes<infer TInput, any, any, any> } ? TInput : undefined;
/** What onUploadCompleted returned, which reaches the browser as blob.data. */
export type RouteData<R> = R extends { readonly __upstashUploadRoute: UploadRouteTypes<any, infer TData, any, any> } ? TData : unknown;
/**
 * The url the route was declared with, so `route` cannot name one endpoint while the handler type
 * describes another. A route that declared none types as plain string, as before.
 */
export type RoutePath<R> = R extends { readonly __upstashUploadRoute: UploadRouteTypes<any, any, infer TRoute, any> } ? (string extends TRoute ? string : TRoute) : string;

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
  /** Every in-flight part is waiting on a backoff. */
  stalled: boolean;
}

export type DoneUpload<TData> = UploadRecordBase & { status: 'done'; blob: BlobObject & { data: TData } };
export type FailedUpload = UploadRecordBase & { status: 'error'; error: BlobError };

export type UploadRecord<TData = unknown> =
  /** 'finishing': every byte is sent and the route is completing the upload. percent sits at 99. */
  | (UploadRecordBase & { status: 'queued' | 'uploading' | 'finishing' | 'paused' })
  | DoneUpload<TData>
  | (UploadRecordBase & { status: 'canceled' })
  | FailedUpload;

/**
 * A proxied upload is one POST that either lands or does not: there are no parts to pause, resume or
 * stall on, and a raw `start({ body })` has no File behind it. The fields that cannot mean anything
 * are absent rather than always-false, so a page cannot render a Pause button that never works.
 */
export interface ProxyUploadRecordBase {
  readonly id: string;
  readonly file: File | null;
  cancel(): boolean;
  loaded: number;
  total: number;
  percent: number;
}

export type DoneProxyRecord<TData> = ProxyUploadRecordBase & { status: 'done'; blob: BlobObject & { data: TData } };

export type ProxyUploadRecord<TData = unknown> =
  /** 'finishing': the bytes are sent and the route has not answered. */
  | (ProxyUploadRecordBase & { status: 'queued' | 'uploading' | 'finishing' })
  | DoneProxyRecord<TData>
  | (ProxyUploadRecordBase & { status: 'canceled' })
  | (ProxyUploadRecordBase & { status: 'error'; error: BlobError });

/** The record for a route, chosen by the route's transport. One conditional, never a union. */
export type RecordOf<R> = IsProxyRoute<R> extends true ? ProxyUploadRecord<RouteData<R>> : UploadRecord<RouteData<R>>;
export type DoneRecordOf<R> = Extract<RecordOf<R>, { status: 'done' }>;
export type FailedRecordOf<R> = Extract<RecordOf<R>, { status: 'error' }>;

type InputArg<TInput> = [TInput] extends [undefined] ? { input?: undefined } : { input: TInput };

export interface UploadStart<TInput, TData> {
  (args: { file: File | null | undefined } & InputArg<TInput>): UploadRecord<TData> | null;
  (args: { files: File[] | FileList | null | undefined } & InputArg<TInput>): UploadRecord<TData>[];
}

export interface ProxyUploadStart<TInput, TData> {
  (args: { file: File | null | undefined } & InputArg<TInput>): ProxyUploadRecord<TData> | null;
  (args: { files: File[] | FileList | null | undefined } & InputArg<TInput>): ProxyUploadRecord<TData>[];
  /** Proxy routes only: the request body as it stands, for a Blob or a form you built yourself. */
  (args: { body: File | Blob | FormData | null | undefined } & InputArg<TInput>): ProxyUploadRecord<TData> | null;
}

export type StartOf<R> = IsProxyRoute<R> extends true ? ProxyUploadStart<RouteInput<R>, RouteData<R>> : UploadStart<RouteInput<R>, RouteData<R>>;

export interface UseUploadOptions<R> {
  /** @deprecated pass the route positionally: `useUpload(route, options)`. */
  route?: RoutePath<R>;
  /** Where the router is mounted, for a route named rather than spelled out. Default '/api/upload'. */
  endpoint?: string;
  /**
   * A function is re-read per call to the route, so a rotated JWT still ends the upload. A throw
   * from it ends the upload carrying that error, which is how an app refuses its own upload.
   */
  headers?: HeadersProvider;
  /** Files in flight. The rest queue. */
  concurrency?: number;
  /** Proxy routes only: the multipart field the file is sent in. Must match the route's. Default 'file'. */
  field?: IsProxyRoute<R> extends true ? string : never;
  onDone?: (upload: DoneRecordOf<R>) => void;
  onError?: (upload: FailedRecordOf<R>) => void;
}

export interface UseUploadResult<R> {
  start: StartOf<R>;
  uploads: RecordOf<R>[];
  /** The newest record. */
  upload: RecordOf<R> | null;
  /** @deprecated renamed to `upload`; the same record for one minor. */
  task: RecordOf<R> | null;
  clear(id?: string): void;
  /** The route's allowedContentTypes, joined. Empty until GET lands, or when it serves none. */
  accept: string;
  /**
   * What the route says it accepts, its own numbers: `maxBytes` in bytes and the exact content type
   * list, so a page states the cap instead of repeating a constant that can drift from it. Undefined
   * until the route's GET answers, and when it serves no limits at all.
   */
  limits: WireLimits | undefined;
}

interface AnyStartArgs {
  file?: File | null;
  files?: File[] | FileList | null;
  body?: File | Blob | FormData | null;
  input?: unknown;
}

type AnyRecord = { id: string; status: string };

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
    record: () => ({ id: task.id, file: task.file, pause, resume, cancel, retry, ...task.snapshot() }) as unknown as AnyRecord,
    start: () => task.start(),
  };
}

/**
 * The route's envelope as one blob, so a page reads `upload.blob.url` whichever transport carried
 * it. uploadedAt crossed as JSON and is parsed back here, which is only safe because this runs for
 * SDK routes alone: an app's own response shape reaches useUploadProxy untouched, as it always did.
 */
function envelopeBlob(response: unknown): BlobObject & { data: unknown } {
  const envelope = response as ProxyUploadResponse<unknown> | undefined;
  const blob = envelope?.blob as (Omit<BlobObject, 'uploadedAt'> & { uploadedAt: string }) | undefined;
  if (!blob || typeof blob !== 'object') return { ...(response as object) } as BlobObject & { data: unknown };
  return { ...blob, uploadedAt: new Date(blob.uploadedAt), data: envelope!.data };
}

function proxyEntry(task: ProxyTask<unknown>): ListEntry<AnyRecord> {
  const cancel = () => task.cancel();
  return {
    id: task.id,
    subscribe: (onChange) => task.subscribe(onChange),
    status: () => task.snapshot().status,
    record: () => {
      const snapshot = task.snapshot();
      const base = { id: task.id, file: task.file, cancel, loaded: snapshot.loaded, total: snapshot.total, percent: snapshot.percent };
      if (snapshot.status === 'done') return { ...base, status: 'done', blob: envelopeBlob(snapshot.response) } as unknown as AnyRecord;
      if (snapshot.status === 'error') return { ...base, status: 'error', error: snapshot.error } as unknown as AnyRecord;
      return { ...base, status: snapshot.status } as unknown as AnyRecord;
    },
    start: () => task.start(),
  };
}

// A file the route's own limits already refuse never becomes a Task, so it never calls begin.
function refusedEntry(file: File | null, error: BlobError): ListEntry<AnyRecord> {
  const id = `r${++staticCounter}-${clock.now().toString(36)}`;
  const no = () => false;
  const record = {
    id,
    file,
    pause: no,
    resume: no,
    cancel: no,
    retry: no,
    loaded: 0,
    total: file?.size ?? 0,
    percent: 0,
    canPause: false,
    stalled: false,
    status: 'error',
    error,
  } as unknown as AnyRecord;
  return {
    id,
    subscribe: () => () => {},
    status: () => 'error',
    record: () => record,
    start: () => {},
  };
}

/**
 * The transport is the route's to declare and it arrives with the limits, so a file picked before
 * that GET lands waits here instead of being sent with the wrong one. Warm -- which is every upload
 * after the first render -- nothing is deferred and this is never built.
 */
function deferredEntry(file: File | null, make: () => Promise<ListEntry<AnyRecord>>): ListEntry<AnyRecord> {
  const id = `d${++staticCounter}-${clock.now().toString(36)}`;
  const listeners = new Set<() => void>();
  let inner: ListEntry<AnyRecord> | undefined;
  let detach: (() => void) | undefined;
  let canceled = false;
  const notify = () => {
    for (const listener of [...listeners]) listener();
  };
  const no = () => false;
  const cancel = () => {
    if (inner) return (inner.record() as unknown as { cancel(): boolean }).cancel();
    if (canceled) return false;
    canceled = true;
    notify();
    return true;
  };
  const waiting = () =>
    ({
      id,
      file,
      pause: no,
      resume: no,
      cancel,
      retry: no,
      loaded: 0,
      total: file?.size ?? 0,
      percent: 0,
      canPause: false,
      stalled: false,
      status: canceled ? 'canceled' : 'queued',
    }) as unknown as AnyRecord;

  return {
    id,
    subscribe(onChange) {
      listeners.add(onChange);
      return () => {
        listeners.delete(onChange);
        if (listeners.size === 0) detach?.();
      };
    },
    status: () => (inner ? inner.status() : canceled ? 'canceled' : 'queued'),
    // The list keys on the id it was handed, so the inner task's own id must not replace it.
    record: () => (inner ? { ...inner.record(), id } : waiting()),
    start: () => {
      void make()
        .catch((e: unknown) => refusedEntry(file, BlobError.is(e) ? e : new BlobError('request_failed', { message: e instanceof Error ? e.message : String(e), status: 400, cause: e })))
        .then((entry) => {
          if (canceled) return;
          inner = entry;
          detach = entry.subscribe(notify);
          notify();
          entry.start();
        });
    },
  };
}

interface ProxyPayload {
  body: XMLHttpRequestBodyInit;
  file: File | null;
  total: number;
}

// fetch's body rule, not an encoding option: `start({ body })` goes as it stands, even when the body
// is a File; `start({ file })` goes as multipart under `field`.
function proxyPayload(file: File | null, body: File | Blob | FormData | null | undefined, input: unknown, field: string): ProxyPayload | null {
  if (body) {
    if (body instanceof FormData) {
      if (input !== undefined) body.append('input', JSON.stringify(input));
      return { body, file: null, total: 0 };
    }
    return { body, file, total: body.size };
  }
  if (!file) return null;
  const form = new FormData();
  form.append(field, file);
  // A form field cannot carry an object, so input crosses as JSON beside the file.
  if (input !== undefined) form.append('input', JSON.stringify(input));
  return { body: form, file, total: file.size };
}

/**
 * One hook for both transports. A direct route presigns and the bytes go straight to storage; a
 * proxy route takes one POST through your own function. The route says which it is -- the same GET
 * that serves its limits -- so a page names a route and never an upload strategy.
 */
export function useUpload<R extends AnyUploadRoute = UploadRoute<undefined, unknown>>(route: RoutePath<R>, options?: UseUploadOptions<R>): UseUploadResult<R>;
/** @deprecated pass the route positionally: `useUpload(route, options)`. */
export function useUpload<R extends AnyUploadRoute = UploadRoute<undefined, unknown>>(options: UseUploadOptions<R> & { route: RoutePath<R> }): UseUploadResult<R>;
export function useUpload(routeOrOptions: any, maybeOptions?: any): any {
  const options: UseUploadOptions<any> = (typeof routeOrOptions === 'string' ? maybeOptions : routeOrOptions) ?? {};
  const name: string = typeof routeOrOptions === 'string' ? routeOrOptions : (options.route ?? '');
  const url = resolveRouteUrl(name, options.endpoint);

  const headersRef = useRef<HeadersProvider | undefined>(options.headers);
  headersRef.current = options.headers;
  const fieldRef = useRef<string>((options.field as string | undefined) ?? 'file');
  fieldRef.current = (options.field as string | undefined) ?? 'file';
  const handlers = useRef(options);
  handlers.current = options;

  const { limitsRef, transportRef, limits, accept, load } = useLimits(url, options.headers);

  const { uploads, task, add, clear } = useTaskList<AnyRecord>({
    concurrency: options.concurrency,
    onDone: (record) => {
      if (record.status === 'done') handlers.current.onDone?.(record as any);
    },
    onError: (record) => {
      if (record.status === 'error') handlers.current.onError?.(record as any);
    },
  });

  const start = useCallback(
    (args: AnyStartArgs) => {
      const input = args.input;

      const build = (transport: 'direct' | 'proxy', file: File | null, body: File | Blob | FormData | null | undefined): ListEntry<AnyRecord> => {
        const refusal = file ? deny(file, limitsRef.current) : undefined;
        if (refusal) return refusedEntry(file, refusal);
        if (transport === 'proxy') {
          const payload = proxyPayload(file, body, input, fieldRef.current);
          if (!payload) return refusedEntry(file, new BlobError('empty_body'));
          return proxyEntry(new ProxyTask({ route: url, headers: headersRef.current, ...payload }));
        }
        // A direct upload is presigned per file: there is nothing to sign for a body with no File.
        if (!file) return refusedEntry(null, new BlobError('invalid_input', { message: 'this route takes a file' }));
        return taskEntry(createTask(file, { route: url, headers: headersRef.current, input }, false));
      };

      const make = (file: File | null, body?: File | Blob | FormData | null): ListEntry<AnyRecord> => {
        const transport = transportRef.current;
        if (transport) return build(transport, file, body);
        return deferredEntry(file, async () => {
          const facts = await load();
          // The route never said which transport it speaks, so nothing is guessed: the upload fails
          // with why, and the next start() asks again.
          if (!facts.transport) return refusedEntry(file, facts.error ?? new BlobError('request_failed', { message: 'could not reach the route', status: 503 }));
          return build(facts.transport, file, body);
        });
      };

      if ('files' in args) return add(args.files ? Array.from(args.files).map((file) => make(file)) : []);
      if ('body' in args) {
        if (!args.body) return null;
        return add([make(args.body instanceof File ? args.body : null, args.body)])[0] ?? null;
      }
      const file = args.file;
      if (!file) return null;
      return add([make(file)])[0] ?? null;
    },
    [add, url, limitsRef, transportRef, load],
  );

  return { start, uploads, upload: task, task, clear, accept, limits };
}
