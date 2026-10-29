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
  for (const file of ["policy-card.test.ts", "policy-card-recovery-worker.ts"]) copyFileSync(join(repository, "test", file), join(root, "test", file));
  mkdirSync(join(root, "examples")); copyFileSync(join(repository, "examples/loop-bandit.json"), join(root, "examples/loop-bandit.json"));
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
  writeFileSync(source, original.replace("latest.version ?? latest.index", "latest.index"));
  const versionArgs = ["--test", "--test-name-pattern=compacted disposable", "test/training-influence.test.ts"];
  const versionMutant = spawnSync(process.execPath, versionArgs, { cwd: root, encoding: "utf8", timeout: 120000, env: { ...process.env, NODE_V8_COVERAGE: undefined } });
  assert.equal(versionMutant.status, 1, versionMutant.stdout + versionMutant.stderr); assert.match(versionMutant.stdout, /AssertionError/);
  writeFileSync(source, original);
  const versionRestored = spawnSync(process.execPath, versionArgs, { cwd: root, encoding: "utf8", timeout: 120000, env: { ...process.env, NODE_V8_COVERAGE: undefined } });
  assert.equal(versionRestored.status, 0, versionRestored.stdout + versionRestored.stderr);
  const indexSource = join(root, "index.ts"); const originalIndex = readFileSync(indexSource, "utf8");
  const policySource = join(root, "policy-card.ts"); const originalPolicy = readFileSync(policySource, "utf8");
  const checks: { source: string; original: string; removed: string; pattern: string; function: string; file?: string }[] = [
    { source, original, removed: original.replace('item.id !== normalizeItemId(`training-influence-${report.digest}`, prefix)', '!String(item.id).endsWith(`-${row.id}`)'), pattern: "native project prefixes", function: "readTrainingInfluence SDK native identity" },
    { source: indexSource, original: originalIndex, removed: originalIndex.replace('for (const row of orderedHistoryEntries(history, "loop_history_incomplete"))', 'for (const row of history.compact_history!)'), pattern: "reversed native history", function: "promotionAuthor", file: "test/policy-card.test.ts" },
    { source: policySource, original: originalPolicy, removed: originalPolicy.replace('for (const row of orderedHistoryEntries(history, "card_missing_provenance"))', 'for (const row of history.compact_history!)'), pattern: "reversed native history", function: "snapshot", file: "test/policy-card.test.ts" },
    { source: indexSource, original: originalIndex, removed: originalIndex.replace('return [...history.compact_history].sort((left, right) => (left.version ?? left.index) - (right.version ?? right.index));', 'return [...history.compact_history];'), pattern: "history order is irrelevant", function: "orderedHistoryEntries" },
    { source, original, removed: original.replace('if (at === undefined) matchingRecord((await readCompleteLoopItem(client, id)).item, String(item.body), report.digest);', ""), pattern: "history order is irrelevant", function: "readTrainingInfluence current-envelope validation" },
    { source: policySource, original: originalPolicy, removed: originalPolicy.replace('item.tags?.includes("rl-policy-card") === true && ', ""), pattern: "retained policy-card ownership", function: "matchingRetainedCard" },
    { source, original, removed: original.replace('item.type !== "Decision" || ', ""), pattern: "influence ownership", function: "ownedRecord" },
    { source: indexSource, original: originalIndex, removed: originalIndex.replace('fields.some((field) => !isDeepStrictEqual(birth.item[field], current.item[field]))', "false"), pattern: "every producer certifies", function: "createVerifiedItem" },
  ];
  const envelope = [];
  for (const check of checks) {
    process.stdout.write(`checking ${check.function}\n`);
    assert.notEqual(check.removed, check.original);
    const args = ["--test", `--test-name-pattern=${check.pattern}`, check.file ?? "test/training-influence.test.ts"];
    writeFileSync(check.source, check.removed);
    const broken = spawnSync(process.execPath, args, { cwd: root, encoding: "utf8", timeout: 120000, env: { ...process.env, NODE_V8_COVERAGE: undefined } });
    assert.equal(broken.status, 1, broken.stdout + broken.stderr); assert.match(broken.stdout, /AssertionError/);
    writeFileSync(check.source, check.original);
    const fixed = spawnSync(process.execPath, args, { cwd: root, encoding: "utf8", timeout: 120000, env: { ...process.env, NODE_V8_COVERAGE: undefined } });
    assert.equal(fixed.status, 0, `${check.function}: ${fixed.error?.message ?? ""} ${fixed.signal ?? ""}\n${fixed.stdout}\n${fixed.stderr}`); assert.match(fixed.stdout, /pass 1/);
    envelope.push({ function: check.function, mutant: { passed: 0, failed: 1 }, restored: { passed: 1, failed: 0 } });
  }
  writeFileSync("docs/training-influence-revert.json", JSON.stringify({ format: "pm-rl/training-influence-revert/1", function: "measureTrainingInfluence", behavior_removed: "Declared slice membership no longer changes training composition", mutant: { passed: 0, failed: 1 }, restored: { passed: 1, failed: 0 }, durable_versions: { function: "readTrainingInfluence", mutant: { passed: 0, failed: 1 }, restored: { passed: 1, failed: 0 } }, native_envelopes: envelope, reviewed_worktree_unchanged: true, command: "node --test --test-name-pattern='fixed learner and seed' test/training-influence.test.ts" }, null, 2) + "\n");
} finally { rmSync(root, { recursive: true, force: true }); }
