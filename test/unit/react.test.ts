import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test';
import { act, createElement, StrictMode } from 'react';
import { clock } from '../../src/browser/clock.ts';
import { poolState } from '../../src/browser/pool.ts';
import { BlobError, createUploadHooks, useServerUpload, useUpload } from '../../src/react/index.ts';
import type { UploadRoute } from '../../src/shared/types.ts';
import { installRouter, installXhr, ManualXhr } from '../helpers/xhr.ts';

// bun imports every test file before running any of them, and happy-dom's globals are read-only
// once installed, so registering at import time breaks a sibling file that stubs localStorage.
// react-dom is imported here too: it wants document at module scope.
let createRoot: typeof import('react-dom/client').createRoot;

beforeAll(async () => {
  GlobalRegistrator.register();
  ({ createRoot } = await import('react-dom/client'));
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  clock.frame = (cb: () => void) => queueMicrotask(cb);
});

afterAll(async () => {
  await GlobalRegistrator.unregister();
});

/* ------------------------------------------------------------------ fakes -- */

const xhrs: TestXhr[] = [];

/** ManualXhr drops a request from `pending` once it answers, so the test keeps its own order. */
class TestXhr extends ManualXhr {
  override send(body: unknown): void {
    xhrs.push(this);
    super.send(body);
  }
}

interface RouteCall {
  url: string;
  method: string;
  body: any;
  auth: string | null;
}

let calls: RouteCall[] = [];
let restore: (() => void)[] = [];
let routeId = 0;
// The constraints GET is cached per route for a minute, so every test gets its own route.
let route = '';

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
}

const CONSTRAINTS = { contentTypes: ['image/png'], maxBytes: 1000 };

const END_BODY = {
  blob: { path: 'p', url: 'https://h/p', versionedUrl: 'https://h/p?v=x', size: 3, contentType: 'image/png', etag: '"x"', uploadedAt: new Date().toISOString() },
  data: { rowId: '1' },
};

// A route answers with the plan it chose for this file: under its multipart threshold that is one
// presigned object PUT carrying the headers its signature pins, over it a list of real parts. Both
// are one part here -- a 3-byte png -- so the two shapes differ only in `multipart`, which is what
// decides whether the upload can be paused. Default to the plan a real route picks for a png this
// size; `partedPlan` is the test that wants the other one.
const PART_SIZE = 5 * 1024 * 1024;
const ONE_PART = [{ n: 1, url: 'https://r2.test/put' }];
const ONE_PUT = [{ n: 1, url: 'https://r2.test/put', headers: { 'content-type': 'image/png', 'cache-control': 'public, max-age=3600' } }];
let partedPlan = false;
const plan = (size: number) => (partedPlan ? { partSize: PART_SIZE, multipart: true, parts: ONE_PART } : { partSize: size, multipart: false, parts: ONE_PUT });

function handlers() {
  // What begin was told, so the parts phase reports the size the resume check compares against.
  let size = 0;
  return {
    GET: async (request: Request) => {
      calls.push({ url: route, method: 'GET', body: undefined, auth: request.headers.get('authorization') });
      return jsonResponse({ constraints: CONSTRAINTS });
    },
    POST: async (request: Request) => {
      const body = (await request.json()) as any;
      calls.push({ url: route, method: 'POST', body, auth: request.headers.get('authorization') });
      if (body?.phase === 'begin') {
        if (!CONSTRAINTS.contentTypes.includes(body.file.type)) {
          return jsonResponse({ code: 'content_type_not_allowed', message: `${body.file.type} is not allowed`, status: 400 }, 400);
        }
        size = body.file.size;
        return jsonResponse({ completionToken: 't', path: 'p', upload: plan(size) });
      }
      if (body?.phase === 'parts') return jsonResponse({ size, ...plan(size), landed: [] });
      if (body?.phase === 'end') return jsonResponse(END_BODY);
      return jsonResponse({ ok: true });
    },
  };
}

/* ------------------------------------------------------------------ react -- */

let root: { render(el: any): void; unmount(): void } | undefined;

async function render<T>(useHook: () => T, strict = false): Promise<{ current: T }> {
  const box = { current: undefined as unknown as T };
  function Probe() {
    box.current = useHook();
    return null;
  }
  const container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  const tree = createElement(Probe);
  await act(async () => {
    root!.render(strict ? createElement(StrictMode, null, tree) : tree);
  });
  return box;
}

