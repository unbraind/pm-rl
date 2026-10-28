/** The lint gate covers source only, never tracker data or runtime caches written by the live suites. */
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { ESLint } from 'eslint';

const repoRoot = resolve(import.meta.dirname, '..');

test('lint ignores tracker runtime output such as installed extension builds', async () => {
  const runDir = join(repoRoot, '.agents/pm/runtime/live-meta/run-lint-probe/.agents/pm/extensions/pm-rl/dist');
  const file = join(runDir, 'index.d.ts');
  mkdirSync(runDir, { recursive: true });
  // The construct the release job tripped over: an inline type import, forbidden in source.
  writeFileSync(file, "export declare const probe: import('node:fs').Stats;\n");
  try {
    const eslint = new ESLint({ cwd: repoRoot, overrideConfigFile: join(repoRoot, 'scripts/eslint.config.ts') });
    assert.equal(await eslint.isPathIgnored(file), true);
    const results = await eslint.lintFiles(['.']);
    assert.deepEqual(results.filter((result) => result.filePath.includes('/.agents/')).map((result) => result.filePath), []);
  } finally {
    rmSync(join(repoRoot, '.agents/pm/runtime/live-meta/run-lint-probe'), { recursive: true, force: true });
  }
});

test('lint still checks source files', async () => {
  const eslint = new ESLint({ cwd: repoRoot, overrideConfigFile: join(repoRoot, 'scripts/eslint.config.ts') });
  assert.equal(await eslint.isPathIgnored(join(repoRoot, 'scripts/live-meta.ts')), false);
});
