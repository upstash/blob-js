import { hmac } from './sigv4.ts';
import { toBase64Url } from './token.ts';

interface TokenBase {
  v: 1;
  /** Bucket id the grant is bound to. */
  b: string;
  /** Route id the grant is bound to: one bucket's routes all sign with the same key. */
  r: string;
  /** Upload id: what makes an at-least-once phase 'end' idempotent for the app. */
  id: string;
  path: string;
  /** The file's name as the browser gave it, so `file` reaches onUploadComplete unchanged. */
  n: string;
  type: string;
  size: number;
  /** Headers pinned into the signature: content-type, cache-control, x-amz-meta-*. */
  headers: Record<string, string>;
  /** Expanded allowed types, sniffed at phase 'end'. */
  allowed: string[] | undefined;
  /** What onBeforeUpload returned as `state`. */
  ctx: unknown;
  /** Unix ms. */
  exp: number;
}

export interface TokenPayload extends TokenBase {
  /** R2's own multipart id, so phase 'end' can complete it and a cancel can abort it. */
  uploadId: string;
  partSize: number;
}

const enc = new TextEncoder();

function encodePayload(payload: TokenPayload): string {
  return toBase64Url(enc.encode(JSON.stringify(payload)));
}

async function mac(data: string, key: string): Promise<string> {
  return toBase64Url(await hmac(enc.encode(`upstash-blob-completion:${key}`), data));
}

// Signed, not encrypted: the payload is readable in devtools, so context carries a rowId, never a secret.
export async function signToken(payload: TokenPayload, key: string): Promise<string> {
  const body = encodePayload(payload);
  return `${body}.${await mac(body, key)}`;
}

export async function verifyToken(token: string, key: string): Promise<TokenPayload | undefined> {
  const dot = token.indexOf('.');
  if (dot < 0) return undefined;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = await mac(body, key);
  if (!timingSafeEqual(sig, expected)) return undefined;
  try {
    const b64 = body.replace(/-/g, '+').replace(/_/g, '/');
    const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    const payload = JSON.parse(new TextDecoder().decode(bytes)) as TokenPayload;
    return payload.v === 1 ? payload : undefined;
  } catch {
    return undefined;
  }
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
