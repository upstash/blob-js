import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { BlobError } from '../../src/shared/errors.ts';
import { upload } from '../../src/browser/index.ts';
import { createTask } from '../../src/browser/task.ts';
import { clock } from '../../src/browser/clock.ts';
import { poolState, GLOBAL_REQUEST_CAP } from '../../src/browser/pool.ts';
import { backoffMs, classify } from '../../src/browser/retry.ts';
import { flush, installXhr, ManualXhr, removeXhr } from '../helpers/xhr.ts';

const MIB = 1024 * 1024;
const memory = new Map<string, string>();
const sleeps: number[] = [];
let timers: { ms: number; cb: () => void }[] = [];
let wakers: (() => void)[] = [];
let calls: { phase: string; body: any; protocol: unknown }[] = [];
let onPhase: (body: any) => unknown | Response;
const restore: (() => void)[] = [];

const BLOB = { path: 'p', url: 'https://h/p', versionedUrl: 'https://h/p?v=%22x%22', size: 3, etag: '"x"', uploadedAt: '2026-08-24T00:00:00.000Z' };

// What the route answers with. Under the threshold that is one presigned object PUT carrying the
// headers its signature pins; over it, real multipart parts. The client walks the same list either
// way, so the two shapes differ only in `multipart` and in what a part url means.
const THRESHOLD = 16_000_000;
const SINGLE_HEADERS = { 'content-type': 'image/png', 'cache-control': 'public, max-age=3600' };

function multipartBegin(size: number, partSize = 5 * MIB) {
  return { completionToken: 'tok', path: 'p', upload: { partSize, multipart: true, parts: partUrls(1, size, partSize) } };
}

function singleBegin(size: number, gen = 0) {
  return { completionToken: 'tok', path: 'p', upload: { partSize: size, multipart: false, parts: singleUrl(gen) } };
}

function singleUrl(gen = 0) {
  return [{ n: 1, url: `https://r2.test/object?g=${gen}`, headers: SINGLE_HEADERS }];
}

function partUrls(from: number, size: number, partSize: number, gen = 0) {
  const count = Math.ceil(size / partSize);
  const out = [];
  for (let n = from; n < from + 16 && n <= count; n++) out.push({ n, url: `https://r2.test/part/${n}?g=${gen}` });
  return out;
}

function defaultRoute(size: number, landed: { n: number; etag: string }[] = []) {
  let gen = 0;
  const multipart = size > THRESHOLD;
  return (body: any) => {
    if (body.phase === 'begin') return multipart ? multipartBegin(size) : singleBegin(size);
    if (body.phase === 'parts') {
      gen++;
      if (!multipart) return { partSize: size, size, multipart: false, parts: singleUrl(gen), landed: [] };
      return { partSize: 5 * MIB, size, multipart: true, parts: partUrls(body.from, size, 5 * MIB, gen), landed };
    }
    if (body.phase === 'end') return { blob: { ...BLOB, size }, data: { rowId: '1', parts: body.parts } };
    if (body.phase === 'cancel') return { ok: true };
    throw new Error('unexpected phase');
  };
}

// defaultRoute that remembers when it signed each generation of urls, and storage that refuses a url
// past its life the way the browser sees it: the 403 carries no CORS header, so it is a network
// error with no status. `expiresS` is written into the urls the way storage signs them.
function expiringRoute(size: number, expiresS?: number) {
  const base = defaultRoute(size);
  const issued: number[] = [];
  const route = (body: any) => {
    const out: any = base(body);
    const plan = body.phase === 'begin' ? out.upload : body.phase === 'parts' ? out : undefined;
    if (plan) {
      issued.push(clock.now());
      if (expiresS) plan.parts = plan.parts.map((p: any) => ({ ...p, url: `${p.url}&X-Amz-Expires=${expiresS}` }));
    }
    return out;
  };
  const storage = (x: ManualXhr, beforeOk?: () => void) => {
    const gen = Number(new URL(x.url).searchParams.get('g'));
    if (clock.now() - issued[gen]! >= (expiresS ?? 600) * 1000) {
      x.progress(1);
      x.fail();
      return;
    }
    beforeOk?.();
    x.respond(200, { etag: `"e${new URL(x.url).pathname.split('/').pop()}"` });
  };
  return { route, storage };
}

/** Wakes every backoff and answers every PUT on the wire, until the task settles. */
async function drive(task: { snapshot(): { pending: boolean } }, answer: (x: ManualXhr) => void, rounds = 80) {
  for (let i = 0; i < rounds && task.snapshot().pending; i++) {
    await wake();
    for (const x of [...ManualXhr.pending]) answer(x);
  }
  await settle();
}

beforeAll(() => {
  (globalThis as any).localStorage = {
    getItem: (k: string) => memory.get(k) ?? null,
    setItem: (k: string, v: string) => void memory.set(k, v),
    removeItem: (k: string) => void memory.delete(k),
  };
  clock.frame = (cb) => queueMicrotask(cb);
  clock.random = () => 0.5;
  clock.timer = (ms, cb) => {
    const entry = { ms, cb };
    timers.push(entry);
    return () => {
      const i = timers.indexOf(entry);
      if (i >= 0) timers.splice(i, 1);
    };
  };
  clock.sleep = async (ms, signal) => {
    sleeps.push(ms);
    if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
    await new Promise<void>((resolve) => wakers.push(resolve));
    if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
  };
  restore.push(installXhr(ManualXhr));
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: any, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.url;
    if (!url.startsWith('/api/')) return real(input, init);
    const body = JSON.parse(init!.body as string);
    // Kept apart so the body assertions stay about the phase; afterEach checks it on every call.
    const { protocol, ...rest } = body;
    calls.push({ phase: body.phase, body: rest, protocol });
    const out = onPhase(body);
    if (out instanceof Response) return out;
    return Response.json(out);
  }) as typeof fetch;
  restore.push(() => {
    globalThis.fetch = real;
  });
});
afterAll(() => restore.forEach((r) => r()));
function fireTimers(): void {
  const due = timers;
  timers = [];
  for (const t of due) t.cb();
}

beforeEach(() => {
  calls = [];
  timers = [];
  sleeps.length = 0;
  wakers = [];
  memory.clear();
  ManualXhr.reset();
});
afterEach(() => {
  expect(poolState().active).toBe(0);
  // Every phase of every test: the client's protocol rides each POST.
  expect(calls.map((c) => c.protocol)).toEqual(calls.map(() => 1));
});

async function settle(rounds = 6) {
  for (let i = 0; i < rounds; i++) await flush();
}

/** Microtasks only: enough for an XHR callback to reach the next await in the client. */
async function tick() {
  for (let i = 0; i < 12; i++) await Promise.resolve();
}

async function wake() {
  await tick();
  const w = wakers;
  wakers = [];
  for (const r of w) r();
  await settle();
}

const png = () => new File([new Uint8Array(3)], 'a.png', { type: 'image/png', lastModified: 1 });
const big = (size: number) => new File([new ArrayBuffer(size)], 'big.bin', { type: 'application/octet-stream', lastModified: 2 });

