import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { Bucket, BlobError, handleProxyUpload, handleUpload } from '../../src/index.ts';
import { resetCredentialCaches } from '../../src/server/credentials.ts';
import { deriveRouteId } from '../../src/server/handle-upload.ts';
import { encodeToken } from '../../src/server/token.ts';
import type { WireBeginResponse } from '../../src/shared/types.ts';

// The server path against a scripted R2: what a live bucket cannot be made to do on purpose (expire
// a credential mid-request, answer 503 three times, refuse a create) is exactly what needs proving.

const TOKEN = encodeToken('bucket-id', 'pw-secret', 'b0123456789a');
const OTHER_TOKEN = encodeToken('bucket-id', 'pw-secret', 'bffffffffffe');
const ENDPOINT = 'https://acc.r2.cloudflarestorage.com';

interface Call {
  method: string;
  url: string;
  headers: Headers;
  init: RequestInit;
}

const realFetch = globalThis.fetch;
let calls: Call[] = [];
let mints = 0;
let mintResponse: () => Response;
let r2Handler: (call: Call) => Response | Promise<Response>;

function creds(extra: Record<string, unknown> = {}, ttl = 600): Record<string, unknown> {
  return {
    accessKeyId: 'AKIAOBJECT',
    secretAccessKey: 'sk',
    sessionToken: 'st',
    endpoint: ENDPOINT,
    bucket: 'bkt',
    region: 'auto',
    expiresAt: Math.floor(Date.now() / 1000) + ttl,
    ...extra,
  };
}

const mockFetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const call: Call = { method: (init.method ?? 'GET').toUpperCase(), url, headers: new Headers(init.headers), init };
  calls.push(call);
  if (url.includes('/v1/credentials')) {
    mints++;
    return mintResponse();
  }
  if (url.startsWith(ENDPOINT)) return r2Handler(call);
  return realFetch(input as RequestInfo, init);
}) as typeof fetch;

// Installed in beforeAll, never at module scope: bun imports every test file before running any of
// them, so a global replaced at import time is what a sibling file captures as "the real fetch".
beforeAll(() => {
  globalThis.fetch = mockFetch;
});

afterAll(() => {
  globalThis.fetch = realFetch;
});

beforeEach(() => {
  calls = [];
  mints = 0;
  mintResponse = () => Response.json(creds());
  r2Handler = () => new Response('', { status: 200 });
});

const bucket = () => new Bucket({ token: TOKEN });
const r2Calls = () => calls.filter((c) => c.url.startsWith(ENDPOINT));

describe('credential cache', () => {
  test('is keyed by token, so a per-request fromEnv() does not mint per request', async () => {
    resetCredentialCaches();
    await new Bucket({ token: TOKEN }).exists('a');
    await new Bucket({ token: TOKEN }).exists('b');
    expect(mints).toBe(1);
    await new Bucket({ token: OTHER_TOKEN }).exists('c');
    expect(mints).toBe(2);
  });

  test('the mint request carries a timeout, so a hung agent does not hang the route', async () => {
    resetCredentialCaches();
    await bucket().exists('a');
    const mint = calls.find((c) => c.url.includes('/v1/credentials'))!;
    expect(mint.init.signal).toBeInstanceOf(AbortSignal);
  });

  test('a Retry-After longer than a request can wait is an error, not a 30 s stall', async () => {
    resetCredentialCaches();
    mintResponse = () => new Response('', { status: 429, headers: { 'retry-after': '45' } });
    const e = await bucket()
      .exists('a')
      .catch((x) => x);
    expect(BlobError.is(e)).toBe(true);
    expect(e.code).toBe('mint_backoff');
    expect(e.status).toBe(429);
    expect(e.retryAfter).toBe(45);
    expect(BlobError.fromJSON(e.toJSON())!.retryAfter).toBe(45);
    expect(mints).toBe(1);
  });
});

