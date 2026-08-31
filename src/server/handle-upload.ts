import { BlobError } from '../shared/errors.ts';
import type { UploadFile, WireBeginResponse, WireEndResponse, WireLanded, WireConstraints, WireConstraintsResponse, WirePart, WirePartsResponse } from '../shared/types.ts';
import { cacheControl, formatBytes, parseSize, type CacheOption, type Size } from '../shared/units.ts';
import { r2Of, type Bucket } from './bucket.ts';
import { signToken, verifyToken, type TokenPayload } from './completion-token.ts';
import { encodeKey, metaHeaders } from './keys.ts';
import { partCount, partSizeFor } from './multipart.ts';
import { checkContentType, expandContentTypes, SNIFF_BYTES } from './sniff.ts';

/**
 * The direct transport, internal to `uploadHandler`. Presign, the browser PUTs straight to storage,
 * and phase 'end' completes the upload. Always multipart -- one part when the file fits one -- so
 * the object does not exist until 'end' runs the route's onUploadComplete.
 */

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

export interface UploadConstraints {
  contentTypes?: readonly string[];
  maxBytes?: Size;
}

/** What the handler knows when a callback threw, as much of it as the request had reached. */
export interface ErrorDetails {
  file?: UploadFile;
  path?: string;
  metadata?: Record<string, string>;
  state?: unknown;
}

export type ErrorMapper = (error: unknown, request: Request, details: ErrorDetails) => BlobError | Response | void | Promise<BlobError | Response | void>;

/** What the route decided about one file. `ctx` is added by the handler, not by this module. */
interface Decided {
  path: string;
  /** The `Cache-Control` this object is stored with, overriding the bucket default. @see CacheOption */
  cache?: CacheOption;
  metadata?: Record<string, string>;
  constraints?: UploadConstraints;
  state?: unknown;
}

export interface InternalUploadOptions {
  bucket: Bucket;
  /** The route's name, handed to every callback. '' for a handler that mounts no named routes. */
  route: string;
  /** Which route a completion token belongs to: a token minted by one is not spendable at another. */
  id: string;
  constraints?: UploadConstraints;
  input?: StandardSchema<any, any> | undefined;
  onBeforeUpload: (args: { request: Request; route: string; file: UploadFile; input: unknown }) => Decided | Promise<Decided>;
  onUploadComplete?: (args: Record<string, unknown>) => unknown;
  onError?: ErrorMapper;
}

export interface InternalUploadHandlers {
  GET: (request: Request) => Promise<Response>;
  POST: (request: Request) => Promise<Response>;
}

const PARTS_PER_BATCH = 16;
// What the SDK asks for. R2 signs with a credential that lives at most ~600 s and the signature dies
// with it, so this is an upper bound, never the real lifetime: the client re-presigns through phase
// 'parts' when a url stops working, and minRemainingSeconds keeps a fresh url from being born stale.
const PRESIGN_REQUESTED_SECONDS = 3600;
const PRESIGN_MIN_REMAINING_SECONDS = 120;
const TOKEN_TTL_MS = 7 * 86_400_000;
const LIMITS_MAX_AGE = 60;

