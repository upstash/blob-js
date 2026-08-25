import { abortError, clock } from './clock.ts';

export interface XhrRequest {
  method: string;
  url: string;
  headers?: Record<string, string>;
  body?: XMLHttpRequestBodyInit | null;
  signal?: AbortSignal;
  onUploadProgress?: (loaded: number, total: number) => void;
  /** Fires when the body has been sent and the response has not come back. */
  onUploadDone?: () => void;
  /** Fail the request after this long without an upload progress event or a response. */
  stallTimeoutMs?: number;
}

export interface XhrResponse {
  status: number;
  statusText: string;
  header(name: string): string | null;
  text: string;
}

export class NetworkError extends Error {
  override readonly name = 'NetworkError';
}

// XHR and not fetch: fetch has no upload progress event, and request streams need duplex:'half'
// on the one browser that supports them.
export function sendXhr(req: XhrRequest): Promise<XhrResponse> {
  return new Promise((resolve, reject) => {
    if (req.signal?.aborted) return reject(abortError());
    const xhr = new XMLHttpRequest();
    xhr.open(req.method, req.url, true);
    for (const [k, v] of Object.entries(req.headers ?? {})) xhr.setRequestHeader(k, v);
    // xhr.timeout is a deadline for the whole request, which a large part on a slow link outruns
    // honestly. The watchdog below measures silence instead, and covers the wait for the response
    // too: without it a connection that dies after the last byte hangs until the tab closes.
    let cancelStall = () => {};
    const cleanup = () => {
      cancelStall();
      req.signal?.removeEventListener('abort', onAbort);
    };
    const arm = () => {
      if (!req.stallTimeoutMs) return;
      cancelStall();
      cancelStall = clock.timer(req.stallTimeoutMs, () => {
        cleanup();
        // Reject before aborting: onabort would otherwise settle this promise with an AbortError,
        // which every caller reads as "the user canceled" instead of "retry this part".
        reject(new NetworkError(`no progress for ${Math.round(req.stallTimeoutMs! / 1000)}s`));
        xhr.abort();
      });
    };
    function onAbort() {
      xhr.abort();
      cleanup();
      reject(abortError());
    }
    req.signal?.addEventListener('abort', onAbort, { once: true });
    xhr.upload.onprogress = (e) => {
      arm();
      req.onUploadProgress?.(e.loaded, e.lengthComputable ? e.total : e.loaded);
    };
    xhr.upload.onload = () => {
      arm();
      req.onUploadDone?.();
    };
    xhr.onload = () => {
      cleanup();
      resolve({
        status: xhr.status,
        statusText: xhr.statusText,
        header: (name) => {
          try {
            return xhr.getResponseHeader(name);
          } catch {
            return null;
          }
        },
        text: xhr.responseText,
      });
    };
    xhr.onerror = () => {
      cleanup();
      reject(new NetworkError('network error'));
    };
    xhr.ontimeout = () => {
      cleanup();
      reject(new NetworkError('timeout'));
    };
    xhr.onabort = () => {
      cleanup();
      reject(abortError());
    };
    arm();
    xhr.send(req.body ?? null);
  });
}
