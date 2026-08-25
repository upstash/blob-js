import { BlobError } from '../shared/errors.ts';
import type { BlobObject } from '../shared/types.ts';
import type { CacheOption } from '../shared/units.ts';
import { credentialCacheFor, type CredentialCache, type TempCredentials } from './credentials.ts';
import { blocks, decodeEntities, encodeKey, escapeXml, tag } from './keys.ts';
import { presign, signHeaders } from './sigv4.ts';
import { DOMAIN_SUFFIX } from './token.ts';

export interface R2RequestInit {
  method: string;
  path?: string;
  query?: Record<string, string>;
  headers?: Record<string, string>;
  body?: BodyInit | null;
  signal?: AbortSignal;
}

export interface ObjectHead {
  size: number;
  etag: string;
  contentType: string;
  metadata: Record<string, string>;
  uploadedAt: Date;
}

export interface MultipartUpload {
  path: string;
  uploadId: string;
  initiatedAt: Date;
}

export interface PresignedRead {
  url: string;
  /** When the link stops working: the signature's own expiry, or the credential's, whichever is first. */
  expiresAt: Date;
}

const RETRIABLE_METHODS = new Set(['GET', 'HEAD', 'PUT', 'DELETE']);
const RETRY_ATTEMPTS = 3;
// R2 answers a temporary credential that has expired with a 403 naming it, which is indistinguishable
// from a signature error unless the body is read.
const CREDENTIAL_REJECTED = /ExpiredToken|InvalidAccessKeyId|TokenRefreshRequired/;
// What a read link is signed for when the caller does not say. Shorter than the cap on purpose: an
// ask at the cap re-mints, and the cap moves with whatever the agent had left.
const DEFAULT_READ_SECONDS = 300;
// A credential this much older than it was minted might be replaced by a newer one; a fresher one
// would only come back identical.
const WORTH_REMINTING_S = 30;

export class R2 {
  private readonly creds: CredentialCache;
  private readonly hostname: string;

  constructor(
    readonly bucketId: string,
    token: string,
    /** The bucket's public DNS label, carried in the token. */
    hashForDomain: string,
    /** The bucket password: the HMAC key for completion tokens. Never leaves the server. */
    readonly signingSecret: string,
    readonly defaultCache: CacheOption | undefined,
    enableTelemetry = true,
    /** What the caller declared; a `visibility` in the credentials response wins over it. */
    private readonly declaredVisibility?: 'public' | 'private',
  ) {
    this.creds = credentialCacheFor(token, enableTelemetry);
    this.hostname = `${hashForDomain}.${DOMAIN_SUFFIX}`;
  }

  credentials(): Promise<TempCredentials> {
    return this.creds.get();
  }

  /** Undefined on a private bucket: nothing serves its objects over the public host. */
  publicUrl(path: string): string | undefined {
    if ((this.creds.peek()?.visibility ?? this.declaredVisibility) === 'private') return undefined;
    return `https://${this.hostname}/${encodeKey(path)}`;
  }

  blobObject(path: string, size: number, etag: string, uploadedAt: Date): BlobObject {
    const url = this.publicUrl(path);
    if (url === undefined) return { path, size, etag, uploadedAt };
    return { path, url, versionedUrl: `${url}?v=${encodeURIComponent(etag)}`, size, etag, uploadedAt };
  }

  async objectUrl(path?: string, query?: Record<string, string>): Promise<string> {
    const c = await this.creds.get();
    const url = new URL(`${c.endpoint}/${c.bucket}${path === undefined ? '' : '/' + encodeKey(path)}`);
    for (const [k, v] of Object.entries(query ?? {})) url.searchParams.set(k, v);
    return url.toString();
  }

