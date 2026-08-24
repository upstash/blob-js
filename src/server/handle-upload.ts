import { BlobError } from '../shared/errors.ts';
import type { BlobObject, UploadRoute, WireBeginResponse, WireEndResponse, WireFile, WireLanded, WireLimits, WirePart, WirePartsResponse } from '../shared/types.ts';
import { cacheControl, parseSize, type CacheOption, type Size } from '../shared/units.ts';
import { r2Of, type Bucket } from './bucket.ts';
import { signToken, verifyToken, type TokenPayload } from './completion-token.ts';
import { encodeKey } from './keys.ts';
import { MULTIPART_THRESHOLD, partCount, partSizeFor } from './multipart.ts';
import { checkContentType, expandContentTypes, SNIFF_BYTES } from './sniff.ts';

/** The subset of the Standard Schema spec the SDK reads: schema['~standard'].validate(). */
export interface StandardSchema<TInput = unknown, TOutput = TInput> {
  readonly '~standard': {
    readonly version: 1;
    readonly vendor: string;
    readonly validate: (value: unknown) => StandardResult<TOutput> | Promise<StandardResult<TOutput>>;
    readonly types?: { readonly input: TInput; readonly output: TOutput } | undefined;
  };
}

export type StandardResult<T> = { readonly value: T; readonly issues?: undefined } | { readonly issues: ReadonlyArray<{ readonly message: string; readonly path?: ReadonlyArray<PropertyKey | { key: PropertyKey }> | undefined }> };

type InferOutput<S> = S extends StandardSchema<any, infer O> ? O : never;

export interface UploadLimits {
  allowedContentTypes?: string[];
  maxBytes?: Size;
}

export interface BeforeUploadArgs<TInput> {
  request: Request;
  file: WireFile;
  input: TInput;
}

export interface BeforeUploadResult<TContext> {
  path: string;
  cache?: CacheOption;
  metadata?: Record<string, string>;
  /** May narrow the route's limits per user, never widen them. */
  limits?: UploadLimits;
  context?: TContext;
}

export interface UploadCompletedArgs<TContext> extends BlobObject {
  request: Request;
  /** Stable for one upload across a retried phase 'end': the key to dedupe on. */
  uploadId: string;
  contentType: string;
  metadata: Record<string, string>;
  context: TContext;
}

export interface HandleUploadOptions<TSchema extends StandardSchema<any, any> | undefined, TContext, TData> {
  bucket: Bucket;
  limits?: UploadLimits;
  input?: TSchema;
  onBeforeUpload: (args: BeforeUploadArgs<TSchema extends StandardSchema<any, any> ? InferOutput<TSchema> : never>) => BeforeUploadResult<TContext> | Promise<BeforeUploadResult<TContext>>;
  onUploadCompleted?: (args: UploadCompletedArgs<TContext>) => TData | Promise<TData>;
}

export interface UploadHandlers<TInput, TData> {
  GET: (request: Request) => Promise<Response>;
  POST: UploadRoute<TInput, TData>;
}

const PARTS_PER_BATCH = 16;
const PRESIGN_SECONDS = 3600;
const TOKEN_TTL_MS = 7 * 86_400_000;

