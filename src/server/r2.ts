import { BlobError } from '../shared/errors.ts';
import type { BlobObject } from '../shared/types.ts';
import type { CacheOption } from '../shared/units.ts';
import { CredentialCache, type TempCredentials } from './credentials.ts';
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
  ) {
    this.creds = new CredentialCache(token, enableTelemetry);
    this.hostname = `${hashForDomain}.${DOMAIN_SUFFIX}`;
  }

  credentials(): Promise<TempCredentials> {
    return this.creds.get();
  }

  publicUrl(path: string): string {
    return `https://${this.hostname}/${encodeKey(path)}`;
  }

  blobObject(path: string, size: number, etag: string, uploadedAt: Date): BlobObject {
    const url = this.publicUrl(path);
    return { path, url, versionedUrl: `${url}?v=${encodeURIComponent(etag)}`, size, etag, uploadedAt };
  }

  async objectUrl(path?: string, query?: Record<string, string>): Promise<string> {
    const c = await this.creds.get();
    const url = new URL(`${c.endpoint}/${c.bucket}${path === undefined ? '' : '/' + encodeKey(path)}`);
    for (const [k, v] of Object.entries(query ?? {})) url.searchParams.set(k, v);
    return url.toString();
  }

  async fetch(init: R2RequestInit): Promise<Response> {
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
  async presign(init: { method: string; path: string; query?: Record<string, string>; expiresIn: number; signedHeaders?: Record<string, string> }): Promise<string> {
    const c = await this.creds.get();
    const remaining = Math.floor(c.expiresAt - Date.now() / 1000);
    const url = await this.objectUrl(init.path, init.query);
    return presign(
      { accessKeyId: c.accessKeyId, secretAccessKey: c.secretAccessKey, sessionToken: c.sessionToken, region: c.region },
      { method: init.method, url, expiresIn: Math.max(1, Math.min(init.expiresIn, remaining)), signedHeaders: init.signedHeaders },
    );
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
  if (status === 403) return new BlobError('signature_mismatch');
  if (status === 429 || code === 'SlowDown' || code === 'TooManyRequests') return new BlobError('rate_limited', { message: 'R2 rate limited the request' });
  if (status === 503) return new BlobError('not_ready');
  if (status === 413 || code === 'EntityTooLarge') return new BlobError('too_large');
  return new BlobError('request_failed', {
    message: `R2 responded ${status}${code ? ` ${code}` : ''}${message ? `: ${message}` : ''}`,
    status: status >= 500 ? 502 : status,
  });
}
