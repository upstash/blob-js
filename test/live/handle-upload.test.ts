import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import * as z from 'zod';
import { BlobError, handleUpload, uniquePath } from '../../src/index.ts';
import type { WireBeginResponse, WireEndResponse, WirePartsResponse } from '../../src/shared/types.ts';
import { bytes, cleanup, p, PNG, priv, pub, root, sweep } from './setup.ts';

beforeAll(async () => {
  await Promise.all([sweep(pub), sweep(priv)]);
});
afterAll(async () => {
  await Promise.all([cleanup(pub), cleanup(priv)]);
});

const rows: Record<string, { status: string; owner?: string; size?: number }> = {};
let nextRow = 1;
const completed: string[] = [];
let lastChatCompleted: { multipartUploadId: string | undefined } | undefined;
let lastLargeCompleted: { multipartUploadId: string | undefined } | undefined;

const chat = handleUpload({
  bucket: pub,
  limits: { allowedContentTypes: ['image/png', 'image/jpeg', 'image/webp', 'application/pdf'], maxBytes: '20mb' },
  input: z.object({ threadId: z.string().uuid() }),
  onBeforeUpload: async ({ request, file, input }) => {
    const user = request.headers.get('authorization')?.slice(7);
    if (!user) throw new BlobError('unauthorized');
    if (input.threadId.startsWith('00000000')) throw new BlobError('forbidden');
    const path = root + uniquePath`chat/${user}/${input.threadId}/${file.name}`;
    const id = String(nextRow++);
    rows[id] = { status: 'pending', owner: user };
    return { path, cache: 'immutable', metadata: { uploadedBy: user, originalName: file.name }, context: { rowId: id, owner: user } };
  },
  onUploadCompleted: async ({ context, size, multipartUploadId }) => {
    lastChatCompleted = { multipartUploadId };
    rows[context.rowId] = { status: 'ready', owner: context.owner, size };
    return { rowId: context.rowId };
  },
});

const large = handleUpload({
  bucket: priv,
  limits: { maxBytes: '5gb' },
  onBeforeUpload: async ({ file }) => ({ path: p(`large/${crypto.randomUUID()}-${file.name}`), metadata: { originalName: file.name } }),
  onUploadCompleted: async ({ path, size, etag, uploadId, multipartUploadId }) => {
    completed.push(uploadId);
    lastLargeCompleted = { multipartUploadId };
    rows[path] = { status: 'ready', size };
    return etag;
  },
});

