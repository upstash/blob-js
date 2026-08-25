import { BlobError } from '../shared/errors.ts';
import type { BlobObject, UploadRoute, WireBeginResponse, WireEndResponse, WireFile, WireLanded, WireLimits, WirePart, WirePartsResponse } from '../shared/types.ts';
import { cacheControl, formatSize, parseSize, type CacheOption, type Size } from '../shared/units.ts';
import { r2Of, type Bucket } from './bucket.ts';
import { signToken, verifyToken, type TokenPayload } from './completion-token.ts';
import { encodeKey, metaHeaders } from './keys.ts';
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
  allowedContentTypes?: readonly string[];
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

export interface BeforeUploadFailedArgs<TInput, TContext> extends BeforeUploadArgs<TInput> {
  /** What onBeforeUpload returned: the row it reserved is reachable through its context. */
  decided: BeforeUploadResult<TContext>;
  error: BlobError;
}

export interface UploadCompletedArgs<TContext> extends BlobObject {
  request: Request;
  /** Stable for one upload across a retried phase 'end': the key to dedupe on. */
  uploadId: string;
  /** R2's own multipart id, for a bucket.abortMultipart(). Undefined for a single PUT. */
  multipartUploadId: string | undefined;
  contentType: string;
  metadata: Record<string, string>;
  context: TContext;
}

export interface HandleUploadOptions<TSchema extends StandardSchema<any, any> | undefined, TContext, TData, TPath extends string = string> {
  bucket: Bucket;
  /**
   * The URL this route is mounted at. `route` on the hooks is typed to it, so naming one endpoint
   * while importing another's handler type stops compiling. It also separates two routes that
   * declare identical limits, which is what `id` otherwise has to do by hand.
   */
  path?: TPath;
  /**
   * Which route a completion token belongs to. Two routes on one bucket sign with the same key, so
   * without this a token minted by one is spendable at the other. Derived from the route's path,
   * limits and whether it takes input when omitted, which collides only when two routes declare all
   * three the same: name them then.
   */
  id?: string;
  limits?: UploadLimits;
  input?: TSchema;
  onBeforeUpload: (args: BeforeUploadArgs<TSchema extends StandardSchema<any, any> ? InferOutput<TSchema> : never>) => BeforeUploadResult<TContext> | Promise<BeforeUploadResult<TContext>>;
  /**
   * onBeforeUpload accepted the upload but reserving it with storage failed, so nothing will ever
   * complete: release the row it reserved here. The error is rethrown to the client afterwards.
   */
  onBeforeUploadFailed?: (args: BeforeUploadFailedArgs<TSchema extends StandardSchema<any, any> ? InferOutput<TSchema> : never, TContext>) => void | Promise<void>;
  onUploadCompleted?: (args: UploadCompletedArgs<TContext>) => TData | Promise<TData>;
  /**
   * Maps anything a callback threw that is not a BlobError. Return a BlobError or a Response to
   * answer with it; return nothing to fall through. An error carrying a numeric `status` becomes
   * that status without this hook.
   */
  onError?: (error: unknown, request: Request) => BlobError | Response | void | Promise<BlobError | Response | void>;
}

export interface UploadHandlers<TInput, TData, TPath extends string = string> {
  GET: (request: Request) => Promise<Response>;
  POST: UploadRoute<TInput, TData, TPath>;
}

const PARTS_PER_BATCH = 16;
// What the SDK asks for. R2 signs with a credential that lives at most ~600 s and the signature dies
// with it, so this is an upper bound, never the real lifetime: the client re-presigns through phase
// 'parts' when a url stops working, and minRemainingSeconds keeps a fresh url from being born stale.
const PRESIGN_REQUESTED_SECONDS = 3600;
const PRESIGN_MIN_REMAINING_SECONDS = 120;
const TOKEN_TTL_MS = 7 * 86_400_000;
const LIMITS_MAX_AGE = 60;

