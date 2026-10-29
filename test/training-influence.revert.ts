/** Behavioral revert proof mutates only a disposable copy, preserving the reviewed implementation. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = mkdtempSync(join(tmpdir(), "rl-influence-revert-")); const repository = resolve(".");
try {
  for (const file of readdirSync(repository)) if (file.endsWith(".ts") || file === "package.json") copyFileSync(join(repository, file), join(root, file));
  mkdirSync(join(root, "test")); copyFileSync(join(repository, "test/training-influence.test.ts"), join(root, "test/training-influence.test.ts"));
  mkdirSync(join(root, "scripts")); copyFileSync(join(repository, "scripts/script-launcher.ts"), join(root, "scripts/script-launcher.ts"));
  symlinkSync(join(repository, "node_modules"), join(root, "node_modules"), "dir");
  const source = join(root, "training-influence.ts"); const original = readFileSync(source, "utf8");
  const oldBehavior = original.replace("const selected = new Set(slice.members);", "const selected = new Set<string>();");
  assert.notEqual(oldBehavior, original); writeFileSync(source, oldBehavior);
  const mutant = spawnSync(process.execPath, ["--test", "--test-name-pattern=fixed learner and seed", "test/training-influence.test.ts"], { cwd: root, encoding: "utf8", timeout: 120000, env: { ...process.env, NODE_V8_COVERAGE: undefined } });
  assert.equal(mutant.status, 1, mutant.stderr); assert.match(mutant.stdout, /fail 1/); assert.match(mutant.stdout, /AssertionError/);
  writeFileSync(source, original);
  const restored = spawnSync(process.execPath, ["--test", "--test-name-pattern=fixed learner and seed", "test/training-influence.test.ts"], { cwd: root, encoding: "utf8", timeout: 120000, env: { ...process.env, NODE_V8_COVERAGE: undefined } });
  assert.equal(restored.status, 0, restored.stdout + restored.stderr); assert.match(restored.stdout, /pass 1/);
  writeFileSync("docs/training-influence-revert.json", JSON.stringify({ format: "pm-rl/training-influence-revert/1", function: "measureTrainingInfluence", behavior_removed: "Declared slice membership no longer changes training composition", mutant: { passed: 0, failed: 1 }, restored: { passed: 1, failed: 0 }, reviewed_worktree_unchanged: true, command: "node --test --test-name-pattern='fixed learner and seed' test/training-influence.test.ts" }, null, 2) + "\n");
} finally { rmSync(root, { recursive: true, force: true }); }
