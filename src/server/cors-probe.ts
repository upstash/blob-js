/**
 * A browser upload PUTs straight to storage, so a bucket whose CORS list leaves out the page's origin
 * fails in the browser alone: the route answers 200, a curl against it succeeds, and the only trace
 * is a console error in a tab nobody is watching. The token the SDK holds cannot read the bucket's
 * CORS rules, but storage answers a preflight for anybody, so the handler sends the same preflight
 * the browser is about to send, against the url it just signed, and says so in the server log when
 * storage refuses it. Measured 2026-10-14: a signed url answers 204 with the origin for an allowed
 * one and 403 with no CORS headers for any other, 20 out of 20 times each.
 *
 * Diagnostic only: never awaited by the request, never thrown, and once per origin per process.
 */

/** Origins already probed. Bounded, since the Origin header is the client's to choose. */
const MAX_PROBED = 64;

export function corsProbe(): (request: Request, url: string, headers: Record<string, string> | undefined) => void {
  const probed = new Set<string>();
  return (request, url, headers) => {
    const origin = request.headers?.get?.('origin');
    if (!origin || !/^https?:\/\/[^/]+$/i.test(origin) || probed.has(origin) || probed.size >= MAX_PROBED) return;
    probed.add(origin);
    void preflight(origin, url, headers).then(
      (allowed) => {
        // Storage that could not be asked is asked again on the next upload from this origin.
        if (allowed === undefined) probed.delete(origin);
        else if (!allowed) console.warn(corsWarning(origin));
      },
      () => probed.delete(origin),
    );
  };
}

export function corsWarning(origin: string): string {
  return `[upstash-blob] storage refused the CORS preflight from ${origin}, so the browser upload will be blocked before any bytes are sent. Add ${origin} to the bucket's CORS origins in the Upstash Console (the bucket's CORS settings), or recreate the bucket without --cors to allow all origins.`;
}

/** true or false when storage answered the preflight; undefined when it could not be asked. */
async function preflight(origin: string, url: string, headers: Record<string, string> | undefined): Promise<boolean | undefined> {
  const names = Object.keys(headers ?? {}).map((h) => h.toLowerCase()).sort();
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'OPTIONS',
      headers: {
        origin,
        'access-control-request-method': 'PUT',
        ...(names.length ? { 'access-control-request-headers': names.join(',') } : {}),
      },
      signal: AbortSignal.timeout(5_000),
    });
  } catch {
    return undefined;
  }
  await res.body?.cancel().catch(() => {});
  // A 5xx or a rate limit is storage not answering the question, not a refusal.
  if (res.status >= 500 || res.status === 429) return undefined;
  const allowed = res.headers.get('access-control-allow-origin');
  return res.ok && (allowed === '*' || allowed === origin);
}
