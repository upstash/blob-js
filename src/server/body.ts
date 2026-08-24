import { BlobError } from '../shared/errors.ts';
import { SNIFF_BYTES } from './sniff.ts';

export type PutBody = Request | Blob | ArrayBuffer | ArrayBufferView | string | ReadableStream<Uint8Array>;

export interface ResolvedBody {
  stream: ReadableStream<Uint8Array>;
  /** Undefined when the length is unknown up front. */
  size: number | undefined;
  contentType: string | undefined;
}

const enc = new TextEncoder();

function fromBytes(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(c) {
      if (bytes.byteLength) c.enqueue(bytes);
      c.close();
    },
  });
}

export function resolveBody(body: PutBody): ResolvedBody {
  if (body instanceof Request) {
    if (body.body === null || body.bodyUsed) throw new BlobError('empty_body', { message: 'the request has no body' });
    const len = body.headers.get('content-length');
    const size = len !== null && /^\d+$/.test(len) ? Number(len) : undefined;
    return { stream: body.body, size, contentType: body.headers.get('content-type') ?? undefined };
  }
  if (typeof Blob !== 'undefined' && body instanceof Blob) {
    return { stream: body.stream() as ReadableStream<Uint8Array>, size: body.size, contentType: body.type || undefined };
  }
  if (typeof body === 'string') {
    const bytes = enc.encode(body);
    return { stream: fromBytes(bytes), size: bytes.byteLength, contentType: undefined };
  }
  if (body instanceof ArrayBuffer) return { stream: fromBytes(new Uint8Array(body)), size: body.byteLength, contentType: undefined };
  if (ArrayBuffer.isView(body)) {
    const bytes = new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
    return { stream: fromBytes(bytes), size: bytes.byteLength, contentType: undefined };
  }
  if (body instanceof ReadableStream) return { stream: body, size: undefined, contentType: undefined };
  throw new TypeError('put() body must be a Request, Blob, ArrayBuffer, typed array, string or ReadableStream');
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((n, c) => n + c.byteLength, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}

/** Reads up to SNIFF_BYTES, then hands back a stream that replays them ahead of the rest. */
export async function peek(stream: ReadableStream<Uint8Array>): Promise<{ head: Uint8Array; stream: ReadableStream<Uint8Array> }> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let got = 0;
  let ended = false;
  while (got < SNIFF_BYTES) {
    const { value, done } = await reader.read();
    if (done) {
      ended = true;
      break;
    }
    chunks.push(value);
    got += value.byteLength;
  }
  const buffered = concat(chunks);
  const replay = new ReadableStream<Uint8Array>({
    start(c) {
      if (buffered.byteLength) c.enqueue(buffered);
      if (ended) c.close();
    },
    async pull(c) {
      const { value, done } = await reader.read();
      if (done) c.close();
      else c.enqueue(value);
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
  return { head: buffered.subarray(0, SNIFF_BYTES), stream: replay };
}

export async function readAll(stream: ReadableStream<Uint8Array>, maxBytes: number): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let got = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    got += value.byteLength;
    if (got > maxBytes) {
      await reader.cancel();
      throw new BlobError('too_large', { message: `body exceeds maxBytes (${maxBytes} bytes)` });
    }
    chunks.push(value);
  }
  return concat(chunks);
}

/** Counts bytes through; over maxBytes the stream errors so the PUT never completes. */
export function limit(stream: ReadableStream<Uint8Array>, maxBytes: number, onCount?: (n: number) => void): ReadableStream<Uint8Array> {
  let seen = 0;
  return stream.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, c) {
        seen += chunk.byteLength;
        if (seen > maxBytes) throw new BlobError('too_large', { message: `body exceeds maxBytes (${maxBytes} bytes)` });
        onCount?.(seen);
        c.enqueue(chunk);
      },
    }),
  );
}