  /**
   * A 5xx, a 429 and a dropped connection are retried for the verbs that can be sent twice safely;
   * multipart complete and the batch delete are POSTs and are not among them. A streamed body is
   * never retried either: it has already been read once.
   */
  async fetch(init: R2RequestInit): Promise<Response> {
    const streaming = init.body instanceof ReadableStream;
    const attempts = !streaming && RETRIABLE_METHODS.has(init.method.toUpperCase()) ? RETRY_ATTEMPTS : 1;
    let refreshed = false;
    for (let attempt = 1; ; attempt++) {
      let res: Response;
      try {
        res = await this.send(init);
      } catch (e) {
        // A BlobError here came from minting a credential, which has its own retry policy and its
        // own verdict; only a dropped connection is this loop's to retry.
        if (BlobError.is(e) || attempt >= attempts || init.signal?.aborted) throw e;
        await sleep(backoff(attempt, null));
        continue;
      }
      if (res.status === 403 && !refreshed && !streaming) {
        // A HEAD carries no body to name the reason, so a credential that has visibly run out counts
        // as the same finding: re-mint once and ask again.
        const outlived = (this.creds.peek()?.expiresAt ?? Infinity) * 1000 <= Date.now();
        const text = res.body ? await res.text() : '';
        if (outlived || CREDENTIAL_REJECTED.test(text)) {
          refreshed = true;
          this.creds.invalidate();
          continue;
        }
        return new Response(text, { status: res.status, statusText: res.statusText, headers: { 'content-type': res.headers.get('content-type') ?? 'application/xml' } });
      }
      if (attempt < attempts && (res.status === 429 || res.status >= 500) && !init.signal?.aborted) {
        await res.body?.cancel();
        await sleep(backoff(attempt, res.headers.get('retry-after')));
        continue;
      }
      return res;
    }
  }

  private async send(init: R2RequestInit): Promise<Response> {
    const c = await this.creds.get();
    const url = await this.objectUrl(init.path, init.query);
    const headers = await signHeaders(
      { accessKeyId: c.accessKeyId, secretAccessKey: c.secretAccessKey, sessionToken: c.sessionToken, region: c.region },
      { method: init.method, url, headers: init.headers },
    );
    const body = init.body ?? undefined;
    const extra: RequestInit & { duplex?: 'half' } = {};
    if (body instanceof ReadableStream) extra.duplex = 'half';
    return fetch(url, { method: init.method, headers, body, signal: init.signal, ...extra });
  }

  /** Query-signed URL. Lives min(expiresIn, credential remaining life): R2 checks the credential at request start. */
  async presign(init: {
    method: string;
    path: string;
    query?: Record<string, string>;
    expiresIn: number;
    signedHeaders?: Record<string, string>;
    /** Mint a fresh credential when less than this is left, so the url is usable for that long. */
    minRemainingSeconds?: number;
  }): Promise<string> {
    const c = await this.creds.get(init.minRemainingSeconds ?? 0);
    const remaining = Math.floor(c.expiresAt - Date.now() / 1000);
    const url = await this.objectUrl(init.path, init.query);
    return presign(
      { accessKeyId: c.accessKeyId, secretAccessKey: c.secretAccessKey, sessionToken: c.sessionToken, region: c.region },
      { method: init.method, url, expiresIn: Math.max(1, Math.min(init.expiresIn, remaining)), signedHeaders: init.signedHeaders },
    );
  }

  /**
   * A read link that lives as long as it says it does. The cap is what the signing credential has
   * left, which moves: the agent serves one credential until it is nearly out, so a fresh mint can
   * come back with anything from a minute to ten. Omitting `expiresIn` asks for the shorter of five
   * minutes and the cap and therefore never throws; naming one that is over the cap does, unless
   * `clamp`. `signing` in the credentials response, when the backend ships one, raises the cap and
   * removes the re-mint entirely.
   */
  async presignRead(init: { path: string; query?: Record<string, string>; expiresIn?: number; clamp?: boolean }): Promise<PresignedRead> {
    let c = await this.creds.get();
    let cap = capOf(c);
    let seconds = init.expiresIn === undefined ? Math.min(cap, DEFAULT_READ_SECONDS) : Math.max(1, Math.floor(init.expiresIn));
    if (seconds > cap && worthReminting(c)) {
      c = await this.creds.get(seconds);
      cap = capOf(c);
    }
    if (seconds > cap) {
      if (!init.clamp) {
        throw new BlobError('invalid_input', {
          message: `expiresIn: ${seconds}s is over the ${cap}s this credential can sign for`,
          hint: 'pass { clamp: true } to take the cap instead, and read expiresAt for what you got',
        });
      }
      seconds = cap;
    }
    const signer = c.signing ?? c;
    const url = await this.objectUrl(init.path, init.query);
    const signed = await presign(
      { accessKeyId: signer.accessKeyId, secretAccessKey: signer.secretAccessKey, sessionToken: signer.sessionToken, region: c.region },
      { method: 'GET', url, expiresIn: seconds },
    );
    return { url: signed, expiresAt: new Date(Math.min(Date.now() + seconds * 1000, signer.expiresAt * 1000)) };
  }

