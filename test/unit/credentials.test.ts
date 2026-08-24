import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Bucket } from '../../src/index.ts';
import { CredentialCache } from '../../src/server/credentials.ts';
import { encodeToken } from '../../src/server/token.ts';
import { VERSION } from '../../src/version.ts';

const realFetch = globalThis.fetch;
const realDisable = process.env.UPSTASH_DISABLE_TELEMETRY;
beforeEach(() => {
  delete process.env.UPSTASH_DISABLE_TELEMETRY;
});
afterEach(() => {
  globalThis.fetch = realFetch;
  if (realDisable === undefined) delete process.env.UPSTASH_DISABLE_TELEMETRY;
  else process.env.UPSTASH_DISABLE_TELEMETRY = realDisable;
});

function mockMint(): { headers: () => Headers } {
  let last: Headers | undefined;
  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    last = new Headers(init?.headers);
    return Response.json({
      accessKeyId: 'ak',
      secretAccessKey: 'sk',
      sessionToken: 'st',
      endpoint: 'https://x.r2.cloudflarestorage.com',
      bucket: 'b',
      region: 'auto',
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
    });
  }) as typeof fetch;
  return { headers: () => last! };
}

describe('credential mint telemetry', () => {
  test('sends the telemetry headers by default', async () => {
    const m = mockMint();
    await new CredentialCache('tok').get();
    expect(m.headers().get('authorization')).toBe('Bearer tok');
    expect(m.headers().get('upstash-telemetry-sdk')).toBe(`upstash-blob-js@${VERSION}`);
    expect(m.headers().get('upstash-telemetry-runtime')).toStartWith('bun@');
  });

  test('enableTelemetry: false sends only the authorization header', async () => {
    const m = mockMint();
    await new CredentialCache('tok', false).get();
    expect([...m.headers().keys()]).toEqual(['authorization']);
  });

  test('new Bucket({ enableTelemetry: false }) reaches the mint request', async () => {
    const m = mockMint();
    const bucket = new Bucket({ token: encodeToken('bucket', 'pw', 'bdeadbeef012'), enableTelemetry: false });
    await bucket.signedReadUrl('a.txt');
    expect(m.headers().get('upstash-telemetry-sdk')).toBeNull();
    expect(m.headers().get('authorization')).toStartWith('Bearer ');
  });

  test('new Bucket({}) sends telemetry by default', async () => {
    const m = mockMint();
    await new Bucket({ token: encodeToken('bucket', 'pw', 'bdeadbeef012') }).signedReadUrl('a.txt');
    expect(m.headers().get('upstash-telemetry-sdk')).toBe(`upstash-blob-js@${VERSION}`);
  });
});
