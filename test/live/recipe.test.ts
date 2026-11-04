import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { BlobError, uniquePath, uploadHandler } from '../../src/index.ts';
import { upload } from '../../src/browser/index.ts';
import { clock } from '../../src/browser/clock.ts';
import { FetchXhr, installRouter, installXhr } from '../helpers/xhr.ts';
import { bytes, cleanup, priv, root, sweep } from './setup.ts';

// The README's AI agents recipe, run against a real private bucket: the handler as written there,
// with a header standing in for the session and a Map for the database.
const restore: (() => void)[] = [];
const memory = new Map<string, string>();
const rows = new Map<string, { path: string; ownerId: string; name: string; size: number }>();
const getUser = async (request: Request) => {
  const id = request.headers.get('x-user');
  return id ? { id } : null;
};

const uploads = uploadHandler({
  bucket: priv,
  constraints: { maxSize: '1gb' },
  context: async (request: Request) => {
    const user = await getUser(request);
    if (!user) throw new BlobError('unauthorized');
    return user;
  },
  // The owner is fixed here, where the path is, and not read from whoever's session finishes it.
  onBeforeUpload: ({ ctx, file }) => ({ path: root + uniquePath(`${ctx.id}/${file.name}`), state: { ownerId: ctx.id } }),
  onUploadComplete: async ({ state, path, size, file }) => {
    rows.set(path, { path, ownerId: state.ownerId, name: file.name, size });
    return { path, name: file.name };
  },
});

// Every PUT the client sends, and the first PUT of part 2 fails once after sending bytes.
const puts: string[] = [];
let failPart2 = false;
class FlakyXhr extends FetchXhr {
  override send(body: unknown): void {
    if (this.method === 'PUT') puts.push(this.url);
    if (failPart2 && this.method === 'PUT' && /partNumber=2\b/.test(this.url)) {
      failPart2 = false;
      this.upload.onprogress?.({ loaded: 1, total: 2, lengthComputable: true });
      queueMicrotask(() => this.onerror?.({}));
      return;
    }
    super.send(body);
  }
}

// Captures what alice's browser sent, so a signed-out caller can replay it.
const sent: { body: any }[] = [];

beforeAll(async () => {
  (globalThis as any).localStorage = {
    getItem: (k: string) => memory.get(k) ?? null,
    setItem: (k: string, v: string) => void memory.set(k, v),
    removeItem: (k: string) => void memory.delete(k),
  };
  clock.frame = (cb) => queueMicrotask(cb);
  restore.push(installXhr(FlakyXhr));
  restore.push(
    installRouter({
      '/api/upload': {
        GET: uploads.GET,
        POST: async (request) => {
          sent.push({ body: await request.clone().json() });
          return uploads.POST(request);
        },
      },
    }),
  );
  await sweep(priv);
});
afterAll(async () => {
  for (const r of restore) r();
  await cleanup(priv);
});

const as = (user: string) => ({ headers: () => ({ 'x-user': user }) });
const replaySignedOut = (body: unknown) =>
  uploads.POST(new Request('https://app.test/api/upload', { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }));

describe('README recipe', () => {
  test('a multipart upload survives a failed part, records one row, and refuses signed-out replays', async () => {
    failPart2 = true;
    puts.length = 0;
    sent.length = 0;
    const file = new File([bytes(17 * 1024 * 1024, 7)], 'big file.bin', { type: 'application/octet-stream' });
    const blob = await upload(file, { route: '/api/upload', ...as('alice') }).done;
    expect(blob.data).toEqual({ path: blob.path, name: 'big file.bin' });
    expect(rows.get(blob.path)).toEqual({ path: blob.path, ownerId: 'alice', name: 'big file.bin', size: file.size });
    expect((await priv.info(blob.path)).size).toBe(file.size);
    // Four parts, part 2 sent twice, nothing else resent.
    expect(puts.filter((u) => /partNumber=2\b/.test(u))).toHaveLength(2);
    expect(puts).toHaveLength(5);

    for (const { body } of sent.filter((s) => s.body.phase !== 'begin')) {
      for (const phase of ['end', 'parts', 'cancel']) {
        const res = await replaySignedOut({ ...body, phase });
        expect(res.status).toBe(401);
        expect(await res.text()).not.toContain(blob.path);
      }
    }
    expect(rows.get(blob.path)!.ownerId).toBe('alice');
    expect((await priv.info(blob.path)).size).toBe(file.size);
  });

  test('cancel at 0% and mid-upload stores nothing and writes no row', async () => {
    const before = new Set((await priv.list({ prefix: root })).blobs.map((b) => b.path));
    const rowsBefore = rows.size;

    const early = upload(new File([bytes(2000, 3)], 'early.bin'), { route: '/api/upload', ...as('alice') });
    expect(early.cancel()).toBe(true);
    await expect(early.done).rejects.toMatchObject({ name: 'AbortError' });
    expect(early.snapshot().status).toBe('canceled');

    const mid = upload(new File([bytes(17 * 1024 * 1024, 4)], 'mid.bin'), { route: '/api/upload', ...as('alice') });
    await new Promise<void>((resolve) => {
      const off = mid.subscribe(() => {
        if (mid.snapshot().loaded > 0) {
          off();
          resolve();
        }
      });
    });
    expect(mid.cancel()).toBe(true);
    await expect(mid.done).rejects.toMatchObject({ name: 'AbortError' });
    expect(mid.snapshot().status).toBe('canceled');

    // The cancel request is fire and forget; give it a moment, then nothing may be left.
    await new Promise((r) => setTimeout(r, 2000));
    expect(new Set((await priv.list({ prefix: root })).blobs.map((b) => b.path))).toEqual(before);
    expect(rows.size).toBe(rowsBefore);
    expect((await priv.listMultipartUploads({ prefix: root })).some((u) => u.path.includes('mid'))).toBe(false);
  });
});