  /** The cap a presigned read can ask for right now, in seconds. */
  async readCap(): Promise<number> {
    return capOf(await this.creds.get());
  }

  async head(path: string): Promise<ObjectHead | undefined> {
    const res = await this.fetch({ method: 'HEAD', path });
    await res.body?.cancel();
    if (res.status === 404) return undefined;
    if (!res.ok) throw await errorFromResponse(res);
    return headFromHeaders(res.headers);
  }

  async createMultipart(path: string, headers: Record<string, string>): Promise<string> {
    const res = await this.fetch({ method: 'POST', path, query: { uploads: '' }, headers });
    const xml = await res.text();
    if (!res.ok) throw errorFromBody(res.status, xml);
    const id = tag(xml, 'UploadId');
    if (!id) throw new BlobError('request_failed', { message: 'CreateMultipartUpload returned no upload id', status: 502 });
    return decodeEntities(id);
  }

  async listParts(path: string, uploadId: string): Promise<{ n: number; etag: string; size: number }[]> {
    const out: { n: number; etag: string; size: number }[] = [];
    let marker: string | undefined;
    for (;;) {
      const query: Record<string, string> = { uploadId, 'max-parts': '1000' };
      if (marker) query['part-number-marker'] = marker;
      const res = await this.fetch({ method: 'GET', path, query });
      const xml = await res.text();
      if (!res.ok) throw errorFromBody(res.status, xml);
      for (const b of blocks(xml, 'Part')) {
        out.push({ n: Number(tag(b, 'PartNumber')), etag: decodeEntities(tag(b, 'ETag') ?? ''), size: Number(tag(b, 'Size') ?? 0) });
      }
      if (tag(xml, 'IsTruncated') !== 'true') break;
      marker = tag(xml, 'NextPartNumberMarker');
      if (!marker) break;
    }
    return out;
  }

  /** Every multipart upload started and neither completed nor aborted. Nothing else can see them. */
  async listMultipartUploads(prefix?: string): Promise<MultipartUpload[]> {
    const out: MultipartUpload[] = [];
    let keyMarker: string | undefined;
    let idMarker: string | undefined;
    for (;;) {
      const query: Record<string, string> = { uploads: '', 'max-uploads': '1000' };
      if (prefix) query.prefix = prefix;
      if (keyMarker) query['key-marker'] = keyMarker;
      if (idMarker) query['upload-id-marker'] = idMarker;
      const res = await this.fetch({ method: 'GET', query });
      const xml = await res.text();
      if (!res.ok) throw errorFromBody(res.status, xml);
      for (const b of blocks(xml, 'Upload')) {
        const key = tag(b, 'Key');
        const id = tag(b, 'UploadId');
        if (key === undefined || id === undefined) continue;
        out.push({ path: decodeEntities(key), uploadId: decodeEntities(id), initiatedAt: new Date(tag(b, 'Initiated') ?? 0) });
      }
      if (tag(xml, 'IsTruncated') !== 'true') break;
      const nextKey = tag(xml, 'NextKeyMarker');
      const nextId = tag(xml, 'NextUploadIdMarker');
      // The markers are sent back verbatim, so a key carrying &, < or > has to be decoded first or
      // the next page repeats this one forever.
      keyMarker = nextKey === undefined ? undefined : decodeEntities(nextKey);
      idMarker = nextId === undefined ? undefined : decodeEntities(nextId);
      if (!keyMarker) break;
    }
    return out;
  }

