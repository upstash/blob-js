import { BlobError } from '../shared/errors.ts';

/**
 * Bytes peeked from a stream before sniffing. Every signature below lives in the first 32 bytes; the
 * rest of the buffer is slack so a caller can hand the same head to something stricter later.
 * HEAD_BYTES in src/browser/task.ts is this same number, duplicated because that file ships to
 * browsers. They may drift without breaking anything -- the server clamps what it decodes, and no
 * signature reaches past 32 -- but keep them equal.
 */
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

/** Little-endian uint32, or -1 when the slice runs past the end. */
function u32le(b: Uint8Array, offset: number): number {
  if (b.length < offset + 4) return -1;
  return ((b[offset]! | (b[offset + 1]! << 8) | (b[offset + 2]! << 16)) >>> 0) + b[offset + 3]! * 0x1000000;
}

/** The DIB header sizes BMP actually uses. Without this, 'BM' matches any text beginning "BM". */
const DIB_SIZES = new Set([12, 40, 52, 56, 64, 108, 124]);

/**
 * The types a signature proves outright, with no sibling format sharing it and no inner label left
 * to guess. This set is deliberately small: it is the domain over which a mismatch is a lie rather
 * than a gap in the table. Formats left out on purpose, because their signature proves a container
 * and not the type above it: ISO-BMFF (`ftyp` is mp4, m4a, heic, avif and quicktime alike), EBML
 * (webm vs mkv), Ogg (vorbis vs opus vs theora), TIFF (also every raw camera format), sfnt fonts
 * (ttf, otf, ttc), MPEG audio (frame sync varies by version and layer) and tar (its marker sits at
 * 257, behind an attacker-controlled filename).
 */
const CLOSED = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/bmp',
  'audio/wav',
  'video/x-msvideo',
  'application/pdf',
  'application/zip',
  'application/gzip',
  'application/x-7z-compressed',
  'application/x-rar-compressed',
  'application/x-bzip2',
]);

/**
 * The type the leading bytes prove, or undefined when they prove nothing this function is willing to
 * name. Undefined is the common answer and never an error: see checkContentType for what is done
 * with it.
 */
