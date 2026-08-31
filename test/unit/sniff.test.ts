import { describe, expect, test } from 'bun:test';
import { BlobError } from '../../src/shared/errors.ts';
import { SNIFF_BYTES, checkContentType, expandContentTypes, sniff } from '../../src/server/sniff.ts';

/** Byte literals and ASCII runs, in file order. */
function bytes(...parts: (number | string)[]): Uint8Array {
  const out: number[] = [];
  for (const part of parts) {
    if (typeof part === 'number') out.push(part);
    else for (let i = 0; i < part.length; i++) out.push(part.charCodeAt(i));
  }
  return new Uint8Array(out);
}

function zeros(n: number): number[] {
  return new Array<number>(n).fill(0);
}

function thrown(fn: () => unknown): BlobError {
  try {
    fn();
  } catch (e) {
    if (BlobError.is(e)) return e;
    throw e;
  }
  throw new Error('expected a BlobError, nothing was thrown');
}

const PNG = bytes(0x89, 'PNG', 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 'IHDR');
const JPEG = bytes(0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 'JFIF');
const GIF = bytes('GIF89a', 0x01, 0x00, 0x01, 0x00);
const WEBP = bytes('RIFF', 0x24, 0, 0, 0, 'WEBPVP8 ');
const WAV = bytes('RIFF', 0x24, 0, 0, 0, 'WAVEfmt ');
const AVI = bytes('RIFF', 0x24, 0, 0, 0, 'AVI LIST');
const BMP = bytes('BM', 0x36, 0x10, 0, 0, ...zeros(8), 0x28, 0, 0, 0);
const ZIP = bytes('PK', 0x03, 0x04, 0x14, 0x00);
const PDF = bytes('%PDF-1.7', 0x0a);
const HTML = bytes('<!doctype html><html><body>hi</body></html>');
/** A fragmented mp4: a real ffmpeg brand that no signature table below is asked to know. */
const MP4_DASH = bytes(0, 0, 0, 0x18, 'ftyp', 'dash', 0, 0, 0x02, 0);
const MP3_FFE3 = bytes(0xff, 0xe3, 0x90, 0x00);

