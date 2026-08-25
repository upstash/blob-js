import { clock } from '../browser/clock.ts';
import { resolveHeaders, routeMessage, type HeadersProvider } from '../browser/task.ts';
import { NetworkError, sendXhr, type XhrResponse } from '../browser/xhr.ts';
import { BlobError, PLATFORM_BODY_CAP_HINT } from '../shared/errors.ts';

export type ProxySnapshot<TResponse> = {
  loaded: number;
  total: number;
  percent: number;
  /** The bytes are sent and the response has not come back. */
  finishing: boolean;
} & (
  | { status: 'queued' | 'uploading' }
  | { status: 'done'; response: TResponse }
  | { status: 'canceled' }
  | { status: 'error'; error: BlobError }
);

export interface ProxyTaskOptions {
  route: string;
  headers?: HeadersProvider;
  body: XMLHttpRequestBodyInit;
  /** The File behind the body, when there is one. */
  file: File | null;
  /** Replaced by upload.onprogress, which counts the multipart envelope too. */
  total: number;
}

type Status = 'queued' | 'uploading' | 'done' | 'canceled' | 'error';

let counter = 0;

/**
 * uploadedAt crosses the wire as an ISO string. Reviving it here is what makes a proxied upload's
 * blob the same shape as a direct one's, so the two hooks stay interchangeable. Guarded on the exact
 * envelope handleProxyUpload writes; any other response body is handed back untouched.
 */
function revive(json: unknown): unknown {
  const body = json as { blob?: { uploadedAt?: unknown } } | null | undefined;
  if (typeof body !== 'object' || body === null || typeof body.blob?.uploadedAt !== 'string') return json;
  return { ...body, blob: { ...body.blob, uploadedAt: new Date(body.blob.uploadedAt) } };
}

/** One POST to a route you wrote: no begin, no end, no pause. Observable, and free of React. */
export class ProxyTask<TResponse = unknown> {
  readonly id = `p${++counter}-${clock.now().toString(36)}`;
  readonly file: File | null;

  private status: Status = 'queued';
  private loaded = 0;
  private total: number;
  private finishing = false;
  private response: TResponse | undefined;
  private error: BlobError | undefined;
  private started = false;
  private readonly controller = new AbortController();
  private readonly listeners = new Set<() => void>();
  private cached: ProxySnapshot<TResponse> | undefined;
  private frameQueued = false;

  constructor(private readonly options: ProxyTaskOptions) {
    this.file = options.file;
    this.total = options.total;
  }

  snapshot(): ProxySnapshot<TResponse> {
    if (this.cached) return this.cached;
    const done = this.status === 'done';
    const base = {
      loaded: done ? this.total : this.loaded,
      total: this.total,
      // 100% means sent, not stored: the bar sits there with finishing set while the route streams
      // the body onward. That is the whole difference from useUpload's percent.
      percent: done ? 100 : this.total > 0 ? Math.min(100, Math.floor((this.loaded / this.total) * 100)) : 0,
      finishing: this.finishing,
    };
    switch (this.status) {
      case 'done':
        this.cached = { ...base, status: 'done', response: this.response as TResponse };
        break;
      case 'error':
        this.cached = { ...base, status: 'error', error: this.error! };
        break;
      case 'canceled':
        this.cached = { ...base, status: 'canceled' };
        break;
      default:
        this.cached = { ...base, status: this.status };
    }
    return this.cached;
  }

  subscribe(onChange: () => void): () => void {
    this.listeners.add(onChange);
    return () => {
      this.listeners.delete(onChange);
    };
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    void this.run();
  }

  cancel(): boolean {
    if (this.status === 'done' || this.status === 'error' || this.status === 'canceled') return false;
    this.status = 'canceled';
    this.finishing = false;
    this.controller.abort();
    this.notify();
    return true;
  }

  private async run(): Promise<void> {
    this.status = 'uploading';
    this.notify();
    let authored: Record<string, string>;
    try {
      // The app's own hook. A throw from it ends the upload carrying that error, rather than being
      // reworded below as a route that could not be reached.
      authored = await resolveHeaders(this.options.headers);
    } catch (e) {
      this.fail(BlobError.is(e) ? e : new BlobError('request_failed', { message: e instanceof Error ? e.message : String(e), status: 400, cause: e }));
      return;
    }
    let res: XhrResponse;
    try {
      res = await sendXhr({
        method: 'POST',
        url: this.options.route,
        // No content-type: the browser writes the multipart boundary, or the Blob's own type.
        headers: authored,
        body: this.options.body,
        signal: this.controller.signal,
        onUploadProgress: (loaded, total) => {
          this.loaded = loaded;
          if (total > 0) this.total = total;
          this.notify();
        },
        onUploadDone: () => {
          this.finishing = true;
          this.notify();
        },
      });
    } catch (e) {
      if (this.isCanceled()) return;
      const message = e instanceof NetworkError ? 'could not reach the route' : e instanceof Error ? e.message : String(e);
      this.fail(new BlobError('request_failed', { message, status: 503, cause: e }));
      return;
    }
    if (this.isCanceled()) return;

    this.finishing = false;
    let json: unknown;
    try {
      json = res.text ? JSON.parse(res.text) : undefined;
    } catch {
      json = undefined;
    }
    if (res.status >= 200 && res.status < 300) {
      this.response = revive(json) as TResponse;
      this.status = 'done';
      this.notify();
      return;
    }
    // A route that answered with BlobError.toJSON() keeps its code, so callers can switch on
    // error.code instead of matching status numbers and message text.
    const authoredError = BlobError.fromJSON(json, res.status);
    if (authoredError) {
      this.fail(authoredError);
      return;
    }
    // The platform rejected the body before your route ran, so the 413 carries no code of its own.
    if (res.status === 413) {
      this.fail(new BlobError('too_large', { hint: PLATFORM_BODY_CAP_HINT }));
      return;
    }
    this.fail(new BlobError('request_failed', { message: routeMessage(json, res), status: res.status }));
  }

  private isCanceled(): boolean {
    return this.status === 'canceled';
  }

  private fail(error: BlobError): void {
    this.finishing = false;
    this.error = error;
    this.status = 'error';
    this.notify();
  }

  private notify(): void {
    this.cached = undefined;
    if (this.frameQueued) return;
    this.frameQueued = true;
    clock.frame(() => {
      this.frameQueued = false;
      for (const listener of [...this.listeners]) listener();
    });
  }
}