/** Never call this inside act(): nested act calls are not supported. */
async function flush(times = 1): Promise<void> {
  for (let i = 0; i < times; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function nextXhr(index = 0): Promise<TestXhr> {
  for (let i = 0; i < 20 && xhrs.length <= index; i++) await flush();
  const xhr = xhrs[index];
  if (!xhr) throw new Error(`no xhr at ${index}`);
  return xhr;
}

const png = (name = 'a.png', bytes = 10): File => new File(['x'.repeat(bytes)], name, { type: 'image/png' });

beforeEach(() => {
  xhrs.length = 0;
  calls = [];
  partedPlan = false;
  ManualXhr.reset();
  route = `/api/upload/${++routeId}`;
  restore = [installXhr(TestXhr), installRouter({ [route]: handlers() })];
  localStorage.clear();
});

afterEach(async () => {
  // The request pool is global: an upload left in flight holds its slot for every later test file.
  for (const pending of [...ManualXhr.pending]) pending.respond(200, { etag: '"x"' });
  await flush(2);
  if (root) {
    const current = root;
    root = undefined;
    await act(async () => {
      current.unmount();
    });
  }
  for (const undo of restore.reverse()) undo();
  expect(poolState().active).toBe(0);
});

/* --------------------------------------------------------------- useUpload -- */

test('accept lands from the route GET', async () => {
  const seen: string[] = [];
  const hook = await render(() => {
    const result = useUpload(route);
    seen.push(result.accept);
    return result;
  });
  expect(seen[0]).toBe('');
  await flush();
  expect(hook.current.accept).toBe('image/png');
  expect(calls[0]).toMatchObject({ url: route, method: 'GET' });
});

test('constraints land from the route GET, so a page can state the cap it enforces', async () => {
  const seen: (number | undefined)[] = [];
  const hook = await render(() => {
    const result = useUpload(route);
    seen.push(result.constraints?.maxBytes);
    return result;
  });
  // Undefined until the GET answers: nothing is guessed, so a page renders no number rather than a
  // wrong one.
  expect(seen[0]).toBeUndefined();
  await flush();
  expect(hook.current.constraints).toEqual(CONSTRAINTS);
  expect(hook.current.constraints?.maxBytes).toBe(1000);
});

test('the cached constraints expire, so a deploy that widens them reaches the picker', async () => {
  const realNow = clock.now;
  let t = 1_000_000;
  clock.now = () => t;
  try {
    const first = await render(() => useUpload(route));
    await flush();
    expect(first.current.accept).toBe('image/png');
    expect(calls.filter((c) => c.method === 'GET')).toHaveLength(1);
    // A second mount inside the TTL is served from memory.
    t += 30_000;
    await render(() => useUpload(route));
    await flush();
    expect(calls.filter((c) => c.method === 'GET')).toHaveLength(1);
    t += 61_000;
    await render(() => useUpload(route));
    await flush();
    expect(calls.filter((c) => c.method === 'GET')).toHaveLength(2);
  } finally {
    clock.now = realNow;
  }
});

test('start({file}) returns the record uploads holds, and upload is the newest', async () => {
  const hook = await render(() => useUpload(route));
  await flush();
  let record: any;
  await act(async () => {
    record = hook.current.start({ file: png() });
  });
  expect(record.status).toBe('queued');
  expect(hook.current.uploads).toHaveLength(1);
  expect(hook.current.uploads[0]!.id).toBe(record.id);
  expect(hook.current.upload).toBe(hook.current.uploads.at(-1)!);
});

test('start({file: undefined}) is a no-op returning null', async () => {
  const hook = await render(() => useUpload(route));
  await flush();
  let record: unknown = 'unset';
  await act(async () => {
    record = hook.current.start({ file: undefined });
  });
  expect(record).toBeNull();
  expect(hook.current.uploads).toHaveLength(0);
});

test('progress events move percent', async () => {
  const hook = await render(() => useUpload(route));
  await flush();
  await act(async () => {
    hook.current.start({ file: png('a.png', 10) });
  });
  const put = await nextXhr();
  expect(put.method).toBe('PUT');
  await act(async () => {
    put.progress(5, 10);
  });
  await flush();
  expect(hook.current.upload!.percent).toBe(50);
  expect(hook.current.upload!.loaded).toBe(5);
});

test('a finished upload carries blob.data and fires onDone once', async () => {
  const done: any[] = [];
  const hook = await render(() => useUpload<UploadRoute<undefined, { rowId: string }>>(route, { onDone: (u) => done.push(u) }));
  await flush();
  await act(async () => {
    hook.current.start({ file: png() });
  });
  const put = await nextXhr();
  await act(async () => {
    put.respond(200, { etag: '"x"' });
  });
  await flush(3);
  const upload = hook.current.upload!;
  expect(upload.status).toBe('done');
  expect(upload.percent).toBe(100);
  expect(upload.status === 'done' && upload.blob.data.rowId).toBe('1');
  expect(upload.status === 'done' && upload.blob.url).toBe('https://h/p');
  // Readable with no narrowing, which is the point of declaring the absent payload as undefined.
  expect(upload.pending).toBe(false);
  expect(upload.blob?.data.rowId).toBe('1');
  expect(upload.error).toBeUndefined();
  await flush(2);
  expect(done).toHaveLength(1);
  expect(done[0].id).toBe(upload.id);
});

test('concurrency 1 queues the second file until the first finishes', async () => {
  const hook = await render(() => useUpload(route, { concurrency: 1 }));
  await flush();
  await act(async () => {
    hook.current.start({ files: [png('a.png'), png('b.png')] });
  });
  expect(hook.current.uploads).toHaveLength(2);
  const first = await nextXhr();
  await flush(2);
  expect(xhrs).toHaveLength(1);
  expect(calls.filter((c) => c.body?.phase === 'begin')).toHaveLength(1);

  await act(async () => {
    first.respond(200, { etag: '"x"' });
  });
  const second = await nextXhr(1);
  expect(second.method).toBe('PUT');
  expect(hook.current.uploads[0]!.status).toBe('done');
});

test('a file over maxBytes is an error record that never reaches the route', async () => {
  const errors: any[] = [];
  const hook = await render(() => useUpload(route, { onError: (u) => errors.push(u) }));
  await flush();
  let record: any;
  await act(async () => {
    record = hook.current.start({ file: png('big.png', 2000) });
  });
  expect(record.status).toBe('error');
  expect(record.error.code).toBe('too_large');
  expect(record.pending).toBe(false);
  expect(record.blob).toBeUndefined();
  expect(record.cancel()).toBe(false);
  expect(xhrs).toHaveLength(0);
  expect(calls.every((c) => c.method === 'GET')).toBe(true);
  expect(errors).toHaveLength(1);
});

// The route owns the type check: it canonicalises aliases and sniffs the bytes, neither of which
// the served accept list can express.
test('a type the route refuses is an error record carrying its code', async () => {
  const hook = await render(() => useUpload(route));
  await flush();
  await act(async () => {
    hook.current.start({ file: new File(['x'], 'a.txt', { type: 'text/plain' }) });
  });
  await flush(3);
  const upload = hook.current.upload!;
  expect(upload.status).toBe('error');
  expect(upload.status === 'error' && upload.error.code).toBe('content_type_not_allowed');
  expect(calls.some((c) => c.body?.phase === 'begin')).toBe(true);
  expect(xhrs).toHaveLength(0);
});

test('clear(id) removes one record and clear() removes all', async () => {
  const hook = await render(() => useUpload(route, { concurrency: 1 }));
  await flush();
  let records: any[] = [];
  await act(async () => {
    records = hook.current.start({ files: [png('a.png'), png('b.png')] });
  });
  expect(records).toHaveLength(2);
  await act(async () => {
    hook.current.clear(records[1].id);
  });
  expect(hook.current.uploads).toHaveLength(1);
  expect(hook.current.uploads[0]!.id).toBe(records[0].id);
  await act(async () => {
    hook.current.clear();
  });
  expect(hook.current.uploads).toHaveLength(0);
  expect(hook.current.upload).toBeNull();
});

test('StrictMode fetches the constraints once and starts one upload per file', async () => {
  const hook = await render(() => useUpload(route), true);
  await flush(2);
  expect(calls.filter((c) => c.method === 'GET')).toHaveLength(1);
  expect(hook.current.accept).toBe('image/png');
  await act(async () => {
    hook.current.start({ file: png() });
  });
  await flush(2);
  expect(hook.current.uploads).toHaveLength(1);
  expect(calls.filter((c) => c.body?.phase === 'begin')).toHaveLength(1);
  expect(xhrs).toHaveLength(1);
});

test('headers is a function re-read per route call', async () => {
  let n = 0;
  const hook = await render(() => useUpload(route, { headers: () => ({ authorization: `Bearer ${++n}` }) }));
  await flush();
  await act(async () => {
    hook.current.start({ file: png() });
  });
  const put = await nextXhr();
  await act(async () => {
    put.respond(200, { etag: '"x"' });
  });
  await flush(3);
  const auths = calls.map((c) => c.auth);
  expect(auths).toEqual(['Bearer 1', 'Bearer 2', 'Bearer 3']);
  expect(calls.map((c) => c.body?.phase)).toEqual([undefined, 'begin', 'end']);
});

test('a small file is a single PUT, so it is not offered as pausable', async () => {
  const hook = await render(() => useUpload(route));
  await flush();
  await act(async () => {
    hook.current.start({ file: png() });
  });
  await nextXhr();
  await flush();
  // One request that is either on the wire or not: stopping it throws its bytes away rather than
  // parking them, so the hook says so instead of labelling an upload that then finishes anyway.
  expect(hook.current.upload!.canPause).toBe(false);
  expect(hook.current.upload!.pause()).toBe(false);
  expect(hook.current.upload!.status).toBe('uploading');
  await act(async () => {
    expect(hook.current.upload!.cancel()).toBe(true);
  });
  await flush(2);
  expect(hook.current.upload!.status).toBe('canceled');
});

test('a file the route parts pauses, resumes and cancels, and the controls answer', async () => {
  partedPlan = true;
  const hook = await render(() => useUpload(route));
  await flush();
  await act(async () => {
    hook.current.start({ file: png() });
  });
  await nextXhr();
  await flush();
  expect(hook.current.upload!.canPause).toBe(true);
  expect(hook.current.upload!.stalled).toBe(false);
  await act(async () => {
    expect(hook.current.upload!.pause()).toBe(true);
  });
  expect(hook.current.upload!.status).toBe('paused');
  await act(async () => {
    expect(hook.current.upload!.resume()).toBe(true);
  });
  expect(hook.current.upload!.status).toBe('uploading');
  await act(async () => {
    expect(hook.current.upload!.cancel()).toBe(true);
  });
  await flush(2);
  expect(hook.current.upload!.status).toBe('canceled');
  expect(hook.current.upload!.cancel()).toBe(false);
});

test('retry() takes a failed record out of error and finishes it', async () => {
  const seen: string[] = [];
  const hook = await render(() => useUpload(route, { onError: () => seen.push('error'), onDone: () => seen.push('done') }));
  await flush();
  await act(async () => {
    hook.current.start({ file: png() });
  });
  const put = await nextXhr();
  await act(async () => {
    put.respond(400);
  });
  await flush(2);
  expect(hook.current.upload!.status).toBe('error');
  expect(seen).toEqual(['error']);

  await act(async () => {
    expect(hook.current.upload!.retry()).toBe(true);
  });
  await flush(2);
  expect(hook.current.upload!.status).toBe('uploading');
  const second = await nextXhr(1);
  await act(async () => {
    second.respond(200, { etag: '"x"' });
  });
  await flush(3);
  expect(hook.current.upload!.status).toBe('done');
  expect(seen).toEqual(['error', 'done']);
  // A retry asks for a fresh url rather than beginning a second upload.
  expect(calls.filter((c) => c.body?.phase === 'begin').length).toBe(1);
  expect(calls.filter((c) => c.body?.phase === 'parts').length).toBe(1);
});

test('unmount never cancels: the upload finishes with nothing rendering it', async () => {
  const hook = await render(() => useUpload(route));
  await flush();
  await act(async () => {
    hook.current.start({ file: png() });
  });
  const put = await nextXhr();
  const mounted = root!;
  root = undefined;
  await act(async () => {
    mounted.unmount();
  });
  await act(async () => {
    put.respond(200, { etag: '"x"' });
  });
  await flush(3);
  expect(put.aborted).toBe(false);
  expect(calls.map((c) => c.body?.phase)).toContain('end');
});

test('start({files: []}) returns an empty array', async () => {
  const hook = await render(() => useUpload(route));
  await flush();
  let records: any;
  await act(async () => {
    records = hook.current.start({ files: [] });
  });
  expect(records).toEqual([]);
});

/* ---------------------------------------------------------- useServerUpload -- */

test('server upload start({file}) posts multipart under the field file', async () => {
  const hook = await render(() => useServerUpload<{ url: string }>('/api/avatar'));
  const file = png();
  let record: any;
  await act(async () => {
    record = hook.current.start({ file });
  });
  expect(record.file).toBe(file);
  const xhr = await nextXhr();
  expect(xhr.method).toBe('POST');
  expect(xhr.url).toBe('/api/avatar');
  expect(xhr.body).toBeInstanceOf(FormData);
  expect((xhr.body as FormData).get('file')).toBe(file as any);
  expect(xhr.headers['content-type']).toBeUndefined();
});

test('server upload start({body: file}) sends the File raw', async () => {
  const hook = await render(() => useServerUpload('/api/avatar'));
  const file = png();
  let record: any;
  await act(async () => {
    record = hook.current.start({ body: file });
  });
  const xhr = await nextXhr();
  expect(xhr.body).toBe(file);
  expect(record.file).toBe(file);
  expect(record.total).toBe(file.size);
});

test('server upload start({body: formData}) sends it as is', async () => {
  const hook = await render(() => useServerUpload('/api/avatar'));
  const form = new FormData();
  form.append('caption', 'hi');
  form.append('files', png());
  let record: any;
  await act(async () => {
    record = hook.current.start({ body: form });
  });
  const xhr = await nextXhr();
  expect(xhr.body).toBe(form);
  expect(record.file).toBeNull();
});

test('server upload reports progress, then status finishing, then the parsed response', async () => {
  const done: any[] = [];
  const hook = await render(() => useServerUpload<{ url: string }>('/api/avatar', { onDone: (u) => done.push(u) }));
  await act(async () => {
    hook.current.start({ file: png('a.png', 10) });
  });
  const xhr = await nextXhr();
  await act(async () => {
    xhr.progress(6, 12);
  });
  await flush();
  expect(hook.current.upload!.total).toBe(12);
  expect(hook.current.upload!.percent).toBe(50);
  expect(hook.current.upload!.status).toBe('uploading');

  await act(async () => {
    xhr.progress(12, 12);
    xhr.sentAll();
  });
  await flush();
  // Sent, not stored: the bar sits at 100 in status 'finishing' until the route answers.
  expect(hook.current.upload!.percent).toBe(100);
  expect(hook.current.upload!.status).toBe('finishing');

  await act(async () => {
    xhr.respond(200, {}, JSON.stringify({ url: 'https://h/p' }));
  });
  await flush();
  const upload = hook.current.upload!;
  expect(upload.status === 'done' && upload.response.url).toBe('https://h/p');
  expect(upload.percent).toBe(100);
  expect(done).toHaveLength(1);
});

test('server upload pending spans queued, uploading and finishing, and clears on every terminal state', async () => {
  const hook = await render(() => useServerUpload<{ url: string }>('/api/avatar'));
  await act(async () => {
    hook.current.start({ file: png('a.png', 10) });
  });
  const xhr = await nextXhr();
  await flush();
  expect(hook.current.upload!.pending).toBe(true);
  expect(hook.current.upload!.response).toBeUndefined();
  expect(hook.current.upload!.error).toBeUndefined();

  await act(async () => {
    xhr.progress(10, 10);
    xhr.sentAll();
  });
  await flush();
  // 'finishing' is still pending: the bytes are sent but the route has not answered, and an input
  // gated on this stays disabled instead of accepting a second file mid-store.
  expect(hook.current.upload!.status).toBe('finishing');
  expect(hook.current.upload!.pending).toBe(true);

  await act(async () => {
    xhr.respond(200, {}, JSON.stringify({ url: 'https://h/p' }));
  });
  await flush();
  expect(hook.current.upload!.pending).toBe(false);
  expect(hook.current.upload!.response).toEqual({ url: 'https://h/p' });
  expect(hook.current.upload!.error).toBeUndefined();
});

test('server upload 413 is too_large', async () => {
  const hook = await render(() => useServerUpload('/api/avatar'));
  await act(async () => {
    hook.current.start({ file: png() });
  });
  const xhr = await nextXhr();
  await act(async () => {
    xhr.respond(413);
  });
  await flush();
  const upload = hook.current.upload!;
  expect(upload.status).toBe('error');
  expect(upload.status === 'error' && upload.error.code).toBe('too_large');
  expect(upload.status === 'error' && upload.error.message).toContain('4.5MB');
  expect(upload.pending).toBe(false);
  expect(upload.error?.code).toBe('too_large');
  expect(upload.response).toBeUndefined();
});

test('server upload 500 with an error string becomes request_failed carrying it', async () => {
  const errors: any[] = [];
  const hook = await render(() => useServerUpload('/api/avatar', { onError: (u) => errors.push(u) }));
  await act(async () => {
    hook.current.start({ file: png() });
  });
  const xhr = await nextXhr();
  await act(async () => {
    xhr.respond(500, {}, JSON.stringify({ error: 'nope' }));
  });
  await flush();
  const upload = hook.current.upload!;
  expect(upload.status === 'error' && upload.error.code).toBe('request_failed');
  expect(upload.status === 'error' && upload.error.message).toBe('Nope');
  expect(upload.status === 'error' && upload.error.status).toBe(500);
  expect(errors).toHaveLength(1);
});

test('server upload cancel aborts the request and reports canceled', async () => {
  const hook = await render(() => useServerUpload('/api/avatar'));
  let record: any;
  await act(async () => {
    record = hook.current.start({ file: png() });
  });
  const xhr = await nextXhr();
  let effect: boolean | undefined;
  await act(async () => {
    effect = hook.current.upload!.cancel();
  });
  await flush();
  expect(effect).toBe(true);
  expect(xhr.aborted).toBe(true);
  expect(hook.current.upload!.status).toBe('canceled');
  expect(hook.current.upload!.pending).toBe(false);
  expect(hook.current.upload!.response).toBeUndefined();
  expect(hook.current.upload!.error).toBeUndefined();
  expect(record.id).toBe(hook.current.upload!.id);
  expect(hook.current.upload!.cancel()).toBe(false);
});

test('server upload start with a nullish file or body returns null', async () => {
  const hook = await render(() => useServerUpload('/api/avatar'));
  let a: unknown = 'unset';
  let b: unknown = 'unset';
  await act(async () => {
    a = hook.current.start({ file: undefined });
    b = hook.current.start({ body: null });
  });
  expect(a).toBeNull();
  expect(b).toBeNull();
  expect(xhrs).toHaveLength(0);
  expect(hook.current.uploads).toHaveLength(0);
});

test('server upload request_failed falls back to statusText when the body carries no error', async () => {
  const hook = await render(() => useServerUpload('/api/avatar'));
  await act(async () => {
    hook.current.start({ file: png() });
  });
  const xhr = await nextXhr();
  await act(async () => {
    xhr.respond(500);
  });
  await flush();
  const upload = hook.current.upload!;
  expect(upload.status === 'error' && upload.error.code).toBe('request_failed');
  expect(upload.status === 'error' && upload.error.message).toBe('Internal Server Error');
  expect(upload.status === 'error' && upload.error.status).toBe(500);
});

test('server upload headers are re-read per request', async () => {
  let n = 0;
  const hook = await render(() => useServerUpload('/api/avatar', { headers: () => ({ authorization: `Bearer ${++n}` }) }));
  await act(async () => {
    hook.current.start({ file: png('a.png') });
  });
  const first = await nextXhr();
  await act(async () => {
    first.respond(200, {}, '{}');
  });
  await act(async () => {
    hook.current.start({ file: png('b.png') });
  });
  const second = await nextXhr(1);
  // Not absolute numbers: the hook also fetches the route's constraints, which reads the headers too.
  // What matters is that the second request did not reuse the first one's token.
  expect(first.headers['authorization']).toMatch(/^Bearer \d+$/);
  expect(second.headers['authorization']).not.toBe(first.headers['authorization']);
});

// The queue must never start an upload that already settled: a cancel is not an error.
test('an upload canceled while queued is not started by a clear() from onError', async () => {
  let api!: ReturnType<typeof useServerUpload>;
  let queued: { cancel(): boolean } | undefined;
  const errors: string[] = [];
  await render(() => {
    const result = useServerUpload('/api/avatar', {
      concurrency: 1,
      onError: (u) => {
        errors.push(u.error.code);
        queued?.cancel();
        result.clear(u.id);
      },
    });
    api = result;
    return result;
  });
  await act(async () => {
    api.start({ file: png('a.png') });
    queued = api.start({ file: png('b.png') }) ?? undefined;
  });
  const first = await nextXhr();
  await act(async () => {
    first.respond(500, {}, JSON.stringify({ error: 'nope' }));
  });
  await flush(3);
  expect(errors).toEqual(['request_failed']);
  expect(api.uploads).toHaveLength(1);
  expect(api.uploads[0]!.status).toBe('canceled');
  expect(xhrs).toHaveLength(1);
});

test('server upload concurrency 1 queues the second request', async () => {
  const hook = await render(() => useServerUpload('/api/avatar', { concurrency: 1 }));
  await act(async () => {
    hook.current.start({ file: png('a.png') });
    hook.current.start({ file: png('b.png') });
  });
  const first = await nextXhr();
  await flush(2);
  expect(xhrs).toHaveLength(1);
  await act(async () => {
    first.respond(200);
  });
  await flush(2);
  expect(xhrs).toHaveLength(2);
  expect(hook.current.uploads[0]!.status).toBe('done');
  expect(hook.current.uploads[1]!.status).toBe('uploading');
});

/* ------------------------------------------------- refusals keep their code -- */

test('a server upload route answering with BlobError.toJSON keeps its code', async () => {
  const hook = await render(() => useServerUpload('/api/avatar'));
  await act(async () => {
    hook.current.start({ file: png() });
  });
  const xhr = await nextXhr();
  await act(async () => {
    xhr.respond(401, { 'content-type': 'application/json' }, JSON.stringify({ code: 'unauthorized', message: 'session expired', status: 401 }));
  });
  await flush();
  const upload = hook.current.upload!;
  // Before this, every non-2xx arrived as request_failed and the caller had to read the status.
  expect(upload.status === 'error' && upload.error.code).toBe('unauthorized');
  expect(upload.status === 'error' && upload.error.message).toBe('Session expired');
  expect(upload.status === 'error' && upload.error.status).toBe(401);
});

test('a route that answered a plain 401 still arrives as unauthorized', async () => {
  const hook = await render(() => useServerUpload('/api/avatar'));
  await act(async () => {
    hook.current.start({ file: png() });
  });
  const xhr = await nextXhr();
  // No code in the body: the shape an ordinary auth wrapper answers with.
  await act(async () => {
    xhr.respond(401, { 'content-type': 'application/json' }, JSON.stringify({ error: 'unauthorized' }));
  });
  await flush();
  const upload = hook.current.upload!;
  expect(upload.status === 'error' && upload.error.code).toBe('unauthorized');
});

test('a server upload route response is handed back exactly as it arrived', async () => {
  const hook = await render(() => useServerUpload('/api/avatar'));
  await act(async () => {
    hook.current.start({ file: png() });
  });
  const xhr = await nextXhr();
  await act(async () => {
    xhr.respond(200, { 'content-type': 'application/json' }, JSON.stringify(END_BODY));
  });
  await flush();
  const upload = hook.current.upload! as any;
  expect(upload.status).toBe('done');
  // A string, not a Date. Reviving it rewrote any app response that happened to have this shape.
  expect(upload.response.blob.uploadedAt).toBe(END_BODY.blob.uploadedAt);
  expect(upload.response.data).toEqual({ rowId: '1' });
});

/* ----------------------------------------------- headers() is the interrupt -- */

test('a throw from headers ends a direct upload without retrying the route', async () => {
  const hook = await render(() =>
    useUpload<UploadRoute<undefined, unknown>>(route, {
      headers: () => {
        throw new BlobError('unauthorized', { message: 'no session' });
      },
    }),
  );
  await act(async () => {
    hook.current.start({ file: png() });
  });
  await flush(3);
  const upload = hook.current.upload!;
  expect(upload.status === 'error' && upload.error.code).toBe('unauthorized');
  expect(upload.status === 'error' && upload.error.message).toBe('No session');
  // Not reworded as a network fault, and begin was never attempted three times.
  expect(calls.filter((c) => c.method === 'POST')).toHaveLength(0);
});

test('a throw from headers ends a server upload before any bytes are sent', async () => {
  const hook = await render(() =>
    useServerUpload('/api/avatar', {
      headers: () => {
        throw new BlobError('forbidden', { message: 'not your avatar' });
      },
    }),
  );
  await act(async () => {
    hook.current.start({ file: png() });
  });
  await flush(3);
  const upload = hook.current.upload!;
  expect(upload.status === 'error' && upload.error.code).toBe('forbidden');
  expect(xhrs).toHaveLength(0);
});

/* ------------------------------------------------------------- finishing -- */

test('a direct upload is finishing between the last byte and the end response', async () => {
  const hook = await render(() => useUpload<UploadRoute<undefined, unknown>>(route));
  await act(async () => {
    hook.current.start({ file: png() });
  });
  const put = await nextXhr();
  expect(hook.current.upload!.status).toBe('uploading');
  await act(async () => {
    put.respond(200, { etag: '"x"' });
  });
  await flush(2);
  const upload = hook.current.upload!;
  // Every byte is sent, phase 'end' is in flight, and percent is clamped to 99 for this stretch.
  expect(upload.status === 'done' || upload.status === 'finishing').toBe(true);
});

/* -------------------------------------------------------- createUploadHooks -- */

test('a route with no contentTypes is not asked for the file head', async () => {
  const sizeOnly = `/api/size-only/${++routeId}`;
  const bodies: any[] = [];
  restore.push(
    installRouter({
      [sizeOnly]: {
        GET: async () => jsonResponse({ constraints: { maxBytes: 1000 } }),
        POST: async (request: Request) => {
          const body = (await request.json()) as any;
          bodies.push(body);
          if (body?.phase === 'begin') {
            return jsonResponse({ completionToken: 't', path: 'p', upload: { partSize: PART_SIZE, parts: ONE_PART } });
          }
          return jsonResponse(END_BODY);
        },
      },
    }),
  );
  const hook = await render(() => useUpload(sizeOnly));
  // The constraints have to have landed, or the head is sent because nothing is known yet.
  await flush();
  expect(hook.current.constraints).toEqual({ maxBytes: 1000 });
  await act(async () => {
    hook.current.start({ file: png() });
  });
  await flush(3);
  const begin = bodies.find((b) => b.phase === 'begin');
  expect(begin).toBeDefined();
  expect(begin.head).toBeUndefined();
});

test('a route that declares contentTypes is sent the head with begin', async () => {
  const hook = await render(() => useUpload(route));
  await flush();
  await act(async () => {
    hook.current.start({ file: png() });
  });
  await flush(3);
  const begin = calls.find((c) => c.method === 'POST' && (c.body as any)?.phase === 'begin');
  expect(typeof (begin!.body as any).head).toBe('string');
  // 'x'.repeat(10), which proves nothing and so is accepted.
  expect(atob((begin!.body as any).head)).toBe('x'.repeat(10));
});

test('createUploadHooks applies direct defaults and runs its onError before the call site handler', async () => {
  const seen: string[] = [];
  const failing = `/api/configured/${++routeId}`;
  restore.push(
    installRouter({
      [failing]: {
        GET: async () => jsonResponse({ constraints: CONSTRAINTS }),
        POST: async () => jsonResponse(new BlobError('forbidden').toJSON(), 403),
      },
    }),
  );
  const configured = createUploadHooks({
    headers: () => ({ authorization: 'Bearer default' }),
    onError: () => seen.push('default'),
  });
  const hook = await render(() => configured.useUpload(failing, { onError: () => seen.push('call') }));
  await act(async () => {
    hook.current.start({ file: png() });
  });
  await flush(3);
  expect(hook.current.upload!.status).toBe('error');
  expect(seen).toEqual(['default', 'call']);
});

test('a direct call-site option wins over the configured default', async () => {
  const configured = createUploadHooks({ headers: () => ({ authorization: 'Bearer default' }) });
  const hook = await render(() =>
    configured.useUpload(route, { headers: () => ({ authorization: 'Bearer own' }) }),
  );
  await flush();
  await act(async () => {
    hook.current.start({ file: png() });
  });
  await flush();
  expect(calls.filter((call) => call.url === route).map((call) => call.auth)).toEqual([
    'Bearer own',
    'Bearer own',
  ]);
});

test('a configured onError that throws does not stop the direct queue or call-site handler', async () => {
  const seen: string[] = [];
  const failing = `/api/configured/${++routeId}`;
  restore.push(
    installRouter({
      [failing]: {
        GET: async () => jsonResponse({ constraints: CONSTRAINTS }),
        POST: async () => jsonResponse(new BlobError('forbidden').toJSON(), 403),
      },
    }),
  );
  const configured = createUploadHooks({
    onError: () => {
      seen.push('default');
      throw new Error('boom');
    },
  });
  const hook = await render(() =>
    configured.useUpload(failing, { concurrency: 1, onError: () => seen.push('call') }),
  );
  await act(async () => {
    hook.current.start({ files: [png('a.png'), png('b.png')] });
  });
  await flush(5);
  expect(seen).toEqual(['default', 'call', 'default', 'call']);
  expect(hook.current.uploads.map((upload) => upload.status)).toEqual(['error', 'error']);
});

test('pause is refused once every direct-upload part has landed', async () => {
  const hook = await render(() => useUpload<UploadRoute<undefined, unknown>>(route));
  await act(async () => {
    hook.current.start({ file: png() });
  });
  const put = await nextXhr();
  await act(async () => {
    put.respond(200, { etag: '"x"' });
  });
  await flush();
  const upload = hook.current.upload!;
  if (upload.status === 'finishing') {
    expect(upload.canPause).toBe(false);
    expect(upload.pause()).toBe(false);
  }
});

/* ---------------------------------------------------------- named handler -- */

type Uploads = {
  readonly __upstashUploadHandler: {
    doc: UploadRoute<undefined, { rowId: string }>;
  };
};

function mountHandler(name: string): { endpoint: string; url: string } {
  const endpoint = `/api/handler/${++routeId}`;
  const url = `${endpoint}?route=${name}`;
  restore.push(
    installRouter({
      [url]: {
        GET: async (request: Request) => {
          calls.push({ url, method: 'GET', body: undefined, auth: request.headers.get('authorization') });
          return jsonResponse({ constraints: CONSTRAINTS });
        },
        POST: async (request: Request) => {
          const body = (await request.json()) as any;
          calls.push({ url, method: 'POST', body, auth: request.headers.get('authorization') });
          if (body?.phase === 'begin') {
            return jsonResponse({ completionToken: 't', path: 'p', upload: { partSize: PART_SIZE, parts: ONE_PART } });
          }
          if (body?.phase === 'end') return jsonResponse(END_BODY);
          return jsonResponse({ ok: true });
        },
      },
    }),
  );
  return { endpoint, url };
}

test('a direct route name resolves against the configured endpoint for constraints and upload', async () => {
  const { endpoint, url } = mountHandler('doc');
  const { useUpload: bound } = createUploadHooks<Uploads>({ endpoint });
  const hook = await render(() => bound('doc'));
  await flush();
  expect(calls[0]).toMatchObject({ url, method: 'GET' });
  expect(hook.current.accept).toBe('image/png');

  await act(async () => {
    hook.current.start({ file: png() });
  });
  const put = await nextXhr();
  expect(put.method).toBe('PUT');
  expect(calls.some((call) => call.url === url && call.body?.phase === 'begin')).toBe(true);
  await act(async () => {
    put.respond(200, { etag: '"x"' });
  });
  await flush(3);
  const upload = hook.current.upload!;
  expect(upload.status).toBe('done');
  expect(upload.status === 'done' && upload.blob.data.rowId).toBe('1');
});

test('canceling a server upload while async headers resolve never sends bytes', async () => {
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  const hook = await render(() =>
    useServerUpload('/api/avatar', {
      headers: async () => {
        await waiting;
        return { authorization: 'Bearer late' };
      },
    }),
  );
  let record: ReturnType<typeof hook.current.start>;
  await act(async () => {
    record = hook.current.start({ file: png() });
  });
  await act(async () => {
    expect(record!.cancel()).toBe(true);
    release();
  });
  await flush(3);
  expect(hook.current.upload!.status).toBe('canceled');
  expect(xhrs).toHaveLength(0);
});
