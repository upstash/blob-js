import { BlobError } from '../shared/errors.ts';
import { telemetryHeaders } from '../shared/telemetry.ts';
import { AGENT_URL } from './token.ts';

/** A credential the agent may hand back purely for presigning reads; longer-lived than the object one. */
export interface SigningCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  /** Unix seconds. */
  expiresAt: number;
}

export interface TempCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
  endpoint: string;
  bucket: string;
  region: string;
  /** Unix seconds. */
  expiresAt: number;
  /** 'private' means the bucket has no public host, so a BlobObject carries no url. */
  visibility?: 'public' | 'private';
  /** Present only once the backend ships a long-lived read-signing credential. */
  signing?: SigningCredentials;
  /** Seconds between this credential being minted and expiring: the cap on a presigned read. */
  lifetime: number;
}

// Must stay under the agent's 60 s re-mint margin: at or above it the agent hands back the same
// credential the SDK already considers stale, and every operation refetches until the limiter 429s.
const REFRESH_MARGIN_MS = 30_000;
const MINT_TIMEOUT_MS = 10_000;
// A Retry-After longer than this is the agent asking for a pause no request can wait out: the caller
// is told to come back rather than blocked for the whole of it.
const MAX_MINT_WAIT_S = 10;

export class CredentialCache {
  private current: TempCredentials | undefined;
  private refreshAt = 0;
  private inflight: Promise<TempCredentials> | undefined;

  constructor(
    private readonly token: string,
    private readonly enableTelemetry = true,
  ) {}

  /**
   * @param minRemainingSeconds re-mint when the cached credential has less life left than this, so a
   * presigned url gets the lifetime it asked for rather than whatever happened to be left.
   */
  get(minRemainingSeconds = 0): Promise<TempCredentials> {
    if (this.current && Date.now() < this.refreshAt && this.remaining() >= minRemainingSeconds) return Promise.resolve(this.current);
    this.inflight ??= this.mint().finally(() => {
      this.inflight = undefined;
    });
    return this.inflight;
  }

  /** The cached credential, without minting one. Undefined before the first mint. */
  peek(): TempCredentials | undefined {
    return this.current;
  }

  /** After a 403 that named the credential itself: the next get() mints. */
  invalidate(): void {
    this.current = undefined;
    this.refreshAt = 0;
  }

  private remaining(): number {
    return this.current ? this.current.expiresAt - Date.now() / 1000 : 0;
  }

  private async mint(attempt = 0): Promise<TempCredentials> {
    const res = await fetch(`${AGENT_URL}/v1/credentials`, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.token}`, ...(this.enableTelemetry ? telemetryHeaders() : {}) },
      signal: AbortSignal.timeout(MINT_TIMEOUT_MS),
    });

    if (res.status === 429 || res.status === 503) {
      // Number(null) is 0, so a missing Retry-After would otherwise retry immediately, three times.
      const parsed = Number(res.headers.get('retry-after'));
      const asked = Number.isFinite(parsed) && parsed > 0 ? parsed : 2;
      await res.body?.cancel();
      if (asked > MAX_MINT_WAIT_S) {
        throw new BlobError('mint_backoff', { message: `the credential service asked for ${asked}s of backoff`, retryAfter: asked });
      }
      if (attempt < 3) {
        await new Promise((r) => setTimeout(r, asked * 1000));
        return this.mint(attempt + 1);
      }
    }

    if (res.status === 401) throw new BlobError('unauthorized', { message: 'the bucket token was rejected' });
    if (res.status === 429) throw new BlobError('rate_limited', { message: 'credential requests are rate limited' });
    if (res.status === 503) throw new BlobError('not_ready');
    if (!res.ok) throw new BlobError('request_failed', { message: `credentials request failed with ${res.status}`, status: 502 });

    const creds = (await res.json()) as TempCredentials;

    // The endpoint decides where every object request goes; refuse anything but R2 over https.
    let host: URL | undefined;
    try {
      host = new URL(creds.endpoint);
    } catch {
      host = undefined;
    }
    if (!host || host.protocol !== 'https:' || !host.hostname.endsWith('.r2.cloudflarestorage.com')) {
      throw new BlobError('request_failed', { message: 'credentials response named an unexpected endpoint', status: 502 });
    }

    creds.lifetime = Math.max(1, Math.ceil(creds.expiresAt - Date.now() / 1000));
    if (!validSigning(creds.signing)) delete creds.signing;
    if (creds.visibility !== 'public' && creds.visibility !== 'private') delete creds.visibility;
    this.refreshAt = Math.max(Date.now(), creds.expiresAt * 1000 - REFRESH_MARGIN_MS);
    this.current = creds;
    return creds;
  }
}

function validSigning(s: SigningCredentials | undefined): boolean {
  return !!s && typeof s.accessKeyId === 'string' && typeof s.secretAccessKey === 'string' && typeof s.expiresAt === 'number' && Number.isFinite(s.expiresAt);
}

// Keyed by token rather than held per Bucket: `Bucket.fromEnv()` per request is the documented shape
// on every serverless platform, and an instance-held cache minted a credential for each one.
const caches = new Map<string, CredentialCache>();

export function credentialCacheFor(token: string, enableTelemetry: boolean): CredentialCache {
  const key = `${enableTelemetry ? '1' : '0'} ${token}`;
  let cache = caches.get(key);
  if (!cache) {
    cache = new CredentialCache(token, enableTelemetry);
    caches.set(key, cache);
  }
  return cache;
}

/** Tests only. */
export function resetCredentialCaches(): void {
  caches.clear();
}
