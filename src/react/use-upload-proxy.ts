import { useCallback, useRef } from 'react';
import { clock } from '../browser/clock.ts';
import type { HeadersProvider } from '../browser/task.ts';
import type { BlobError } from '../shared/errors.ts';
import type { ProxyUploadResponse, UploadRouteTypes, WireLimits } from '../shared/types.ts';
import { deny, useLimits } from './limits.ts';
import { ProxyTask } from './proxy-task.ts';
import { resolveRouteUrl } from './routes.ts';
import { useTaskList, type ListEntry } from './task-list.ts';
import type { RouteData, RoutePath } from './use-upload.ts';

/**
 * What the route answers with. A handleProxyUpload handler carries the SDK's brand and answers its
 * envelope; anything else -- including an ordinary `(request: Request) => Promise<Response>` you
 * wrote yourself -- is whatever shape you passed, untouched.
 */
export type ProxyResponse<R> = R extends { readonly __upstashUploadRoute: UploadRouteTypes<any, any, any, any> } ? ProxyUploadResponse<RouteData<R>> : R;

export interface ProxyRecordBase {
  readonly id: string;
  /** The File, when start() was given one. A raw Blob or FormData body has none. */
  readonly file: File | null;
  cancel(): boolean;
  loaded: number;
  total: number;
  percent: number;
}

export type DoneProxyUpload<TResponse> = ProxyRecordBase & { status: 'done'; response: TResponse };
export type FailedProxyUpload = ProxyRecordBase & { status: 'error'; error: BlobError };

export type ProxyRecord<TResponse = unknown> =
  /** 'finishing': the bytes are sent and the response has not come back. */
  | (ProxyRecordBase & { status: 'queued' | 'uploading' | 'finishing' })
  | DoneProxyUpload<TResponse>
  | (ProxyRecordBase & { status: 'canceled' })
  | FailedProxyUpload;

export type ProxyStartArgs = { file?: File | null } | { body?: File | Blob | FormData | null };

export interface UseUploadProxyOptions<R> {
  /** @deprecated pass the route positionally: `useUploadProxy(route, options)`. */
  route?: RoutePath<R>;
  /** Where the handler is mounted, for a route named rather than spelled out. Default '/api/upload'. */
  endpoint?: string;
  /**
   * A function is re-read per request, so a rotated JWT is never stale. A throw from it ends the
   * upload carrying that error, which is how an app refuses its own upload.
   */
  headers?: HeadersProvider;
  /** Requests in flight. The rest queue. */
  concurrency?: number;
  /** The multipart field `start({ file })` sends the file in. Must match the route's. Default 'file'. */
  field?: string;
  onDone?: (upload: DoneProxyUpload<ProxyResponse<R>>) => void;
  onError?: (upload: FailedProxyUpload) => void;
}

export interface UseUploadProxyResult<R> {
  start(args: ProxyStartArgs): ProxyRecord<ProxyResponse<R>> | null;
  uploads: ProxyRecord<ProxyResponse<R>>[];
  /** The newest record. */
  upload: ProxyRecord<ProxyResponse<R>> | null;
  /** @deprecated renamed to `upload`; the same record for one minor. */
  task: ProxyRecord<ProxyResponse<R>> | null;
  clear(id?: string): void;
  /** The route's allowedContentTypes, joined. Empty until GET lands, or when it serves none. */
  accept: string;
  /**
   * What the route says it accepts, its own numbers. Undefined until its GET answers, and for a
   * route this SDK did not write, which serves no limits document at all.
   */
  limits: WireLimits | undefined;
}

interface Payload {
  body: XMLHttpRequestBodyInit;
  file: File | null;
  total: number;
}

let staticCounter = 0;

