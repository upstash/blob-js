import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { BlobError } from '../../src/index.ts';
import { bytes, cleanup, p, PNG, priv, pub, sweep } from './setup.ts';

// SPEC.tsx sections 1 and 4, run as written against the live buckets with a stand-in for the app.

beforeAll(async () => {
  await Promise.all([sweep(pub), sweep(priv)]);
});
afterAll(async () => {
  await Promise.all([cleanup(pub), cleanup(priv)]);
});

const requireUser = (req: Request) => {
  const id = req.headers.get('authorization')?.slice(7);
  if (!id) throw new BlobError('unauthorized');
  return { id };
};
const route = (fn: (req: Request) => Promise<Response>) => async (req: Request) => {
  try {
    return await fn(req);
  } catch (e) {
    if (!BlobError.is(e)) throw e;
    return Response.json({ error: e.message }, { status: e.status });
  }
};
const db = { avatars: new Map<string, { path: string; size: number; etag: string }>() };

const POST_avatar = route(async (req: Request) => {
  const user = requireUser(req);
  const file = (await req.formData()).get('file');
  if (!(file instanceof File)) return Response.json({ error: 'file field required' }, { status: 400 });
  const blob = await pub.put(p(`avatar/${user.id}`), file, {
    contentTypes: ['image/png', 'image/jpeg', 'image/webp'],
    maxBytes: '2mb',
    cache: '1m',
    metadata: { uploadedBy: user.id },
  });
  db.avatars.set(user.id, { path: blob.path, size: blob.size, etag: blob.etag });
  return Response.json({ url: blob.versionedUrl });
});

const POST_avatarStreaming = route(async (req: Request) => {
  const user = requireUser(req);
  const blob = await pub.put(p(`avatar/${user.id}`), req, { contentTypes: ['image/png', 'image/jpeg', 'image/webp'], maxBytes: '2mb' });
  return Response.json({ url: blob.versionedUrl });
});

describe('1. avatar', () => {
  test('multipart form upload, overwritten path, versionedUrl changes with the bytes', async () => {
    const png1 = new Uint8Array(new ArrayBuffer(1200));
    png1.set(PNG);
    const fd = new FormData();
    fd.set('file', new File([png1], 'me.png', { type: 'image/png' }));
    const res = await POST_avatar(new Request('https://app/api/avatar', { method: 'POST', body: fd, headers: { authorization: 'Bearer 42' } }));
    expect(res.status).toBe(200);
    const { url } = (await res.json()) as { url: string };
    expect(url).toMatch(/\?v=/);
    expect((await fetch(url)).status).toBe(200);

    const png2 = new Uint8Array(new ArrayBuffer(1300));
    png2.set(PNG);
    const res2 = await POST_avatarStreaming(new Request('https://app/api/avatar/streaming', { method: 'POST', body: png2, headers: { authorization: 'Bearer 42', 'content-type': 'image/png' } }));
    const { url: url2 } = (await res2.json()) as { url: string };
    expect(url2).not.toBe(url);
    expect(url2.split('?')[0]).toBe(url.split('?')[0]);
    const served = await fetch(url2);
    expect(served.status).toBe(200);
    expect((await served.arrayBuffer()).byteLength).toBe(1300);
    expect((await pub.info(p('avatar/42'))).size).toBe(1300);

    const bad = await POST_avatar(new Request('https://app/api/avatar', { method: 'POST', body: fd }));
    expect(bad.status).toBe(401);
    const html = new FormData();
    html.set('file', new File(['<html>'], 'x.png', { type: 'image/png' }));
    const rejected = await POST_avatar(new Request('https://app/api/avatar', { method: 'POST', body: html, headers: { authorization: 'Bearer 42' } }));
    expect(rejected.status).toBe(400);
    const empty = await POST_avatarStreaming(new Request('https://app/api/avatar/streaming', { method: 'POST', headers: { authorization: 'Bearer 42' } }));
    expect(empty.status).toBe(400);
    expect((await empty.json()).error).toContain('body');
    const big = await POST_avatarStreaming(new Request('https://app/api/avatar/streaming', { method: 'POST', body: bytes(2_100_000), headers: { authorization: 'Bearer 42', 'content-type': 'image/png' } }));
    expect(big.status).toBe(413);
  });
});

