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

export type CacheOption = Duration | 'immutable' | 'no-store';

export function cacheControl(cache: CacheOption | undefined): string {
  if (cache === undefined) return 'public, max-age=3600';
  if (cache === 'immutable') return 'public, max-age=31536000, immutable';
  if (cache === 'no-store') return 'no-store';
  return `public, max-age=${Math.floor(parseDuration(cache, 'cache') / 1000)}`;
}
