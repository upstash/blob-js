// Every timer the client uses goes through here, so tests can replace them without a browser.
export const clock = {
  now: (): number => Date.now(),
  random: (): number => Math.random(),
  sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(abortError());
      const t = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      function onAbort() {
        clearTimeout(t);
        reject(abortError());
      }
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  },
  frame(cb: () => void): void {
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => cb());
    else setTimeout(cb, 16);
  },
};

export function abortError(): Error {
  return typeof DOMException === 'function' ? new DOMException('The upload was canceled', 'AbortError') : Object.assign(new Error('The upload was canceled'), { name: 'AbortError' });
}
