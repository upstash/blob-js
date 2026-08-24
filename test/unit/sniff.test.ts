import { describe, expect, test } from 'bun:test';
import { BlobError } from '../../src/shared/errors.ts';
import { SNIFF_BYTES, checkContentType, expandContentTypes, isSniffable, sniff } from '../../src/server/sniff.ts';

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
const MP4 = bytes(0, 0, 0, 0x18, 'ftyp', 'isom', 0, 0, 0x02, 0);
const HTML = bytes('<!doctype html><html><body>hi</body></html>');

describe('sniff', () => {
  const cases: [string, Uint8Array, string][] = [
    ['png', PNG, 'image/png'],
    ['jpeg', JPEG, 'image/jpeg'],
    ['gif87a', bytes('GIF87a', 0x01, 0x00), 'image/gif'],
    ['gif89a', GIF, 'image/gif'],
    ['webp', WEBP, 'image/webp'],
    ['bmp', bytes('BM', 0x36, 0, 0, 0), 'image/bmp'],
    ['tiff little endian', bytes(0x49, 0x49, 0x2a, 0x00, 0x08), 'image/tiff'],
    ['tiff big endian', bytes(0x4d, 0x4d, 0x00, 0x2a, 0x00), 'image/tiff'],
    ['avif', bytes(0, 0, 0, 0x1c, 'ftyp', 'avif'), 'image/avif'],
    ['avis', bytes(0, 0, 0, 0x1c, 'ftyp', 'avis'), 'image/avif'],
    ['heic', bytes(0, 0, 0, 0x18, 'ftyp', 'heic'), 'image/heic'],
    ['heix', bytes(0, 0, 0, 0x18, 'ftyp', 'heix'), 'image/heic'],
    ['hevc', bytes(0, 0, 0, 0x18, 'ftyp', 'hevc'), 'image/heic'],
    ['mif1', bytes(0, 0, 0, 0x18, 'ftyp', 'mif1'), 'image/heic'],
    ['ico', bytes(0x00, 0x00, 0x01, 0x00, 0x01, 0x00), 'image/x-icon'],
    ['pdf', bytes('%PDF-1.7', 0x0a), 'application/pdf'],
    ['zip', bytes('PK', 0x03, 0x04, 0x14, 0x00), 'application/zip'],
    ['empty zip', bytes('PK', 0x05, 0x06, 0x00, 0x00), 'application/zip'],
    ['gzip', bytes(0x1f, 0x8b, 0x08, 0x00), 'application/gzip'],
    ['7z', bytes(0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c, 0x00), 'application/x-7z-compressed'],
    ['rar', bytes('Rar!', 0x1a, 0x07, 0x00), 'application/x-rar-compressed'],
    ['rar5', bytes('Rar!', 0x1a, 0x07, 0x01, 0x00), 'application/x-rar-compressed'],
    ['tar', bytes('name.txt', ...zeros(249), 'ustar', 0x00, '00'), 'application/x-tar'],
    ['bzip2', bytes('BZh9', 0x31), 'application/x-bzip2'],
    ['mp4 isom', MP4, 'video/mp4'],
    ['mp4 mp42', bytes(0, 0, 0, 0x18, 'ftyp', 'mp42'), 'video/mp4'],
    ['mp4 avc1', bytes(0, 0, 0, 0x18, 'ftyp', 'avc1'), 'video/mp4'],
    ['m4v', bytes(0, 0, 0, 0x18, 'ftyp', 'M4V '), 'video/mp4'],
    ['quicktime ftyp', bytes(0, 0, 0, 0x14, 'ftyp', 'qt  '), 'video/quicktime'],
    ['quicktime moov', bytes(0, 0, 0, 0x14, 'moov'), 'video/quicktime'],
    ['quicktime mdat', bytes(0, 0, 0x10, 0x00, 'mdat'), 'video/quicktime'],
    ['webm', bytes(0x1a, 0x45, 0xdf, 0xa3, 0x01, ...zeros(6), 0x1f, 0x42, 0x86, 0x81, 0x01, 0x42, 0x82, 0x84, 'webm'), 'video/webm'],
    [
      'matroska',
      bytes(0x1a, 0x45, 0xdf, 0xa3, 0x01, ...zeros(6), 0x23, 0x42, 0x86, 0x81, 0x01, 0x42, 0x82, 0x88, 'matroska'),
      'video/x-matroska',
    ],
    ['avi', AVI, 'video/x-msvideo'],
    ['mp3 id3', bytes('ID3', 0x03, 0x00), 'audio/mpeg'],
    ['mp3 frame sync fffb', bytes(0xff, 0xfb, 0x90, 0x00), 'audio/mpeg'],
    ['mp3 frame sync fff3', bytes(0xff, 0xf3, 0x90, 0x00), 'audio/mpeg'],
    ['mp3 frame sync fff2', bytes(0xff, 0xf2, 0x90, 0x00), 'audio/mpeg'],
    ['wav', WAV, 'audio/wav'],
    ['ogg', bytes('OggS', 0x00, 0x02), 'audio/ogg'],
    ['flac', bytes('fLaC', 0x00, 0x00), 'audio/flac'],
    ['aac fff1', bytes(0xff, 0xf1, 0x50, 0x80), 'audio/aac'],
    ['aac fff9', bytes(0xff, 0xf9, 0x50, 0x80), 'audio/aac'],
    ['woff', bytes('wOFF', 0x00, 0x01), 'font/woff'],
    ['woff2', bytes('wOF2', 0x00, 0x01), 'font/woff2'],
    ['ttf', bytes(0x00, 0x01, 0x00, 0x00, 0x00, 0x0c), 'font/ttf'],
    ['otf', bytes('OTTO', 0x00, 0x0c), 'font/otf'],
  ];

  for (const [name, input, expected] of cases) {
    test(name, () => {
      expect(sniff(input)).toBe(expected);
      expect(isSniffable(expected)).toBe(true);
    });
  }

  test('RIFF is ambiguous until offset 8', () => {
    expect(sniff(WEBP)).toBe('image/webp');
    expect(sniff(WAV)).toBe('audio/wav');
    expect(sniff(AVI)).toBe('video/x-msvideo');
    expect(sniff(bytes('RIFF', 0x24, 0, 0, 0, 'NOPE'))).toBeUndefined();
    expect(sniff(bytes('RIFF'))).toBeUndefined();
  });

  test('png needs IHDR, not just the 8-byte signature', () => {
    expect(sniff(bytes(0x89, 'PNG', 0x0d, 0x0a, 0x1a, 0x0a))).toBeUndefined();
    expect(sniff(bytes(0x89, 'PNG', 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 'IEND'))).toBeUndefined();
  });

  test('truncated and unknown inputs return undefined without throwing', () => {
    expect(sniff(new Uint8Array(0))).toBeUndefined();
    expect(sniff(bytes(0x89))).toBeUndefined();
    expect(sniff(bytes(0xff))).toBeUndefined();
    expect(sniff(bytes('ft'))).toBeUndefined();
    expect(sniff(bytes(0, 0, 0, 0x18, 'ftyp', 'zzzz'))).toBeUndefined();
    expect(sniff(bytes('ustar'))).toBeUndefined();
    expect(sniff(HTML)).toBeUndefined();
    expect(sniff(bytes('{"a":1}'))).toBeUndefined();
  });

  test('ico and ttf do not collide', () => {
    expect(sniff(bytes(0x00, 0x00, 0x01, 0x00))).toBe('image/x-icon');
    expect(sniff(bytes(0x00, 0x01, 0x00, 0x00))).toBe('font/ttf');
  });

  test('SNIFF_BYTES covers the deepest probe', () => {
    expect(SNIFF_BYTES).toBe(4100);
    expect(SNIFF_BYTES).toBeGreaterThan(257 + 5);
  });

  test('isSniffable is false for the unsniffable types', () => {
    expect(isSniffable('text/plain')).toBe(false);
    expect(isSniffable('text/csv')).toBe(false);
    expect(isSniffable('application/json')).toBe(false);
    expect(isSniffable('image/svg+xml')).toBe(false);
    expect(isSniffable('image/jpg')).toBe(true);
  });
});

