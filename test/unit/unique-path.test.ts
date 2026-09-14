import { describe, expect, test } from 'bun:test';
import { uniquePath } from '../../src/server/unique-path.ts';

const B58 = '[1-9A-HJ-NP-Za-km-z]';
const SUFFIX = `${B58}{8}`;
const stripSuffix = (path: string) => path.replace(new RegExp(`-${SUFFIX}(?=\\.[a-z0-9]{1,8}$|$)`, 'i'), '');

describe('uniquePath', () => {
  test('preserves a browser filename and keeps its extension', () => {
    expect(uniquePath`${'Q3 Report (final).pdf'}`).toMatch(new RegExp(`^Q3 Report \\(final\\)-${SUFFIX}\\.pdf$`));
  });

  test('preserves the exact owner prefix used for authorization', () => {
    const owner = 'Alice_123';
    const path = uniquePath`users/${owner}/${'Q3 Report.pdf'}`;
    expect(path.startsWith(`users/${owner}/`)).toBe(true);
    expect(stripSuffix(path)).toBe('users/Alice_123/Q3 Report.pdf');
    expect(stripSuffix(uniquePath`users/${'alice-123'}/${'Q3 Report.pdf'}`)).not.toBe(stripSuffix(path));
  });

  test('literal slashes are structure, values fill the segments', () => {
    expect(uniquePath`chat/${'42'}/${'q3-report.pdf'}`).toMatch(new RegExp(`^chat/42/q3-report-${SUFFIX}\\.pdf$`));
  });

  test('rejects directory separators, traversal and controls in values instead of rewriting them', () => {
    for (const value of ['../admin/x.png', 'b/c', 'a\\b.png', '.', '..', 'a\nb.png', 'a\rb.png', 'a\tb.png', 'a\0b.png', 'a\u007fb.png', 'a\u0085b.png']) {
      expect(() => uniquePath`chat/${value}`).toThrow(TypeError);
    }
    expect(() => uniquePath`${'../admin/x.png'}`).toThrow('uniquePath interpolations');
  });

  test('validates assembled segments before adding the suffix', () => {
    expect(() => uniquePath`safe/.${''}./file.png`).toThrow(TypeError);
    expect(() => uniquePath`safe/.${''}/file.png`).toThrow(TypeError);
    expect(() => uniquePath`safe/.${''}.`).toThrow(TypeError);
    expect(() => uniquePath`../${'file.png'}`).toThrow(TypeError);
    expect(() => uniquePath`safe\\${'file.png'}`).toThrow(TypeError);
    expect(() => uniquePath`safe/\n${'file.png'}`).toThrow(TypeError);
  });

  test('preserves unicode, punctuation, emoji and format characters', () => {
    for (const name of ['café.pdf', 'Ünïcode ٣.pdf', '日本語.pdf', 'a🙂b&c.pdf', '👩‍💻.png', 'a\u200bb.png', '!!! ***']) {
      expect(stripSuffix(uniquePath`${name}`)).toBe(name);
    }
  });

  test('preserves distinct Unicode normalization forms in owner IDs and filenames', () => {
    for (const owner of ['caf\u00e9', 'cafe\u0301']) {
      const filename = `${owner}.pdf`;
      const path = uniquePath`users/${owner}/${filename}`;
      expect(path.startsWith(`users/${owner}/`)).toBe(true);
      expect(stripSuffix(path)).toBe(`users/${owner}/${filename}`);
    }
  });

  test('an empty final filename becomes file', () => {
    expect(uniquePath`${''}`).toMatch(new RegExp(`^file-${SUFFIX}$`));
    expect(uniquePath``).toMatch(new RegExp(`^file-${SUFFIX}$`));
  });

  test('a leading dot alone does not make a filename an empty stem', () => {
    expect(uniquePath`${'.env'}`).toMatch(new RegExp(`^\\.env-${SUFFIX}$`));
    expect(uniquePath`${'.env.local'}`).toMatch(new RegExp(`^\\.env-${SUFFIX}\\.local$`));
  });

  test('does not truncate long owner IDs or filenames', () => {
    const owner = 'A_'.repeat(80);
    const filename = `${'a'.repeat(900)}.png`;
    expect(stripSuffix(uniquePath`${owner}/${filename}`)).toBe(`${owner}/${filename}`);
  });

  test('preserves extension case', () => {
    expect(uniquePath`${'REPORT.PDF'}`).toMatch(new RegExp(`^REPORT-${SUFFIX}\\.PDF$`));
  });

  test('adds the suffix before the final extension, preserving earlier dots', () => {
    expect(uniquePath`${'x.exe.png'}`).toMatch(new RegExp(`^x\\.exe-${SUFFIX}\\.png$`));
  });

  test('an extension longer than 8 chars is kept in the stem', () => {
    expect(uniquePath`${'x.superlongext'}`).toMatch(new RegExp(`^x\\.superlongext-${SUFFIX}$`));
  });

  test('a value with no extension gets no dot', () => {
    expect(uniquePath`avatar/${'user name'}`).toMatch(new RegExp(`^avatar/user name-${SUFFIX}$`));
  });

  test('a literal basename extension is recognised', () => {
    expect(uniquePath`foo/${'x'}/bar.png`).toMatch(new RegExp(`^foo/x/bar-${SUFFIX}\\.png$`));
  });

  test('preserves whitespace in literal chunks and interpolations', () => {
    expect(stripSuffix(uniquePath`  photos/${' a.png'}  `)).toBe('  photos/ a.png  ');
    expect(stripSuffix(uniquePath`photo ${'a'}.png`)).toBe('photo a.png');
  });

  test('non-string values are stringified', () => {
    expect(uniquePath`chat/${42}/${'a.png'}`).toMatch(new RegExp(`^chat/42/a-${SUFFIX}\\.png$`));
  });

  test('a trailing literal slash still yields a basename', () => {
    expect(uniquePath`${'a.png'}/thumbs/`).toMatch(new RegExp(`^a\\.png/thumbs/file-${SUFFIX}$`));
  });

  test('two calls differ in suffix', () => {
    const paths = new Set(Array.from({ length: 100 }, () => uniquePath`${'a.png'}`));
    expect(paths.size).toBe(100);
  });

  test('the suffix uses the base58 alphabet only', () => {
    const alphabet = new Set('123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz');
    const seen = new Set<string>();
    for (let i = 0; i < 500; i++) {
      const suffix = uniquePath`${'a'}`.slice(2);
      expect(suffix).toHaveLength(8);
      for (const c of suffix) {
        expect(alphabet.has(c)).toBe(true);
        seen.add(c);
      }
    }
    for (const c of '0OIl') expect(seen.has(c)).toBe(false);
    expect(seen.size).toBe(58);
  });
});
