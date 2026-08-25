import { BlobError } from '../shared/errors.ts';
import { uriEncode } from './sigv4.ts';

// A temp credential authorises the whole bucket and the URL parser resolves `..`, so a traversing
// key would touch a different object than named. Reject rather than normalise.
export function encodeKey(path: string): string {
  if (typeof path !== 'string' || path.length === 0) throw new TypeError('path must be a non-empty string');
  const segments = path.split('/');
  for (const s of segments) {
    if (s === '.' || s === '..') throw new TypeError(`path may not contain "." or ".." segments: ${path}`);
  }
  return segments.map((s) => uriEncode(s)).join('/');
}

export function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

export function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function tag(xml: string, name: string): string | undefined {
  const m = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(xml);
  return m?.[1];
}

export function blocks(xml: string, name: string): string[] {
  return xml.match(new RegExp(`<${name}>[\\s\\S]*?</${name}>`, 'g')) ?? [];
}

const HEADER_NAME_RE = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;
// ASCII, not Latin-1. A header value is a ByteString, so fetch throws a bare TypeError above U+00FF
// and it surfaces as "request failed" rather than as the caller's mistake; and R2 does not store a
// Latin-1 value verbatim either. Measured 2026-08-25: metadata { note: 'café' } comes back as
// '=?utf-8?Q?caf=C3=A9?=', so accepting it would hand back a different string than was written.
const ASCII_RE = /^[\x20-\x7e]*$/;

export function metaHeaders(metadata: Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(metadata ?? {})) {
    if (!HEADER_NAME_RE.test(k)) throw new BlobError('invalid_input', { message: `metadata key "${k}" is not a valid header name` });
    if (typeof v !== 'string') throw new BlobError('invalid_input', { message: `metadata.${k} must be a string` });
    if (!ASCII_RE.test(v)) {
      throw new BlobError('invalid_input', {
        message: `metadata.${k} has characters storage does not carry back unchanged`,
        hint: 'metadata is printable ASCII; percent-encode anything else with encodeURIComponent',
      });
    }
    out[`x-amz-meta-${k.toLowerCase()}`] = v;
  }
  return out;
}
