import { BlobError } from '../shared/errors.ts';
import { telemetryHeaders } from '../shared/telemetry.ts';
import { AGENT_URL } from './token.ts';

export interface TempCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
  endpoint: string;
  bucket: string;
  region: string;
  /** Unix seconds. */
  expiresAt: number;
}

// Must stay under the agent's 60 s re-mint margin: at or above it the agent hands back the same
// credential the SDK already considers stale, and every operation refetches until the limiter 429s.
const REFRESH_MARGIN_MS = 30_000;

export class CredentialCache {
  private current: TempCredentials | undefined;
  private refreshAt = 0;
  private inflight: Promise<TempCredentials> | undefined;

  constructor(private readonly token: string) {}

  get(): Promise<TempCredentials> {
    if (this.current && Date.now() < this.refreshAt) return Promise.resolve(this.current);
    this.inflight ??= this.mint().finally(() => {
      this.inflight = undefined;
    });
    return this.inflight;
  }

  private async mint(attempt = 0): Promise<TempCredentials> {
    const res = await fetch(`${AGENT_URL}/v1/credentials`, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.token}`, ...telemetryHeaders() },
    });

    if ((res.status === 429 || res.status === 503) && attempt < 3) {
      // Number(null) is 0, so a missing Retry-After would otherwise retry immediately, three times.
      const parsed = Number(res.headers.get('retry-after'));
      const wait = Math.min(Number.isFinite(parsed) && parsed > 0 ? parsed : 2, 10);
      await res.body?.cancel();
      await new Promise((r) => setTimeout(r, wait * 1000));
      return this.mint(attempt + 1);
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

    this.refreshAt = Math.max(Date.now(), creds.expiresAt * 1000 - REFRESH_MARGIN_MS);
    this.current = creds;
    return creds;
  }
}
