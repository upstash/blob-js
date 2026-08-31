import { BlobError } from '../shared/errors.ts';
import type { CompletedBlob, UploadSnapshot, UploadTask, WireBeginResponse, WireEndResponse, WireLanded, WirePartsResponse } from '../shared/types.ts';
import { SNIFF_BYTES } from '../shared/units.ts';
import { abortError, clock } from './clock.ts';
import { acquire } from './pool.ts';
import { backoffMs, classify, MAX_ATTEMPTS, MAX_NETWORK_ATTEMPTS, NO_BYTES_NETWORK_ATTEMPTS, STALL_TIMEOUT_MS } from './retry.ts';
import { clearPending, fingerprint, readPending, writePending } from './store.ts';
import { NetworkError, sendXhr } from './xhr.ts';

export type HeadersProvider = () => Record<string, string> | Promise<Record<string, string>>;

export interface UploadOptions<TInput = unknown> {
  route: string;
  /** A function is re-read per call to the route, so a rotated JWT still ends the upload. */
  headers?: HeadersProvider;
  input?: TInput;
  /**
   * Whether to send the file's leading bytes with phase 'begin' for the route's type check. The
   * hooks set it from the constraints the route serves, so a route with no contentTypes reads no
   * bytes and sends none. Undefined means send: a caller that does not know what the route enforces
   * must not be the reason the check does not happen.
   */
  sendHead?: boolean;
}

export interface InternalTask extends UploadTask {
  /** Runs the upload; a no-op after the first call. */
  start(): void;
}

const PARTS_IN_FLIGHT = 4;
const ROUTE_ATTEMPTS = 3;
// A part url is signed with the bucket's temporary credential and dies with it, well under ten
// minutes out, which a 5 MiB part on a slow link outruns. A 403 on a url older than this is the
// clock however often it happens; only a url minted moments ago and refused again is the body.
const PRESIGN_STALE_MS = 60_000;
// How many batches one part may wait through before the route is simply not signing it.
const MAX_URL_BATCHES = 4;

type Status = UploadSnapshot['status'];

interface PartState {
  n: number;
  size: number;
  etag?: string;
}

/** A presigned url and the headers its signature pins, which have to be sent with it verbatim. */
interface Signed {
  url: string;
  headers: Record<string, string>;
}

interface InFlight {
  loaded: number;
  backingOff: boolean;
  controller: AbortController;
}

let counter = 0;

export function createTask(file: File, options: UploadOptions, autoStart: boolean): InternalTask {
  const task = new Task(file, options);
  if (autoStart) task.start();
  return task;
}

function isAbort(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as { name?: string }).name === 'AbortError';
}

class Task implements InternalTask {
  readonly id = `u${++counter}-${clock.now().toString(36)}`;

  private status: Status = 'queued';
  private error: BlobError | undefined;
  private blob: (CompletedBlob & { data: unknown }) | undefined;
  private token: string | undefined;
  private storeKey: string;
  private partSize = 0;
  // Whether the route cut this file into real multipart parts. False is a single PUT: one url, one
  // object write, and nothing on the other side to pause into or resume from.
  private multipart = false;
  private parts = new Map<number, PartState>();
  private urls = new Map<number, Signed>();
  private batch: Promise<void> | undefined;
  private inflight = new Map<number, InFlight>();
  private represigned = new Set<number>();
  private urlsMintedAt = 0;
  private paused = false;
  private resumeWaiters: (() => void)[] = [];
  private readonly cancelController = new AbortController();
  private started = false;
  private listeners = new Set<() => void>();
  private cached: UploadSnapshot | undefined;
  private frameQueued = false;
  private resolveDone!: (b: CompletedBlob & { data: unknown }) => void;
  private rejectDone!: (e: unknown) => void;
  private donePromise!: Promise<CompletedBlob & { data: unknown }>;

  constructor(
    readonly file: File,
    private readonly options: UploadOptions,
  ) {
    this.storeKey = fingerprint(options.route, file);
    this.freshDone();
  }

