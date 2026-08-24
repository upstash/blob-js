import { BlobError } from '../shared/errors.ts';
import type { BlobObject } from '../shared/types.ts';
import { cacheControl, parseDuration, parseSize, type CacheOption, type Duration, type Size } from '../shared/units.ts';
import { limit, peek, readAll, resolveBody, type PutBody } from './body.ts';
import { blocks, decodeEntities, encodeKey, escapeXml, tag } from './keys.ts';
import { errorFromBody, errorFromResponse, headFromHeaders, R2 } from './r2.ts';
import { checkContentType, expandContentTypes } from './sniff.ts';
import { decodeToken } from './token.ts';

export interface BucketOptions {
  token: string;
  /** Default cache policy for every write; per-call `cache` overrides it. */
  cache?: CacheOption;
  /**
   * Send the SDK version, runtime and platform as headers on credential requests to Upstash.
   * `UPSTASH_DISABLE_TELEMETRY` in the environment also turns it off.
   * @default true
   */
  enableTelemetry?: boolean;
}

export interface PutOptions {
  contentType?: string;
  allowedContentTypes?: string[];
  maxBytes?: Size;
  cache?: CacheOption;
  metadata?: Record<string, string>;
  /** For a bare stream whose length the SDK cannot see. */
  size?: number;
  /** false: If-None-Match: * server-side, so a real 412 rather than a client-side race. */
  overwrite?: boolean;
  /** An etag: If-Match, so the write fails with 'conflict' if the object changed. */
  ifUnchanged?: string;
}

export interface ListOptions {
  prefix?: string;
  limit?: number;
  cursor?: string;
}

export interface ListPage {
  blobs: BlobObject[];
  cursor: string | undefined;
}

export interface BlobInfo extends BlobObject {
  contentType: string;
  metadata: Record<string, string>;
}

export interface BlobBody extends BlobInfo {
  body: ReadableStream<Uint8Array>;
}

export interface SignedReadUrlOptions {
  expiresIn?: Duration;
  downloadName?: string;
}

export interface S3Config {
  endpoint: () => Promise<{ url: URL }>;
  region: string;
  bucket: string;
  credentials: () => Promise<{ accessKeyId: string; secretAccessKey: string; sessionToken: string; expiration: Date }>;
}

export interface UpdateOptions {
  cache?: CacheOption;
  metadata?: Record<string, string>;
}

const INTERNALS = new WeakMap<Bucket, R2>();

/** Not exported from the package: handleUpload's access to the signing core. */
export function r2Of(bucket: Bucket): R2 {
  const r2 = INTERNALS.get(bucket);
  if (!r2) throw new TypeError('expected a Bucket');
  return r2;
}

export class Bucket {
  private readonly r2: R2;
  private readonly defaultCache: CacheOption | undefined;

  constructor(options: BucketOptions) {
    if (typeof options?.token !== 'string' || !options.token) throw new TypeError('new Bucket({ token }): token is required');
    const decoded = decodeToken(options.token);
    this.defaultCache = options.cache;
    this.r2 = new R2(decoded.bucketId, options.token, decoded.password, options.cache, options.enableTelemetry ?? true);
    INTERNALS.set(this, this.r2);
  }

  static fromEnv(name = 'UPSTASH_BLOB_TOKEN'): Bucket {
    const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;
    const token = env?.[name];
    if (!token) throw new TypeError(`Bucket.fromEnv: ${name} is not set (on Workers, pass it explicitly: new Bucket({ token: env.${name} }))`);
    return new Bucket({ token });
  }

  /* ------------------------------------------------------------------ put */

