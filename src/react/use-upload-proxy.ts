import { useCallback, useRef } from 'react';
import type { HeadersProvider } from '../browser/task.ts';
import type { BlobError } from '../shared/errors.ts';
import { ProxyTask } from './proxy-task.ts';
import { useTaskList, type ListEntry } from './task-list.ts';

export interface ProxyRecordBase {
  readonly id: string;
  /** The File, when start() was given one. A raw Blob or FormData body has none. */
  readonly file: File | null;
  cancel(): boolean;
  loaded: number;
  total: number;
  percent: number;
  /** The bytes are sent and the response has not come back. */
  finishing: boolean;
}

export type DoneProxyUpload<TResponse> = ProxyRecordBase & { status: 'done'; response: TResponse };
export type FailedProxyUpload = ProxyRecordBase & { status: 'error'; error: BlobError };

export type ProxyRecord<TResponse = unknown> =
  | (ProxyRecordBase & { status: 'queued' | 'uploading' })
  | DoneProxyUpload<TResponse>
  | (ProxyRecordBase & { status: 'canceled' })
  | FailedProxyUpload;

export type ProxyStartArgs = { file?: File | null } | { body?: File | Blob | FormData | null };

export interface UseUploadProxyOptions<TResponse> {
  route: string;
  /** A function is re-read per request, so a rotated JWT is never stale. */
  headers?: HeadersProvider;
  /** Requests in flight. The rest queue. */
  concurrency?: number;
  onDone?: (upload: DoneProxyUpload<TResponse>) => void;
  onError?: (upload: FailedProxyUpload) => void;
}

export interface UseUploadProxyResult<TResponse> {
  start(args: ProxyStartArgs): ProxyRecord<TResponse> | null;
  uploads: ProxyRecord<TResponse>[];
  task: ProxyRecord<TResponse> | null;
  clear(id?: string): void;
}

interface Payload {
  body: XMLHttpRequestBodyInit;
  file: File | null;
  total: number;
}

// fetch's body rule, not an encoding option: a File is a raw body, a FormData is multipart.
function payloadOf(args: ProxyStartArgs): Payload | null {
  if ('file' in args) {
    const file = args.file;
    if (!file) return null;
    const form = new FormData();
    form.append('file', file);
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

/** One ordinary POST to your own route: fetch() plus a bytes-sent event and a cancel. */
export function useUploadProxy<TResponse = unknown>(options: UseUploadProxyOptions<TResponse>): UseUploadProxyResult<TResponse> {
  const { route } = options;
  const headersRef = useRef<HeadersProvider | undefined>(options.headers);
  headersRef.current = options.headers;
  const handlers = useRef(options);
  handlers.current = options;

  const { uploads, task, add, clear } = useTaskList<ProxyRecord<TResponse>>({
    concurrency: options.concurrency,
    onDone: (record) => {
      if (record.status === 'done') handlers.current.onDone?.(record);
    },
    onError: (record) => {
      if (record.status === 'error') handlers.current.onError?.(record);
    },
  });

  const start = useCallback(
    (args: ProxyStartArgs) => {
      const payload = payloadOf(args);
      if (!payload) return null;
      const task = new ProxyTask<TResponse>({ route, headers: headersRef.current, ...payload });
      return add([proxyEntry(task)])[0] ?? null;
    },
    [add, route],
  );

  return { start, uploads, task, clear };
}
