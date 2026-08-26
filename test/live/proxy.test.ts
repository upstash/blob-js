import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import * as z from 'zod';
import { BlobError, uploadHandler } from '../../src/index.ts';
import { clock } from '../../src/browser/clock.ts';
import { ProxyTask } from '../../src/react/proxy-task.ts';
import { FetchXhr, installRouter, installXhr } from '../helpers/xhr.ts';
import { cleanup, p, PNG, pub, sweep } from './setup.ts';

// The proxied-upload primitive under useUploadProxy: once against routes the app wrote itself,
// which is the reason the hook exists, and once against a `proxy: true` uploadHandler.
const restore: (() => void)[] = [];
beforeAll(async () => {
  clock.frame = (cb) => queueMicrotask(cb);
  restore.push(installXhr(FetchXhr));
  await sweep(pub);
});
afterAll(async () => {
  restore.forEach((r) => r());
  await cleanup(pub);
});

const guard = (fn: (req: Request) => Promise<Response>) => async (req: Request) => {
  try {
    if (!req.headers.get('authorization')) throw new BlobError('unauthorized');
    return await fn(req);
  } catch (e) {
    if (!BlobError.is(e)) throw e;
    return Response.json({ error: e.message }, { status: e.status });
  }
};
const opts = { contentTypes: ['image/png', 'image/jpeg', 'image/webp'] as string[], maxBytes: '2mb' };

// The same upload written as an uploadHandler instead: `proxy: true` with no `routes` makes the one
// route this handler is take its bytes through the function, and `field` names the form field.
const avatars = uploadHandler({
  bucket: pub,
  proxy: true,
  field: 'avatar',
  constraints: { contentTypes: ['image/png', 'image/jpeg', 'image/webp'], maxBytes: '2mb' },
  context: (request) => {
    const id = request.headers.get('authorization')?.slice(7);
    if (!id) throw new BlobError('unauthorized');
    return { id };
  },
  input: z.object({ label: z.string() }),
  onBeforeUpload: ({ ctx, input }) => ({ path: p(`proxied/${ctx.id}`), cache: '1m', metadata: { label: input.label, uploadedBy: ctx.id } }),
  onUploadComplete: ({ path, size, contentType, metadata }) => ({ path, size, contentType, label: metadata.label }),
});

const refuses = uploadHandler({
  bucket: pub,
  proxy: true,
  constraints: { contentTypes: ['image/png'], maxBytes: '2mb' },
  onBeforeUpload: () => ({ path: p('proxied/rollback.png') }),
  onUploadComplete: () => {
    throw new BlobError('forbidden', { message: 'the row this file belongs to is gone' });
  },
});

restore.push(
  installRouter({
    '/api/avatar': {
      POST: guard(async (req) => {
        const file = (await req.formData()).get('file');
        if (!(file instanceof File)) return Response.json({ error: 'file field required' }, { status: 400 });
        const blob = await pub.put(p('avatar/42'), file, { ...opts, cache: '1m' });
        return Response.json({ url: blob.versionedUrl });
      }),
    },
    '/api/avatar/streaming': {
      POST: guard(async (req) => {
        const blob = await pub.put(p('avatar/42'), req, opts);
        return Response.json({ url: blob.versionedUrl });
      }),
    },
    '/api/proxied': avatars,
    '/api/proxied/refuses': refuses,
  }),
);

function run<T>(task: ProxyTask<T>) {
  task.start();
  return new Promise<ReturnType<ProxyTask<T>['snapshot']>>((resolve) => {
    const check = () => {
      const s = task.snapshot();
      if (s.status === 'done' || s.status === 'error' || s.status === 'canceled') resolve(s);
    };
    task.subscribe(check);
    check();
  });
}

const png = (n: number) => {
  const out = new Uint8Array(new ArrayBuffer(n));
  out.set(PNG);
  return out;
};

