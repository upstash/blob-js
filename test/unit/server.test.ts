import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { Bucket, BlobError, handleUpload } from '../../src/index.ts';
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
    expect(await b.signedReadCap()).toBe(600);
    expect(mints).toBe(1);

    const e = await b.signedRead('secret.txt', { expiresIn: '1h' }).catch((x) => x);
    expect(BlobError.is(e)).toBe(true);
    expect(e.code).toBe('invalid_input');
    expect(e.message).toContain('over the 600s');
    const clamped = await b.signedRead('secret.txt', { expiresIn: '1h', clamp: true });
    expect(clamped.url).toContain('X-Amz-Expires=600');
    expect(await b.signedReadUrl('secret.txt')).toContain('X-Amz-Expires=300');
  });

  test('re-mints rather than handing back a link that dies in seconds', async () => {
    resetCredentialCaches();
    mintResponse = () => Response.json(creds({}, 31));
    const b = bucket();
    await b.exists('a');
    expect(mints).toBe(1);
    // The cached credential cannot cover the full ask, so a fresh one is minted before signing.
    await b.signedRead('a', { expiresIn: 31 });
    expect(mints).toBeGreaterThan(1);
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
    // Latin-1 is what a header can carry, so it goes through.
    r2Handler = () => new Response('', { status: 200, headers: { etag: '"e"' } });
    await b.put('a.txt', 'x', { metadata: { note: 'café' } });
    expect(r2Calls()[0]!.headers.get('x-amz-meta-note')).toBe('café');
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
