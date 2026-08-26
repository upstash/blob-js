import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { BlobError } from '../../src/shared/errors.ts';
import { upload } from '../../src/browser/index.ts';
import { clock } from '../../src/browser/clock.ts';
import { poolState, GLOBAL_REQUEST_CAP } from '../../src/browser/pool.ts';
import { backoffMs, classify } from '../../src/browser/retry.ts';
import { flush, installXhr, ManualXhr } from '../helpers/xhr.ts';

const MIB = 1024 * 1024;
const memory = new Map<string, string>();
const sleeps: number[] = [];
let timers: { ms: number; cb: () => void }[] = [];
let wakers: (() => void)[] = [];
let calls: { phase: string; body: any }[] = [];
let onPhase: (body: any) => unknown | Response;
const restore: (() => void)[] = [];

const BLOB = { path: 'p', url: 'https://h/p', versionedUrl: 'https://h/p?v=%22x%22', size: 3, etag: '"x"', uploadedAt: '2026-08-24T00:00:00.000Z' };

// Every direct upload is multipart, one part when the file fits one, so there is only one shape.
function multipartBegin(size: number, partSize = 5 * MIB) {
  return { completionToken: 'tok', path: 'p', upload: { partSize, parts: partUrls(1, size, partSize) } };
}

function partUrls(from: number, size: number, partSize: number, gen = 0) {
  const count = Math.ceil(size / partSize);
  const out = [];
  for (let n = from; n < from + 16 && n <= count; n++) out.push({ n, url: `https://r2.test/part/${n}?g=${gen}` });
  return out;
}

function defaultRoute(size: number, landed: { n: number; etag: string }[] = []) {
  let gen = 0;
  return (body: any) => {
    if (body.phase === 'begin') return multipartBegin(size);
    if (body.phase === 'parts') {
      gen++;
      return { partSize: 5 * MIB, size, parts: partUrls(body.from, size, 5 * MIB, gen), landed };
    }
    if (body.phase === 'end') return { blob: { ...BLOB, size }, data: { rowId: '1', parts: body.parts } };
    if (body.phase === 'cancel') return { ok: true };
    throw new Error('unexpected phase');
  };
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
    calls.push({ phase: body.phase, body });
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

describe('one part', () => {
  test('begin, PUT the one part, progress, end, done with typed data', async () => {
    onPhase = defaultRoute(3);
    const task = upload(png(), { route: '/api/upload', headers: () => ({ authorization: 'Bearer j' }), input: { threadId: 't' } });
    // A three-byte file is a multipart of one part, so it pauses and resumes like any other upload.
    expect(task.snapshot()).toMatchObject({ status: 'queued', loaded: 0, total: 3, percent: 0, canPause: true, stalled: false });
    const same = task.snapshot();
    expect(task.snapshot()).toBe(same);
    await settle();
    expect(calls[0]!.body).toEqual({ phase: 'begin', file: { name: 'a.png', type: 'image/png', size: 3 }, input: { threadId: 't' } });
    expect(ManualXhr.pending.length).toBe(1);
    const xhr = ManualXhr.pending[0]!;
    expect(xhr.method).toBe('PUT');
    expect(xhr.url).toBe('https://r2.test/part/1?g=0');
    // A part url signs content-length and nothing else: the type and the cache header were pinned
    // when the multipart was created, so the browser sends no headers of its own.
    expect(xhr.headers).toEqual({});
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
    expect(ManualXhr.pending[0]!.url).toBe('https://r2.test/part/1?g=1');
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

  test('the controls answer false instead of throwing when they cannot act', async () => {
    onPhase = defaultRoute(3);
    const task = upload(png(), { route: '/api/upload' });
    // Queued: pause has nothing on the wire to hold back yet, though the upload is pausable.
    expect(task.pause()).toBe(false);
    expect(task.resume()).toBe(false);
    await settle();
    expect(task.snapshot().canPause).toBe(true);
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
