import { VERSION } from '../version.ts';

/** The subset of globalThis this module sniffs. Passed in so tests can fake a runtime. */
export interface TelemetryGlobals {
  Deno?: { version?: { deno?: string } };
  Bun?: { version?: string };
  EdgeRuntime?: string;
  process?: { versions?: { node?: string }; env?: Record<string, string | undefined> };
  navigator?: { userAgent?: string };
}

// Order matters. Bun, Deno, workerd with nodejs_compat, and the Next.js edge sandbox all expose
// process.versions.node, so every more specific runtime has to be ruled out before that check.
function runtime(g: TelemetryGlobals): string | undefined {
  if (g.Deno?.version?.deno) return `deno@${g.Deno.version.deno}`;
  if (g.Bun?.version) return `bun@${g.Bun.version}`;
  if (g.navigator?.userAgent === 'Cloudflare-Workers') return 'cloudflare-workers';
  if (g.EdgeRuntime) return 'edge-light';
  if (g.process?.versions?.node) return `node@${g.process.versions.node}`;
  return g.navigator?.userAgent ? 'browser' : undefined;
}

function platform(g: TelemetryGlobals): string | undefined {
  // Before the env checks: workerd populates process.env from bindings, so a worker with an
  // AWS_REGION var would otherwise report aws.
  if (g.navigator?.userAgent === 'Cloudflare-Workers') return 'cloudflare';
  if (g.process?.env?.VERCEL) return 'vercel';
  if (g.process?.env?.AWS_REGION) return 'aws';
  return undefined;
}

/**
 * Sent only on calls to the Upstash agent, not on object requests: it is one request per credential
 * lifetime, so it costs nothing there, while the object path is the hot path.
 * Opt out with UPSTASH_DISABLE_TELEMETRY (only reachable where process.env exists).
 */
export function telemetryHeaders(g: TelemetryGlobals = globalThis as TelemetryGlobals): Record<string, string> {
  if (g.process?.env?.UPSTASH_DISABLE_TELEMETRY) return {};
  const out: Record<string, string> = { 'Upstash-Telemetry-Sdk': `upstash-blob-js@${VERSION}` };
  const r = runtime(g);
  if (r) out['Upstash-Telemetry-Runtime'] = r;
  const p = platform(g);
  if (p) out['Upstash-Telemetry-Platform'] = p;
  return out;
}
