/** Keep every package regression reachable from both release coverage jobs. */
import assert from "node:assert/strict";
import { globSync, readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";

test("release coverage reaches every package test file", () => {
  const config = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
    scripts: Record<string, string>; coverageGate: { tests: string[] };
  };
  assert.match(config.scripts["release:check"], /npm run coverage/);
  assert.match(config.scripts.coverage, /node scripts\/coverage-gate\.ts/);
  const reachable = new Set(globSync(config.coverageGate.tests));
  const files = readdirSync(new URL(".", import.meta.url)).filter(file => file.endsWith(".test.ts"));
  assert.ok(files.length > 0);
  for (const file of files) assert.ok(reachable.has(`test/${file}`), `release gate omits test/${file}`);
});