export function handleUpload<TSchema extends StandardSchema<any, any> | undefined = undefined, TContext = undefined, TData = void>(
  options: HandleUploadOptions<TSchema, TContext, TData>,
): UploadHandlers<TSchema extends StandardSchema<any, any> ? InferOutput<TSchema> : undefined, TData> {
  const r2 = r2Of(options.bucket);
  const routeLimits = resolveLimits(options.limits);
  const wireLimits: WireLimits = {};
  if (routeLimits.allowedContentTypes) wireLimits.allowedContentTypes = routeLimits.allowedContentTypes;
  if (routeLimits.maxBytes !== undefined) wireLimits.maxBytes = routeLimits.maxBytes;

  const GET = async (): Promise<Response> =>
    Response.json({ limits: wireLimits }, { headers: { 'cache-control': 'public, max-age=31536000, immutable' } });

  const POST = async (request: Request): Promise<Response> => {
    try {
      const body = await request.json().catch(() => undefined);
      if (!body || typeof body !== 'object' || typeof body.phase !== 'string') throw new BlobError('invalid_input', { message: 'expected a JSON body with a phase' });
      switch (body.phase) {
        case 'begin':
          return Response.json(await begin(request, body));
        case 'parts':
          return Response.json(await parts(body));
        case 'end':
          return Response.json(await end(request, body));
        case 'cancel':
          return Response.json(await cancel(body));
        default:
          throw new BlobError('invalid_input', { message: `unknown phase ${String(body.phase)}` });
      }
    } catch (e) {
      if (BlobError.is(e)) return Response.json(e.toJSON(), { status: e.status });
      // Anything else is the app's bug: let the framework log it rather than mask it as a 500.
      throw e;
    }
  };

  async function begin(request: Request, body: any): Promise<WireBeginResponse> {
    const file = readFile(body.file);
    enforce(routeLimits, file);

    let input: unknown = undefined;
    if (options.input) {
      const result = await options.input['~standard'].validate(body.input);
      if (result.issues) {
        throw new BlobError('invalid_input', { message: result.issues.map((i) => (i.path?.length ? `${i.path.map((p) => (typeof p === 'object' ? String(p.key) : String(p))).join('.')}: ` : '') + i.message).join('; ') });
      }
      input = result.value;
    } else if (body.input !== undefined) {
      throw new BlobError('invalid_input', { message: 'this route takes no input' });
    }

    const decided = await options.onBeforeUpload({ request, file, input: input as any });
    if (!decided || typeof decided.path !== 'string') throw new TypeError('onBeforeUpload must return { path }');
    encodeKey(decided.path);

    let allowed = routeLimits.allowedContentTypes;
    if (decided.limits) {
      const narrowed = resolveLimits(decided.limits);
      if (narrowed.maxBytes !== undefined && routeLimits.maxBytes !== undefined && narrowed.maxBytes > routeLimits.maxBytes) {
        throw new TypeError(`onBeforeUpload widened maxBytes (${narrowed.maxBytes} > ${routeLimits.maxBytes})`);
      }
      if (narrowed.allowedContentTypes && routeLimits.allowedContentTypes) {
        const wider = narrowed.allowedContentTypes.filter((t) => !routeLimits.allowedContentTypes!.includes(t));
        if (wider.length) throw new TypeError(`onBeforeUpload widened allowedContentTypes (${wider.join(', ')})`);
      }
      enforce(narrowed, file);
      allowed = narrowed.allowedContentTypes ?? allowed;
    }

    const cache = cacheControl(decided.cache ?? r2.defaultCache);
    const metadata = decided.metadata ?? {};
    const headers: Record<string, string> = { 'content-type': file.type, 'cache-control': cache };
    for (const [k, v] of Object.entries(metadata)) headers[`x-amz-meta-${k.toLowerCase()}`] = v;

    const base = {
      v: 1 as const,
      b: r2.bucketId,
      id: crypto.randomUUID(),
      path: decided.path,
      type: file.type,
      size: file.size,
      headers,
      allowed,
      ctx: decided.context,
      exp: Date.now() + TOKEN_TTL_MS,
    };

    if (file.size >= MULTIPART_THRESHOLD) {
      const uploadId = await r2.createMultipart(decided.path, headers);
      const partSize = partSizeFor(file.size);
      const payload: TokenPayload = { ...base, kind: 'multipart', uploadId, partSize };
      const completionToken = await signToken(payload, tokenKey());
      return { completionToken, path: decided.path, upload: { kind: 'multipart', partSize, parts: await presignParts(payload, 1) } };
    }
    const payload: TokenPayload = { ...base, kind: 'single' };
    const completionToken = await signToken(payload, tokenKey());
    return { completionToken, path: decided.path, upload: await presignSingle(payload) };
  }

  async function parts(body: any): Promise<WirePartsResponse> {
    const t = await verify(body.completionToken);
    if (t.kind === 'single') return await presignSingle(t);
    const from = Number.isInteger(body.from) && body.from >= 1 ? body.from : 1;
    const landed = (await r2.listParts(t.path, t.uploadId)).map(({ n, etag }) => ({ n, etag }));
    return { kind: 'multipart', partSize: t.partSize, size: t.size, parts: await presignParts(t, from), landed };
  }

  async function end(request: Request, body: any): Promise<WireEndResponse<TData>> {
    const t = await verify(body.completionToken);
    if (t.kind === 'multipart') {
      const expected = partCount(t.size, t.partSize);
      let list: WireLanded[] = Array.isArray(body.parts) ? body.parts : [];
      if (list.length !== expected) list = (await r2.listParts(t.path, t.uploadId)).map(({ n, etag }) => ({ n, etag }));
      if (list.length !== expected) throw new BlobError('invalid_input', { message: `expected ${expected} parts, ${list.length} landed` });
      for (const p of list) {
        if (!Number.isInteger(p?.n) || typeof p.etag !== 'string') throw new BlobError('invalid_input', { message: 'parts must be [{ n, etag }]' });
      }
      try {
        await r2.completeMultipart(t.path, t.uploadId, list);
      } catch (e) {
        // NoSuchUpload after the object landed is a retried 'end': the earlier call completed it.
        if (!BlobError.is(e) || e.code !== 'not_found' || !(await r2.head(t.path))) throw e;
      }
    }

    const head = await r2.head(t.path);
    if (!head) throw new BlobError('not_found', { message: 'the upload never landed' });
    if (head.size !== t.size) throw new BlobError('signature_mismatch', { message: `stored ${head.size} bytes, ${t.size} were declared` });

    if (t.allowed) {
      const res = await r2.fetch({ method: 'GET', path: t.path, headers: { range: `bytes=0-${SNIFF_BYTES - 1}` } });
      const bytes = new Uint8Array(await res.arrayBuffer());
      if (!res.ok) throw new BlobError('request_failed', { message: `could not read back the upload (${res.status})`, status: 502 });
      checkContentType(head.contentType, bytes, t.allowed);
    }

    const blob = await r2.blobObject(t.path, head.size, head.etag, head.uploadedAt);
    let data: TData = undefined as TData;
    if (options.onUploadCompleted) {
      data = await options.onUploadCompleted({ request, uploadId: t.id, ...blob, contentType: head.contentType, metadata: head.metadata, context: t.ctx as TContext });
    }
    return { blob: { ...blob, uploadedAt: blob.uploadedAt.toISOString() }, data };
  }

  async function cancel(body: any): Promise<{ ok: true }> {
    const t = await verify(body.completionToken);
    if (t.kind === 'multipart') await r2.abortMultipart(t.path, t.uploadId);
    return { ok: true };
  }

  async function verify(token: unknown): Promise<TokenPayload> {
    if (typeof token !== 'string') throw new BlobError('invalid_input', { message: 'completionToken is required' });
    const t = await verifyToken(token, tokenKey());
    if (!t || t.b !== r2.bucketId) throw new BlobError('forbidden', { message: 'completionToken is not valid for this route' });
    if (t.exp < Date.now()) throw new BlobError('forbidden', { message: 'completionToken has expired' });
    return t;
  }

  function tokenKey(): string {
    return r2.signingSecret;
  }

  async function presignSingle(t: { path: string; size: number; headers: Record<string, string> }): Promise<{ kind: 'single'; url: string; headers: Record<string, string> }> {
    const url = await r2.presign({
      method: 'PUT',
      path: t.path,
      expiresIn: PRESIGN_SECONDS,
      signedHeaders: { ...t.headers, 'content-length': String(t.size) },
    });
    // content-length is signed but not returned: the browser sets it itself and refuses it as a header.
    return { kind: 'single', url, headers: t.headers };
  }

  async function presignParts(t: { path: string; size: number; uploadId: string; partSize: number }, from: number): Promise<WirePart[]> {
    const count = partCount(t.size, t.partSize);
    const out: WirePart[] = [];
    for (let n = from; n < from + PARTS_PER_BATCH && n <= count; n++) {
      const length = n === count ? t.size - t.partSize * (count - 1) : t.partSize;
      out.push({
        n,
        url: await r2.presign({
          method: 'PUT',
          path: t.path,
          query: { partNumber: String(n), uploadId: t.uploadId },
          expiresIn: PRESIGN_SECONDS,
          signedHeaders: { 'content-length': String(length) },
        }),
      });
    }
    return out;
  }

  return { GET, POST: POST as UploadRoute<any, TData> };
}

