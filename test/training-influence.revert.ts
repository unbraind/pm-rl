/** Behavioral revert proof mutates only a disposable copy, preserving the reviewed implementation. */
import assert from "node:assert/strict";
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { proveRevert, type ProofResult } from "./fixtures/causal-proof.ts";
import { refuseChangedReceipt, worktreeState } from "./fixtures/revert-receipt.ts";

/** Preserve the historical receipt keys while deriving every count from measured TAP evidence. */
function legacyCounts(result: ProofResult) { return { passed: result.pass, failed: result.fail, ...(result.failure === undefined ? {} : { failure: result.failure }) }; }
/** Revert ordering only inside the named current consumer, even after shared-reader refactors. */
function revertHistoryOrder(source: string, name: string): string {
  const start = source.indexOf(`function ${name}(`); assert.ok(start >= 0, name);
  const end = source.indexOf("\n}\n", start); assert.ok(end > start, name);
  const body = source.slice(start, end).replace(/orderedHistoryEntries\(history, "loop_history_incomplete"\)/, "history.compact_history!");
  return source.slice(0, start) + body + source.slice(end);
}
const root = mkdtempSync(join(tmpdir(), "rl-influence-revert-")); const repository = resolve(".");
const receipt = "docs/training-influence-revert.json"; refuseChangedReceipt(repository, receipt); const reviewed = worktreeState(repository, receipt);
try {
  for (const file of readdirSync(repository)) if (file.endsWith(".ts") || file === "package.json") copyFileSync(join(repository, file), join(root, file));
  mkdirSync(join(root, "test")); copyFileSync(join(repository, "test/training-influence.test.ts"), join(root, "test/training-influence.test.ts"));
  for (const file of ["policy-card.test.ts", "policy-card-recovery-worker.ts"]) copyFileSync(join(repository, "test", file), join(root, "test", file));
  mkdirSync(join(root, "examples")); copyFileSync(join(repository, "examples/loop-bandit.json"), join(root, "examples/loop-bandit.json"));
  mkdirSync(join(root, "scripts")); copyFileSync(join(repository, "scripts/script-launcher.ts"), join(root, "scripts/script-launcher.ts"));
  cpSync(join(repository, "test/fixtures"), join(root, "test/fixtures"), { recursive: true });
  symlinkSync(join(repository, "node_modules"), join(root, "node_modules"), "dir");
  const source = join(root, "training-influence.ts"); const original = readFileSync(source, "utf8");
  const oldBehavior = original.replace("const selected = new Set(slice.members);", "const selected = new Set<string>();");
  assert.notEqual(oldBehavior, original);
  const movement = proveRevert(root, "training-influence.ts", original, oldBehavior, "test/training-influence.test.ts", "fixed learner and seed", /Expected values to be strictly (?:deep-)?equal|The expression evaluated to a falsy value/);
  const versions = proveRevert(root, "training-influence.ts", original, original.replace("latest.version ?? latest.index", "latest.index"), "test/training-influence.test.ts", "compacted disposable", /Expected values to be strictly (?:deep-)?equal|Missing expected rejection|history_version_pruned/);
  const indexSource = join(root, "index.ts"); const originalIndex = readFileSync(indexSource, "utf8");
  const policySource = join(root, "policy-card.ts"); const originalPolicy = readFileSync(policySource, "utf8");
  const checks: { source: string; original: string; removed: string; pattern: string; function: string; file?: string }[] = [
    { source, original, removed: original.replace('item.id !== normalizeItemId(`training-influence-${report.digest}`, prefix)', '!String(item.id).endsWith(`-${row.id}`)'), pattern: "native project prefixes", function: "readTrainingInfluence SDK native identity" },
    { source: indexSource, original: originalIndex, removed: revertHistoryOrder(originalIndex, "promotionAuthor"), pattern: "reversed native history", function: "promotionAuthor", file: "test/policy-card.test.ts" },
    { source: indexSource, original: originalIndex, removed: revertHistoryOrder(originalIndex, "firstDecisionSnapshot"), pattern: "reversed native history", function: "firstDecisionSnapshot (policy-card snapshot)", file: "test/policy-card.test.ts" },
    { source: indexSource, original: originalIndex, removed: originalIndex.replace('return [...history.compact_history].sort((left, right) => (left.version ?? left.index) - (right.version ?? right.index));', 'return [...history.compact_history];'), pattern: "history order is irrelevant", function: "orderedHistoryEntries" },
    { source, original, removed: original.replace('if (at === undefined) matchingRecord((await readCompleteLoopItem(client, id)).item, String(item.body), report.digest);', ""), pattern: "history order is irrelevant", function: "readTrainingInfluence current-envelope validation" },
    { source: policySource, original: originalPolicy, removed: originalPolicy.replace('item.tags?.includes("rl-policy-card") === true && ', ""), pattern: "retained policy-card ownership", function: "matchingRetainedCard" },
    { source, original, removed: original.replace('item.type !== "Decision" || ', ""), pattern: "influence ownership", function: "ownedRecord" },
    { source: indexSource, original: originalIndex, removed: originalIndex.replace('fields.some((field) => !isDeepStrictEqual(birth.item[field], current.item[field]))', "false").replace('  await certifyLoopWrite(client, created.item.id, 1, code);\n', ""), pattern: "every producer certifies", function: "createVerifiedItem" },
  ];
  const envelope = [];
  for (const check of checks) {
    process.stdout.write(`checking ${check.function}\n`);
    assert.notEqual(check.removed, check.original);
    const proof = proveRevert(root, check.source.slice(root.length + 1), check.original, check.removed, check.file ?? "test/training-influence.test.ts", check.pattern, /Missing expected rejection|Expected values to be strictly (?:deep-)?equal|The validation function is expected to return/);
    envelope.push({ function: check.function, mutant: legacyCounts(proof.reverted), restored: legacyCounts(proof.restored) });
  }
  writeFileSync(receipt, JSON.stringify({ format: "pm-rl/training-influence-revert/1", function: "measureTrainingInfluence", behavior_removed: "Declared slice membership no longer changes training composition", mutant: legacyCounts(movement.reverted), restored: legacyCounts(movement.restored), durable_versions: { function: "readTrainingInfluence", mutant: legacyCounts(versions.reverted), restored: legacyCounts(versions.restored) }, native_envelopes: envelope, reviewed_worktree_unchanged: worktreeState(repository, receipt) === reviewed, command: "node --test --test-name-pattern='fixed learner and seed' test/training-influence.test.ts" }, null, 2) + "\n");
} finally { rmSync(root, { recursive: true, force: true }); }
