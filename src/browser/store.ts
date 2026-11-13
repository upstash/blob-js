// Pending upload records this client wrote at phase 'begin', keyed by fingerprint. Never trusted
// for what landed: the server asks R2 for ListParts, and a single PUT has nothing to resume, so
// picking the same file again re-sends it under the same token and the same path.
const PREFIX = 'upstash-blob:v1:';

// The token is a bearer capability for one upload and the only thing kept: nothing else here is
// worth the exposure, and what landed is the server's answer, not this record's.
export interface PendingRecord {
  completionToken: string;
}

// The input decides where the upload lands, so a record is only ever resumed by a pick with the same
// input: the same file attached under another input is a different upload. It is hashed, not kept,
// for the same reason as above. Undefined, so nothing is stored or resumed, when the input has no
// JSON form, which begin refuses anyway.
export function fingerprint(route: string, file: File, input: unknown): string | undefined {
  const base = `${PREFIX}${route}|${file.name}|${file.size}|${file.lastModified}`;
  if (input === undefined) return base;
  try {
    // Plain first: the sorting replacer hands back a fresh copy of every object, which hides a cycle
    // from JSON.stringify until the stack runs out, seconds later on a wide object.
    if (JSON.stringify(input) === undefined) return base;
    const json = JSON.stringify(input, (_k, v: unknown) =>
      v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : v,
    );
    return `${base}|${hash(json)}`;
  } catch {
    return undefined;
  }
}

// cyrb53: 53 bits is plenty to tell one file's inputs apart, and it is synchronous.
function hash(s: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

function storage(): Storage | undefined {
  try {
    return typeof localStorage === 'undefined' ? undefined : localStorage;
  } catch {
    return undefined;
  }
}

export function readPending(key: string | undefined): PendingRecord | undefined {
  if (key === undefined) return undefined;
  try {
    const raw = storage()?.getItem(key);
    if (!raw) return undefined;
    const rec = JSON.parse(raw) as PendingRecord;
    return typeof rec?.completionToken === 'string' ? rec : undefined;
  } catch {
    return undefined;
  }
}

export function writePending(key: string | undefined, rec: PendingRecord): void {
  if (key === undefined) return;
  try {
    storage()?.setItem(key, JSON.stringify(rec));
  } catch {
    /* quota or private mode: resume is best effort */
  }
}

// Only the record holding this token: the same file picked twice in one page writes over the first
// pick's record, and the first one finishing must not take the second one's resume with it.
export function clearPending(key: string | undefined, token: string | undefined): void {
  if (key === undefined || token === undefined || readPending(key)?.completionToken !== token) return;
  try {
    storage()?.removeItem(key);
  } catch {
    /* ignore */
  }
}
