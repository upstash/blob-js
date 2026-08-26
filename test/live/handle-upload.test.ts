import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import * as z from 'zod';
import { BlobError, uniquePath, upload, uploadHandler } from '../../src/index.ts';
import type { WireBeginResponse, WireEndResponse, WirePartsResponse } from '../../src/shared/types.ts';
import { bytes, cleanup, p, PNG, priv, pub, root, sweep } from './setup.ts';

beforeAll(async () => {
  await Promise.all([sweep(pub), sweep(priv)]);
});
afterAll(async () => {
  await Promise.all([cleanup(pub), cleanup(priv)]);
});

const rows: Record<string, { status: string; owner?: string; size?: number }> = {};
const completed: string[] = [];
let lastChatCompleted: { route: string; name: string; contentType: string } | undefined;
let lastLargeCompleted: { multipartUploadId: string; name: string; declared: number } | undefined;

// The handler with no `routes` IS the route: no ?route= in the url and no name on the client.
// `context` is written above the callbacks on purpose -- see the ordering rule in handler.ts.
const chat = uploadHandler({
  bucket: pub,
  limits: { allowedContentTypes: ['image/png', 'image/jpeg', 'image/webp', 'application/pdf'], maxBytes: '20mb' },
  context: (request) => {
    const id = request.headers.get('authorization')?.slice(7);
    if (!id) throw new BlobError('unauthorized');
    return { id };
  },
  input: z.object({ threadId: z.string().uuid() }),
  onBeforeUpload: ({ ctx, file, input }) => {
    if (input.threadId.startsWith('00000000')) throw new BlobError('forbidden');
    const path = root + uniquePath`chat/${ctx.id}/${input.threadId}/${file.name}`;
    rows[path] = { status: 'pending', owner: ctx.id };
    return { path, cache: 'immutable', metadata: { uploadedBy: ctx.id, originalName: file.name } };
  },
  onUploadComplete: ({ ctx, route, file, path, size, contentType }) => {
    lastChatCompleted = { route, name: file.name, contentType };
    rows[path] = { status: 'ready', owner: ctx.id, size };
    return { rowId: path };
  },
});

// An `upload()` route is written on its own, not inline in `routes`: inline, TypeScript settles the
// route's transport before it types the callback and `uploadId` stops resolving.
const fileRoute = upload()({
  onBeforeUpload: ({ file }) => ({
    path: p(`large/${crypto.randomUUID()}-${file.name}`),
    metadata: { originalName: file.name },
    state: { declared: file.size },
  }),
  onUploadComplete: ({ path, size, etag, file, state, uploadId, multipartUploadId }) => {
    completed.push(uploadId);
    lastLargeCompleted = { multipartUploadId, name: file.name, declared: state.declared };
    rows[path] = { status: 'ready', size };
    return etag;
  },
});

// `thumb` narrows the handler's maxBytes and inherits the bucket and everything else.
const thumbRoute = upload()({
  limits: { maxBytes: '1mb' },
  onBeforeUpload: ({ file }) => ({ path: p(`thumb/${file.name}`) }),
});

// Two routes at one endpoint, told apart by ?route=.
const large = uploadHandler({
  bucket: priv,
  limits: { maxBytes: '5gb' },
  routes: { file: fileRoute, thumb: thumbRoute },
});

interface Postable {
  POST: (request: Request) => Promise<Response>;
}
const post = (handler: Postable, body: unknown, opts: { route?: string; auth?: string } = {}) =>
  handler.POST(
    new Request(`https://app.test/api/upload${opts.route ? `?route=${opts.route}` : ''}`, {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'content-type': 'application/json', authorization: opts.auth ?? 'Bearer u1' },
    }),
  );
const toFile = (handler: Postable, body: unknown) => post(handler, body, { route: 'file' });

