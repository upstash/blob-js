import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import * as z from 'zod';
import { BlobError, Bucket, upload, uploadRouter } from '../../src/index.ts';
import { resetCredentialCaches } from '../../src/server/credentials.ts';
import { encodeToken } from '../../src/server/token.ts';
import type { WireBeginResponse } from '../../src/shared/types.ts';

// The router against a scripted R2. What matters here is the dispatch and the composition: which
// route a request reaches, what it inherits, and what the observers are told.

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

beforeEach(() => {
  calls = [];
  r2Handler = () => new Response('', { status: 200 });
  resetCredentialCaches();
});

const bucket = () => new Bucket({ token: TOKEN });
const r2Calls = () => calls.filter((c) => c.url.startsWith(ENDPOINT));

// A real png header: put() sniffs, so 'looks like a png' is not enough.
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);

const url = (route?: string) => `https://app.test/api/upload${route === undefined ? '' : `?route=${route}`}`;

const post = (router: { POST: (r: Request) => Promise<Response> }, route: string | undefined, body: unknown) =>
  router.POST(new Request(url(route), { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }));

const form = (file: File, route: string, field = 'file', input?: unknown): Request => {
  const body = new FormData();
  body.append(field, file);
  if (input !== undefined) body.append('input', JSON.stringify(input));
  return new Request(url(route), { method: 'POST', body });
};

const png = (name = 'a.png') => new File([PNG as BlobPart], name, { type: 'image/png' });

function router(extra: Record<string, unknown> = {}) {
  return uploadRouter({
    bucket: bucket(),
    limits: { maxBytes: '20mb', allowedContentTypes: ['image/png'] },
    routes: {
      attachment: upload({ onBeforeUpload: () => ({ path: 'attachment/1.png' }) }),
      large: upload({ limits: { maxBytes: '2gb', allowedContentTypes: null }, onBeforeUpload: () => ({ path: 'large/1.bin' }) }),
      avatar: upload({ proxy: true, limits: { maxBytes: '2mb' }, onBeforeUpload: () => ({ path: 'avatar/demo' }) }),
    },
    ...extra,
  });
}

describe('dispatch', () => {
  test('the query names the route, for GET and for POST', async () => {
    const uploads = router();
    const res = await uploads.GET(new Request(url('large')));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ limits: { maxBytes: 2_000_000_000 }, transport: 'direct' });

    const begin = await post(uploads, 'attachment', { phase: 'begin', file: { name: 'a.png', type: 'image/png', size: 10 } });
    expect(begin.status).toBe(200);
    expect(((await begin.json()) as WireBeginResponse).path).toBe('attachment/1.png');
  });

  // better-upload 3.0.19 selects with `route in router.routes` on a plain object literal, so
  // {"route":"toString"} finds Object.prototype's and dispatches to a function with no callbacks.
  test('a name off Object.prototype is not a route', async () => {
    const uploads = router();
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
    const uploads = router();
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

  test('a name the query cannot carry is refused at build time, not at request time', () => {
    const build = (name: string) =>
      uploadRouter({ bucket: bucket(), routes: { [name]: upload({ onBeforeUpload: () => ({ path: 'x' }) }) } });
    expect(() => build('a b')).toThrow(/upload route names must match/);
    expect(() => build('9lives')).toThrow(/upload route names must match/);
    expect(() => build('a/b')).toThrow(/upload route names must match/);
    expect(build('a-b_C1')).toBeDefined();
  });

  test('a route with no bucket anywhere is a build error naming the route', () => {
    expect(() => uploadRouter({ routes: { avatar: upload({ onBeforeUpload: () => ({ path: 'x' }) }) } })).toThrow(/"avatar" has no bucket/);
  });

  test('two routes do not share a completion token', async () => {
    const uploads = router();
    const begin = (await (await post(uploads, 'attachment', { phase: 'begin', file: { name: 'a.png', type: 'image/png', size: 10 } })).json()) as WireBeginResponse;
    const crossed = await post(uploads, 'large', { phase: 'end', completionToken: begin.completionToken });
    expect(crossed.status).toBe(403);
  });
});

