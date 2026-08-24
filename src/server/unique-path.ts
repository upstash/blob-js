const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const SUFFIX_LENGTH = 8;
const MAX_STEM = 64;
const EXTENSION = /\.[a-z0-9]{1,8}$/;

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
  return m ? [name.slice(0, m.index), m[0]] : [name, ''];
}

function slug(stem: string): string {
  return stem
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_STEM)
    .replace(/-+$/, '');
}

/** Everything an interpolated value can contribute: no directories, no control characters. */
function sanitize(value: unknown): string {
  const basename = String(value).split(/[/\\]/).pop() ?? '';
  const cleaned = basename.replace(/[\p{Cc}\p{Cf}]+/gu, '').normalize('NFC').toLowerCase();
  const [stem, extension] = splitExtension(cleaned);
  return (slug(stem) || 'file') + extension;
}

/**
 * Path builder whose trust boundary is the interpolation: slashes in the literal chunks are
 * structure, slashes inside ${} are stripped along with the rest of the directory component.
 */
export function uniquePath(strings: TemplateStringsArray, ...values: unknown[]): string {
  let path = '';
  for (let i = 0; i < strings.length; i++) {
    path += (strings[i] ?? '').trim();
    if (i < values.length) path += sanitize(values[i]);
  }
  const basenameAt = path.lastIndexOf('/') + 1;
  const [stem, extension] = splitExtension(path.slice(basenameAt));
  return `${path.slice(0, basenameAt)}${stem || 'file'}-${randomSuffix()}${extension}`;
}
