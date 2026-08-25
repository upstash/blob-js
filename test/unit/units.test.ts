import { describe, expect, test } from 'bun:test';
import { cacheControl, formatSize, parseDuration, parseSize } from '../../src/shared/units.ts';

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

  test('the two words are not durations', () => {
    expect(cacheControl('immutable')).toBe('public, max-age=31536000, immutable');
    expect(cacheControl('no-store')).toBe('no-store');
  });
});

test('sizes are formatted the decimal way they are parsed', () => {
  expect(formatSize(0)).toBe('0B');
  expect(formatSize(999)).toBe('999B');
  expect(formatSize(1500)).toBe('1.5kB');
  expect(formatSize(parseSize('2mb'))).toBe('2MB');
  expect(formatSize(3_145_728)).toBe('3.1MB');
  expect(formatSize(parseSize('5gb'))).toBe('5GB');
});

// Rounding both sides independently produced refusals reading "1MB, over the 1MB limit".
test('a size just over a limit does not format as the limit', () => {
  expect(formatSize(1_049_999)).not.toBe(formatSize(1_000_000));
  expect(formatSize(1_049_999)).toBe('1.0MB');
  expect(formatSize(999_999)).toBe('1.0MB');
  expect(formatSize(1_000_000)).toBe('1MB');
});