describe('r2 retries', () => {
  test('an idempotent verb is retried on 503 and 429', async () => {
    resetCredentialCaches();
    let n = 0;
    r2Handler = () => {
      n++;
      if (n === 1) return new Response('<Error/>', { status: 503 });
      if (n === 2) return new Response('<Error/>', { status: 429, headers: { 'retry-after': '0' } });
      return new Response('', { status: 200, headers: { 'content-length': '3', etag: '"e"' } });
    };
    expect(await bucket().exists('a.txt')).toBe(true);
    expect(r2Calls().length).toBe(3);
  });

  test('it gives up after three, and a non-idempotent POST is never retried', async () => {
    resetCredentialCaches();
    r2Handler = () => new Response('<Error><Code>InternalError</Code></Error>', { status: 500 });
    await expect(bucket().exists('a.txt')).rejects.toMatchObject({ code: 'request_failed' });
    expect(r2Calls().length).toBe(3);

    calls = [];
    await expect(bucket().del(['a.txt', 'b.txt'])).rejects.toMatchObject({ code: 'request_failed' });
    expect(r2Calls().length).toBe(1);
  });

  test('a 403 that names the credential re-mints once and retries, then reads as unauthorized', async () => {
    resetCredentialCaches();
    const expired = '<Error><Code>ExpiredToken</Code><Message>token expired</Message></Error>';
    let n = 0;
    r2Handler = () => {
      n++;
      if (n === 1) return new Response(expired, { status: 403 });
      return new Response('body', { status: 200, headers: { 'content-length': '4', etag: '"e"', 'content-type': 'text/plain' } });
    };
    await bucket().get('a.txt');
    expect(mints).toBe(2);
    expect(r2Calls().length).toBe(2);

    calls = [];
    r2Handler = () => new Response(expired, { status: 403 });
    const e = await bucket()
      .get('a.txt')
      .catch((x) => x);
    expect(e.code).toBe('unauthorized');
    // Once. A credential that is refused twice is not a stale one.
    expect(r2Calls().length).toBe(2);
  });

  test('a plain 403 is still a signature mismatch and is not retried', async () => {
    resetCredentialCaches();
    r2Handler = () => new Response('<Error><Code>SignatureDoesNotMatch</Code></Error>', { status: 403 });
    await expect(bucket().exists('a.txt')).rejects.toMatchObject({ code: 'signature_mismatch' });
    expect(r2Calls().length).toBe(1);
  });
});

describe('signedRead', () => {
  test('answers a url and when it dies, and refuses an ask over the cap', async () => {
    resetCredentialCaches();
    const b = bucket();
    const read = await b.signedRead('secret.txt', { expiresIn: '2m' });
    expect(read.url).toContain('X-Amz-Expires=120');
    expect(read.expiresAt.getTime()).toBeGreaterThan(Date.now() + 110_000);
    expect(read.expiresAt.getTime()).toBeLessThan(Date.now() + 130_000);
    const cap = await b.signedReadCap();
    expect(cap).toBeGreaterThanOrEqual(595);
    expect(cap).toBeLessThanOrEqual(600);
    expect(mints).toBe(1);

    const e = await b.signedRead('secret.txt', { expiresIn: '1h' }).catch((x) => x);
    expect(BlobError.is(e)).toBe(true);
    expect(e.code).toBe('invalid_input');
    expect(e.message).toMatch(/over the \d+s this credential can sign for/);
    const clamped = await b.signedRead('secret.txt', { expiresIn: '1h', clamp: true });
    expect(Number(new URL(clamped.url).searchParams.get('X-Amz-Expires'))).toBeGreaterThanOrEqual(cap - 2);
    // No expiresIn is the shorter of five minutes and the cap, so it never throws.
    expect(await b.signedReadUrl('secret.txt')).toContain('X-Amz-Expires=300');
  });

  test('an aged credential is re-minted before signing, but not once per call', async () => {
    resetCredentialCaches();
    // A credential the agent handed over with most of its life already spent.
    let expiresAt = Math.floor(Date.now() / 1000) + 600;
    mintResponse = () => Response.json({ ...creds(), expiresAt, lifetime: undefined });
    const b = bucket();
    await b.exists('a');
    expect(mints).toBe(1);
    // Pretend the clock moved: the cached credential now has 100 s left of the 600 it was minted with.
    const cache = (await import('../../src/server/credentials.ts')).credentialCacheFor(TOKEN, true);
    const held = cache.peek()!;
    held.expiresAt = Math.floor(Date.now() / 1000) + 100;
    const asked = await b.signedRead('a', { expiresIn: 200, clamp: true });
    expect(mints).toBe(2);
    expect(Number(new URL(asked.url).searchParams.get('X-Amz-Expires'))).toBe(200);
    // The agent answered with the same credential, so asking again straight away would only spend
    // the mint budget: it does not.
    expiresAt = Math.floor(Date.now() / 1000) + 100;
    cache.peek()!.expiresAt = expiresAt;
    cache.peek()!.lifetime = 600;
    await b.signedRead('a', { expiresIn: 200, clamp: true });
    await b.signedRead('a', { expiresIn: 200, clamp: true });
    expect(mints).toBe(3);
  });

  test('a signing credential in the mint response raises the cap and removes the re-mint', async () => {
    resetCredentialCaches();
    mintResponse = () =>
      Response.json(creds({ signing: { accessKeyId: 'AKIASIGNING', secretAccessKey: 'ss', expiresAt: Math.floor(Date.now() / 1000) + 86_400 } }));
    const b = bucket();
    const read = await b.signedRead('secret.txt', { expiresIn: '1h' });
    expect(read.url).toContain('X-Amz-Credential=AKIASIGNING');
    expect(read.url).toContain('X-Amz-Expires=3600');
    expect(mints).toBe(1);
    // A signing credential is not the object credential: writes keep using the short-lived one.
    await b.exists('a');
    expect(r2Calls()[0]!.headers.get('authorization')).toContain('AKIAOBJECT');
  });

  test('a malformed signing block is ignored rather than trusted', async () => {
    resetCredentialCaches();
    mintResponse = () => Response.json(creds({ signing: { accessKeyId: 'AKIABAD' } }));
    const read = await bucket().signedRead('secret.txt', { expiresIn: '2m' });
    expect(read.url).toContain('X-Amz-Credential=AKIAOBJECT');
  });
});

