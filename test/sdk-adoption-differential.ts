/** Compare built lock/transaction functions on isolated copies of public trackers. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Hash settings, item and history bytes, excluding disposable SDK caches and locks. */
function domain(root: string): Record<string, string> {
  const hashes: Record<string, string> = {};
  /** Walk only the explicitly supplied tracker. */
  function visit(directory: string): void {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
      const path = join(directory, entry.name);
      if (entry.isDirectory() && !["runtime", "locks", "search", "transactions", "extensions", "cache", "artifacts", "checkpoints"].includes(entry.name)) visit(path);
      else if (entry.isFile()) hashes[relative(root, path)] = createHash("sha256").update(readFileSync(path)).digest("hex");
    }
  }
  visit(root);
  return hashes;
}

const [before, after, ...trackers] = process.argv.slice(2).map((path) => resolve(path));
assert.ok(before && after && trackers.length > 0, "supply baseline package root, candidate package root, and public tracker snapshots");
const fixture = fileURLToPath(new URL("./fixtures/sdk-adoption-read.ts", import.meta.url));
const baselineFixture = join(before, "test", "fixtures", "sdk-adoption-read.ts");
mkdirSync(dirname(baselineFixture), { recursive: true });
cpSync(fixture, baselineFixture);
const directory = mkdtempSync(join(tmpdir(), "rl-sdk-differential-"));
try {
  let items = 0;
  for (const [index, source] of trackers.entries()) {
    const original = domain(source);
    const outputs: string[] = [];
    for (const [label, packageRoot] of [["before", before], ["after", after]]) {
      const copy = join(directory, `${index}-${label}`, ".agents", "pm");
      cpSync(source, copy, { recursive: true });
      const snapshot = domain(copy);
      for (const path of Object.keys(snapshot)) chmodSync(join(copy, path), 0o444);
      const run = spawnSync(process.execPath, [join(packageRoot, "test", "fixtures", "sdk-adoption-read.ts"), copy], {
        cwd: directory, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, env: { ...process.env, PM_PATH: undefined, GIT_CEILING_DIRECTORIES: dirname(directory) },
      });
      assert.equal(run.status, 0, `${run.error?.message ?? ""} ${run.signal ?? ""} ${run.stderr}`);
      assert.deepEqual(domain(copy), snapshot, "probe changed authoritative tracker bytes");
      outputs.push(run.stdout.replaceAll(copy, "$TRACKER"));
    }
    if (outputs[0] !== outputs[1]) {
      /** Locate output differences without echoing public tracker content into logs. */
      function differences(left: unknown, right: unknown, key = "root"): string[] {
        if (JSON.stringify(left) === JSON.stringify(right)) return [];
        if (left !== null && right !== null && typeof left === "object" && typeof right === "object") {
          const l = left as Record<string, unknown>;
          const r = right as Record<string, unknown>;
          return [...new Set([...Object.keys(l), ...Object.keys(r)])].flatMap((child) => differences(l[child], r[child], `${key}.${child}`));
        }
        return [key];
      }
      assert.fail(`before/after output differences: ${differences(JSON.parse(outputs[0]), JSON.parse(outputs[1])).join(", ")}`);
    }
    const parsed = JSON.parse(outputs[0]) as { result: { items: unknown[] } };
    items += parsed.result.items.length;
    assert.deepEqual(domain(source), original, "source snapshot changed");
    process.stdout.write(`tracker ${index + 1}: identical output, ${parsed.result.items.length} items, authoritative bytes unchanged\n`);
  }
  process.stdout.write(`${trackers.length} trackers, ${items} items: differential passed; intentional differences: none\n`);
} finally { rmSync(directory, { recursive: true, force: true }); }