  /** A getter, so retry() can hand out a promise the failed attempt has not already rejected. */
  get done(): Promise<CompletedBlob & { data: unknown }> {
    return this.donePromise;
  }

  private freshDone(): void {
    this.donePromise = new Promise((resolve, reject) => {
      this.resolveDone = resolve;
      this.rejectDone = reject;
    });
    // Nobody is required to await done; a rejection must not surface as unhandled.
    this.donePromise.catch(() => {});
  }

  /* ------------------------------------------------------------ observe */

  snapshot(): UploadSnapshot {
    if (this.cached) return this.cached;
    const total = this.file.size;
    let loaded = 0;
    for (const p of this.parts.values()) if (p.etag) loaded += p.size;
    for (const f of this.inflight.values()) loaded += f.loaded;
    if (this.status === 'done') loaded = total;
    const base = {
      loaded,
      total,
      percent: this.status === 'done' ? 100 : total > 0 ? Math.min(99, Math.floor((loaded / total) * 100)) : 0,
      // A single PUT is one request that is either on the wire or not: stopping it throws its bytes
      // away rather than parking them, so it is not offered as a pause.
      canPause: this.multipart && (this.status === 'queued' || this.status === 'uploading' || this.status === 'paused'),
      pending: this.status !== 'done' && this.status !== 'error' && this.status !== 'canceled',
      stalled: this.inflight.size > 0 && [...this.inflight.values()].every((f) => f.backingOff),
    };
    switch (this.status) {
      case 'done':
        this.cached = { ...base, status: 'done', blob: this.blob! };
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

  private notify(): void {
    this.cached = undefined;
    if (this.frameQueued) return;
    this.frameQueued = true;
    clock.frame(() => {
      this.frameQueued = false;
      for (const l of [...this.listeners]) l();
    });
  }

  /* ----------------------------------------------------------- controls */

  // Bytes on the wire are already paid for, so pause stops the queue rather than the transfer: a
  // part that has sent anything finishes and keeps its etag, and only a part that has sent nothing
  // (parked on a backoff, or waiting for a pool slot) is dropped and re-queued. Aborting all four
  // threw away up to a part each and snapped the bar to zero.
  pause(): boolean {
    // Status 'finishing' is not pausable: every part has landed and phase 'end' is running, so there
    // is nothing left to hold back. Pausing there only mislabelled an upload that completed anyway.
    // Neither is a single PUT: nothing about it can be held back, and answering true there labelled
    // an upload paused that then went on and finished.
    if (!this.multipart || this.status !== 'uploading' || this.paused) return false;
    this.paused = true;
    this.status = 'paused';
    for (const f of this.inflight.values()) if (f.loaded === 0) f.controller.abort();
    this.notify();
    return true;
  }

  resume(): boolean {
    if (this.status !== 'paused') return false;
    this.paused = false;
    this.status = 'uploading';
    const waiters = this.resumeWaiters;
    this.resumeWaiters = [];
    for (const w of waiters) w();
    this.notify();
    return true;
  }

  // The error is terminal for the attempt, not for the upload: the upload the route began still
  // exists, every landed part is still landed, and done is a fresh promise because the old one
  // already rejected.
  retry(): boolean {
    if (this.status !== 'error') return false;
    this.error = undefined;
    this.status = 'queued';
    this.inflight.clear();
    this.represigned.clear();
    this.freshDone();
    this.started = false;
    this.notify();
    this.start();
    return true;
  }

  cancel(): boolean {
    if (this.status === 'done' || this.status === 'error' || this.status === 'canceled') return false;
    // From 'finishing' the route has already been asked to record the object, and the answer is its
    // to give: a cancel racing it would ask the route to delete an object onUploadComplete may have
    // just accepted and written a row for. The local task is canceled either way; what is dropped is
    // the server call, so the worst case is an object the app has no row for rather than a row the
    // app has no object for.
    const finishing = this.status === 'finishing';
    this.status = 'canceled';
    this.paused = false;
    this.cancelController.abort();
    for (const f of this.inflight.values()) f.controller.abort();
    const waiters = this.resumeWaiters;
    this.resumeWaiters = [];
    for (const w of waiters) w();
    if (finishing) clearPending(this.storeKey);
    else this.abortServerSide();
    this.inflight.clear();
    this.notify();
    this.rejectDone(abortError());
    return true;
  }

  // A multipart upload the server already created is storage nothing else can see, and a single PUT
  // that landed is an object no callback accepted, so the token is spent on a cancel either way.
  private abortServerSide(): void {
    clearPending(this.storeKey);
    const token = this.token;
    if (!token) return;
    this.token = undefined;
    this.routeCall({ phase: 'cancel', completionToken: token }, undefined, 1).catch(() => {});
  }

  private landed(): WireLanded[] {
    return [...this.parts.values()].filter((p) => p.etag !== undefined).map((p) => ({ n: p.n, etag: p.etag! }));
  }

  /* ---------------------------------------------------------------- run */

  start(): void {
    if (this.started) return;
    this.started = true;
    this.run().then(
      (blob) => {
        if (this.status === 'canceled') return;
        this.blob = blob;
        this.status = 'done';
        clearPending(this.storeKey);
        this.notify();
        this.resolveDone(blob);
      },
      (e) => {
        if (this.status === 'canceled' || isAbort(e)) return;
        this.error = BlobError.is(e) ? e : new BlobError('request_failed', { message: e instanceof Error ? e.message : String(e), status: 503, cause: e });
        this.status = 'error';
        this.inflight.clear();
        this.notify();
        this.rejectDone(this.error);
      },
    );
  }

  private async run(): Promise<CompletedBlob & { data: unknown }> {
    const signal = this.cancelController.signal;
    if (this.token) {
      // A retry of an upload that already began: its presigns are stale and its parts are the
      // server's to report, so ask for fresh urls instead of beginning a second multipart.
      this.urls.clear();
      await this.fetchBatch(this.firstMissing());
    } else if (!(await this.tryResume())) {
      await this.begin();
    }
    // A cancel that lands while begin is in flight still gets its token here.
    if (signal.aborted) {
      this.abortServerSide();
      throw abortError();
    }
    this.status = 'uploading';
    this.notify();

    await this.runParts();
    const landed = this.landed();
    if (signal.aborted) throw abortError();

    this.status = 'finishing';
    this.notify();
    const end = (await this.routeCall({ phase: 'end', completionToken: this.token, parts: landed }, signal)) as WireEndResponse;
    return { ...end.blob, uploadedAt: new Date(end.blob.uploadedAt), data: end.data };
  }

  private async begin(): Promise<void> {
    const head = this.options.sendHead === false ? undefined : await readHead(this.file);
    const res = (await this.routeCall(
      {
        phase: 'begin',
        file: { name: this.file.name, type: this.file.type, size: this.file.size },
        ...(head === undefined ? {} : { head }),
        ...(this.options.input === undefined ? {} : { input: this.options.input }),
      },
      this.cancelController.signal,
      // Never retried: begin runs onBeforeUpload, which inserts the app's row.
      1,
    )) as WireBeginResponse;
    this.token = res.completionToken;
    this.partSize = res.upload.partSize;
    this.multipart = res.upload.multipart !== false;
    this.layoutParts();
    for (const p of res.upload.parts) this.urls.set(p.n, { url: p.url, headers: p.headers ?? {} });
    this.urlsMintedAt = clock.now();
    writePending(this.storeKey, { completionToken: this.token });
  }

  // The user picking the file again is the resume gesture: a fingerprint match asks the server,
  // which asks R2 what landed. Anything else is a fresh upload, never an error.
  private async tryResume(): Promise<boolean> {
    const rec = readPending(this.storeKey);
    if (!rec) return false;
    try {
      const res = (await this.routeCall({ phase: 'parts', completionToken: rec.completionToken, from: 1 }, this.cancelController.signal, 1)) as WirePartsResponse;
      if (res.size !== this.file.size) throw new Error('not resumable');
      this.token = rec.completionToken;
      this.partSize = res.partSize;
      this.multipart = res.multipart !== false;
      this.layoutParts();
      this.applyBatch(res);
      return true;
    } catch (e) {
      if (isAbort(e)) throw e;
      clearPending(this.storeKey);
      return false;
    }
  }

  private firstMissing(): number {
    for (const p of this.parts.values()) if (!p.etag) return p.n;
    return 1;
  }

  private layoutParts(): void {
    const count = Math.max(1, Math.ceil(this.file.size / this.partSize));
    for (let n = 1; n <= count; n++) {
      this.parts.set(n, { n, size: n === count ? this.file.size - this.partSize * (count - 1) : this.partSize });
    }
  }

  private applyBatch(res: WirePartsResponse): void {
    for (const p of res.parts) this.urls.set(p.n, { url: p.url, headers: p.headers ?? {} });
    this.urlsMintedAt = clock.now();
    for (const l of res.landed) {
      const p = this.parts.get(l.n);
      if (p) p.etag = l.etag;
    }
  }

  /* -------------------------------------------------------------- parts */

  private async runParts(): Promise<void> {
    const pending = [...this.parts.values()].filter((p) => !p.etag).map((p) => p.n);
    let failure: unknown;
    const worker = async () => {
      while (pending.length && failure === undefined) {
        if (this.cancelController.signal.aborted) return;
        if (this.paused) {
          await this.waitResume();
          continue;
        }
        const n = pending.shift()!;
        const part = this.parts.get(n)!;
        try {
          await this.putWithRetry(n, part.size, this.file.slice((n - 1) * this.partSize, (n - 1) * this.partSize + part.size));
          this.notify();
        } catch (e) {
          // An abort that is not the cancel is a pause, even if resume() already ran.
          if (isAbort(e) && !this.cancelController.signal.aborted) {
            pending.unshift(n);
            continue;
          }
          failure ??= e;
          for (const f of this.inflight.values()) f.controller.abort();
        }
      }
    };
    await Promise.all(Array.from({ length: PARTS_IN_FLIGHT }, worker));
    if (failure !== undefined) throw failure;
    if (this.cancelController.signal.aborted) throw abortError();
    const missing = [...this.parts.values()].filter((p) => !p.etag);
    if (missing.length) throw new BlobError('request_failed', { message: `${missing.length} parts did not land`, status: 503 });
  }

  private waitResume(): Promise<void> {
    return new Promise((resolve) => this.resumeWaiters.push(resolve));
  }

  // Re-entrant on purpose: a batch already in flight was asked for some other part's `from` and
  // carries at most 16 urls, so a worker further down the file waits for it and then asks for its
  // own batch. Bounded, because that is one round trip per hop and a route that never signs this
  // part would otherwise spin here with no backoff and no error.
  private async urlFor(n: number, attempt = 0): Promise<Signed> {
    const cached = this.urls.get(n);
    if (cached) return cached;
    this.batch ??= this.fetchBatch(n).finally(() => {
      this.batch = undefined;
    });
    await this.batch;
    const signed = this.urls.get(n);
    if (signed) return signed;
    if (attempt >= MAX_URL_BATCHES) throw new BlobError('request_failed', { message: `the route did not sign part ${n}`, status: 503 });
    return this.urlFor(n, attempt + 1);
  }

  private async fetchBatch(from: number): Promise<void> {
    const res = (await this.routeCall({ phase: 'parts', completionToken: this.token, from }, this.cancelController.signal)) as WirePartsResponse;
    this.applyBatch(res);
  }

  private async represign(n: number): Promise<void> {
    // Every url from the same batch expires together, so drop them all.
    this.urls.clear();
    await this.fetchBatch(n);
  }

  /* ------------------------------------------------------------ one PUT */

  private async putWithRetry(n: number, size: number, body: Blob): Promise<string> {
    const ctrl = new AbortController();
    const cancel = this.cancelController.signal;
    const onCancel = () => ctrl.abort();
    cancel.addEventListener('abort', onCancel, { once: true });
    const state: InFlight = { loaded: 0, backingOff: false, controller: ctrl };
    this.inflight.set(n, state);
    try {
      let sentBytes = false;
      let lastStatus = 0;
      let httpAttempts = 0;
      let netAttempts = 0;
      let represigns = 0;
      let waits = 0;
      for (;;) {
        if (ctrl.signal.aborted) throw abortError();
        const { url, headers } = await this.urlFor(n);
        const mintedAt = this.urlsMintedAt;
        const release = await acquire(ctrl.signal);
        let status = 0;
        let retryAfter: string | null = null;
        let etag: string | null = null;
        try {
          const res = await sendXhr({
            method: 'PUT',
            url,
            headers,
            body,
            signal: ctrl.signal,
            onUploadProgress: (loaded) => {
              if (loaded > 0) sentBytes = true;
              state.loaded = Math.min(loaded, size);
              this.notify();
            },
            stallTimeoutMs: STALL_TIMEOUT_MS,
          });
          status = res.status;
          // Chrome logs "Refused to get unsafe header" for any header a cross-origin response does
          // not name in Access-Control-Expose-Headers, once per read, so R2 is asked only for the
          // ones it answers with: the etag of a stored part, and Retry-After on the two statuses
          // that carry one. A normal 200 must not print a console error (measured 2026-08-25).
          if (status >= 200 && status < 300) etag = res.header('etag');
          else if (status === 429 || status === 503 || sameOrigin(url)) retryAfter = res.header('retry-after');
        } catch (e) {
          if (!(e instanceof NetworkError)) throw e;
          status = 0;
        } finally {
          release();
        }
        if (status >= 200 && status < 300) {
          // Bank the bytes before the finally drops this part from the in-flight map: a notify()
          // between the two reads a snapshot that counts neither, and the bar dips to zero.
          this.parts.get(n)!.etag = etag ?? '';
          return etag ?? '';
        }

        // In-flight bytes were never stored; the bar retreats rather than lying.
        state.loaded = 0;
        this.notify();
        // Nothing is on the wire any more, so a pause that spared this part has nothing left to
        // spare: hand it back to the queue rather than retrying through a pause.
        if (this.paused) throw abortError();
        lastStatus = status;
        const verdict = classify(status);
        if (verdict === 'fail') throw putError(status, false);
        if (verdict === 'represign') {
          const expired = clock.now() - mintedAt >= PRESIGN_STALE_MS;
          if ((!expired && this.represigned.has(n)) || represigns >= MAX_ATTEMPTS) throw putError(status, true);
          represigns++;
          this.represigned.add(n);
          await this.represign(n);
          continue;
        }
        if (status === 0 ? ++netAttempts >= networkAttemptCap(sentBytes) : ++httpAttempts >= MAX_ATTEMPTS) break;
        state.backingOff = true;
        this.notify();
        try {
          await clock.sleep(backoffMs(waits++, retryAfter), ctrl.signal);
        } finally {
          state.backingOff = false;
          this.notify();
        }
      }
      throw new BlobError('request_failed', {
        message: `upload failed after ${httpAttempts + netAttempts} attempts${lastStatus ? ` (last status ${lastStatus})` : ''}`,
        status: 503,
        hint: netAttempts > 0 && !sentBytes ? CORS_HINT : 'the parts that landed are kept: task.retry(), or pick the same file again',
      });
    } finally {
      cancel.removeEventListener('abort', onCancel);
      this.inflight.delete(n);
      this.notify();
    }
  }

  /* -------------------------------------------------------------- route */

  private async routeCall(body: Record<string, unknown>, signal: AbortSignal | undefined, attempts = ROUTE_ATTEMPTS): Promise<unknown> {
    let last: BlobError | undefined;
    for (let attempt = 0; attempt < attempts; attempt++) {
      if (signal?.aborted) throw abortError();
      // Outside the try on purpose. headers() is the app's own hook and is re-read per attempt, so a
      // throw from it is how an app refuses its own upload -- a token it could not refresh, a
      // precondition that failed. Caught below it would be reworded as a network fault and retried
      // three times; here it ends the upload immediately carrying the app's error.
      const authored = await resolveHeaders(this.options.headers);
      let res: Response;
      try {
        res = await fetch(this.options.route, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...authored },
          body: JSON.stringify(body),
          signal,
        });
      } catch (e) {
        if (isAbort(e) || signal?.aborted) throw abortError();
        last = new BlobError('request_failed', { message: 'could not reach the upload route', status: 503, cause: e });
        if (attempt === attempts - 1) break;
        await clock.sleep(backoffMs(attempt), signal);
        continue;
      }
      const text = await res.text();
      let json: unknown;
      try {
        json = text ? JSON.parse(text) : undefined;
      } catch {
        json = undefined;
      }
      if (res.ok) return json;
      const err = BlobError.fromJSON(json, res.status) ?? BlobError.fromStatus(res.status, { message: routeMessage(json, res) });
      if (classify(res.status) !== 'retry') throw err;
      last = err;
      if (attempt === attempts - 1) break;
      await clock.sleep(backoffMs(attempt, res.headers.get('retry-after')), signal);
    }
    throw last ?? new BlobError('request_failed');
  }
}

