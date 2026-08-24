/** Decimal, like every user-facing size. Above this the browser client goes multipart. */
export const MULTIPART_THRESHOLD = 16_000_000;

// Part math is binary: R2's floor for every part but the last is 5 MiB, checked at complete().
const MIB = 1024 * 1024;
const MIN_PART = 5 * MIB;
const TARGET_PARTS = 250;

/** max(5 MiB, ceil(size / 250)) rounded up to a MiB. */
export function partSizeFor(size: number): number {
  return Math.max(MIN_PART, Math.ceil(Math.ceil(size / TARGET_PARTS) / MIB) * MIB);
}

export function partCount(size: number, partSize: number): number {
  return Math.max(1, Math.ceil(size / partSize));
}
