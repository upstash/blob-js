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
