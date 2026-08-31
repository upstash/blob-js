import { describe, expect, test } from 'bun:test';
import { BlobError } from '../../src/shared/errors.ts';
import { MULTIPART_THRESHOLD, partCount, partSizeFor, SINGLE_PUT_MAX, wantsMultipart } from '../../src/server/multipart.ts';

const MIB = 1024 * 1024;

describe('MULTIPART_THRESHOLD', () => {
  test('is 16MB decimal, like every other user-facing size', () => {
    expect(MULTIPART_THRESHOLD).toBe(16_000_000);
  });

  test('is one line for both halves of the SDK: a put and a browser upload split at the same size', () => {
    expect(wantsMultipart(undefined, MULTIPART_THRESHOLD)).toBe(false);
    expect(wantsMultipart(undefined, MULTIPART_THRESHOLD + 1)).toBe(true);
    // The small upload every app actually does: one PUT, and nothing half-created behind it.
    expect(wantsMultipart(undefined, 3_000)).toBe(false);
  });
});

describe('wantsMultipart', () => {
  test('a size is the threshold, in the same units as every other option', () => {
    expect(wantsMultipart('100mb', 99_000_000)).toBe(false);
    expect(wantsMultipart('100mb', 100_000_001)).toBe(true);
    expect(wantsMultipart(5_000, 5_001)).toBe(true);
  });

  test('true and false pin it, whatever the size', () => {
    expect(wantsMultipart(true, 1)).toBe(true);
    expect(wantsMultipart(false, 4_000_000_000)).toBe(false);
  });

  test('a threshold of 0 is the old always-multipart behaviour, the long way round', () => {
    for (const option of [0, '0b', true] as const) {
      expect(wantsMultipart(option, 1)).toBe(true);
      expect(wantsMultipart(option, MULTIPART_THRESHOLD)).toBe(true);
    }
  });

  test('past R2 single-PUT cap there is no choice, and a false that forbids it says so', () => {
    expect(wantsMultipart(undefined, SINGLE_PUT_MAX + 1)).toBe(true);
    expect(wantsMultipart('50gb', SINGLE_PUT_MAX + 1)).toBe(true);
    try {
      wantsMultipart(false, SINGLE_PUT_MAX + 1);
      throw new Error('expected a refusal');
    } catch (e) {
      expect(BlobError.is(e)).toBe(true);
      expect((e as BlobError).code).toBe('too_large');
      expect((e as BlobError).hint).toContain('multipart: false');
    }
  });

  test('a single part still covers the whole file, so the browser runs one loop either way', () => {
    expect(partCount(3_000, 3_000)).toBe(1);
    expect(partCount(1, 1)).toBe(1);
  });
});

describe('partSizeFor', () => {
  test('is binary: R2 rejects a part under 5 MiB at complete()', () => {
    expect(partSizeFor(16_000_000)).toBe(5 * MIB);
    expect(partCount(16_000_000, partSizeFor(16_000_000))).toBe(4);
  });

  test('floors at 5 MiB, the R2 minimum for every part but the last', () => {
    expect(partSizeFor(1)).toBe(5 * MIB);
    expect(partSizeFor(16_000_001)).toBe(5 * MIB);
    expect(partSizeFor(100_000_000)).toBe(5 * MIB);
    expect(partSizeFor(1_310_720_000)).toBe(5 * MIB);
  });

  test('a 2GB file is 8 MiB parts', () => {
    expect(partSizeFor(2_000_000_000)).toBe(8 * MIB);
    // Targeting 250 parts, not a part size: the count stays just under it whatever the file is.
    expect(partCount(2_000_000_000, partSizeFor(2_000_000_000))).toBe(239);
  });

  test('a 5GB file is 20 MiB parts, the blast radius of one crashed part', () => {
    expect(partSizeFor(5_000_000_000)).toBe(20 * MIB);
    expect(partCount(5_000_000_000, partSizeFor(5_000_000_000))).toBe(239);
  });

  test('every size stays two orders of magnitude under the 10,000 part ceiling', () => {
    for (const size of [16_000_000, 20_000_000, 100_000_000, 999_999_999, 2_000_000_000, 5_000_000_000, 50_000_000_000]) {
      const partSize = partSizeFor(size);
      expect(partSize % MIB).toBe(0);
      expect(partSize).toBeGreaterThanOrEqual(5 * MIB);
      expect(partCount(size, partSize)).toBeLessThanOrEqual(250);
    }
  });
});

describe('partCount', () => {
  test('the last part is the short one', () => {
    expect(partCount(5 * MIB, 5 * MIB)).toBe(1);
    expect(partCount(5 * MIB + 1, 5 * MIB)).toBe(2);
    expect(partCount(0, 5 * MIB)).toBe(1);
  });
});
