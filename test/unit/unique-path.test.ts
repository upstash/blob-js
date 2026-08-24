import { describe, expect, test } from 'bun:test';
import { uniquePath } from '../../src/server/unique-path.ts';

const B58 = '[1-9A-HJ-NP-Za-km-z]';
const SUFFIX = `${B58}{8}`;
const stripSuffix = (path: string) => path.replace(new RegExp(`-${SUFFIX}`), '');

describe('uniquePath', () => {
  test('slugs a browser filename and keeps its extension', () => {
    expect(uniquePath`${'Q3 Report (final).pdf'}`).toMatch(new RegExp(`^q3-report-final-${SUFFIX}\\.pdf$`));
  });

  test('literal slashes are structure, values fill the segments', () => {
    expect(uniquePath`chat/${'42'}/${'q3-report.pdf'}`).toMatch(new RegExp(`^chat/42/q3-report-${SUFFIX}\\.pdf$`));
  });

  test('a value cannot contribute directory structure', () => {
    expect(uniquePath`chat/${'../admin/x.png'}`).toMatch(new RegExp(`^chat/x-${SUFFIX}\\.png$`));
    expect(uniquePath`a/${'b/c'}`).toMatch(new RegExp(`^a/c-${SUFFIX}$`));
    expect(uniquePath`${'a/b\\c.tar.gz'}`).toMatch(new RegExp(`^c-tar-${SUFFIX}\\.gz$`));
  });

  test('unicode letters and digits survive', () => {
    expect(uniquePath`${'café.pdf'}`).toMatch(new RegExp(`^café-${SUFFIX}\\.pdf$`));
    expect(uniquePath`${'Ünïcode ٣.pdf'}`).toMatch(new RegExp(`^ünïcode-٣-${SUFFIX}\\.pdf$`));
  });

  test('composed and decomposed forms give the same path', () => {
    const composed = stripSuffix(uniquePath`${'caf\u00e9.pdf'}`);
    const decomposed = stripSuffix(uniquePath`${'cafe\u0301.pdf'}`);
    expect(composed).toBe('café.pdf');
    expect(decomposed).toBe(composed);
  });

  test('non-latin scripts keep their stem; symbols and emoji separate', () => {
    expect(uniquePath`${'a日本b.pdf'}`).toMatch(new RegExp(`^a日本b-${SUFFIX}\\.pdf$`));
    expect(uniquePath`${'日本語.pdf'}`).toMatch(new RegExp(`^日本語-${SUFFIX}\\.pdf$`));
    expect(uniquePath`${'a🙂b&c.pdf'}`).toMatch(new RegExp(`^a-b-c-${SUFFIX}\\.pdf$`));
  });

  test('a value that slugs to empty becomes file', () => {
    expect(uniquePath`${''}`).toMatch(new RegExp(`^file-${SUFFIX}$`));
    expect(uniquePath`${'!!! ***'}`).toMatch(new RegExp(`^file-${SUFFIX}$`));
  });

  test('the stem is capped at 64 chars', () => {
    const path = uniquePath`${`${'a'.repeat(900)}.png`}`;
    expect(path).toMatch(new RegExp(`^a{64}-${SUFFIX}\\.png$`));
    expect(stripSuffix(path)).toBe(`${'a'.repeat(64)}.png`);
  });

  test('the cap does not leave a trailing separator', () => {
    expect(uniquePath`${`${'a'.repeat(63)} b`}`).toMatch(new RegExp(`^a{63}-${SUFFIX}$`));
  });

  test('extensions are lowercased', () => {
    expect(uniquePath`${'REPORT.PDF'}`).toMatch(new RegExp(`^report-${SUFFIX}\\.pdf$`));
  });

  test('only the final extension survives', () => {
    expect(uniquePath`${'x.exe.png'}`).toMatch(new RegExp(`^x-exe-${SUFFIX}\\.png$`));
  });

  test('an extension longer than 8 chars is not an extension', () => {
    expect(uniquePath`${'x.superlongext'}`).toMatch(new RegExp(`^x-superlongext-${SUFFIX}$`));
  });

  test('a value with no extension gets no dot', () => {
    expect(uniquePath`avatar/${'user name'}`).toMatch(new RegExp(`^avatar/user-name-${SUFFIX}$`));
  });

  test('a literal basename extension is recognised', () => {
    expect(uniquePath`foo/${'x'}/bar.png`).toMatch(new RegExp(`^foo/x/bar-${SUFFIX}\\.png$`));
  });

  test('control and format characters are stripped', () => {
    expect(uniquePath`${'a\u200bb\u202ec.png'}`).toMatch(new RegExp(`^abc-${SUFFIX}\\.png$`));
    expect(uniquePath`${'a\nb.png'}`).toMatch(new RegExp(`^ab-${SUFFIX}\\.png$`));
  });

  test('literal chunks are trimmed of surrounding whitespace', () => {
    expect(uniquePath`  photos/${'a.png'}  `).toMatch(new RegExp(`^photos/a-${SUFFIX}\\.png$`));
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
