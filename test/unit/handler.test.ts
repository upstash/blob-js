import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import * as z from 'zod';
import { BlobError, Bucket, uploadRoute, uploadHandler } from '../../src/index.ts';
import { resetCredentialCaches } from '../../src/server/credentials.ts';
import { encodeToken } from '../../src/server/token.ts';
import type { WireBeginResponse } from '../../src/shared/types.ts';

// The handler against a scripted R2. What matters here is the dispatch and the composition: which
// route a request reaches, and what it inherits from the handler it is mounted in.

const TOKEN = encodeToken('bucket-id', 'pw-secret', 'b0123456789a');
const ENDPOINT = 'https://acc.r2.cloudflarestorage.com';

interface Call {
  method: string;
  url: string;
  headers: Headers;
  init: RequestInit;
}

const realFetch = globalThis.fetch;
let calls: Call[] = [];
let r2Handler: (call: Call) => Response | Promise<Response>;

const mockFetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const call: Call = { method: (init.method ?? 'GET').toUpperCase(), url, headers: new Headers(init.headers), init };
  calls.push(call);
  if (url.includes('/v1/credentials')) {
    return Response.json({
      accessKeyId: 'AKIAOBJECT',
      secretAccessKey: 'sk',
      sessionToken: 'st',
      endpoint: ENDPOINT,
      bucket: 'bkt',
      region: 'auto',
      expiresAt: Math.floor(Date.now() / 1000) + 600,
    });
  }
  if (url.startsWith(ENDPOINT)) return r2Handler(call);
  return realFetch(input as RequestInfo, init);
}) as typeof fetch;

beforeAll(() => {
  globalThis.fetch = mockFetch;
});

afterAll(() => {
  globalThis.fetch = realFetch;
});

/**
 * The default script answers a CreateMultipartUpload and a CompleteMultipartUpload for the routes
 * that are over the threshold or pin multipart, and the HEAD phase 'end' reads the object back with.
 */
// A single PUT writes a marker the SDK signed into the url, and phase 'end' reads it back to know
// the object is this upload's. The fake storage has not seen the PUT, so began() remembers what the
// last begin handed the browser and the fake HEAD answers with it.
const MARKER = 'x-amz-meta-upstash-upload';
let marker: string | undefined;

function scriptedR2(head: Record<string, string> = { 'content-length': '4', etag: '"e"', 'content-type': 'image/png', 'last-modified': new Date().toUTCString() }) {
  return (call: Call): Response => {
    if (call.method === 'POST' && call.url.includes('uploads=')) return new Response('<InitiateMultipartUploadResult><UploadId>mp-1</UploadId></InitiateMultipartUploadResult>', { status: 200 });
    if (call.method === 'POST') return new Response('<CompleteMultipartUploadResult><ETag>"e"</ETag></CompleteMultipartUploadResult>', { status: 200 });
    if (call.method === 'HEAD') return new Response('', { status: 200, headers: { ...head, ...(marker === undefined ? {} : { [MARKER]: marker }) } });
    return new Response('', { status: 200 });
  };
}

beforeEach(() => {
  calls = [];
  r2Handler = scriptedR2();
  resetCredentialCaches();
});

const bucket = () => new Bucket({ token: TOKEN });
const r2Calls = () => calls.filter((c) => c.url.startsWith(ENDPOINT));

const url = (route?: string) => `https://app.test/api/upload${route === undefined ? '' : `?route=${route}`}`;

const post = (handler: { POST: (r: Request) => Promise<Response> }, route: string | undefined, body: unknown) =>
  handler.POST(new Request(url(route), { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }));

const began = async (handler: { POST: (r: Request) => Promise<Response> }, route: string | undefined, file: { name: string; type: string; size: number }, input?: unknown) => {
  const begin = (await (await post(handler, route, { phase: 'begin', file, ...(input === undefined ? {} : { input }) })).json()) as WireBeginResponse;
  marker = begin.upload?.parts?.[0]?.headers?.[MARKER];
  return begin;
};

function handler(extra: Record<string, unknown> = {}) {
  return uploadHandler({
    bucket: bucket(),
    constraints: { maxBytes: '20mb', contentTypes: ['image/png'] },
    routes: {
      attachment: { onBeforeUpload: () => ({ path: 'attachment/1.png' }) },
      large: { constraints: { maxBytes: '2gb', contentTypes: null }, onBeforeUpload: () => ({ path: 'large/1.bin' }) },
      avatar: { constraints: { maxBytes: '2mb' }, onBeforeUpload: () => ({ path: 'avatar/demo' }) },
    },
    ...extra,
  });
}

