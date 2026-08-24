import { Bucket } from '../../src/index.ts';

export const pub = Bucket.fromEnv('UPSTASH_BLOB_PUBLIC_TOKEN');
export const priv = Bucket.fromEnv('UPSTASH_BLOB_PRIVATE_TOKEN');

export const runId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
export const root = `test/${runId}/`;
export const p = (name: string) => `${root}${name}`;

// A crashed run leaves test/<runId>/ behind; sweep anything older than an hour.
export async function sweep(bucket: Bucket): Promise<void> {
  const cutoff = Date.now() - 3600_000;
  let cursor: string | undefined;
  const stale = new Set<string>();
  do {
    const page = await bucket.list({ prefix: 'test/', limit: 1000, cursor });
    for (const b of page.blobs) {
      const id = b.path.split('/')[1] ?? '';
      const started = parseInt(id.split('-')[0] ?? '', 36);
      if (Number.isFinite(started) && started < cutoff) stale.add(`test/${id}/`);
    }
    cursor = page.cursor;
  } while (cursor);
  for (const prefix of stale) await bucket.del({ prefix });
}

export async function cleanup(bucket: Bucket): Promise<void> {
  await bucket.del({ prefix: root });
}

export function bytes(n: number, seed = 1): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(new ArrayBuffer(n));
  let x = seed >>> 0 || 1;
  for (let i = 0; i < n; i++) {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    out[i] = x & 0xff;
  }
  return out;
}

export const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0]);