describe('bucket guards', () => {
  test('metadata that a header cannot carry is invalid_input, not a TypeError', async () => {
    resetCredentialCaches();
    const b = bucket();
    const e = await b.put('a.txt', 'x', { metadata: { note: 'cafe ✅' } }).catch((x) => x);
    expect(BlobError.is(e)).toBe(true);
    expect(e.code).toBe('invalid_input');
    expect(e.status).toBe(400);
    expect(e.message).toContain('metadata.note');
    await expect(b.put('a.txt', 'x', { metadata: { 'bad name': 'v' } })).rejects.toMatchObject({ code: 'invalid_input' });
    // R2 re-encodes anything above ASCII, so it is refused too rather than handed back changed.
    await expect(b.put('a.txt', 'x', { metadata: { note: 'café' } })).rejects.toMatchObject({ code: 'invalid_input' });
    r2Handler = () => new Response('', { status: 200, headers: { etag: '"e"' } });
    await b.put('a.txt', 'x', { metadata: { note: encodeURIComponent('café') } });
    expect(r2Calls()[0]!.headers.get('x-amz-meta-note')).toBe('caf%C3%A9');
  });

  test("del({ prefix: '' }) has to say it means the whole bucket", async () => {
    resetCredentialCaches();
    const e = await bucket()
      .del({ prefix: '' })
      .catch((x) => x);
    expect(BlobError.is(e)).toBe(true);
    expect(e.code).toBe('invalid_input');
    expect(e.message).toContain('every object');
    expect(r2Calls().length).toBe(0);
  });

  test("del({ prefix: '', all: true }) means it, and lists then batch-deletes", async () => {
    resetCredentialCaches();
    const listed = ['a.txt', 'b/c.txt'];
    r2Handler = (call) => {
      const u = new URL(call.url);
      if (u.searchParams.get('list-type') === '2') {
        return new Response(
          `<ListBucketResult>${listed.map((k) => `<Contents><Key>${k}</Key><Size>1</Size><ETag>&quot;e&quot;</ETag></Contents>`).join('')}<IsTruncated>false</IsTruncated></ListBucketResult>`,
          { status: 200 },
        );
      }
      if (u.searchParams.has('delete')) return new Response('<DeleteResult/>', { status: 200 });
      return new Response('', { status: 200 });
    };
    await bucket().del({ prefix: '', all: true });
    const batch = r2Calls().find((c) => new URL(c.url).searchParams.has('delete'))!;
    expect(batch.method).toBe('POST');
    expect(String(batch.init.body)).toContain('<Key>b/c.txt</Key>');
  });

  test('put answers the content type it sent', async () => {
    resetCredentialCaches();
    r2Handler = () => new Response('', { status: 200, headers: { etag: '"e"' } });
    expect((await bucket().put('a.png', 'x', { contentType: 'image/png' })).contentType).toBe('image/png');
    expect((await bucket().put('a.bin', 'x')).contentType).toBe('application/octet-stream');
  });

  test('a private bucket has no public url', async () => {
    resetCredentialCaches();
    r2Handler = () => new Response('', { status: 200, headers: { etag: '"e"' } });
    const blob = await new Bucket({ token: TOKEN, visibility: 'private' }).put('a.txt', 'x');
    expect(blob.url).toBeUndefined();
    expect(blob.versionedUrl).toBeUndefined();
    expect(blob.path).toBe('a.txt');

    resetCredentialCaches();
    mintResponse = () => Response.json(creds({ visibility: 'private' }));
    // The credentials response wins over the option: the bucket knows what it is.
    const declaredPublic = await new Bucket({ token: TOKEN, visibility: 'public' }).put('a.txt', 'x');
    expect(declaredPublic.url).toBeUndefined();
  });
});