describe('dispatch', () => {
  test('the query names the route, for GET and for POST', async () => {
    const uploads = handler();
    const res = await uploads.GET(new Request(url('large')));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ constraints: { maxBytes: 2_000_000_000 } });

    const begin = await post(uploads, 'attachment', { phase: 'begin', file: { name: 'a.png', type: 'image/png', size: 10 } });
    expect(begin.status).toBe(200);
    expect(((await begin.json()) as WireBeginResponse).path).toBe('attachment/1.png');
  });

  // better-upload 3.0.19 selects with `route in router.routes` on a plain object literal, so
  // {"route":"toString"} finds Object.prototype's and dispatches to a function with no callbacks.
  test('a name off Object.prototype is not a route', async () => {
    const uploads = handler();
    for (const name of ['toString', '__proto__', 'constructor', 'hasOwnProperty', 'valueOf']) {
      const res = await post(uploads, name, { phase: 'begin', file: { name: 'a.png', type: 'image/png', size: 10 } });
      expect(res.status).toBe(404);
      expect((await res.json()).code).toBe('not_found');
      const get = await uploads.GET(new Request(url(name)));
      expect(get.status).toBe(404);
    }
    expect(r2Calls()).toHaveLength(0);
  });

  test('an unknown route is a 404 that does not name the ones it mounts', async () => {
    const uploads = handler();
    // No ?route= at all, and an empty one, are both routes nobody mounted.
    expect((await post(uploads, undefined, { phase: 'begin' })).status).toBe(404);
    expect((await post(uploads, '', { phase: 'begin' })).status).toBe(404);
    const res = await post(uploads, 'attachmnt', { phase: 'begin', file: { name: 'a.png', type: 'image/png', size: 10 } });
    const body = await res.json();
    expect(res.status).toBe(404);
    expect(body.code).toBe('not_found');
    expect(body.message).toBe('Unknown upload route');
    expect(JSON.stringify(body)).not.toContain('attachment');
  });

  test('with no routes the handler is the route, and no query names it', async () => {
    const uploads = uploadHandler({ bucket: bucket(), constraints: { maxBytes: '1mb' }, onBeforeUpload: () => ({ path: 'only/1.png' }) });
    const begin = await began(uploads, undefined, { name: 'a.png', type: 'image/png', size: 10 });
    expect(begin.path).toBe('only/1.png');
    expect(await (await uploads.GET(new Request(url()))).json()).toEqual({ constraints: { maxBytes: 1_000_000 } });
    // A name on the query is a client bound to some other handler: it does not silently get this
    // route, for GET or for POST.
    for (const name of ['anything', '__proto__', 'toString']) {
      const res = await post(uploads, name, { phase: 'begin', file: { name: 'a.png', type: 'image/png', size: 10 } });
      expect(res.status).toBe(404);
      expect((await res.json()).code).toBe('not_found');
      expect((await uploads.GET(new Request(url(name)))).status).toBe(404);
    }
    // An empty one is the same as none.
    expect((await post(uploads, '', { phase: 'begin', file: { name: 'a.png', type: 'image/png', size: 10 } })).status).toBe(200);
    // A file this size goes up as one PUT, so neither begin created anything to clean up.
    expect(r2Calls().filter((c) => c.method === 'POST')).toHaveLength(0);
  });

  test('an empty routes map is a build error, not a handler that answers 404 to everything', () => {
    expect(() => uploadHandler({ bucket: bucket(), onBeforeUpload: () => ({ path: 'x' }), routes: {} })).toThrow(/empty routes map/);
  });

  test('a name the query cannot carry is refused at build time, not at request time', () => {
    const build = (name: string) => uploadHandler({ bucket: bucket(), routes: { [name]: { onBeforeUpload: () => ({ path: 'x' }) } } });
    expect(() => build('a b')).toThrow(/upload route names must match/);
    expect(() => build('9lives')).toThrow(/upload route names must match/);
    expect(() => build('a/b')).toThrow(/upload route names must match/);
    expect(build('a-b_C1')).toBeDefined();
  });

  test('no bucket anywhere falls back to UPSTASH_BLOB_TOKEN', async () => {
    process.env.UPSTASH_BLOB_TOKEN = TOKEN;
    try {
      const uploads = uploadHandler({ routes: { avatar: { onBeforeUpload: () => ({ path: 'avatar/1.png' }) } } });
      const begin = await began(uploads, 'avatar', { name: 'a.png', type: 'image/png', size: 10 });
      expect(begin.path).toBe('avatar/1.png');
    } finally {
      delete process.env.UPSTASH_BLOB_TOKEN;
    }
  });

  test('no bucket and no token is a build error naming the route and the variable', () => {
    const saved = process.env.UPSTASH_BLOB_TOKEN;
    delete process.env.UPSTASH_BLOB_TOKEN;
    try {
      expect(() => uploadHandler({ routes: { avatar: { onBeforeUpload: () => ({ path: 'x' }) } } })).toThrow(/"avatar" has no bucket and UPSTASH_BLOB_TOKEN is not set/);
      expect(() => uploadHandler({ onBeforeUpload: () => ({ path: 'x' }) })).toThrow(/uploadHandler has no bucket and UPSTASH_BLOB_TOKEN is not set/);
    } finally {
      if (saved !== undefined) process.env.UPSTASH_BLOB_TOKEN = saved;
    }
  });

  test('a route with no onBeforeUpload anywhere is a build error naming the route', () => {
    expect(() => uploadHandler({ bucket: bucket(), routes: { avatar: {} } })).toThrow(/"avatar" has no onBeforeUpload/);
    // Inherited from the handler, so a route that writes nothing at all is fine.
    expect(uploadHandler({ bucket: bucket(), onBeforeUpload: () => ({ path: 'x' }), routes: { avatar: {} } })).toBeDefined();
  });

  test('removed server-transport options fail instead of silently becoming direct uploads', () => {
    expect(() => uploadHandler({ bucket: bucket(), routes: { avatar: { proxy: true, onBeforeUpload: () => ({ path: 'avatar/demo' }) } } } as any)).toThrow(
      'upload routes no longer take proxy',
    );
    expect(() => uploadHandler({ bucket: bucket(), routes: { avatar: uploadRoute()({ field: 'avatar', onBeforeUpload: () => ({ path: 'avatar/demo' }) } as any) } })).toThrow(
      'upload routes no longer take field',
    );
  });

  test('two routes do not share a completion token', async () => {
    const uploads = handler();
    const begin = await began(uploads, 'attachment', { name: 'a.png', type: 'image/png', size: 10 });
    const crossed = await post(uploads, 'large', { phase: 'end', completionToken: begin.completionToken });
    expect(crossed.status).toBe(403);
  });

  test('an endpoint separates two handlers that mount the same names on one bucket', async () => {
    const b = bucket();
    const one = uploadHandler({ bucket: b, endpoint: '/api/one', routes: { docs: { onBeforeUpload: () => ({ path: 'a' }) } } });
    const two = uploadHandler({ bucket: b, endpoint: '/api/two', routes: { docs: { onBeforeUpload: () => ({ path: 'a' }) } } });
    const begin = await began(one, 'docs', { name: 'a', type: '', size: 3 });
    expect((await post(two, 'docs', { phase: 'end', completionToken: begin.completionToken })).status).toBe(403);
  });
});

