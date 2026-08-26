import type { BlobError } from './errors.ts';

/** What every write verb returns, what list() pages carry, and blob in a snapshot's 'done' member. */
export interface BlobObject {
  path: string;
  /** Undefined on a private bucket: no public host serves it, so use signedRead(). */
  url?: string;
  /** `${url}?v=${etag}`: the fix for a stable path that gets overwritten. Undefined when url is. */
  versionedUrl?: string;
  size: number;
  etag: string;
  uploadedAt: Date;
}

/* ----------------------------------------------------------- upload wire -- */

/**
 * What a route is told about a file before a byte of it is sent: what the browser claimed, which is
 * why onUploadCompleted's `contentType` is the one to record. Exported so a shared onBeforeUpload
 * can be written outside the `upload({ ... })` that runs it.
 */
export interface UploadFile {
  name: string;
  type: string;
  size: number;
}

/** The name this crosses the wire under, kept for the wire types below. */
export type WireFile = UploadFile;

export interface WireLimits {
  allowedContentTypes?: readonly string[];
  maxBytes?: number;
}

export interface WirePart {
  n: number;
  url: string;
}

/**
 * Every direct upload is multipart, one part when the file fits one: the object does not exist until
 * phase 'end' completes it, so no callback can be handed an object it never saw, and pause, resume
 * and retry work at every size instead of only past a threshold.
 */
export interface WireMultipart {
  partSize: number;
  parts: WirePart[];
}

export interface WireBeginResponse {
  completionToken: string;
  path: string;
  upload: WireMultipart;
}

export interface WireLanded {
  n: number;
  etag: string;
}

export interface WirePartsResponse {
  partSize: number;
  size: number;
  parts: WirePart[];
  landed: WireLanded[];
}

export interface WireEndResponse<TData = unknown> {
  blob: Omit<BlobObject, 'uploadedAt'> & { uploadedAt: string };
  data: TData;
}

export type WireRequest =
  | { phase: 'begin'; file: WireFile; input?: unknown }
  | { phase: 'parts'; completionToken: string; from: number }
  | { phase: 'end'; completionToken: string; parts?: WireLanded[] }
  | { phase: 'cancel'; completionToken: string };

/* -------------------------------------------------------------- browser -- */

export type UploadSnapshot = {
  loaded: number;
  total: number;
  percent: number;
  canPause: boolean;
  /** Every in-flight part is waiting on a backoff. */
  stalled: boolean;
} & (
  /**
   * 'finishing': every byte is sent and phase 'end' is completing the upload -- sniffing it,
   * recording it, running onUploadCompleted. percent sits at 99 for exactly that stretch, and
   * naming it is the difference between a bar that is working and one that looks stuck.
   */
  | { status: 'queued' | 'uploading' | 'finishing' | 'paused' }
  | { status: 'done'; blob: BlobObject & { data: unknown } }
  | { status: 'canceled' }
  | { status: 'error'; error: BlobError }
);

export interface UploadTask {
  readonly id: string;
  readonly file: File;
  snapshot(): UploadSnapshot;
  subscribe(onChange: () => void): () => void;
  readonly done: Promise<BlobObject & { data: unknown }>;
  pause(): boolean;
  resume(): boolean;
  cancel(): boolean;
  /** Only from 'error': runs the same upload again from the parts that landed. done is replaced. */
  retry(): boolean;
}

/** Phantom types carried by a handleUpload POST handler so useUpload<typeof POST> can infer them. */
export interface UploadRouteTypes<TInput, TData, TRoute extends string = string, TProxy extends boolean = false> {
  input: TInput;
  data: TData;
  /** The url the route declared, when it declared one. `route` on the hooks is typed to it. */
  route: TRoute;
  /**
   * True for a handleProxyUpload route. One hook serves both transports, so the record it hands back
   * -- pause and resume on a direct upload, `start({ body })` on a proxied one -- is chosen by this.
   */
  proxy: TProxy;
}

/**
 * A POST handler this SDK built. The brand is required and never exists at runtime: an ordinary
 * `(request: Request) => Promise<Response>` must NOT satisfy it, because the hooks decide from this
 * whether the route answers the SDK's envelope or whatever the app wrote itself.
 */
export type UploadRoute<TInput = unknown, TData = unknown, TRoute extends string = string, TProxy extends boolean = false> = ((request: Request) => Promise<Response>) & {
  readonly __upstashUploadRoute: UploadRouteTypes<TInput, TData, TRoute, TProxy>;
};

/** What GET on an upload route answers: what it accepts, and which transport it speaks. */
export interface WireLimitsResponse {
  limits: WireLimits;
  /** 'proxy': the bytes go through the route as one POST. 'direct': presigned, straight to storage. */
  transport?: 'direct' | 'proxy';
}

/** What a handleProxyUpload route answers with. JSON, so uploadedAt is the string it crossed as. */
export interface ProxyUploadResponse<TData = unknown> {
  blob: Omit<BlobObject, 'uploadedAt'> & { uploadedAt: string };
  data: TData;
}
