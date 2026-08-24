import { abortError } from './clock.ts';

export interface XhrRequest {
  method: string;
  url: string;
  headers?: Record<string, string>;
  body?: XMLHttpRequestBodyInit | null;
  signal?: AbortSignal;
  onUploadProgress?: (loaded: number, total: number) => void;
  /** Fires when the body has been sent and the response has not come back. */
  onUploadDone?: () => void;
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
    const cleanup = () => req.signal?.removeEventListener('abort', onAbort);
    function onAbort() {
      xhr.abort();
      cleanup();
      reject(abortError());
    }
    req.signal?.addEventListener('abort', onAbort, { once: true });
    xhr.upload.onprogress = (e) => req.onUploadProgress?.(e.loaded, e.lengthComputable ? e.total : e.loaded);
    xhr.upload.onload = () => req.onUploadDone?.();
    xhr.onload = () => {
      cleanup();
      resolve({
        status: xhr.status,
        statusText: xhr.statusText,
        header: (name) => xhr.getResponseHeader(name),
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
    xhr.send(req.body ?? null);
  });
}