describe('limits', () => {
  test('a route replaces the router per key, and null clears one', async () => {
    const uploads = router();
    expect(await (await uploads.GET(new Request(url('attachment')))).json()).toEqual({ limits: { allowedContentTypes: ['image/png'], maxBytes: 20_000_000 }, transport: 'direct' });
    // maxBytes replaced, allowedContentTypes cleared by null.
    expect(await (await uploads.GET(new Request(url('large')))).json()).toEqual({ limits: { maxBytes: 2_000_000_000 }, transport: 'direct' });
    // maxBytes replaced, the router's type list inherited.
    expect(await (await uploads.GET(new Request(url('avatar')))).json()).toEqual({ limits: { allowedContentTypes: ['image/png'], maxBytes: 2_000_000 }, transport: 'proxy' });
  });

  test('the inherited limits still refuse', async () => {
    const uploads = router();
    const tooBig = await post(uploads, 'attachment', { phase: 'begin', file: { name: 'a.png', type: 'image/png', size: 30_000_000 } });
    expect(tooBig.status).toBe(413);
    const wrongType = await post(uploads, 'attachment', { phase: 'begin', file: { name: 'a.txt', type: 'text/plain', size: 10 } });
    expect(wrongType.status).toBe(400);
    expect((await wrongType.json()).code).toBe('content_type_not_allowed');
    // large cleared the list, so the same file is fine there.
    expect((await post(uploads, 'large', { phase: 'begin', file: { name: 'a.txt', type: 'text/plain', size: 10 } })).status).toBe(200);
  });
});

describe('context', () => {
  test('it reaches every callback of every route, once per request', async () => {
    const seen: string[] = [];
    let ran = 0;
    const uploads = uploadRouter({
      bucket: bucket(),
      context: (request) => {
        ran++;
        return { user: request.headers.get('authorization') ?? 'anon' };
      },
      routes: (upload) => ({
        attachment: upload({
          onBeforeUpload: ({ ctx }) => {
            seen.push(`before:${ctx.user}`);
            return { path: `u/${ctx.user}.png`, state: { row: 7 } };
          },
          onUploadCompleted: ({ ctx, state, path }) => {
            seen.push(`completed:${ctx.user}:${state.row}:${path}`);
            return { row: state.row };
          },
        }),
      }),
    });

    const begin = (await (
      await uploads.POST(
        new Request(url('attachment'), { method: 'POST', body: JSON.stringify({ phase: 'begin', file: { name: 'a.png', type: 'image/png', size: 4 } }), headers: { authorization: 'ada' } }),
      )
    ).json()) as WireBeginResponse;
    expect(begin.path).toBe('u/ada.png');

    r2Handler = (call) => (call.method === 'HEAD' ? new Response('', { status: 200, headers: { 'content-length': '4', etag: '"e"', 'content-type': 'image/png', 'last-modified': new Date().toUTCString() } }) : new Response('', { status: 200 }));
    const end = await uploads.POST(
      new Request(url('attachment'), { method: 'POST', body: JSON.stringify({ phase: 'end', completionToken: begin.completionToken }), headers: { authorization: 'ada' } }),
    );
    expect(end.status).toBe(200);
    expect((await end.json()).data).toEqual({ row: 7 });
    expect(seen).toEqual(['before:ada', 'completed:ada:7:u/ada.png']);
    // Once per request, and never for the limits GET.
    expect(ran).toBe(2);
    await uploads.GET(new Request(url('attachment')));
    expect(ran).toBe(2);
  });

  test('a throw refuses the upload before the route runs', async () => {
    let reached = false;
    const uploads = uploadRouter({
      bucket: bucket(),
      context: () => {
        throw new BlobError('unauthorized');
      },
      routes: (upload) => ({
        attachment: upload({
          onBeforeUpload: () => {
            reached = true;
            return { path: 'x' };
          },
        }),
      }),
    });
    const res = await post(uploads, 'attachment', { phase: 'begin', file: { name: 'a.png', type: 'image/png', size: 10 } });
    expect(res.status).toBe(401);
    expect((await res.json()).code).toBe('unauthorized');
    expect(reached).toBe(false);
  });
});