interface ResolvedLimits {
  allowedContentTypes: string[] | undefined;
  maxBytes: number | undefined;
}

function resolveLimits(limits: UploadLimits | undefined): ResolvedLimits {
  return {
    allowedContentTypes: limits?.allowedContentTypes === undefined ? undefined : expandContentTypes(limits.allowedContentTypes),
    maxBytes: limits?.maxBytes === undefined ? undefined : parseSize(limits.maxBytes, 'maxBytes'),
  };
}

function enforce(limits: ResolvedLimits, file: WireFile): void {
  if (limits.maxBytes !== undefined && file.size > limits.maxBytes) {
    throw new BlobError('too_large', { message: `${file.name} is ${file.size} bytes, over the limit of ${limits.maxBytes}` });
  }
  if (limits.allowedContentTypes) checkContentType(file.type, undefined, limits.allowedContentTypes);
}

function readFile(raw: unknown): WireFile {
  const f = raw as Record<string, unknown> | undefined;
  if (!f || typeof f !== 'object' || typeof f.name !== 'string' || !Number.isInteger(f.size) || (f.size as number) < 0) {
    throw new BlobError('invalid_input', { message: 'file must be { name, type, size }' });
  }
  const type = typeof f.type === 'string' && f.type ? f.type.toLowerCase().split(';')[0]!.trim() : 'application/octet-stream';
  return { name: f.name, type, size: f.size as number };
}
