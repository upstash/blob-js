import { useCallback, useEffect, useRef, useState } from 'react';
import { clock } from '../browser/clock.ts';
import { resolveHeaders, type HeadersProvider } from '../browser/task.ts';
import { BlobError } from '../shared/errors.ts';
import type { ServedConstraints, WireConstraintsResponse } from '../shared/types.ts';
import { formatBytes } from '../shared/units.ts';

/** The constraints a direct upload route serves from its GET endpoint. */
const CONSTRAINTS_TTL_MS = 60_000;
const cache = new Map<string, RouteFacts & { at: number }>();
const inFlight = new Map<string, Promise<RouteFacts>>();

export interface RouteFacts {
  constraints: ServedConstraints | undefined;
  /** Why the route could not be asked. Failed responses are not cached. */
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
    authored = await resolveHeaders(headers);
  } catch (e) {
    return { constraints: undefined, error: BlobError.is(e) ? e : new BlobError('request_failed', { message: e instanceof Error ? e.message : String(e), status: 400, cause: e }) };
  }
  let res: Response;
  try {
    res = await fetch(route, { headers: authored });
  } catch (e) {
    return { constraints: undefined, error: new BlobError('request_failed', { message: 'could not reach the route', status: 503, cause: e }) };
  }
  // Ordinary server-upload URLs commonly expose POST only. There are no route constraints to cache.
  if (res.status === 404 || res.status === 405) return remember(route, { constraints: undefined });
  if (!res.ok) {
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      body = undefined;
    }
    return { constraints: undefined, error: BlobError.fromJSON(body, res.status) ?? BlobError.fromStatus(res.status) };
  }
  let constraints: ServedConstraints | undefined;
  try {
    const body = (await res.json()) as WireConstraintsResponse | undefined;
    if (body?.constraints && typeof body.constraints === 'object') constraints = body.constraints;
  } catch {
    // Not a constraints document. The upload itself remains authoritative.
  }
  return remember(route, { constraints });
}

function remember(route: string, facts: RouteFacts): RouteFacts {
  cache.set(route, { ...facts, at: clock.now() });
  return facts;
}

export function acceptOf(constraints: ServedConstraints | undefined): string {
  return constraints?.contentTypes?.join(',') ?? '';
}

/** Size only. The server remains authoritative for type validation. */
export function deny(file: File, constraints: ServedConstraints | undefined): BlobError | undefined {
  if (constraints?.maxBytes !== undefined && file.size > constraints.maxBytes) {
    return new BlobError('too_large', { message: `${file.name} is ${formatBytes(file.size)}, over the ${formatBytes(constraints.maxBytes)} limit` });
  }
  return undefined;
}

export function useConstraints(route: string, headers: HeadersProvider | undefined) {
  const headersRef = useRef<HeadersProvider | undefined>(headers);
  headersRef.current = headers;
  const routeRef = useRef(route);
  routeRef.current = route;

  const constraintsRef = useRef<ServedConstraints | undefined>(cachedFacts(route)?.constraints);
  const [constraints, setConstraints] = useState<ServedConstraints | undefined>(() => cachedFacts(route)?.constraints);
  const [accept, setAccept] = useState(() => acceptOf(cachedFacts(route)?.constraints));

  const load = useCallback(async (): Promise<RouteFacts> => {
    const facts = await loadFacts(route, headersRef.current);
    if (routeRef.current === route) constraintsRef.current = facts.constraints;
    return facts;
  }, [route]);

  useEffect(() => {
    let alive = true;
    const hit = cachedFacts(route);
    constraintsRef.current = hit?.constraints;
    setConstraints(hit?.constraints);
    setAccept(acceptOf(hit?.constraints));
    void load().then((facts) => {
      if (!alive) return;
      setConstraints(facts.constraints);
      setAccept(acceptOf(facts.constraints));
    });
    return () => {
      alive = false;
    };
  }, [route, load]);

  return { constraintsRef, constraints, accept };
}
