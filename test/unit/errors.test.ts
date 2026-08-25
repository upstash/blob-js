import { describe, expect, test } from 'bun:test';
import { BlobError, type BlobErrorCode } from '../../src/shared/errors.ts';

// The table SPEC.tsx publishes. e.status is what a route answers with, so drift here is an API break.
const TABLE: Record<BlobErrorCode, number> = {
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

describe('status', () => {
  test('every code carries its documented status', () => {
    for (const [code, status] of Object.entries(TABLE)) {
      expect(new BlobError(code as BlobErrorCode).status).toBe(status);
    }
  });

  test('request_failed is the one code whose status the caller sets', () => {
    expect(new BlobError('request_failed', { status: 418 }).status).toBe(418);
    expect(new BlobError('request_failed').status).toBe(500);
  });

  test('every code has a message and none of them is empty', () => {
    for (const code of Object.keys(TABLE) as BlobErrorCode[]) {
      const e = new BlobError(code);
      expect(e.name).toBe('BlobError');
      expect(e.code).toBe(code);
      expect(e.message.length).toBeGreaterThan(0);
    }
  });
});

describe('message folds the hint in', () => {
  test('so e.message is the whole display text', () => {
    const e = new BlobError('length_required');
    expect(e.hint).toBe('pass { size } or { maxBytes } so the length is known before the first byte');
    expect(e.message).toBe(`length required (${e.hint})`);
  });

  test('a caller hint folds into a caller message', () => {
    const e = new BlobError('content_type_not_allowed', { message: 'text/html is not allowed', hint: 'allowed: image/png' });
    expect(e.message).toBe('text/html is not allowed (allowed: image/png)');
  });

  test('a message that already carries the hint is not doubled', () => {
    const e = new BlobError('length_required', { message: 'pass { size } or { maxBytes } so the length is known before the first byte' });
    expect(e.message).toBe('pass { size } or { maxBytes } so the length is known before the first byte');
  });

  test('a bare string is the message', () => {
    expect(new BlobError('forbidden', 'not your thread').message).toBe('not your thread');
  });

  test('maxBytes rejections do not carry the platform body cap hint', () => {
    const e = new BlobError('too_large', { message: 'body is 3000 bytes, over maxBytes (2000)' });
    expect(e.hint).toBeUndefined();
    expect(e.message).toBe('body is 3000 bytes, over maxBytes (2000)');
  });
});

describe('is()', () => {
  test('accepts a structurally identical error from another copy of the package', () => {
    const foreign = Object.assign(new Error('not found'), {
      [Symbol.for('@upstash/blob/BlobError')]: true,
      code: 'not_found',
      status: 404,
    });
    expect(foreign instanceof BlobError).toBe(false);
    expect(BlobError.is(foreign)).toBe(true);
    if (BlobError.is(foreign)) expect(foreign.status).toBe(404);
  });

  test('rejects anything else', () => {
    expect(BlobError.is(new Error('x'))).toBe(false);
    expect(BlobError.is({ code: 'not_found', status: 404 })).toBe(false);
    expect(BlobError.is(null)).toBe(false);
    expect(BlobError.is(undefined)).toBe(false);
    expect(BlobError.is('not_found')).toBe(false);
    expect(BlobError.is({ [Symbol.for('@upstash/blob/BlobError')]: 'yes' })).toBe(false);
  });

  test('accepts its own', () => {
    expect(BlobError.is(new BlobError('conflict'))).toBe(true);
  });
});

describe('toJSON / fromJSON', () => {
  test('round trips the fields a route sends over the wire', () => {
    const e = new BlobError('partial_delete', { message: '2 of 3 paths were not deleted', failed: ['a', 'b'] });
    const json = e.toJSON();
    expect(json).toEqual({ code: 'partial_delete', message: '2 of 3 paths were not deleted', status: 500, failed: ['a', 'b'] });

    const back = BlobError.fromJSON(JSON.parse(JSON.stringify(json)));
    expect(BlobError.is(back)).toBe(true);
    expect(back!.code).toBe('partial_delete');
    expect(back!.message).toBe(e.message);
    expect(back!.status).toBe(500);
    expect(back!.failed).toEqual(['a', 'b']);
  });

  test('carries already_exists { etag, size } and does not fold the hint twice', () => {
    const e = new BlobError('already_exists', { message: 'x already exists', etag: '"abc"', size: 3 });
    const back = BlobError.fromJSON(e.toJSON())!;
    expect(back.etag).toBe('"abc"');
    expect(back.size).toBe(3);
    expect(back.status).toBe(409);

    const hinted = BlobError.fromJSON(new BlobError('signature_mismatch').toJSON())!;
    expect(hinted.message).toBe(new BlobError('signature_mismatch').message);
  });

  test('an http status overrides the body', () => {
    expect(BlobError.fromJSON({ code: 'request_failed', message: 'nope' }, 418)!.status).toBe(418);
  });

  test('undefined when the body is not one of ours', () => {
    expect(BlobError.fromJSON(undefined)).toBeUndefined();
    expect(BlobError.fromJSON(null)).toBeUndefined();
    expect(BlobError.fromJSON('not_found')).toBeUndefined();
    expect(BlobError.fromJSON({ error: 'nope' })).toBeUndefined();
    expect(BlobError.fromJSON({ code: 'made_up' })).toBeUndefined();
  });
});
