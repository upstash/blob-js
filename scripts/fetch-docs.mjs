// Copies the Upstash Blob docs (github.com/upstash/docs, blob/) into ./docs so they ship in
// the npm tarball. Runs from `prepack`; `postpack` deletes the copy again. The docs are never
// committed to this repo.
//
//   BLOB_DOCS_DIR   copy from a local checkout of upstash/docs instead of cloning
//   BLOB_DOCS_REF   commit, branch or tag to fetch (default: scripts/docs-ref.txt)

import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';

const REPO = 'https://github.com/upstash/docs.git';
const SUBDIR = 'blob';
const OUT = 'docs';
const pinnedRef = readFileSync(new URL('./docs-ref.txt', import.meta.url), 'utf8').trim();
if (!/^[a-f0-9]{40}$/.test(pinnedRef)) throw new Error('scripts/docs-ref.txt must contain a full commit SHA');
const ref = process.env.BLOB_DOCS_REF || pinnedRef;

function source() {
  const local = process.env.BLOB_DOCS_DIR;
  if (local) {
    const dir = existsSync(join(local, SUBDIR)) ? join(local, SUBDIR) : local;
    console.log(`fetch-docs: copying from ${dir}`);
    return { dir, provenance: 'Source: local checkout via `BLOB_DOCS_DIR` (unversioned).', cleanup: () => {} };
  }
  const tmp = mkdtempSync(join(tmpdir(), 'upstash-docs-'));
  const cleanup = () => rmSync(tmp, { recursive: true, force: true });
  const git = (...args) => execFileSync('git', ['-C', tmp, ...args], { encoding: 'utf8' });
  console.log(`fetch-docs: fetching ${REPO}@${ref} (sparse: ${SUBDIR}/)`);
  try {
    git('init', '--quiet');
    git('remote', 'add', 'origin', REPO);
    git('sparse-checkout', 'set', SUBDIR);
    git('fetch', '--quiet', '--depth', '1', '--filter=blob:none', '--', 'origin', ref);
    git('checkout', '--quiet', '--detach', 'FETCH_HEAD');
    const revision = git('rev-parse', 'HEAD').trim();
    return {
      dir: join(tmp, SUBDIR),
      provenance: `Source: [upstash/docs@${revision}](https://github.com/upstash/docs/tree/${revision}/${SUBDIR}).`,
      cleanup,
    };
  } catch (error) {
    cleanup();
    throw error;
  }
}

function* mdxFiles(dir) {
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* mdxFiles(p);
    else if (name.endsWith('.mdx')) yield p;
  }
}

function title(file) {
  const m = readFileSync(file, 'utf8').match(/^title:\s*["']?(.+?)["']?\s*$/m);
  return m ? m[1] : relative(OUT, file);
}

const { dir, provenance, cleanup } = source();
try {
  if ([...mdxFiles(dir)].length === 0) {
    throw new Error(`fetch-docs: no .mdx files found under ${dir}, refusing to pack without docs`);
  }
  rmSync(OUT, { recursive: true, force: true });
  cpSync(dir, OUT, { recursive: true });
} finally {
  cleanup();
}

const files = [...mdxFiles(OUT)];
const index = files.map((f) => `- \`${relative(OUT, f)}\`: ${title(f)}`).join('\n');
writeFileSync(
  join(OUT, 'README.md'),
  `# Upstash Blob docs

The Upstash Blob documentation snapshot bundled with this SDK release.
${provenance}
The latest docs are rendered at https://upstash.com/docs/blob. Read the bundled pages
before writing code for the installed SDK version.

Search with \`rg "<query>" node_modules/@upstash/blob/docs/\`.

${index}
`,
);
console.log(`fetch-docs: ${files.length} pages in ${OUT}/`);