describe('observers', () => {
  test('onUploadCompleted fires for every route, after the route it belongs to', async () => {
    const events: unknown[] = [];
    const uploads = uploadRouter({
      bucket: bucket(),
      onUploadCompleted: ({ route, path, size, data }) => {
        events.push({ route, path, size, data });
      },
      routes: {
        attachment: upload({ onBeforeUpload: () => ({ path: 'a/1.png' }), onUploadCompleted: () => ({ row: 3 }) }),
      },
    });
    const begin = (await (await post(uploads, 'attachment', { phase: 'begin', file: { name: 'a.png', type: 'image/png', size: 4 } })).json()) as WireBeginResponse;
    r2Handler = (call) => (call.method === 'HEAD' ? new Response('', { status: 200, headers: { 'content-length': '4', etag: '"e"', 'content-type': 'image/png', 'last-modified': new Date().toUTCString() } }) : new Response('', { status: 200 }));
    await post(uploads, 'attachment', { phase: 'end', completionToken: begin.completionToken });
    expect(events).toEqual([{ route: 'attachment', path: 'a/1.png', size: 4, data: { row: 3 } }]);
  });

  test('onError sees the refusal whatever it was, and cannot change the answer', async () => {
    const events: { route: string; code: string | undefined; message: string }[] = [];
    const uploads = uploadRouter({
      bucket: bucket(),
      limits: { maxBytes: '1mb' },
      onError: ({ route, error }) => {
        events.push({ route, code: BlobError.is(error) ? error.code : undefined, message: (error as Error).message });
        throw new Error('an observer must not be able to break the route');
      },
      routes: {
        attachment: upload({
          onBeforeUpload: ({ file }) => {
            if (file.name === 'boom.png') throw Object.assign(new Error('no seats left'), { status: 402 });
            return { path: 'a/1.png' };
          },
        }),
      },
    });

    // A BlobError the SDK raised.
    expect((await post(uploads, 'attachment', { phase: 'begin', file: { name: 'a.png', type: 'image/png', size: 9_000_000 } })).status).toBe(413);
    // Something the app threw that named a status.
    expect((await post(uploads, 'attachment', { phase: 'begin', file: { name: 'boom.png', type: 'image/png', size: 4 } })).status).toBe(402);
    // A route nobody mounted.
    expect((await post(uploads, 'nope', { phase: 'begin' })).status).toBe(404);

    expect(events.map((e) => [e.route, e.code])).toEqual([
      ['attachment', 'too_large'],
      // As thrown: the observer gets the app's own error, not the BlobError the status became.
      ['attachment', undefined],
      ['nope', 'not_found'],
    ]);
    expect(events[1]!.message).toBe('no seats left');
  });

  test("a route's own onError still maps, and the observer sees it too", async () => {
    const seen: string[] = [];
    const uploads = uploadRouter({
      bucket: bucket(),
      context: () => ({ user: 'ada' }),
      onError: ({ error }) => {
        seen.push(`observed:${(error as Error).message}`);
      },
      routes: (upload) => ({
        attachment: upload({
          onBeforeUpload: () => {
            throw new Error('db down');
          },
          onError: ({ error, ctx }) => {
            seen.push(`mapped:${ctx?.user}`);
            return new BlobError('not_ready', { message: (error as Error).message });
          },
        }),
      }),
    });
    const res = await post(uploads, 'attachment', { phase: 'begin', file: { name: 'a.png', type: 'image/png', size: 4 } });
    expect(res.status).toBe(503);
    expect((await res.json()).code).toBe('not_ready');
    expect(seen).toEqual(['mapped:ada', 'observed:db down']);
  });

  test('nothing claimed it: it stays the framework\'s to log, and the observer still hears', async () => {
    const seen: unknown[] = [];
    const uploads = uploadRouter({
      bucket: bucket(),
      onError: ({ error }) => {
        seen.push((error as Error).message);
      },
      routes: {
        attachment: upload({
          onBeforeUpload: () => {
            throw new Error('bug');
          },
        }),
      },
    });
    await expect(post(uploads, 'attachment', { phase: 'begin', file: { name: 'a.png', type: 'image/png', size: 4 } })).rejects.toThrow('bug');
    expect(seen).toEqual(['bug']);
  });
});

