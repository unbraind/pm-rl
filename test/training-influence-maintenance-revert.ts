/** Behavior-only reverts run in disposable copies with the real SDK and no Git tracker. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { proveRevert } from "./fixtures/causal-proof.ts";
import { refuseChangedReceipt, worktreeState } from "./fixtures/revert-receipt.ts";

/** Extract one full top-level implementation, retaining its export and async modifiers. */
function implementation(source: string, name: string): string {
  const start = source.indexOf(`function ${name}(`); assert.ok(start >= 0, name);
  const line = source.lastIndexOf("\n", start) + 1; const end = source.indexOf("\n}\n", start); assert.ok(end > line);
  return source.slice(line, end + 3);
}
const repository = resolve("."); const root = mkdtempSync(join(tmpdir(), "rl-maintenance-revert-"));
const receipt = "docs/training-influence-maintenance-revert.json"; refuseChangedReceipt(repository, receipt); const reviewed = worktreeState(repository, receipt);
try {
  for (const file of readdirSync(repository)) if (file.endsWith(".ts") || file === "package.json") copyFileSync(join(repository, file), join(root, file));
  mkdirSync(join(root, "test")); copyFileSync("test/training-influence-maintenance.test.ts", join(root, "test/training-influence-maintenance.test.ts"));
  mkdirSync(join(root, "scripts")); copyFileSync("scripts/script-launcher.ts", join(root, "scripts/script-launcher.ts"));
  cpSync(join(repository, "test/fixtures"), join(root, "test/fixtures"), { recursive: true });
  symlinkSync(join(repository, "node_modules"), join(root, "node_modules"));
  const influence = readFileSync("training-influence.ts", "utf8"); const index = readFileSync("index.ts", "utf8"); const refusal = readFileSync("refuse.ts", "utf8");
  const oldIndex = execFileSync("git", ["show", "cd7370d:index.ts"], { encoding: "utf8" });
  const oldInfluence = execFileSync("git", ["show", "cd7370d:training-influence.ts"], { encoding: "utf8" });
  const checks = [
    { name: "influenceDatasets error category", file: "training-influence.ts", source: influence, mutant: influence.replace('error instanceof Error && error.message.startsWith("bandit_overlap:") ? "influence_overlap" : "influence_invalid"', '"influence_overlap"'), pattern: "dataset categories" },
    { name: "attachTrainingInfluence admission order", file: "training-influence.ts", source: influence, mutant: influence.replace(implementation(influence, "attachTrainingInfluence"), implementation(oldInfluence, "attachTrainingInfluence")), pattern: "dataset categories" },
    { name: "runRlLoop sealed re-entry", file: "index.ts", source: index, mutant: index.replace(implementation(index, "runRlLoop"), implementation(oldIndex, "runRlLoop")), pattern: "sealed loop evidence" },
    { name: "storedLoopConfiguration seed seal", file: "index.ts", source: index, mutant: index.replace(implementation(index, "storedLoopConfiguration"), implementation(oldIndex, "storedLoopConfiguration")), pattern: "sealed loop evidence" },
    { name: "isProvenanceReadFailure permanent pruning", file: "refuse.ts", source: refusal, mutant: refusal.replace('"history_version_pruned", ', ""), pattern: "sealed loop evidence" },
  ];
  const results = [];
  for (const check of checks) {
    assert.notEqual(check.mutant, check.source, check.name);
    const proof = proveRevert(root, check.file, check.source, check.mutant, "test/training-influence-maintenance.test.ts", check.pattern, /Missing expected rejection|Missing expected exception|The validation function is expected to return|Expected values to be strictly (?:deep-)?equal/);
    results.push({ function: check.name, ...proof });
    process.stdout.write(`${check.name}: revert fails; restoration passes\n`);
  }
  writeFileSync(receipt, JSON.stringify({ format: "pm-rl/influence-maintenance-revert/1", baseline: "cd7370d", tests: results, reviewed_source_unchanged: worktreeState(repository, receipt) === reviewed }, null, 2) + "\n");
} finally { rmSync(root, { recursive: true, force: true }); }
