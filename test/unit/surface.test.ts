import { describe, expect, test } from 'bun:test';
import { Bucket, type PutOptions } from '../../src/index.ts';
import type { UploadOptions } from '../../src/browser/index.ts';
import { encodeToken } from '../../src/server/token.ts';

describe('public surface', () => {
  test('fromEnv names the missing variable and the Workers form', () => {
    expect(() => Bucket.fromEnv('UPSTASH_BLOB_NOPE')).toThrow(/UPSTASH_BLOB_NOPE is not set.*new Bucket\(\{ token: env\.UPSTASH_BLOB_NOPE \}\)/);
  });

  test('fromEnv takes the constructor options too', () => {
    process.env.UPSTASH_BLOB_SURFACE = encodeToken('bucket', 'pw', 'bdeadbeef012');
    try {
      const b = Bucket.fromEnv('UPSTASH_BLOB_SURFACE', { visibility: 'private', cache: '1m' });
      expect(b).toBeInstanceOf(Bucket);
      // The token in the options is ignored: fromEnv's whole job is to read it from the environment.
      // @ts-expect-error token is not one of fromEnv's options
      void Bucket.fromEnv('UPSTASH_BLOB_SURFACE', { token: 'x' });
    } finally {
      delete process.env.UPSTASH_BLOB_SURFACE;
    }
  });

  test('nothing SPEC does not name', () => {
    // @ts-expect-error signal is not a put() option
    const _opts: PutOptions = { signal: new AbortController().signal };
    // @ts-expect-error headers is a function, re-read per call
    const _upload: UploadOptions = { route: '/x', headers: { authorization: 'x' } };
    const bucket = new Bucket({ token: encodeToken('bucket', 'pw', 'bdeadbeef012') });
    // @ts-expect-error the bucket id is not public
    void bucket.id;
    expect(Object.keys(bucket)).not.toContain('id');
  });
});