describe('expandContentTypes', () => {
  test('image/* is every sniffable image subtype and never svg', () => {
    const out = expandContentTypes(['image/*']);
    expect(out).toContain('image/png');
    expect(out).toContain('image/webp');
    expect(out).toContain('image/avif');
    expect(out).toContain('image/x-icon');
    expect(out).not.toContain('image/svg+xml');
    expect(out.every((t) => t.startsWith('image/'))).toBe(true);
  });

  test('video/* and audio/* expand likewise', () => {
    expect(expandContentTypes(['video/*'])).toContain('video/webm');
    expect(expandContentTypes(['video/*']).every((t) => t.startsWith('video/'))).toBe(true);
    expect(expandContentTypes(['audio/*'])).toContain('audio/mpeg');
    expect(expandContentTypes(['audio/*']).every((t) => t.startsWith('audio/'))).toBe(true);
  });

  test('svg passes through when listed explicitly', () => {
    expect(expandContentTypes(['image/svg+xml'])).toEqual(['image/svg+xml']);
  });

  test('exact types keep input order and are lowercased', () => {
    expect(expandContentTypes(['image/PNG', 'Text/Plain'])).toEqual(['image/png', 'text/plain']);
  });

  test('aliases collapse to the canonical name', () => {
    expect(expandContentTypes(['image/jpg', 'audio/mp3', 'audio/x-wav'])).toEqual(['image/jpeg', 'audio/mpeg', 'audio/wav']);
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
    const e = thrown(() => expandContentTypes([]));
    expect(e.code).toBe('invalid_content_type_pattern');
  });

  test('a non "a/b" string throws and names it', () => {
    for (const bad of ['png', 'image', 'image/', '/png', 'image/png/extra']) {
      const e = thrown(() => expandContentTypes([bad]));
      expect(e.code).toBe('invalid_content_type_pattern');
      expect(e.message).toContain(bad);
    }
  });
});

