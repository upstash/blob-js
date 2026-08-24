import { clock } from './clock.ts';

export const MAX_ATTEMPTS = 8;
const BASE_MS = 500;
const CAP_MS = 15_000;

export type Verdict = 'retry' | 'represign' | 'fail';

/** retry: network, 408, 429, 5xx. represign: 401/403 (an expired presign looks like a tampered body). */
export function classify(status: number): Verdict {
  if (status === 0 || status === 408 || status === 429 || status === 500 || status === 502 || status === 503 || status === 504) return 'retry';
  if (status === 401 || status === 403) return 'represign';
  return 'fail';
}

/** Full jitter: uniform in [0, min(cap, base * 2^attempt)]. A 429 with Retry-After uses that instead. */
export function backoffMs(attempt: number, retryAfter?: string | null): number {
  if (retryAfter) {
    const secs = Number(retryAfter);
    if (Number.isFinite(secs) && secs >= 0) return Math.min(secs * 1000, 60_000);
    const at = Date.parse(retryAfter);
    if (Number.isFinite(at)) return Math.max(0, Math.min(at - clock.now(), 60_000));
  }
  return Math.floor(clock.random() * Math.min(CAP_MS, BASE_MS * 2 ** attempt));
}