describe('sniff: the closed set it will name', () => {
  const cases: [string, Uint8Array, string][] = [
    ['png', PNG, 'image/png'],
    ['jpeg', JPEG, 'image/jpeg'],
    ['gif87a', bytes('GIF87a', 0x01, 0x00), 'image/gif'],
    ['gif89a', GIF, 'image/gif'],
    ['webp', WEBP, 'image/webp'],
    ['bmp', BMP, 'image/bmp'],
    ['wav', WAV, 'audio/wav'],
    ['avi', AVI, 'video/x-msvideo'],
    ['pdf', PDF, 'application/pdf'],
    ['zip', ZIP, 'application/zip'],
    ['empty zip', bytes('PK', 0x05, 0x06, 0x00, 0x00), 'application/zip'],
    ['gzip', bytes(0x1f, 0x8b, 0x08, 0x00), 'application/gzip'],
    ['7z', bytes(0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c, 0x00), 'application/x-7z-compressed'],
    ['rar', bytes('Rar!', 0x1a, 0x07, 0x00), 'application/x-rar-compressed'],
    ['bzip2', bytes('BZh9', 0x31, 0x41, 0x59, 0x26, 0x53, 0x59), 'application/x-bzip2'],
  ];

  for (const [name, input, expected] of cases) {
    test(name, () => expect(sniff(input)).toBe(expected));
  }

  test('RIFF is ambiguous until offset 8', () => {
    expect(sniff(bytes('RIFF', 0x24, 0, 0, 0, 'NOPE'))).toBeUndefined();
    expect(sniff(bytes('RIFF'))).toBeUndefined();
  });

  test('png needs IHDR, not just the 8-byte signature', () => {
    expect(sniff(bytes(0x89, 'PNG', 0x0d, 0x0a, 0x1a, 0x0a))).toBeUndefined();
    expect(sniff(bytes(0x89, 'PNG', 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 'IEND'))).toBeUndefined();
  });

  test('BM alone is not a bmp: the DIB header size is what makes it a signature', () => {
    expect(sniff(bytes('BMW,model,year', 0x0a, '1,x,2020'))).toBeUndefined();
    expect(sniff(bytes('BM', ...zeros(12), 0x99, 0, 0, 0))).toBeUndefined();
    expect(sniff(BMP)).toBe('image/bmp');
  });

  test('BZh needs its level digit and block magic', () => {
    expect(sniff(bytes('BZh is how the log line starts'))).toBeUndefined();
    expect(sniff(bytes('BZh9'))).toBeUndefined();
  });

  test('truncated and unknown inputs return undefined without throwing', () => {
    expect(sniff(new Uint8Array(0))).toBeUndefined();
    expect(sniff(bytes(0x89))).toBeUndefined();
    expect(sniff(bytes(0xff))).toBeUndefined();
    expect(sniff(HTML)).toBeUndefined();
    expect(sniff(bytes('{"a":1}'))).toBeUndefined();
  });

  test('containers and partial-coverage formats are deliberately unnamed', () => {
    // Each of these used to be named, and each named it wrongly for some real file.
    expect(sniff(MP4_DASH)).toBeUndefined();
    expect(sniff(bytes(0, 0, 0, 0x18, 'ftyp', 'isom'))).toBeUndefined();
    expect(sniff(bytes(0, 0, 0, 0x18, 'ftyp', 'heic'))).toBeUndefined();
    expect(sniff(MP3_FFE3)).toBeUndefined();
    expect(sniff(bytes(0xff, 0xfb, 0x90, 0x00))).toBeUndefined();
    expect(sniff(bytes('OggS', 0x00, 0x02))).toBeUndefined();
    expect(sniff(bytes(0x49, 0x49, 0x2a, 0x00, 0x08))).toBeUndefined();
    expect(sniff(bytes(0x1a, 0x45, 0xdf, 0xa3))).toBeUndefined();
    expect(sniff(bytes(0x00, 0x01, 0x00, 0x00, 0x00, 0x0c))).toBeUndefined();
  });

  test('a tar is never refused for what its first member is called', () => {
    // A tar's first 512 bytes are a filename the uploader picks, and every signature here is read at
    // offset 0, so sniff() can be steered into naming one. It costs nothing: application/x-tar is
    // outside the closed set, so whatever is named, the declaration stands.
    const tar = (first: string) => bytes(first, ...zeros(257 - first.length), 'ustar', 0x00, '00');
    const allowed = expandContentTypes(['application/x-tar']);
    for (const name of ['BMW-sales.csv', 'GIF89a-list.txt', '%PDF-notes.txt', 'PK-archive.txt']) {
      expect(() => checkContentType('application/x-tar', tar(name), allowed)).not.toThrow();
    }
  });

  test('SNIFF_BYTES is the documented peek', () => {
    expect(SNIFF_BYTES).toBe(4100);
  });
});

