// AWS Signature Version 4 over Web Crypto. Service 's3', UNSIGNED-PAYLOAD throughout, so bodies
// stream without a hash.

export interface SigningCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  region: string;
  service?: string;
}

export interface SignInput {
  method: string;
  url: string;
  headers?: Record<string, string>;
  /** Override the timestamp; tests only. */
  date?: Date;
}

export interface PresignInput extends SignInput {
  /** Seconds the URL stays valid, per X-Amz-Expires. */
  expiresIn: number;
  /** Header names (lowercase) that the requester must send with these exact values. */
  signedHeaders?: Record<string, string>;
}

const enc = new TextEncoder();
const UNSIGNED_PAYLOAD = 'UNSIGNED-PAYLOAD';

function hex(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

export async function sha256Hex(data: string | Uint8Array): Promise<string> {
  const bytes = typeof data === 'string' ? enc.encode(data) : data;
  return hex(await crypto.subtle.digest('SHA-256', bytes as BufferSource));
}

export async function hmac(key: Uint8Array | string, data: string): Promise<Uint8Array> {
  const raw = typeof key === 'string' ? enc.encode(key) : key;
  const k = await crypto.subtle.importKey('raw', raw as BufferSource, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, enc.encode(data)));
}

// S3 wants every character outside the unreserved set percent-encoded, including those
// encodeURIComponent leaves alone.
export function uriEncode(s: string, keepSlash = false): string {
  let out = '';
  for (const ch of s) {
    if (/[A-Za-z0-9\-_.~]/.test(ch) || (keepSlash && ch === '/')) {
      out += ch;
    } else {
      for (const b of enc.encode(ch)) out += '%' + b.toString(16).toUpperCase().padStart(2, '0');
    }
  }
  return out;
}

export function amzDate(d: Date): { amz: string; day: string } {
  const amz = d.toISOString().replace(/[:-]|\.\d{3}/g, '');
  return { amz, day: amz.slice(0, 8) };
}

function canonicalQuery(params: URLSearchParams): string {
  const pairs: [string, string][] = [];
  params.forEach((v, k) => pairs.push([uriEncode(k), uriEncode(v)]));
  pairs.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
  return pairs.map(([k, v]) => `${k}=${v}`).join('&');
}

function canonicalHeaders(headers: Record<string, string>): { canonical: string; signed: string } {
  const entries = Object.entries(headers)
    .map(([k, v]) => [k.toLowerCase().trim(), v.trim().replace(/\s+/g, ' ')] as const)
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return {
    canonical: entries.map(([k, v]) => `${k}:${v}\n`).join(''),
    signed: entries.map(([k]) => k).join(';'),
  };
}

// The path is already percent-encoded by the caller (encodeKey); S3 canonicalises it once, not
// twice, so it is kept as-is apart from the WHATWG parser's own normalisation.
function canonicalPath(url: URL): string {
  return url.pathname || '/';
}

async function signingKey(creds: SigningCredentials, day: string, service: string): Promise<Uint8Array> {
  const kDate = await hmac('AWS4' + creds.secretAccessKey, day);
  const kRegion = await hmac(kDate, creds.region);
  const kService = await hmac(kRegion, service);
  return hmac(kService, 'aws4_request');
}

async function signature(creds: SigningCredentials, amz: string, day: string, service: string, canonicalRequest: string): Promise<string> {
  const scope = `${day}/${creds.region}/${service}/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', amz, scope, await sha256Hex(canonicalRequest)].join('\n');
  return hex(await hmac(await signingKey(creds, day, service), toSign));
}

/** Header-authenticated request: returns the full header set to send. */
export async function signHeaders(creds: SigningCredentials, input: SignInput): Promise<Record<string, string>> {
  const service = creds.service ?? 's3';
  const url = new URL(input.url);
  const { amz, day } = amzDate(input.date ?? new Date());
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(input.headers ?? {})) headers[k.toLowerCase()] = v;
  headers.host = url.host;
  headers['x-amz-date'] = amz;
  headers['x-amz-content-sha256'] = UNSIGNED_PAYLOAD;
  if (creds.sessionToken) headers['x-amz-security-token'] = creds.sessionToken;

  const { canonical, signed } = canonicalHeaders(headers);
  const canonicalRequest = [input.method.toUpperCase(), canonicalPath(url), canonicalQuery(url.searchParams), canonical, signed, UNSIGNED_PAYLOAD].join('\n');
  const sig = await signature(creds, amz, day, service, canonicalRequest);
  const scope = `${day}/${creds.region}/${service}/aws4_request`;
  headers.authorization = `AWS4-HMAC-SHA256 Credential=${creds.accessKeyId}/${scope}, SignedHeaders=${signed}, Signature=${sig}`;
  delete headers.host;
  return headers;
}

/** Query-authenticated URL. `signedHeaders` are pinned into the signature and must be sent verbatim. */
export async function presign(creds: SigningCredentials, input: PresignInput): Promise<string> {
  const service = creds.service ?? 's3';
  const url = new URL(input.url);
  const { amz, day } = amzDate(input.date ?? new Date());
  const scope = `${day}/${creds.region}/${service}/aws4_request`;

  const headers: Record<string, string> = { host: url.host };
  for (const [k, v] of Object.entries(input.signedHeaders ?? {})) headers[k.toLowerCase()] = v;
  const { canonical, signed } = canonicalHeaders(headers);

  url.searchParams.set('X-Amz-Algorithm', 'AWS4-HMAC-SHA256');
  url.searchParams.set('X-Amz-Credential', `${creds.accessKeyId}/${scope}`);
  url.searchParams.set('X-Amz-Date', amz);
  url.searchParams.set('X-Amz-Expires', String(input.expiresIn));
  url.searchParams.set('X-Amz-SignedHeaders', signed);
  if (creds.sessionToken) url.searchParams.set('X-Amz-Security-Token', creds.sessionToken);

  const query = canonicalQuery(url.searchParams);
  const canonicalRequest = [input.method.toUpperCase(), canonicalPath(url), query, canonical, signed, UNSIGNED_PAYLOAD].join('\n');
  const sig = await signature(creds, amz, day, service, canonicalRequest);
  return `${url.origin}${url.pathname}?${query}&X-Amz-Signature=${sig}`;
}