// A PUT that fails with no status and no bytes sent was refused by the browser, not by storage, and
// the reason is never visible to script: the preflight is what failed. Retrying it for four minutes
// only delays the same answer.
const CORS_HINT = 'the browser blocked the request before sending any bytes, which is almost always CORS: the bucket has to allow PUT and the signed headers from this origin';

function networkAttemptCap(sentBytes: boolean): number {
  if (sentBytes) return MAX_NETWORK_ATTEMPTS;
  // Offline is the one other way to fail with nothing sent, and it does come back.
  const offline = typeof navigator !== 'undefined' && navigator.onLine === false;
  return offline ? MAX_NETWORK_ATTEMPTS : NO_BYTES_NETWORK_ATTEMPTS;
}

function sameOrigin(url: string): boolean {
  if (typeof location === 'undefined') return false;
  try {
    return new URL(url, location.href).origin === location.origin;
  } catch {
    return false;
  }
}

function putError(status: number, afterRepresign: boolean): BlobError {
  if (afterRepresign) return new BlobError('signature_mismatch');
  if (status === 413) return new BlobError('too_large', { message: 'storage refused the body as too large' });
  return new BlobError('request_failed', { message: `storage responded ${status}`, status: status || 503 });
}

export function routeMessage(json: unknown, res: { status: number; statusText: string }): string {
  const err = (json as { error?: unknown } | undefined)?.error;
  if (typeof err === 'string' && err) return err;
  if (typeof (json as { message?: unknown } | undefined)?.message === 'string') return (json as { message: string }).message;
  return res.statusText || `request failed with ${res.status}`;
}

export async function resolveHeaders(h: HeadersProvider | undefined): Promise<Record<string, string>> {
  if (!h) return {};
  return await h();
}

/**
 * The file's first bytes, base64, for the server's type check at 'begin'. Best effort: a file the
 * browser will not read yet is not worth failing the upload over, so the head is simply omitted and
 * the server falls back to the declared type.
 */
async function readHead(file: Blob): Promise<string | undefined> {
  try {
    const buf = await file.slice(0, SNIFF_BYTES).arrayBuffer();
    const bytes = new Uint8Array(buf);
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i] as number);
    return btoa(bin);
  } catch {
    return undefined;
  }
}
