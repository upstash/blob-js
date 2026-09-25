import { describe, expect, test } from 'bun:test';
import { uniquePath } from '../../src/server/unique-path.ts';
import { encodeKey } from '../../src/server/keys.ts';

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

  test('accepts a plain string', () => {
    expect(uniquePath('chat/42/q3-report.pdf')).toMatch(new RegExp(`^chat/42/q3-report-${SUFFIX}\\.pdf$`));
  });

  test('a prefix with a trailing slash can be interpolated', () => {
    const prefix = 'agent-bench/run-1/';
    expect(stripSuffix(uniquePath`${prefix}${'alice'}/${'a.png'}`)).toBe('agent-bench/run-1/alice/a.png');
    expect(stripSuffix(uniquePath(`${prefix}alice/a.png`))).toBe('agent-bench/run-1/alice/a.png');
  });

  test('does not rewrite or reject slashes in values; the suffix goes on the final segment', () => {
    expect(stripSuffix(uniquePath`chat/${'b/c.png'}`)).toBe('chat/b/c.png');
    expect(uniquePath`chat/${'b/c.png'}`).toMatch(new RegExp(`^chat/b/c-${SUFFIX}\\.png$`));
  });

  test('traversal is refused where the key is used, not here', () => {
    for (const path of [uniquePath`uploads/${'..'}/${'x.png'}`, uniquePath('a/./b.png'), uniquePath('../x.png')]) {
      expect(() => encodeKey(path)).toThrow(TypeError);
    }
    // An invalid escape leaves the cooked chunk undefined; it must not print as "undefined".
    expect(uniquePath`up\users/${'a.png'}`).toMatch(new RegExp(`^a-${SUFFIX}\\.png$`));
    expect(uniquePath('a/..')).toMatch(new RegExp(`^a/\\.\\.-${SUFFIX}$`));
    expect(encodeKey(uniquePath`${'a\\b'}/${'c\nd.png'}`)).not.toMatch(/[\\\n]/);
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