describe('listMultipartUploads', () => {
  test('pages with markers decoded, so a key with an entity in it does not repeat forever', async () => {
    resetCredentialCaches();
    const markers: (string | null)[] = [];
    let page = 0;
    r2Handler = (call) => {
      const u = new URL(call.url);
      markers.push(u.searchParams.get('key-marker'));
      page++;
      if (page === 1) {
        return new Response(
          '<ListMultipartUploadsResult><Upload><Key>a&amp;b.txt</Key><UploadId>u1</UploadId><Initiated>2026-08-01T00:00:00Z</Initiated></Upload>' +
            '<IsTruncated>true</IsTruncated><NextKeyMarker>a&amp;b.txt</NextKeyMarker><NextUploadIdMarker>u1</NextUploadIdMarker></ListMultipartUploadsResult>',
          { status: 200 },
        );
      }
      return new Response(
        '<ListMultipartUploadsResult><Upload><Key>c.txt</Key><UploadId>u2</UploadId><Initiated>2026-08-02T00:00:00Z</Initiated></Upload>' +
          '<IsTruncated>false</IsTruncated></ListMultipartUploadsResult>',
        { status: 200 },
      );
    };
    const uploads = await bucket().listMultipartUploads();
    expect(uploads.map((u) => u.path)).toEqual(['a&b.txt', 'c.txt']);
    expect(markers).toEqual([null, 'a&b.txt']);
  });
});