describe('defaults', () => {
  test('a route replaces constraints per key, and null clears one', async () => {
    const uploads = handler();
    expect(await (await uploads.GET(new Request(url('attachment')))).json()).toEqual({ constraints: { contentTypes: ['image/png'], maxBytes: 20_000_000 } });
    // maxBytes replaced, contentTypes cleared by null.
    expect(await (await uploads.GET(new Request(url('large')))).json()).toEqual({ constraints: { maxBytes: 2_000_000_000 } });
    // maxBytes replaced, the handler's type list inherited.
    expect(await (await uploads.GET(new Request(url('avatar')))).json()).toEqual({ constraints: { contentTypes: ['image/png'], maxBytes: 2_000_000 } });
  });

  test('the inherited constraints still refuse', async () => {
    const uploads = handler();
    const tooBig = await post(uploads, 'attachment', { phase: 'begin', file: { name: 'a.png', type: 'image/png', size: 30_000_000 } });
    expect(tooBig.status).toBe(413);
    const wrongType = await post(uploads, 'attachment', { phase: 'begin', file: { name: 'a.txt', type: 'text/plain', size: 10 } });
    expect(wrongType.status).toBe(400);
    expect((await wrongType.json()).code).toBe('content_type_not_allowed');
    // large cleared the list, so the same file is fine there.
    expect((await post(uploads, 'large', { phase: 'begin', file: { name: 'a.txt', type: 'text/plain', size: 10 } })).status).toBe(200);
  });

  test('onBeforeUpload is inherited and sees the route name; a route replaces it', async () => {
    const uploads = uploadHandler({
      bucket: bucket(),
      onBeforeUpload: ({ route, file }) => ({ path: `${route}/${file.name}` }),
      routes: {
        attachment: {},
        avatar: { onBeforeUpload: () => ({ path: 'avatar/stable' }) },
      },
    });
    expect((await began(uploads, 'attachment', { name: 'a.png', type: 'image/png', size: 4 })).path).toBe('attachment/a.png');
    expect((await began(uploads, 'avatar', { name: 'a.png', type: 'image/png', size: 4 })).path).toBe('avatar/stable');
  });

  test('onUploadComplete is inherited, and a route with its own answers with its own data', async () => {
    const seen: unknown[] = [];
    const uploads = uploadHandler({
      bucket: bucket(),
      onBeforeUpload: ({ route }) => ({ path: `${route}/1.png` }),
      onUploadComplete: ({ route, path, size }) => {
        seen.push({ from: 'default', route, path, size });
        return { shared: true };
      },
      routes: {
        attachment: {},
        avatar: {
          onUploadComplete: ({ route, path }) => {
            seen.push({ from: 'route', route, path });
            return { own: true };
          },
        },
      },
    });

    const a = await began(uploads, 'attachment', { name: 'a.png', type: 'image/png', size: 4 });
    const endA = await post(uploads, 'attachment', { phase: 'end', completionToken: a.completionToken, parts: [{ n: 1, etag: '"p1"' }] });
    expect((await endA.json()).data).toEqual({ shared: true });

    const b = await began(uploads, 'avatar', { name: 'a.png', type: 'image/png', size: 4 });
    const endB = await post(uploads, 'avatar', { phase: 'end', completionToken: b.completionToken, parts: [{ n: 1, etag: '"p1"' }] });
    expect((await endB.json()).data).toEqual({ own: true });

    // Replaced, not chained: the route's own is the only one that ran for avatar.
    expect(seen).toEqual([
      { from: 'default', route: 'attachment', path: 'attachment/1.png', size: 4 },
      { from: 'route', route: 'avatar', path: 'avatar/1.png' },
    ]);
  });

  test('onError is inherited, and a route with its own replaces it', async () => {
    const seen: string[] = [];
    const uploads = uploadHandler({
      bucket: bucket(),
      onBeforeUpload: () => {
        throw new Error('db down');
      },
      onError: ({ route, error }) => {
        seen.push(`default:${route}:${(error as Error).message}`);
        return new BlobError('not_ready');
      },
      routes: {
        attachment: {},
        avatar: {
          onError: ({ route }) => {
            seen.push(`route:${route}`);
            return new BlobError('conflict');
          },
        },
      },
    });
    expect((await post(uploads, 'attachment', { phase: 'begin', file: { name: 'a.png', type: 'image/png', size: 4 } })).status).toBe(503);
    expect((await post(uploads, 'avatar', { phase: 'begin', file: { name: 'a.png', type: 'image/png', size: 4 } })).status).toBe(409);
    // And a route nobody mounted still reaches the handler's own onError.
    expect((await post(uploads, 'nope', { phase: 'begin' })).status).toBe(503);
    expect(seen).toEqual(['default:attachment:db down', 'route:avatar', 'default:nope:Unknown upload route']);
  });

  test('the key order of routes changes nothing', async () => {
    const first = uploadHandler({
      bucket: bucket(),
      constraints: { maxBytes: '20mb' },
      onBeforeUpload: ({ route }) => ({ path: `${route}/1` }),
      routes: { alpha: {}, omega: { constraints: { maxBytes: '1kb' } } },
    });
    const second = uploadHandler({
      bucket: bucket(),
      constraints: { maxBytes: '20mb' },
      onBeforeUpload: ({ route }) => ({ path: `${route}/1` }),
      routes: { omega: { constraints: { maxBytes: '1kb' } }, alpha: {} },
    });
    for (const uploads of [first, second]) {
      expect(await (await uploads.GET(new Request(url('alpha')))).json()).toEqual({ constraints: { maxBytes: 20_000_000 } });
      expect(await (await uploads.GET(new Request(url('omega')))).json()).toEqual({ constraints: { maxBytes: 1_000 } });
    }
  });
});

