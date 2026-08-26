import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test';
import { act, createElement, StrictMode } from 'react';
import { clock } from '../../src/browser/clock.ts';
import { poolState } from '../../src/browser/pool.ts';
import { BlobError, createUploadHooks, useUpload, useUploadProxy } from '../../src/react/index.ts';
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

// Every direct upload is multipart, one part when the file fits one: begin hands back a part list
// and phase 'end' completes it with the etags the PUTs answered. There is no single-PUT path left.
const PART_SIZE = 5 * 1024 * 1024;
const ONE_PART = [{ n: 1, url: 'https://r2.test/put' }];

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
        return jsonResponse({ completionToken: 't', path: 'p', upload: { partSize: PART_SIZE, parts: ONE_PART } });
      }
      if (body?.phase === 'parts') return jsonResponse({ partSize: PART_SIZE, size, parts: ONE_PART, landed: [] });
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

test('a small file is a one-part multipart, so it pauses like any other, and the controls answer', async () => {
  const hook = await render(() => useUpload(route));
  await flush();
  await act(async () => {
    hook.current.start({ file: png() });
  });
  await nextXhr();
  await flush();
  // canPause used to be false under the multipart threshold, because a single PUT had no parts to
  // hold back. There is no threshold and no single PUT: pause, resume and retry work at every size.
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

/* ---------------------------------------------------------- useUploadProxy -- */

test('proxy start({file}) posts multipart under the field file', async () => {
  const hook = await render(() => useUploadProxy<{ url: string }>('/api/avatar'));
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

test('proxy start({body: file}) sends the File raw', async () => {
  const hook = await render(() => useUploadProxy('/api/avatar'));
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

test('proxy start({body: formData}) sends it as is', async () => {
  const hook = await render(() => useUploadProxy('/api/avatar'));
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

test('proxy reports progress, then status finishing, then the parsed response', async () => {
  const done: any[] = [];
  const hook = await render(() => useUploadProxy<{ url: string }>('/api/avatar', { onDone: (u) => done.push(u) }));
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

test('proxy 413 is too_large', async () => {
  const hook = await render(() => useUploadProxy('/api/avatar'));
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
});

test('proxy 500 with an error string becomes request_failed carrying it', async () => {
  const errors: any[] = [];
  const hook = await render(() => useUploadProxy('/api/avatar', { onError: (u) => errors.push(u) }));
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

test('proxy cancel aborts the request and reports canceled', async () => {
  const hook = await render(() => useUploadProxy('/api/avatar'));
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
  expect(record.id).toBe(hook.current.upload!.id);
  expect(hook.current.upload!.cancel()).toBe(false);
});

test('proxy start with a nullish file or body returns null', async () => {
  const hook = await render(() => useUploadProxy('/api/avatar'));
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

test('proxy request_failed falls back to statusText when the body carries no error', async () => {
  const hook = await render(() => useUploadProxy('/api/avatar'));
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

test('proxy headers are re-read per request', async () => {
  let n = 0;
  const hook = await render(() => useUploadProxy('/api/avatar', { headers: () => ({ authorization: `Bearer ${++n}` }) }));
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
  let api!: ReturnType<typeof useUploadProxy>;
  let queued: { cancel(): boolean } | undefined;
  const errors: string[] = [];
  await render(() => {
    const result = useUploadProxy('/api/avatar', {
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

test('proxy concurrency 1 queues the second request', async () => {
  const hook = await render(() => useUploadProxy('/api/avatar', { concurrency: 1 }));
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

test('a proxy route answering with BlobError.toJSON keeps its code', async () => {
  const hook = await render(() => useUploadProxy('/api/avatar'));
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
  const hook = await render(() => useUploadProxy('/api/avatar'));
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

test('a proxy route response is handed back exactly as it arrived', async () => {
  const hook = await render(() => useUploadProxy('/api/avatar'));
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

test('a throw from headers ends a proxy upload before any bytes are sent', async () => {
  const hook = await render(() =>
    useUploadProxy('/api/avatar', {
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

test('createUploadHooks applies defaults and runs its onError before the call site own', async () => {
  const seen: string[] = [];
  const configured = createUploadHooks({
    headers: () => ({ authorization: 'Bearer default' }),
    onError: () => seen.push('default'),
  });
  const hook = await render(() => configured.useUploadProxy('/api/avatar', { onError: () => seen.push('call') }));
  await act(async () => {
    hook.current.start({ file: png() });
  });
  const xhr = await nextXhr();
  expect(xhr.headers['authorization']).toBe('Bearer default');
  await act(async () => {
    xhr.respond(500);
  });
  await flush();
  expect(seen).toEqual(['default', 'call']);
});

test('a call site option wins over the configured default', async () => {
  const configured = createUploadHooks({ headers: () => ({ authorization: 'Bearer default' }) });
  const hook = await render(() => configured.useUploadProxy('/api/avatar', { headers: () => ({ authorization: 'Bearer own' }) }));
  await act(async () => {
    hook.current.start({ file: png() });
  });
  const xhr = await nextXhr();
  expect(xhr.headers['authorization']).toBe('Bearer own');
});

test('a configured onError that throws does not stop the queue or the call site handler', async () => {
  const seen: string[] = [];
  const configured = createUploadHooks({
    onError: () => {
      seen.push('default');
      throw new Error('boom');
    },
  });
  const hook = await render(() => configured.useUploadProxy('/api/avatar', { concurrency: 1, onError: () => seen.push('call') }));
  await act(async () => {
    hook.current.start({ file: png('a.png') });
    hook.current.start({ file: png('b.png') });
  });
  const first = await nextXhr();
  await act(async () => {
    first.respond(500);
  });
  await flush(2);
  expect(seen).toEqual(['default', 'call']);
  // The throw used to escape the settle loop, so the queued second file never started.
  expect(xhrs).toHaveLength(2);
});

test('pause is refused once every part has landed', async () => {
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
    // Nothing is left to hold back: pausing here only mislabelled an upload that completed anyway.
    expect(upload.canPause).toBe(false);
    expect(upload.pause()).toBe(false);
  }
});

/* ----------------------------------------------------------------- handler -- */

/** The shape `typeof uploads` has: only the brands matter, so a fake one types the hooks here. */
type Uploads = {
  readonly __upstashUploadHandler: {
    doc: UploadRoute<undefined, { rowId: string }, string, false>;
    avatar: UploadRoute<undefined, { rowId: string }, string, true>;
  };
};

function mountHandler(transport: 'direct' | 'proxy', name: string, gate?: Promise<unknown>): { endpoint: string; url: string } {
  const endpoint = `/api/handler/${++routeId}`;
  const url = `${endpoint}?route=${name}`;
  restore.push(
    installRouter({
      [url]: {
        GET: async (request: Request) => {
          calls.push({ url, method: 'GET', body: undefined, auth: request.headers.get('authorization') });
          // A route that has not answered yet is the whole point of the deferred tests below.
          if (gate) await gate;
          return jsonResponse({ constraints: CONSTRAINTS, transport });
        },
        POST: async (request: Request) => {
          const body = (await request.json()) as any;
          calls.push({ url, method: 'POST', body, auth: request.headers.get('authorization') });
          if (body?.phase === 'begin') return jsonResponse({ completionToken: 't', path: 'p', upload: { partSize: PART_SIZE, parts: ONE_PART } });
          if (body?.phase === 'end') return jsonResponse(END_BODY);
          return jsonResponse({ ok: true });
        },
      },
    }),
  );
  return { endpoint, url };
}

test('a route name resolves against the endpoint, for the constraints and for the upload', async () => {
  const { endpoint, url } = mountHandler('direct', 'doc');
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
  expect(calls.some((c) => c.url === url && c.body?.phase === 'begin')).toBe(true);
  await act(async () => {
    put.respond(200, { etag: '"x"' });
  });
  await flush(3);
  const upload = hook.current.upload!;
  expect(upload.status).toBe('done');
  expect(upload.status === 'done' && upload.blob.data.rowId).toBe('1');
});

test('the same hook runs a proxy route as one POST, and merges the envelope into blob', async () => {
  const { endpoint, url } = mountHandler('proxy', 'avatar');
  const { useUpload: bound } = createUploadHooks<Uploads>({ endpoint, headers: () => ({ authorization: 'Bearer t' }) });
  const hook = await render(() => bound('avatar'));
  await flush();

  const file = png();
  await act(async () => {
    hook.current.start({ file });
  });
  const xhr = await nextXhr();
  expect(xhr.method).toBe('POST');
  expect(xhr.url).toBe(url);
  expect(xhr.headers['authorization']).toBe('Bearer t');
  expect(xhr.body).toBeInstanceOf(FormData);
  expect((xhr.body as FormData).get('file')).toBe(file as any);
  // No begin, no end: the bytes and the answer are the one request.
  expect(calls.filter((c) => c.method === 'POST')).toHaveLength(0);

  await act(async () => {
    xhr.respond(200, {}, JSON.stringify(END_BODY));
  });
  await flush(2);
  const upload = hook.current.upload!;
  expect(upload.status).toBe('done');
  if (upload.status !== 'done') throw new Error('unreachable');
  expect(upload.blob.data.rowId).toBe('1');
  expect(upload.blob.url).toBe('https://h/p');
  // The envelope crossed as JSON; uploadedAt is a Date again, as it is on a direct upload.
  expect(upload.blob.uploadedAt).toBeInstanceOf(Date);
});

test('a file picked before the route has answered waits for it, then goes the right way', async () => {
  let answer!: () => void;
  const gate = new Promise<void>((resolve) => (answer = resolve));
  const { endpoint } = mountHandler('proxy', 'avatar', gate);
  const { useUpload: bound } = createUploadHooks<Uploads>({ endpoint });
  // The route has not said what it is yet, so nothing can be sent with the right transport.
  const hook = await render(() => bound('avatar'));
  let record: any;
  await act(async () => {
    record = hook.current.start({ file: png() });
  });
  expect(record.status).toBe('queued');
  expect(xhrs).toHaveLength(0);

  await act(async () => {
    answer();
  });
  const xhr = await nextXhr();
  // It went out as one POST, not as a presign: the route said so before anything was sent.
  expect(xhr.method).toBe('POST');
  expect(xhr.body).toBeInstanceOf(FormData);
  expect(hook.current.uploads).toHaveLength(1);
  expect(hook.current.uploads[0]!.id).toBe(record.id);
  await act(async () => {
    xhr.respond(200, {}, JSON.stringify(END_BODY));
  });
  await flush(2);
  expect(hook.current.upload!.status).toBe('done');
});

test('a file the constraints refuse is refused even when it was picked before they landed', async () => {
  let answer!: () => void;
  const gate = new Promise<void>((resolve) => (answer = resolve));
  const { endpoint } = mountHandler('proxy', 'avatar', gate);
  const { useUpload: bound } = createUploadHooks<Uploads>({ endpoint });
  const hook = await render(() => bound('avatar'));
  await act(async () => {
    hook.current.start({ file: png('big.png', 2000) });
  });
  await act(async () => {
    answer();
  });
  await flush(3);
  const upload = hook.current.upload!;
  expect(upload.status).toBe('error');
  expect(upload.status === 'error' && upload.error.code).toBe('too_large');
  expect(xhrs).toHaveLength(0);
});

test('cancel before the route answers never sends the file', async () => {
  let answer!: () => void;
  const gate = new Promise<void>((resolve) => (answer = resolve));
  const { endpoint } = mountHandler('proxy', 'avatar', gate);
  const { useUpload: bound } = createUploadHooks<Uploads>({ endpoint });
  const hook = await render(() => bound('avatar'));
  let record: any;
  await act(async () => {
    record = hook.current.start({ file: png() });
  });
  await act(async () => {
    expect(record.cancel()).toBe(true);
  });
  await act(async () => {
    answer();
  });
  await flush(3);
  expect(xhrs).toHaveLength(0);
  expect(hook.current.upload!.status).toBe('canceled');
});

test('start({ body: file }) on a proxy route sends the file as the body, not as a form', async () => {
  const { endpoint } = mountHandler('proxy', 'avatar');
  const { useUpload: bound } = createUploadHooks<Uploads>({ endpoint });
  const hook = await render(() => bound('avatar'));
  await flush();
  const file = png();
  await act(async () => {
    hook.current.start({ body: file });
  });
  const xhr = await nextXhr();
  expect(xhr.body).toBe(file as any);
  expect(hook.current.upload!.file).toBe(file);
});

test('a route that cannot be reached fails the upload with why, and is asked again next time', async () => {
  const endpoint = `/api/handler/${++routeId}`;
  const url = `${endpoint}?route=avatar`;
  let reachable = false;
  restore.push(
    installRouter({
      [url]: {
        GET: async () => {
          if (!reachable) throw new TypeError('fetch failed');
          return jsonResponse({ constraints: CONSTRAINTS, transport: 'proxy' });
        },
        POST: async () => jsonResponse(END_BODY),
      },
    }),
  );
  const { useUpload: bound } = createUploadHooks<Uploads>({ endpoint });
  const hook = await render(() => bound('avatar'));
  await flush();
  await act(async () => {
    hook.current.start({ file: png() });
  });
  await flush(3);
  // Nothing was guessed: a presign sent to a proxy route would be a JSON body it stores.
  expect(xhrs).toHaveLength(0);
  const first = hook.current.upload!;
  expect(first.status).toBe('error');
  expect(first.status === 'error' && first.error.code).toBe('request_failed');

  reachable = true;
  await act(async () => {
    hook.current.start({ file: png() });
  });
  const xhr = await nextXhr();
  expect(xhr.method).toBe('POST');
  expect(xhr.body).toBeInstanceOf(FormData);
});

test('a route whose GET refuses hands the upload that refusal', async () => {
  const endpoint = `/api/handler/${++routeId}`;
  const url = `${endpoint}?route=doc`;
  restore.push(installRouter({ [url]: { GET: async () => jsonResponse(new BlobError('unauthorized').toJSON(), 401), POST: async () => jsonResponse(END_BODY) } }));
  const { useUpload: bound } = createUploadHooks<Uploads>({ endpoint });
  const hook = await render(() => bound('doc'));
  await act(async () => {
    hook.current.start({ file: png() });
  });
  await flush(3);
  expect(xhrs).toHaveLength(0);
  const upload = hook.current.upload!;
  expect(upload.status === 'error' && upload.error.code).toBe('unauthorized');
});

test('a route with no GET half is a direct one, as every upload route was before proxy existed', async () => {
  const endpoint = `/api/handler/${++routeId}`;
  const url = `${endpoint}?route=doc`;
  restore.push(
    installRouter({
      [url]: {
        POST: async (request) => {
          const body = (await request.json()) as any;
          calls.push({ url, method: 'POST', body, auth: null });
          if (body?.phase === 'begin') return jsonResponse({ completionToken: 't', path: 'p', upload: { partSize: PART_SIZE, parts: ONE_PART } });
          return jsonResponse(END_BODY);
        },
      },
    }),
  );
  const { useUpload: bound } = createUploadHooks<Uploads>({ endpoint });
  const hook = await render(() => bound('doc'));
  await act(async () => {
    hook.current.start({ file: png() });
  });
  const put = await nextXhr();
  expect(put.method).toBe('PUT');
  expect(calls.some((c) => c.url === url && c.body?.phase === 'begin')).toBe(true);
});
