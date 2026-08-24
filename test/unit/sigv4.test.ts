import { describe, expect, test } from 'bun:test';
import { HttpRequest } from '@smithy/core/protocols';
import { Hash } from '@smithy/core/serde';
import { SignatureV4 } from '@smithy/signature-v4';
import { amzDate, presign, sha256Hex, signHeaders, uriEncode } from '../../src/server/sigv4.ts';

const R2_HOST = 'acct.r2.cloudflarestorage.com';

const CREDS = {
  accessKeyId: 'AKIAEXAMPLE',
  secretAccessKey: 'secretsecretsecret',
  sessionToken: 'tok/en+123',
  region: 'auto',
};

const DATE = new Date('2026-08-24T12:34:56.000Z');

// uriEscapePath false is the S3 rule: the path is canonicalised once, not twice. applyChecksum
// false keeps the oracle from inventing an x-amz-content-sha256 we did not ask for; the header is
// set explicitly instead so both sides sign UNSIGNED-PAYLOAD.
function oracle(sessionToken?: string) {
  return new SignatureV4({
    credentials: {
      accessKeyId: CREDS.accessKeyId,
      secretAccessKey: CREDS.secretAccessKey,
      ...(sessionToken ? { sessionToken } : {}),
    },
    region: CREDS.region,
    service: 's3',
    sha256: Hash.bind(null, 'sha256') as any,
    uriEscapePath: false,
    applyChecksum: false,
  });
}

describe('presign', () => {
  // AWS S3 docs, "Authenticating Requests: Using Query Parameters (AWS Signature Version 4)",
  // example GET. The secret in this vector is the slash variant: wJalrXUtnFEMI/K7MDENG/bPx...,
  // not the plus variant used elsewhere in AWS examples. Swapping them changes the signature.
  test('matches the AWS documentation vector', async () => {
    const url = await presign(
      {
        accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
        secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
        region: 'us-east-1',
        service: 's3',
      },
      {
        method: 'GET',
        url: 'https://examplebucket.s3.amazonaws.com/test.txt',
        expiresIn: 86400,
        date: new Date('2013-05-24T00:00:00Z'),
      },
    );

    const query = url.slice(url.indexOf('?') + 1);
    expect(url.slice(0, url.indexOf('?'))).toBe('https://examplebucket.s3.amazonaws.com/test.txt');
    expect(query).toContain('X-Amz-Algorithm=AWS4-HMAC-SHA256');
    expect(query).toContain('X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20130524%2Fus-east-1%2Fs3%2Faws4_request');
    expect(query).toContain('X-Amz-Date=20130524T000000Z');
    expect(query).toContain('X-Amz-Expires=86400');
    expect(query).toContain('X-Amz-SignedHeaders=host');
    expect(query).toContain('X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404');
    expect(query).not.toContain('X-Amz-Security-Token');
  });

  test('matches the @smithy/signature-v4 oracle', async () => {
    const path = '/bucket-id/some%20key/x.png';
    const url = `https://${R2_HOST}${path}?uploadId=abc%2Fdef&partNumber=3`;

    const expected = await oracle(CREDS.sessionToken).presign(
      new HttpRequest({
        method: 'PUT',
        protocol: 'https:',
        hostname: R2_HOST,
        path,
        query: { uploadId: 'abc/def', partNumber: '3' },
        headers: { host: R2_HOST, 'content-length': '12' },
        // Any body the oracle cannot hash makes its payload hash UNSIGNED-PAYLOAD, which is what
        // presign() always signs. A sha256 header would be hoisted into the query instead.
        body: { unhashable: true },
      }),
      { signingDate: DATE, expiresIn: 900 },
    );

    const actual = new URL(
      await presign(CREDS, {
        method: 'PUT',
        url,
        expiresIn: 900,
        date: DATE,
        signedHeaders: { 'content-length': '12' },
      }),
    );

    expect(actual.searchParams.get('X-Amz-Signature')).toBe(expected.query?.['X-Amz-Signature'] as string);
    expect(actual.searchParams.get('X-Amz-SignedHeaders')).toBe('content-length;host');
    expect(actual.searchParams.get('X-Amz-Security-Token')).toBe(CREDS.sessionToken);
    expect(actual.pathname).toBe(path);
  });

  test('omits the session token when the credentials carry none', async () => {
    const url = await presign(
      { accessKeyId: CREDS.accessKeyId, secretAccessKey: CREDS.secretAccessKey, region: 'auto' },
      { method: 'GET', url: `https://${R2_HOST}/b/k`, expiresIn: 60, date: DATE },
    );
    expect(url).not.toContain('X-Amz-Security-Token');
  });

  test('sorts the canonical query by encoded key then value', async () => {
    const url = await presign(CREDS, {
      method: 'GET',
      url: `https://${R2_HOST}/b/k?z=1&a=2&b=2&b=1`,
      expiresIn: 60,
      date: DATE,
    });

    const query = url.slice(url.indexOf('?') + 1);
    const pairs = query.split('&');
    // Uppercase sorts before lowercase, so every X-Amz-* param precedes the caller's. Repeated
    // keys break the tie on the encoded value, and the signature is appended after the canonical
    // string rather than sorted into it.
    expect(pairs.slice(0, -1)).toEqual([
      'X-Amz-Algorithm=AWS4-HMAC-SHA256',
      'X-Amz-Credential=AKIAEXAMPLE%2F20260824%2Fauto%2Fs3%2Faws4_request',
      'X-Amz-Date=20260824T123456Z',
      'X-Amz-Expires=60',
      'X-Amz-Security-Token=tok%2Fen%2B123',
      'X-Amz-SignedHeaders=host',
      'a=2',
      'b=1',
      'b=2',
      'z=1',
    ]);
    expect(pairs.at(-1)).toBe(`X-Amz-Signature=${new URL(url).searchParams.get('X-Amz-Signature')}`);
  });
});

