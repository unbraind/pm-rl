/** Keep every package regression reachable from both release coverage jobs. */
import assert from "node:assert/strict";
import { globSync, readdirSync, readFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import path, { join, win32 } from "node:path";
import { test } from "node:test";

/** Compare the native paths returned by filesystem glob discovery on every platform. */
function assertDiscovered(reachable: Set<string>, files: string[]): void {
  for (const file of files) assert.ok(reachable.has(join("test", file)), `release gate omits test/${file}`);
}

test("release coverage reaches every package test file", () => {
  const config = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
    scripts: Record<string, string>; coverageGate: { tests: string[] };
  };
  assert.match(config.scripts["release:check"], /npm run coverage/);
  assert.match(config.scripts.coverage, /node scripts\/coverage-gate\.ts/);
  const reachable = new Set(globSync(config.coverageGate.tests));
  const files = readdirSync(new URL(".", import.meta.url)).filter(file => file.endsWith(".test.ts"));
  assert.ok(files.length > 0);
  assertDiscovered(reachable, files);
});

test("discovery assertion accepts Windows-native glob paths", (t) => {
  t.mock.method(path, "join", win32.join);
  syncBuiltinESMExports();
  try {
    assertDiscovered(new Set([win32.join("test", "release-test-discovery.test.ts")]), ["release-test-discovery.test.ts"]);
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
});
