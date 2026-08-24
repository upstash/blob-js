import { abortError } from './clock.ts';

// One cap shared by every task in the page: files and parts draw from the same pool because the
// browser does not care which of ours a request belongs to.
export const GLOBAL_REQUEST_CAP = 6;

let active = 0;
const waiting: { grant: () => void; signal: AbortSignal | undefined }[] = [];

function pump(): void {
  while (active < GLOBAL_REQUEST_CAP && waiting.length) {
    const next = waiting.shift()!;
    if (next.signal?.aborted) continue;
    active++;
    next.grant();
  }
}

/** Resolves with a release function once a slot is free. Rejects with AbortError if the signal fires first. */
export function acquire(signal?: AbortSignal): Promise<() => void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      active--;
      pump();
    };
    const entry = {
      signal,
      grant: () => {
        signal?.removeEventListener('abort', onAbort);
        resolve(release);
      },
    };
    function onAbort() {
      const i = waiting.indexOf(entry);
      if (i >= 0) waiting.splice(i, 1);
      reject(abortError());
    }
    signal?.addEventListener('abort', onAbort, { once: true });
    waiting.push(entry);
    pump();
  });
}

/** Tests only. */
export function poolState(): { active: number; waiting: number } {
  return { active, waiting: waiting.length };
}
