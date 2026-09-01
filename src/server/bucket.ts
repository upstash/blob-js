import { BlobError } from '../shared/errors.ts';
import type { BlobObject, CompletedBlob } from '../shared/types.ts';
import { cacheControl, formatBytes, parseDuration, parseSize, type CacheOption, type Duration, type Size } from '../shared/units.ts';
import { limit, peek, readAll, resolveBody, type PutBody } from './body.ts';
import { blocks, decodeEntities, encodeKey, escapeXml, metaHeaders, tag } from './keys.ts';
import { partCount, partSizeFor, wantsMultipart, type MultipartOption } from './multipart.ts';
import { errorFromBody, errorFromResponse, headFromHeaders, R2, type MultipartUpload } from './r2.ts';
import { checkContentType, expandContentTypes } from './sniff.ts';
import { decodeToken } from './token.ts';

export type { MultipartUpload };

export interface BucketOptions {
  token: string;
  /**
   * `'private'` drops `url` and `versionedUrl` from every BlobObject: nothing serves a private
   * bucket over the public host, so a url there is a link that 404s. A visibility in the
   * credentials response wins over this.
   */
  visibility?: 'public' | 'private';
  /**
   * The `Cache-Control` written on every object this bucket stores. A per-call `cache` overrides it.
   * @see CacheOption
   */
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
  contentTypes?: readonly string[];
  maxBytes?: Size;
  /** The `Cache-Control` this object is stored with, overriding the bucket default. @see CacheOption */
  cache?: CacheOption;
  metadata?: Record<string, string>;
  /**
   * Declared length for a stream whose size is not otherwise known. Without it, `put()` buffers the
   * stream (up to `maxBytes`) before uploading so it can determine the required content length.
   */
  size?: number;
  /** false: If-None-Match: * server-side, so a real 412 rather than a client-side race. */
  overwrite?: boolean;
  /** An etag: If-Match, so the write fails with 'conflict' if the object changed. */
  ifUnchanged?: string;
  /**
   * Where the multipart path starts. The default is 16 MB: under it a body goes up as one PUT, over
   * it in parts, which is the only way past R2's ~5 GiB single-PUT cap and the only way a failed
   * chunk can be retried. A size moves the line (`'100mb'`), `true` always parts, `false` never
   * does. `overwrite: false` and `ifUnchanged` are single-PUT only, so they turn it off.
   */
  multipart?: MultipartOption;
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

/** What get() answers: the blob's facts and its bytes. */
export interface BlobDownload extends BlobInfo {
  body: ReadableStream<Uint8Array>;
}

export interface SignedReadUrlOptions {
  /**
   * How long the link should live. If the current signing credential expires sooner, the SDK uses
   * what is available; `expiresAt` always says when the returned link actually expires.
   */
  expiresIn?: Duration;
  /** Save the response as this filename instead of displaying it inline. */
  downloadAs?: string;
  /** What storage answers with as `Content-Type`, overriding what the object was stored as. */
  contentType?: string;
}

export interface SignedReadUrl {
  url: string;
  /** When the link stops working. Never later than the credential that signed it. */
  expiresAt: Date;
}

export interface ListMultipartOptions {
  prefix?: string;
}

export interface AbortStaleMultipartOptions extends ListMultipartOptions {
  /** Only abort uploads started longer ago than this. */
  olderThan: Duration;
}

export interface S3Config {
  endpoint: () => Promise<{ url: URL }>;
  region: string;
  bucket: string;
  credentials: () => Promise<{ accessKeyId: string; secretAccessKey: string; sessionToken: string; expiration: Date }>;
}

export type DeleteTarget = string | string[] | { prefix: string; all?: boolean };

export interface UpdateJsonOptions {
  /** The `Cache-Control` the rewritten object is stored with. @see CacheOption */
  cache?: CacheOption;
  metadata?: Record<string, string>;
}

/**
 * The name reaches storage as a query parameter and comes back as a header value, so a quote, a
 * semicolon or a CRLF in it must not be able to add a parameter or a second header. RFC 6266 4.1
 * carries the real name in `filename*` as an RFC 8187 ext-value, where percent-encoding leaves a
 * parser nothing to read as syntax; the `filename` fallback is cut back to characters that cannot
 * end the quoted string. encodeURIComponent leaves `!'()*` alone and only `!` of those is an
 * attr-char, so the other four are escaped by hand.
 */
function attachmentDisposition(name: string): string {
  const raw = name || 'download';
  const ascii = raw.replace(/[^\w.\- ]+/g, '_') || 'download';
  const encoded = encodeURIComponent(raw).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

/** Same reasoning: this becomes the Content-Type header storage answers with. */
function safeContentType(type: string): string {
  if (!/^[\w.+-]+\/[\w.+-]+(?:\s*;\s*[\w.+-]+=(?:[\w.+-]+|"[^";\\]*"))*$/.test(type)) {
    throw new BlobError('invalid_input', { message: `contentType: "${type}" is not a media type` });
  }
  return type;
}

const INTERNALS = new WeakMap<Bucket, R2>();

/** Not exported from the package: the upload handler's access to the signing core. */
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
    this.r2 = new R2(decoded.bucketId, options.token, decoded.hashForDomain, decoded.password, options.cache, options.enableTelemetry ?? true, options.visibility);
    INTERNALS.set(this, this.r2);
  }

  static fromEnv(name = 'UPSTASH_BLOB_TOKEN', options: Omit<BucketOptions, 'token'> = {}): Bucket {
    const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;
    const token = env?.[name];
    if (!token) throw new TypeError(`Bucket.fromEnv: ${name} is not set (on Workers, pass it explicitly: new Bucket({ token: env.${name} }))`);
    return new Bucket({ ...options, token });
  }

  /** The public object URL, computed locally from the bucket token. Undefined for a private bucket. */
  publicUrl(path: string): string | undefined {
    encodeKey(path);
    return this.r2.publicUrl(path);
  }

  /* ------------------------------------------------------------------ put */

  async put(path: string, body: PutBody, options: PutOptions = {}): Promise<CompletedBlob> {
    encodeKey(path);
    const allowed = options.contentTypes === undefined ? undefined : expandContentTypes(options.contentTypes);
    const maxBytes = options.maxBytes === undefined ? undefined : parseSize(options.maxBytes, 'maxBytes');

    const resolved = resolveBody(body);
    let { stream, size } = resolved;
    const contentType = options.contentType ?? resolved.contentType ?? 'application/octet-stream';

    if (size === undefined && options.size !== undefined) size = parseSize(options.size, 'size');
    if (maxBytes !== undefined && size !== undefined && size > maxBytes) {
      throw new BlobError('too_large', { message: `the body is ${formatBytes(size)}, over the ${formatBytes(maxBytes)} limit` });
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

    // Resolved before the header is written: visibility decides public vs private on it, and the
    // credentials that carry it are not peekable until they have been fetched once.
    await this.r2.credentials();
    const objectHeaders: Record<string, string> = {
      'content-type': contentType,
      'cache-control': cacheControl(options.cache ?? this.defaultCache, this.r2.visibility()),
      ...metaHeaders(options.metadata),
    };

    const conditional = options.overwrite === false || options.ifUnchanged !== undefined;
    if (options.multipart === true && conditional) {
      throw new BlobError('invalid_input', { message: 'multipart: overwrite:false and ifUnchanged are single-PUT only' });
    }
    // Asked before the conditional check, not after: a body over the single-PUT cap is a refusal
    // worth naming whatever else is set, and a conditional write cannot rescue it either.
    // A zero-byte multipart upload is not a thing, and its stream has already been released.
    if (size > 0 && wantsMultipart(options.multipart, size) && !conditional) {
      return this.putMultipart(path, stream, size, objectHeaders, contentType);
    }

    const headers: Record<string, string> = { ...objectHeaders, 'content-length': String(size) };
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
    return { ...this.r2.blobObject(path, size, res.headers.get('etag') ?? '', new Date()), contentType };
  }

  /**
   * One part at a time: a part is buffered whole so it can be retried, and holding several of them
   * would multiply that by the concurrency. An error anywhere aborts the upload rather than leaving
   * parts behind that nothing can see.
   */
  private async putMultipart(path: string, stream: ReadableStream<Uint8Array>, size: number, headers: Record<string, string>, contentType: string): Promise<CompletedBlob> {
    const partSize = partSizeFor(size);
    const expected = partCount(size, partSize);
    const uploadId = await this.r2.createMultipart(path, headers);
    try {
      const reader = stream.getReader();
      const parts: { n: number; etag: string }[] = [];
      let pending: Uint8Array[] = [];
      let pendingBytes = 0;
      let sent = 0;

      const sendPart = async (length: number): Promise<void> => {
        const chunk = new Uint8Array(length);
        let filled = 0;
        while (filled < length) {
          const head = pending[0]!;
          const take = Math.min(head.byteLength, length - filled);
          chunk.set(head.subarray(0, take), filled);
          filled += take;
          if (take === head.byteLength) pending.shift();
          else pending[0] = head.subarray(take);
        }
        pendingBytes -= length;
        const n = parts.length + 1;
        if (n > expected) throw new BlobError('invalid_input', { message: `body is longer than the declared ${size} bytes` });
        const res = await this.r2.fetch({
          method: 'PUT',
          path,
          query: { partNumber: String(n), uploadId },
          headers: { 'content-length': String(length) },
          body: chunk,
        });
        if (!res.ok) throw errorFromBody(res.status, await res.text());
        await res.body?.cancel();
        const etag = res.headers.get('etag');
        if (!etag) throw new BlobError('request_failed', { message: `part ${n} landed without an etag`, status: 502 });
        parts.push({ n, etag });
        sent += length;
      };

      for (;;) {
        const { done, value } = await reader.read();
        if (value && value.byteLength) {
          pending.push(value);
          pendingBytes += value.byteLength;
        }
        while (pendingBytes >= partSize) await sendPart(partSize);
        if (done) break;
      }
      if (pendingBytes > 0) await sendPart(pendingBytes);
      pending = [];
      if (sent !== size) throw new BlobError('invalid_input', { message: `body was ${sent} bytes, ${size} were declared` });

      const etag = await this.r2.completeMultipart(path, uploadId, parts);
      return { ...this.r2.blobObject(path, size, etag, new Date()), contentType };
    } catch (e) {
      // Nothing lists an incomplete upload, so a failure that left one behind is invisible billing.
      await this.r2.abortMultipart(path, uploadId).catch(() => {});
      if (BlobError.is(e)) throw e;
      if (e && typeof e === 'object' && BlobError.is((e as { cause?: unknown }).cause)) throw (e as { cause: BlobError }).cause;
      throw e;
    }
  }

  /* ----------------------------------------------------------------- read */

  async get(path: string): Promise<BlobDownload> {
    const res = await this.r2.fetch({ method: 'GET', path });
    if (!res.ok) throw await errorFromResponse(res);
    const head = headFromHeaders(res.headers);
    const blob = this.r2.blobObject(path, head.size, head.etag, head.uploadedAt);
    return { ...blob, contentType: head.contentType, metadata: head.metadata, body: res.body ?? new Blob([]).stream() };
  }

  async info(path: string): Promise<BlobInfo> {
    const head = await this.r2.head(path);
    if (!head) throw new BlobError('not_found', { message: `${path} not found` });
    const blob = this.r2.blobObject(path, head.size, head.etag, head.uploadedAt);
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
      blobs.push(this.r2.blobObject(decodeEntities(key), Number(tag(b, 'Size') ?? 0), etag, new Date(tag(b, 'LastModified') ?? 0)));
    }
    const next = tag(xml, 'NextContinuationToken');
    return { blobs, cursor: tag(xml, 'IsTruncated') === 'true' && next ? decodeEntities(next) : undefined };
  }

  /** The link and when it dies, so a caller can cache it until then rather than guess. */
  async signedReadUrl(path: string, options: SignedReadUrlOptions = {}): Promise<SignedReadUrl> {
    const expiresIn = options.expiresIn === undefined ? undefined : Math.max(1, Math.floor(parseDuration(options.expiresIn, 'expiresIn') / 1000));
    const query: Record<string, string> = {};
    if (options.downloadAs !== undefined) query['response-content-disposition'] = attachmentDisposition(options.downloadAs);
    if (options.contentType !== undefined) query['response-content-type'] = safeContentType(options.contentType);
    return this.r2.presignRead({ path, query, expiresIn });
  }

  /* ---------------------------------------------------------------- write */

  async del(target: DeleteTarget): Promise<void> {
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
    if (typeof target?.prefix !== 'string') throw new BlobError('invalid_input', { message: 'del: expected a path, an array of paths, or { prefix }' });
    if (target.prefix === '' && target.all !== true) {
      throw new BlobError('invalid_input', {
        message: "del({ prefix: '' }) would delete every object in the bucket",
        hint: "pass { prefix: '', all: true } if that is what you mean",
      });
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

  /* ------------------------------------------------------------ multipart */

  /**
   * Multipart uploads that were started and never completed or aborted. They are billed storage that
   * list() cannot see, and a bucket cannot be deleted while one exists.
   */
  async listMultipartUploads(options: ListMultipartOptions = {}): Promise<MultipartUpload[]> {
    return this.r2.listMultipartUploads(options.prefix);
  }

  /**
   * Throws away an incomplete upload and every part that landed for it. Missing is success, which is
   * why it takes the record listMultipartUploads() returned rather than two strings: a swapped pair
   * would abort nothing and report that it worked.
   */
  async abortMultipartUpload(upload: Pick<MultipartUpload, 'path' | 'uploadId'>): Promise<void> {
    if (!upload || typeof upload !== 'object') throw new BlobError('invalid_input', { message: 'abortMultipartUpload({ path, uploadId }): an upload is required' });
    if (typeof upload.uploadId !== 'string' || !upload.uploadId) throw new BlobError('invalid_input', { message: 'abortMultipartUpload({ path, uploadId }): uploadId is required' });
    encodeKey(upload.path);
    await this.r2.abortMultipart(upload.path, upload.uploadId);
  }

  /**
   * List plus abort, for an app cron: an abandoned upload is not expired for you, and one that
   * list() cannot see is what turns "delete the bucket" into a dead end. Returns what it aborted.
   */
  async abortStaleMultipartUploads(options: AbortStaleMultipartOptions): Promise<MultipartUpload[]> {
    const cutoff = Date.now() - parseDuration(options.olderThan, 'olderThan');
    const stale = (await this.listMultipartUploads(options)).filter((u) => u.initiatedAt.getTime() <= cutoff);
    for (const u of stale) await this.r2.abortMultipart(u.path, u.uploadId);
    return stale;
  }

  /* ---------------------------------------------------------- copy/move */

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
  async updateJson<T = unknown>(path: string, fn: (prev: T | null) => T | Promise<T>, options: UpdateJsonOptions = {}): Promise<BlobObject> {
    let lastError: BlobError | undefined;
    for (let attempt = 0; attempt < 6; attempt++) {
      let prev: T | null = null;
      let etag: string | undefined;
      let metadata: Record<string, string> | undefined;
      try {
        const res = await this.get(path);
        const text = await new Response(res.body).text();
        // An object that exists but is empty reads as null: there is no JSON document in it either
        // way, so the callback is handed the same "nothing here yet" both times.
        prev = text.length ? (JSON.parse(text) as T) : null;
        etag = res.etag;
        metadata = res.metadata;
      } catch (e) {
        if (!BlobError.is(e) || e.code !== 'not_found') throw e;
      }
      const next = await fn(prev);
      try {
        // If-None-Match when nothing was there, If-Match on the etag when something was, so a write
        // that raced another one is retried against what actually landed rather than overwriting it.
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

