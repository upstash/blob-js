export type BlobErrorCode =
  | 'not_found'
  | 'already_exists'
  | 'conflict'
  | 'content_type_not_allowed'
  | 'invalid_input'
  | 'too_large'
  | 'empty_body'
  | 'length_required'
  | 'signature_mismatch'
  | 'unauthorized'
  | 'forbidden'
  | 'rate_limited'
  | 'mint_backoff'
  | 'not_ready'
  | 'partial_delete'
  | 'move_left_a_copy'
  | 'invalid_content_type_pattern'
  | 'request_failed';

export const STATUS: Record<BlobErrorCode, number> = {
  not_found: 404,
  already_exists: 409,
  conflict: 409,
  content_type_not_allowed: 400,
  invalid_input: 400,
  too_large: 413,
  empty_body: 400,
  length_required: 411,
  signature_mismatch: 403,
  unauthorized: 401,
  forbidden: 403,
  rate_limited: 429,
  mint_backoff: 429,
  not_ready: 503,
  partial_delete: 500,
  move_left_a_copy: 500,
  invalid_content_type_pattern: 500,
  request_failed: 500,
};

const DEFAULT_MESSAGE: Record<BlobErrorCode, string> = {
  not_found: 'not found',
  already_exists: 'already exists',
  conflict: 'the object changed since it was read',
  content_type_not_allowed: 'content type not allowed',
  invalid_input: 'invalid input',
  too_large: 'too large',
  empty_body: 'empty body',
  length_required: 'length required',
  signature_mismatch: 'signature mismatch',
  unauthorized: 'unauthorized',
  forbidden: 'forbidden',
  rate_limited: 'rate limited',
  mint_backoff: 'the credential service asked for a backoff longer than a request can wait',
  not_ready: 'bucket is not ready',
  partial_delete: 'some paths were not deleted',
  move_left_a_copy: 'move left a copy at the source',
  invalid_content_type_pattern: 'invalid content type pattern',
  request_failed: 'request failed',
};

const DEFAULT_HINT: Partial<Record<BlobErrorCode, string>> = {
  signature_mismatch: 'a 403 from R2 usually means the body length or type differs from the signature',
  length_required: 'pass { size } or { maxSize } so the length is known before the first byte',
};

/**
 * For the 413 a proxied upload gets from the platform, never from maxSize: the body never reached
 * the route, so the error carries no code of its own. Doc-sourced, not measured.
 */
export const PLATFORM_BODY_CAP_HINT = 'Vercel caps a serverless request body at 4.5MB, AWS Lambda at 6MB, Cloudflare at 100MB on the free plan';

/**
 * The code a bare HTTP status means, for a route that answered with a status and no code of its own:
 * an auth check that threw its own 401, a platform that refused the body at 413. Without it every
 * such answer arrives as request_failed and the caller has to read status numbers to tell a dead
 * session from a rejected file.
 */
const CODE_FOR_STATUS: Partial<Record<number, BlobErrorCode>> = {
  401: 'unauthorized',
  403: 'forbidden',
  404: 'not_found',
  409: 'conflict',
  411: 'length_required',
  413: 'too_large',
  429: 'rate_limited',
};

export interface BlobErrorOptions {
  message?: string;
  hint?: string;
  status?: number;
  /** partial_delete: the paths that survived. */
  failed?: string[];
  /** already_exists: what is already there. */
  etag?: string;
  size?: number;
  /** mint_backoff and rate_limited: seconds the service asked the caller to wait. */
  retryAfter?: number;
  cause?: unknown;
}

const MARK = Symbol.for('@upstash/blob/BlobError');

/**
 * Messages are written lowercase here and read by people there: an app prints e.message straight
 * into its error line, and every app doing that wrote its own capitalize() first. A message that
 * opens with an identifier -- a MIME type, a file name, a metadata key -- keeps its case, because
 * 'Image/png is not allowed' names a type that does not exist and 'Cat.png' is not the file the
 * user picked.
 */
const OPENS_WITH_IDENTIFIER = /^[a-z][\w+*-]*[./][\w.+*/-]*/;

function sentenceCase(message: string): string {
  if (OPENS_WITH_IDENTIFIER.test(message)) return message;
  return message.charAt(0).toUpperCase() + message.slice(1);
}

// e.message never carries a credential, a token, or an internal path. Every message assembled
// here comes from a code, a caller-supplied string, or an HTTP status.
export class BlobError extends Error {
  readonly code: BlobErrorCode;
  readonly status: number;
  readonly hint: string | undefined;
  readonly failed: string[] | undefined;
  readonly etag: string | undefined;
  readonly size: number | undefined;
  readonly retryAfter: number | undefined;
  readonly [MARK] = true;

  constructor(code: BlobErrorCode, options: BlobErrorOptions | string = {}) {
    const o = typeof options === 'string' ? { message: options } : options;
    const raw = o.message ?? DEFAULT_MESSAGE[code];
    const hint = o.hint ?? DEFAULT_HINT[code];
    // The fold is decided on the message as written: the hint is lowercase, and a message that
    // already carries it has just had its own first letter raised.
    const base = sentenceCase(raw);
    super(hint && !raw.includes(hint) ? `${base} (${hint})` : base, o.cause === undefined ? undefined : { cause: o.cause });
    this.name = 'BlobError';
    this.code = code;
    this.status = o.status ?? STATUS[code];
    this.hint = hint;
    this.failed = o.failed;
    this.etag = o.etag;
    this.size = o.size;
    this.retryAfter = o.retryAfter;
  }

  /** The best code for a status that arrived without one, falling back to request_failed. */
  static fromStatus(status: number, options: BlobErrorOptions = {}): BlobError {
    return new BlobError(CODE_FOR_STATUS[status] ?? 'request_failed', { ...options, status });
  }

  // is(), not instanceof: an ESM and a CJS copy of this class are two classes.
  static is(e: unknown): e is BlobError {
    return typeof e === 'object' && e !== null && (e as any)[MARK] === true;
  }

  toJSON(): { code: BlobErrorCode; message: string; status: number; hint?: string; failed?: string[]; etag?: string; size?: number; retryAfter?: number } {
    return {
      code: this.code,
      message: this.message,
      status: this.status,
      ...(this.hint ? { hint: this.hint } : {}),
      ...(this.failed ? { failed: this.failed } : {}),
      ...(this.etag ? { etag: this.etag } : {}),
      ...(this.size !== undefined ? { size: this.size } : {}),
      ...(this.retryAfter !== undefined ? { retryAfter: this.retryAfter } : {}),
    };
  }

  /** Rebuild from a JSON body a route wrote with toJSON(); undefined when the body is not one. */
  static fromJSON(body: unknown, status?: number): BlobError | undefined {
    if (typeof body !== 'object' || body === null) return undefined;
    const b = body as Record<string, unknown>;
    if (typeof b.code !== 'string' || !(b.code in STATUS)) return undefined;
    const message = typeof b.message === 'string' ? b.message : undefined;
    return new BlobError(b.code as BlobErrorCode, {
      message,
      hint: typeof b.hint === 'string' ? b.hint : undefined,
      status: status ?? (typeof b.status === 'number' ? b.status : undefined),
      failed: Array.isArray(b.failed) ? (b.failed as string[]) : undefined,
      etag: typeof b.etag === 'string' ? b.etag : undefined,
      size: typeof b.size === 'number' ? b.size : undefined,
      retryAfter: typeof b.retryAfter === 'number' ? b.retryAfter : undefined,
    });
  }
}
