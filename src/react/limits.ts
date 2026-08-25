import { useEffect, useRef, useState } from 'react';
import { clock } from '../browser/clock.ts';
import { resolveHeaders, type HeadersProvider } from '../browser/task.ts';
import { BlobError } from '../shared/errors.ts';
import type { WireLimits } from '../shared/types.ts';
import { formatSize } from '../shared/units.ts';

/**
 * What a route says it accepts, fetched from its own GET. Shared by both hooks so a proxied upload
 * and a direct one fill the file picker from the same source: whatever the route refuses.
 */

// The route serves its limits with max-age=60. A cache that never expired outlived the deploy that
// changed them, so the picker went on refusing files the route had started accepting.
const LIMITS_TTL_MS = 60_000;
const cache = new Map<string, { limits: WireLimits; at: number }>();
const inFlight = new Map<string, Promise<WireLimits | undefined>>();

export function cachedLimits(route: string): WireLimits | undefined {
  const entry = cache.get(route);
  if (!entry) return undefined;
  if (clock.now() - entry.at > LIMITS_TTL_MS) {
    cache.delete(route);
    return undefined;
  }
  return entry.limits;
}

async function loadLimits(route: string, headers: HeadersProvider | undefined): Promise<WireLimits | undefined> {
  const hit = cachedLimits(route);
  if (hit) return hit;
  let pending = inFlight.get(route);
  if (!pending) {
    pending = (async () => {
      try {
        const res = await fetch(route, { headers: await resolveHeaders(headers) });
        if (!res.ok) return undefined;
        const body = (await res.json()) as { limits?: WireLimits } | undefined;
        const limits = body?.limits;
        if (!limits || typeof limits !== 'object') return undefined;
        cache.set(route, { limits, at: clock.now() });
        return limits;
      } catch {
        // A route that will not say what it allows still uploads; the picker just has no accept.
        return undefined;
      } finally {
        inFlight.delete(route);
      }
    })();
    inFlight.set(route, pending);
  }
  return pending;
}

export function acceptOf(limits: WireLimits | undefined): string {
  return limits?.allowedContentTypes?.join(',') ?? '';
}

/**
 * Size only. accept carries the types, and the route canonicalises aliases before comparing
 * (image/jpg is image/jpeg), so a type check against the served list refuses files it accepts.
 */
export function deny(file: File, limits: WireLimits | undefined): BlobError | undefined {
  if (limits?.maxBytes !== undefined && file.size > limits.maxBytes) {
    return new BlobError('too_large', { message: `${file.name} is ${formatSize(file.size)}, over the ${formatSize(limits.maxBytes)} limit` });
  }
  return undefined;
}

/** The live limits for a route, plus the `accept` string a file input wants. */
export function useLimits(route: string, headers: HeadersProvider | undefined) {
  const headersRef = useRef<HeadersProvider | undefined>(headers);
  headersRef.current = headers;

  const limitsRef = useRef<WireLimits | undefined>(cachedLimits(route));
  const [accept, setAccept] = useState(() => acceptOf(cachedLimits(route)));

  useEffect(() => {
    let alive = true;
    limitsRef.current = cachedLimits(route);
    setAccept(acceptOf(limitsRef.current));
    void loadLimits(route, headersRef.current).then((limits) => {
      if (!alive || !limits) return;
      limitsRef.current = limits;
      setAccept(acceptOf(limits));
    });
    return () => {
      alive = false;
    };
  }, [route]);

  return { limitsRef, accept };
}