describe('multipart put', () => {
  const CREATED = '<InitiateMultipartUploadResult><UploadId>up-1</UploadId></InitiateMultipartUploadResult>';
  const COMPLETED = '<CompleteMultipartUploadResult><ETag>"done-4"</ETag></CompleteMultipartUploadResult>';

  function scriptMultipart(failPart?: number): { parts: string[] } {
    const parts: string[] = [];
    r2Handler = (call) => {
      const u = new URL(call.url);
      if (u.searchParams.has('uploads')) return new Response(CREATED, { status: 200 });
      const n = u.searchParams.get('partNumber');
      if (n) {
        parts.push(n);
        if (Number(n) === failPart) return new Response('<Error><Code>InvalidPart</Code></Error>', { status: 400 });
        return new Response('', { status: 200, headers: { etag: `"p${n}"` } });
      }
      if (call.method === 'POST') return new Response(COMPLETED, { status: 200 });
      return new Response('', { status: 200, headers: { etag: '"single"' } });
    };
    return { parts };
  }

  test('a body over the threshold goes up in parts', async () => {
    resetCredentialCaches();
    const script = scriptMultipart();
    const blob = await bucket().put('big.bin', new Uint8Array(17_000_000), { contentType: 'application/octet-stream' });
    expect(script.parts).toEqual(['1', '2', '3', '4']);
    expect(blob.etag).toBe('"done-4"');
    expect(blob.size).toBe(17_000_000);
    expect(blob.contentType).toBe('application/octet-stream');
    // Every part carried its own length, so a failed one is the only thing that has to be re-sent.
    expect(r2Calls().filter((c) => c.url.includes('partNumber=1'))[0]!.headers.get('content-length')).toBe(String(5 * 1024 * 1024));
  });

  test('a part that fails takes the upload with it rather than leaving parts nothing can see', async () => {
    resetCredentialCaches();
    scriptMultipart(2);
    await expect(bucket().put('big.bin', new Uint8Array(17_000_000))).rejects.toMatchObject({ code: 'request_failed' });
    const abort = r2Calls().find((c) => c.method === 'DELETE');
    expect(abort).toBeDefined();
    expect(abort!.url).toContain('uploadId=up-1');
  });

  test('a conditional write stays a single PUT, and asking for both is refused', async () => {
    resetCredentialCaches();
    const script = scriptMultipart();
    const blob = await bucket().put('big.bin', new Uint8Array(17_000_000), { overwrite: false });
    expect(script.parts).toEqual([]);
    expect(blob.etag).toBe('"single"');
    await expect(bucket().put('big.bin', 'x', { multipart: true, ifUnchanged: '"e"' })).rejects.toMatchObject({ code: 'invalid_input' });
    // Small bodies stay one request unless asked otherwise.
    scriptMultipart();
    expect((await bucket().put('small.bin', 'x')).etag).toBe('"single"');
    expect((await bucket().put('small.bin', 'x', { multipart: true })).etag).toBe('"done-4"');
  });
});

