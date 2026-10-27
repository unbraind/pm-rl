/** Release checks must follow a newly selected calendar version. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

test('changelog scripts derive dates from the selected package version', () => {
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  for (const name of ['changelog:full', 'release:notes']) {
    assert.match(manifest.scripts[name], /--date-from-version/u);
    assert.doesNotMatch(manifest.scripts[name], /--date \d{4}-\d{2}-\d{2}/u);
  }
});
