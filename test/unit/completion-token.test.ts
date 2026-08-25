import { describe, expect, test } from 'bun:test';
import { signToken, verifyToken, type TokenPayload } from '../../src/server/completion-token.ts';

const KEY = 'bucket-password';
const OTHER_KEY = 'bucket-password ';

const single: TokenPayload = {
  v: 1,
  kind: 'single',
  b: 'ac63f03a-4c24-4ed2-a0e3-ab78d70b62d7',
  r: 'route1',
  id: '9c1f0f5a-1f2e-4a3b-8c4d-5e6f7a8b9c0d',
  path: 'chat/42/holiday-8kZP4mQr.png',
  type: 'image/png',
  size: 4211,
  headers: { 'content-type': 'image/png', 'cache-control': 'public, max-age=31536000, immutable' },
  allowed: ['image/png'],
  ctx: { rowId: 7, owner: '42' },
  exp: Date.now() + 86_400_000,
};

const multipart: TokenPayload = { ...single, kind: 'multipart', uploadId: 'r2-upload-id', partSize: 5 * 1024 * 1024 };

describe('signToken / verifyToken', () => {
  test('round trips the grant, the context and the upload id', async () => {
    const token = await signToken(single, KEY);
    expect(await verifyToken(token, KEY)).toEqual(single);
    expect(await verifyToken(await signToken(multipart, KEY), KEY)).toEqual(multipart);
  });

  test('is base64url payload plus mac, so it survives a JSON body and a URL', async () => {
    const token = await signToken(single, KEY);
    expect(token).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(encodeURIComponent(token)).toBe(token);
  });

  test('signed is not encrypted: the payload is readable', async () => {
    const [body] = (await signToken(single, KEY)).split('.');
    const b64 = body!.replace(/-/g, '+').replace(/_/g, '/');
    const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
    const json = JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0))));
    expect(json.ctx).toEqual({ rowId: 7, owner: '42' });
  });

  test('a tampered payload is refused', async () => {
    const token = await signToken(single, KEY);
    const [body, sig] = token.split('.');
    expect(await verifyToken(`${body}x.${sig}`, KEY)).toBeUndefined();
    expect(await verifyToken(`${body}.${sig}x`, KEY)).toBeUndefined();

    const forged = await signToken({ ...single, size: 1, path: 'other' }, KEY);
    expect(await verifyToken(`${forged.split('.')[0]}.${sig}`, KEY)).toBeUndefined();
  });

  test('another bucket key is refused', async () => {
    const token = await signToken(single, KEY);
    expect(await verifyToken(token, OTHER_KEY)).toBeUndefined();
    expect(await verifyToken(token, '')).toBeUndefined();
  });

  test('malformed input is refused rather than thrown', async () => {
    expect(await verifyToken('', KEY)).toBeUndefined();
    expect(await verifyToken('nodot', KEY)).toBeUndefined();
    expect(await verifyToken('.', KEY)).toBeUndefined();
    expect(await verifyToken('a.b.c', KEY)).toBeUndefined();
  });

  test('a valid mac over a payload that is not v1 is refused', async () => {
    const token = await signToken({ ...single, v: 2 as unknown as 1 }, KEY);
    expect(await verifyToken(token, KEY)).toBeUndefined();
  });
});