describe('useUploadProxy primitive', () => {
  test('start({file}) is multipart under field "file"; the route answers JSON', async () => {
    const file = new File([png(900)], 'me.png', { type: 'image/png' });
    const fd = new FormData();
    fd.append('file', file);
    const task = new ProxyTask<{ url: string }>({ route: '/api/avatar', headers: () => ({ authorization: 'Bearer 42' }), body: fd, file, total: file.size });
    const s = await run(task);
    expect(s.status).toBe('done');
    if (s.status !== 'done') throw new Error();
    expect(s.response.url).toMatch(/\?v=/);
    expect(s.percent).toBe(100);
    expect((await fetch(s.response.url)).status).toBe(200);
  });

  test('start({body: file}) is the raw body for a streaming route', async () => {
    const file = new File([png(950)], 'me.png', { type: 'image/png' });
    const task = new ProxyTask<{ url: string }>({ route: '/api/avatar/streaming', headers: () => ({ authorization: 'Bearer 42' }), body: file, file, total: file.size });
    const s = await run(task);
    expect(s.status).toBe('done');
    expect((await pub.info(p('avatar/42'))).size).toBe(950);
  });

  test('the route saying no is request_failed with its status and {error} message', async () => {
    const html = new File(['<html>'], 'x.png', { type: 'image/png' });
    const s = await run(new ProxyTask({ route: '/api/avatar/streaming', headers: () => ({ authorization: 'Bearer 42' }), body: html, file: html, total: html.size }));
    expect(s.status).toBe('error');
    if (s.status !== 'error') throw new Error();
    expect(s.error.code).toBe('request_failed');
    expect(s.error.status).toBe(400);
    expect(s.error.message).toContain('image/png');
    const noAuth = await run(new ProxyTask({ route: '/api/avatar', body: new FormData(), file: null, total: 0 }));
    expect(noAuth.status === 'error' && noAuth.error.status).toBe(401);
  });
});

describe('a proxy: true uploadHandler', () => {
  const send = (route: string, form: FormData, file: File | null, auth: string | undefined = 'Bearer 42') =>
    run(new ProxyTask<{ blob: { path: string; url?: string; size: number }; data: unknown }>({ route, ...(auth ? { headers: () => ({ authorization: auth }) } : {}), body: form, file, total: file?.size ?? 0 }));

  const formOf = (file: File, field = 'avatar', input: unknown = { label: 'profile' }) => {
    const fd = new FormData();
    fd.append(field, file);
    // The browser sends `input` as a JSON string beside the file: a form field cannot carry an object.
    if (input !== undefined) fd.append('input', JSON.stringify(input));
    return fd;
  };

  test('GET says which transport it speaks, so one hook serves both', async () => {
    const res = await avatars.GET(new Request('https://app.test/api/proxied'));
    expect(await res.json()).toEqual({ constraints: { contentTypes: ['image/png', 'image/jpeg', 'image/webp'], maxBytes: 2_000_000 }, transport: 'proxy' });
  });

  test('the bytes go through the function and come back in the same envelope as phase end', async () => {
    const file = new File([png(1100)], 'me.png', { type: 'image/png' });
    const s = await send('/api/proxied', formOf(file), file);
    expect(s.status).toBe('done');
    if (s.status !== 'done') throw new Error();
    expect(s.response.blob.path).toBe(p('proxied/42'));
    expect(s.response.blob.size).toBe(1100);
    expect(s.response.data).toEqual({ path: p('proxied/42'), size: 1100, contentType: 'image/png', label: 'profile' });
    expect((await fetch(s.response.blob.url!)).status).toBe(200);
    const info = await pub.info(p('proxied/42'));
    expect(info.metadata.uploadedby).toBe('42');
    expect(info.metadata.label).toBe('profile');
  });

  test('a file under the wrong field, a bad input and a dead session are all refused', async () => {
    const file = new File([png(1100)], 'me.png', { type: 'image/png' });
    const wrongField = await send('/api/proxied', formOf(file, 'file'), file);
    expect(wrongField.status === 'error' && wrongField.error.code).toBe('invalid_input');
    const badInput = await send('/api/proxied', formOf(file, 'avatar', { label: 7 }), file);
    expect(badInput.status === 'error' && badInput.error.code).toBe('invalid_input');
    const noAuth = await send('/api/proxied', formOf(file), file, undefined);
    expect(noAuth.status === 'error' && noAuth.error.code).toBe('unauthorized');
  });

  test('bytes that lie about their type never reach the bucket, so what was there survives', async () => {
    const before = await pub.info(p('proxied/42'));
    const html = new File(['<!DOCTYPE html><html></html>'], 'me.png', { type: 'image/png' });
    const s = await send('/api/proxied', formOf(html), html);
    expect(s.status === 'error' && s.error.code).toBe('content_type_not_allowed');
    // This is the whole reason to send an upload through the function. The direct transport presigns,
    // the browser PUTs, and phase 'end' reads the object back to sniff it -- at a path that is
    // overwritten in place, the refused file has already replaced the one it was refused for.
    const after = await pub.info(p('proxied/42'));
    expect(after.size).toBe(before.size);
    expect(after.etag).toBe(before.etag);
  });

  test('onUploadComplete throwing takes the object with it here too', async () => {
    const fd = new FormData();
    fd.append('file', new File([png(700)], 'rollback.png', { type: 'image/png' }));
    const s = await send('/api/proxied/refuses', fd, null);
    expect(s.status === 'error' && s.error.status).toBe(403);
    // The invariant, whichever transport stored the bytes: the object exists iff the callback returned.
    expect(await pub.exists(p('proxied/rollback.png'))).toBe(false);
  });
});
