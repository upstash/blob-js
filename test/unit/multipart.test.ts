import { describe, expect, test } from 'bun:test';
import { MULTIPART_THRESHOLD, partCount, partSizeFor } from '../../src/server/multipart.ts';

const MIB = 1024 * 1024;

describe('MULTIPART_THRESHOLD', () => {
  test('is 16MB decimal, like every other user-facing size', () => {
    expect(MULTIPART_THRESHOLD).toBe(16_000_000);
  });
});

describe('partSizeFor', () => {
  test('is binary: R2 rejects a part under 5 MiB at complete()', () => {
    expect(partSizeFor(16_000_000)).toBe(5 * MIB);
    expect(partCount(16_000_000, partSizeFor(16_000_000))).toBe(4);
  });

  test('floors at 5 MiB for anything the threshold lets through', () => {
    expect(partSizeFor(MULTIPART_THRESHOLD + 1)).toBe(5 * MIB);
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