describe('proxy routes', () => {
  test('the same router serves a proxied upload, and the bytes go through it', async () => {
    const completed: unknown[] = [];
    const uploads = uploadRouter({
      bucket: bucket(),
      context: () => ({ user: 'ada' }),
      routes: (upload) => ({
        avatar: upload({
          proxy: true,
          limits: { maxBytes: '2mb', allowedContentTypes: ['image/png'] },
          onBeforeUpload: ({ ctx, file }) => ({ path: `avatar/${ctx.user}`, overwrite: true, state: { name: file.name } }),
          onUploadCompleted: ({ ctx, state, path, contentType }) => {
            completed.push({ user: ctx.user, name: state.name, path, contentType });
            return { ok: true };
          },
        }),
      }),
    });
    r2Handler = () => new Response('', { status: 200, headers: { etag: '"e1"' } });
    const res = await uploads.POST(form(png(), 'avatar'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.blob.path).toBe('avatar/ada');
    expect(body.data).toEqual({ ok: true });
    expect(completed).toEqual([{ user: 'ada', name: 'a.png', path: 'avatar/ada', contentType: 'image/png' }]);
    expect(r2Calls().some((c) => c.method === 'PUT')).toBe(true);
  });

  test('bytes that do not prove their type are refused before anything is stored', async () => {
    const uploads = router();
    const html = new File([new TextEncoder().encode('<html><script>x</script>') as BlobPart], 'a.png', { type: 'image/png' });
    const res = await uploads.POST(form(html, 'avatar'));
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('content_type_not_allowed');
    expect(r2Calls().some((c) => c.method === 'PUT')).toBe(false);
  });

  test('a proxy route takes input, as a JSON form field beside the file', async () => {
    let seen: unknown;
    const uploads = uploadRouter({
      bucket: bucket(),
      routes: {
        avatar: upload({
          proxy: true,
          input: z.object({ albumId: z.string() }),
          onBeforeUpload: ({ input }) => {
            seen = input;
            return { path: `album/${input.albumId}` };
          },
        }),
      },
    });
    r2Handler = () => new Response('', { status: 200, headers: { etag: '"e1"' } });
    expect((await uploads.POST(form(png(), 'avatar', 'file', { albumId: 'a1' }))).status).toBe(200);
    expect(seen).toEqual({ albumId: 'a1' });

    const bad = await uploads.POST(form(png(), 'avatar', 'file', { albumId: 7 }));
    expect(bad.status).toBe(400);
    expect((await bad.json()).code).toBe('invalid_input');
  });

  test('a put that fails after onBeforeUpload tells the app, so its row is not stranded', async () => {
    const released: unknown[] = [];
    const uploads = uploadRouter({
      bucket: bucket(),
      routes: {
        avatar: upload({
          proxy: true,
          onBeforeUpload: () => ({ path: 'avatar/demo', state: { row: 9 } }),
          onBeforeUploadFailed: ({ decided, error }) => {
            released.push({ state: decided.state, code: error.code });
          },
        }),
      },
    });
    r2Handler = () => new Response('<Error><Code>InternalError</Code></Error>', { status: 500 });
    const res = await uploads.POST(form(png(), 'avatar'));
    expect(res.status).toBeGreaterThanOrEqual(500);
    expect(released).toEqual([{ state: { row: 9 }, code: 'request_failed' }]);
  });

  test('the field option names the form field on a proxy route', async () => {
    const uploads = uploadRouter({
      bucket: bucket(),
      routes: { avatar: upload({ proxy: true, field: 'avatar', onBeforeUpload: () => ({ path: 'avatar/demo' }) }) },
    });
    r2Handler = () => new Response('', { status: 200, headers: { etag: '"e1"' } });
    expect((await uploads.POST(form(png(), 'avatar', 'avatar'))).status).toBe(200);
    const wrong = await uploads.POST(form(png(), 'avatar', 'file'));
    expect(wrong.status).toBe(400);
    expect((await wrong.json()).message).toBe('The request needs a avatar field holding the file');
  });
});

describe('direct routes', () => {
  test('begin, then end: the object is checked and the route hears about it', async () => {
    const uploads = uploadRouter({
      bucket: bucket(),
      routes: {
        large: upload({
          input: z.object({ threadId: z.string() }),
          onBeforeUpload: ({ input, file }) => ({ path: `t/${input.threadId}/${file.name}`, metadata: { thread: input.threadId }, state: { row: 1 } }),
          onUploadCompleted: ({ state, size, uploadId }) => ({ row: state.row, size, dedupe: uploadId }),
        }),
      },
    });
    const begin = (await (await post(uploads, 'large', { phase: 'begin', file: { name: 'a.bin', type: '', size: 6 }, input: { threadId: 't1' } })).json()) as WireBeginResponse;
    expect(begin.path).toBe('t/t1/a.bin');
    expect(begin.upload.kind).toBe('single');

    r2Handler = (call) => (call.method === 'HEAD' ? new Response('', { status: 200, headers: { 'content-length': '6', etag: '"e"', 'content-type': 'application/octet-stream', 'last-modified': new Date().toUTCString() } }) : new Response('', { status: 200 }));
    const end = await post(uploads, 'large', { phase: 'end', completionToken: begin.completionToken });
    expect(end.status).toBe(200);
    const body = (await end.json()) as any;
    expect(body.blob.size).toBe(6);
    expect(body.data.row).toBe(1);
    expect(typeof body.data.dedupe).toBe('string');

    const bad = await post(uploads, 'large', { phase: 'begin', file: { name: 'a.bin', type: '', size: 6 }, input: { threadId: 7 } });
    expect(bad.status).toBe(400);
    expect((await bad.json()).code).toBe('invalid_input');
  });

  test('an endpoint separates two routers that mount the same names on one bucket', async () => {
    const b = bucket();
    const one = uploadRouter({ bucket: b, endpoint: '/api/one', routes: { docs: upload({ onBeforeUpload: () => ({ path: 'a' }) }) } });
    const two = uploadRouter({ bucket: b, endpoint: '/api/two', routes: { docs: upload({ onBeforeUpload: () => ({ path: 'a' }) }) } });
    const begin = (await (await post(one, 'docs', { phase: 'begin', file: { name: 'a', type: '', size: 3 } })).json()) as WireBeginResponse;
    expect((await post(two, 'docs', { phase: 'end', completionToken: begin.completionToken })).status).toBe(403);
  });
});
