import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import * as z from 'zod';
import { BlobError, handleUpload, uniquePath } from '../../src/index.ts';
import { upload } from '../../src/browser/index.ts';
import { clock } from '../../src/browser/clock.ts';
import { FetchXhr, installRouter, installXhr } from '../helpers/xhr.ts';
import { bytes, cleanup, p, PNG, priv, pub, root, sweep } from './setup.ts';

// The browser client, driven in one process against the real route handlers and real R2. A
// fetch-backed XMLHttpRequest stands in for the browser's; the bytes really land.
const restore: (() => void)[] = [];
const rows: Record<string, unknown> = {};
const memory = new Map<string, string>();

beforeAll(async () => {
  (globalThis as any).localStorage = {
    getItem: (k: string) => memory.get(k) ?? null,
    setItem: (k: string, v: string) => void memory.set(k, v),
    removeItem: (k: string) => void memory.delete(k),
  };
  clock.frame = (cb) => queueMicrotask(cb);
  restore.push(installXhr(FetchXhr));
  await Promise.all([sweep(pub), sweep(priv)]);
});
afterAll(async () => {
  for (const r of restore) r();
  await Promise.all([cleanup(pub), cleanup(priv)]);
});

const chat = handleUpload({
  bucket: pub,
  limits: { allowedContentTypes: ['image/png', 'image/jpeg', 'image/webp', 'application/pdf'], maxBytes: '20mb' },
  input: z.object({ threadId: z.string().uuid() }),
  onBeforeUpload: async ({ request, file, input }) => {
    const user = request.headers.get('authorization')?.slice(7);
    if (!user) throw new BlobError('unauthorized');
    const path = root + uniquePath`chat/${user}/${input.threadId}/${file.name}`;
    rows[path] = 'pending';
    return { path, cache: 'immutable', metadata: { uploadedBy: user }, context: { rowId: path, owner: user } };
  },
  onUploadCompleted: async ({ path, context }) => {
    rows[path] = 'ready';
    return { rowId: context.rowId };
  },
});

let begins = 0;
const large = handleUpload({
  bucket: priv,
  limits: { maxBytes: '5gb' },
  onBeforeUpload: async ({ file }) => {
    begins++;
    return { path: p(`large/${crypto.randomUUID()}-${file.name}`), context: { n: begins } };
  },
  onUploadCompleted: async ({ path, size }) => {
    rows[path] = size;
  },
});

restore.push(installRouter({ '/api/upload': chat, '/api/upload/large': large }));

const tid = '4d4a2a2c-5d6e-4f7a-8b9c-0d1e2f3a4b5c';
const headers = () => ({ authorization: 'Bearer u7' });

