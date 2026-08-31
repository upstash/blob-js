import { describe, expect, test } from 'bun:test';
import { cacheControl, formatBytes, parseDuration, parseSize } from '../../src/shared/units.ts';

describe('parseSize', () => {
  test('is decimal, the way storage is billed', () => {
    expect(parseSize('2mb')).toBe(2_000_000);
    expect(parseSize('20mb')).toBe(20_000_000);
    expect(parseSize('500kb')).toBe(500_000);
    expect(parseSize('5gb')).toBe(5_000_000_000);
    expect(parseSize('1tb')).toBe(1_000_000_000_000);
    expect(parseSize('1b')).toBe(1);
  });

  test('accepts fractions, spacing and case', () => {
    expect(parseSize('1.5mb')).toBe(1_500_000);
    expect(parseSize(' 2 MB ')).toBe(2_000_000);
    expect(parseSize('4.5MB')).toBe(4_500_000);
  });

  test('a bare number is bytes', () => {
    expect(parseSize(4096)).toBe(4096);
    expect(parseSize('4096')).toBe(4096);
    expect(parseSize(0)).toBe(0);
    expect(parseSize(10.9)).toBe(10);
  });

  test('binary units are not part of the user-facing vocabulary', () => {
    expect(() => parseSize('5mib')).toThrow('unknown unit');
    expect(() => parseSize('5 KiB')).toThrow('unknown unit');
  });

  test('rejects junk and negatives, naming the option', () => {
    expect(() => parseSize('big', 'maxBytes')).toThrow('maxBytes');
    expect(() => parseSize('', 'maxBytes')).toThrow('maxBytes');
    expect(() => parseSize(-1, 'maxBytes')).toThrow('maxBytes');
    expect(() => parseSize(Number.NaN)).toThrow();
  });
});

describe('parseDuration', () => {
  test("'15m' is canonical and the long forms parse", () => {
    expect(parseDuration('15m')).toBe(900_000);
    expect(parseDuration('15 min')).toBe(900_000);
    expect(parseDuration('15minutes')).toBe(900_000);
    expect(parseDuration('2h')).toBe(7_200_000);
    expect(parseDuration('2 hours')).toBe(7_200_000);
    expect(parseDuration('7d')).toBe(604_800_000);
    expect(parseDuration('7 days')).toBe(604_800_000);
    expect(parseDuration('30s')).toBe(30_000);
    expect(parseDuration('30 seconds')).toBe(30_000);
    expect(parseDuration('250ms')).toBe(250);
    expect(parseDuration('1hr')).toBe(3_600_000);
  });

  test('a bare number is seconds', () => {
    expect(parseDuration(3600)).toBe(3_600_000);
    expect(parseDuration('3600')).toBe(3_600_000);
  });

  test('rejects an unknown unit and junk', () => {
    expect(() => parseDuration('15 weeks', 'expiresIn')).toThrow('expiresIn');
    expect(() => parseDuration('soon', 'expiresIn')).toThrow('expiresIn');
    expect(() => parseDuration(-5)).toThrow();
  });
});

describe('cacheControl', () => {
  test("defaults to '1h', and '1h' says the same thing", () => {
    expect(cacheControl(undefined)).toBe('public, max-age=3600');
    expect(cacheControl('1h')).toBe('public, max-age=3600');
    expect(cacheControl(3600)).toBe('public, max-age=3600');
  });

  test('a duration becomes max-age in whole seconds', () => {
    expect(cacheControl('1m')).toBe('public, max-age=60');
    expect(cacheControl('15 min')).toBe('public, max-age=900');
    expect(cacheControl('7d')).toBe('public, max-age=604800');
    expect(cacheControl('1500ms')).toBe('public, max-age=1');
  });

  test('the three words are not durations', () => {
    expect(cacheControl('immutable')).toBe('public, max-age=31536000, immutable');
    expect(cacheControl('revalidate')).toBe('public, max-age=0, must-revalidate');
    expect(cacheControl('no-store')).toBe('no-store');
  });

  test('a private bucket never says public', () => {
    expect(cacheControl(undefined, 'private')).toBe('private, max-age=3600');
    expect(cacheControl('1m', 'private')).toBe('private, max-age=60');
    expect(cacheControl('immutable', 'private')).toBe('private, max-age=31536000, immutable');
    expect(cacheControl('revalidate', 'private')).toBe('private, max-age=0, must-revalidate');
    expect(cacheControl('no-store', 'private')).toBe('no-store');
  });

  test('anything with a directive separator is a header, passed through as written', () => {
    expect(cacheControl('public, max-age=60, s-maxage=31536000')).toBe('public, max-age=60, s-maxage=31536000');
    expect(cacheControl('  max-age=0, stale-while-revalidate=86400  ')).toBe('max-age=0, stale-while-revalidate=86400');
    // Written out, so the visibility is the caller's to state and is not second-guessed.
    expect(cacheControl('public, max-age=60', 'private')).toBe('public, max-age=60');
  });
});

test('sizes are formatted the decimal way they are parsed', () => {
  expect(formatBytes(0)).toBe('0 B');
  expect(formatBytes(512)).toBe('512 B');
  expect(formatBytes(999)).toBe('999 B');
  expect(formatBytes(1500)).toBe('1.5 KB');
  expect(formatBytes(parseSize('2mb'))).toBe('2 MB');
  expect(formatBytes(3_145_728)).toBe('3.1 MB');
  expect(formatBytes(parseSize('20mb'))).toBe('20 MB');
  expect(formatBytes(parseSize('1.5gb'))).toBe('1.5 GB');
  expect(formatBytes(parseSize('5gb'))).toBe('5 GB');
  expect(formatBytes(parseSize('3tb'))).toBe('3 TB');
  // Past ten of a unit the decimal is noise.
  expect(formatBytes(20_971_520)).toBe('21 MB');
});

// Rounding both sides independently produced refusals reading "1MB, over the 1MB limit".
test('a size just over a limit does not format as the limit', () => {
  expect(formatBytes(1_049_999)).not.toBe(formatBytes(1_000_000));
  expect(formatBytes(1_049_999)).toBe('1.0 MB');
  expect(formatBytes(999_999)).toBe('1.0 MB');
  expect(formatBytes(1_000_000)).toBe('1 MB');
});