describe('checkContentType', () => {
  const images = expandContentTypes(['image/png', 'image/jpeg']);

  test('html bytes declared image/png are rejected', () => {
    const e = thrown(() => checkContentType('image/png', HTML, images));
    expect(e.code).toBe('content_type_not_allowed');
    expect(e.status).toBe(400);
    expect(e.message).toContain('image/png');
  });

  test('bytes that sniff as another type are rejected by both names', () => {
    const e = thrown(() => checkContentType('image/png', GIF, expandContentTypes(['image/png', 'image/gif'])));
    expect(e.message).toContain('image/gif');
    expect(e.message).toContain('image/png');
  });

  test('a declared type outside the list is rejected with the list as the hint', () => {
    const e = thrown(() => checkContentType('image/gif', GIF, images));
    expect(e.code).toBe('content_type_not_allowed');
    expect(e.message).toContain('image/gif is not allowed');
    expect(e.hint).toBe('allowed: image/png, image/jpeg');
  });

  test('matching bytes pass', () => {
    expect(() => checkContentType('image/png', PNG, images)).not.toThrow();
    expect(() => checkContentType('image/jpeg', JPEG, images)).not.toThrow();
  });

  test('text/plain passes on the declaration', () => {
    const allowed = expandContentTypes(['text/plain', 'text/csv', 'application/json']);
    expect(() => checkContentType('text/plain', HTML, allowed)).not.toThrow();
    expect(() => checkContentType('text/csv', bytes('a,b\n1,2\n'), allowed)).not.toThrow();
    expect(() => checkContentType('application/json', bytes('{"a":1}'), allowed)).not.toThrow();
  });

  test('an unsniffable declaration still has to be in the list', () => {
    const e = thrown(() => checkContentType('text/html', HTML, expandContentTypes(['text/plain'])));
    expect(e.code).toBe('content_type_not_allowed');
  });

  test('image/jpg and image/jpeg are the same type', () => {
    expect(() => checkContentType('image/jpg', JPEG, images)).not.toThrow();
    expect(() => checkContentType('image/jpeg', JPEG, expandContentTypes(['image/jpg']))).not.toThrow();
  });

  test('audio aliases are the same type', () => {
    expect(() => checkContentType('audio/x-wav', WAV, expandContentTypes(['audio/wav']))).not.toThrow();
    expect(() => checkContentType('audio/mp3', bytes('ID3', 0x03, 0x00), expandContentTypes(['audio/mpeg']))).not.toThrow();
  });

  test('charset and other parameters are stripped', () => {
    expect(() => checkContentType('IMAGE/PNG; charset=binary', PNG, images)).not.toThrow();
    expect(() => checkContentType('text/plain;charset=utf-8', HTML, expandContentTypes(['text/plain']))).not.toThrow();
    const e = thrown(() => checkContentType('image/gif; charset=binary', GIF, images));
    expect(e.message).toContain('image/gif is not allowed');
  });

  test('without bytes only the declaration is checked', () => {
    expect(() => checkContentType('image/png', undefined, images)).not.toThrow();
    expect(thrown(() => checkContentType('image/gif', undefined, images)).code).toBe('content_type_not_allowed');
  });

  test('empty bytes cannot prove a sniffable type', () => {
    expect(thrown(() => checkContentType('image/png', new Uint8Array(0), images)).code).toBe('content_type_not_allowed');
  });

  test('a video declaration is checked against its own bytes', () => {
    const allowed = expandContentTypes(['video/*']);
    expect(() => checkContentType('video/mp4', MP4, allowed)).not.toThrow();
    expect(thrown(() => checkContentType('video/webm', MP4, allowed)).message).toContain('video/mp4');
  });
});