  async put(path: string, body: PutBody, options: PutOptions = {}): Promise<BlobObject> {
    encodeKey(path);
    const allowed = options.allowedContentTypes === undefined ? undefined : expandContentTypes(options.allowedContentTypes);
    const maxBytes = options.maxBytes === undefined ? undefined : parseSize(options.maxBytes, 'maxBytes');

    const resolved = resolveBody(body);
    let { stream, size } = resolved;
    const contentType = options.contentType ?? resolved.contentType ?? 'application/octet-stream';

    if (size === undefined && options.size !== undefined) size = parseSize(options.size, 'size');
    if (maxBytes !== undefined && size !== undefined && size > maxBytes) {
      throw new BlobError('too_large', { message: `body is ${size} bytes, over maxBytes (${maxBytes})` });
    }
    if (size === undefined) {
      if (maxBytes === undefined) throw new BlobError('length_required');
      const bytes = await readAll(stream, maxBytes);
      size = bytes.byteLength;
      stream = new Blob([bytes as BlobPart]).stream() as ReadableStream<Uint8Array>;
    }

    if (allowed) {
      const peeked = await peek(stream);
      checkContentType(contentType, peeked.head, allowed);
      stream = peeked.stream;
    }

    if (maxBytes !== undefined) stream = limit(stream, maxBytes);
    // A zero-length body goes out as bytes, so the peeked stream has to be released rather than left open.
    if (size === 0) await stream.cancel();

    const headers: Record<string, string> = {
      'content-type': contentType,
      'content-length': String(size),
      'cache-control': cacheControl(options.cache ?? this.defaultCache),
      ...metaHeaders(options.metadata),
    };
    if (options.overwrite === false) headers['if-none-match'] = '*';
    if (options.ifUnchanged !== undefined) headers['if-match'] = options.ifUnchanged;

    let res: Response;
    try {
      res = await this.r2.fetch({ method: 'PUT', path, headers, body: size === 0 ? new Uint8Array() : stream });
    } catch (e) {
      if (BlobError.is(e)) throw e;
      if (e && typeof e === 'object' && BlobError.is((e as { cause?: unknown }).cause)) throw (e as { cause: BlobError }).cause;
      throw e;
    }
    if (res.status === 412) {
      await res.body?.cancel();
      if (options.overwrite === false) {
        const head = await this.r2.head(path);
        throw new BlobError('already_exists', { message: `${path} already exists`, etag: head?.etag, size: head?.size });
      }
      throw new BlobError('conflict');
    }
    if (!res.ok) throw await errorFromResponse(res);
    await res.body?.cancel();
    return this.r2.blobObject(path, size, res.headers.get('etag') ?? '', new Date());
  }

  /* ----------------------------------------------------------------- read */

  async get(path: string): Promise<BlobBody> {
    const res = await this.r2.fetch({ method: 'GET', path });
    if (!res.ok) throw await errorFromResponse(res);
    const head = headFromHeaders(res.headers);
    const blob = await this.r2.blobObject(path, head.size, head.etag, head.uploadedAt);
    return { ...blob, contentType: head.contentType, metadata: head.metadata, body: res.body ?? new Blob([]).stream() };
  }

  async info(path: string): Promise<BlobInfo> {
    const head = await this.r2.head(path);
    if (!head) throw new BlobError('not_found', { message: `${path} not found` });
    const blob = await this.r2.blobObject(path, head.size, head.etag, head.uploadedAt);
    return { ...blob, contentType: head.contentType, metadata: head.metadata };
  }

  async exists(path: string): Promise<boolean> {
    return (await this.r2.head(path)) !== undefined;
  }

  async list(options: ListOptions = {}): Promise<ListPage> {
    const query: Record<string, string> = { 'list-type': '2' };
    if (options.prefix) query.prefix = options.prefix;
    if (options.limit !== undefined) query['max-keys'] = String(Math.min(Math.max(Math.floor(options.limit), 1), 1000));
    if (options.cursor) query['continuation-token'] = options.cursor;
    const res = await this.r2.fetch({ method: 'GET', query });
    const xml = await res.text();
    if (!res.ok) throw errorFromBody(res.status, xml);
    const blobs: BlobObject[] = [];
    for (const b of blocks(xml, 'Contents')) {
      const key = tag(b, 'Key');
      if (key === undefined) continue;
      const etag = decodeEntities(tag(b, 'ETag') ?? '');
      blobs.push(await this.r2.blobObject(decodeEntities(key), Number(tag(b, 'Size') ?? 0), etag, new Date(tag(b, 'LastModified') ?? 0)));
    }
    const next = tag(xml, 'NextContinuationToken');
    return { blobs, cursor: tag(xml, 'IsTruncated') === 'true' && next ? decodeEntities(next) : undefined };
  }

  async signedReadUrl(path: string, options: SignedReadUrlOptions = {}): Promise<string> {
    const expiresIn = Math.max(1, Math.floor(parseDuration(options.expiresIn ?? '1h', 'expiresIn') / 1000));
    const query: Record<string, string> = {};
    if (options.downloadName !== undefined) {
      const ascii = options.downloadName.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
      query['response-content-disposition'] = `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(options.downloadName)}`;
    }
    return this.r2.presign({ method: 'GET', path, query, expiresIn });
  }

  /* ---------------------------------------------------------------- write */

