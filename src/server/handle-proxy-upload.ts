import { BlobError } from '../shared/errors.ts';
import type { ProxyUploadResponse, UploadFile, WireLimits } from '../shared/types.ts';
import { formatBytes, type CacheOption, type Size } from '../shared/units.ts';
import { type Bucket } from './bucket.ts';
import { answerError, enforce, limitsEndpoint, resolveLimits, validateInput, type ErrorDetails, type ErrorMapper, type StandardSchema, type UploadLimits } from './handle-upload.ts';

/**
 * The other half of handleUpload, internal to `uploadHandler`: the upload that goes through your
 * function instead of straight to storage, for when the bytes have to be checked before they are
 * stored rather than after.
 *
 * The direct transport cannot do that. It presigns, the browser PUTs, and phase 'end' reads the
 * object back to sniff it -- so at a path that is overwritten in place (an avatar), a refused file
 * has already replaced the one it was refused in favour of. put() checks first: the leading bytes
 * against allowedContentTypes and the stream against maxBytes, before anything reaches the bucket.
 *
 * The cost is that every byte crosses your function, so it is bounded by the platform's request body
 * cap (Vercel 4.5MB, AWS Lambda 6MB, Cloudflare 100MB): keep maxBytes well inside it and leave
 * anything larger on the direct transport.
 *
 * GET answers the same limits document the direct transport's does, so the hook fills a file picker
 * from the route's own list and refuses an oversize file before it is sent.
 */

/** What the route decided about one file. `ctx` is added by the handler, not by this module. */
interface ProxyDecided {
  path: string;
  cache?: CacheOption;
  metadata?: Record<string, string>;
  limits?: UploadLimits;
  overwrite?: boolean;
  state?: unknown;
}

export interface InternalProxyUploadOptions {
  bucket: Bucket;
  /** The route's name, handed to every callback. '' for a handler that mounts no named routes. */
  route: string;
  /** Refused before the body is read when content-length says so, and again from the stream. */
  limits?: UploadLimits;
  /** The form field the file arrives in. Default 'file'; a request that is not multipart is the body itself. */
  field?: string;
  /**
   * A Standard Schema for the `input` form field, which the browser sends as JSON beside the file.
   * A raw body carries no fields, so a route that declares one only accepts multipart requests.
   */
  input?: StandardSchema<any, any> | undefined;
  onBeforeUpload: (args: { request: Request; route: string; file: UploadFile; input: unknown }) => ProxyDecided | Promise<ProxyDecided>;
  onUploadComplete?: (args: Record<string, unknown>) => unknown;
  onError?: ErrorMapper;
}

export interface InternalProxyUploadHandlers {
  GET: (request: Request) => Promise<Response>;
  POST: (request: Request) => Promise<Response>;
}

export function handleProxyUpload(options: InternalProxyUploadOptions): InternalProxyUploadHandlers {
  const routeLimits = resolveLimits(options.limits);
  const field = options.field ?? 'file';
  const GET = limitsEndpoint(routeLimits, 'proxy');

  const POST = async (request: Request): Promise<Response> => {
    const details: ErrorDetails = {};
    try {
      // Before the body is read, so a file far over the limit costs a header rather than the memory
      // to hold it. A multipart body is the file plus a boundary and part headers, and refusing on
      // that total would refuse a file exactly at the limit: the envelope is allowed for, and the
      // exact check is enforce() below, against the file's own size.
      const declared = Number(request.headers.get('content-length'));
      const ceiling = routeLimits.maxBytes === undefined ? undefined : routeLimits.maxBytes + (isMultipart(request) ? ENVELOPE_SLACK : 0);
      if (ceiling !== undefined && Number.isFinite(declared) && declared > ceiling) {
        throw new BlobError('too_large', { message: `the request body is ${formatBytes(declared)}, over the ${formatBytes(routeLimits.maxBytes!)} limit` });
      }

      const body = await readBody(request, field, routeLimits.maxBytes);
      const file: UploadFile = { name: body.name, type: normalizeType(body.type), size: body.size };
      details.file = file;
      enforce(routeLimits, file);

      const input = await validateInput(options.input, body.input);
      const decided = await options.onBeforeUpload({ request, route: options.route, file, input });
      if (!decided || typeof decided.path !== 'string') throw new TypeError('onBeforeUpload must return { path }');
      details.path = decided.path;
      details.state = decided.state;

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
      details.metadata = metadata;
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
        // The path is onBeforeUpload's to decide, so whatever it reserved exists before the bytes do;
        // a put that fails afterwards reaches onError with that path instead of stranding it.
        throw BlobError.is(e) ? e : new BlobError('request_failed', { message: 'could not store the upload', status: 502, cause: e });
      }

      let data: unknown;
      if (options.onUploadComplete) {
        try {
          data = await options.onUploadComplete({ request, route: options.route, file, ...blob, contentType: blob.contentType, metadata, state: decided.state });
        } catch (e) {
          // The invariant: the object exists only if onUploadComplete returned.
          await options.bucket.del(decided.path).catch(() => {});
          throw e;
        }
      }
      // The envelope phase 'end' answers with, so a proxied upload and a direct one land in the same
      // shape on the client and the two hooks stay interchangeable.
      const response: ProxyUploadResponse<unknown> = { blob: { ...blob, uploadedAt: blob.uploadedAt.toISOString() }, data };
      return Response.json(response);
    } catch (e) {
      return await answerError(e, request, options.onError, details);
    }
  };

  return { GET, POST };
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
