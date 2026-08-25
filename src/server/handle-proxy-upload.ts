import { BlobError } from '../shared/errors.ts';
import type { BlobObject, ProxyUploadResponse, UploadRoute, WireFile, WireLimits } from '../shared/types.ts';
import { formatSize, type CacheOption, type Size } from '../shared/units.ts';
import { type Bucket } from './bucket.ts';
import { answerError, enforce, limitsEndpoint, resolveLimits, stateOf, validateInput, type StandardSchema, type UploadLimits } from './handle-upload.ts';

type InferOutput<S> = S extends StandardSchema<any, infer O> ? O : never;
type ProxyInput<TSchema> = TSchema extends StandardSchema<any, any> ? InferOutput<TSchema> : undefined;

/**
 * The other half of handleUpload: the upload that goes through your function instead of straight to
 * storage, for when the bytes have to be checked before they are stored rather than after.
 *
 * handleUpload cannot do that. It presigns, the browser PUTs, and phase 'end' reads the object back
 * to sniff it -- so at a path that is overwritten in place (an avatar), a refused file has already
 * replaced the one it was refused in favour of. put() checks first: the leading bytes against
 * allowedContentTypes and the stream against maxBytes, before anything reaches the bucket.
 *
 * The cost is that every byte crosses your function, so it is bounded by the platform's request body
 * cap (Vercel 4.5MB, AWS Lambda 6MB, Cloudflare 100MB): keep maxBytes well inside it and use
 * handleUpload for anything larger.
 *
 * GET answers the same limits document handleUpload's does, so useUploadProxy fills a file picker
 * from the route's own list and refuses an oversize file before it is sent.
 */

export interface ProxyBeforeUploadArgs<TInput = undefined> {
  request: Request;
  file: WireFile;
  /** The `input` form field, parsed as JSON and validated. `undefined` on a route with no schema. */
  input: TInput;
}

export interface ProxyBeforeUploadResult<TState> {
  path: string;
  cache?: CacheOption;
  metadata?: Record<string, string>;
  /** May narrow the route's limits per user, never widen them. */
  limits?: UploadLimits;
  /** false: If-None-Match: * server-side, so a second upload to the same path is a real 412. */
  overwrite?: boolean;
  /** Carried to onUploadCompleted and onBeforeUploadFailed. */
  state?: TState;
  /** @deprecated renamed to `state`; still read for one minor. */
  context?: TState;
}

export interface ProxyBeforeUploadFailedArgs<TInput, TState> extends ProxyBeforeUploadArgs<TInput> {
  /** What onBeforeUpload returned: the row it reserved is reachable through its state. */
  decided: ProxyBeforeUploadResult<TState>;
  error: BlobError;
}

export interface ProxyUploadCompletedArgs<TState> extends BlobObject {
  request: Request;
  /** What R2 stored, canonicalised and proven by the leading bytes: not what the browser claimed. */
  contentType: string;
  metadata: Record<string, string>;
  /** What onBeforeUpload returned as `state`. */
  state: TState;
  /** @deprecated renamed to `state`; the same value for one minor. */
  context: TState;
}

export interface HandleProxyUploadOptions<TSchema extends StandardSchema<any, any> | undefined, TState, TData, TRoute extends string = string> {
  bucket: Bucket;
  /** The URL this route is mounted at, so `route` on useUploadProxy is typed to it. */
  route?: TRoute;
  /** Refused before the body is read when content-length says so, and again from the stream. */
  limits?: UploadLimits;
  /** The form field the file arrives in. Default 'file'; a request that is not multipart is the body itself. */
  field?: string;
  /**
   * A Standard Schema for the `input` form field, which the browser sends as JSON beside the file.
   * A raw body carries no fields, so a route that declares one only accepts multipart requests.
   */
  input?: TSchema;
  onBeforeUpload: (args: ProxyBeforeUploadArgs<ProxyInput<TSchema>>) => ProxyBeforeUploadResult<TState> | Promise<ProxyBeforeUploadResult<TState>>;
  /**
   * onBeforeUpload accepted the upload but storing it failed, so nothing will ever complete: release
   * the row it reserved here. The error is rethrown to the client afterwards.
   */
  onBeforeUploadFailed?: (args: ProxyBeforeUploadFailedArgs<ProxyInput<TSchema>, TState>) => void | Promise<void>;
  onUploadCompleted?: (args: ProxyUploadCompletedArgs<TState>) => TData | Promise<TData>;
  /**
   * Maps anything a callback threw that is not a BlobError. Return a BlobError or a Response to
   * answer with it; return nothing to fall through. An error carrying a numeric `status` becomes
   * that status without this hook.
   */
  onError?: (error: unknown, request: Request) => BlobError | Response | void | Promise<BlobError | Response | void>;
}