describe('4. files', () => {
  test('GET_fileUrl, GET_files, sweepOrphans, deleteThread, updateSettings, serveThumbnail, copyToArchive', async () => {
    const rows = new Map<string, { id: string; owner: string; path: string; name: string; status: string; bucket: 'public' | 'private' }>();
    await priv.put(p('large/7/one.bin'), bytes(10), { contentType: 'application/octet-stream' });
    rows.set('r1', { id: 'r1', owner: '7', path: p('large/7/one.bin'), name: 'Q3 Report.bin', status: 'ready', bucket: 'private' });
    rows.set('r2', { id: 'r2', owner: '7', path: p('large/7/never.bin'), name: 'x', status: 'pending', bucket: 'private' });
    await pub.put(p('chat/7/t1/a.txt'), 'a');
    rows.set('r3', { id: 'r3', owner: '7', path: p('chat/7/t1/a.txt'), name: 'a.txt', status: 'pending', bucket: 'public' });

    const GET_fileUrl = route(async (req: Request) => {
      const user = requireUser(req);
      const id = new URL(req.url).searchParams.get('id')!;
      const row = rows.get(id);
      if (!row || row.owner !== user.id || row.status !== 'ready') return Response.json({ error: 'not found' }, { status: 404 });
      // No expiresIn: 15m was answered with a link that quietly died with the credential, and the
      // cap moves, so the default asks for the shorter of five minutes and what it can actually sign.
      const url = await priv.signedReadUrl(row.path, { downloadAs: row.name });
      return Response.json({ url });
    });
    const ok = await GET_fileUrl(new Request('https://app/api/file?id=r1', { headers: { authorization: 'Bearer 7' } }));
    const { url } = (await ok.json()) as { url: string };
    const dl = await fetch(url);
    expect(dl.status).toBe(200);
    expect(dl.headers.get('content-disposition')).toContain('Q3 Report.bin');
    expect((await GET_fileUrl(new Request('https://app/api/file?id=r1', { headers: { authorization: 'Bearer 8' } }))).status).toBe(404);

    const GET_files = route(async (req: Request) => {
      const user = requireUser(req);
      const cursor = new URL(req.url).searchParams.get('cursor') ?? undefined;
      const page = await priv.list({ prefix: p(`large/${user.id}/`), limit: 100, cursor });
      return Response.json({ blobs: page.blobs, cursor: page.cursor });
    });
    const files = (await (await GET_files(new Request('https://app/api/files', { headers: { authorization: 'Bearer 7' } }))).json()) as { blobs: { path: string }[]; cursor?: string };
    expect(files.blobs.map((b) => b.path)).toEqual([p('large/7/one.bin')]);
    expect(files.cursor).toBeUndefined();

    async function sweepOrphans(owner: string) {
      for (const row of [...rows.values()].filter((r) => r.owner === owner && r.status === 'pending')) {
        const bucket = row.bucket === 'public' ? pub : priv;
        if (await bucket.exists(row.path)) row.status = 'ready';
        else rows.delete(row.id);
      }
    }
    await sweepOrphans('7');
    expect(rows.has('r2')).toBe(false);
    expect(rows.get('r3')!.status).toBe('ready');

    await pub.put(p('chat/7/t1/b.txt'), 'b');
    await pub.del({ prefix: p('chat/7/t1/') });
    expect((await pub.list({ prefix: p('chat/7/') })).blobs).toEqual([]);

    await priv.update<Record<string, unknown>>(p('settings.json'), (prev) => ({ ...(prev ?? {}), theme: 'dark' }), { metadata: { owner: '7' } });
    await priv.update<Record<string, unknown>>(p('settings.json'), (prev) => ({ ...(prev ?? {}), lang: 'tr' }));
    const res = await priv.get(p('settings.json'));
    expect(res.contentType).toBe('application/json');
    const served = new Response(res.body, { headers: { 'content-type': res.contentType } });
    expect(await served.json()).toEqual({ theme: 'dark', lang: 'tr' });
    expect(res.metadata).toEqual({ owner: '7' });

    await priv.copy(p('large/7/one.bin'), p(`archive/${p('large/7/one.bin')}`));
    expect(await priv.exists(p(`archive/${p('large/7/one.bin')}`))).toBe(true);
  });
});
