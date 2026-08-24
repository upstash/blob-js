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
  not_ready: 'bucket is not ready',
  partial_delete: 'some paths were not deleted',
  move_left_a_copy: 'move left a copy at the source',
  invalid_content_type_pattern: 'invalid content type pattern',
  request_failed: 'request failed',
};

const DEFAULT_HINT: Partial<Record<BlobErrorCode, string>> = {
  signature_mismatch: 'a 403 from R2 usually means the body length or type differs from the signature',
  length_required: 'pass { size } or { maxBytes } so the length is known before the first byte',
};

/**
 * For the 413 a proxied upload gets from the platform, never from maxBytes: the body never reached
 * the route, so the error carries no code of its own. Doc-sourced, not measured.
 */
export const PLATFORM_BODY_CAP_HINT = 'Vercel caps a serverless request body at 4.5MB, AWS Lambda at 6MB, Cloudflare at 100MB on the free plan';

export interface BlobErrorOptions {
  message?: string;
  hint?: string;
  status?: number;
  /** partial_delete: the paths that survived. */
  failed?: string[];
  /** already_exists: what is already there. */
  etag?: string;
  size?: number;
  cause?: unknown;
}

const MARK = Symbol.for('@upstash/blob/BlobError');

// e.message never carries a credential, a token, or an internal path. Every message assembled
// here comes from a code, a caller-supplied string, or an HTTP status.
export class BlobError extends Error {
  readonly code: BlobErrorCode;
  readonly status: number;
  readonly hint: string | undefined;
  readonly failed: string[] | undefined;
  readonly etag: string | undefined;
  readonly size: number | undefined;
  readonly [MARK] = true;

  constructor(code: BlobErrorCode, options: BlobErrorOptions | string = {}) {
    const o = typeof options === 'string' ? { message: options } : options;
    const base = o.message ?? DEFAULT_MESSAGE[code];
    const hint = o.hint ?? DEFAULT_HINT[code];
    super(hint && !base.includes(hint) ? `${base} (${hint})` : base, o.cause === undefined ? undefined : { cause: o.cause });
    this.name = 'BlobError';
    this.code = code;
    this.status = o.status ?? STATUS[code];
    this.hint = hint;
    this.failed = o.failed;
    this.etag = o.etag;
    this.size = o.size;
  }

  // is(), not instanceof: an ESM and a CJS copy of this class are two classes.
  static is(e: unknown): e is BlobError {
    return typeof e === 'object' && e !== null && (e as any)[MARK] === true;
  }

  toJSON(): { code: BlobErrorCode; message: string; status: number; hint?: string; failed?: string[]; etag?: string; size?: number } {
    return {
      code: this.code,
      message: this.message,
      status: this.status,
      ...(this.hint ? { hint: this.hint } : {}),
      ...(this.failed ? { failed: this.failed } : {}),
      ...(this.etag ? { etag: this.etag } : {}),
      ...(this.size !== undefined ? { size: this.size } : {}),
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
    });
  }
}
