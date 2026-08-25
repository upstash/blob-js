import { useEffect, useRef, useState } from 'react';
import { clock } from '../browser/clock.ts';
import { resolveHeaders, type HeadersProvider } from '../browser/task.ts';
import { BlobError } from '../shared/errors.ts';
import type { WireLimits, WireLimitsResponse } from '../shared/types.ts';
import { formatSize } from '../shared/units.ts';

/**
 * What a route says it accepts, fetched from its own GET. Shared by both hooks so a proxied upload
 * and a direct one fill the file picker from the same source: whatever the route refuses.
 */

// The route serves its limits with max-age=60. A cache that never expired outlived the deploy that
// changed them, so the picker went on refusing files the route had started accepting.
const LIMITS_TTL_MS = 60_000;
// A route with no GET half answers 404/405 forever. Caching that too is what keeps every mount of
// every component on a plain POST-only route from re-asking.
const cache = new Map<string, RouteFacts & { at: number }>();
const inFlight = new Map<string, Promise<RouteFacts>>();

/** What a route says about itself. `transport` decides which upload one hook runs for it. */
export interface RouteFacts {
  limits: WireLimits | undefined;
  transport: 'direct' | 'proxy';
}

export function cachedFacts(route: string): RouteFacts | undefined {
  return fresh(route);
}

function fresh(route: string): (RouteFacts & { at: number }) | undefined {
  const entry = cache.get(route);
  if (!entry) return undefined;
  if (clock.now() - entry.at > LIMITS_TTL_MS) {
    cache.delete(route);
    return undefined;
  }
  return entry;
}

export function loadFacts(route: string, headers: HeadersProvider | undefined): Promise<RouteFacts> {
  const hit = fresh(route);
  if (hit) return Promise.resolve(hit);
  let pending = inFlight.get(route);
  if (!pending) {
    pending = (async () => {
      let limits: WireLimits | undefined;
      // A route that never answers is a route the SDK presigns against, which is what every
      // handleUpload route did before the proxy transport existed.
      let transport: 'direct' | 'proxy' = 'direct';
      try {
        const res = await fetch(route, { headers: await resolveHeaders(headers) });
        if (res.ok) {
          const body = (await res.json()) as WireLimitsResponse | undefined;
          if (body?.limits && typeof body.limits === 'object') limits = body.limits;
          if (body?.transport === 'proxy') transport = 'proxy';
        }
      } catch {
        // A route that will not say what it allows still uploads; the picker just has no accept.
      } finally {
        inFlight.delete(route);
      }
      cache.set(route, { limits, transport, at: clock.now() });
      return { limits, transport };
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

/** The live limits for a route, its transport, and the `accept` string a file input wants. */
export function useLimits(route: string, headers: HeadersProvider | undefined) {
  const headersRef = useRef<HeadersProvider | undefined>(headers);
  headersRef.current = headers;

  const limitsRef = useRef<WireLimits | undefined>(cachedFacts(route)?.limits);
  const transportRef = useRef<'direct' | 'proxy' | undefined>(cachedFacts(route)?.transport);
  const [accept, setAccept] = useState(() => acceptOf(cachedFacts(route)?.limits));

  useEffect(() => {
    let alive = true;
    const hit = cachedFacts(route);
    limitsRef.current = hit?.limits;
    transportRef.current = hit?.transport;
    setAccept(acceptOf(limitsRef.current));
    void loadFacts(route, headersRef.current).then((facts) => {
      if (!alive) return;
      limitsRef.current = facts.limits;
      transportRef.current = facts.transport;
      setAccept(acceptOf(facts.limits));
    });
    return () => {
      alive = false;
    };
  }, [route]);

  /** Resolves once the route has said what it is, so a file picked before the GET lands still waits. */
  const load = (): Promise<RouteFacts> => {
    const facts = loadFacts(route, headersRef.current);
    void facts.then((f) => {
      limitsRef.current = f.limits;
      transportRef.current = f.transport;
    });
    return facts;
  };

  return { limitsRef, transportRef, accept, load };
}