describe('handleUpload', () => {
  const post = (route: { POST: (r: Request) => Promise<Response> }, body: unknown) =>
    route.POST(new Request('https://app.test/api/upload', { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }));

  test('a completion token is bound to its route, not just to the bucket', async () => {
    resetCredentialCaches();
    const b = bucket();
    const avatars = handleUpload({ bucket: b, limits: { maxBytes: '1mb' }, onBeforeUpload: () => ({ path: 'avatars/1.png' }) });
    const invoices = handleUpload({ bucket: b, limits: { maxBytes: '9mb' }, onBeforeUpload: () => ({ path: 'invoices/1.pdf' }) });
    const twin = handleUpload({ bucket: b, id: 'avatars', limits: { maxBytes: '1mb' }, onBeforeUpload: () => ({ path: 'x' }) });

    const begin = (await (await post(avatars, { phase: 'begin', file: { name: 'a.png', type: 'image/png', size: 10 } })).json()) as WireBeginResponse;
    const crossed = await post(invoices, { phase: 'end', completionToken: begin.completionToken });
    expect(crossed.status).toBe(403);
    // Same limits, different id: the id is what separates them.
    expect((await post(twin, { phase: 'end', completionToken: begin.completionToken })).status).toBe(403);
    expect(deriveRouteId({ allowedContentTypes: undefined, maxBytes: 1 }, false)).not.toBe(deriveRouteId({ allowedContentTypes: undefined, maxBytes: 2 }, false));
    expect(deriveRouteId({ allowedContentTypes: ['image/png'], maxBytes: 1 }, false)).toBe(deriveRouteId({ allowedContentTypes: ['image/png'], maxBytes: 1 }, false));
  });

  test('the limits are revalidated, not cached forever', async () => {
    resetCredentialCaches();
    const route = handleUpload({ bucket: bucket(), limits: { maxBytes: '1mb' }, onBeforeUpload: () => ({ path: 'x' }) });
    const res = await route.GET(new Request('https://app.test/api/upload'));
    expect(res.headers.get('cache-control')).toBe('public, max-age=60');
    const etag = res.headers.get('etag')!;
    expect(etag).toMatch(/^"[a-z0-9]+"$/);
    expect(await res.json()).toEqual({ limits: { maxBytes: 1_000_000 } });
    const again = await route.GET(new Request('https://app.test/api/upload', { headers: { 'if-none-match': etag } }));
    expect(again.status).toBe(304);
  });

  test('an app error that names a status becomes that status; onError maps the rest', async () => {
    resetCredentialCaches();
    const b = bucket();
    const statusy = handleUpload({
      bucket: b,
      onBeforeUpload: () => {
        throw Object.assign(new Error('no seats left'), { status: 402 });
      },
    });
    const res = await post(statusy, { phase: 'begin', file: { name: 'a', type: '', size: 1 } });
    expect(res.status).toBe(402);
    expect(await res.json()).toMatchObject({ code: 'request_failed', message: 'no seats left', status: 402 });

    const mapped = handleUpload({
      bucket: b,
      onBeforeUpload: () => {
        throw new Error('db down');
      },
      onError: (e, request) => {
        expect(request).toBeInstanceOf(Request);
        return new BlobError('not_ready', { message: String((e as Error).message) });
      },
    });
    const res2 = await post(mapped, { phase: 'begin', file: { name: 'a', type: '', size: 1 } });
    expect(res2.status).toBe(503);
    expect(await res2.json()).toMatchObject({ code: 'not_ready', message: 'db down' });

    const responder = handleUpload({
      bucket: b,
      onBeforeUpload: () => {
        throw new Error('nope');
      },
      onError: () => new Response('teapot', { status: 418 }),
    });
    expect((await post(responder, { phase: 'begin', file: { name: 'a', type: '', size: 1 } })).status).toBe(418);

    // Nothing claimed it: still the framework's to log.
    const bare = handleUpload({
      bucket: b,
      onBeforeUpload: () => {
        throw new Error('bug');
      },
      onError: () => undefined,
    });
    await expect(post(bare, { phase: 'begin', file: { name: 'a', type: '', size: 1 } })).rejects.toThrow('bug');
  });

  test('a create that fails after onBeforeUpload tells the app, so its row is not stranded', async () => {
    resetCredentialCaches();
    const released: unknown[] = [];
    const route = handleUpload({
      bucket: bucket(),
      limits: { maxBytes: '5gb' },
      onBeforeUpload: () => ({ path: 'big.bin', context: { rowId: 7 } }),
      onBeforeUploadFailed: ({ decided, error }) => {
        released.push({ context: decided.context, code: error.code });
      },
    });
    r2Handler = () => new Response('<Error><Code>InternalError</Code></Error>', { status: 500 });
    const res = await post(route, { phase: 'begin', file: { name: 'big.bin', type: '', size: 20_000_000 } });
    expect(res.status).toBe(502);
    expect(released).toEqual([{ context: { rowId: 7 }, code: 'request_failed' }]);
  });

  test('bytes refused at the end are deleted, not left served', async () => {
    resetCredentialCaches();
    const route = handleUpload({ bucket: bucket(), onBeforeUpload: () => ({ path: 'a.png' }) });
    const begin = (await (await post(route, { phase: 'begin', file: { name: 'a.png', type: 'image/png', size: 10 } })).json()) as WireBeginResponse;
    r2Handler = (call) => {
      if (call.method === 'HEAD') return new Response('', { status: 200, headers: { 'content-length': '99', etag: '"e"', 'content-type': 'image/png' } });
      return new Response('', { status: 204 });
    };
    calls = [];
    const end = await post(route, { phase: 'end', completionToken: begin.completionToken });
    expect(end.status).toBe(403);
    expect((await end.json()).code).toBe('signature_mismatch');
    expect(r2Calls().map((c) => c.method)).toEqual(['HEAD', 'DELETE']);
  });
});

