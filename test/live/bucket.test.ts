import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { S3Client, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { BlobError } from '../../src/index.ts';
import { r2Of } from '../../src/server/bucket.ts';
import { bytes, cleanup, p, PNG, priv, pub, root, sweep } from './setup.ts';

beforeAll(async () => {
  await Promise.all([sweep(pub), sweep(priv)]);
});
afterAll(async () => {
  await Promise.all([cleanup(pub), cleanup(priv)]);
});

describe('put', () => {
  test('bytes, then get/info/exists', async () => {
    const blob = await pub.put(p('a.txt'), 'hello', { contentType: 'text/plain', metadata: { uploadedBy: 'u1' } });
    expect(blob.path).toBe(p('a.txt'));
    expect(blob.size).toBe(5);
    expect(blob.etag).toMatch(/^"[0-9a-f]{32}"$/);
    expect(blob.url).toMatch(/^https:\/\/b[0-9a-f]{11}\.blob\.upstash\.io\/test\//);
    expect(blob.versionedUrl).toBe(`${blob.url}?v=${encodeURIComponent(blob.etag)}`);
    expect(blob.uploadedAt).toBeInstanceOf(Date);

    const got = await pub.get(p('a.txt'));
    expect(await new Response(got.body).text()).toBe('hello');
    expect(got.contentType).toBe('text/plain');
    expect(got.metadata.uploadedby).toBe('u1');
    expect(got.etag).toBe(blob.etag);

    const info = await pub.info(p('a.txt'));
    expect(info.size).toBe(5);
    expect(info.metadata.uploadedby).toBe('u1');
    expect(await pub.exists(p('a.txt'))).toBe(true);
    expect(await pub.exists(p('nope'))).toBe(false);
  });

  test('public url serves the object with the chosen cache-control', async () => {
    const blob = await pub.put(p('served.txt'), 'served', { contentType: 'text/plain', cache: '1m' });
    const res = await fetch(blob.url!);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('served');
    expect(res.headers.get('cache-control')).toContain('max-age=60');
  });

  test('File carries type and size; sniff accepts matching bytes', async () => {
    const file = new File([PNG as BlobPart], 'x.png', { type: 'image/png' });
    const blob = await pub.put(p('x.png'), file, { contentTypes: ['image/*'], maxSize: '2mb' });
    expect(blob.size).toBe(PNG.byteLength);
    expect((await pub.info(p('x.png'))).contentType).toBe('image/png');
  });

  test('sniff rejects lying bytes and disallowed declarations', async () => {
    // Only a closed signature is a lie the SDK will name. A type with no magic number -- html, svg,
    // plain text -- is a gap in the table rather than a check, and the declaration stands.
    const zip = new File([new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00])], 'x.png', { type: 'image/png' });
    await expect(pub.put(p('lie.png'), zip, { contentTypes: ['image/png'] })).rejects.toMatchObject({ code: 'content_type_not_allowed' });
    const svg = new File(['<svg/>'], 'x.svg', { type: 'image/svg+xml' });
    await expect(pub.put(p('x.svg'), svg, { contentTypes: ['image/*'] })).rejects.toMatchObject({ code: 'content_type_not_allowed' });
    expect(() => pub.put(p('x'), 'x', { contentTypes: ['*/*'] })).toThrow();
    await expect(pub.put(p('x'), 'x', { contentTypes: [] })).rejects.toMatchObject({ code: 'invalid_content_type_pattern' });
    expect(await pub.exists(p('lie.png'))).toBe(false);
  });

  test('maxSize rejects up front and while streaming', async () => {
    await expect(pub.put(p('big'), bytes(3000), { maxSize: '2kb' })).rejects.toMatchObject({ code: 'too_large', status: 413 });
    const lying = new Request('https://x/', { method: 'POST', body: bytes(3000), headers: { 'content-length': '1000', 'content-type': 'application/octet-stream' } });
    await expect(pub.put(p('lying'), lying, { maxSize: '2kb' })).rejects.toMatchObject({ code: 'too_large' });
  });

  test('Request body streams with content-length; empty body and unknown length are errors', async () => {
    const body = bytes(70_000, 7);
    const req = new Request('https://x/', { method: 'POST', body, headers: { 'content-type': 'application/octet-stream' } });
    const blob = await pub.put(p('req.bin'), req, { contentTypes: ['application/octet-stream'], maxSize: '1mb' });
    expect(blob.size).toBe(70_000);
    const back = new Uint8Array(await new Response((await pub.get(p('req.bin'))).body).arrayBuffer());
    expect(back).toEqual(body);

    await expect(pub.put(p('empty'), new Request('https://x/', { method: 'POST' }))).rejects.toMatchObject({ code: 'empty_body' });
    const stream = new Blob([bytes(10)]).stream();
    await expect(pub.put(p('nolen'), stream)).rejects.toMatchObject({ code: 'length_required', status: 411 });
  });

  test('unknown length buffers under maxSize; explicit size streams', async () => {
    const data = bytes(5000, 3);
    const chunked = new Request('https://x/', { method: 'POST', body: new Blob([data]).stream(), duplex: 'half' } as RequestInit);
    chunked.headers.delete('content-length');
    const blob = await pub.put(p('chunked'), chunked, { maxSize: '10kb' });
    expect(blob.size).toBe(5000);
    const sized = await pub.put(p('sized'), new Blob([data]).stream(), { size: 5000 });
    expect(sized.size).toBe(5000);
  });

  test('allowOverwrite: false and ifUnchanged', async () => {
    const first = await pub.put(p('once'), 'one');
    const err = await pub.put(p('once'), 'two', { allowOverwrite: false }).catch((e) => e);
    expect(BlobError.is(err)).toBe(true);
    expect(err.code).toBe('already_exists');
    expect(err.status).toBe(409);
    expect(err.etag).toBe(first.etag);
    expect(err.size).toBe(3);

    await expect(pub.put(p('once'), 'three', { ifUnchanged: '"deadbeef"' })).rejects.toMatchObject({ code: 'conflict' });
    const ok = await pub.put(p('once'), 'four', { ifUnchanged: first.etag });
    expect(ok.size).toBe(4);
  });
});