describe('upload()', () => {
  test('single PUT: queued -> uploading -> done, blob.data typed by the route', async () => {
    const png = new Uint8Array(new ArrayBuffer(2000));
    png.set(PNG);
    const file = new File([png], 'Pic One.png', { type: 'image/png' });
    const task = upload(file, { route: '/api/upload', headers, input: { threadId: tid } });
    expect(task.snapshot().status).toBe('queued');
    expect(task.snapshot().canPause).toBe(false);
    const seen: string[] = [];
    task.subscribe(() => seen.push(task.snapshot().status));
    const blob = await task.done;
    expect(blob.path).toMatch(new RegExp(`^${root}chat/u7/${tid}/pic-one-[1-9A-HJ-NP-Za-km-z]{8}\\.png$`));
    expect(blob.size).toBe(2000);
    expect((blob.data as { rowId: string }).rowId).toBe(blob.path);
    expect(rows[blob.path]).toBe('ready');
    expect(task.snapshot().status).toBe('done');
    expect(task.snapshot().percent).toBe(100);
    expect(seen).toContain('uploading');
    expect(task.pause()).toBe(false);
    expect(task.cancel()).toBe(false);
    expect((await fetch(blob.url!)).status).toBe(200);
  });

  test('route errors surface as BlobError with the route status', async () => {
    const file = new File(['<html>'], 'x.png', { type: 'text/html' });
    const task = upload(file, { route: '/api/upload', headers, input: { threadId: tid } });
    const err = await task.done.catch((e) => e);
    expect(BlobError.is(err)).toBe(true);
    expect(err.code).toBe('content_type_not_allowed');
    expect(err.status).toBe(400);
    expect(task.snapshot().status).toBe('error');

    const noAuth = upload(new File([PNG], 'x.png', { type: 'image/png' }), { route: '/api/upload', input: { threadId: tid } });
    await expect(noAuth.done).rejects.toMatchObject({ code: 'unauthorized', status: 401 });
  });

  test('multipart: pause, resume, cancel, and resume by fingerprint after a reload', async () => {
    const size = 17_000_000;
    const data = bytes(size, 5);
    const file = new File([data], 'movie.bin', { type: 'application/octet-stream', lastModified: 1_700_000_000_000 });

    const first = upload(file, { route: '/api/upload/large', headers });
    await new Promise<void>((resolve) => {
      const unsub = first.subscribe(() => {
        const s = first.snapshot();
        if (s.status === 'uploading' && s.loaded > 0) {
          unsub();
          resolve();
        }
      });
    });
    expect(first.snapshot().canPause).toBe(true);
    expect(first.pause()).toBe(true);
    expect(first.pause()).toBe(false);
    expect(first.snapshot().status).toBe('paused');
    // A pending record exists for the fingerprint: the reload story.
    expect([...memory.keys()].some((k) => k.includes('movie.bin'))).toBe(true);
    expect(first.resume()).toBe(true);
    expect(first.snapshot().status).toBe('uploading');
    // Let at least one part land, then cancel the in-progress task to simulate the tab closing.
    await new Promise<void>((resolve) => {
      const unsub = first.subscribe(() => {
        if (first.snapshot().loaded >= 5 * 1024 * 1024) {
          unsub();
          resolve();
        }
      });
    });
    const record = [...memory.entries()].find(([k]) => k.includes('movie.bin'))!;
    expect(first.cancel()).toBe(true);
    expect(first.snapshot().status).toBe('canceled');
    await expect(first.done).rejects.toMatchObject({ name: 'AbortError' });
    await new Promise((r) => setTimeout(r, 500));
    // cancel() aborts the multipart upload server-side and forgets the record...
    expect(memory.has(record[0])).toBe(false);
    // ...so to exercise resume, put the record back as if the tab had simply closed, on a NEW upload.
    const second0 = upload(file, { route: '/api/upload/large', headers });
    await new Promise<void>((resolve) => {
      const unsub = second0.subscribe(() => {
        if (second0.snapshot().loaded >= 5 * 1024 * 1024 && second0.snapshot().status === 'uploading') {
          unsub();
          resolve();
        }
      });
    });
    const rec2 = [...memory.entries()].find(([k]) => k.includes('movie.bin'))!;
    const beginsBefore = begins;
    // Simulate the tab dying mid-upload: drop the task on the floor without cancel. pause() drains
    // the parts already sending, so wait for it to go quiet: two writers on one part number race.
    (second0 as any).pause();
    for (let last = -1; last !== second0.snapshot().loaded; ) {
      last = second0.snapshot().loaded;
      await new Promise((r) => setTimeout(r, 750));
    }
    memory.set(rec2[0], rec2[1]);

    const third = upload(file, { route: '/api/upload/large', headers });
    const blob = await third.done;
    expect(begins).toBe(beginsBefore); // resumed: no new begin, no new row
    expect(blob.size).toBe(size);
    expect(blob.etag).toMatch(/-4"$/);
    expect(rows[blob.path]).toBe(size);
    expect(memory.has(rec2[0])).toBe(false);
    const back = new Uint8Array(await new Response((await priv.get(blob.path)).body).arrayBuffer());
    expect(back.subarray(0, 64)).toEqual(data.subarray(0, 64));
    expect(back.subarray(size - 64)).toEqual(data.subarray(size - 64));
  }, 300_000);
});