describe('context', () => {
  test('it reaches every callback of every route, once per request', async () => {
    const seen: string[] = [];
    let ran = 0;
    const uploads = uploadHandler({
      bucket: bucket(),
      context: (request: Request) => {
        ran++;
        return { user: request.headers.get('authorization') ?? 'anon' };
      },
      routes: {
        attachment: {
          onBeforeUpload: ({ ctx }) => {
            seen.push(`before:${ctx.user}`);
            return { path: `u/${ctx.user}.png` };
          },
          onUploadComplete: ({ ctx, path }) => {
            seen.push(`complete:${ctx.user}:${path}`);
            return { user: ctx.user };
          },
        },
      },
    });

    const begin = (await (
      await uploads.POST(
        new Request(url('attachment'), { method: 'POST', body: JSON.stringify({ phase: 'begin', file: { name: 'a.png', type: 'image/png', size: 4 } }), headers: { authorization: 'ada' } }),
      )
    ).json()) as WireBeginResponse;
    marker = begin.upload.parts[0]!.headers![MARKER];
    expect(begin.path).toBe('u/ada.png');

    const end = await uploads.POST(
      new Request(url('attachment'), {
        method: 'POST',
        body: JSON.stringify({ phase: 'end', completionToken: begin.completionToken, parts: [{ n: 1, etag: '"p1"' }] }),
        headers: { authorization: 'ada' },
      }),
    );
    expect(end.status).toBe(200);
    expect((await end.json()).data).toEqual({ user: 'ada' });
    expect(seen).toEqual(['before:ada', 'complete:ada:u/ada.png']);
    // Once per request, and never for the constraints GET.
    expect(ran).toBe(2);
    await uploads.GET(new Request(url('attachment')));
    expect(ran).toBe(2);
  });

  test('a throw refuses the upload before the route runs', async () => {
    let reached = false;
    const uploads = uploadHandler({
      bucket: bucket(),
      context: () => {
        throw new BlobError('unauthorized');
      },
      routes: {
        attachment: {
          onBeforeUpload: () => {
            reached = true;
            return { path: 'x' };
          },
        },
      },
    });
    const res = await post(uploads, 'attachment', { phase: 'begin', file: { name: 'a.png', type: 'image/png', size: 10 } });
    expect(res.status).toBe(401);
    expect((await res.json()).code).toBe('unauthorized');
    expect(reached).toBe(false);
  });
});