describe('read', () => {
  test('not_found surfaces as 404', async () => {
    await expect(pub.get(p('missing'))).rejects.toMatchObject({ code: 'not_found', status: 404 });
    await expect(pub.info(p('missing'))).rejects.toMatchObject({ code: 'not_found' });
  });

  test('list pages with a cursor and stops on undefined', async () => {
    await Promise.all([1, 2, 3].map((i) => priv.put(p(`list/${i}.txt`), `n${i}`)));
    const page1 = await priv.list({ prefix: p('list/'), limit: 2 });
    expect(page1.blobs.length).toBe(2);
    expect(page1.cursor).toBeDefined();
    expect(page1.blobs[0]!.etag).toMatch(/^"/);
    expect(page1.blobs[0]!.uploadedAt.getTime()).toBeGreaterThan(Date.now() - 600_000);
    const page2 = await priv.list({ prefix: p('list/'), limit: 2, cursor: page1.cursor });
    expect(page2.blobs.length).toBe(1);
    expect(page2.cursor).toBeUndefined();
  });

  test('signedReadUrl serves the private object, with a download name and an expiry it can prove', async () => {
    await priv.put(p('secret.txt'), 'shh', { contentType: 'text/plain' });
    // Measured 2026-08-25: the agent serves one credential until it is nearly out, so the cap is
    // anywhere from ~30 s to ~10 min. Ask for something it can cover.
    const cap = await r2Of(priv).readCap();
    expect(cap).toBeGreaterThanOrEqual(30);
    const asked = Math.min(120, cap);
    const read = await priv.signedReadUrl(p('secret.txt'), { expiresIn: asked, downloadAs: 'Report Q3.txt' });
    expect(Number(new URL(read.url).searchParams.get('X-Amz-Expires'))).toBe(asked);
    // expiresAt is the truth, including when the current credential shortened what was requested.
    expect(read.expiresAt.getTime()).toBeGreaterThan(Date.now() + (asked - 10) * 1000);
    const res = await fetch(read.url);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('shh');
    expect(res.headers.get('content-disposition')).toContain('Report Q3.txt');
    const plain = await fetch((await priv.signedReadUrl(p('secret.txt'))).url);
    expect(plain.status).toBe(200);
    expect(plain.headers.get('content-disposition')).toBeNull();
    const tampered = await fetch(read.url.replace('secret.txt', 'other.txt'));
    expect(tampered.status).toBe(403);
  });

  test('signedUploadUrl writes one object, pins its headers, and refuses a body it did not sign', async () => {
    const up = await priv.signedUploadUrl(p('signed-up.txt'), {
      contentType: 'text/plain',
      metadata: { owner: 'u7' },
      size: 5,
      expiresIn: 120,
    });
    expect(up.expiresAt.getTime()).toBeGreaterThan(Date.now());
    expect(up.headers['content-type']).toBe('text/plain');
    expect(up.headers['x-amz-meta-owner']).toBe('u7');

    // A header the signature pinned cannot be dropped or changed by whoever holds the url.
    const bare = await fetch(up.url, { method: 'PUT', body: 'hello' });
    expect(bare.status).toBe(403);
    const swapped = await fetch(up.url, { method: 'PUT', headers: { ...up.headers, 'content-type': 'text/html' }, body: 'hello' });
    expect(swapped.status).toBe(403);
    // ...and content-length is pinned, so the url is good for five bytes and nothing else.
    const wrongSize = await fetch(up.url, { method: 'PUT', headers: up.headers, body: 'hello world' });
    expect(wrongSize.ok).toBe(false);

    const res = await fetch(up.url, { method: 'PUT', headers: up.headers, body: 'hello' });
    expect(res.status).toBe(200);
    const info = await priv.info(p('signed-up.txt'));
    expect(info.size).toBe(5);
    expect(info.contentType).toBe('text/plain');
    expect(info.metadata.owner).toBe('u7');
  });

  test('signedUploadUrl with allowOverwrite: false refuses a path that is already taken', async () => {
    await priv.put(p('taken.txt'), 'first', { contentType: 'text/plain' });
    const up = await priv.signedUploadUrl(p('taken.txt'), { contentType: 'text/plain', allowOverwrite: false });
    const res = await fetch(up.url, { method: 'PUT', headers: up.headers, body: 'second' });
    expect(res.status).toBe(412);
    expect(await (await priv.get(p('taken.txt'))).body.getReader().read().then((r) => new TextDecoder().decode(r.value))).toBe('first');
  });

  test('an expiresIn over the credential cap is shortened transparently', async () => {
    await priv.put(p('capped.txt'), 'shh', { contentType: 'text/plain' });
    const cap = await r2Of(priv).readCap();
    const capped = await priv.signedReadUrl(p('capped.txt'), { expiresIn: '1h' });
    expect(Number(new URL(capped.url).searchParams.get('X-Amz-Expires'))).toBeLessThanOrEqual(cap + 2);
    expect((await fetch(capped.url)).status).toBe(200);
  });
});

describe('large put', () => {
  test('a body over 16MB goes up in parts and leaves no incomplete upload behind', async () => {
    const size = 17_000_000;
    const data = bytes(size, 21);
    const blob = await priv.put(p('multipart/big.bin'), data, { contentType: 'application/octet-stream' });
    expect(blob.size).toBe(size);
    // A multipart etag names its part count; a single PUT's is a plain md5.
    expect(blob.etag).toMatch(/-4"$/);
    expect(await priv.listMultipartUploads({ prefix: p('multipart/') })).toEqual([]);
    const back = new Uint8Array(await new Response((await priv.get(p('multipart/big.bin'))).body).arrayBuffer());
    expect(back.byteLength).toBe(size);
    expect(back.subarray(0, 64)).toEqual(data.subarray(0, 64));
    expect(back.subarray(size - 64)).toEqual(data.subarray(size - 64));
    expect((await priv.info(p('multipart/big.bin'))).contentType).toBe('application/octet-stream');

    // A conditional write cannot be multipart, so it stays one PUT and still enforces the condition.
    const once = await priv.put(p('multipart/cond.bin'), data, { allowOverwrite: false });
    expect(once.etag).not.toMatch(/-\d+"$/);
    await expect(priv.put(p('multipart/cond.bin'), data, { allowOverwrite: false })).rejects.toMatchObject({ code: 'already_exists' });
  }, 300_000);
});

describe('metadata and guards', () => {
  test('metadata storage would not hand back unchanged is refused before the request', async () => {
    for (const note of ['done ✅', 'café']) {
      const e = await pub.put(p('meta-bad.txt'), 'x', { metadata: { note } }).catch((x) => x);
      expect(BlobError.is(e)).toBe(true);
      expect(e.code).toBe('invalid_input');
      expect(e.status).toBe(400);
      expect(await pub.exists(p('meta-bad.txt'))).toBe(false);
    }
    // Percent-encoding is the documented way through, and it round trips exactly.
    const blob = await pub.put(p('meta-ok.txt'), 'x', { contentType: 'text/plain', metadata: { note: encodeURIComponent('café') } });
    expect(blob.contentType).toBe('text/plain');
    expect(decodeURIComponent((await pub.info(p('meta-ok.txt'))).metadata.note!)).toBe('café');
  });

  test("del({ prefix: '' }) refuses to mean the whole bucket by accident", async () => {
    const e = await pub.del({ prefix: '' }).catch((x) => x);
    expect(BlobError.is(e)).toBe(true);
    expect(e.code).toBe('invalid_input');
    // The objects this run wrote are still there.
    expect((await pub.list({ prefix: root })).blobs.length).toBeGreaterThan(0);
  });

  test('put answers the content type it stored', async () => {
    const png = await pub.put(p('typed.png'), PNG as BlobPart, { contentType: 'image/png' });
    expect(png.contentType).toBe('image/png');
    expect((await pub.info(p('typed.png'))).contentType).toBe('image/png');
    expect((await pub.put(p('typed.bin'), 'x')).contentType).toBe('application/octet-stream');
  });
});

describe('write verbs', () => {
  test('copy, move, move_left_a_copy never loses data', async () => {
    await priv.put(p('src.txt'), 'copyme', { contentType: 'text/plain' });
    const copied = await priv.copy(p('src.txt'), p('archive/src.txt'));
    expect(copied.size).toBe(6);
    expect(await priv.exists(p('src.txt'))).toBe(true);
    const moved = await priv.move(p('src.txt'), p('moved.txt'));
    expect(moved.path).toBe(p('moved.txt'));
    expect(await priv.exists(p('src.txt'))).toBe(false);
    await expect(priv.copy(p('missing'), p('x'))).rejects.toMatchObject({ code: 'not_found' });
    await expect(priv.copy(p('missing'), p('x'), { cache: '1m' })).rejects.toMatchObject({ code: 'not_found' });
  });

  test('copy options: one given, the other two carried over from the source', async () => {
    await priv.put(p('c/src.txt'), 'copyme', { contentType: 'text/plain', metadata: { origin: 'src' } });
    await priv.copy(p('c/src.txt'), p('c/typed.md'), { contentType: 'text/markdown' });
    const typed = await priv.info(p('c/typed.md'));
    expect(typed.contentType).toBe('text/markdown');
    expect(typed.metadata).toEqual({ origin: 'src' });
    await priv.move(p('c/typed.md'), p('c/owned.md'), { metadata: { owner: 'u7' } });
    const owned = await priv.info(p('c/owned.md'));
    expect(owned.contentType).toBe('text/markdown');
    expect(owned.metadata).toEqual({ owner: 'u7' });
    expect(await priv.exists(p('c/typed.md'))).toBe(false);
  });

  test('del: one path, a list, a prefix; partial_delete carries failed', async () => {
    await Promise.all(['d/1', 'd/2', 'd/3', 'e/1'].map((k) => pub.put(p(k), 'x')));
    await pub.del(p('e/1'));
    await pub.del(p('e/1'));
    expect(await pub.exists(p('e/1'))).toBe(false);
    await pub.del([p('d/1'), p('d/2')]);
    expect((await pub.list({ prefix: p('d/') })).blobs.map((b) => b.path)).toEqual([p('d/3')]);
    await pub.del({ prefix: p('d/') });
    expect((await pub.list({ prefix: p('d/') })).blobs.length).toBe(0);
    await expect(pub.del([p('d/1'), '../x'])).rejects.toThrow();
  });

  test('update: create-if-absent then CAS', async () => {
    await priv.updateJson<Record<string, unknown>>(p('settings.json'), (prev) => ({ ...(prev ?? {}), a: 1 }));
    await priv.updateJson<Record<string, unknown>>(p('settings.json'), (prev) => ({ ...(prev ?? {}), b: 2 }));
    const got = await priv.get(p('settings.json'));
    expect(got.contentType).toBe('application/json');
    expect(await new Response(got.body).json()).toEqual({ a: 1, b: 2 });

    let calls = 0;
    await priv.updateJson<Record<string, unknown>>(p('settings.json'), async (prev) => {
      calls++;
      if (calls === 1) await priv.put(p('settings.json'), JSON.stringify({ ...prev, raced: true }), { contentType: 'application/json' });
      return { ...(prev ?? {}), c: 3 };
    });
    expect(calls).toBe(2);

    // Metadata survives an update unless given; five conflicts in a row still land on the sixth try.
    await priv.put(p('meta.json'), '{"n":0}', { contentType: 'application/json', metadata: { owner: 'u9' } });
    let races = 0;
    await priv.updateJson<{ n: number }>(p('meta.json'), async (prev) => {
      if (races < 5) {
        races++;
        await priv.put(p('meta.json'), JSON.stringify({ n: -races }), { contentType: 'application/json', metadata: { owner: 'u9' } });
      }
      return { n: (prev?.n ?? 0) + 1 };
    });
    expect(races).toBe(5);
    const meta = await priv.get(p('meta.json'));
    expect(meta.metadata).toEqual({ owner: 'u9' });
    expect(await new Response(meta.body).json()).toEqual({ n: -4 });
    await priv.updateJson(p('meta.json'), () => ({ n: 9 }), { metadata: { owner: 'u10' } });
    expect((await priv.info(p('meta.json'))).metadata).toEqual({ owner: 'u10' });
    let always = 0;
    await expect(
      priv.updateJson<{ n: number }>(p('meta.json'), async () => {
        always++;
        await priv.put(p('meta.json'), JSON.stringify({ n: always }), { contentType: 'application/json' });
        return { n: 0 };
      }),
    ).rejects.toMatchObject({ code: 'conflict' });
    expect(always).toBe(6);
    expect(await new Response((await priv.get(p('settings.json'))).body).json()).toEqual({ a: 1, b: 2, raced: true, c: 3 });
  });
});

describe('s3()', () => {
  test('config drives the aws sdk', async () => {
    await priv.put(p('s3/one.txt'), 'x');
    const cfg = priv.s3();
    expect((await cfg.endpoint()).url.hostname).toMatch(/^[a-z0-9]+\.r2\.cloudflarestorage\.com$/);
    const s3 = new S3Client(cfg);
    const out = await s3.send(new ListObjectsV2Command({ Bucket: cfg.bucket, Prefix: p('s3/'), MaxKeys: 10 }));
    expect(out.Contents?.map((c) => c.Key)).toEqual([p('s3/one.txt')]);
    const creds = await cfg.credentials();
    expect(creds.expiration.getTime()).toBeGreaterThan(Date.now());
    expect(root.startsWith('test/')).toBe(true);
  });
});
