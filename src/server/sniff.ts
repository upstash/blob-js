import { BlobError } from '../shared/errors.ts';

/** Bytes peeked from a stream before sniffing. A tar's `ustar` marker sits at 257, the deepest probe. */
export const SNIFF_BYTES = 4100;

function magic(b: Uint8Array, offset: number, sig: readonly number[]): boolean {
  if (b.length < offset + sig.length) return false;
  for (let i = 0; i < sig.length; i++) if (b[offset + i] !== sig[i]) return false;
  return true;
}

function ascii(b: Uint8Array, offset: number, s: string): boolean {
  if (b.length < offset + s.length) return false;
  for (let i = 0; i < s.length; i++) if (b[offset + i] !== s.charCodeAt(i)) return false;
  return true;
}

/** ASCII of a fixed-width field; '' when the slice runs past the end. */
function tag(b: Uint8Array, offset: number, length: number): string {
  if (b.length < offset + length) return '';
  let s = '';
  for (let i = 0; i < length; i++) s += String.fromCharCode(b[offset + i] as number);
  return s;
}

function findAscii(b: Uint8Array, s: string, limit: number): boolean {
  const end = Math.min(b.length, limit) - s.length;
  for (let i = 0; i <= end; i++) if (ascii(b, i, s)) return true;
  return false;
}

const FTYP_AVIF = new Set(['avif', 'avis']);
const FTYP_HEIC = new Set(['heic', 'heix', 'hevc', 'mif1']);
const FTYP_MP4 = new Set(['isom', 'iso2', 'mp41', 'mp42', 'avc1', 'M4V ']);

/**
 * The most specific type the leading bytes prove, or undefined. text/plain, text/csv and
 * application/json have no signature and are undefined by construction, not by omission.
 */