export function handleUpload(options: InternalUploadOptions): InternalUploadHandlers {
  const r2 = r2Of(options.bucket);
  const routeConstraints = resolveConstraints(options.constraints);
  const routeId = options.id;
  const GET = constraintsEndpoint(routeConstraints);

  const POST = async (request: Request): Promise<Response> => {
    const details: ErrorDetails = {};
    try {
      const body = await request.json().catch(() => undefined);
      if (!body || typeof body !== 'object' || typeof body.phase !== 'string') throw new BlobError('invalid_input', { message: 'expected a JSON body with a phase' });
      switch (body.phase) {
        case 'begin':
          return Response.json(await begin(request, body, details));
        case 'parts':
          return Response.json(await parts(body, details));
        case 'end':
          return Response.json(await end(request, body, details));
        case 'cancel':
          return Response.json(await cancel(body, details));
        default:
          throw new BlobError('invalid_input', { message: `unknown phase ${String(body.phase)}` });
      }
    } catch (e) {
      return await answerError(e, request, options.onError, details);
    }
  };

  async function begin(request: Request, body: any, details: ErrorDetails): Promise<WireBeginResponse> {
    const file = readFile(body.file);
    details.file = file;
    if (file.size === 0) throw new BlobError('empty_body');
    // The browser sends the file's first bytes so a mislabelled file is refused here, before a
    // multipart exists and before onBeforeUpload has written anything down, rather than after the
    // whole upload. This is ergonomics and not a control: the part bodies never reach this server,
    // so a client is free to send an honest head and then upload something else. Older clients send
    // no head, and then the declared type is all there is to check.
    const head = readHead(body.head);
    enforce(routeConstraints, file, head);

    const input = await validateInput(options.input, body.input);

    const decided = await options.onBeforeUpload({ request, route: options.route, file, input });
    if (!decided || typeof decided.path !== 'string') throw new TypeError('onBeforeUpload must return { path }');
    encodeKey(decided.path);
    details.path = decided.path;
    details.state = decided.state;

    if (decided.constraints) {
      const narrowed = resolveConstraints(decided.constraints);
      if (narrowed.maxBytes !== undefined && routeConstraints.maxBytes !== undefined && narrowed.maxBytes > routeConstraints.maxBytes) {
        throw new TypeError(`onBeforeUpload widened maxBytes (${narrowed.maxBytes} > ${routeConstraints.maxBytes})`);
      }
      if (narrowed.contentTypes && routeConstraints.contentTypes) {
        const wider = narrowed.contentTypes.filter((t) => !routeConstraints.contentTypes!.includes(t));
        if (wider.length) throw new TypeError(`onBeforeUpload widened contentTypes (${wider.join(', ')})`);
      }
      enforce(narrowed, file, head);
    }

    await r2.credentials();
    const cache = cacheControl(decided.cache ?? r2.defaultCache, r2.visibility());
    const metadata = decided.metadata ?? {};
    details.metadata = metadata;
    const headers: Record<string, string> = { 'content-type': file.type, 'cache-control': cache, ...metaHeaders(metadata) };

    // The path is onBeforeUpload's to decide, so the multipart cannot be created before it runs; a
    // create that fails afterwards is told back to the app, with the path it reserved, through onError.
    let uploadId: string;
    try {
      uploadId = await r2.createMultipart(decided.path, headers);
    } catch (e) {
      throw BlobError.is(e) ? e : new BlobError('request_failed', { message: 'could not start the upload', status: 502, cause: e });
    }
    const partSize = partSizeFor(file.size);
    const payload: TokenPayload = {
      v: 1,
      b: r2.bucketId,
      r: routeId,
      id: crypto.randomUUID(),
      path: decided.path,
      n: file.name,
      type: file.type,
      size: file.size,
      headers,
      ctx: decided.state,
      exp: Date.now() + TOKEN_TTL_MS,
      uploadId,
      partSize,
    };
    const completionToken = await signToken(payload, tokenKey());
    return { completionToken, path: decided.path, upload: { partSize, parts: await presignParts(payload, 1) } };
  }

  async function parts(body: any, details: ErrorDetails): Promise<WirePartsResponse> {
    const t = await verify(body.completionToken, details);
    const from = Number.isInteger(body.from) && body.from >= 1 ? body.from : 1;
    const landed = (await r2.listParts(t.path, t.uploadId)).map(({ n, etag }) => ({ n, etag }));
    return { partSize: t.partSize, size: t.size, parts: await presignParts(t, from), landed };
  }

  async function end(request: Request, body: any, details: ErrorDetails): Promise<WireEndResponse<unknown>> {
    const t = await verify(body.completionToken, details);
    const file: UploadFile = { name: t.n, type: t.type, size: t.size };
    details.file = file;

    const expected = partCount(t.size, t.partSize);
    let list: WireLanded[] = Array.isArray(body.parts) ? body.parts : [];
    if (list.length !== expected) list = (await r2.listParts(t.path, t.uploadId)).map(({ n, etag }) => ({ n, etag }));
    if (list.length !== expected) throw new BlobError('invalid_input', { message: `expected ${expected} parts, ${list.length} landed` });
    for (const p of list) {
      if (!Number.isInteger(p?.n) || typeof p.etag !== 'string') throw new BlobError('invalid_input', { message: 'parts must be [{ n, etag }]' });
    }
    // Kept for discard(): it is what says the object still holds this upload's bytes and not a later
    // upload's, which matters whenever onBeforeUpload returns a stable path.
    let completedEtag: string | undefined;
    try {
      completedEtag = await r2.completeMultipart(t.path, t.uploadId, list);
    } catch (e) {
      // NoSuchUpload after the object landed is a retried 'end': the earlier call completed it.
      if (!BlobError.is(e) || e.code !== 'not_found' || !(await r2.head(t.path))) throw e;
    }

    const head = await r2.head(t.path);
    if (!head) throw new BlobError('not_found', { message: 'the upload never landed' });
    // A refusal here deletes an object that is already stored and, on a public bucket, already
    // served: R2 commits at completeMultipart and the public host has no per-object access control,
    // so everything below runs on an object the world can already read. Deleting bounds that
    // exposure to these few round trips; it does not undo it, and an edge that cached the object
    // inside the window keeps serving it for its Cache-Control. Nothing the SDK can do closes that,
    // which is why the byte check moved to phase 'begin', where refusing costs nothing.
    if (head.size !== t.size) {
      await discard(t.path, completedEtag);
      throw new BlobError('signature_mismatch', { message: `stored ${head.size} bytes, ${t.size} were declared` });
    }

    const blob = { ...r2.blobObject(t.path, head.size, head.etag, head.uploadedAt), contentType: head.contentType };
    details.metadata = head.metadata;
    let data: unknown;
    if (options.onUploadComplete) {
      try {
        data = await options.onUploadComplete({
          request,
          route: options.route,
          file,
          uploadId: t.id,
          multipartUploadId: t.uploadId,
          ...blob,
          metadata: head.metadata,
          state: t.ctx,
        });
      } catch (e) {
        // The intent: the object exists only if onUploadComplete returned. On a private bucket that
        // holds. On a public bucket it does not -- the object has been readable since
        // completeMultipart, through the head above and through the whole of this callback, which is
        // app code and unbounded. The delete ends the storage, not the exposure.
        await discard(t.path, completedEtag);
        throw e;
      }
    }
    return { blob: { ...blob, uploadedAt: blob.uploadedAt.toISOString() }, data };
  }

  /**
   * Deletes the object a rejected upload left behind, unless it is no longer that object. R2 has no
   * conditional delete, so this re-reads the etag first: on a stable path a later upload can already
   * have replaced these bytes, and deleting then would destroy a file that was accepted.
   */
  async function discard(path: string, etag: string | undefined): Promise<void> {
    try {
      if (etag) {
        const current = await r2.head(path);
        if (!current) return;
        if (current.etag !== etag) {
          console.warn(`[upstash-blob] refused upload ${JSON.stringify(path)} was replaced before it could be deleted; leaving the newer object alone`);
          return;
        }
      }
      const res = await r2.fetch({ method: 'DELETE', path });
      await res.body?.cancel();
      if (!res.ok && res.status !== 404) throw new Error(`storage responded ${res.status}`);
    } catch (e) {
      // The refusal is the answer; a delete that fails must not replace it with its own error. But
      // the object it leaves behind is one no callback accepted, so it is not left behind silently.
      console.error(`[upstash-blob] refused upload ${JSON.stringify(path)} could not be deleted and is still stored`, e);
    }
  }

  async function cancel(body: any, details: ErrorDetails): Promise<{ ok: true }> {
    const t = await verify(body.completionToken, details);
    await r2.abortMultipart(t.path, t.uploadId);
    return { ok: true };
  }

  async function verify(token: unknown, details: ErrorDetails): Promise<TokenPayload> {
    if (typeof token !== 'string') throw new BlobError('invalid_input', { message: 'completionToken is required' });
    const t = await verifyToken(token, tokenKey());
    if (!t || t.b !== r2.bucketId || t.r !== routeId) throw new BlobError('forbidden', { message: 'completionToken is not valid for this route' });
    if (t.exp < Date.now()) throw new BlobError('forbidden', { message: 'completionToken has expired' });
    details.path = t.path;
    details.state = t.ctx;
    return t;
  }

  function tokenKey(): string {
    return r2.signingSecret;
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

  return { GET, POST };
}

/**
 * Every refusal leaves a route as BlobError.toJSON(), so the browser rebuilds it with its code
 * intact and callers switch on error.code instead of reading status numbers and message text.
 */
export async function answerError(e: unknown, request: Request, onError: ErrorMapper | undefined, details: ErrorDetails = {}): Promise<Response> {
  if (onError) {
    const mapped = await onError(e, request, details);
    if (mapped instanceof Response) return mapped;
    if (BlobError.is(mapped)) return Response.json(mapped.toJSON(), { status: mapped.status });
  }
  if (BlobError.is(e)) return Response.json(e.toJSON(), { status: e.status });
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
 * the refusing. Short and revalidated, not immutable -- the constraints are the route's own code and
 * change with a deploy, and a client that cached them forever refuses files the route now accepts.
 */
export function constraintsEndpoint(routeConstraints: ResolvedConstraints): (request: Request) => Promise<Response> {
  const wireConstraints: WireConstraints = {};
  if (routeConstraints.contentTypes) wireConstraints.contentTypes = routeConstraints.contentTypes;
  if (routeConstraints.maxBytes !== undefined) wireConstraints.maxBytes = routeConstraints.maxBytes;
  const body = JSON.stringify({ constraints: wireConstraints } satisfies WireConstraintsResponse);
  const etag = `"${hash(body)}"`;
  return async (request: Request): Promise<Response> => {
    const headers = { 'content-type': 'application/json', 'cache-control': `public, max-age=${LIMITS_MAX_AGE}`, etag };
    if (request?.headers?.get('if-none-match') === etag) return new Response(null, { status: 304, headers });
    return new Response(body, { headers });
  };
}

/**
 * The route's Standard Schema against what the browser sent, as invalid_input rather than whatever
 * the validator throws. A route with no schema refuses input rather than dropping it silently.
 */
export async function validateInput(schema: StandardSchema<any, any> | undefined, raw: unknown): Promise<unknown> {
  if (!schema) {
    if (raw !== undefined) throw new BlobError('invalid_input', { message: 'this route takes no input' });
    return undefined;
  }
  const result = await schema['~standard'].validate(raw);
  if (result.issues) {
    throw new BlobError('invalid_input', { message: result.issues.map((i) => (i.path?.length ? `${i.path.map((p) => (typeof p === 'object' ? String(p.key) : String(p))).join('.')}: ` : '') + i.message).join('; ') });
  }
  return result.value;
}

export interface ResolvedConstraints {
  contentTypes: string[] | undefined;
  maxBytes: number | undefined;
}

export function resolveConstraints(constraints: UploadConstraints | undefined): ResolvedConstraints {
  return {
    contentTypes: constraints?.contentTypes === undefined ? undefined : expandContentTypes(constraints.contentTypes),
    maxBytes: constraints?.maxBytes === undefined ? undefined : parseSize(constraints.maxBytes, 'maxBytes'),
  };
}

export function enforce(constraints: ResolvedConstraints, file: UploadFile, head?: Uint8Array): void {
  if (constraints.maxBytes !== undefined && file.size > constraints.maxBytes) {
    throw new BlobError('too_large', { message: `${file.name} is ${formatBytes(file.size)}, over the ${formatBytes(constraints.maxBytes)} limit` });
  }
  if (constraints.contentTypes) checkContentType(file.type, head, constraints.contentTypes);
}

/** The leading bytes a browser may send at 'begin', base64. Anything unreadable is simply no head. */
function readHead(raw: unknown): Uint8Array | undefined {
  if (typeof raw !== 'string' || raw.length === 0) return undefined;
  try {
    const bin = atob(raw);
    const out = new Uint8Array(Math.min(bin.length, SNIFF_BYTES));
    for (let i = 0; i < out.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return undefined;
  }
}

function readFile(raw: unknown): UploadFile {
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

export function deriveRouteId(constraints: { contentTypes: string[] | undefined; maxBytes: number | undefined }, hasInput: boolean, route?: string): string {
  return hash(JSON.stringify([route ?? null, constraints.contentTypes ?? null, constraints.maxBytes ?? null, hasInput]));
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