describe('signHeaders', () => {
  test('matches the @smithy/signature-v4 oracle', async () => {
    const path = '/bucket-id/some%20key/x.png';
    const url = `https://${R2_HOST}${path}?partNumber=3&uploadId=abc%2Fdef`;
    const headers = { 'content-type': 'image/png', 'content-length': '12', 'x-amz-meta-foo': 'bar baz' };

    const expected = await oracle(CREDS.sessionToken).sign(
      new HttpRequest({
        method: 'PUT',
        protocol: 'https:',
        hostname: R2_HOST,
        path,
        query: { partNumber: '3', uploadId: 'abc/def' },
        headers: { host: R2_HOST, ...headers, 'x-amz-content-sha256': 'UNSIGNED-PAYLOAD' },
      }),
      { signingDate: DATE },
    );

    const actual = await signHeaders(CREDS, { method: 'PUT', url, headers, date: DATE });

    expect(actual.authorization).toBe(expected.headers.authorization as string);
    expect(actual.authorization).toContain('Credential=AKIAEXAMPLE/20260824/auto/s3/aws4_request');
    expect(actual.authorization).toContain(
      'SignedHeaders=content-length;content-type;host;x-amz-content-sha256;x-amz-date;x-amz-meta-foo;x-amz-security-token',
    );
    // host is signed but never returned: fetch sets it and rejects it as a request header.
    expect(actual.host).toBeUndefined();
    expect(actual['x-amz-date']).toBe('20260824T123456Z');
    expect(actual['x-amz-content-sha256']).toBe('UNSIGNED-PAYLOAD');
    expect(actual['x-amz-security-token']).toBe(CREDS.sessionToken);
  });

  test('omits the security token header when the credentials carry none', async () => {
    const actual = await signHeaders(
      { accessKeyId: CREDS.accessKeyId, secretAccessKey: CREDS.secretAccessKey, region: 'auto' },
      { method: 'GET', url: `https://${R2_HOST}/b/k`, date: DATE },
    );
    expect(actual['x-amz-security-token']).toBeUndefined();
    expect(actual.authorization).not.toContain('x-amz-security-token');
  });
});

describe('uriEncode', () => {
  test('percent-encodes everything outside the unreserved set', () => {
    expect(uriEncode('a b')).toBe('a%20b');
    expect(uriEncode('a/b')).toBe('a%2Fb');
    expect(uriEncode('a/b', true)).toBe('a/b');
    expect(uriEncode('A-Za-z0-9-_.~')).toBe('A-Za-z0-9-_.~');
    expect(uriEncode("*!()'")).toBe('%2A%21%28%29%27');
    expect(uriEncode('+=&?#%')).toBe('%2B%3D%26%3F%23%25');
  });

  test('encodes non-ASCII as uppercase-hex UTF-8 bytes', () => {
    expect(uriEncode('é')).toBe('%C3%A9');
    expect(uriEncode('日本')).toBe('%E6%97%A5%E6%9C%AC');
    expect(uriEncode('🙂')).toBe('%F0%9F%99%82');
  });

  test('keepSlash leaves only the slash alone', () => {
    expect(uriEncode('dir name/sub/f~1.png', true)).toBe('dir%20name/sub/f~1.png');
  });
});

describe('amzDate', () => {
  test('renders the basic ISO 8601 form', () => {
    expect(amzDate(new Date('2026-08-24T12:34:56.789Z'))).toEqual({ amz: '20260824T123456Z', day: '20260824' });
    expect(amzDate(new Date(0))).toEqual({ amz: '19700101T000000Z', day: '19700101' });
  });
});

describe('sha256Hex', () => {
  test('hashes the empty string', async () => {
    expect(await sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });

  test('hashes strings as UTF-8 and accepts bytes', async () => {
    expect(await sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(await sha256Hex(new TextEncoder().encode('abc'))).toBe(await sha256Hex('abc'));
  });
});
