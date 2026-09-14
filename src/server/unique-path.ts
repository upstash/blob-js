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

function pathValue(value: unknown): string {
  const text = String(value);
  if (/[/\\\p{Cc}]/u.test(text) || text === '.' || text === '..') {
    throw new TypeError('uniquePath interpolations may not contain slashes, backslashes, control characters, or be "." or ".."');
  }
  return text;
}

/**
 * Adds a random suffix to the final filename, before its extension. Preserves case, spaces,
 * punctuation, Unicode and length in both literals and interpolations; it does not slugify.
 * For example, uniquePath`users/${'Alice_123'}/${'Q3 Report.pdf'}` produces
 * `users/Alice_123/Q3 Report-<random>.pdf`.
 *
 * Put directory separators in the literal chunks. Interpolations containing slashes,
 * backslashes, control characters, or exactly "." or ".." throw TypeError. The assembled path
 * also rejects backslashes, control characters and "." or ".." segments. An empty final
 * filename uses "file". Store the returned path and use it unchanged for later reads/deletes.
 */
export function uniquePath(strings: TemplateStringsArray, ...values: unknown[]): string {
  let path = '';
  for (let i = 0; i < strings.length; i++) {
    path += strings[i] ?? '';
    if (i < values.length) path += pathValue(values[i]);
  }
  if (/[\\\p{Cc}]/u.test(path) || path.split('/').some((segment) => segment === '.' || segment === '..')) {
    throw new TypeError('uniquePath may not contain backslashes, control characters, or "." or ".." segments');
  }
  const basenameAt = path.lastIndexOf('/') + 1;
  const [stem, extension] = splitExtension(path.slice(basenameAt));
  return `${path.slice(0, basenameAt)}${stem || 'file'}-${randomSuffix()}${extension}`;
}