export interface ProxyUploadHandlers<TInput, TData, TRoute extends string = string> {
  GET: (request: Request) => Promise<Response>;
  POST: UploadRoute<TInput, TData, TRoute, true>;
}

export function handleProxyUpload<TSchema extends StandardSchema<any, any> | undefined = undefined, TState = undefined, TData = void, TRoute extends string = string>(
  options: HandleProxyUploadOptions<TSchema, TState, TData, TRoute>,
): ProxyUploadHandlers<ProxyInput<TSchema>, TData, TRoute> {
  const routeLimits = resolveLimits(options.limits);
  const field = options.field ?? 'file';
  const GET = limitsEndpoint(routeLimits, 'proxy');

  const POST = async (request: Request): Promise<Response> => {
    try {
      // Before the body is read, so a file far over the limit costs a header rather than the memory
      // to hold it. A multipart body is the file plus a boundary and part headers, and refusing on
      // that total would refuse a file exactly at the limit: the envelope is allowed for, and the
      // exact check is enforce() below, against the file's own size.
      const declared = Number(request.headers.get('content-length'));
      const ceiling = routeLimits.maxBytes === undefined ? undefined : routeLimits.maxBytes + (isMultipart(request) ? ENVELOPE_SLACK : 0);
      if (ceiling !== undefined && Number.isFinite(declared) && declared > ceiling) {
        throw new BlobError('too_large', { message: `the request body is ${formatSize(declared)}, over the ${formatSize(routeLimits.maxBytes!)} limit` });
      }

      const body = await readBody(request, field, routeLimits.maxBytes);
      const file: WireFile = { name: body.name, type: normalizeType(body.type), size: body.size };
      enforce(routeLimits, file);

      const input = (await validateInput(options.input, body.input)) as ProxyInput<TSchema>;
      const decided = await options.onBeforeUpload({ request, file, input });
      if (!decided || typeof decided.path !== 'string') throw new TypeError('onBeforeUpload must return { path }');

      let limits = routeLimits;
      if (decided.limits) {
        const narrowed = resolveLimits(decided.limits);
        if (narrowed.maxBytes !== undefined && routeLimits.maxBytes !== undefined && narrowed.maxBytes > routeLimits.maxBytes) {
          throw new TypeError(`onBeforeUpload widened maxBytes (${narrowed.maxBytes} > ${routeLimits.maxBytes})`);
        }
        if (narrowed.allowedContentTypes && routeLimits.allowedContentTypes) {
          const wider = narrowed.allowedContentTypes.filter((t) => !routeLimits.allowedContentTypes!.includes(t));
          if (wider.length) throw new TypeError(`onBeforeUpload widened allowedContentTypes (${wider.join(', ')})`);
        }
        // Merged, never replaced. Narrowing only maxBytes would otherwise drop the route's type list
        // and with it the byte sniff, which is the reason to send the upload through here at all.
        limits = {
          maxBytes: narrowed.maxBytes ?? routeLimits.maxBytes,
          allowedContentTypes: narrowed.allowedContentTypes ?? routeLimits.allowedContentTypes,
        };
        enforce(limits, file);
      }

      const metadata = decided.metadata ?? {};
      // put() sniffs the leading bytes against allowedContentTypes and caps the stream at maxBytes,
      // both before the first byte reaches the bucket. A refusal here stored nothing.
      let blob;
      try {
        blob = await options.bucket.put(decided.path, body.blob, {
          contentType: file.type,
          ...(limits.allowedContentTypes ? { allowedContentTypes: limits.allowedContentTypes } : {}),
          ...(limits.maxBytes === undefined ? {} : { maxBytes: limits.maxBytes as Size }),
          ...(decided.cache === undefined ? {} : { cache: decided.cache }),
          ...(decided.overwrite === undefined ? {} : { overwrite: decided.overwrite }),
          metadata,
        });
      } catch (e) {
        // The path is onBeforeUpload's to decide, so the row it reserved exists before the bytes do;
        // a put that fails afterwards is told back to the app instead of stranding it.
        const error = BlobError.is(e) ? e : new BlobError('request_failed', { message: 'could not store the upload', status: 502, cause: e });
        await options.onBeforeUploadFailed?.({ request, file, input, decided, error });
        throw error;
      }

      const state = stateOf(decided) as TState;
      let data: TData = undefined as TData;
      if (options.onUploadCompleted) {
        data = await options.onUploadCompleted({ request, ...blob, contentType: blob.contentType, metadata, state, context: state });
      }
      // The envelope phase 'end' answers with, so a proxied upload and a direct one land in the same
      // shape on the client and the two hooks stay interchangeable.
      const response: ProxyUploadResponse<TData> = { blob: { ...blob, uploadedAt: blob.uploadedAt.toISOString() }, data };
      return Response.json(response);
    } catch (e) {
      return await answerError(e, request, options.onError);
    }
  };

  return { GET, POST: POST as UploadRoute<ProxyInput<TSchema>, TData, TRoute, true> };
}