export function sniff(bytes: Uint8Array): string | undefined {
  const b = bytes;

  // PNG's 8-byte signature is shared with nothing, but a truncated PNG header is a common
  // polyglot prefix, so require the IHDR chunk type at 12 (16 bytes total).
  if (magic(b, 0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return ascii(b, 12, 'IHDR') ? 'image/png' : undefined;
  }

  if (magic(b, 0, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (ascii(b, 0, 'GIF87a') || ascii(b, 0, 'GIF89a')) return 'image/gif';

  // RIFF at offset 0 is webp, wav and avi alike. The form type at offset 8 is what separates them.
  if (ascii(b, 0, 'RIFF')) {
    if (ascii(b, 8, 'WEBP')) return 'image/webp';
    if (ascii(b, 8, 'WAVE')) return 'audio/wav';
    if (ascii(b, 8, 'AVI ')) return 'video/x-msvideo';
    return undefined;
  }

  if (ascii(b, 0, 'BM')) return 'image/bmp';
  if (magic(b, 0, [0x49, 0x49, 0x2a, 0x00]) || magic(b, 0, [0x4d, 0x4d, 0x00, 0x2a])) return 'image/tiff';

  // ISO base media: the brand at offset 8 decides image, mp4 or quicktime.
  if (ascii(b, 4, 'ftyp')) {
    const brand = tag(b, 8, 4);
    if (FTYP_AVIF.has(brand)) return 'image/avif';
    if (FTYP_HEIC.has(brand)) return 'image/heic';
    if (FTYP_MP4.has(brand)) return 'video/mp4';
    if (brand === 'qt  ') return 'video/quicktime';
    return undefined;
  }
  if (ascii(b, 4, 'moov') || ascii(b, 4, 'mdat')) return 'video/quicktime';

  if (magic(b, 0, [0x00, 0x00, 0x01, 0x00])) return 'image/x-icon';
  if (ascii(b, 0, '%PDF')) return 'application/pdf';

  if (magic(b, 0, [0x50, 0x4b, 0x03, 0x04]) || magic(b, 0, [0x50, 0x4b, 0x05, 0x06]) || magic(b, 0, [0x50, 0x4b, 0x07, 0x08])) {
    return 'application/zip';
  }
  if (magic(b, 0, [0x1f, 0x8b])) return 'application/gzip';
  if (magic(b, 0, [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c])) return 'application/x-7z-compressed';
  if (magic(b, 0, [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07])) return 'application/x-rar-compressed';
  if (ascii(b, 0, 'BZh')) return 'application/x-bzip2';
  if (ascii(b, 257, 'ustar')) return 'application/x-tar';

  // EBML alone does not separate webm from mkv; the DocType string sits within the first segment
  // header, a few dozen bytes in.
  if (magic(b, 0, [0x1a, 0x45, 0xdf, 0xa3])) {
    return findAscii(b, 'webm', 64) ? 'video/webm' : 'video/x-matroska';
  }

  if (ascii(b, 0, 'ID3') || magic(b, 0, [0xff, 0xfb]) || magic(b, 0, [0xff, 0xf3]) || magic(b, 0, [0xff, 0xf2])) return 'audio/mpeg';
  if (magic(b, 0, [0xff, 0xf1]) || magic(b, 0, [0xff, 0xf9])) return 'audio/aac';
  if (ascii(b, 0, 'OggS')) return 'audio/ogg';
  if (ascii(b, 0, 'fLaC')) return 'audio/flac';

  if (ascii(b, 0, 'wOFF')) return 'font/woff';
  if (ascii(b, 0, 'wOF2')) return 'font/woff2';
  if (magic(b, 0, [0x00, 0x01, 0x00, 0x00])) return 'font/ttf';
  if (ascii(b, 0, 'OTTO')) return 'font/otf';

  return undefined;
}

const SNIFFABLE = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/bmp',
  'image/tiff',
  'image/avif',
  'image/heic',
  'image/x-icon',
  'application/pdf',
  'application/zip',
  'application/gzip',
  'application/x-7z-compressed',
  'application/x-rar-compressed',
  'application/x-tar',
  'application/x-bzip2',
  'video/mp4',
  'video/quicktime',
  'video/webm',
  'video/x-matroska',
  'video/x-msvideo',
  'audio/mpeg',
  'audio/wav',
  'audio/ogg',
  'audio/flac',
  'audio/aac',
  'font/woff',
  'font/woff2',
  'font/ttf',
  'font/otf',
]);

/** True when sniff() can return this type, so bytes declaring it must prove it. */
export function isSniffable(type: string): boolean {
  return SNIFFABLE.has(canonical(type));
}

const ALIASES: Record<string, string> = {
  'image/jpg': 'image/jpeg',
  'audio/x-wav': 'audio/wav',
  'audio/mp3': 'audio/mpeg',
};

function canonical(type: string): string {
  const bare = type.split(';', 1)[0]!.trim().toLowerCase();
  return ALIASES[bare] ?? bare;
}

const TYPE_RE = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/;

function bad(pattern: string, why: string): never {
  throw new BlobError('invalid_content_type_pattern', { message: `allowedContentTypes: ${why} "${pattern}"` });
}

function subtypesOf(prefix: string): string[] {
  // image/* never yields image/svg+xml: an SVG is script, and sniff() cannot prove one anyway, so
  // consenting to it has to be explicit.
  return [...SNIFFABLE].filter((t) => t.startsWith(`${prefix}/`));
}

/**
 * Resolves the accept grammar to concrete types. Only image/*, video/* and audio/* exist; '*\/*',
 * any other wildcard and an empty list throw, because a list that matches everything is a limit
 * that reads enforced and is not.
 */
export function expandContentTypes(allowed: readonly string[]): string[] {
  if (allowed.length === 0) {
    throw new BlobError('invalid_content_type_pattern', {
      message: 'allowedContentTypes: empty list; omit the option to accept anything',
    });
  }
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (t: string) => {
    if (seen.has(t)) return;
    seen.add(t);
    out.push(t);
  };
  for (const raw of allowed) {
    const pattern = raw.trim().toLowerCase();
    if (pattern.endsWith('/*')) {
      const prefix = pattern.slice(0, -2);
      if (prefix !== 'image' && prefix !== 'video' && prefix !== 'audio') {
        bad(raw, 'only image/*, video/* and audio/* are wildcards, got');
      }
      for (const t of subtypesOf(prefix)) push(t);
      continue;
    }
    if (!TYPE_RE.test(pattern)) bad(raw, 'expected a "type/subtype", got');
    push(canonical(pattern));
  }
  return out;
}

/**
 * Enforces an already-expanded list against the declared type and, when they are available, the
 * leading bytes. An unsniffable declaration (text/plain, text/csv, application/json) passes on the
 * declaration; a sniffable one has to be proven by the bytes.
 */
export function checkContentType(declared: string, bytes: Uint8Array | undefined, allowed: readonly string[]): void {
  const declaredBare = declared.split(';', 1)[0]!.trim().toLowerCase();
  const want = ALIASES[declaredBare] ?? declaredBare;
  const list = allowed.map(canonical);

  if (!list.includes(want)) {
    throw new BlobError('content_type_not_allowed', {
      message: `${declaredBare} is not allowed`,
      hint: `allowed: ${allowed.join(', ')}`,
    });
  }
  if (bytes === undefined) return;

  const seen = sniff(bytes);
  if (seen !== undefined) {
    if (seen !== want) {
      throw new BlobError('content_type_not_allowed', {
        message: `the bytes look like ${seen} but were declared ${declaredBare}`,
      });
    }
    return;
  }
  if (SNIFFABLE.has(want)) {
    throw new BlobError('content_type_not_allowed', {
      message: `the bytes do not match the declared type ${declaredBare}`,
    });
  }
}
