// Pending upload records this client wrote at phase 'begin', keyed by fingerprint. Never trusted
// for what landed: the server asks R2 for ListParts, and a single PUT has nothing to resume, so
// picking the same file again re-sends it under the same token and the same path.
const PREFIX = 'upstash-blob:v1:';

// The token is a bearer capability for one upload and the only thing kept: nothing else here is
// worth the exposure, and what landed is the server's answer, not this record's.
export interface PendingRecord {
  completionToken: string;
}

export function fingerprint(route: string, file: File): string {
  return `${PREFIX}${route}|${file.name}|${file.size}|${file.lastModified}`;
}

function storage(): Storage | undefined {
  try {
    return typeof localStorage === 'undefined' ? undefined : localStorage;
  } catch {
    return undefined;
  }
}

export function readPending(key: string): PendingRecord | undefined {
  try {
    const raw = storage()?.getItem(key);
    if (!raw) return undefined;
    const rec = JSON.parse(raw) as PendingRecord;
    return typeof rec?.completionToken === 'string' ? rec : undefined;
  } catch {
    return undefined;
  }
}

export function writePending(key: string, rec: PendingRecord): void {
  try {
    storage()?.setItem(key, JSON.stringify(rec));
  } catch {
    /* quota or private mode: resume is best effort */
  }
}

export function clearPending(key: string): void {
  try {
    storage()?.removeItem(key);
  } catch {
    /* ignore */
  }
}