describe('direct routes', () => {
  test('begin, then end: the object is checked and the route hears about it', async () => {
    const uploads = uploadHandler({
      bucket: bucket(),
      routes: {
        large: uploadRoute()({
          input: z.object({ threadId: z.string() }),
          onBeforeUpload: ({ input, file }) => ({ path: `t/${input.threadId}/${file.name}`, metadata: { thread: input.threadId }, state: { row: 1 } }),
          onUploadComplete: ({ state, size, uploadId }) => ({ row: state.row, size, dedupe: uploadId }),
        }),
      },
    });
    const begin = await began(uploads, 'large', { name: 'a.bin', type: '', size: 6 }, { threadId: 't1' });
    expect(begin.path).toBe('t/t1/a.bin');
    // One part: a six-byte file is a multipart of one, so it can be paused and retried like any other.
    expect(begin.upload.parts.map((p) => p.n)).toEqual([1]);

    r2Handler = scriptedR2({ 'content-length': '6', etag: '"e"', 'content-type': 'application/octet-stream', 'last-modified': new Date().toUTCString() });
    const end = await post(uploads, 'large', { phase: 'end', completionToken: begin.completionToken, parts: [{ n: 1, etag: '"p1"' }] });
    expect(end.status).toBe(200);
    const body = (await end.json()) as any;
    expect(body.blob.size).toBe(6);
    expect(body.data.row).toBe(1);
    expect(typeof body.data.dedupe).toBe('string');

    const bad = await post(uploads, 'large', { phase: 'begin', file: { name: 'a.bin', type: '', size: 6 }, input: { threadId: 7 } });
    expect(bad.status).toBe(400);
    expect((await bad.json()).code).toBe('invalid_input');
  });
});
