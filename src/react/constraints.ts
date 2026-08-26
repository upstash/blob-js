import { useCallback, useEffect, useRef, useState } from 'react';
import { clock } from '../browser/clock.ts';
import { resolveHeaders, type HeadersProvider } from '../browser/task.ts';
import { BlobError } from '../shared/errors.ts';
import type { WireConstraints, WireConstraintsResponse } from '../shared/types.ts';
import { formatBytes } from '../shared/units.ts';

/**
 * What a route says it accepts, fetched from its own GET. Shared by both hooks so a proxied upload
 * and a direct one fill the file picker from the same source: whatever the route refuses.
 */

// The route serves its constraints with max-age=60. A cache that never expired outlived the deploy that
// changed them, so the picker went on refusing files the route had started accepting.
const CONSTRAINTS_TTL_MS = 60_000;
// A route with no GET half answers 404/405 forever. Caching that too is what keeps every mount of
// every component on a plain POST-only route from re-asking.
const cache = new Map<string, RouteFacts & { at: number }>();
const inFlight = new Map<string, Promise<RouteFacts>>();

/** What a route says about itself. `transport` decides which upload one hook runs for it. */
export interface RouteFacts {
  constraints: WireConstraints | undefined;
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
  if (clock.now() - entry.at > CONSTRAINTS_TTL_MS) {
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
    return { constraints: undefined, transport: undefined, error: BlobError.is(e) ? e : new BlobError('request_failed', { message: e instanceof Error ? e.message : String(e), status: 400, cause: e }) };
  }
  let res: Response;
  try {
    res = await fetch(route, { headers: authored });
  } catch (e) {
    return { constraints: undefined, transport: undefined, error: new BlobError('request_failed', { message: 'could not reach the route', status: 503, cause: e }) };
  }
  // A route with no GET half is one the SDK presigns against: a branded route from before the
  // proxy transport existed. Any other refusal is the route's own, and the upload carries it.
  if (res.status === 404 || res.status === 405) return remember(route, { constraints: undefined, transport: 'direct' });
  if (!res.ok) {
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      body = undefined;
    }
    return { constraints: undefined, transport: undefined, error: BlobError.fromJSON(body, res.status) ?? BlobError.fromStatus(res.status) };
  }
  let constraints: WireConstraints | undefined;
  let transport: 'direct' | 'proxy' = 'direct';
  try {
    const body = (await res.json()) as WireConstraintsResponse | undefined;
    if (body?.constraints && typeof body.constraints === 'object') constraints = body.constraints;
    if (body?.transport === 'proxy') transport = 'proxy';
  } catch {
    // Not the constraints document: a route that will not say what it allows still uploads.
  }
  return remember(route, { constraints, transport });
}

function remember(route: string, facts: RouteFacts): RouteFacts {
  cache.set(route, { ...facts, at: clock.now() });
  return facts;
}

export function acceptOf(constraints: WireConstraints | undefined): string {
  return constraints?.contentTypes?.join(',') ?? '';
}

/**
 * Size only. accept carries the types, and the route canonicalises aliases before comparing
 * (image/jpg is image/jpeg), so a type check against the served list refuses files it accepts.
 */
export function deny(file: File, constraints: WireConstraints | undefined): BlobError | undefined {
  if (constraints?.maxBytes !== undefined && file.size > constraints.maxBytes) {
    return new BlobError('too_large', { message: `${file.name} is ${formatBytes(file.size)}, over the ${formatBytes(constraints.maxBytes)} limit` });
  }
  return undefined;
}

/** The live constraints for a route, its transport, and the `accept` string a file input wants. */
export function useConstraints(route: string, headers: HeadersProvider | undefined) {
  const headersRef = useRef<HeadersProvider | undefined>(headers);
  headersRef.current = headers;
  const routeRef = useRef(route);
  routeRef.current = route;

  const constraintsRef = useRef<WireConstraints | undefined>(cachedFacts(route)?.constraints);
  const transportRef = useRef<'direct' | 'proxy' | undefined>(cachedFacts(route)?.transport);
  // State, not just the ref: a page that prints the size cap has to render again when it lands.
  const [constraints, setConstraints] = useState<WireConstraints | undefined>(() => cachedFacts(route)?.constraints);
  const [accept, setAccept] = useState(() => acceptOf(cachedFacts(route)?.constraints));

  /** Resolves once the route has said what it is, so a file picked before the GET lands still waits. */
  const load = useCallback(async (): Promise<RouteFacts> => {
    const facts = await loadFacts(route, headersRef.current);
    if (routeRef.current === route) {
      constraintsRef.current = facts.constraints;
      transportRef.current = facts.transport;
    }
    return facts;
  }, [route]);

  useEffect(() => {
    let alive = true;
    const hit = cachedFacts(route);
    constraintsRef.current = hit?.constraints;
    transportRef.current = hit?.transport;
    setConstraints(hit?.constraints);
    setAccept(acceptOf(constraintsRef.current));
    void load().then((facts) => {
      if (!alive) return;
      setConstraints(facts.constraints);
      setAccept(acceptOf(facts.constraints));
    });
    return () => {
      alive = false;
    };
  }, [route, load]);

  return { constraintsRef, transportRef, constraints, accept, load };
}
