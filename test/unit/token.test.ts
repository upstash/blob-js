import { describe, expect, test } from 'bun:test';
import { decodeToken, encodeToken, toBase64Url } from '../../src/server/token.ts';

const BUCKET = 'ac63f03a-4c24-4ed2-a0e3-ab78d70b62d7';
const HASH = 'bd41727c9136';

function reencode(mutate: (bytes: Uint8Array) => Uint8Array): string {
  const token = encodeToken(BUCKET, 'hunter2', HASH, 0);
  const b64 = token.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (token.length % 4)) % 4);
  const bin = atob(b64);
  const raw = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) raw[i] = bin.charCodeAt(i);
  return toBase64Url(mutate(raw));
}

describe('encodeToken / decodeToken', () => {
  test('round trips', () => {
    expect(decodeToken(encodeToken(BUCKET, 'hunter2', HASH))).toEqual({ bucketId: BUCKET, password: 'hunter2', hashForDomain: HASH, flags: 0 });
    expect(decodeToken(encodeToken(BUCKET, 'hunter2', HASH, 3))).toEqual({ bucketId: BUCKET, password: 'hunter2', hashForDomain: HASH, flags: 3 });
  });

  test('round trips a non-ASCII password', () => {
    const password = 'pä🙂ss/word+=';
    expect(decodeToken(encodeToken(BUCKET, password, HASH)).password).toBe(password);
  });

  test('round trips a password longer than one byte of length', () => {
    const password = 'x'.repeat(500);
    expect(decodeToken(encodeToken(BUCKET, password, HASH)).password).toBe(password);
  });

  test('is base64url: no +, / or padding', () => {
    expect(encodeToken(BUCKET, 'a'.repeat(64), HASH)).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  test('tolerates surrounding whitespace', () => {
    expect(decodeToken(` ${encodeToken(BUCKET, 'hunter2', HASH)}\n`).bucketId).toBe(BUCKET);
  });

  // The coordinator and this SDK are independent implementations of one wire format, and
  // nothing carries a real token across the boundary in a test. These vectors are asserted
  // on both sides (blob-store test/unit/crypto.test.ts), so a layout change fails here.
  test.each([
    ['bucket-id', 's3cr3t', 'b0123456789a', 'AgAJAAYMYnVja2V0LWlkczNjcjN0YjAxMjM0NTY3ODlh'],
    ['9b1f7c2a-0000-4000-8000-000000000001', 'pw', 'bba32f9308d2', 'AgAkAAIMOWIxZjdjMmEtMDAwMC00MDAwLTgwMDAtMDAwMDAwMDAwMDAxcHdiYmEzMmY5MzA4ZDI'],
    ['b', 'p', 'h', 'AgABAAEBYnBo'],
    ['ünïcøde-bucket', 'pässwörd-✓', 'b0123456789a', 'AgARAA4Mw7xuw69jw7hkZS1idWNrZXRww6Rzc3fDtnJkLeKck2IwMTIzNDU2Nzg5YQ'],
    ['emoji-🪣', '🔑🔑', 'bdeadbeef012', 'AgAKAAgMZW1vamkt8J-qo_CflJHwn5SRYmRlYWRiZWVmMDEy'],
  ])('matches the coordinator byte-for-byte: %s', (bucketId, password, hash, expected) => {
    expect(encodeToken(bucketId, password, hash)).toBe(expected);
    expect(decodeToken(expected)).toEqual({ bucketId, password, hashForDomain: hash, flags: 0 });
  });

  test('rejects a version byte other than 2', () => {
    const token = reencode((raw) => {
      raw[0] = 3;
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

  test('rejects a zero-length field', () => {
    expect(() => decodeToken(toBase64Url(new Uint8Array([2, 0, 0, 0, 0, 0])))).toThrow('token: malformed');
    expect(() => decodeToken(toBase64Url(new Uint8Array([2, 0, 1, 0, 1, 0, 98, 112])))).toThrow('token: malformed');
  });

  test('rejects a header shorter than the six-byte prefix', () => {
    expect(() => decodeToken(toBase64Url(new Uint8Array([2, 0, 1, 0, 1])))).toThrow('token: unsupported format');
    expect(() => decodeToken('')).toThrow('token: unsupported format');
  });

  test('rejects non-base64url input', () => {
    expect(() => decodeToken('!!!!')).toThrow('token is not base64url');
    expect(() => decodeToken('****')).toThrow('token is not base64url');
  });
});
