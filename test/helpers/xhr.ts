// XMLHttpRequest stand-ins for a runtime without one. FetchXhr really sends the request through
// fetch (bytes land in R2); ManualXhr is driven by the test.

type Handler = ((e: any) => void) | null;

class Upload {
  onprogress: Handler = null;
  onload: Handler = null;
}

abstract class BaseXhr {
  upload = new Upload();
  onload: Handler = null;
  onerror: Handler = null;
  ontimeout: Handler = null;
  onabort: Handler = null;
  status = 0;
  statusText = '';
  responseText = '';
  method = '';
  url = '';
  headers: Record<string, string> = {};
  body: unknown = null;
  aborted = false;
  /** Every response header this request asked for: Chrome logs an error for one CORS never exposed. */
  asked: string[] = [];
  protected responseHeaders = new Map<string, string>();

  open(method: string, url: string): void {
    this.method = method;
    this.url = url;
  }
  setRequestHeader(k: string, v: string): void {
    this.headers[k.toLowerCase()] = v;
  }
  getResponseHeader(name: string): string | null {
    this.asked.push(name.toLowerCase());
    return this.responseHeaders.get(name.toLowerCase()) ?? null;
  }
  abstract send(body: unknown): void;
  abort(): void {
    this.aborted = true;
    this.onabort?.({});
  }
}

export class FetchXhr extends BaseXhr {
  send(body: unknown): void {
    this.body = body;
    const controller = new AbortController();
    this.abort = () => {
      this.aborted = true;
      controller.abort();
      this.onabort?.({});
    };
    const size = body instanceof Blob ? body.size : 0;
    (async () => {
      try {
        this.upload.onprogress?.({ loaded: Math.floor(size / 2), total: size, lengthComputable: true });
        const res = await fetch(this.url, { method: this.method, headers: this.headers, body: body as BodyInit, signal: controller.signal });
        this.upload.onprogress?.({ loaded: size, total: size, lengthComputable: true });
        this.upload.onload?.({});
        this.status = res.status;
        this.statusText = res.statusText;
        res.headers.forEach((v, k) => this.responseHeaders.set(k.toLowerCase(), v));
        this.responseText = await res.text();
        if (!this.aborted) this.onload?.({});
      } catch (e) {
        if (!this.aborted) this.onerror?.(e);
      }
    })();
  }
}

export class ManualXhr extends BaseXhr {
  static pending: ManualXhr[] = [];
  /** Kept after the response, so a test can prove a part that landed was never sent twice. */
  static sentUrls: string[] = [];
  static reset(): void {
    ManualXhr.pending = [];
    ManualXhr.sentUrls = [];
  }
  sent = false;

  send(body: unknown): void {
    this.body = body;
    this.sent = true;
    ManualXhr.pending.push(this);
    ManualXhr.sentUrls.push(this.url);
  }

  override abort(): void {
    const i = ManualXhr.pending.indexOf(this);
    if (i >= 0) ManualXhr.pending.splice(i, 1);
    super.abort();
  }

  progress(loaded: number, total?: number): void {
    const size = total ?? (this.body instanceof Blob ? this.body.size : loaded);
    this.upload.onprogress?.({ loaded, total: size, lengthComputable: true });
  }

  sentAll(): void {
    this.upload.onload?.({});
  }

  respond(status: number, headers: Record<string, string> = {}, text = ''): void {
    this.status = status;
    this.statusText = status === 200 ? 'OK' : status === 413 ? 'Payload Too Large' : status === 500 ? 'Internal Server Error' : '';
    for (const [k, v] of Object.entries(headers)) this.responseHeaders.set(k.toLowerCase(), v);
    this.responseText = text;
    ManualXhr.pending.splice(ManualXhr.pending.indexOf(this), 1);
    this.onload?.({});
  }

  fail(): void {
    ManualXhr.pending.splice(ManualXhr.pending.indexOf(this), 1);
    this.onerror?.({});
  }
}

export function installXhr(cls: typeof FetchXhr | typeof ManualXhr): () => void {
  const prev = (globalThis as any).XMLHttpRequest;
  (globalThis as any).XMLHttpRequest = cls;
  return () => {
    (globalThis as any).XMLHttpRequest = prev;
  };
}

/** Routes fetch(route) to in-process handlers; anything else goes to the real fetch. */
export function installRouter(routes: Record<string, { GET?: (r: Request) => Promise<Response>; POST: (r: Request) => Promise<Response> }>): () => void {
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const handlers = routes[url];
    if (!handlers) return real(input, init);
    const req = new Request(`https://app.test${url}`, init);
    const h = req.method === 'GET' ? handlers.GET : handlers.POST;
    if (!h) return new Response('not found', { status: 404 });
    return h(req);
  }) as typeof fetch;
  return () => {
    globalThis.fetch = real;
  };
}

export function flush(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}