  async del(target: string | string[] | { prefix: string }): Promise<void> {
    if (typeof target === 'string') {
      const res = await this.r2.fetch({ method: 'DELETE', path: target });
      await res.body?.cancel();
      if (!res.ok && res.status !== 404) throw await errorFromResponse(res);
      return;
    }
    if (Array.isArray(target)) {
      const failed: string[] = [];
      for (let i = 0; i < target.length; i += 1000) failed.push(...(await this.deleteBatch(target.slice(i, i + 1000))));
      if (failed.length) throw new BlobError('partial_delete', { message: `${failed.length} of ${target.length} paths were not deleted`, failed });
      return;
    }
    const failed: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.list({ prefix: target.prefix, limit: 1000, cursor });
      if (page.blobs.length) failed.push(...(await this.deleteBatch(page.blobs.map((b) => b.path))));
      cursor = page.cursor;
    } while (cursor);
    if (failed.length) throw new BlobError('partial_delete', { message: `${failed.length} paths under ${target.prefix} were not deleted`, failed });
  }

  private async deleteBatch(paths: string[]): Promise<string[]> {
    if (paths.length === 0) return [];
    for (const p of paths) encodeKey(p);
    const body = `<Delete>${paths.map((p) => `<Object><Key>${escapeXml(p)}</Key></Object>`).join('')}</Delete>`;
    const res = await this.r2.fetch({ method: 'POST', query: { delete: '' }, headers: { 'content-type': 'application/xml' }, body });
    const xml = await res.text();
    if (!res.ok) throw errorFromBody(res.status, xml);
    const failed = blocks(xml, 'Error')
      .map((b) => tag(b, 'Key'))
      .filter((k): k is string => k !== undefined)
      .map(decodeEntities);
    // S3 answers 200 with errors inside; a survivor is the truth, so ask again rather than trust the list.
    const survivors: string[] = [];
    for (const p of failed) if (await this.exists(p)) survivors.push(p);
    return survivors;
  }

  async copy(from: string, to: string): Promise<BlobObject> {
    const creds = await this.r2.credentials();
    const res = await this.r2.fetch({ method: 'PUT', path: to, headers: { 'x-amz-copy-source': `/${creds.bucket}/${encodeKey(from)}` } });
    const xml = await res.text();
    if (!res.ok) throw errorFromBody(res.status, xml);
    const code = tag(xml, 'Code');
    if (code) throw errorFromBody(500, xml);
    const head = await this.r2.head(to);
    if (!head) throw new BlobError('not_found', { message: `${to} was not found after copy` });
    return this.r2.blobObject(to, head.size, head.etag, head.uploadedAt);
  }

  async move(from: string, to: string): Promise<BlobObject> {
    const blob = await this.copy(from, to);
    try {
      await this.del(from);
    } catch (e) {
      throw new BlobError('move_left_a_copy', { message: `moved ${from} to ${to} but could not delete the source`, cause: e });
    }
    return blob;
  }

  /** Read-modify-write over a JSON document; retried on 'conflict' up to 5 times. Existing metadata is kept unless options.metadata is given. */
  async update<T = unknown>(path: string, fn: (prev: T | null) => T | Promise<T>, options: UpdateOptions = {}): Promise<BlobObject> {
    let lastError: BlobError | undefined;
    for (let attempt = 0; attempt < 6; attempt++) {
      let prev: T | null = null;
      let etag: string | undefined;
      let metadata: Record<string, string> | undefined;
      try {
        const res = await this.get(path);
        const text = await new Response(res.body).text();
        prev = text.length ? (JSON.parse(text) as T) : null;
        etag = res.etag;
        metadata = res.metadata;
      } catch (e) {
        if (!BlobError.is(e) || e.code !== 'not_found') throw e;
      }
      const next = await fn(prev);
      try {
        return await this.put(path, JSON.stringify(next), {
          contentType: 'application/json',
          cache: options.cache,
          metadata: options.metadata ?? metadata,
          ...(etag === undefined ? { overwrite: false } : { ifUnchanged: etag }),
        });
      } catch (e) {
        if (!BlobError.is(e) || (e.code !== 'conflict' && e.code !== 'already_exists')) throw e;
        lastError = e;
      }
    }
    throw new BlobError('conflict', { message: `${path} kept changing across 6 attempts`, cause: lastError });
  }

  /* ----------------------------------------------------------- escape hatch */

  // Async because the endpoint is only known from a credentials response: the aws-sdk reads
  // `endpoint` and `bucket` while the client is constructed (measured 2026-08-24, @aws-sdk 3.1116:
  // resolveEndpointConfig spreads the config, so a lazy getter is captured as its first value).
  s3(): S3Config {
    const r2 = this.r2;
    return {
      // The account id in the endpoint is only known from a credentials response, so the endpoint
      // is the async provider shape the aws-sdk accepts (EndpointV2) rather than a string.
      endpoint: async () => ({ url: new URL((await r2.credentials()).endpoint) }),
      region: 'auto',
      bucket: r2.bucketId,
      credentials: async () => {
        const fresh = await r2.credentials();
        return { accessKeyId: fresh.accessKeyId, secretAccessKey: fresh.secretAccessKey, sessionToken: fresh.sessionToken, expiration: new Date(fresh.expiresAt * 1000) };
      },
    };
  }
}

function metaHeaders(metadata: Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(metadata ?? {})) {
    if (typeof v !== 'string') throw new TypeError(`metadata.${k} must be a string`);
    out[`x-amz-meta-${k.toLowerCase()}`] = v;
  }
  return out;
}
