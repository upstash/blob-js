import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { Bucket, BlobError, upload, uploadHandler } from '../../src/index.ts';
import { r2Of } from '../../src/server/bucket.ts';
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
  test('answers a url and transparently uses the credential cap', async () => {
    resetCredentialCaches();
    const b = bucket();
    const read = await b.signedRead('secret.txt', { expiresIn: '2m' });
    expect(read.url).toContain('X-Amz-Expires=120');
    expect(read.expiresAt.getTime()).toBeGreaterThan(Date.now() + 110_000);
    expect(read.expiresAt.getTime()).toBeLessThan(Date.now() + 130_000);
    const cap = await r2Of(b).readCap();
    expect(cap).toBeGreaterThanOrEqual(595);
    expect(cap).toBeLessThanOrEqual(600);
    expect(mints).toBe(1);

    const capped = await b.signedRead('secret.txt', { expiresIn: '1h' });
    expect(Number(new URL(capped.url).searchParams.get('X-Amz-Expires'))).toBeGreaterThanOrEqual(cap - 2);
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
    const asked = await b.signedRead('a', { expiresIn: 200 });
    expect(mints).toBe(2);
    expect(Number(new URL(asked.url).searchParams.get('X-Amz-Expires'))).toBe(200);
    // The agent answered with the same credential, so asking again straight away would only spend
    // the mint budget: it does not.
    expiresAt = Math.floor(Date.now() / 1000) + 100;
    cache.peek()!.expiresAt = expiresAt;
    cache.peek()!.lifetime = 600;
    await b.signedRead('a', { expiresIn: 200 });
    await b.signedRead('a', { expiresIn: 200 });
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

describe('signedRead download', () => {
  const disposition = async (path: string, options: Parameters<Bucket['signedRead']>[1] = {}) =>
    new URL((await bucket().signedRead(path, options)).url).searchParams.get('response-content-disposition');

  test('downloadAs: name is the name it saves as', async () => {
    resetCredentialCaches();
    expect(await disposition('u/1/abc', { downloadAs: 'Report Q3.pdf' })).toBe(`attachment; filename="Report Q3.pdf"; filename*=UTF-8''Report%20Q3.pdf`);
  });

  test('no download option is no disposition at all', async () => {
    resetCredentialCaches();
    expect(await disposition('a.txt')).toBeNull();
  });

  test('a name a header cannot carry cannot add a parameter or a second header', async () => {
    resetCredentialCaches();
    // The quote, the semicolon and the CRLF are what an injection needs; filename* carries the
    // real name percent-encoded, where a parser finds nothing to read as syntax.
    const evil = 'a";x=1\r\nSet-Cookie: p=1.txt';
    const value = (await disposition('u/1/abc', { downloadAs: evil }))!;
    expect(value).toBe(`attachment; filename="a_x_1_Set-Cookie_ p_1.txt"; filename*=UTF-8''a%22%3Bx%3D1%0D%0ASet-Cookie%3A%20p%3D1.txt`);
    // The quoted fallback ends where it is meant to, and the ext-value carries no syntax at all.
    expect(value.slice(value.indexOf('"') + 1, value.lastIndexOf('"'))).not.toMatch(/["\\;\r\n]/);
    expect(value.slice(value.indexOf('filename*'))).not.toMatch(/[\r\n;"]/);
  });

  test('a unicode name crosses as an RFC 8187 ext-value with an ascii fallback', async () => {
    resetCredentialCaches();
    expect(await disposition('u/1/abc', { downloadAs: 'café ☕.pdf' })).toBe(`attachment; filename="caf_ _.pdf"; filename*=UTF-8''caf%C3%A9%20%E2%98%95.pdf`);
    // encodeURIComponent leaves !'()* alone; only ! is an attr-char, so the rest are escaped.
    expect(await disposition('u/1/abc', { downloadAs: "it's (a)*.pdf" })).toBe(`attachment; filename="it_s _a_.pdf"; filename*=UTF-8''it%27s%20%28a%29%2A.pdf`);
  });

  test('contentType overrides what the object was stored as, and must be a media type', async () => {
    resetCredentialCaches();
    const url = new URL((await bucket().signedRead('u/1/abc', { contentType: 'application/pdf' })).url);
    expect(url.searchParams.get('response-content-type')).toBe('application/pdf');
    expect(new URL((await bucket().signedRead('a', { contentType: 'text/plain; charset=utf-8' })).url).searchParams.get('response-content-type')).toBe('text/plain; charset=utf-8');
    const e = await bucket()
      .signedRead('a', { contentType: 'text/plain\r\nX-Evil: 1' })
      .catch((x) => x);
    expect(BlobError.is(e)).toBe(true);
    expect(e.code).toBe('invalid_input');
  });

  test('the disposition is inside the signature, not appended to it', async () => {
    resetCredentialCaches();
    const b = bucket();
    const plain = new URL((await b.signedRead('a.txt', { expiresIn: 60 })).url);
    const named = new URL((await b.signedRead('a.txt', { expiresIn: 60, downloadAs: 'x.txt' })).url);
    expect(named.searchParams.get('X-Amz-Signature')).not.toBe(plain.searchParams.get('X-Amz-Signature'));
    // Sorted into the canonical query with everything else, before the signature is appended.
    expect(named.search.indexOf('response-content-disposition')).toBeLessThan(named.search.indexOf('X-Amz-Signature'));
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

  test('publicUrl is local, encoded, and absent for a private bucket', () => {
    resetCredentialCaches();
    const pub = new Bucket({ token: TOKEN, private: false });
    expect(pub.publicUrl('reports/Q3 final.pdf')).toMatch(/\/reports\/Q3%20final\.pdf$/);
    expect(new Bucket({ token: TOKEN, private: true }).publicUrl('a.txt')).toBeUndefined();
    expect(mints).toBe(0);
  });

  test('a private bucket has no public url', async () => {
    resetCredentialCaches();
    r2Handler = () => new Response('', { status: 200, headers: { etag: '"e"' } });
    const blob = await new Bucket({ token: TOKEN, private: true }).put('a.txt', 'x');
    expect(blob.url).toBeUndefined();
    expect(blob.versionedUrl).toBeUndefined();
    expect(blob.path).toBe('a.txt');

    resetCredentialCaches();
    mintResponse = () => Response.json(creds({ visibility: 'private' }));
    // The credentials response wins over the option: the bucket knows what it is.
    const declaredPublic = await new Bucket({ token: TOKEN, private: false }).put('a.txt', 'x');
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

describe('abortMultipart', () => {
  test('sends the DELETE for the listed record', async () => {
    resetCredentialCaches();
    let seen: URL | undefined;
    r2Handler = (call) => {
      seen = new URL(call.url);
      return new Response(null, { status: 204 });
    };
    await bucket().abortMultipart({ path: 'a&b.txt', uploadId: 'u1' });
    expect(seen!.pathname.endsWith('a%26b.txt')).toBe(true);
    expect(seen!.searchParams.get('uploadId')).toBe('u1');
  });

  test('an upload without an id is refused rather than answered as a no-op', async () => {
    resetCredentialCaches();
    r2Handler = () => new Response(null, { status: 204 });
    // A missing upload is success at the wire, so bad input has to be caught before it is sent.
    await expect(bucket().abortMultipart({ path: 'a.txt', uploadId: '' })).rejects.toThrow('uploadId is required');
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

describe('uploadHandler: the direct transport', () => {
  const post = (route: { POST: (r: Request) => Promise<Response> }, body: unknown) =>
    route.POST(new Request('https://app.test/api/upload', { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }));

  // Every direct upload is multipart now, so begin always creates one.
  const initiated = (call: Call): Response | undefined =>
    call.method === 'POST' && call.url.includes('uploads=') ? new Response('<InitiateMultipartUploadResult><UploadId>mp-1</UploadId></InitiateMultipartUploadResult>', { status: 200 }) : undefined;
  const beginR2 = (call: Call): Response => initiated(call) ?? new Response('', { status: 200 });
  /** begin, then complete, then the HEAD phase 'end' reads the stored object back with. */
  const fullR2 =
    (head: Record<string, string> = { 'content-length': '10', etag: '"e"', 'content-type': 'image/png' }) =>
    (call: Call): Response => {
      const created = initiated(call);
      if (created) return created;
      if (call.method === 'POST') return new Response('<CompleteMultipartUploadResult><ETag>"e"</ETag></CompleteMultipartUploadResult>', { status: 200 });
      if (call.method === 'HEAD') return new Response('', { status: 200, headers: head });
      return new Response('', { status: 204 });
    };

  const begin = async (route: { POST: (r: Request) => Promise<Response> }, file: { name: string; type: string; size: number }) =>
    (await (await post(route, { phase: 'begin', file })).json()) as WireBeginResponse;

  test('a completion token is bound to its route, not just to the bucket', async () => {
    resetCredentialCaches();
    r2Handler = beginR2;
    const b = bucket();
    const avatars = uploadHandler({ bucket: b, constraints: { maxBytes: '1mb' }, onBeforeUpload: () => ({ path: 'avatars/1.png' }) });
    const invoices = uploadHandler({ bucket: b, constraints: { maxBytes: '9mb' }, onBeforeUpload: () => ({ path: 'invoices/1.pdf' }) });
    // Same constraints, different endpoint: two handlers on one bucket do not share each other's tokens.
    const twin = uploadHandler({ bucket: b, endpoint: '/api/twin', constraints: { maxBytes: '1mb' }, onBeforeUpload: () => ({ path: 'x' }) });

    const started = await begin(avatars, { name: 'a.png', type: 'image/png', size: 10 });
    expect((await post(invoices, { phase: 'end', completionToken: started.completionToken })).status).toBe(403);
    expect((await post(twin, { phase: 'end', completionToken: started.completionToken })).status).toBe(403);
    expect(deriveRouteId({ contentTypes: undefined, maxBytes: 1 }, false)).not.toBe(deriveRouteId({ contentTypes: undefined, maxBytes: 2 }, false));
    expect(deriveRouteId({ contentTypes: ['image/png'], maxBytes: 1 }, false)).toBe(deriveRouteId({ contentTypes: ['image/png'], maxBytes: 1 }, false));
  });

  test('the constraints are revalidated, not cached forever', async () => {
    resetCredentialCaches();
    const route = uploadHandler({ bucket: bucket(), constraints: { maxBytes: '1mb' }, onBeforeUpload: () => ({ path: 'x' }) });
    const res = await route.GET(new Request('https://app.test/api/upload'));
    expect(res.headers.get('cache-control')).toBe('public, max-age=60');
    const etag = res.headers.get('etag')!;
    expect(etag).toMatch(/^"[a-z0-9]+"$/);
    expect(await res.json()).toEqual({ constraints: { maxBytes: 1_000_000 } });
    const again = await route.GET(new Request('https://app.test/api/upload', { headers: { 'if-none-match': etag } }));
    expect(again.status).toBe(304);
  });

  test('a file that fits one part is still a multipart, so it can be paused and resumed', async () => {
    resetCredentialCaches();
    r2Handler = beginR2;
    const route = uploadHandler({ bucket: bucket(), onBeforeUpload: () => ({ path: 'small.png' }) });
    const started = await begin(route, { name: 'a.png', type: 'image/png', size: 10 });
    expect(started.upload.partSize).toBe(5 * 1024 * 1024);
    expect(started.upload.parts.map((p) => p.n)).toEqual([1]);
    expect(new URL(started.upload.parts[0]!.url).searchParams.get('partNumber')).toBe('1');
    expect(new URL(started.upload.parts[0]!.url).searchParams.get('uploadId')).toBe('mp-1');
    // The object does not exist yet: nothing has been completed, so nothing can be served.
    expect(r2Calls().filter((c) => c.method === 'PUT')).toEqual([]);
  });

  test('an empty file is refused before anything is created', async () => {
    resetCredentialCaches();
    r2Handler = beginR2;
    const route = uploadHandler({ bucket: bucket(), onBeforeUpload: () => ({ path: 'zero.bin' }) });
    const res = await post(route, { phase: 'begin', file: { name: 'a', type: '', size: 0 } });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('empty_body');
    expect(r2Calls()).toEqual([]);
  });

  test('phase end hands the callback the file the browser declared at begin', async () => {
    resetCredentialCaches();
    r2Handler = fullR2();
    let seen: unknown;
    // The builder, because `state` and `uploadId` are a route's, not a shared default's.
    const route = uploadHandler({
      bucket: bucket(),
      routes: {
        doc: upload()({
          onBeforeUpload: () => ({ path: 'a.png', state: { rowId: 7 } }),
          onUploadComplete: ({ file, route: name, state, uploadId, multipartUploadId }) => {
            seen = { file, name, state, hasUploadId: typeof uploadId === 'string', multipartUploadId };
            return { ok: true };
          },
        }),
      },
    });
    const named = { POST: (r: Request) => route.POST(new Request('https://app.test/api/upload?route=doc', r)) };
    const started = await begin(named, { name: 'Holiday Pic.PNG', type: 'image/png', size: 10 });
    const res = await post(named, { phase: 'end', completionToken: started.completionToken, parts: [{ n: 1, etag: '"p1"' }] });
    expect(res.status).toBe(200);
    const completed = await res.json();
    expect(completed.blob.contentType).toBe('image/png');
    expect(completed.data).toEqual({ ok: true });
    expect(seen).toEqual({
      // The name is the one thing the stored object does not carry: it rides the completion token.
      file: { name: 'Holiday Pic.PNG', type: 'image/png', size: 10 },
      name: 'doc',
      state: { rowId: 7 },
      hasUploadId: true,
      multipartUploadId: 'mp-1',
    });
  });

  test('a repeated end delivers the callback again with the same uploadId', async () => {
    resetCredentialCaches();
    r2Handler = beginR2;
    const ids: string[] = [];
    const route = uploadHandler({
      bucket: bucket(),
      onBeforeUpload: () => ({ path: 'a.png' }),
      onUploadComplete: ({ uploadId }) => {
        ids.push(uploadId);
        return { uploadId };
      },
    });
    const started = await begin(route, { name: 'a.png', type: 'image/png', size: 10 });
    let completes = 0;
    r2Handler = (call) => {
      if (call.method === 'POST') {
        completes++;
        if (completes > 1) return new Response('<Error><Code>NoSuchUpload</Code></Error>', { status: 404 });
        return new Response('<CompleteMultipartUploadResult><ETag>"e"</ETag></CompleteMultipartUploadResult>', { status: 200 });
      }
      if (call.method === 'HEAD') return new Response('', { status: 200, headers: { 'content-length': '10', etag: '"e"', 'content-type': 'image/png' } });
      return new Response('', { status: 204 });
    };
    const end = { phase: 'end', completionToken: started.completionToken, parts: [{ n: 1, etag: '"p1"' }] };
    expect((await post(route, end)).status).toBe(200);
    expect((await post(route, end)).status).toBe(200);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(1);
  });

  test('an app error that names a status becomes that status; onError maps the rest', async () => {
    resetCredentialCaches();
    r2Handler = beginR2;
    const b = bucket();
    const statusy = uploadHandler({
      bucket: b,
      onBeforeUpload: () => {
        throw Object.assign(new Error('no seats left'), { status: 402 });
      },
    });
    const res = await post(statusy, { phase: 'begin', file: { name: 'a', type: '', size: 1 } });
    expect(res.status).toBe(402);
    expect(await res.json()).toMatchObject({ code: 'request_failed', message: 'No seats left', status: 402 });

    const mapped = uploadHandler({
      bucket: b,
      onBeforeUpload: () => {
        throw new Error('db down');
      },
      onError: ({ error, request, route, file }) => {
        expect(request).toBeInstanceOf(Request);
        expect(route).toBe('');
        expect(file).toEqual({ name: 'a', type: 'application/octet-stream', size: 1 });
        return new BlobError('not_ready', { message: String((error as Error).message) });
      },
    });
    const res2 = await post(mapped, { phase: 'begin', file: { name: 'a', type: '', size: 1 } });
    expect(res2.status).toBe(503);
    expect(await res2.json()).toMatchObject({ code: 'not_ready', message: 'Db down' });

    const responder = uploadHandler({
      bucket: b,
      onBeforeUpload: () => {
        throw new Error('nope');
      },
      onError: () => new Response('teapot', { status: 418 }),
    });
    expect((await post(responder, { phase: 'begin', file: { name: 'a', type: '', size: 1 } })).status).toBe(418);

    // Nothing claimed it: still the framework's to log.
    const bare = uploadHandler({
      bucket: b,
      onBeforeUpload: () => {
        throw new Error('bug');
      },
      onError: () => undefined,
    });
    await expect(post(bare, { phase: 'begin', file: { name: 'a', type: '', size: 1 } })).rejects.toThrow('bug');
  });

  test('onError sees a refusal the SDK raised itself, with the path onBeforeUpload had reserved', async () => {
    resetCredentialCaches();
    const seen: unknown[] = [];
    const route = uploadHandler({
      bucket: bucket(),
      constraints: { maxBytes: '5gb' },
      onBeforeUpload: () => ({ path: 'big.bin', metadata: { rowId: '7' } }),
      onError: ({ error, path, metadata }) => {
        seen.push({ code: (error as BlobError).code, path, metadata });
      },
    });
    r2Handler = () => new Response('<Error><Code>InternalError</Code></Error>', { status: 500 });
    const res = await post(route, { phase: 'begin', file: { name: 'big.bin', type: '', size: 20_000_000 } });
    expect(res.status).toBe(502);
    // The create failed after onBeforeUpload ran, so whatever it reserved is reachable here.
    expect(seen).toEqual([{ code: 'request_failed', path: 'big.bin', metadata: { rowId: '7' } }]);
  });

  test('bytes refused at the end are deleted, which bounds the exposure without undoing it', async () => {
    resetCredentialCaches();
    r2Handler = beginR2;
    const route = uploadHandler({ bucket: bucket(), onBeforeUpload: () => ({ path: 'a.png' }) });
    const started = await begin(route, { name: 'a.png', type: 'image/png', size: 10 });
    r2Handler = fullR2({ 'content-length': '99', etag: '"e"', 'content-type': 'image/png' });
    calls = [];
    const end = await post(route, { phase: 'end', completionToken: started.completionToken, parts: [{ n: 1, etag: '"p1"' }] });
    expect(end.status).toBe(403);
    expect((await end.json()).code).toBe('signature_mismatch');
    // The second HEAD is discard() checking the object is still the one this upload completed.
    expect(r2Calls().map((c) => c.method)).toEqual(['POST', 'HEAD', 'HEAD', 'DELETE']);
  });

  test('a refusal leaves a newer object alone: a stable path is not a licence to delete', async () => {
    resetCredentialCaches();
    r2Handler = beginR2;
    const route = uploadHandler({ bucket: bucket(), onBeforeUpload: () => ({ path: 'avatars/u1.png' }) });
    const started = await begin(route, { name: 'a.png', type: 'image/png', size: 10 });
    // The size check refuses, but by then the HEAD reports an etag from a later upload to the same
    // key. Deleting here would destroy a file that was accepted.
    r2Handler = fullR2({ 'content-length': '99', etag: '"newer"', 'content-type': 'image/png' });
    calls = [];
    const end = await post(route, { phase: 'end', completionToken: started.completionToken, parts: [{ n: 1, etag: '"p1"' }] });
    expect(end.status).toBe(403);
    expect(r2Calls().map((c) => c.method)).toEqual(['POST', 'HEAD', 'HEAD']);
    expect(r2Calls().some((c) => c.method === 'DELETE')).toBe(false);
  });

  test('phase end never reads the stored bytes back', async () => {
    resetCredentialCaches();
    r2Handler = beginR2;
    const route = uploadHandler({
      bucket: bucket(),
      constraints: { contentTypes: ['image/png'] },
      onBeforeUpload: () => ({ path: 'a.png' }),
    });
    const started = await begin(route, { name: 'a.png', type: 'image/png', size: 10 });
    r2Handler = fullR2();
    calls = [];
    const end = await post(route, { phase: 'end', completionToken: started.completionToken, parts: [{ n: 1, etag: '"p1"' }] });
    expect(end.status).toBe(200);
    // No ranged GET: the type was settled at 'begin', where refusing costs nothing.
    expect(r2Calls().map((c) => c.method)).toEqual(['POST', 'HEAD']);
    expect(r2Calls().some((c) => c.headers.get('range'))).toBe(false);
  });

  test('the head sent at begin refuses a mislabelled file before a multipart exists', async () => {
    resetCredentialCaches();
    r2Handler = beginR2;
    const route = uploadHandler({
      bucket: bucket(),
      constraints: { contentTypes: ['image/png'] },
      onBeforeUpload: () => ({ path: 'a.png' }),
    });
    calls = [];
    // 'PK\x03\x04...': a zip, declared image/png.
    const res = await post(route, {
      phase: 'begin',
      file: { name: 'a.png', type: 'image/png', size: 10 },
      head: btoa('PK\u0003\u0004\u0014\u0000'),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).message).toContain('application/zip');
    // Nothing was created: no CreateMultipartUpload reached R2.
    expect(r2Calls().some((c) => c.method === 'POST')).toBe(false);
  });

  test('a head that agrees, and a client that sends none, both proceed', async () => {
    resetCredentialCaches();
    r2Handler = beginR2;
    const route = uploadHandler({
      bucket: bucket(),
      constraints: { contentTypes: ['image/png'] },
      onBeforeUpload: () => ({ path: 'a.png' }),
    });
    const png = btoa('\u0089PNG\r\n\u001a\n\u0000\u0000\u0000\rIHDR');
    const withHead = await post(route, { phase: 'begin', file: { name: 'a.png', type: 'image/png', size: 10 }, head: png });
    expect(withHead.status).toBe(200);
    // An older client sends no head at all, and the declared type is all there is to go on.
    const noHead = await post(route, { phase: 'begin', file: { name: 'a.png', type: 'image/png', size: 10 } });
    expect(noHead.status).toBe(200);
    // So is a head that is not decodable.
    const junk = await post(route, { phase: 'begin', file: { name: 'a.png', type: 'image/png', size: 10 }, head: '!!!!not base64!!!!' });
    expect(junk.status).toBe(200);
  });

  test('onUploadComplete throwing deletes the object: it exists only if the callback returned', async () => {
    resetCredentialCaches();
    r2Handler = beginR2;
    const route = uploadHandler({
      bucket: bucket(),
      onBeforeUpload: () => ({ path: 'a.png' }),
      onUploadComplete: () => {
        throw new BlobError('conflict', { message: 'that thread was deleted' });
      },
    });
    const started = await begin(route, { name: 'a.png', type: 'image/png', size: 10 });
    r2Handler = fullR2();
    calls = [];
    const end = await post(route, { phase: 'end', completionToken: started.completionToken, parts: [{ n: 1, etag: '"p1"' }] });
    expect(end.status).toBe(409);
    expect((await end.json()).message).toBe('That thread was deleted');
    // complete, HEAD, the re-read discard() guards on, and then the delete.
    expect(r2Calls().map((c) => c.method)).toEqual(['POST', 'HEAD', 'HEAD', 'DELETE']);
  });

  test('a delete that fails after onUploadComplete threw keeps the refusal and says what it left behind', async () => {
    resetCredentialCaches();
    r2Handler = beginR2;
    const route = uploadHandler({
      bucket: bucket(),
      onBeforeUpload: () => ({ path: 'a.png' }),
      onUploadComplete: () => {
        throw new BlobError('conflict', { message: 'that thread was deleted' });
      },
    });
    const started = await begin(route, { name: 'a.png', type: 'image/png', size: 10 });
    const full = fullR2();
    r2Handler = (call) => (call.method === 'DELETE' ? new Response('<Error><Code>InternalError</Code></Error>', { status: 500 }) : full(call));
    const logged = spyOn(console, 'error').mockImplementation(() => {});
    try {
      const end = await post(route, { phase: 'end', completionToken: started.completionToken, parts: [{ n: 1, etag: '"p1"' }] });
      // The callback's refusal is the answer, not the delete's failure.
      expect(end.status).toBe(409);
      expect((await end.json()).code).toBe('conflict');
      expect(logged).toHaveBeenCalledTimes(1);
      expect(String(logged.mock.calls[0]![0])).toContain('"a.png" could not be deleted');
    } finally {
      logged.mockRestore();
    }
  });

  test('cancel aborts the multipart the browser walked away from', async () => {
    resetCredentialCaches();
    r2Handler = beginR2;
    const route = uploadHandler({ bucket: bucket(), onBeforeUpload: () => ({ path: 'a.png' }) });
    const started = await begin(route, { name: 'a.png', type: 'image/png', size: 10 });
    calls = [];
    expect((await post(route, { phase: 'cancel', completionToken: started.completionToken })).status).toBe(200);
    const aborted = r2Calls().find((c) => c.method === 'DELETE')!;
    expect(new URL(aborted.url).searchParams.get('uploadId')).toBe('mp-1');
  });
});