export function handleUpload<TSchema extends StandardSchema<any, any> | undefined = undefined, TContext = undefined, TData = void, TPath extends string = string>(
  options: HandleUploadOptions<TSchema, TContext, TData, TPath>,
): UploadHandlers<TSchema extends StandardSchema<any, any> ? InferOutput<TSchema> : undefined, TData, TPath> {
  const r2 = r2Of(options.bucket);
  const routeLimits = resolveLimits(options.limits);
  const routeId = options.id ?? deriveRouteId(routeLimits, options.input !== undefined, options.path);
  const GET = limitsEndpoint(routeLimits);

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
      return await answerError(e, request, options.onError);
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
    const headers: Record<string, string> = { 'content-type': file.type, 'cache-control': cache, ...metaHeaders(metadata) };

    const base = {
      v: 1 as const,
      b: r2.bucketId,
      r: routeId,
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
      // The path is onBeforeUpload's to decide, so the multipart cannot be created before it runs;
      // a create that fails afterwards is told back to the app instead of stranding its row.
      let uploadId: string;
      try {
        uploadId = await r2.createMultipart(decided.path, headers);
      } catch (e) {
        const error = BlobError.is(e) ? e : new BlobError('request_failed', { message: 'could not start the upload', status: 502, cause: e });
        await options.onBeforeUploadFailed?.({ request, file, input: input as any, decided, error });
        throw error;
      }
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
    // Refusing bytes that are already stored is only a refusal if they stop being stored: on a public
    // bucket the url is live from the moment the PUT lands, so the object goes before the throw does.
    if (head.size !== t.size) {
      await discard(t.path);
      throw new BlobError('signature_mismatch', { message: `stored ${head.size} bytes, ${t.size} were declared` });
    }

    if (t.allowed) {
      const res = await r2.fetch({ method: 'GET', path: t.path, headers: { range: `bytes=0-${SNIFF_BYTES - 1}` } });
      const bytes = new Uint8Array(await res.arrayBuffer());
      if (!res.ok) throw new BlobError('request_failed', { message: `could not read back the upload (${res.status})`, status: 502 });
      try {
        checkContentType(head.contentType, bytes, t.allowed);
      } catch (e) {
        await discard(t.path);
        throw e;
      }
    }

    const blob = r2.blobObject(t.path, head.size, head.etag, head.uploadedAt);
    let data: TData = undefined as TData;
    if (options.onUploadCompleted) {
      data = await options.onUploadCompleted({
        request,
        uploadId: t.id,
        multipartUploadId: t.kind === 'multipart' ? t.uploadId : undefined,
        ...blob,
        contentType: head.contentType,
        metadata: head.metadata,
        context: t.ctx as TContext,
      });
    }
    return { blob: { ...blob, uploadedAt: blob.uploadedAt.toISOString() }, data };
  }

  /** Deletes the object a rejected upload left behind. */
  async function discard(path: string): Promise<void> {
    try {
      const res = await r2.fetch({ method: 'DELETE', path });
      await res.body?.cancel();
    } catch {
      // The refusal is the answer; a delete that fails must not replace it with its own error.
    }
  }

  async function cancel(body: any): Promise<{ ok: true }> {
    const t = await verify(body.completionToken);
    if (t.kind === 'multipart') await r2.abortMultipart(t.path, t.uploadId);
    return { ok: true };
  }

  async function verify(token: unknown): Promise<TokenPayload> {
    if (typeof token !== 'string') throw new BlobError('invalid_input', { message: 'completionToken is required' });
    const t = await verifyToken(token, tokenKey());
    if (!t || t.b !== r2.bucketId || t.r !== routeId) throw new BlobError('forbidden', { message: 'completionToken is not valid for this route' });
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
      expiresIn: PRESIGN_REQUESTED_SECONDS,
      minRemainingSeconds: PRESIGN_MIN_REMAINING_SECONDS,
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
          expiresIn: PRESIGN_REQUESTED_SECONDS,
          minRemainingSeconds: PRESIGN_MIN_REMAINING_SECONDS,
          signedHeaders: { 'content-length': String(length) },
        }),
      });
    }
    return out;
  }

  return { GET, POST: POST as UploadRoute<any, TData, TPath> };
}