describe('expandContentTypes', () => {
  test('image/* is the media family, not the sniffable subset, and never svg', () => {
    const out = expandContentTypes(['image/*']);
    expect(out).toContain('image/png');
    expect(out).toContain('image/heic');
    expect(out).toContain('image/avif');
    expect(out).toContain('image/tiff');
    expect(out).not.toContain('image/svg+xml');
    expect(out.every((t) => t.startsWith('image/'))).toBe(true);
  });

  test('audio/* includes audio/mp4, so an m4a voice memo is accepted', () => {
    expect(expandContentTypes(['audio/*'])).toContain('audio/mp4');
    expect(expandContentTypes(['audio/*'])).toContain('audio/opus');
    expect(expandContentTypes(['audio/*']).every((t) => t.startsWith('audio/'))).toBe(true);
  });

  test('video/* likewise', () => {
    expect(expandContentTypes(['video/*'])).toContain('video/webm');
    expect(expandContentTypes(['video/*'])).toContain('video/3gpp');
    expect(expandContentTypes(['video/*']).every((t) => t.startsWith('video/'))).toBe(true);
  });

  test('svg passes through when listed explicitly', () => {
    expect(expandContentTypes(['image/svg+xml'])).toEqual(['image/svg+xml']);
  });

  test('exact types keep input order and are lowercased', () => {
    expect(expandContentTypes(['image/PNG', 'Text/Plain'])).toEqual(['image/png', 'text/plain']);
  });

  test('aliases collapse to the canonical name', () => {
    expect(expandContentTypes(['image/jpg', 'audio/mp3', 'audio/x-wav'])).toEqual(['image/jpeg', 'audio/mpeg', 'audio/wav']);
    expect(expandContentTypes(['application/x-zip-compressed'])).toEqual(['application/zip']);
    expect(expandContentTypes(['image/vnd.microsoft.icon'])).toEqual(['image/x-icon']);
  });

  test('deduplicates across wildcards and exact types', () => {
    const out = expandContentTypes(['image/png', 'image/*', 'image/png']);
    expect(out[0]).toBe('image/png');
    expect(out.filter((t) => t === 'image/png')).toHaveLength(1);
    expect(new Set(out).size).toBe(out.length);
  });

  test("'*/*' throws and names the pattern", () => {
    const e = thrown(() => expandContentTypes(['*/*']));
    expect(e.code).toBe('invalid_content_type_pattern');
    expect(e.message).toContain('*/*');
  });

  test("'text/*' throws", () => {
    const e = thrown(() => expandContentTypes(['image/png', 'text/*']));
    expect(e.code).toBe('invalid_content_type_pattern');
    expect(e.message).toContain('text/*');
  });

  test('an empty list throws', () => {
    expect(thrown(() => expandContentTypes([])).code).toBe('invalid_content_type_pattern');
  });

  test('a non "a/b" string throws and names it', () => {
    for (const bad of ['png', 'image', 'image/', '/png', 'image/png/extra']) {
      const e = thrown(() => expandContentTypes([bad]));
      expect(e.code).toBe('invalid_content_type_pattern');
      expect(e.message).toContain(bad);
    }
  });
});

describe('checkContentType: the allow list', () => {
  const images = expandContentTypes(['image/png', 'image/jpeg']);

  test('a declared type outside the list is rejected with the list as the hint', () => {
    const e = thrown(() => checkContentType('image/gif', GIF, images));
    expect(e.code).toBe('content_type_not_allowed');
    expect(e.message).toContain('image/gif is not allowed');
    expect(e.hint).toBe('allowed: image/png, image/jpeg');
  });

  test('the list is checked before the bytes, with or without them', () => {
    expect(thrown(() => checkContentType('image/gif', undefined, images)).code).toBe('content_type_not_allowed');
    expect(thrown(() => checkContentType('text/html', HTML, expandContentTypes(['text/plain']))).code).toBe('content_type_not_allowed');
  });

  test('charset and other parameters are stripped', () => {
    expect(() => checkContentType('IMAGE/PNG; charset=binary', PNG, images)).not.toThrow();
    expect(thrown(() => checkContentType('image/gif; charset=binary', GIF, images)).message).toContain('image/gif is not allowed');
  });

  test('aliases are the same type on both sides', () => {
    expect(() => checkContentType('image/jpg', JPEG, images)).not.toThrow();
    expect(() => checkContentType('image/jpeg', JPEG, expandContentTypes(['image/jpg']))).not.toThrow();
    expect(() => checkContentType('audio/x-wav', WAV, expandContentTypes(['audio/wav']))).not.toThrow();
  });
});