describe('a single PUT', () => {
  test('begin, PUT the object, progress, end, done with typed data', async () => {
    onPhase = defaultRoute(3);
    const task = upload(png(), { route: '/api/upload', headers: () => ({ authorization: 'Bearer j' }), input: { threadId: 't' } });
    // A three-byte file is one object PUT, not a multipart of one part: there is no upload on the
    // other side to park bytes in, so it is not offered as pausable.
    expect(task.snapshot()).toMatchObject({ status: 'queued', loaded: 0, total: 3, percent: 0, canPause: false, stalled: false });
    const same = task.snapshot();
    expect(task.snapshot()).toBe(same);
    await settle();
    expect(calls[0]!.body).toEqual({ phase: 'begin', file: { name: 'a.png', type: 'image/png', size: 3 }, head: 'AAAA', input: { threadId: 't' } });
    expect(ManualXhr.pending.length).toBe(1);
    const xhr = ManualXhr.pending[0]!;
    expect(xhr.method).toBe('PUT');
    expect(xhr.url).toBe('https://r2.test/object?g=0');
    // A single PUT writes the object, so what a multipart pins at create is signed into this url
    // instead and sent with it verbatim.
    expect(xhr.headers).toEqual(SINGLE_HEADERS);
    expect(xhr.body).toBeInstanceOf(Blob);
    expect(task.snapshot().status).toBe('uploading');
    xhr.progress(2);
    expect(task.snapshot()).toMatchObject({ loaded: 2, percent: 66 });
    let notified = 0;
    task.subscribe(() => notified++);
    xhr.progress(3);
    xhr.respond(200, { etag: '"x"' });
    const blob = await task.done;
    expect(blob).toMatchObject({ path: 'p', size: 3, etag: '"x"', data: { rowId: '1' } });
    expect(blob.uploadedAt).toBeInstanceOf(Date);
    expect(calls.map((c) => c.phase)).toEqual(['begin', 'end']);
    expect(calls[1]!.body).toEqual({ phase: 'end', completionToken: 'tok', parts: [{ n: 1, etag: '"x"' }] });
    await settle();
    expect(task.snapshot()).toMatchObject({ status: 'done', percent: 100, loaded: 3 });
    expect(notified).toBeGreaterThan(0);
    expect(memory.size).toBe(0);
  });

  test('retries 503 and network errors with jittered backoff; stalled while waiting', async () => {
    onPhase = defaultRoute(3);
    const task = upload(png(), { route: '/api/upload' });
    await settle();
    ManualXhr.pending[0]!.progress(2);
    expect(task.snapshot().loaded).toBe(2);
    ManualXhr.pending[0]!.respond(503);
    await tick();
    expect(task.snapshot()).toMatchObject({ loaded: 0, stalled: true });
    await wake();
    expect(task.snapshot().stalled).toBe(false);
    ManualXhr.pending[0]!.fail();
    await wake();
    ManualXhr.pending[0]!.respond(429, { 'retry-after': '3' });
    await wake();
    expect(sleeps).toEqual([250, 500, 3000]);
    ManualXhr.pending[0]!.respond(200, { etag: '"x"' });
    await task.done;
    expect(calls.map((c) => c.phase)).toEqual(['begin', 'end']);
  });

  test('the bar stays full while phase end runs', async () => {
    let finish!: () => void;
    onPhase = (body) => {
      if (body.phase !== 'end') return defaultRoute(3)(body);
      return new Response(
        new ReadableStream({
          start: (c) => {
            finish = () => {
              c.enqueue(new TextEncoder().encode(JSON.stringify({ blob: BLOB, data: null })));
              c.close();
            };
          },
        }),
      );
    };
    const task = upload(png(), { route: '/api/upload' });
    await settle();
    ManualXhr.pending[0]!.progress(3);
    ManualXhr.pending[0]!.respond(200, { etag: '"x"' });
    await tick();
    expect(calls.at(-1)!.phase).toBe('end');
    // The bytes are in R2; the bar must not collapse while the route HEADs and runs the hook.
    expect(task.snapshot()).toMatchObject({ status: 'finishing', loaded: 3, percent: 99 });
    finish();
    await task.done;
    expect(task.snapshot()).toMatchObject({ status: 'done', percent: 100 });
  });

  test('cancel while finishing never asks the route to delete an object end may have accepted', async () => {
    let finish!: () => void;
    onPhase = (body) => {
      if (body.phase !== 'end') return defaultRoute(3)(body);
      return new Response(
        new ReadableStream({
          start: (c) => {
            finish = () => {
              c.enqueue(new TextEncoder().encode(JSON.stringify({ blob: BLOB, data: null })));
              c.close();
            };
          },
        }),
      );
    };
    const task = upload(png(), { route: '/api/upload' });
    await settle();
    ManualXhr.pending[0]!.progress(3);
    ManualXhr.pending[0]!.respond(200, { etag: '"x"' });
    await tick();
    expect(task.snapshot().status).toBe('finishing');
    // The route has already been asked to record the object and onUploadComplete may have inserted
    // the row. A cancel that raced it and won would delete the file that row points at.
    expect(task.cancel()).toBe(true);
    await settle();
    expect(calls.map((c) => c.phase)).toEqual(['begin', 'end']);
    expect(memory.size).toBe(0);
    await expect(task.done).rejects.toMatchObject({ name: 'AbortError' });
    finish();
    await settle();
  });

  test('401 and 403 re-presign once and retreat the bar before the fresh url arrives', async () => {
    for (const status of [401, 403]) {
      calls = [];
      memory.clear();
      ManualXhr.reset();
      onPhase = defaultRoute(3);
      const task = upload(png(), { route: '/api/upload' });
      await settle();
      ManualXhr.pending[0]!.progress(2);
      expect(task.snapshot().loaded).toBe(2);
      ManualXhr.pending[0]!.respond(status);
      await tick();
      expect(task.snapshot().loaded).toBe(0);
      await settle();
      expect(calls.map((c) => c.phase)).toEqual(['begin', 'parts']);
      ManualXhr.pending[0]!.respond(status);
      await expect(task.done).rejects.toMatchObject({ code: 'signature_mismatch', status: 403 });
    }
  });

  test('403 re-presigns once, then a second 403 is signature_mismatch', async () => {
    onPhase = defaultRoute(3);
    const task = upload(png(), { route: '/api/upload' });
    await settle();
    ManualXhr.pending[0]!.respond(403);
    await settle();
    expect(calls.map((c) => c.phase)).toEqual(['begin', 'parts']);
    expect(ManualXhr.pending[0]!.url).toBe('https://r2.test/object?g=1');
    ManualXhr.pending[0]!.respond(403);
    await expect(task.done).rejects.toMatchObject({ code: 'signature_mismatch', status: 403 });
    expect(task.snapshot().status).toBe('error');
    expect(sleeps).toEqual([]);
  });

  test('fails fast on 400, 411 and 413', async () => {
    for (const [status, code] of [
      [400, 'request_failed'],
      [411, 'request_failed'],
      [413, 'too_large'],
    ] as const) {
      onPhase = defaultRoute(3);
      const task = upload(png(), { route: '/api/upload' });
      await settle();
      ManualXhr.pending[0]!.respond(status);
      const e = await task.done.catch((x) => x);
      expect(BlobError.is(e)).toBe(true);
      expect(e.code).toBe(code);
      if (code === 'request_failed') expect(e.status).toBe(status);
      expect(sleeps).toEqual([]);
    }
  });

  test('gives up after 8 answered failures, with no backoff after the last one', async () => {
    onPhase = defaultRoute(3);
    const task = upload(png(), { route: '/api/upload' });
    for (let i = 0; i < 8; i++) {
      await settle();
      ManualXhr.pending[0]!.respond(503);
      await wake();
    }
    await expect(task.done).rejects.toMatchObject({ code: 'request_failed', status: 503 });
    // 8 sends, 7 waits between them: the 8th failure is the answer, not another 15s.
    expect(sleeps.length).toBe(7);
    expect(Math.max(...sleeps)).toBeLessThanOrEqual(15_000);
  });

  test('a dropped link is not an answer: 20 network attempts, not 8', async () => {
    onPhase = defaultRoute(3);
    const task = upload(png(), { route: '/api/upload' });
    for (let i = 0; i < 8; i++) {
      await settle();
      // Bytes went out before the link died: this is an outage, not a refusal.
      ManualXhr.pending[0]!.progress(1);
      ManualXhr.pending[0]!.fail();
      await wake();
    }
    // An upload runs for minutes; giving up ~25s into an outage re-sends everything in flight.
    expect(task.snapshot().status).toBe('uploading');
    for (let i = 8; i < 20; i++) {
      await settle();
      ManualXhr.pending[0]!.progress(1);
      ManualXhr.pending[0]!.fail();
      await wake();
    }
    await expect(task.done).rejects.toMatchObject({ code: 'request_failed', status: 503 });
    expect(sleeps.length).toBe(19);
  });

  test('a PUT the browser refuses before any bytes fails fast, naming CORS', async () => {
    onPhase = defaultRoute(3);
    const task = upload(png(), { route: '/api/upload' });
    for (let i = 0; i < 3; i++) {
      await settle();
      ManualXhr.pending[0]!.fail();
      await wake();
    }
    const e = await task.done.catch((x) => x);
    expect(BlobError.is(e)).toBe(true);
    expect(e.message).toContain('CORS');
    // Three attempts, not twenty: no amount of backoff fixes a preflight.
    expect(sleeps.length).toBe(2);
  });

  test('the CORS error names the page origin and where to allow it', async () => {
    const had = Object.getOwnPropertyDescriptor(globalThis, 'location');
    Object.defineProperty(globalThis, 'location', { value: { origin: 'http://localhost:3001', href: 'http://localhost:3001/upload' }, configurable: true });
    try {
      onPhase = defaultRoute(3);
      const task = upload(png(), { route: '/api/upload' });
      for (let i = 0; i < 3; i++) {
        await settle();
        ManualXhr.pending[0]!.fail();
        await wake();
      }
      const e = await task.done.catch((x) => x);
      expect(e.code).toBe('request_failed');
      expect(e.message).toContain("the bucket's CORS origins must include http://localhost:3001");
      expect(e.message).toContain('Upstash Console');
      expect(e.message).toContain("the bucket's CORS settings");
      expect(e.hint).toContain('http://localhost:3001');
    } finally {
      if (had) Object.defineProperty(globalThis, 'location', had);
      else delete (globalThis as any).location;
    }
  });

  test('a network failure after bytes were sent is not blamed on CORS', async () => {
    onPhase = defaultRoute(3);
    const task = upload(png(), { route: '/api/upload' });
    for (let i = 0; i < 20; i++) {
      await settle();
      ManualXhr.pending[0]!.progress(1);
      ManualXhr.pending[0]!.fail();
      await wake();
    }
    const e = await task.done.catch((x) => x);
    expect(e.code).toBe('request_failed');
    expect(e.message).not.toContain('CORS');
  });

  test('a PUT that goes quiet is aborted and retried instead of hanging', async () => {
    onPhase = defaultRoute(3);
    const task = upload(png(), { route: '/api/upload' });
    await settle();
    const first = ManualXhr.pending[0]!;
    first.progress(1);
    expect(timers.map((t) => t.ms)).toEqual([60_000]);
    fireTimers();
    expect(first.aborted).toBe(true);
    await tick();
    await wake();
    expect(sleeps.length).toBe(1);
    expect(ManualXhr.pending.length).toBe(1);
    expect(ManualXhr.pending[0]).not.toBe(first);
    ManualXhr.pending[0]!.progress(3);
    ManualXhr.pending[0]!.respond(200, { etag: '"x"' });
    await task.done;
    expect(task.snapshot().status).toBe('done');
  });

  test('a cross-origin 200 asks only for the etag, and retry-after only where one is carried', async () => {
    onPhase = defaultRoute(3);
    const task = upload(png(), { route: '/api/upload' });
    await settle();
    const throttled = ManualXhr.pending[0]!;
    throttled.respond(429, { 'retry-after': '2' });
    await wake();
    expect(throttled.asked).toEqual(['retry-after']);
    expect(sleeps).toEqual([2000]);
    const server = ManualXhr.pending[0]!;
    server.respond(500);
    await tick();
    // R2 sends no Retry-After on a 500, and Chrome logs "Refused to get unsafe header" for a read
    // of a header the CORS response never exposed.
    expect(server.asked).toEqual([]);
    await wake();
    const ok = ManualXhr.pending[0]!;
    ok.respond(200, { etag: '"x"' });
    await task.done;
    expect(ok.asked).toEqual(['etag']);
  });

  test('a 403 on a presign that outlived its credential re-presigns again instead of failing', async () => {
    onPhase = defaultRoute(3);
    const realNow = clock.now;
    let t = 1_000_000;
    clock.now = () => t;
    try {
      const task = upload(png(), { route: '/api/upload' });
      await settle();
      ManualXhr.pending[0]!.respond(403);
      await settle();
      expect(calls.filter((c) => c.phase === 'parts').length).toBe(1);
      // A slow link can outrun the ~524s presign more than once; only a url minted moments ago and
      // refused again is a real signature mismatch.
      t += 600_000;
      ManualXhr.pending[0]!.respond(403);
      await settle();
      expect(calls.filter((c) => c.phase === 'parts').length).toBe(2);
      ManualXhr.pending[0]!.respond(200, { etag: '"x"' });
      await task.done;
    } finally {
      clock.now = realNow;
    }
  });

  test('a url that died while the laptop slept is renewed instead of re-sent until the budget runs out', async () => {
    const realNow = clock.now;
    let t = 1_000_000;
    clock.now = () => t;
    let task: ReturnType<typeof upload> | undefined;
    try {
      const { route, storage } = expiringRoute(3);
      onPhase = route;
      task = upload(png(), { route: '/api/upload' });
      await settle();
      // The lid closes with the PUT on the wire and opens eleven minutes later.
      t += 11 * 60_000;
      ManualXhr.pending[0]!.progress(1);
      ManualXhr.pending[0]!.fail();
      await drive(task, (x) => storage(x));
      expect(await task.done).toMatchObject({ size: 3 });
      expect(calls.map((c) => c.phase)).toEqual(['begin', 'parts', 'end']);
    } finally {
      clock.now = realNow;
      task?.cancel();
      await settle();
    }
  });

  test('a renewal the route cannot answer yet is backed off from like a dropped link', async () => {
    const realNow = clock.now;
    let t = 1_000_000;
    clock.now = () => t;
    let task: ReturnType<typeof upload> | undefined;
    try {
      const { route, storage } = expiringRoute(3);
      let refused = 0;
      // Woken before its network is back: two renewals, three calls each, never reach the route.
      onPhase = (body) => {
        if (body.phase === 'parts' && refused++ < 6) throw new TypeError('Failed to fetch');
        return route(body);
      };
      task = upload(png(), { route: '/api/upload' });
      await settle();
      // The lid closes before a byte leaves.
      t += 11 * 60_000;
      ManualXhr.pending[0]!.fail();
      // The first PUT on the fresh url drops too: the failed renewals do not count against the PUT.
      let dropped = false;
      await drive(task, (x) => (dropped ? storage(x) : ((dropped = true), x.fail())));
      expect(await task.done).toMatchObject({ size: 3 });
      expect(calls.filter((c) => c.phase === 'parts').length).toBe(7);
    } finally {
      clock.now = realNow;
      task?.cancel();
      await settle();
    }
  });

  test("a url is renewed before its own X-Amz-Expires runs out, not after ten minutes", async () => {
    const realNow = clock.now;
    let t = 1_000_000;
    clock.now = () => t;
    let task: ReturnType<typeof upload> | undefined;
    try {
      const { route } = expiringRoute(3, 120);
      onPhase = route;
      task = upload(png(), { route: '/api/upload' });
      await settle();
      ManualXhr.pending[0]!.respond(503);
      await tick();
      t += 110_000;
      await wake();
      expect(calls.map((c) => c.phase)).toEqual(['begin', 'parts']);
      expect(ManualXhr.pending[0]!.url).toContain('g=1');
      ManualXhr.pending[0]!.respond(200, { etag: '"x"' });
      await task.done;
    } finally {
      clock.now = realNow;
      task?.cancel();
      await settle();
    }
  });

  test('route errors become BlobError; begin is never retried, end is retried on 5xx', async () => {
    let begins = 0;
    onPhase = (body) => {
      if (body.phase === 'begin') {
        begins++;
        return new Response('boom', { status: 502 });
      }
      return {};
    };
    const first = upload(png(), { route: '/api/upload' });
    await expect(first.done).rejects.toMatchObject({ code: 'request_failed', status: 502 });
    expect(begins).toBe(1);
    expect(sleeps).toEqual([]);

    let ends = 0;
    const base = defaultRoute(3);
    onPhase = (body) => (body.phase === 'end' && ends++ === 0 ? new Response('boom', { status: 502 }) : base(body));
    const task = upload(png(), { route: '/api/upload' });
    await settle();
    ManualXhr.pending[0]!.respond(200, { etag: '"x"' });
    await settle();
    await wake();
    await task.done;
    expect(ends).toBe(2);
    onPhase = () => Response.json(new BlobError('forbidden').toJSON(), { status: 403 });
    await expect(upload(png(), { route: '/api/upload' }).done).rejects.toMatchObject({ code: 'forbidden', status: 403 });
    onPhase = () => Response.json({ error: 'nope' }, { status: 418 });
    await expect(upload(png(), { route: '/api/upload' }).done).rejects.toMatchObject({ code: 'request_failed', status: 418, message: 'Nope' });
  });

  test('without XMLHttpRequest, upload() throws invalid_input before calling the route', () => {
    onPhase = defaultRoute(3);
    const put = removeXhr();
    let thrown: unknown;
    try {
      expect(typeof XMLHttpRequest).toBe('undefined');
      // Canceled at once if it ever stops throwing, so a regression fails here and not in every later test.
      upload(png(), { route: '/api/upload' }).cancel();
    } catch (e) {
      thrown = e;
    } finally {
      put();
    }
    expect(BlobError.is(thrown)).toBe(true);
    expect(thrown).toMatchObject({ code: 'invalid_input', status: 400 });
    expect((thrown as BlobError).message).toContain('XMLHttpRequest');
    expect((thrown as BlobError).message).toContain('Bucket.fromEnv().put(path, body)');
    expect(calls).toEqual([]);
  });

  test('an input JSON cannot carry is invalid_input and never reaches the route', async () => {
    onPhase = defaultRoute(3);
    const failed = await upload(png(), { route: '/api/upload', input: { n: 1n } }).done.catch((e) => e);
    expect(failed).toMatchObject({ code: 'invalid_input', status: 400 });
    expect(failed.cause).toBeInstanceOf(TypeError);
    expect(calls).toEqual([]);
    expect(sleeps).toEqual([]);
  });

  test('an input that refers to itself is refused at once', async () => {
    onPhase = defaultRoute(3);
    const input: Record<string, unknown> = { rows: Array.from({ length: 100 }, (_, i) => ({ i })) };
    input.self = input;
    const t0 = performance.now();
    const failed = await upload(png(), { route: '/api/upload', input }).done.catch((e) => e);
    expect(performance.now() - t0).toBeLessThan(1000);
    expect(failed).toMatchObject({ code: 'invalid_input' });
    expect(calls).toEqual([]);
  });

  test('a success that drops mid-body is a network failure, retried like one', async () => {
    let parts = 0;
    const base = defaultRoute(3);
    const dropped = () => new Response(new ReadableStream({ start: (c) => c.error(new TypeError('terminated')) }));
    onPhase = (body) => (body.phase === 'parts' && parts++ === 0 ? dropped() : base(body));
    const task = upload(png(), { route: '/api/upload' });
    await settle();
    // A refused presign asks the route for fresh urls, read-only and safe to ask again.
    ManualXhr.pending[0]!.respond(403);
    await settle();
    await wake();
    await settle();
    expect(parts).toBe(2);
    ManualXhr.pending[0]!.respond(200, { etag: '"x"' });
    await task.done;

    onPhase = (body) => (body.phase === 'begin' ? dropped() : base(body));
    await expect(upload(png(), { route: '/api/upload' }).done).rejects.toMatchObject({ code: 'request_failed', status: 503, message: "The upload route's response was cut off" });
  });

  test("a success for 'end' that drops mid-body is never sent again", async () => {
    let ends = 0;
    const base = defaultRoute(3);
    onPhase = (body) => {
      if (body.phase !== 'end') return base(body);
      ends++;
      return new Response(new ReadableStream({ start: (c) => c.error(new TypeError('terminated')) }));
    };
    const task = upload(png(), { route: '/api/upload' });
    await settle();
    ManualXhr.pending[0]!.respond(200, { etag: '"x"' });
    await settle();
    const failed = await task.done.catch((e) => e);
    expect(failed).toMatchObject({ code: 'request_failed', status: 502 });
    expect(failed.message).toContain('The upload completed');
    expect(task.retry()).toBe(false);
    expect(ends).toBe(1);
    expect(sleeps).toEqual([]);
  });

  test("a success for 'end' whose body is not an answer is never sent again", async () => {
    let ends = 0;
    const base = defaultRoute(3);
    onPhase = (body) => {
      if (body.phase !== 'end') return base(body);
      ends++;
      return new Response('<html>ok</html>', { status: 200 });
    };
    const task = upload(png(), { route: '/api/upload' });
    await settle();
    ManualXhr.pending[0]!.respond(200, { etag: '"x"' });
    await settle();
    await expect(task.done).rejects.toMatchObject({ code: 'request_failed', status: 502 });
    expect(task.retry()).toBe(false);
    expect(ends).toBe(1);
  });

  test('a refusal that drops mid-body keeps its status and is not retried', async () => {
    let ends = 0;
    const base = defaultRoute(3);
    const dropped = () => new Response(new ReadableStream({ start: (c) => c.error(new TypeError('terminated')) }), { status: 403 });
    onPhase = (body) => {
      if (body.phase !== 'end') return base(body);
      ends++;
      return dropped();
    };
    const task = upload(png(), { route: '/api/upload' });
    await settle();
    ManualXhr.pending[0]!.respond(200, { etag: '"x"' });
    await settle();
    await expect(task.done).rejects.toMatchObject({ code: 'forbidden', status: 403 });
    expect(ends).toBe(1);
    expect(sleeps).toEqual([]);
  });

  test('a throw from headers is a 400 carrying the app error, and the route is never called', async () => {
    onPhase = defaultRoute(3);
    const cause = new Error('no token');
    const failed = await upload(png(), {
      route: '/api/upload',
      headers: () => {
        throw cause;
      },
    }).done.catch((e) => e);
    expect(failed).toMatchObject({ code: 'request_failed', status: 400, message: 'No token' });
    expect(failed.cause).toBe(cause);
    expect(calls).toEqual([]);
  });

  test('the controls answer false instead of throwing when they cannot act', async () => {
    onPhase = defaultRoute(3);
    const task = upload(png(), { route: '/api/upload' });
    expect(task.pause()).toBe(false);
    expect(task.resume()).toBe(false);
    await settle();
    // A single PUT is never pausable: stopping it throws its bytes away rather than parking them.
    expect(task.snapshot().canPause).toBe(false);
    expect(task.pause()).toBe(false);
    expect(task.resume()).toBe(false);
    ManualXhr.pending[0]!.respond(200, { etag: '"x"' });
    await task.done;
    expect(task.cancel()).toBe(false);
    expect(task.pause()).toBe(false);
    expect(task.resume()).toBe(false);
  });

  test('subscribe unsubscribes, and snapshot is the same object while nothing changes', async () => {
    onPhase = defaultRoute(3);
    const task = upload(png(), { route: '/api/upload' });
    expect(task.done).toBe(task.done);
    let n = 0;
    const unsub = task.subscribe(() => n++);
    await settle();
    const before = n;
    ManualXhr.pending[0]!.progress(1);
    await tick();
    expect(n).toBeGreaterThan(before);
    const s = task.snapshot();
    expect(task.snapshot()).toBe(s);
    unsub();
    const after = n;
    ManualXhr.pending[0]!.progress(2);
    await tick();
    expect(n).toBe(after);
    expect(task.snapshot()).not.toBe(s);
    task.cancel();
    await settle();
  });

  test('no error message carries the completion token or a signed url', async () => {
    const token = 'tok-SECRET';
    const url = 'https://r2.test/put?X-Amz-Signature=DEADBEEF';
    onPhase = (body) => {
      if (body.phase === 'begin') return { completionToken: token, path: 'p', upload: { partSize: 5 * MIB, parts: [{ n: 1, url }] } };
      if (body.phase === 'parts') return { partSize: 5 * MIB, size: 3, parts: [{ n: 1, url }], landed: [] };
      throw new Error('unexpected phase');
    };
    const messages: string[] = [];
    for (const statuses of [[403, 403], [400]]) {
      calls = [];
      ManualXhr.reset();
      const task = upload(png(), { route: '/api/upload' });
      for (const s of statuses) {
        await settle();
        ManualXhr.pending[0]!.respond(s, {}, `<Error><Token>${token}</Token><Url>${url}</Url></Error>`);
      }
      messages.push((await task.done.catch((e) => e)).message);
    }
    expect(messages.length).toBe(2);
    for (const m of messages) {
      expect(m).not.toContain(token);
      expect(m).not.toContain('DEADBEEF');
    }
  });

  test('answers from servers of different protocols, as on a deploy, still make one upload', async () => {
    // begin and end can be answered by two releases: every mix of newer, none and garbage.
    for (const [atBegin, atEnd] of [[2, undefined], [undefined, 2], [2, 'x'], ['x', 1]]) {
      const from = calls.length;
      const route = defaultRoute(3);
      onPhase = (body) => {
        const out = route(body) as Record<string, unknown>;
        const advertised = body.phase === 'begin' ? atBegin : atEnd;
        return advertised === undefined ? out : { ...out, protocol: advertised };
      };
      const task = upload(png(), { route: '/api/upload' });
      await settle();
      ManualXhr.pending[0]!.respond(200, { etag: '"x"' });
      await expect(task.done).resolves.toMatchObject({ path: 'p' });
      expect(calls.slice(from).map((c) => c.phase)).toEqual(['begin', 'end']);
    }
  });

  test('cancel while queued rejects done with AbortError and never PUTs', async () => {
    let release!: () => void;
    onPhase = () => new Response(new ReadableStream({ start: (c) => (release = () => c.close()) }));
    const task = upload(png(), { route: '/api/upload' });
    await tick();
    expect(task.snapshot().status).toBe('queued');
    expect(task.cancel()).toBe(true);
    expect(task.cancel()).toBe(false);
    expect(task.snapshot().status).toBe('canceled');
    await expect(task.done).rejects.toMatchObject({ name: 'AbortError' });
    release();
    await settle();
    expect(ManualXhr.pending.length).toBe(0);
  });
});

