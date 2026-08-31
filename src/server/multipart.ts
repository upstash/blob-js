import { BlobError } from '../shared/errors.ts';
import { formatBytes, parseSize, type Size } from '../shared/units.ts';

/**
 * Decimal, like every user-facing size. One line for both halves of the SDK: `bucket.put()` and a
 * direct browser upload each send a body under this as a single PUT and split anything over it.
 *
 * Parts are three round trips and one more per chunk where a PUT is one, and an upload begun and
 * never finished lingers until something aborts it. So parts are what a big file needs -- past R2's
 * single-PUT cap, and for a chunk that can be retried or resumed on its own -- rather than the shape
 * of every upload.
 */
export const MULTIPART_THRESHOLD = 16_000_000;

/** R2 refuses a single PUT larger than this, so past it there is no choice but parts. */
export const SINGLE_PUT_MAX = 5 * 1024 * 1024 * 1024;

/**
 * `true` always parts, `false` never does, a size is the threshold to use instead of the default.
 * @see MULTIPART_THRESHOLD
 */
export type MultipartOption = boolean | Size;

/** Whether a body of this size goes up in parts. Throws only for a `false` R2 cannot honour. */
export function wantsMultipart(option: MultipartOption | undefined, size: number, what = 'multipart'): boolean {
  if (size > SINGLE_PUT_MAX) {
    if (option === false) {
      throw new BlobError('too_large', {
        message: `${formatBytes(size)} is over the ${formatBytes(SINGLE_PUT_MAX)} a single PUT can carry`,
        hint: `${what}: false forbids the parts this body needs`,
      });
    }
    return true;
  }
  if (typeof option === 'boolean') return option;
  // A threshold above the single-PUT cap is honoured up to the cap, which the branch above enforces.
  return size > (option === undefined ? MULTIPART_THRESHOLD : parseSize(option, what));
}

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
