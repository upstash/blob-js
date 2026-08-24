export const AGENT_URL = 'https://blob.upstash.io';
export const DOMAIN_SUFFIX = 'blob.upstash.io';

const TOKEN_VERSION = 0x02;

export interface DecodedToken {
  bucketId: string;
  password: string;
  /** The bucket's public DNS label, already prefixed: `<hashForDomain>.blob.upstash.io` serves its objects. */
  hashForDomain: string;
  flags: number;
}

function fromBase64Url(s: string): Uint8Array {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function toBase64Url(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function encodeToken(bucketId: string, password: string, hashForDomain: string, flags = 0): string {
  const enc = new TextEncoder();
  const id = enc.encode(bucketId);
  const pw = enc.encode(password);
  const h = enc.encode(hashForDomain);
  const out = new Uint8Array(6 + id.length + pw.length + h.length);
  out[0] = TOKEN_VERSION;
  out[1] = flags;
  out[2] = id.length;
  out[3] = pw.length >> 8;
  out[4] = pw.length & 0xff;
  out[5] = h.length;
  out.set(id, 6);
  out.set(pw, 6 + id.length);
  out.set(h, 6 + id.length + pw.length);
  return toBase64Url(out);
}

// Trailing bytes mean tamper, so the length check is exact.
export function decodeToken(token: string): DecodedToken {
  let raw: Uint8Array;
  try {
    raw = fromBase64Url(token.trim());
  } catch {
    throw new TypeError('token is not base64url');
  }
  if (raw.length < 6 || raw[0] !== TOKEN_VERSION) throw new TypeError('token: unsupported format');
  const idLen = raw[2]!;
  const pwLen = (raw[3]! << 8) | raw[4]!;
  const hLen = raw[5]!;
  if (idLen === 0 || pwLen === 0 || hLen === 0) throw new TypeError('token: malformed');
  if (raw.length !== 6 + idLen + pwLen + hLen) throw new TypeError('token: malformed');
  const dec = new TextDecoder();
  return {
    flags: raw[1]!,
    bucketId: dec.decode(raw.subarray(6, 6 + idLen)),
    password: dec.decode(raw.subarray(6 + idLen, 6 + idLen + pwLen)),
    hashForDomain: dec.decode(raw.subarray(6 + idLen + pwLen)),
  };
}