describe('checkContentType: refuses a proven conflict, and only that', () => {
  const images = expandContentTypes(['image/png', 'image/jpeg']);

  test('matching bytes pass', () => {
    expect(() => checkContentType('image/png', PNG, images)).not.toThrow();
    expect(() => checkContentType('image/jpeg', JPEG, images)).not.toThrow();
  });

  test('bytes proven to be another closed type are refused, naming both', () => {
    const e = thrown(() => checkContentType('image/png', GIF, expandContentTypes(['image/png', 'image/gif'])));
    expect(e.code).toBe('content_type_not_allowed');
    expect(e.status).toBe(400);
    expect(e.message).toContain('image/gif');
    expect(e.message).toContain('image/png');
    expect(e.hint).toContain('contentTypes');
  });

  test('the renamed archive, which is the case this exists for', () => {
    expect(thrown(() => checkContentType('image/png', ZIP, images)).message).toContain('application/zip');
    expect(thrown(() => checkContentType('image/jpeg', PDF, images)).message).toContain('application/pdf');
  });

  test('bytes that prove nothing pass: the check never guesses', () => {
    expect(() => checkContentType('image/png', HTML, images)).not.toThrow();
    expect(() => checkContentType('image/png', new Uint8Array(0), images)).not.toThrow();
    expect(() => checkContentType('image/png', undefined, images)).not.toThrow();
  });

  test('a declaration outside the closed set is never contradicted', () => {
    // A .docx really is a zip. So is an .epub, a .jar and an .apk.
    for (const t of [
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/epub+zip',
      'application/java-archive',
      'application/vnd.android.package-archive',
    ]) {
      expect(() => checkContentType(t, ZIP, expandContentTypes([t]))).not.toThrow();
    }
    // A .svgz really is a gzip.
    expect(() => checkContentType('image/svg+xml', bytes(0x1f, 0x8b, 0x08, 0x00), expandContentTypes(['image/svg+xml']))).not.toThrow();
  });

  test('application/octet-stream is a shrug, not a claim, so bytes never contradict it', () => {
    const allowed = expandContentTypes(['application/octet-stream']);
    expect(() => checkContentType('application/octet-stream', PNG, allowed)).not.toThrow();
    expect(() => checkContentType('application/octet-stream', ZIP, allowed)).not.toThrow();
  });

  test('text declarations pass on the declaration, whatever the bytes look like', () => {
    const allowed = expandContentTypes(['text/plain', 'text/csv', 'application/json']);
    expect(() => checkContentType('text/plain', HTML, allowed)).not.toThrow();
    expect(() => checkContentType('text/csv', bytes('BMW,model,year', 0x0a), allowed)).not.toThrow();
    expect(() => checkContentType('text/plain', bytes('ID3 tag notes', 0x0a), allowed)).not.toThrow();
    expect(() => checkContentType('text/plain', bytes('%PDF is the pdf magic', 0x0a), allowed)).not.toThrow();
    expect(() => checkContentType('application/json', bytes('{"a":1}'), allowed)).not.toThrow();
  });

  test('real media the old table refused now passes', () => {
    const av = expandContentTypes(['video/*', 'audio/*']);
    expect(() => checkContentType('video/mp4', MP4_DASH, av)).not.toThrow();
    for (const brand of ['iso5', 'iso6', 'msf1', 'mmp4', 'M4A ']) {
      expect(() => checkContentType('video/mp4', bytes(0, 0, 0, 0x18, 'ftyp', brand), av)).not.toThrow();
    }
    expect(() => checkContentType('audio/mpeg', MP3_FFE3, av)).not.toThrow();
    expect(() => checkContentType('audio/mpeg', bytes(0xff, 0xfa, 0x90, 0x00), av)).not.toThrow();
    expect(() => checkContentType('audio/mp4', bytes(0, 0, 0, 0x18, 'ftyp', 'M4A '), av)).not.toThrow();
    expect(() => checkContentType('audio/opus', bytes('OggS', 0x00, 0x02), av)).not.toThrow();
    expect(() => checkContentType('video/webm', bytes(0x1a, 0x45, 0xdf, 0xa3), av)).not.toThrow();
  });
});
