import { useCallback, useRef } from 'react';
import { clock } from '../browser/clock.ts';
import type { HeadersProvider } from '../browser/task.ts';
import type { BlobError } from '../shared/errors.ts';
import type { WireConstraints } from '../shared/types.ts';
import { deny, useConstraints } from './constraints.ts';
import { ServerUploadTask } from './server-upload-task.ts';
import { useTaskList, type ListEntry } from './task-list.ts';

/** The JSON an ordinary application route returns, handed back unchanged. */
export type ServerUploadResponse<TResponse> = TResponse;

export interface ServerUploadRecordBase {
  readonly id: string;
  /** The File, when start() was given one. A raw Blob or FormData body has none. */
  readonly file: File | null;
  cancel(): boolean;
  loaded: number;
  total: number;
  percent: number;
  /** Not settled: queued, uploading or finishing. */
  pending: boolean;
}

export type DoneServerUpload<TResponse> = ServerUploadRecordBase & { status: 'done'; response: TResponse; error?: undefined };
export type FailedServerUpload = ServerUploadRecordBase & { status: 'error'; error: BlobError; response?: undefined };

export type ServerUploadRecord<TResponse = unknown> =
  /** 'finishing': the bytes are sent and the response has not come back. */
  | (ServerUploadRecordBase & { status: 'queued' | 'uploading' | 'finishing'; response?: undefined; error?: undefined })
  | DoneServerUpload<TResponse>
  | (ServerUploadRecordBase & { status: 'canceled'; response?: undefined; error?: undefined })
  | FailedServerUpload;

export type ServerUploadStartArgs = { file?: File | null } | { body?: File | Blob | FormData | null };

export interface UseServerUploadOptions<R> {
  /**
   * A function is re-read per request, so a rotated JWT is never stale. A throw from it ends the
   * upload carrying that error, which is how an app refuses its own upload.
   */
  headers?: HeadersProvider;
  /** Requests in flight. The rest queue. */
  concurrency?: number;
  /** The multipart field `start({ file })` sends the file in. Must match the route's. Default 'file'. */
  field?: string;
  onDone?: (upload: DoneServerUpload<ServerUploadResponse<R>>) => void;
  onError?: (upload: FailedServerUpload) => void;
}

export interface UseServerUploadResult<R> {
  start(args: ServerUploadStartArgs): ServerUploadRecord<ServerUploadResponse<R>> | null;
  uploads: ServerUploadRecord<ServerUploadResponse<R>>[];
  /** The newest record. */
  upload: ServerUploadRecord<ServerUploadResponse<R>> | null;
  clear(id?: string): void;
  /** The route's contentTypes, joined. Empty until GET lands, or when it serves none. */
  accept: string;
  /**
   * What the route says it accepts, its own numbers. Undefined until its GET answers, and for a
   * route this SDK did not write, which serves no constraints document at all.
   */
  constraints: WireConstraints | undefined;
}

interface Payload {
  body: XMLHttpRequestBodyInit;
  file: File | null;
  total: number;
}

let staticCounter = 0;

// fetch's body rule, not an encoding option: a File is a raw body, a FormData is multipart.
function payloadOf(args: ServerUploadStartArgs, field: string): Payload | null {
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

function serverUploadEntry<TResponse>(task: ServerUploadTask<TResponse>): ListEntry<ServerUploadRecord<TResponse>> {
  const cancel = () => task.cancel();
  return {
    id: task.id,
    subscribe: (onChange) => task.subscribe(onChange),
    status: () => task.snapshot().status,
    record: () => ({ id: task.id, file: task.file, cancel, ...task.snapshot() }),
    start: () => task.start(),
  };
}

// A file the route's own constraints already refuse is never sent, so the bytes never leave the browser.
function refusedEntry<TResponse>(file: File, error: BlobError): ListEntry<ServerUploadRecord<TResponse>> {
  const id = `q${++staticCounter}-${clock.now().toString(36)}`;
  const record: ServerUploadRecord<TResponse> = {
    id,
    file,
    cancel: () => false,
    loaded: 0,
    total: file.size,
    percent: 0,
    pending: false,
    status: 'error',
    error,
  };
  return { id, subscribe: () => () => {}, status: () => 'error', record: () => record, start: () => {} };
}

/**
 * One ordinary POST to your own route: request upload progress plus cancellation. The response JSON
 * is handed back exactly as it arrived.
 */
export function useServerUpload<R = unknown>(route: string, options: UseServerUploadOptions<R> = {}): UseServerUploadResult<R> {
  type TResponse = R;

  const headersRef = useRef<HeadersProvider | undefined>(options.headers);
  headersRef.current = options.headers;
  const fieldRef = useRef(options.field ?? 'file');
  fieldRef.current = options.field ?? 'file';
  const handlers = useRef(options);
  handlers.current = options;

  // An ordinary POST-only route answers GET with 404/405 and leaves these empty. A route may
  // optionally serve the SDK's `{ constraints }` document to fill its picker from one source.
  const { constraintsRef, constraints, accept } = useConstraints(route, options.headers);

  const { uploads, task, add, clear } = useTaskList<ServerUploadRecord<TResponse>>({
    concurrency: options.concurrency,
    onDone: (record) => {
      if (record.status === 'done') handlers.current.onDone?.(record as DoneServerUpload<TResponse>);
    },
    onError: (record) => {
      if (record.status === 'error') handlers.current.onError?.(record);
    },
  });

  const start = useCallback(
    (args: ServerUploadStartArgs) => {
      const payload = payloadOf(args, fieldRef.current);
      if (!payload) return null;
      const refusal = payload.file ? deny(payload.file, constraintsRef.current) : undefined;
      const entry = refusal ? refusedEntry<TResponse>(payload.file!, refusal) : serverUploadEntry(new ServerUploadTask<TResponse>({ route, headers: headersRef.current, ...payload }));
      return add([entry])[0] ?? null;
    },
    [add, route, constraintsRef],
  );

  return { start, uploads, upload: task, clear, accept, constraints };
}