  async completeMultipart(path: string, uploadId: string, parts: { n: number; etag: string }[], headers: Record<string, string> = {}): Promise<string> {
    const body =
      '<CompleteMultipartUpload>' +
      [...parts]
        .sort((a, b) => a.n - b.n)
        .map((p) => `<Part><PartNumber>${p.n}</PartNumber><ETag>${escapeXml(p.etag)}</ETag></Part>`)
        .join('') +
      '</CompleteMultipartUpload>';
    const res = await this.fetch({ method: 'POST', path, query: { uploadId }, headers: { 'content-type': 'application/xml', ...headers }, body });
    const xml = await res.text();
    if (!res.ok) throw errorFromBody(res.status, xml);
    // A 200 can still carry an error document.
    const code = tag(xml, 'Code');
    if (code) throw errorFromBody(500, xml);
    return decodeEntities(tag(xml, 'ETag') ?? '');
  }

  async abortMultipart(path: string, uploadId: string): Promise<void> {
    const res = await this.fetch({ method: 'DELETE', path, query: { uploadId } });
    await res.body?.cancel();
    if (!res.ok && res.status !== 404) throw await errorFromResponse(res);
  }
}

/** What the credential that will sign has left: no link can outlive it, whatever was asked for. */
function capOf(c: TempCredentials): number {
  return Math.max(1, Math.floor((c.signing ? c.signing.expiresAt : c.expiresAt) - Date.now() / 1000));
}

function worthReminting(c: TempCredentials): boolean {
  return !c.signing && capOf(c) < c.lifetime - WORTH_REMINTING_S;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function backoff(attempt: number, retryAfter: string | null): number {
  if (retryAfter) {
    const secs = Number(retryAfter);
    if (Number.isFinite(secs) && secs >= 0) return Math.min(secs * 1000, 10_000);
  }
  return Math.floor(Math.random() * Math.min(4_000, 200 * 2 ** attempt));
}

export function headFromHeaders(h: Headers): ObjectHead {
  const metadata: Record<string, string> = {};
  h.forEach((v, k) => {
    if (k.startsWith('x-amz-meta-')) metadata[k.slice(11)] = v;
  });
  const lm = h.get('last-modified');
  return {
    size: Number(h.get('content-length') ?? 0),
    etag: h.get('etag') ?? '',
    contentType: h.get('content-type') ?? 'application/octet-stream',
    metadata,
    uploadedAt: lm ? new Date(lm) : new Date(),
  };
}

export async function errorFromResponse(res: Response): Promise<BlobError> {
  const text = await res.text().catch(() => '');
  return errorFromBody(res.status, text);
}

export function errorFromBody(status: number, xml: string): BlobError {
  const code = tag(xml, 'Code');
  const message = tag(xml, 'Message');
  if (status === 404 || code === 'NoSuchKey' || code === 'NoSuchUpload') return new BlobError('not_found');
  if (status === 412 || code === 'PreconditionFailed') return new BlobError('conflict');
  if (status === 401) return new BlobError('unauthorized');
  if (status === 403 && code && CREDENTIAL_REJECTED.test(code)) {
    return new BlobError('unauthorized', { message: 'storage refused the temporary credential', hint: 'it expired mid-request; the SDK re-mints and retries once' });
  }
  if (status === 403) return new BlobError('signature_mismatch');
  if (status === 429 || code === 'SlowDown' || code === 'TooManyRequests') return new BlobError('rate_limited', { message: 'R2 rate limited the request' });
  if (status === 503) return new BlobError('not_ready');
  if (status === 413 || code === 'EntityTooLarge') return new BlobError('too_large');
  return new BlobError('request_failed', {
    message: `R2 responded ${status}${code ? ` ${code}` : ''}${message ? `: ${message}` : ''}`,
    status: status >= 500 ? 502 : status,
  });
}
