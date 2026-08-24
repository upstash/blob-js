import { describe, expect, test } from 'bun:test';
import { decodeToken, encodeToken, publicHostname, toBase64Url } from '../../src/server/token.ts';

const BUCKET = 'ac63f03a-4c24-4ed2-a0e3-ab78d70b62d7';

function reencode(mutate: (bytes: Uint8Array) => Uint8Array): string {
  const token = encodeToken(BUCKET, 'hunter2', 0);
  const b64 = token.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (token.length % 4)) % 4);
  const bin = atob(b64);
  const raw = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) raw[i] = bin.charCodeAt(i);
  return toBase64Url(mutate(raw));
}

describe('encodeToken / decodeToken', () => {
  test('round trips', () => {
    expect(decodeToken(encodeToken(BUCKET, 'hunter2'))).toEqual({ bucketId: BUCKET, password: 'hunter2', flags: 0 });
    expect(decodeToken(encodeToken(BUCKET, 'hunter2', 3))).toEqual({ bucketId: BUCKET, password: 'hunter2', flags: 3 });
  });

  test('round trips a non-ASCII password', () => {
    const password = 'pä🙂ss/word+=';
    expect(decodeToken(encodeToken(BUCKET, password)).password).toBe(password);
  });

  test('round trips a password longer than one byte of length', () => {
    const password = 'x'.repeat(500);
    expect(decodeToken(encodeToken(BUCKET, password)).password).toBe(password);
  });

  test('is base64url: no +, / or padding', () => {
    expect(encodeToken(BUCKET, 'a'.repeat(64))).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  test('tolerates surrounding whitespace', () => {
    expect(decodeToken(` ${encodeToken(BUCKET, 'hunter2')}\n`).bucketId).toBe(BUCKET);
  });

  test('rejects a version byte other than 1', () => {
    const token = reencode((raw) => {
      raw[0] = 2;
      return raw;
    });
    expect(() => decodeToken(token)).toThrow('token: unsupported format');
  });

  test('rejects a trailing byte', () => {
    const token = reencode((raw) => {
      const out = new Uint8Array(raw.length + 1);
      out.set(raw);
      return out;
    });
    expect(() => decodeToken(token)).toThrow('token: malformed');
  });

  test('rejects a truncated payload', () => {
    const token = reencode((raw) => raw.subarray(0, raw.length - 1));
    expect(() => decodeToken(token)).toThrow('token: malformed');
  });

  test('rejects a header shorter than the five-byte prefix', () => {
    expect(() => decodeToken(toBase64Url(new Uint8Array([1, 0, 0])))).toThrow('token: unsupported format');
    expect(() => decodeToken('')).toThrow('token: unsupported format');
  });

  test('rejects non-base64url input', () => {
    expect(() => decodeToken('!!!!')).toThrow('token is not base64url');
    expect(() => decodeToken('****')).toThrow('token is not base64url');
  });
});

describe('publicHostname', () => {
  test('matches the coordinator derivation', async () => {
    expect(await publicHostname(BUCKET)).toBe('bd41727c9136.blob.upstash.io');
  });
});