describe('multipart', () => {
  const SIZE = 100 * MIB + 7;

  test('4 parts in flight, lazy batches of 16, etags to end, loaded retreats on failure', async () => {
    onPhase = defaultRoute(SIZE);
    const task = upload(big(SIZE), { route: '/api/upload/large' });
    await settle();
    expect(task.snapshot()).toMatchObject({ status: 'uploading', canPause: true, total: SIZE });
    expect(ManualXhr.pending.map((x) => x.url)).toEqual([1, 2, 3, 4].map((n) => `https://r2.test/part/${n}?g=0`));
    expect((ManualXhr.pending[0]!.body as Blob).size).toBe(5 * MIB);
    // A part url signs content-length and nothing else, so the browser sets no header of ours.
    expect(ManualXhr.pending[0]!.headers).toEqual({});
    ManualXhr.pending[0]!.progress(MIB);
    ManualXhr.pending[1]!.progress(MIB);
    expect(task.snapshot().loaded).toBe(2 * MIB);
    ManualXhr.pending[1]!.respond(500);
    await tick();
    expect(task.snapshot().loaded).toBe(MIB);
    await wake();
    let done = 0;
    while (done < 21) {
      const x = ManualXhr.pending[0];
      if (!x) {
        await settle();
        continue;
      }
      expect(ManualXhr.pending.length).toBeLessThanOrEqual(4);
      x.respond(200, { etag: `"e${new URL(x.url).pathname.split('/').pop()}"` });
      done++;
      await settle();
    }
    const blob = await task.done;
    const partsCalls = calls.filter((c) => c.phase === 'parts').map((c) => c.body.from);
    expect(partsCalls).toEqual([17]);
    expect(blob.size).toBe(SIZE);
    const sent = (blob.data as { parts: { n: number; etag: string }[] }).parts;
    expect(sent.length).toBe(21);
    expect(sent.find((p) => p.n === 21)!.etag).toBe('"e21"');
    expect(task.snapshot().percent).toBe(100);
  });

  test("a cut-off success for 'end' clears the pending record, so picking the file again starts over", async () => {
    const size = 17 * MIB;
    let ends = 0;
    const base = defaultRoute(size);
    onPhase = (body) => {
      if (body.phase !== 'end') return base(body);
      ends++;
      return new Response(new ReadableStream({ start: (c) => c.error(new TypeError('terminated')) }));
    };
    const file = big(size);
    const task = upload(file, { route: '/api/upload/large' });
    await settle();
    expect(memory.size).toBe(1);
    for (let done = 0; done < 4; ) {
      const x = ManualXhr.pending[0];
      if (!x) {
        await settle();
        continue;
      }
      x.respond(200, { etag: `"e${done}"` });
      done++;
      await settle();
    }
    await expect(task.done).rejects.toMatchObject({ code: 'request_failed', status: 502 });
    expect(task.retry()).toBe(false);
    expect(ends).toBe(1);
    expect(memory.size).toBe(0);
  });

  test('pause keeps the parts already sending, drops the idle ones, and never retreats loaded', async () => {
    onPhase = defaultRoute(SIZE);
    const task = upload(big(SIZE), { route: '/api/upload/large' });
    await settle();
    const loads: number[] = [];
    task.subscribe(() => loads.push(task.snapshot().loaded));
    const [a, b, idle1, idle2] = [...ManualXhr.pending];
    a!.progress(MIB);
    b!.progress(2 * MIB);
    await tick();
    expect(task.snapshot().loaded).toBe(3 * MIB);

    expect(task.pause()).toBe(true);
    // Bytes on the wire are paid for either way, so only the two that sent nothing are dropped.
    expect([a!.aborted, b!.aborted, idle1!.aborted, idle2!.aborted]).toEqual([false, false, true, true]);
    await tick();
    expect(task.snapshot()).toMatchObject({ status: 'paused', loaded: 3 * MIB });
    a!.respond(200, { etag: '"e1"' });
    b!.respond(200, { etag: '"e2"' });
    await settle();
    expect(task.snapshot()).toMatchObject({ status: 'paused', loaded: 10 * MIB });
    // Nothing new starts while paused.
    expect(ManualXhr.pending.length).toBe(0);

    expect(task.resume()).toBe(true);
    expect(task.resume()).toBe(false);
    await settle();
    expect(task.snapshot().status).toBe('uploading');
    // The two that landed are never re-sent; the two that were dropped come back.
    expect(ManualXhr.pending.map((x) => new URL(x.url).pathname).sort()).toEqual(['/part/3', '/part/4', '/part/5', '/part/6']);
    const paths = ManualXhr.sentUrls.map((u) => new URL(u).pathname);
    expect(paths.filter((p) => p === '/part/1')).toEqual(['/part/1']);
    expect(paths.filter((p) => p === '/part/2')).toEqual(['/part/2']);
    for (let i = 1; i < loads.length; i++) expect(loads[i]!).toBeGreaterThanOrEqual(loads[i - 1]!);

    expect(task.cancel()).toBe(true);
    await expect(task.done).rejects.toMatchObject({ name: 'AbortError' });
    await settle();
    expect(calls.at(-1)!.body).toEqual({ phase: 'cancel', completionToken: 'tok' });
    expect(memory.size).toBe(0);
    expect(task.resume()).toBe(false);
  });

  test('a part that fails while paused is handed back to the queue instead of retrying', async () => {
    onPhase = defaultRoute(SIZE);
    const task = upload(big(SIZE), { route: '/api/upload/large' });
    await settle();
    const sending = ManualXhr.pending[0]!;
    sending.progress(MIB);
    await tick();
    expect(task.pause()).toBe(true);
    sending.respond(503);
    await settle();
    // Nothing is on the wire any more, so the part waits for resume rather than backing off.
    expect(task.snapshot()).toMatchObject({ status: 'paused', stalled: false, loaded: 0 });
    expect(sleeps).toEqual([]);
    expect(ManualXhr.pending.length).toBe(0);
    expect(task.resume()).toBe(true);
    await settle();
    expect(ManualXhr.pending.length).toBe(4);
    task.cancel();
    await settle();
  });

  test('retry() runs a failed upload again from the parts that landed', async () => {
    const landed: { n: number; etag: string }[] = [];
    onPhase = defaultRoute(SIZE, landed);
    const task = upload(big(SIZE), { route: '/api/upload/large' });
    await settle();
    ManualXhr.pending[0]!.respond(200, { etag: '"e1"' });
    await settle();
    landed.push({ n: 1, etag: '"e1"' });
    ManualXhr.pending[0]!.respond(400);
    await settle();
    expect(task.snapshot().status).toBe('error');
    const failed = await task.done.catch((e) => e);
    expect(failed.code).toBe('request_failed');
    // The multipart still exists server-side: the token is not spent and the record is kept.
    expect(calls.some((c) => c.phase === 'cancel')).toBe(false);
    expect(memory.size).toBe(1);

    expect(task.retry()).toBe(true);
    expect(task.retry()).toBe(false);
    await settle();
    expect(task.snapshot().status).toBe('uploading');
    expect(calls.filter((c) => c.phase === 'begin').length).toBe(1);
    expect(calls.filter((c) => c.phase === 'parts').map((c) => c.body.from)).toEqual([2]);
    let done = 0;
    while (done < 20) {
      const x = ManualXhr.pending[0];
      if (!x) {
        await settle();
        continue;
      }
      x.respond(200, { etag: `"e${new URL(x.url).pathname.split('/').pop()}"` });
      done++;
      await settle();
    }
    const blob = await task.done;
    expect((blob.data as { parts: { n: number }[] }).parts.length).toBe(21);
    const paths = ManualXhr.sentUrls.map((u) => new URL(u).pathname);
    expect(paths.filter((p) => p === '/part/1')).toEqual(['/part/1']);
    expect(task.snapshot().status).toBe('done');
    expect(memory.size).toBe(0);
  });

  test('a terminal error leaves the pending record, so picking the same file again resumes', async () => {
    const file = big(SIZE);
    onPhase = defaultRoute(SIZE, [{ n: 1, etag: '"e1"' }]);
    const task = upload(file, { route: '/api/upload/large' });
    await settle();
    ManualXhr.pending[0]!.respond(400);
    await settle();
    expect(task.snapshot().status).toBe('error');
    calls = [];
    ManualXhr.reset();
    const again = upload(file, { route: '/api/upload/large' });
    await settle();
    expect(calls.map((c) => c.phase)).toEqual(['parts']);
    expect(again.snapshot().loaded).toBe(5 * MIB);
    again.cancel();
    await settle();
  });

  test('resumes by fingerprint: no begin, landed parts skipped, server list trusted', async () => {
    const file = big(SIZE);
    onPhase = defaultRoute(SIZE, [
      { n: 1, etag: '"e1"' },
      { n: 3, etag: '"e3"' },
    ]);
    memory.set(`upstash-blob:v1:/api/upload/large|big.bin|${SIZE}|2`, JSON.stringify({ completionToken: 'old' }));
    const task = upload(file, { route: '/api/upload/large' });
    await settle();
    expect(calls.map((c) => c.phase)).toEqual(['parts']);
    expect(calls[0]!.body).toEqual({ phase: 'parts', completionToken: 'old', from: 1 });
    expect(task.snapshot().loaded).toBe(10 * MIB);
    expect(ManualXhr.pending.map((x) => new URL(x.url).pathname)).toEqual(['/part/2', '/part/4', '/part/5', '/part/6']);
    task.cancel();
    await settle();
  });

  test('a stale record falls back to a fresh begin', async () => {
    memory.set(`upstash-blob:v1:/api/upload/large|big.bin|${SIZE}|2`, JSON.stringify({ completionToken: 'gone' }));
    onPhase = (body) => (body.phase === 'parts' && body.completionToken === 'gone' ? Response.json({ code: 'not_found' }, { status: 404 }) : defaultRoute(SIZE)(body));
    const task = upload(big(SIZE), { route: '/api/upload/large' });
    await settle();
    expect(calls.map((c) => c.phase)).toEqual(['parts', 'begin']);
    // The token is the whole record: nothing else about the upload is worth keeping in localStorage.
    expect(memory.get(`upstash-blob:v1:/api/upload/large|big.bin|${SIZE}|2`)).toBe(JSON.stringify({ completionToken: 'tok' }));
    task.cancel();
    await settle();
  });

  test('a resume lookup that fails is retried, not restarted from zero', async () => {
    const key = `upstash-blob:v1:/api/upload/large|big.bin|${SIZE}|2`;
    memory.set(key, JSON.stringify({ completionToken: 'old-1' }));
    const route = defaultRoute(SIZE, [
      { n: 1, etag: '"e1"' },
      { n: 3, etag: '"e3"' },
    ]);
    let failures = 2;
    onPhase = (body) => {
      if (body.phase === 'parts' && failures-- > 0) {
        if (failures === 1) return new Response('unavailable', { status: 503 });
        throw new TypeError('network down');
      }
      return route(body);
    };
    const task = upload(big(SIZE), { route: '/api/upload/large' });
    await wake();
    await wake();
    expect(calls.map((c) => c.phase)).toEqual(['parts', 'parts', 'parts']);
    expect(calls.every((c) => c.body.completionToken === 'old-1')).toBe(true);
    expect(task.snapshot().loaded).toBe(10 * MIB);
    expect(ManualXhr.pending.map((x) => new URL(x.url).pathname)).toEqual(['/part/2', '/part/4', '/part/5', '/part/6']);
    expect(memory.get(key)).toBe(JSON.stringify({ completionToken: 'old-1' }));
    task.cancel();
    await settle();
  });

  test('a resume lookup that never answers fails the task, keeps the record, and retry() resumes', async () => {
    const key = `upstash-blob:v1:/api/upload/large|big.bin|${SIZE}|2`;
    memory.set(key, JSON.stringify({ completionToken: 'old-2' }));
    const route = defaultRoute(SIZE, [{ n: 1, etag: '"e1"' }]);
    let down = true;
    onPhase = (body) => (body.phase === 'parts' && down ? new Response('unavailable', { status: 503 }) : route(body));
    const task = upload(big(SIZE), { route: '/api/upload/large' });
    await wake();
    await wake();
    expect(task.snapshot().status).toBe('error');
    expect(calls.map((c) => c.phase)).toEqual(['parts', 'parts', 'parts']);
    expect(memory.get(key)).toBe(JSON.stringify({ completionToken: 'old-2', misses: 1 }));
    down = false;
    calls = [];
    expect(task.retry()).toBe(true);
    await settle();
    expect(calls.map((c) => c.phase)).toEqual(['parts']);
    expect(task.snapshot().loaded).toBe(5 * MIB);
    expect(memory.get(key)).toBe(JSON.stringify({ completionToken: 'old-2' }));
    task.cancel();
    await settle();
  });

  test('a resume lookup that keeps getting no usable answer is given up on after three tries', async () => {
    const key = `upstash-blob:v1:/api/upload/large|big.bin|${SIZE}|2`;
    memory.set(key, JSON.stringify({ completionToken: 'old-3' }));
    // A route that rewrites every error, and a 2xx that is not an answer (a login page), look alike.
    const answers = [Response.json({ error: 'nope' }, { status: 400 }), new Response('<html>', { status: 200 }), Response.json({ error: 'nope' }, { status: 400 })];
    const route = defaultRoute(SIZE);
    onPhase = (body) => (body.phase === 'parts' ? answers.shift()! : route(body));
    for (const misses of [1, 2]) {
      const task = upload(big(SIZE), { route: '/api/upload/large' });
      await settle();
      expect(task.snapshot().status).toBe('error');
      expect(memory.get(key)).toBe(JSON.stringify({ completionToken: 'old-3', misses }));
    }
    calls = [];
    const task = upload(big(SIZE), { route: '/api/upload/large' });
    await settle();
    expect(calls.map((c) => c.phase)).toEqual(['parts', 'begin']);
    expect(memory.get(key)).toBe(JSON.stringify({ completionToken: 'tok' }));
    task.cancel();
    await settle();
  });

  test('retry() on a task whose resume lookup failed is refused once a re-pick resumed that upload', async () => {
    const key = `upstash-blob:v1:/api/upload/large|big.bin|${SIZE}|2`;
    memory.set(key, JSON.stringify({ completionToken: 'old-5' }));
    const route = defaultRoute(SIZE, [{ n: 1, etag: '"e1"' }]);
    let down = true;
    onPhase = (body) => (body.phase === 'parts' && down ? new Response('unavailable', { status: 503 }) : route(body));
    const file = big(SIZE);
    const first = upload(file, { route: '/api/upload/large' });
    await wake();
    await wake();
    expect(first.snapshot().status).toBe('error');
    down = false;
    calls = [];
    const again = upload(file, { route: '/api/upload/large' });
    await settle();
    expect(calls.map((c) => [c.phase, c.body.completionToken])).toEqual([['parts', 'old-5']]);
    // The re-pick carries on the upload, so retrying the failed task must not begin a second one.
    calls = [];
    expect(first.retry()).toBe(false);
    await settle();
    expect(calls.filter((c) => c.phase === 'begin')).toEqual([]);
    again.cancel();
    await settle();
  });

  test("a failing resume lookup never writes over the record of a later pick's fresh upload", async () => {
    const key = `upstash-blob:v1:/api/upload/large|big.bin|${SIZE}|2`;
    memory.set(key, JSON.stringify({ completionToken: 'old-6' }));
    let n = 0;
    const base = defaultRoute(SIZE);
    onPhase = (body) => {
      if (body.phase === 'parts' && body.completionToken === 'old-6') return new Response('unavailable', { status: 503 });
      return body.phase === 'begin' ? { ...multipartBegin(SIZE), completionToken: `new-${++n}` } : base(body);
    };
    const file = big(SIZE);
    const first = upload(file, { route: '/api/upload/large' });
    await settle();
    // Its lookup is waiting out a backoff, so the old upload is still claimed: this pick begins fresh.
    const second = upload(file, { route: '/api/upload/large' });
    await settle();
    expect(memory.get(key)).toBe(JSON.stringify({ completionToken: 'new-1' }));
    await wake();
    await wake();
    expect(first.snapshot().status).toBe('error');
    expect(memory.get(key)).toBe(JSON.stringify({ completionToken: 'new-1' }));
    second.cancel();
    await settle();
  });

  test('an expired token or a different size falls back to a fresh begin', async () => {
    const key = `upstash-blob:v1:/api/upload/large|big.bin|${SIZE}|2`;
    for (const answer of [Response.json({ code: 'forbidden', error: 'completionToken has expired' }, { status: 403 }), Response.json({ partSize: 5 * MIB, size: SIZE + 1, multipart: true, parts: [], landed: [] })]) {
      memory.set(key, JSON.stringify({ completionToken: 'old-4' }));
      calls = [];
      const route = defaultRoute(SIZE);
      onPhase = (body) => (body.phase === 'parts' && body.completionToken === 'old-4' ? answer : route(body));
      const task = upload(big(SIZE), { route: '/api/upload/large' });
      await settle();
      expect(calls.map((c) => c.phase)).toEqual(['parts', 'begin']);
      expect(memory.get(key)).toBe(JSON.stringify({ completionToken: 'tok' }));
      task.cancel();
      await settle();
    }
  });

  test('a record under another fingerprint is left alone: a fresh upload, never an error', async () => {
    onPhase = defaultRoute(SIZE);
    const other = `upstash-blob:v1:/api/upload/large|big.bin|${SIZE}|999`;
    memory.set(other, JSON.stringify({ completionToken: 'other' }));
    const task = upload(big(SIZE), { route: '/api/upload/large' });
    await settle();
    expect(calls.map((c) => c.phase)).toEqual(['begin']);
    expect(memory.get(other)).toBe(JSON.stringify({ completionToken: 'other' }));
    task.cancel();
    await settle();
  });

  test('a record is resumed only by a pick with the same input, whatever its key order', async () => {
    let n = 0;
    const base = defaultRoute(SIZE);
    onPhase = (body) => (body.phase === 'begin' ? { ...multipartBegin(SIZE), completionToken: `tok-${++n}` } : base(body));
    const file = big(SIZE);
    const first = upload(file, { route: '/api/upload/large', input: { thread: 'A', kind: 'doc' } });
    await settle();
    // Failed, so nothing in the page holds its upload any more, as after a reload.
    ManualXhr.pending[0]!.respond(400);
    await settle();
    expect(first.snapshot().status).toBe('error');
    calls = [];
    ManualXhr.reset();
    const other = upload(file, { route: '/api/upload/large', input: { thread: 'B', kind: 'doc' } });
    await settle();
    expect(calls.map((c) => c.phase)).toEqual(['begin']);
    expect(calls[0]!.body.input).toEqual({ thread: 'B', kind: 'doc' });
    other.cancel();
    await settle();
    calls = [];
    ManualXhr.reset();
    const same = upload(file, { route: '/api/upload/large', input: { kind: 'doc', thread: 'A' } });
    await settle();
    expect(calls.map((c) => [c.phase, c.body.completionToken])).toEqual([['parts', 'tok-1']]);
    same.cancel();
    await settle();
  });

  test('the same file picked twice in one page is two uploads: canceling one leaves the other', async () => {
    let n = 0;
    const base = defaultRoute(3);
    onPhase = (body) => (body.phase === 'begin' ? { ...singleBegin(3), completionToken: `tok-${++n}` } : base(body));
    const file = png();
    const first = upload(file, { route: '/api/upload/avatar' });
    await settle();
    const second = upload(file, { route: '/api/upload/avatar' });
    await settle();
    expect(calls.map((c) => [c.phase, c.body.completionToken])).toEqual([
      ['begin', undefined],
      ['begin', undefined],
    ]);
    ManualXhr.pending[0]!.respond(200, { etag: '"x"' });
    await settle();
    await first.done;
    // The first finishing leaves the second one's record, so a reload still resumes it.
    expect([...memory.values()]).toEqual([JSON.stringify({ completionToken: 'tok-2' })]);
    second.cancel();
    await settle();
    expect(calls.filter((c) => c.phase === 'cancel').map((c) => c.body.completionToken)).toEqual(['tok-2']);
    expect(memory.size).toBe(0);
  });

  test('a failed upload picked again moves to the new task, and retry() on the old one is refused', async () => {
    const file = big(SIZE);
    onPhase = defaultRoute(SIZE);
    const task = upload(file, { route: '/api/upload/large' });
    await settle();
    ManualXhr.pending[0]!.respond(400);
    await settle();
    expect(task.snapshot().status).toBe('error');
    const again = upload(file, { route: '/api/upload/large' });
    await settle();
    expect(calls.map((c) => c.phase)).toEqual(['begin', 'parts']);
    expect(task.retry()).toBe(false);
    again.cancel();
    await settle();
  });

  test('a duplicate picked before the first one failed is still a second upload', async () => {
    let n = 0;
    const base = defaultRoute(SIZE);
    onPhase = (body) => (body.phase === 'begin' ? { ...multipartBegin(SIZE), completionToken: `tok-${++n}` } : base(body));
    const file = big(SIZE);
    const first = upload(file, { route: '/api/upload/large' });
    await settle();
    // Queued, as useUpload does: picked now, started later.
    const second = createTask(file, { route: '/api/upload/large' }, false);
    ManualXhr.pending[0]!.respond(400);
    await settle();
    expect(first.snapshot().status).toBe('error');
    second.start();
    await settle();
    expect(calls.map((c) => [c.phase, c.body.completionToken])).toEqual([
      ['begin', undefined],
      ['begin', undefined],
    ]);
    expect(first.retry()).toBe(true);
    await settle();
    first.cancel();
    second.cancel();
    await settle();
    expect(calls.filter((c) => c.phase === 'cancel').map((c) => c.body.completionToken)).toEqual(['tok-1', 'tok-2']);
  });

  test('canceling a pick during its resume check leaves the failed upload to retry', async () => {
    onPhase = defaultRoute(SIZE);
    const file = big(SIZE);
    const first = upload(file, { route: '/api/upload/large' });
    await settle();
    ManualXhr.pending[0]!.respond(400);
    await settle();
    expect(first.snapshot().status).toBe('error');
    // A real fetch refuses an aborted signal; the stub has to be told to.
    const stub = globalThis.fetch;
    globalThis.fetch = (async (input: any, init?: RequestInit) => {
      if (init?.signal?.aborted) throw new DOMException('aborted', 'AbortError');
      return stub(input, init);
    }) as typeof fetch;
    try {
      const again = upload(file, { route: '/api/upload/large' });
      again.cancel();
      await settle();
    } finally {
      globalThis.fetch = stub;
    }
    expect(calls.map((c) => c.phase)).toEqual(['begin']);
    expect(memory.size).toBe(1);
    expect(first.retry()).toBe(true);
    await settle();
    expect(calls.map((c) => c.phase)).toEqual(['begin', 'parts']);
    first.cancel();
    await settle();
  });

  test('a cancel during begin still aborts the upload server-side and never PUTs', async () => {
    const route = defaultRoute(SIZE);
    const running: { task?: ReturnType<typeof upload> } = {};
    onPhase = (body) => {
      if (body.phase === 'begin') running.task!.cancel();
      return route(body);
    };
    const task = (running.task = upload(big(SIZE), { route: '/api/upload/large' }));
    await settle();
    expect(task.snapshot().status).toBe('canceled');
    expect(ManualXhr.pending.length).toBe(0);
    expect(calls.map((c) => c.phase)).toEqual(['begin', 'cancel']);
    expect(calls[1]!.body).toEqual({ phase: 'cancel', completionToken: 'tok' });
    expect(memory.size).toBe(0);
    await expect(task.done).rejects.toMatchObject({ name: 'AbortError' });
  });

  test('a 403 on a part re-presigns the batch once', async () => {
    onPhase = defaultRoute(SIZE);
    const task = upload(big(SIZE), { route: '/api/upload/large' });
    await settle();
    ManualXhr.pending[2]!.respond(403);
    await settle();
    expect(calls.filter((c) => c.phase === 'parts').map((c) => c.body.from)).toEqual([3]);
    expect(ManualXhr.pending.find((x) => x.url.includes('/part/3'))!.url).toContain('g=1');
    task.cancel();
    await settle();
  });

  test('resuming after a pause longer than a url lives renews the urls before sending', async () => {
    const realNow = clock.now;
    let t = 1_000_000;
    clock.now = () => t;
    let task: ReturnType<typeof upload> | undefined;
    try {
      const { route } = expiringRoute(SIZE);
      onPhase = route;
      task = upload(big(SIZE), { route: '/api/upload/large' });
      await settle();
      expect(task.pause()).toBe(true);
      await settle();
      t += 11 * 60_000;
      expect(task.resume()).toBe(true);
      await settle();
      expect(calls.filter((c) => c.phase === 'parts').map((c) => c.body.from)).toEqual([1]);
      expect(ManualXhr.pending.map((x) => new URL(x.url).searchParams.get('g'))).toEqual(['1', '1', '1', '1']);
      task.cancel();
      await settle();
    } finally {
      clock.now = realNow;
      task?.cancel();
      await settle();
    }
  });

  test('a part that waited out its url for a connection slot renews it before sending', async () => {
    const realNow = clock.now;
    let t = 1_000_000;
    clock.now = () => t;
    const tasks: ReturnType<typeof upload>[] = [];
    try {
      onPhase = expiringRoute(SIZE).route;
      tasks.push(upload(big(SIZE), { route: '/api/upload/large' }), upload(big(SIZE), { route: '/api/upload/large' }));
      await settle();
      expect(poolState()).toEqual({ active: 6, waiting: 2 });
      t += 11 * 60_000;
      ManualXhr.pending[0]!.respond(200, { etag: '"e"' });
      await settle();
      const after = ManualXhr.sentUrls.slice(6);
      expect(after.length).toBeGreaterThan(0);
      expect(after.filter((u) => u.includes('g=0'))).toEqual([]);
    } finally {
      clock.now = realNow;
      for (const task of tasks) task.cancel();
      await settle();
    }
  });

  test('on a link slower than a batch of urls lives, the later parts get fresh urls', async () => {
    const realNow = clock.now;
    let t = 1_000_000;
    clock.now = () => t;
    let task: ReturnType<typeof upload> | undefined;
    try {
      const { route, storage } = expiringRoute(SIZE);
      onPhase = route;
      task = upload(big(SIZE), { route: '/api/upload/large' });
      await settle();
      // Each part takes 40s to land, so part 16 of the first batch starts past the ten minutes.
      await drive(task, (x) => storage(x, () => (t += 40_000)));
      const blob = await task.done;
      expect((blob.data as { parts: unknown[] }).parts.length).toBe(21);
      // One renewal covers the rest of the file: only the part that outlived its url is sent twice.
      expect(calls.filter((c) => c.phase === 'parts').map((c) => c.body.from)).toEqual([16]);
      expect(ManualXhr.sentUrls.length).toBe(22);
    } finally {
      clock.now = realNow;
      task?.cancel();
      await settle();
    }
  });

  test('the global cap of 6 holds across tasks', async () => {
    onPhase = defaultRoute(SIZE);
    const a = upload(big(SIZE), { route: '/api/upload/large' });
    const b = upload(big(SIZE), { route: '/api/upload/large' });
    await settle();
    expect(ManualXhr.pending.length).toBe(GLOBAL_REQUEST_CAP);
    expect(poolState()).toEqual({ active: 6, waiting: 2 });
    ManualXhr.pending[0]!.respond(200, { etag: '"e"' });
    await settle();
    expect(ManualXhr.pending.length).toBe(6);
    a.cancel();
    b.cancel();
    await settle();
    expect(poolState()).toEqual({ active: 0, waiting: 0 });
  });
});

describe('retry policy', () => {
  test('classify', () => {
    for (const s of [0, 408, 429, 500, 502, 503, 504]) expect(classify(s)).toBe('retry');
    for (const s of [401, 403]) expect(classify(s)).toBe('represign');
    for (const s of [400, 404, 411, 413]) expect(classify(s)).toBe('fail');
  });
  test('backoff is full jitter capped at 15s, Retry-After wins', () => {
    clock.random = () => 1;
    expect(backoffMs(0)).toBe(500);
    expect(backoffMs(3)).toBe(4000);
    expect(backoffMs(7)).toBe(15_000);
    clock.random = () => 0;
    expect(backoffMs(5)).toBe(0);
    expect(backoffMs(0, '2')).toBe(2000);
    clock.random = () => 0.5;
  });
});
