import { afterEach, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../../scripts/fetch-docs.mjs', import.meta.url));
const fixtures: string[] = [];

afterEach(() => {
  for (const dir of fixtures.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'blob-docs-test-'));
  fixtures.push(dir);
  const cwd = join(dir, 'package');
  const source = join(dir, 'source');
  mkdirSync(cwd);
  mkdirSync(source);
  return { cwd, source };
}

function fetchDocs(cwd: string, source: string) {
  return spawnSync('node', [script], {
    cwd,
    env: { PATH: process.env.PATH, BLOB_DOCS_DIR: source },
    encoding: 'utf8',
  });
}

for (const checkoutRoot of [true, false]) {
  test(`copies local docs from ${checkoutRoot ? 'checkout root' : 'blob directory'} and indexes every page`, () => {
    const { cwd, source } = fixture();
    const blob = checkoutRoot ? join(source, 'blob') : source;
    mkdirSync(join(blob, 'bucket'), { recursive: true });
    const content = '---\ntitle: "Writing files"\n---\n\nExample body.\n';
    writeFileSync(join(blob, 'bucket/writing.mdx'), content);
    writeFileSync(join(blob, 'quickstart.mdx'), '---\ntitle: Quickstart\n---\n');

    const result = fetchDocs(cwd, source);
    expect(result.status).toBe(0);
    expect(readFileSync(join(cwd, 'docs/bucket/writing.mdx'), 'utf8')).toBe(content);
    const index = readFileSync(join(cwd, 'docs/README.md'), 'utf8');
    expect(index).toContain('`bucket/writing.mdx`: Writing files');
    expect(index).toContain('`quickstart.mdx`: Quickstart');
    expect(index).toContain('unversioned');
    expect(index).not.toContain('https://github.com/upstash/docs/tree/');
  });
}

for (const missing of [false, true]) {
  test(`rejects ${missing ? 'missing' : 'empty'} docs before replacing existing output`, () => {
    const { cwd, source } = fixture();
    mkdirSync(join(cwd, 'docs'));
    writeFileSync(join(cwd, 'docs/existing.mdx'), 'Existing documentation');
    const result = fetchDocs(cwd, missing ? join(source, 'missing') : source);
    expect(result.status).not.toBe(0);
    expect(readFileSync(join(cwd, 'docs/existing.mdx'), 'utf8')).toBe('Existing documentation');
    if (!missing) expect(result.stderr).toContain('refusing to pack without docs');
  });
}
