import { BlobError } from '../shared/errors.ts';
import type { BlobObject, UploadRoute, WireEndResponse, WireFile, WireLimits } from '../shared/types.ts';
import { formatSize, type CacheOption, type Size } from '../shared/units.ts';
import { type Bucket } from './bucket.ts';
import { answerError, enforce, limitsEndpoint, resolveLimits, type UploadLimits } from './handle-upload.ts';

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

export interface ProxyBeforeUploadArgs {
  request: Request;
  file: WireFile;
}

export interface ProxyBeforeUploadResult<TContext> {
  path: string;
  cache?: CacheOption;
  metadata?: Record<string, string>;
  /** May narrow the route's limits per user, never widen them. */
  limits?: UploadLimits;
  /** false: If-None-Match: * server-side, so a second upload to the same path is a real 412. */
  overwrite?: boolean;
  context?: TContext;
}

export interface ProxyUploadCompletedArgs<TContext> extends BlobObject {
  request: Request;
  /** What R2 stored, canonicalised and proven by the leading bytes: not what the browser claimed. */
  contentType: string;
  metadata: Record<string, string>;
  context: TContext;
}

export interface HandleProxyUploadOptions<TContext, TData, TRoute extends string = string> {
  bucket: Bucket;
  /** The URL this route is mounted at, so `route` on useUploadProxy is typed to it. */
  route?: TRoute;
  /** Refused before the body is read when content-length says so, and again from the stream. */
  limits?: UploadLimits;
  /** The form field the file arrives in. Default 'file'; a request that is not multipart is the body itself. */
  field?: string;
  onBeforeUpload: (args: ProxyBeforeUploadArgs) => ProxyBeforeUploadResult<TContext> | Promise<ProxyBeforeUploadResult<TContext>>;
  onUploadCompleted?: (args: ProxyUploadCompletedArgs<TContext>) => TData | Promise<TData>;
  /**
   * Maps anything a callback threw that is not a BlobError. Return a BlobError or a Response to
   * answer with it; return nothing to fall through. An error carrying a numeric `status` becomes
   * that status without this hook.
   */
  onError?: (error: unknown, request: Request) => BlobError | Response | void | Promise<BlobError | Response | void>;
}

export interface ProxyUploadHandlers<TData, TRoute extends string = string> {
  GET: (request: Request) => Promise<Response>;
  POST: UploadRoute<undefined, TData, TRoute>;
}

export function handleProxyUpload<TContext = undefined, TData = void, TRoute extends string = string>(
  options: HandleProxyUploadOptions<TContext, TData, TRoute>,
): ProxyUploadHandlers<TData, TRoute> {
  const routeLimits = resolveLimits(options.limits);
  const field = options.field ?? 'file';
  const GET = limitsEndpoint(routeLimits);

  const POST = async (request: Request): Promise<Response> => {
    try {
      // Before the body is buffered, so a file far over the limit is refused on its header rather
      // than after your function has held all of it in memory.
      const declared = Number(request.headers.get('content-length'));
      if (routeLimits.maxBytes !== undefined && Number.isFinite(declared) && declared > routeLimits.maxBytes) {
        throw new BlobError('too_large', { message: `the request body is ${formatSize(declared)}, over the ${formatSize(routeLimits.maxBytes)} limit` });
      }

      const body = await readBody(request, field);
      const file: WireFile = { name: body.name, type: normalizeType(body.type), size: body.size };
      enforce(routeLimits, file);

      const decided = await options.onBeforeUpload({ request, file });
      if (!decided || typeof decided.path !== 'string') throw new TypeError('onBeforeUpload must return { path }');

      let limits = routeLimits;
      if (decided.limits) {
        limits = resolveLimits(decided.limits);
        if (limits.maxBytes !== undefined && routeLimits.maxBytes !== undefined && limits.maxBytes > routeLimits.maxBytes) {
          throw new TypeError(`onBeforeUpload widened maxBytes (${limits.maxBytes} > ${routeLimits.maxBytes})`);
        }
        if (limits.allowedContentTypes && routeLimits.allowedContentTypes) {
          const wider = limits.allowedContentTypes.filter((t) => !routeLimits.allowedContentTypes!.includes(t));
          if (wider.length) throw new TypeError(`onBeforeUpload widened allowedContentTypes (${wider.join(', ')})`);
        }
        enforce(limits, file);
      }

      const metadata = decided.metadata ?? {};
      // put() sniffs the leading bytes against allowedContentTypes and caps the stream at maxBytes,
      // both before the first byte reaches the bucket. A refusal here stored nothing.
      const blob = await options.bucket.put(decided.path, body.blob, {
        contentType: file.type,
        ...(limits.allowedContentTypes ? { allowedContentTypes: limits.allowedContentTypes } : {}),
        ...(limits.maxBytes === undefined ? {} : { maxBytes: limits.maxBytes as Size }),
        ...(decided.cache === undefined ? {} : { cache: decided.cache }),
        ...(decided.overwrite === undefined ? {} : { overwrite: decided.overwrite }),
        metadata,
      });

      let data: TData = undefined as TData;
      if (options.onUploadCompleted) {
        data = await options.onUploadCompleted({ request, ...blob, contentType: blob.contentType, metadata, context: decided.context as TContext });
      }
      // The envelope phase 'end' answers with, so a proxied upload and a direct one land in the same
      // shape on the client and the two hooks stay interchangeable.
      const response: WireEndResponse<TData> = { blob: { ...blob, uploadedAt: blob.uploadedAt.toISOString() }, data };
      return Response.json(response);
    } catch (e) {
      return await answerError(e, request, options.onError);
    }
  };

  return { GET, POST: POST as UploadRoute<undefined, TData, TRoute> };
}

interface ReadBody {
  blob: Blob;
  name: string;
  type: string;
  size: number;
}

/**
 * A multipart form's named field, or the whole request body when it is not one. Both are what a
 * browser sends for `start({ file })` and `start({ body })` respectively, so a route written this
 * way accepts either without the caller choosing an encoding.
 */
async function readBody(request: Request, field: string): Promise<ReadBody> {
  const contentType = request.headers.get('content-type') ?? '';
  if (!contentType.startsWith('multipart/form-data')) {
    const blob = await request.blob();
    if (blob.size === 0) throw new BlobError('empty_body');
    return { blob, name: filenameOf(request), type: blob.type || contentType, size: blob.size };
  }

  const form = await request.formData().catch(() => {
    throw new BlobError('invalid_input', { message: 'the request body is not a valid multipart form' });
  });
  const value = form.get(field);
  if (!(value instanceof File)) throw new BlobError('invalid_input', { message: `a ${field} field is required` });
  if (value.size === 0) throw new BlobError('empty_body');
  return { blob: value, name: value.name, type: value.type, size: value.size };
}

/** A raw body has no filename of its own; Content-Disposition is the only place one can arrive. */
function filenameOf(request: Request): string {
  const match = /filename\*?=(?:UTF-8''|")?([^";]+)/i.exec(request.headers.get('content-disposition') ?? '');
  return match?.[1] ? decodeURIComponent(match[1]) : 'upload';
}

function normalizeType(type: string): string {
  return type ? type.toLowerCase().split(';')[0]!.trim() : 'application/octet-stream';
}

export type { WireLimits };
