import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { BlobError } from '../../src/index.ts';
import { clock } from '../../src/browser/clock.ts';
import { ServerUploadTask } from '../../src/react/server-upload-task.ts';
import { FetchXhr, installRouter, installXhr } from '../helpers/xhr.ts';
import { cleanup, p, PNG, pub, sweep } from './setup.ts';

const restore: (() => void)[] = [];
beforeAll(async () => {
  clock.frame = (cb) => queueMicrotask(cb);
  restore.push(installXhr(FetchXhr));
  await sweep(pub);
});
afterAll(async () => {
  restore.forEach((fn) => fn());
  await cleanup(pub);
});

const guard = (fn: (req: Request) => Promise<Response>) => async (req: Request) => {
  try {
    if (!req.headers.get('authorization')) throw new BlobError('unauthorized');
    return await fn(req);
  } catch (error) {
    if (!BlobError.is(error)) throw error;
    return Response.json(error.toJSON(), { status: error.status });
  }
};

restore.push(
  installRouter({
    '/api/avatar': {
      POST: guard(async (req) => {
        const file = (await req.formData()).get('file');
        if (!(file instanceof File)) return Response.json({ error: 'file field required' }, { status: 400 });
        const blob = await pub.put(p('avatar/42'), file, { contentTypes: ['image/png'], maxBytes: '2mb', cache: '1m' });
        return Response.json({ url: blob.versionedUrl });
      }),
    },
    '/api/avatar/raw': {
      POST: guard(async (req) => {
        const blob = await pub.put(p('avatar/42'), req, { contentTypes: ['image/png'], maxBytes: '2mb' });
        return Response.json({ url: blob.versionedUrl });
      }),
    },
  }),
);

function run<T>(task: ServerUploadTask<T>) {
  task.start();
  return new Promise<ReturnType<ServerUploadTask<T>['snapshot']>>((resolve) => {
    const check = () => {
      const snapshot = task.snapshot();
      if (snapshot.status === 'done' || snapshot.status === 'error' || snapshot.status === 'canceled') resolve(snapshot);
    };
    task.subscribe(check);
    check();
  });
}

const png = (size: number) => {
  const bytes = new Uint8Array(size);
  bytes.set(PNG);
  return bytes;
};

describe('server upload primitive', () => {
  test('multipart file upload returns the ordinary route JSON unchanged', async () => {
    const file = new File([png(900)], 'me.png', { type: 'image/png' });
    const form = new FormData();
    form.append('file', file);
    const result = await run(new ServerUploadTask<{ url: string }>({ route: '/api/avatar', headers: () => ({ authorization: 'Bearer 42' }), body: form, file, total: file.size }));
    expect(result.status).toBe('done');
    if (result.status !== 'done') throw new Error();
    expect(result.response.url).toMatch(/\?v=/);
    expect(result.percent).toBe(100);
  });

  test('raw file bodies are supported', async () => {
    const file = new File([png(950)], 'me.png', { type: 'image/png' });
    const result = await run(new ServerUploadTask<{ url: string }>({ route: '/api/avatar/raw', headers: () => ({ authorization: 'Bearer 42' }), body: file, file, total: file.size }));
    expect(result.status).toBe('done');
    expect((await pub.info(p('avatar/42'))).size).toBe(950);
  });

  test('BlobError JSON preserves its code and status', async () => {
    const result = await run(new ServerUploadTask({ route: '/api/avatar', body: new FormData(), file: null, total: 0 }));
    expect(result.status).toBe('error');
    expect(result.status === 'error' && result.error.code).toBe('unauthorized');
    expect(result.status === 'error' && result.error.status).toBe(401);
  });
});