describe('GET', () => {
  test('serves expanded limits, cached for a minute and revalidated', async () => {
    const res = await chat.GET(new Request('https://app.test/api/upload'));
    // Not immutable: the limits are the route's own code, and a deploy changes them.
    expect(res.headers.get('cache-control')).toBe('public, max-age=60');
    const etag = res.headers.get('etag')!;
    expect(etag).toMatch(/^"/);
    expect((await chat.GET(new Request('https://app.test/api/upload', { headers: { 'if-none-match': etag } }))).status).toBe(304);
    expect(await res.json()).toEqual({
      limits: { allowedContentTypes: ['image/png', 'image/jpeg', 'image/webp', 'application/pdf'], maxBytes: 20_000_000 },
      transport: 'direct',
    });
    const img = uploadHandler({ bucket: pub, limits: { allowedContentTypes: ['image/*'] }, onBeforeUpload: () => ({ path: 'x' }) });
    const limits = (await (await img.GET(new Request('https://x'))).json()).limits;
    expect(limits.allowedContentTypes).toContain('image/png');
    expect(limits.allowedContentTypes).not.toContain('image/svg+xml');
    expect(() => uploadHandler({ bucket: pub, limits: { allowedContentTypes: ['*/*'] }, onBeforeUpload: () => ({ path: 'x' }) })).toThrow();
  });

  test('a named handler answers per route, and 404s a name it does not mount', async () => {
    const url = (route?: string) => new Request(`https://app.test/api/upload${route ? `?route=${route}` : ''}`);
    expect((await (await large.GET(url('thumb'))).json()).limits.maxBytes).toBe(1_000_000);
    expect((await (await large.GET(url('file'))).json()).limits.maxBytes).toBe(5_000_000_000);
    // Never the names it does mount, and never a 500: an unknown route is an ordinary 404.
    const missing = await large.GET(url('nope'));
    expect(missing.status).toBe(404);
    expect((await missing.json()).code).toBe('not_found');
    // A named handler is only reachable by name: no ?route= names nothing.
    expect((await large.GET(url())).status).toBe(404);
    expect((await post(large, { phase: 'begin', file: { name: 'a.bin', type: '', size: 10 } }, { route: 'nope' })).status).toBe(404);
  });
});

describe('begin', () => {
  const tid = '4d4a2a2c-5d6e-4f7a-8b9c-0d1e2f3a4b5c';

  test('rejects before any multipart is created: limits, input, auth, forbidden, empty', async () => {
    const file = { name: 'a.png', type: 'image/png', size: 100 };
    let res = await post(chat, { phase: 'begin', file: { ...file, type: 'text/html' }, input: { threadId: tid } });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('content_type_not_allowed');
    res = await post(chat, { phase: 'begin', file: { ...file, size: 30_000_000 }, input: { threadId: tid } });
    expect(res.status).toBe(413);
    res = await post(chat, { phase: 'begin', file, input: { threadId: 'nope' } });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('invalid_input');
    // context runs before the body is read, so a dead session never reaches onBeforeUpload.
    res = await post(chat, { phase: 'begin', file, input: { threadId: tid } }, { auth: '' });
    expect(res.status).toBe(401);
    res = await post(chat, { phase: 'begin', file, input: { threadId: '00000000-0000-4000-8000-000000000000' } });
    expect(res.status).toBe(403);
    // There is no single-PUT path left, so a zero-byte file has no part to send: refused at begin.
    res = await post(chat, { phase: 'begin', file: { ...file, size: 0 }, input: { threadId: tid } });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('empty_body');
    res = await toFile(large, { phase: 'begin', file, input: { x: 1 } });
    expect(res.status).toBe(400);
    res = await post(chat, { phase: 'nope' });
    expect(res.status).toBe(400);
    res = await chat.POST(new Request('https://x', { method: 'POST', body: 'not json', headers: { authorization: 'Bearer u1' } }));
    expect(res.status).toBe(400);
  });

  test('a small file is one part: the object appears at end, sniffed, with the pinned headers', async () => {
    const body = new Uint8Array(new ArrayBuffer(PNG.byteLength + 500));
    body.set(PNG);
    const res = await post(chat, { phase: 'begin', file: { name: 'Holiday Pic.PNG', type: 'image/png', size: body.byteLength }, input: { threadId: tid } });
    expect(res.status).toBe(200);
    const begin = (await res.json()) as WireBeginResponse;
    expect(begin.path).toMatch(new RegExp(`^${p('chat')}/u1/${tid}/holiday-pic-[1-9A-HJ-NP-Za-km-z]{8}\\.png$`));
    // partSizeFor's floor is 5 MiB, so anything under it is exactly one part.
    expect(begin.upload.partSize).toBe(5 * 1024 * 1024);
    expect(begin.upload.parts.map((x) => x.n)).toEqual([1]);
    // Nothing exists until phase 'end' completes the multipart: that is what lets onUploadComplete
    // refuse an object nobody has been able to see.
    expect(await pub.exists(begin.path)).toBe(false);

    // A part url signs content-length and nothing else. Content type, cache-control and the
    // x-amz-meta-* headers were pinned at CreateMultipartUpload, so there is nothing to send here.
    const partUrl = begin.upload.parts[0]!.url;
    expect(new URL(partUrl).searchParams.get('X-Amz-SignedHeaders')).toContain('content-length');
    const wrongSize = await fetch(partUrl, { method: 'PUT', body: body.subarray(0, 100) });
    expect(wrongSize.status).toBe(403);
    const put = await fetch(partUrl, { method: 'PUT', body });
    expect(put.status).toBe(200);
    const etag = put.headers.get('etag')!;

    // Phase 'parts' re-presigns and reports what R2 says landed, at one part as at four.
    const parts = (await (await post(chat, { phase: 'parts', completionToken: begin.completionToken, from: 1 })).json()) as WirePartsResponse;
    expect(parts.size).toBe(body.byteLength);
    expect(parts.partSize).toBe(begin.upload.partSize);
    expect(parts.landed.map((l) => l.n)).toEqual([1]);
    expect(parts.parts.map((x) => x.n)).toEqual([1]);

    const endRes = await post(chat, { phase: 'end', completionToken: begin.completionToken, parts: [{ n: 1, etag }] });
    expect(endRes.status).toBe(200);
    const end = (await endRes.json()) as WireEndResponse<{ rowId: string }>;
    expect(end.blob.path).toBe(begin.path);
    expect(end.blob.size).toBe(body.byteLength);
    expect(end.blob.etag).toMatch(/^"/);
    expect(end.blob.url).toMatch(/^https:\/\/b[0-9a-f]{11}\.blob\.upstash\.io\//);
    expect(end.data.rowId).toBe(begin.path);
    expect(rows[begin.path]).toEqual({ status: 'ready', owner: 'u1', size: body.byteLength });
    // The name the browser declared survives only in the completion token: this is where it lands.
    expect(lastChatCompleted).toEqual({ route: '', name: 'Holiday Pic.PNG', contentType: 'image/png' });

    const served = await fetch(end.blob.url!);
    expect(served.status).toBe(200);
    // Measured 2026-08-24: the public hostname serves max-age=31536000 but drops the immutable token.
    expect(served.headers.get('cache-control')).toContain('max-age=31536000');
    const info = await pub.info(begin.path);
    expect(info.contentType).toBe('image/png');
    expect(info.metadata.uploadedby).toBe('u1');
    expect(info.metadata.originalname).toBe('Holiday Pic.PNG');
  });

  test('end refuses bytes that lie about their type, a tampered token, and a missing upload', async () => {
    const html = new TextEncoder().encode('<!DOCTYPE html><html><body>x</body></html>');
    const res = await post(chat, { phase: 'begin', file: { name: 'x.png', type: 'image/png', size: html.byteLength }, input: { threadId: tid } });
    const begin = (await res.json()) as WireBeginResponse;
    // Nothing has been sent, so there is no part to complete: 'end' has nothing to work with.
    const missing = await post(chat, { phase: 'end', completionToken: begin.completionToken });
    expect(missing.status).toBe(400);
    expect(rows[begin.path]!.status).toBe('pending');

    const put = await fetch(begin.upload.parts[0]!.url, { method: 'PUT', body: html });
    expect(put.status).toBe(200);
    const end = await post(chat, { phase: 'end', completionToken: begin.completionToken, parts: [{ n: 1, etag: put.headers.get('etag')! }] });
    expect(end.status).toBe(400);
    expect((await end.json()).code).toBe('content_type_not_allowed');
    expect(rows[begin.path]!.status).toBe('pending');
    // The parts were completed into an object a moment ago and, on a public bucket, it was served
    // from that moment: refusing the bytes has to mean deleting them.
    expect(await pub.exists(begin.path)).toBe(false);

    const [payload, sig] = begin.completionToken.split('.');
    const tampered = await post(chat, { phase: 'end', completionToken: `${payload}x.${sig}` });
    expect(tampered.status).toBe(403);
    const otherRoute = await toFile(large, { phase: 'end', completionToken: begin.completionToken });
    expect(otherRoute.status).toBe(403);
  });

  test('onUploadComplete throwing takes the object with it', async () => {
    const path = p('rollback/receipt.png');
    const refuses = uploadHandler({
      bucket: pub,
      limits: { maxBytes: '1mb' },
      onBeforeUpload: () => ({ path }),
      onUploadComplete: () => {
        throw new BlobError('forbidden', { message: 'the row this file belongs to is gone' });
      },
    });
    const body = new Uint8Array(new ArrayBuffer(PNG.byteLength + 40));
    body.set(PNG);
    const begin = (await (await post(refuses, { phase: 'begin', file: { name: 'receipt.png', type: 'image/png', size: body.byteLength } })).json()) as WireBeginResponse;
    const put = await fetch(begin.upload.parts[0]!.url, { method: 'PUT', body });
    expect(put.status).toBe(200);
    const end = await post(refuses, { phase: 'end', completionToken: begin.completionToken, parts: [{ n: 1, etag: put.headers.get('etag')! }] });
    expect(end.status).toBe(403);
    // The invariant the app gets to rely on: the object exists if and only if onUploadComplete
    // returned, so a failed insert never leaves a file nothing points at.
    expect(await pub.exists(path)).toBe(false);
  });

  test('many parts: lazy batches, ListParts on resume, complete at end, cancel aborts', async () => {
    const size = 17_000_000;
    const data = bytes(size, 11);
    const res = await toFile(large, { phase: 'begin', file: { name: 'big.bin', type: '', size } });
    expect(res.status).toBe(200);
    const begin = (await res.json()) as WireBeginResponse;
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

    const resumeRes = await toFile(large, { phase: 'parts', completionToken: begin.completionToken, from: 1 });
    const resume = (await resumeRes.json()) as WirePartsResponse;
    expect(resume.size).toBe(size);
    expect(resume.landed.map((l) => l.n).sort()).toEqual([1, 3]);
    expect(resume.landed.find((l) => l.n === 1)!.etag).toBe(p1.etag);
    expect(resume.parts.map((x) => x.n)).toEqual([1, 2, 3, 4]);
    const from3 = (await (await toFile(large, { phase: 'parts', completionToken: begin.completionToken, from: 3 })).json()) as WirePartsResponse;
    expect(from3.parts.map((x) => x.n)).toEqual([3, 4]);

    const p2 = await putPart(2, resume.parts[1]!.url);
    const p4 = await putPart(4, resume.parts[3]!.url);
    const badEnd = await toFile(large, { phase: 'end', completionToken: begin.completionToken, parts: [p1, p2, p3] });
    expect(badEnd.status).toBe(200); // three given, four landed: the server trusts ListParts over the list
    const end = (await badEnd.json()) as WireEndResponse<string>;
    expect(end.blob.size).toBe(size);
    expect(end.blob.etag).toMatch(/-4"$/);
    expect(end.data).toBe(end.blob.etag);
    // A retried 'end' after the object landed answers the same blob with the same uploadId.
    const again = await toFile(large, { phase: 'end', completionToken: begin.completionToken, parts: [p1, p2, p3, p4] });
    expect(again.status).toBe(200);
    expect(((await again.json()) as WireEndResponse<string>).blob.etag).toBe(end.blob.etag);
    expect(completed.length).toBe(2);
    expect(completed[0]).toBe(completed[1]!);
    expect(completed[0]).toMatch(/^[0-9a-f-]{36}$/);
    // R2's own id, for a bucket.abortMultipart(): not the same id the app dedupes on.
    expect(lastLargeCompleted!.multipartUploadId.length).toBeGreaterThan(8);
    expect(lastLargeCompleted!.multipartUploadId).not.toBe(completed[0]);
    // file and state both crossed in the completion token and came back untouched.
    expect(lastLargeCompleted!.name).toBe('big.bin');
    expect(lastLargeCompleted!.declared).toBe(size);
    expect(rows[begin.path]).toEqual({ status: 'ready', size });
    const back = new Uint8Array(await new Response((await priv.get(begin.path)).body).arrayBuffer());
    expect(back.byteLength).toBe(size);
    expect(back.subarray(size - 100)).toEqual(data.subarray(size - 100));

    const res2 = await toFile(large, { phase: 'begin', file: { name: 'cancel.bin', type: '', size } });
    const begin2 = (await res2.json()) as WireBeginResponse;
    const cancel = await toFile(large, { phase: 'cancel', completionToken: begin2.completionToken });
    expect(cancel.status).toBe(200);
    const after = await toFile(large, { phase: 'parts', completionToken: begin2.completionToken, from: 1 });
    expect(after.status).toBe(404);
  });

  test('routes at one endpoint are told apart by name, in the limits and in the token', async () => {
    const file = { name: 'shot.bin', type: '', size: 5_000_000 };
    // thumb narrowed maxBytes to 1mb; file inherited the handler's 5gb. Same handler, same bucket.
    expect((await post(large, { phase: 'begin', file }, { route: 'thumb' })).status).toBe(413);
    const begin = (await (await toFile(large, { phase: 'begin', file })).json()) as WireBeginResponse;
    expect(begin.path).toContain('/large/');
    // The route name is part of the completion token's route id, so a sibling cannot spend it.
    expect((await post(large, { phase: 'end', completionToken: begin.completionToken }, { route: 'thumb' })).status).toBe(403);
    expect((await toFile(large, { phase: 'cancel', completionToken: begin.completionToken })).status).toBe(200);
  });

  test('a completion token is bound to its handler, not just to its bucket', async () => {
    const one = uploadHandler({ bucket: pub, limits: { maxBytes: '1mb' }, onBeforeUpload: () => ({ path: p('routes/one') }) });
    const two = uploadHandler({ bucket: pub, limits: { maxBytes: '2mb' }, onBeforeUpload: () => ({ path: p('routes/two') }) });
    // Same bucket, same limits, same (empty) route name: `endpoint` is the only thing separating
    // them, and it has to be enough.
    const twin = uploadHandler({ bucket: pub, endpoint: '/api/twin', limits: { maxBytes: '1mb' }, onBeforeUpload: () => ({ path: p('routes/twin') }) });
    const begin = (await (await post(one, { phase: 'begin', file: { name: 'a.bin', type: '', size: 10 } })).json()) as WireBeginResponse;
    expect((await post(two, { phase: 'end', completionToken: begin.completionToken })).status).toBe(403);
    expect((await post(twin, { phase: 'end', completionToken: begin.completionToken })).status).toBe(403);
    // Its own handler takes the token: nothing was sent, so it fails on the parts, not on the grant.
    const own = await post(one, { phase: 'end', completionToken: begin.completionToken });
    expect(own.status).toBe(400);
    expect((await own.json()).code).toBe('invalid_input');
    expect((await post(one, { phase: 'cancel', completionToken: begin.completionToken })).status).toBe(200);
  });

  test('onBeforeUpload may narrow limits, never widen them', async () => {
    const narrow = uploadHandler({
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
    const broken = uploadHandler({
      bucket: pub,
      onBeforeUpload: () => {
        throw new Error('db down');
      },
    });
    await expect(post(broken, { phase: 'begin', file: { name: 'a', type: '', size: 1 } })).rejects.toThrow('db down');
  });

  test('an incomplete multipart is visible, abortable and sweepable', async () => {
    const size = 17_000_000;
    const begin = (await (await toFile(large, { phase: 'begin', file: { name: 'orphan.bin', type: '', size } })).json()) as WireBeginResponse;
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

    const second = (await (await toFile(large, { phase: 'begin', file: { name: 'abandoned.bin', type: '', size } })).json()) as WireBeginResponse;
    expect(await priv.sweepMultipart({ olderThan: '1d', prefix: root })).toEqual([]);
    const reaped = await priv.abortStaleUploads({ olderThan: 0, prefix: root });
    expect(reaped.map((u) => u.path)).toContain(second.path);
    expect(await priv.listMultipartUploads({ prefix: root })).toEqual([]);
  });
});
