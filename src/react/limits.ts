import { useCallback, useEffect, useRef, useState } from 'react';
import { clock } from '../browser/clock.ts';
import { resolveHeaders, type HeadersProvider } from '../browser/task.ts';
import { BlobError } from '../shared/errors.ts';
import type { WireLimits, WireLimitsResponse } from '../shared/types.ts';
import { formatBytes } from '../shared/units.ts';

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
  /**
   * Undefined when the route could not be asked -- the network failed, or it answered an error --
   * and is not cached then, so the next start() asks again. Never guessed: a presign sent to a
   * proxy route is a JSON body it would store.
   */
  transport: 'direct' | 'proxy' | undefined;
  /** Why the route could not be asked, for the upload that was waiting on it. */
  error?: BlobError;
}

export function cachedFacts(route: string): RouteFacts | undefined {
  const entry = cache.get(route);
  if (!entry) return undefined;
  if (clock.now() - entry.at > LIMITS_TTL_MS) {
    cache.delete(route);
    return undefined;
  }
  return entry;
}

export function loadFacts(route: string, headers: HeadersProvider | undefined): Promise<RouteFacts> {
  const hit = cachedFacts(route);
  if (hit) return Promise.resolve(hit);
  let pending = inFlight.get(route);
  if (!pending) {
    pending = fetchFacts(route, headers).finally(() => inFlight.delete(route));
    inFlight.set(route, pending);
  }
  return pending;
}

async function fetchFacts(route: string, headers: HeadersProvider | undefined): Promise<RouteFacts> {
  let authored: Record<string, string>;
  try {
    // The app's own hook. A throw from it is the app refusing the upload, and reaches it as thrown.
    authored = await resolveHeaders(headers);
  } catch (e) {
    return { limits: undefined, transport: undefined, error: BlobError.is(e) ? e : new BlobError('request_failed', { message: e instanceof Error ? e.message : String(e), status: 400, cause: e }) };
  }
  let res: Response;
  try {
    res = await fetch(route, { headers: authored });
  } catch (e) {
    return { limits: undefined, transport: undefined, error: new BlobError('request_failed', { message: 'could not reach the route', status: 503, cause: e }) };
  }
  // A route with no GET half is one the SDK presigns against: a branded route from before the
  // proxy transport existed. Any other refusal is the route's own, and the upload carries it.
  if (res.status === 404 || res.status === 405) return remember(route, { limits: undefined, transport: 'direct' });
  if (!res.ok) {
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      body = undefined;
    }
    return { limits: undefined, transport: undefined, error: BlobError.fromJSON(body, res.status) ?? BlobError.fromStatus(res.status) };
  }
  let limits: WireLimits | undefined;
  let transport: 'direct' | 'proxy' = 'direct';
  try {
    const body = (await res.json()) as WireLimitsResponse | undefined;
    if (body?.limits && typeof body.limits === 'object') limits = body.limits;
    if (body?.transport === 'proxy') transport = 'proxy';
  } catch {
    // Not the limits document: a route that will not say what it allows still uploads.
  }
  return remember(route, { limits, transport });
}

function remember(route: string, facts: RouteFacts): RouteFacts {
  cache.set(route, { ...facts, at: clock.now() });
  return facts;
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
    return new BlobError('too_large', { message: `${file.name} is ${formatBytes(file.size)}, over the ${formatBytes(limits.maxBytes)} limit` });
  }
  return undefined;
}

/** The live limits for a route, its transport, and the `accept` string a file input wants. */
export function useLimits(route: string, headers: HeadersProvider | undefined) {
  const headersRef = useRef<HeadersProvider | undefined>(headers);
  headersRef.current = headers;
  const routeRef = useRef(route);
  routeRef.current = route;

  const limitsRef = useRef<WireLimits | undefined>(cachedFacts(route)?.limits);
  const transportRef = useRef<'direct' | 'proxy' | undefined>(cachedFacts(route)?.transport);
  // State, not just the ref: a page that prints the size cap has to render again when it lands.
  const [limits, setLimits] = useState<WireLimits | undefined>(() => cachedFacts(route)?.limits);
  const [accept, setAccept] = useState(() => acceptOf(cachedFacts(route)?.limits));

  /** Resolves once the route has said what it is, so a file picked before the GET lands still waits. */
  const load = useCallback(async (): Promise<RouteFacts> => {
    const facts = await loadFacts(route, headersRef.current);
    if (routeRef.current === route) {
      limitsRef.current = facts.limits;
      transportRef.current = facts.transport;
    }
    return facts;
  }, [route]);

  useEffect(() => {
    let alive = true;
    const hit = cachedFacts(route);
    limitsRef.current = hit?.limits;
    transportRef.current = hit?.transport;
    setLimits(hit?.limits);
    setAccept(acceptOf(limitsRef.current));
    void load().then((facts) => {
      if (!alive) return;
      setLimits(facts.limits);
      setAccept(acceptOf(facts.limits));
    });
    return () => {
      alive = false;
    };
  }, [route, load]);

  return { limitsRef, transportRef, limits, accept, load };
}