/**
 * A multipart boundary plus one part's headers, with room for a long filename. The pre-check only
 * has to stop a body that is obviously too big before it is read; being exact is enforce()'s job.
 */
const ENVELOPE_SLACK = 64 * 1024;

const isMultipart = (request: Request): boolean => (request.headers.get('content-type') ?? '').toLowerCase().startsWith('multipart/form-data');

interface ReadBody {
  blob: BlobLike;
  name: string;
  type: string;
  size: number;
  /** The `input` form field, still JSON. Never present on a raw body: it has no fields. */
  input?: unknown;
}

/** put() takes either; a stream is what keeps a chunked body from being buffered to refuse it. */
type BlobLike = Blob | ReadableStream<Uint8Array>;

/**
 * A multipart form's named field, or the whole request body when it is not one. Both are what a
 * browser sends for `start({ file })` and `start({ body })` respectively, so a route written this
 * way accepts either without the caller choosing an encoding.
 */
async function readBody(request: Request, field: string, maxBytes: number | undefined): Promise<ReadBody> {
  const contentType = (request.headers.get('content-type') ?? '').toLowerCase();
  if (!isMultipart(request)) {
    const declared = Number(request.headers.get('content-length'));
    const size = Number.isFinite(declared) && declared > 0 ? declared : undefined;
    // Handed to put() as a stream, not buffered here: a chunked body declares no length, and
    // reading it to find out how long it is is exactly what maxBytes is supposed to prevent.
    // put() caps the stream at maxBytes and refuses past it without holding the rest.
    const stream = request.body;
    if (!stream || size === 0) throw new BlobError('empty_body');
    // No length and no maxBytes: nothing to enforce and nothing to enforce it against, so the body
    // is read to find out how big it is. Declare maxBytes and this streams instead.
    if (size === undefined && maxBytes === undefined) {
      const blob = await request.blob();
      if (blob.size === 0) throw new BlobError('empty_body');
      return { blob, name: filenameOf(request), type: normalizeType(blob.type || contentType), size: blob.size };
    }
    return { blob: stream, name: filenameOf(request), type: normalizeType(contentType), size: size ?? 0 };
  }

  // formData() buffers: the platform's parser holds the whole body to split it, so the pre-check
  // above is the only thing standing between a multipart route and the memory to hold its body.
  const form = await request.formData().catch(() => {
    throw new BlobError('invalid_input', { message: 'the request body is not a valid multipart form' });
  });
  const value = form.get(field);
  if (!(value instanceof File)) throw new BlobError('invalid_input', { message: `the request needs a ${field} field holding the file` });
  if (value.size === 0) throw new BlobError('empty_body');
  return { blob: value, name: value.name, type: value.type, size: value.size, input: parseInputField(form.get('input')) };
}

/**
 * A raw body has no filename of its own; Content-Disposition is the only place one can arrive. Only
 * the `filename*=UTF-8''` form is percent-encoded: decoding the quoted form as well turned an
 * ordinary `filename="100%.png"` into a URIError and the route into a 500.
 */
function filenameOf(request: Request): string {
  const header = request.headers.get('content-disposition') ?? '';
  const encoded = /filename\*=\s*UTF-8''([^;]+)/i.exec(header);
  if (encoded?.[1]) {
    try {
      return decodeURIComponent(encoded[1].trim());
    } catch {
      return encoded[1].trim();
    }
  }
  const plain = /filename=\s*(?:"([^"]*)"|([^";]+))/i.exec(header);
  return (plain?.[1] ?? plain?.[2])?.trim() || 'upload';
}

/** The browser sends `input` as a JSON string beside the file; a form field cannot carry an object. */
function parseInputField(raw: FormDataEntryValue | null): unknown {
  if (typeof raw !== 'string') return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    throw new BlobError('invalid_input', { message: 'the input field is not valid JSON' });
  }
}

function normalizeType(type: string): string {
  return type ? type.toLowerCase().split(';')[0]!.trim() : 'application/octet-stream';
}

export type { WireLimits };
