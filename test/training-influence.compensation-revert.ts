/** Revert only compensation functions in a disposable copy and require behavioral failures. */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { refuseChangedReceipt, worktreeState } from "./fixtures/revert-receipt.ts";

const repository = resolve(".");
const receipt = "docs/training-influence-compensation-revert.json"; refuseChangedReceipt(repository, receipt); const reviewed = worktreeState(repository, receipt);
const root = mkdtempSync(join(tmpdir(), "rl-compensation-revert-"));
/** Extract one whole top-level function without altering the reviewed implementation. */
function functionText(source: string, name: string): string {
  const start = source.indexOf(`export async function ${name}`);
  assert.ok(start >= 0, name);
  const end = source.indexOf("\n}\n", start);
  assert.ok(end > start, name);
  return source.slice(start, end + 3);
}
try {
  for (const file of readdirSync(repository)) if (file.endsWith(".ts") || file === "package.json") copyFileSync(join(repository, file), join(root, file));
  mkdirSync(join(root, "test"));
  for (const file of ["sweep.test.ts", "process.test.ts"]) copyFileSync(join(repository, "test", file), join(root, "test", file));
  cpSync(join(repository, "test/fixtures"), join(root, "test/fixtures"), { recursive: true });
  cpSync(join(repository, "examples"), join(root, "examples"), { recursive: true });
  mkdirSync(join(root, "scripts"));
  copyFileSync(join(repository, "scripts/script-launcher.ts"), join(root, "scripts/script-launcher.ts"));
  symlinkSync(join(repository, "node_modules"), join(root, "node_modules"));
  const results = [];
  for (const [file, name, test, pattern] of [
    ["index.ts", "removePlannedArms", "sweep", "every SDK revision"],
    ["process.ts", "reserveProcessJob", "process", "every journal step boundary"],
    ["process.ts", "transitionProcessJob", "process", "every journal step boundary"],
  ]) {
    const fixed = readFileSync(join(repository, file), "utf8");
    const previous = execFileSync("git", ["show", `1e3e620:${file}`], { cwd: repository, encoding: "utf8" });
    const mutant = fixed.replace(functionText(fixed, name), functionText(previous, name));
    assert.notEqual(mutant, fixed);
    const args = ["--test", "--test-concurrency=1", `--test-name-pattern=${pattern}`, `test/${test}.test.ts`];
    const run = () => spawnSync(process.execPath, args, { cwd: root, encoding: "utf8", timeout: 240_000, env: { ...process.env, NODE_V8_COVERAGE: undefined } });
    writeFileSync(join(root, file), mutant);
    const broken = run();
    assert.equal(broken.status, 1, broken.stdout + broken.stderr);
    assert.match(broken.stdout + broken.stderr, /AssertionError/);
    writeFileSync(join(root, file), fixed);
    const restored = run();
    assert.equal(restored.status, 0, restored.stdout + restored.stderr);
    assert.match(restored.stdout, /pass 1/);
    results.push({ function: name, reverted: { pass: 0, fail: 1 }, restored: { pass: 1, fail: 0 } });
    process.stdout.write(`${name}: revert fails; restoration passes\n`);
  }
  writeFileSync(receipt, JSON.stringify({ format: "pm-rl/compensation-revert/1", baseline: "1e3e620", tests: results, reviewed_source_unchanged: worktreeState(repository, receipt) === reviewed }, null, 2) + "\n");
} finally { rmSync(root, { recursive: true, force: true }); }