export function sniff(b: Uint8Array): string | undefined {
  // PNG's 8-byte signature is shared with nothing, but a truncated PNG header is a common polyglot
  // prefix, so require the IHDR chunk type at 12.
  if (magic(b, 0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return ascii(b, 12, 'IHDR') ? 'image/png' : undefined;
  }
  if (magic(b, 0, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (ascii(b, 0, 'GIF87a') || ascii(b, 0, 'GIF89a')) return 'image/gif';

  // RIFF at 0 is webp, wav and avi alike; the form type at 8 separates them exactly.
  if (ascii(b, 0, 'RIFF')) {
    if (ascii(b, 8, 'WEBP')) return 'image/webp';
    if (ascii(b, 8, 'WAVE')) return 'audio/wav';
    if (ascii(b, 8, 'AVI ')) return 'video/x-msvideo';
    return undefined;
  }

  if (ascii(b, 0, 'BM') && DIB_SIZES.has(u32le(b, 14))) return 'image/bmp';
  if (ascii(b, 0, '%PDF')) return 'application/pdf';

  if (magic(b, 0, [0x50, 0x4b, 0x03, 0x04]) || magic(b, 0, [0x50, 0x4b, 0x05, 0x06]) || magic(b, 0, [0x50, 0x4b, 0x07, 0x08])) {
    return 'application/zip';
  }
  if (magic(b, 0, [0x1f, 0x8b])) return 'application/gzip';
  if (magic(b, 0, [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c])) return 'application/x-7z-compressed';
  if (magic(b, 0, [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07])) return 'application/x-rar-compressed';
  // 'BZh' is three ASCII letters; the level digit and the block magic are what make it a signature.
  if (ascii(b, 0, 'BZh') && b[3]! >= 0x31 && b[3]! <= 0x39 && magic(b, 4, [0x31, 0x41, 0x59, 0x26, 0x53, 0x59])) {
    return 'application/x-bzip2';
  }

  return undefined;
}

/**
 * What a wildcard means. A media family, not the subset whose bytes sniff() happens to recognise:
 * `audio/*` has to include audio/mp4 or it refuses every voice memo. image/* never yields
 * image/svg+xml -- an SVG is script, so consenting to it has to be explicit.
 */
const WILDCARD: Record<string, readonly string[]> = {
  image: ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/bmp', 'image/tiff', 'image/avif', 'image/heic', 'image/heif', 'image/x-icon'],
  video: ['video/mp4', 'video/quicktime', 'video/webm', 'video/x-matroska', 'video/x-msvideo', 'video/mpeg', 'video/ogg', 'video/3gpp'],
  audio: ['audio/mpeg', 'audio/wav', 'audio/ogg', 'audio/opus', 'audio/flac', 'audio/aac', 'audio/mp4', 'audio/webm'],
};

/** Spellings browsers and operating systems really send for a type that has one canonical name. */
const ALIASES: Record<string, string> = {
  'image/jpg': 'image/jpeg',
  'image/pjpeg': 'image/jpeg',
  'image/vnd.microsoft.icon': 'image/x-icon',
  'audio/x-wav': 'audio/wav',
  'audio/wave': 'audio/wav',
  'audio/vnd.wave': 'audio/wav',
  'audio/mp3': 'audio/mpeg',
  'audio/x-flac': 'audio/flac',
  'audio/x-aac': 'audio/aac',
  'video/avi': 'video/x-msvideo',
  'video/msvideo': 'video/x-msvideo',
  'application/x-gzip': 'application/gzip',
  'application/x-zip-compressed': 'application/zip',
  'application/vnd.rar': 'application/x-rar-compressed',
};

function canonical(type: string): string {
  const bare = type.split(';', 1)[0]!.trim().toLowerCase();
  return ALIASES[bare] ?? bare;
}

const TYPE_RE = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/;

function bad(pattern: string, why: string): never {
  throw new BlobError('invalid_content_type_pattern', { message: `contentTypes: ${why} "${pattern}"` });
}

/**
 * Resolves the accept grammar to concrete types. Only image/*, video/* and audio/* exist; '*\/*',
 * any other wildcard and an empty list throw, because a list that matches everything is a limit
 * that reads enforced and is not.
 */
export function expandContentTypes(allowed: readonly string[]): string[] {
  if (allowed.length === 0) {
    throw new BlobError('invalid_content_type_pattern', {
      message: 'contentTypes: empty list; omit the option to accept anything',
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
      const family = WILDCARD[pattern.slice(0, -2)];
      if (!family) bad(raw, 'only image/*, video/* and audio/* are wildcards, got');
      for (const t of family) push(canonical(t));
      continue;
    }
    if (!TYPE_RE.test(pattern)) bad(raw, 'expected a "type/subtype", got');
    push(canonical(pattern));
  }
  return out;
}

/**
 * The declared type against the allow list, and then against the bytes when they are available.
 *
 * The byte half refuses on a proven conflict only. Bytes that prove nothing pass, and bytes that
 * prove something the declaration cannot be checked against pass too: a .docx really is a zip, so
 * `application/zip` under an OOXML declaration is agreement, not a lie. Only a declaration in CLOSED
 * can be contradicted, which is why that set is small. The cost is that this will not catch every
 * mislabelled file; the alternative was refusing real ones, which it used to do.
 */
export function checkContentType(declared: string, bytes: Uint8Array | undefined, allowed: readonly string[]): void {
  const declaredBare = declared.split(';', 1)[0]!.trim().toLowerCase();
  const want = ALIASES[declaredBare] ?? declaredBare;

  if (!allowed.map(canonical).includes(want)) {
    throw new BlobError('content_type_not_allowed', {
      message: `${declaredBare} is not allowed`,
      hint: `allowed: ${allowed.join(', ')}`,
    });
  }
  if (bytes === undefined) return;

  const seen = sniff(bytes);
  if (seen === undefined || seen === want || !CLOSED.has(want)) return;
  throw new BlobError('content_type_not_allowed', {
    message: `the bytes are ${seen}, which cannot be served as ${declaredBare}`,
    hint: 'declare the type the bytes actually are, or add it to contentTypes',
  });
}
