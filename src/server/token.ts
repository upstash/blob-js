export const AGENT_URL = 'https://blob.upstash.io';

export interface DecodedToken {
  bucketId: string;
  password: string;
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

export function encodeToken(bucketId: string, password: string, flags = 0): string {
  const enc = new TextEncoder();
  const id = enc.encode(bucketId);
  const pw = enc.encode(password);
  const out = new Uint8Array(5 + id.length + pw.length);
  out[0] = 1;
  out[1] = flags;
  out[2] = id.length;
  out[3] = pw.length >> 8;
  out[4] = pw.length & 0xff;
  out.set(id, 5);
  out.set(pw, 5 + id.length);
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
  if (raw.length < 5 || raw[0] !== 1) throw new TypeError('token: unsupported format');
  const idLen = raw[2]!;
  const pwLen = (raw[3]! << 8) | raw[4]!;
  if (raw.length !== 5 + idLen + pwLen) throw new TypeError('token: malformed');
  const dec = new TextDecoder();
  return {
    flags: raw[1]!,
    bucketId: dec.decode(raw.subarray(5, 5 + idLen)),
    password: dec.decode(raw.subarray(5 + idLen)),
  };
}

// Same derivation as the coordinator (BlobDnsHash). Verified 2026-08-24: bucket
// ac63f03a-4c24-4ed2-a0e3-ab78d70b62d7 serves at https://bd41727c9136.blob.upstash.io.
export async function publicHostname(bucketId: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(bucketId)));
  let h = '';
  for (const b of digest) h += b.toString(16).padStart(2, '0');
  return `b${h.slice(0, 11)}.blob.upstash.io`;
}