const post = (route: { POST: (r: Request) => Promise<Response> }, body: unknown, auth = 'Bearer u1') =>
  route.POST(new Request('https://app.test/api/upload', { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json', authorization: auth } }));

describe('GET', () => {
  test('serves expanded limits, cached for a minute and revalidated', async () => {
    const res = await chat.GET(new Request('https://app.test/api/upload'));
    // Not immutable: the limits are the route's own code, and a deploy changes them.
    expect(res.headers.get('cache-control')).toBe('public, max-age=60');
    const etag = res.headers.get('etag')!;
    expect(etag).toMatch(/^"/);
    expect((await chat.GET(new Request('https://app.test/api/upload', { headers: { 'if-none-match': etag } }))).status).toBe(304);
    expect(await res.json()).toEqual({ limits: { allowedContentTypes: ['image/png', 'image/jpeg', 'image/webp', 'application/pdf'], maxBytes: 20_000_000 } });
    const img = handleUpload({ bucket: pub, limits: { allowedContentTypes: ['image/*'] }, onBeforeUpload: () => ({ path: 'x' }) });
    const limits = (await (await img.GET(new Request('https://x'))).json()).limits;
    expect(limits.allowedContentTypes).toContain('image/png');
    expect(limits.allowedContentTypes).not.toContain('image/svg+xml');
    expect(() => handleUpload({ bucket: pub, limits: { allowedContentTypes: ['*/*'] }, onBeforeUpload: () => ({ path: 'x' }) })).toThrow();
  });
});

describe('begin', () => {
  const tid = '4d4a2a2c-5d6e-4f7a-8b9c-0d1e2f3a4b5c';

  test('rejects before any presign: limits, input, auth, forbidden', async () => {
    const file = { name: 'a.png', type: 'image/png', size: 100 };
    let res = await post(chat, { phase: 'begin', file: { ...file, type: 'text/html' }, input: { threadId: tid } });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('content_type_not_allowed');
    res = await post(chat, { phase: 'begin', file: { ...file, size: 30_000_000 }, input: { threadId: tid } });
    expect(res.status).toBe(413);
    res = await post(chat, { phase: 'begin', file, input: { threadId: 'nope' } });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('invalid_input');
    res = await post(chat, { phase: 'begin', file, input: { threadId: tid } }, '');
    expect(res.status).toBe(401);
    res = await post(chat, { phase: 'begin', file, input: { threadId: '00000000-0000-4000-8000-000000000000' } });
    expect(res.status).toBe(403);
    res = await post(large, { phase: 'begin', file, input: { x: 1 } });
    expect(res.status).toBe(400);
    res = await post(chat, { phase: 'nope' });
    expect(res.status).toBe(400);
    res = await chat.POST(new Request('https://x', { method: 'POST', body: 'not json' }));
    expect(res.status).toBe(400);
  });

  test('single: presigned PUT pins type, length and cache; end sniffs, HEADs and runs the hook', async () => {
    const body = new Uint8Array(new ArrayBuffer(PNG.byteLength + 500));
    body.set(PNG);
    const res = await post(chat, { phase: 'begin', file: { name: 'Holiday Pic.PNG', type: 'image/png', size: body.byteLength }, input: { threadId: tid } });
    expect(res.status).toBe(200);
    const begin = (await res.json()) as WireBeginResponse;
    expect(begin.path).toMatch(new RegExp(`^${p('chat')}/u1/${tid}/holiday-pic-[1-9A-HJ-NP-Za-km-z]{8}\\.png$`));
    expect(begin.upload.kind).toBe('single');
    if (begin.upload.kind !== 'single') throw new Error();
    expect(begin.upload.headers['content-type']).toBe('image/png');
    expect(begin.upload.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    expect(begin.upload.headers['x-amz-meta-originalname']).toBe('Holiday Pic.PNG');
    expect(begin.upload.headers['content-length']).toBeUndefined();
    expect(new URL(begin.upload.url).searchParams.get('X-Amz-SignedHeaders')).toContain('content-length');

    const wrongSize = await fetch(begin.upload.url, { method: 'PUT', headers: begin.upload.headers, body: body.subarray(0, 100) });
    expect(wrongSize.status).toBe(403);
    const wrongType = await fetch(begin.upload.url, { method: 'PUT', headers: { ...begin.upload.headers, 'content-type': 'text/html' }, body });
    expect(wrongType.status).toBe(403);
    const put = await fetch(begin.upload.url, { method: 'PUT', headers: begin.upload.headers, body });
    expect(put.status).toBe(200);

    const endRes = await post(chat, { phase: 'end', completionToken: begin.completionToken });
    expect(endRes.status).toBe(200);
    const end = (await endRes.json()) as WireEndResponse<{ rowId: string }>;
    expect(end.blob.path).toBe(begin.path);
    expect(end.blob.size).toBe(body.byteLength);
    expect(end.blob.etag).toMatch(/^"/);
    expect(end.blob.url).toMatch(/^https:\/\/b[0-9a-f]{11}\.blob\.upstash\.io\//);
    expect(rows[end.data.rowId]).toEqual({ status: 'ready', owner: 'u1', size: body.byteLength });
    const served = await fetch(end.blob.url!);
    expect(served.status).toBe(200);
    // Measured 2026-08-24: the public hostname serves max-age=31536000 but drops the immutable token.
    expect(served.headers.get('cache-control')).toContain('max-age=31536000');
    expect((await pub.info(begin.path)).metadata.uploadedby).toBe('u1');
    expect(lastChatCompleted!.multipartUploadId).toBeUndefined();

    // A fresh single url from phase 'parts': the re-presign path.
    const fresh = await post(chat, { phase: 'parts', completionToken: begin.completionToken, from: 1 });
    expect(fresh.status).toBe(200);
    expect(((await fresh.json()) as WirePartsResponse).kind).toBe('single');
  });

  test('end refuses bytes that lie about their type, a tampered token, and a missing upload', async () => {
    const html = new TextEncoder().encode('<!DOCTYPE html><html><body>x</body></html>');
    const res = await post(chat, { phase: 'begin', file: { name: 'x.png', type: 'image/png', size: html.byteLength }, input: { threadId: tid } });
    const begin = (await res.json()) as WireBeginResponse;
    if (begin.upload.kind !== 'single') throw new Error();
    const missing = await post(chat, { phase: 'end', completionToken: begin.completionToken });
    expect(missing.status).toBe(404);
    expect(rows[String(nextRow - 1)]!.status).toBe('pending');
    expect((await fetch(begin.upload.url, { method: 'PUT', headers: begin.upload.headers, body: html })).status).toBe(200);
    const end = await post(chat, { phase: 'end', completionToken: begin.completionToken });
    expect(end.status).toBe(400);
    expect((await end.json()).code).toBe('content_type_not_allowed');
    expect(rows[String(nextRow - 1)]!.status).toBe('pending');
    // The bytes were already stored and, on a public bucket, already served: refusing them has to
    // mean deleting them.
    expect(await pub.exists(begin.path)).toBe(false);

    const [payload, sig] = begin.completionToken.split('.');
    const tampered = await post(chat, { phase: 'end', completionToken: `${payload}x.${sig}` });
    expect(tampered.status).toBe(403);
    const otherRoute = await post(large, { phase: 'end', completionToken: begin.completionToken });
    expect(otherRoute.status).toBe(403);
  });

  test('multipart: lazy part batches, ListParts on resume, complete at end, cancel aborts', async () => {
    const size = 17_000_000;
    const data = bytes(size, 11);
    const res = await post(large, { phase: 'begin', file: { name: 'big.bin', type: '', size } });
    expect(res.status).toBe(200);
    const begin = (await res.json()) as WireBeginResponse;
    expect(begin.upload.kind).toBe('multipart');
    if (begin.upload.kind !== 'multipart') throw new Error();
    const partSize = 5 * 1024 * 1024;
    expect(begin.upload.partSize).toBe(partSize);
    expect(begin.upload.parts.map((x) => x.n)).toEqual([1, 2, 3, 4]);
    expect(await priv.exists(begin.path)).toBe(false);

    const putPart = async (n: number, url: string) => {
      const chunk = data.subarray((n - 1) * partSize, Math.min(n * partSize, size));
      const r = await fetch(url, { method: 'PUT', body: chunk });
      expect(r.status).toBe(200);
      return { n, etag: r.headers.get('etag')! };
    };
    const short = await fetch(begin.upload.parts[0]!.url, { method: 'PUT', body: data.subarray(0, 10) });
    expect(short.status).toBe(403);
    const p1 = await putPart(1, begin.upload.parts[0]!.url);
    const p3 = await putPart(3, begin.upload.parts[2]!.url);

    const resumeRes = await post(large, { phase: 'parts', completionToken: begin.completionToken, from: 1 });
    const resume = (await resumeRes.json()) as WirePartsResponse;
    if (resume.kind !== 'multipart') throw new Error();
    expect(resume.size).toBe(size);
    expect(resume.landed.map((l) => l.n).sort()).toEqual([1, 3]);
    expect(resume.landed.find((l) => l.n === 1)!.etag).toBe(p1.etag);
    expect(resume.parts.map((x) => x.n)).toEqual([1, 2, 3, 4]);
    const from3 = (await (await post(large, { phase: 'parts', completionToken: begin.completionToken, from: 3 })).json()) as WirePartsResponse;
    if (from3.kind !== 'multipart') throw new Error();
    expect(from3.parts.map((x) => x.n)).toEqual([3, 4]);

    const p2 = await putPart(2, resume.parts[1]!.url);
    const p4 = await putPart(4, resume.parts[3]!.url);
    const badEnd = await post(large, { phase: 'end', completionToken: begin.completionToken, parts: [p1, p2, p3] });
    expect(badEnd.status).toBe(200); // three given, four landed: the server trusts ListParts over the list
    const end = (await badEnd.json()) as WireEndResponse<string>;
    expect(end.blob.size).toBe(size);
    expect(end.blob.etag).toMatch(/-4"$/);
    expect(end.data).toBe(end.blob.etag);
    // A retried 'end' after the object landed answers the same blob with the same uploadId.
    const again = await post(large, { phase: 'end', completionToken: begin.completionToken, parts: [p1, p2, p3, p4] });
    expect(again.status).toBe(200);
    expect(((await again.json()) as WireEndResponse<string>).blob.etag).toBe(end.blob.etag);
    expect(completed.length).toBe(2);
    expect(completed[0]).toBe(completed[1]!);
    expect(completed[0]).toMatch(/^[0-9a-f-]{36}$/);
    // R2's own id, for a bucket.abortMultipart(): not the same id the app dedupes on.
    expect(typeof lastLargeCompleted!.multipartUploadId).toBe('string');
    expect(lastLargeCompleted!.multipartUploadId).not.toBe(completed[0]);
    expect(rows[begin.path]).toEqual({ status: 'ready', size });
    const back = new Uint8Array(await new Response((await priv.get(begin.path)).body).arrayBuffer());
    expect(back.byteLength).toBe(size);
    expect(back.subarray(size - 100)).toEqual(data.subarray(size - 100));

    const res2 = await post(large, { phase: 'begin', file: { name: 'cancel.bin', type: '', size } });
    const begin2 = (await res2.json()) as WireBeginResponse;
    const cancel = await post(large, { phase: 'cancel', completionToken: begin2.completionToken });
    expect(cancel.status).toBe(200);
    const after = await post(large, { phase: 'parts', completionToken: begin2.completionToken, from: 1 });
    expect(after.status).toBe(404);
  });

  test('a completion token is bound to its route, not just to its bucket', async () => {
    const one = handleUpload({ bucket: pub, limits: { maxBytes: '1mb' }, onBeforeUpload: () => ({ path: p('routes/one') }) });
    const two = handleUpload({ bucket: pub, limits: { maxBytes: '2mb' }, onBeforeUpload: () => ({ path: p('routes/two') }) });
    const twin = handleUpload({ bucket: pub, id: 'twin', limits: { maxBytes: '1mb' }, onBeforeUpload: () => ({ path: p('routes/twin') }) });
    const begin = (await (await post(one, { phase: 'begin', file: { name: 'a.bin', type: '', size: 10 } })).json()) as WireBeginResponse;
    expect((await post(two, { phase: 'end', completionToken: begin.completionToken })).status).toBe(403);
    expect((await post(twin, { phase: 'end', completionToken: begin.completionToken })).status).toBe(403);
    // Its own route still takes it: the upload never landed, so 404, not 403.
    expect((await post(one, { phase: 'end', completionToken: begin.completionToken })).status).toBe(404);
  });

  test('onBeforeUpload may narrow limits, never widen them', async () => {
    const narrow = handleUpload({
      bucket: pub,
      limits: { maxBytes: '1mb', allowedContentTypes: ['image/*'] },
      onBeforeUpload: ({ file }) => ({ path: p('n'), limits: file.name === 'wide' ? { maxBytes: '2mb' } : { maxBytes: '10kb', allowedContentTypes: ['image/png'] } }),
    });
    let res = await post(narrow, { phase: 'begin', file: { name: 'a.png', type: 'image/png', size: 20_000 } });
    expect(res.status).toBe(413);
    res = await post(narrow, { phase: 'begin', file: { name: 'a.jpg', type: 'image/jpeg', size: 20 } });
    expect(res.status).toBe(400);
    await expect(post(narrow, { phase: 'begin', file: { name: 'wide', type: 'image/png', size: 20 } })).rejects.toThrow(TypeError);
  });

  test('a non-BlobError thrown by a callback propagates to the framework', async () => {
    const broken = handleUpload({
      bucket: pub,
      onBeforeUpload: () => {
        throw new Error('db down');
      },
    });
    await expect(post(broken, { phase: 'begin', file: { name: 'a', type: '', size: 1 } })).rejects.toThrow('db down');
  });

  test('an incomplete multipart is visible, abortable and sweepable', async () => {
    const size = 17_000_000;
    const begin = (await (await post(large, { phase: 'begin', file: { name: 'orphan.bin', type: '', size } })).json()) as WireBeginResponse;
    // list() cannot see it and neither can the console: this is the invisible billed storage that
    // blocks deleting a bucket.
    expect((await priv.list({ prefix: root })).blobs.some((b) => b.path === begin.path)).toBe(false);
    const open = await priv.listMultipartUploads({ prefix: root });
    const mine = open.find((u) => u.path === begin.path);
    expect(mine).toBeDefined();
    expect(mine!.uploadId.length).toBeGreaterThan(8);
    expect(mine!.initiatedAt.getTime()).toBeGreaterThan(Date.now() - 3_600_000);

    await priv.abortMultipart(mine!.uploadId, mine!.path);
    expect((await priv.listMultipartUploads({ prefix: root })).some((u) => u.path === begin.path)).toBe(false);
    // Aborting twice is not an error: a sweep has to be safe to run again.
    await priv.abortMultipart(mine!.uploadId, mine!.path);

    const second = (await (await post(large, { phase: 'begin', file: { name: 'abandoned.bin', type: '', size } })).json()) as WireBeginResponse;
    expect(await priv.sweepMultipart({ olderThan: '1d', prefix: root })).toEqual([]);
    const reaped = await priv.abortStaleUploads({ olderThan: 0, prefix: root });
    expect(reaped.map((u) => u.path)).toContain(second.path);
    expect(await priv.listMultipartUploads({ prefix: root })).toEqual([]);
  });

  test('exactly 16MB is multipart: 4 parts', async () => {
    const res = await post(large, { phase: 'begin', file: { name: 'edge.bin', type: '', size: 16_000_000 } });
    const begin = (await res.json()) as WireBeginResponse;
    expect(begin.upload.kind).toBe('multipart');
    if (begin.upload.kind !== 'multipart') throw new Error();
    expect(begin.upload.parts.length).toBe(4);
    await post(large, { phase: 'cancel', completionToken: begin.completionToken });
    const under = (await (await post(large, { phase: 'begin', file: { name: 'edge.bin', type: '', size: 15_999_999 } })).json()) as WireBeginResponse;
    expect(under.upload.kind).toBe('single');
  });
});
