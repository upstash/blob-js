import type { BlobError } from './errors.ts';

/**
 * The record of a stored blob -- the fields a bucket listing carries, shared by every completed
 * write. Never its bytes: the DOM `Blob` is bytes, so the two never swap places here. `blob` is
 * only ever something the SDK answers with, or a field on one; bytes go in as `body` (see PutBody)
 * and nothing in the API takes a parameter named `blob`. Keep it that way when adding to it.
 */
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

/** A completed write, whose stored content type is known even though a bucket listing omits it. */
export interface CompletedBlob extends BlobObject {
  contentType: string;
}

/* ----------------------------------------------------------- upload wire -- */

/**
 * What a route is told about a file before a byte of it is sent: what the browser claimed, which is
 * why onUploadComplete's `contentType` is the one to record. Exported so a shared onBeforeUpload
 * can be written outside the `upload({ ... })` that runs it.
 */
export interface UploadFile {
  name: string;
  type: string;
  size: number;
}

/** The name this crosses the wire under, kept for the wire types below. */
export type WireFile = UploadFile;

export interface WireConstraints {
  contentTypes?: readonly string[];
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
  blob: Omit<CompletedBlob, 'uploadedAt'> & { uploadedAt: string };
  data: TData;
}

export type WireRequest =
  | { phase: 'begin'; file: WireFile; head?: string; input?: unknown }
  | { phase: 'parts'; completionToken: string; from: number }
  | { phase: 'end'; completionToken: string; parts?: WireLanded[] }
  | { phase: 'cancel'; completionToken: string };

/* -------------------------------------------------------------- browser -- */

export type UploadSnapshot = {
  loaded: number;
  total: number;
  percent: number;
  canPause: boolean;
  /**
   * Not settled: queued, uploading, finishing or paused. Every caller wants this and hand-rolling
   * it from `status` is where the off-by-one-state bugs live -- an input re-enabled during
   * 'finishing', a progress bar still drawn under an error line.
   */
  pending: boolean;
  /** Every in-flight part is waiting on a backoff. */
  stalled: boolean;
} & (
  /**
   * 'finishing': every byte is sent and phase 'end' is completing the upload and running
   * onUploadComplete. percent sits at 99 for exactly that stretch, and naming it is the
   * difference between a bar that is working and one that looks stuck.
   */
  // The payload a state does not carry is declared `?: undefined` rather than left out, so
  // `upload.blob?.path` and `upload.error?.message` read straight off the union with no narrowing.
  | { status: 'queued' | 'uploading' | 'finishing' | 'paused'; blob?: undefined; error?: undefined }
  | { status: 'done'; blob: CompletedBlob & { data: unknown }; error?: undefined }
  | { status: 'canceled'; blob?: undefined; error?: undefined }
  | { status: 'error'; error: BlobError; blob?: undefined }
);

export interface UploadTask {
  readonly id: string;
  readonly file: File;
  snapshot(): UploadSnapshot;
  subscribe(onChange: () => void): () => void;
  readonly done: Promise<CompletedBlob & { data: unknown }>;
  pause(): boolean;
  resume(): boolean;
  cancel(): boolean;
  /** Only from 'error': runs the same upload again from the parts that landed. done is replaced. */
  retry(): boolean;
}

/** Phantom types carried by an upload route so the hooks can infer its input and completion data. */
export interface UploadRouteTypes<TInput, TData, TRoute extends string = string> {
  input: TInput;
  data: TData;
  /** The url the route declared, when it declared one. `route` on the hooks is typed to it. */
  route: TRoute;
}

/** A direct-browser-upload route built by this SDK. The brand exists only in its type. */
export type UploadRoute<TInput = unknown, TData = unknown, TRoute extends string = string> = ((request: Request) => Promise<Response>) & {
  readonly __upstashUploadRoute: UploadRouteTypes<TInput, TData, TRoute>;
};

/** What GET on an upload route answers: the constraints the route enforces. */
export interface WireConstraintsResponse {
  constraints: WireConstraints;
}