/**
 * Every refusal leaves a route as BlobError.toJSON(), so the browser rebuilds it with its code
 * intact and callers switch on error.code instead of reading status numbers and message text.
 */
export async function answerError(e: unknown, request: Request, onError: ((error: unknown, request: Request) => BlobError | Response | void | Promise<BlobError | Response | void>) | undefined): Promise<Response> {
  if (BlobError.is(e)) return Response.json(e.toJSON(), { status: e.status });
  if (onError) {
    const mapped = await onError(e, request);
    if (mapped instanceof Response) return mapped;
    if (BlobError.is(mapped)) return Response.json(mapped.toJSON(), { status: mapped.status });
  }
  const status = statusOf(e);
  if (status !== undefined) {
    // An auth check that threw its own 401 reaches the browser as code 'unauthorized', so a caller
    // can tell a dead session from a rejected file without reading status numbers.
    const err = BlobError.fromStatus(status, { message: messageOf(e) });
    return Response.json(err.toJSON(), { status });
  }
  // Anything else is the app's bug: let the framework log it rather than mask it as a 500.
  throw e;
}

/**
 * GET on an upload route: what it accepts, so a file picker is filled from the same list that does
 * the refusing. Short and revalidated, not immutable -- the limits are the route's own code and
 * change with a deploy, and a client that cached them forever refuses files the route now accepts.
 */
export function limitsEndpoint(routeLimits: ResolvedLimits): (request: Request) => Promise<Response> {
  const wireLimits: WireLimits = {};
  if (routeLimits.allowedContentTypes) wireLimits.allowedContentTypes = routeLimits.allowedContentTypes;
  if (routeLimits.maxBytes !== undefined) wireLimits.maxBytes = routeLimits.maxBytes;
  const body = JSON.stringify({ limits: wireLimits });
  const etag = `"${hash(body)}"`;
  return async (request: Request): Promise<Response> => {
    const headers = { 'content-type': 'application/json', 'cache-control': `public, max-age=${LIMITS_MAX_AGE}`, etag };
    if (request?.headers?.get('if-none-match') === etag) return new Response(null, { status: 304, headers });
    return new Response(body, { headers });
  };
}

export interface ResolvedLimits {
  allowedContentTypes: string[] | undefined;
  maxBytes: number | undefined;
}

export function resolveLimits(limits: UploadLimits | undefined): ResolvedLimits {
  return {
    allowedContentTypes: limits?.allowedContentTypes === undefined ? undefined : expandContentTypes(limits.allowedContentTypes),
    maxBytes: limits?.maxBytes === undefined ? undefined : parseSize(limits.maxBytes, 'maxBytes'),
  };
}

export function enforce(limits: ResolvedLimits, file: WireFile): void {
  if (limits.maxBytes !== undefined && file.size > limits.maxBytes) {
    throw new BlobError('too_large', { message: `${file.name} is ${formatSize(file.size)}, over the ${formatSize(limits.maxBytes)} limit` });
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

/** An app error that named an HTTP status meant it; anything else is a bug and stays a throw. */
function statusOf(e: unknown): number | undefined {
  const s = (e as { status?: unknown } | null | undefined)?.status;
  return typeof s === 'number' && Number.isInteger(s) && s >= 400 && s < 600 ? s : undefined;
}

function messageOf(e: unknown): string {
  const m = (e as { message?: unknown } | null | undefined)?.message;
  return typeof m === 'string' && m ? m : 'request failed';
}

export function deriveRouteId(limits: { allowedContentTypes: string[] | undefined; maxBytes: number | undefined }, hasInput: boolean, path?: string): string {
  return hash(JSON.stringify([path ?? null, limits.allowedContentTypes ?? null, limits.maxBytes ?? null, hasInput]));
}

/** FNV-1a. Not a security boundary: the token's MAC is. This only separates routes and versions a body. */
function hash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}