describe('handleProxyUpload', () => {
  // A real header: the magic, the IHDR length, then IHDR. put() sniffs, so 'looks like a png' is not enough.
  const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  const png = (name = 'a.png', bytes: Uint8Array = PNG) => new File([bytes as BlobPart], name, { type: 'image/png' });

  function form(file: File): Request {
    const body = new FormData();
    body.append('file', file);
    return new Request('https://app.test/api/avatar', { method: 'POST', body });
  }

  function route(extra: Record<string, unknown> = {}) {
    return handleProxyUpload({
      bucket: bucket(),
      route: '/api/avatar',
      limits: { allowedContentTypes: ['image/png'], maxBytes: '1mb' },
      onBeforeUpload: () => ({ path: 'avatar/demo', metadata: { owner: 'demo' } }),
      onUploadCompleted: ({ path, contentType, size }) => ({ row: path, contentType, size }),
      ...extra,
    });
  }

  test('it serves the same limits document a direct route does', async () => {
    resetCredentialCaches();
    const res = await route().GET(new Request('https://app.test/api/avatar'));
    expect(await res.json()).toEqual({ limits: { allowedContentTypes: ['image/png'], maxBytes: 1_000_000 } });
    expect(res.headers.get('cache-control')).toBe('public, max-age=60');
  });

  test('it stores the file and answers the envelope phase end answers with', async () => {
    resetCredentialCaches();
    r2Handler = () => new Response('', { status: 200, headers: { etag: '"e1"' } });
    const res = await route().POST(form(png()));
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.blob.path).toBe('avatar/demo');
    expect(typeof body.blob.uploadedAt).toBe('string');
    expect(body.data).toEqual({ row: 'avatar/demo', contentType: 'image/png', size: PNG.byteLength });
    expect(r2Calls().some((c) => c.method === 'PUT')).toBe(true);
  });

  test('bytes that do not prove their type are refused before anything is stored', async () => {
    resetCredentialCaches();
    const html = new File([new TextEncoder().encode('<html><script>x</script>') as BlobPart], 'a.png', { type: 'image/png' });
    const res = await route().POST(form(html));
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('content_type_not_allowed');
    // The whole reason this handler exists: a stable path is not overwritten by a file it refused.
    expect(r2Calls().some((c) => c.method === 'PUT')).toBe(false);
  });

  test('a declared content-length over the limit is refused before the body is read', async () => {
    resetCredentialCaches();
    const req = new Request('https://app.test/api/avatar', { method: 'POST', body: 'x', headers: { 'content-length': '9999999' } });
    const res = await route().POST(req);
    expect(res.status).toBe(413);
    expect((await res.json()).code).toBe('too_large');
  });

  test('a file over the limit is refused on its own size', async () => {
    resetCredentialCaches();
    const big = new File([new Uint8Array(20) as BlobPart], 'a.png', { type: 'image/png' });
    const res = await route({ limits: { allowedContentTypes: ['image/png'], maxBytes: 10 } }).POST(form(big));
    expect(res.status).toBe(413);
    expect((await res.json()).code).toBe('too_large');
  });

  test('a missing file field is invalid_input, not a 500', async () => {
    resetCredentialCaches();
    const res = await route().POST(new Request('https://app.test/api/avatar', { method: 'POST', body: new FormData() }));
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('invalid_input');
  });

  test('a raw body is accepted too, named from Content-Disposition', async () => {
    resetCredentialCaches();
    r2Handler = () => new Response('', { status: 200, headers: { etag: '"e1"' } });
    let seen: { name: string; type: string; size: number } | undefined;
    const res = await handleProxyUpload({
      bucket: bucket(),
      limits: { allowedContentTypes: ['image/png'] },
      onBeforeUpload: ({ file }) => {
        seen = file;
        return { path: 'avatar/raw' };
      },
    }).POST(
      new Request('https://app.test/api/avatar', {
        method: 'POST',
        body: PNG as BlobPart,
        headers: { 'content-type': 'image/png', 'content-disposition': 'attachment; filename="shot.png"' },
      }),
    );
    expect(res.status).toBe(200);
    expect(seen).toEqual({ name: 'shot.png', type: 'image/png', size: PNG.byteLength });
  });

  // A TypeError, and it is rethrown rather than answered: widening is the app's bug, not the
  // caller's, so the framework logs it instead of it becoming a 500 the browser has to interpret.
  test('onBeforeUpload cannot widen the route limits', async () => {
    resetCredentialCaches();
    const widened = route({ onBeforeUpload: () => ({ path: 'avatar/demo', limits: { maxBytes: '5mb' } }) });
    expect(widened.POST(form(png()))).rejects.toThrow(/widened maxBytes/);
  });

  test('the path separates two routes that declare identical limits', () => {
    expect(deriveRouteId({ allowedContentTypes: undefined, maxBytes: 1 }, false, '/api/a')).not.toBe(
      deriveRouteId({ allowedContentTypes: undefined, maxBytes: 1 }, false, '/api/b'),
    );
  });
});
