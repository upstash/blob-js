const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const SUFFIX_LENGTH = 8;
const EXTENSION = /\.[a-z0-9]{1,8}$/i;

function randomSuffix(): string {
  // 2^32 % 58 != 0, so a plain modulo would over-pick the low symbols. Reject the short tail.
  const limit = Math.floor(0x1_0000_0000 / BASE58.length) * BASE58.length;
  const buf = new Uint32Array(SUFFIX_LENGTH);
  let out = '';
  while (out.length < SUFFIX_LENGTH) {
    crypto.getRandomValues(buf);
    for (const n of buf) {
      if (n >= limit) continue;
      out += BASE58.charAt(n % BASE58.length);
      if (out.length === SUFFIX_LENGTH) break;
    }
  }
  return out;
}

function splitExtension(name: string): [stem: string, extension: string] {
  const m = EXTENSION.exec(name);
  return m && m.index > 0 ? [name.slice(0, m.index), m[0]] : [name, ''];
}

/**
 * Adds a random suffix to the final filename, before its extension, so uploads never overwrite
 * each other. Everything else is kept exactly as given: case, spaces, punctuation, Unicode, slashes
 * and length. Call it with a string or as a template tag:
 *
 *   uniquePath(`${prefix}users/${userId}/${file.name}`)
 *   uniquePath`users/${userId}/${file.name}`
 *
 * With userId `Alice_123` and file `Q3 Report.pdf`, both end in `users/Alice_123/Q3 Report-<random>.pdf`.
 * An empty final filename uses "file".
 * Paths are not validated here; every request refuses "." and ".." segments and percent-encodes
 * the rest (see encodeKey). Store the returned path and use it unchanged for later reads/deletes.
 */
export function uniquePath(path: string): string;
export function uniquePath(strings: TemplateStringsArray, ...values: unknown[]): string;
export function uniquePath(input: string | TemplateStringsArray, ...values: unknown[]): string {
  const path = typeof input === 'string' ? input : String.raw({ raw: input }, ...values);
  const basenameAt = path.lastIndexOf('/') + 1;
  const [stem, extension] = splitExtension(path.slice(basenameAt));
  return `${path.slice(0, basenameAt)}${stem || 'file'}-${randomSuffix()}${extension}`;
}
