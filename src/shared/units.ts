// Sizes are decimal ('2mb' = 2,000,000), matching how storage is billed. The only binary math in
// the SDK is multipart part sizing, because R2's part floor is 5 MiB.
export type Size = string | number;
export type Duration = string | number;

const SIZE_UNITS: Record<string, number> = {
  b: 1,
  kb: 1e3,
  mb: 1e6,
  gb: 1e9,
  tb: 1e12,
};

export function parseSize(input: Size, what = 'size'): number {
  if (typeof input === 'number') {
    if (!Number.isFinite(input) || input < 0) throw new TypeError(`${what}: expected a non-negative number of bytes, got ${input}`);
    return Math.floor(input);
  }
  const m = /^\s*(\d+(?:\.\d+)?)\s*([a-z]*)\s*$/i.exec(input);
  if (!m) throw new TypeError(`${what}: cannot parse "${input}" (try '2mb', '500kb', '5gb')`);
  const unit = (m[2] || 'b').toLowerCase();
  const mult = SIZE_UNITS[unit];
  if (mult === undefined) throw new TypeError(`${what}: unknown unit "${m[2]}" in "${input}" (b, kb, mb, gb, tb)`);
  return Math.floor(Number(m[1]) * mult);
}

/**
 * Decimal, the same way parseSize reads them, so a limit written '2mb' is refused as "2 MB". An
 * exact multiple of the unit prints whole and anything else keeps a decimal, because rounding both
 * sides independently produced refusals reading "1MB, over the 1MB limit"; past 10 of a unit the
 * decimal is noise and is dropped.
 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes)) return `${bytes} B`;
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let n = bytes;
  let unit = 0;
  // >= 999.95 and not 1000: at one decimal it would print as "1000 KB", which is a megabyte.
  while (n >= 999.95 && unit < units.length - 1) {
    n /= 1000;
    unit++;
  }
  return `${Number.isInteger(n) ? n : n.toFixed(n < 10 ? 1 : 0)} ${units[unit]}`;
}

const DURATION_UNITS: Record<string, number> = {
  ms: 1,
  s: 1000,
  sec: 1000,
  second: 1000,
  seconds: 1000,
  m: 60_000,
  min: 60_000,
  minute: 60_000,
  minutes: 60_000,
  h: 3_600_000,
  hr: 3_600_000,
  hour: 3_600_000,
  hours: 3_600_000,
  d: 86_400_000,
  day: 86_400_000,
  days: 86_400_000,
};

/** Milliseconds. A bare number is seconds, the unit every TTL option on the web already uses. */
export function parseDuration(input: Duration, what = 'duration'): number {
  if (typeof input === 'number') {
    if (!Number.isFinite(input) || input < 0) throw new TypeError(`${what}: expected a non-negative number of seconds, got ${input}`);
    return Math.floor(input * 1000);
  }
  const m = /^\s*(\d+(?:\.\d+)?)\s*([a-z]*)\s*$/i.exec(input);
  if (!m) throw new TypeError(`${what}: cannot parse "${input}" (try '15m', '2h', '7d')`);
  const unit = (m[2] || 's').toLowerCase();
  const mult = DURATION_UNITS[unit];
  if (mult === undefined) throw new TypeError(`${what}: unknown unit "${m[2]}" in "${input}" (s, m, h, d)`);
  return Math.floor(Number(m[1]) * mult);
}

/**
 * Three words and a duration for what almost every object wants. Anything else is a cache-control
 * header, written out: `s-maxage`, `stale-while-revalidate`, `no-transform` and whatever the spec
 * adds next are all sayable without this type growing a camelCase word for each of them.
 */
/**
 * The `Cache-Control` an object is stored with. It is written once, at upload, and served on every
 * read by the CDN and the browser: changing it later means writing the object again.
 *
 * - `'immutable'` -- `public, max-age=31536000, immutable`, for a versioned path that never changes
 * - `'revalidate'` -- `public, max-age=0, must-revalidate`, for a stable path that gets overwritten
 * - `'no-store'` -- `no-store`
 * - a duration (`'15m'`, `3600`) -- `public, max-age=<seconds>`
 * - unset -- `public, max-age=3600`
 * - anything containing `=` or `,` is a header, stored exactly as written
 *
 * `private` replaces `public` on a private bucket, since a shared cache must not keep a copy of an
 * object only a signed request may read.
 */
export type CacheOption = Duration | 'immutable' | 'revalidate' | 'no-store';

// A directive separator is what tells the two apart: a header always has one, a duration never does.
const RAW_HEADER = /[=,]/;

export function cacheControl(cache: CacheOption | undefined, visibility: 'public' | 'private' = 'public'): string {
  // `public` on an object only a signed request can read invites every shared cache between here
  // and the reader to keep a copy and hand it to the next one.
  const scope = visibility;
  if (cache === undefined) return `${scope}, max-age=3600`;
  if (cache === 'immutable') return `${scope}, max-age=31536000, immutable`;
  // For a stable path that is overwritten: the copy is kept and checked with If-None-Match, so an
  // unchanged object costs a 304 with no body instead of the whole object once every max-age.
  // A short max-age is the wrong tool there -- it is stale until it expires, then re-downloads.
  if (cache === 'revalidate') return `${scope}, max-age=0, must-revalidate`;
  if (cache === 'no-store') return 'no-store';
  // Written out, and passed through as written: the visibility is yours to state too.
  if (typeof cache === 'string' && RAW_HEADER.test(cache)) return cache.trim();
  return `${scope}, max-age=${Math.floor(parseDuration(cache, 'cache') / 1000)}`;
}

/**
 * The leading bytes a type check looks at. The browser slices this many off the file for phase
 * 'begin' and the server clamps what it decodes to the same number, so it lives here rather than in
 * either half: every signature the SDK knows sits in the first 32 bytes, but the two sides must
 * agree on what they are talking about.
 */
export const SNIFF_BYTES = 4100;