// fetch's body rule, not an encoding option: a File is a raw body, a FormData is multipart.
function payloadOf(args: ProxyStartArgs, field: string): Payload | null {
  if ('file' in args) {
    const file = args.file;
    if (!file) return null;
    const form = new FormData();
    form.append(field, file);
    return { body: form, file, total: file.size };
  }
  const body = 'body' in args ? args.body : null;
  if (!body) return null;
  if (body instanceof FormData) return { body, file: null, total: 0 };
  return { body, file: body instanceof File ? body : null, total: body.size };
}

function proxyEntry<TResponse>(task: ProxyTask<TResponse>): ListEntry<ProxyRecord<TResponse>> {
  const cancel = () => task.cancel();
  return {
    id: task.id,
    subscribe: (onChange) => task.subscribe(onChange),
    status: () => task.snapshot().status,
    record: () => ({ id: task.id, file: task.file, cancel, ...task.snapshot() }),
    start: () => task.start(),
  };
}

// A file the route's own limits already refuse is never sent, so the bytes never leave the browser.
function refusedEntry<TResponse>(file: File, error: BlobError): ListEntry<ProxyRecord<TResponse>> {
  const id = `q${++staticCounter}-${clock.now().toString(36)}`;
  const record: ProxyRecord<TResponse> = {
    id,
    file,
    cancel: () => false,
    loaded: 0,
    total: file.size,
    percent: 0,
    status: 'error',
    error,
  };
  return { id, subscribe: () => () => {}, status: () => 'error', record: () => record, start: () => {} };
}

/**
 * One ordinary POST to your own route: fetch() plus a bytes-sent event and a cancel. `useUpload`
 * covers an SDK proxy route now; this stays for a target the SDK did not write, whose response is
 * handed back exactly as it arrived.
 */
export function useUploadProxy<R = unknown>(route: RoutePath<R>, options?: UseUploadProxyOptions<R>): UseUploadProxyResult<R>;
/** @deprecated pass the route positionally: `useUploadProxy(route, options)`. */
export function useUploadProxy<R = unknown>(options: UseUploadProxyOptions<R> & { route: RoutePath<R> }): UseUploadProxyResult<R>;
export function useUploadProxy(routeOrOptions: any, maybeOptions?: any): any {
  type TResponse = unknown;
  const options: UseUploadProxyOptions<any> = (typeof routeOrOptions === 'string' ? maybeOptions : routeOrOptions) ?? {};
  const name: string = typeof routeOrOptions === 'string' ? routeOrOptions : (options.route ?? '');
  const route = resolveRouteUrl(name, options.endpoint);

  const headersRef = useRef<HeadersProvider | undefined>(options.headers);
  headersRef.current = options.headers;
  const fieldRef = useRef(options.field ?? 'file');
  fieldRef.current = options.field ?? 'file';
  const handlers = useRef(options);
  handlers.current = options;

  // Empty unless the route is a handleProxyUpload one, which serves its limits from GET like every
  // other upload route: the picker is filled from the same list that does the refusing.
  const { limitsRef, limits, accept } = useLimits(route, options.headers);

  const { uploads, task, add, clear } = useTaskList<ProxyRecord<TResponse>>({
    concurrency: options.concurrency,
    onDone: (record) => {
      if (record.status === 'done') handlers.current.onDone?.(record as DoneProxyUpload<TResponse>);
    },
    onError: (record) => {
      if (record.status === 'error') handlers.current.onError?.(record);
    },
  });

  const start = useCallback(
    (args: ProxyStartArgs) => {
      const payload = payloadOf(args, fieldRef.current);
      if (!payload) return null;
      const refusal = payload.file ? deny(payload.file, limitsRef.current) : undefined;
      const entry = refusal ? refusedEntry<TResponse>(payload.file!, refusal) : proxyEntry(new ProxyTask<TResponse>({ route, headers: headersRef.current, ...payload }));
      return add([entry])[0] ?? null;
    },
    [add, route, limitsRef],
  );

  return { start, uploads, upload: task, task, clear, accept, limits };
}
