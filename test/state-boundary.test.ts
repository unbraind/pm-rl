/** Seeded identifier and path properties against a real standalone SDK tracker. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, readdirSync, lstatSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { after, test } from "node:test";
import { PmClient } from "@unbrained/pm-cli/sdk/core";
import { init, isPmCliExpectedError, normalizeRawItemId } from "@unbrained/pm-cli/sdk/runtime";
import { acquireStateLease, acquireStateLock, assertStatePathRoot, checkedStateFile, commitStateTransaction, identifier, identifierClient, statePath } from "../state-boundary.ts";
import { recordSequentialEvaluation, withEvaluationLease } from "../sequential-evaluation.ts";
import { parseEvaluationPlan, registerEvaluationPlan } from "../evaluation-plan.ts";
import { parseBenchmarkSpec, parseEvalResultSpec, commitProcessTransaction, withProcessJobFence, loopLeaseLockId, readCompleteLoopItem } from "../index.ts";
import { parseGenerationSpec } from "../lineage.ts";
import { parseSweepSpec } from "../sweep.ts";
import { parseTransferSpec } from "../transfer.ts";
import { lmCheckpointPath } from "../lm.ts";
import { processStaging } from "../process.ts";
import { checkpointArtifactPath } from "../checkpoint-artifacts.ts";

const roots: string[] = [];
after(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });
/** Verify that neither contents nor directory entries outside state changed. */
function treeHash(root: string): string {
  const hash = createHash("sha256");
  /** Walk only the dedicated tripwire, without following any link. */
  function visit(directory: string): void {
    const directoryStat = lstatSync(directory); hash.update(JSON.stringify([directoryStat.mode, directoryStat.ino, directoryStat.mtimeMs, directoryStat.ctimeMs]));
    for (const name of readdirSync(directory).sort()) {
      const file = join(directory, name); const stat = lstatSync(file);
      hash.update(relative(root, file)); hash.update(JSON.stringify([stat.mode, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs]));
      if (stat.isDirectory()) visit(file); else hash.update(stat.isSymbolicLink() ? readlinkSync(file) : readFileSync(file));
    }
  }
  visit(root); return hash.digest("hex");
}
/** Require a typed boundary refusal and its remedy, never a parser or filesystem exception. */
function refusal(error: unknown): boolean { return isPmCliExpectedError(error) && ["rl_identifier_invalid", "rl_state_path_invalid"].includes(String(error.context.code)) && typeof error.context.required === "string"; }
/** Minimal complete plan, used to exercise the originally reported dependency boundary. */
function plan(review: string): unknown {
  return { format: "pm-rl/evaluation-plan/1", candidate: "rl-candidate", incumbent: "rl-incumbent", incumbent_version: "v1", population: "test", selection: "all", correlation_unit: "session", members: [{ id: "m1", unit: "u1" }], objective: "reward", objective_version: "v1", evaluation_context: "held-out", direction: "maximize", reward_bounds: [0, 1], criterion: { confidence: 0.95, minSamples: 1, effectThreshold: 0 }, stopping: { kind: "sequential", method: "hoeffding-alpha-spending/1", observations: 1, independent_units: 1, unit_order: ["u1"], looks: [1], review } };
}

test("identifier property: 500 seeded sequences preserve external tripwires across every shared state boundary", async () => {
  const root = mkdtempSync(join(tmpdir(), "rl-boundary-")); roots.push(root);
  const pmRoot = join(root, "tracker");
  await init("rl", { defaults: true, author: "boundary-test", agentGuidance: "skip" }, { cwd: root, pmRoot });
  const client = new PmClient({ cwd: root, pmRoot, author: "boundary-test", noExtensions: true });
  const tripwire = join(root, "tripwire"); mkdirSync(tripwire);
  writeFileSync(join(tripwire, "sentinel"), "unchanged");
  writeFileSync(join(tripwire, "expired.lock"), JSON.stringify({ id: "../../tripwire/expired", pid: 2147483647, owner: "foreign", token: "foreign-token", created_at: "1970-01-01T00:00:00Z", ttl_seconds: 1 }));
  const before = treeHash(tripwire);
  assert.equal(Reflect.get(identifierClient(client), "nonexistent-property"), undefined);
  await assert.rejects(async () => identifierClient(client).create(undefined as never));
  const valid = ["rl-a", "prefix-123", "a-b-c", "rl-0", "a".repeat(100), `rl-${"x".repeat(197)}`];
  const invalid = ["..", ".", "", " ", "\t", " padded", "trailing ", "../escape", "../../tripwire/expired", "/absolute", "a/b", "a\\b", "a\0b", "%2e%2e", "%2foutside", "C:\\outside", "C:outside", "x".repeat(256)];
  for (const checkpoint of [...valid, "sha256:x", `sha256:${"a".repeat(64)}`, "日本語"]) {
    assert.equal(identifier(checkpoint, "artifact"), checkpoint);
    assert.equal(parseEvalResultSpec(JSON.stringify({ checkpoint, run_id: "rl-a", benchmark_id: "rl-benchmark", environment_id: "rl-env", environment_spec_hash: "hash", reward_spec_hash: "hash", score: 1, passed: true })).checkpoint, checkpoint);
    assert.equal(parseTransferSpec(JSON.stringify({ source_environment_id: "rl-env", target_environment_id: "rl-target", checkpoint, run_id: "rl-a", gaps: [{ metric: "reward", gap: 0 }] })).checkpoint, checkpoint);
  }
  for (const id of valid) {
    const created = await identifierClient(client).create({ id, type: "Task", title: "Boundary fixture" });
    assert.equal((await readCompleteLoopItem(client, id)).item.id, created.item.id);
    const canonical = created.item.id;
    assert.equal(parseSweepSpec(JSON.stringify({ search_space: { x: [1] }, selection_rule: { kind: "none" }, algorithm: "a", environment_id: "rl-env", environment_spec_hash: "hash", arms: [{ id: canonical, config: {} }] })).arms[0].id, canonical);
    assert.equal(parseTransferSpec(JSON.stringify({ source_environment_id: "rl-env", target_environment_id: "rl-target", checkpoint: "checkpoint", run_id: canonical, gaps: [{ metric: "reward", gap: 0 }] })).run_id, canonical);
    assert.equal(parseEvalResultSpec(JSON.stringify({ checkpoint: "checkpoint", run_id: canonical, benchmark_id: "rl-benchmark", environment_id: "rl-env", environment_spec_hash: "hash", reward_spec_hash: "hash", score: 1, passed: true })).run_id, canonical);
    await withEvaluationLease(client, id, [created.item.id], async () => {
      const file = statePath(processStaging(pmRoot, id), "checkpoint.json"); mkdirSync(processStaging(pmRoot, id), { recursive: true });
      writeFileSync(file, id); assert.equal(readFileSync(checkedStateFile(file), "utf8"), id);
    });
  }
  assert.equal((await readCompleteLoopItem(client, "#A")).item.id, "rl-a");
  for (const alias of [" rl-a ", "RL-A", "#rl-a"]) assert.equal((await identifierClient(client).get(alias)).item.id, (await client.get(alias)).item.id);
  await identifierClient(client).update("rl-a", { priority: 3 });
  await commitStateTransaction({ pmRoot, transactionId: "boundary-native-journal", author: "boundary-test", steps: [{ id: "priority",
    inspect: async () => ({ state: (await readCompleteLoopItem(client, "rl-a")).item.priority === 4 ? "applied" : "pending" }),
    apply: async () => { await identifierClient(client).update("rl-a", { priority: 4 }); return undefined; },
    compensate: async () => { await identifierClient(client).update("rl-a", { priority: 3 }); },
  }] });
  assert.equal((await readCompleteLoopItem(client, "rl-a")).item.priority, 4);
  await identifierClient(client).create({ id: "relations", type: "Task", title: "Relationships", dep: ["rl-a", "id=rl-0,kind=related"] });
  assert.ok((await client.get("relations", { full: true })).item.dependencies?.some((edge) => edge.id === "rl-a"));
  // Unicode is supported for package-owned component/lease identifiers; native create decides its own item-id alphabet.
  for (const id of ["évaluation", "日本語", "e\u0301", "Δ-run", "under_score", ".pending-a"]) {
    assert.equal(identifier(id), normalizeRawItemId(id));
    await withProcessJobFence({ pmRoot, author: "boundary-test" }, id, async () => {
      const file = statePath(pmRoot, "runtime", id); mkdirSync(join(pmRoot, "runtime"), { recursive: true }); writeFileSync(file, id); assert.equal(readFileSync(file, "utf8"), id);
    });
  }
  let seed = 0x1072026;
  for (let sequence = 0; sequence < 500; sequence += 1) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const id = invalid[sequence < invalid.length ? sequence : seed % invalid.length];
    assert.throws(() => identifier(id), refusal);
    assert.throws(() => identifier(id, "artifact"), refusal);
    assert.throws(() => identifier(`sha256:${id}`, "artifact"), refusal);
    for (const field of ["id", "parent", "blockedBy", "environment"]) assert.throws(() => identifierClient(client).create({ id: "refused-sdk-reference", type: "Task", title: "Refused", [field]: id }), refusal);
    assert.throws(() => parseSweepSpec(JSON.stringify({ search_space: { x: [1] }, selection_rule: { kind: "none" }, algorithm: "a", environment_id: "rl-env", environment_spec_hash: "hash", arms: [{ id, config: {} }] }), "New sweep", "write"), isPmCliExpectedError);
    assert.throws(() => parseTransferSpec(JSON.stringify({ source_environment_id: "rl-env", target_environment_id: "rl-target", checkpoint: "checkpoint", run_id: id, gaps: [{ metric: "reward", gap: 0 }] }), "New transfer", "write"), isPmCliExpectedError);
    assert.throws(() => parseEvalResultSpec(JSON.stringify({ checkpoint: "checkpoint", run_id: id, benchmark_id: "rl-benchmark", environment_id: "rl-env", environment_spec_hash: "hash", reward_spec_hash: "hash", score: 1, passed: true }), "New evaluation", "write"), isPmCliExpectedError);
    assert.throws(() => parseEvalResultSpec(JSON.stringify({ checkpoint: id, run_id: "rl-a", benchmark_id: "rl-benchmark", environment_id: "rl-env", environment_spec_hash: "hash", reward_spec_hash: "hash", score: 1, passed: true }), "New evaluation", "write"), isPmCliExpectedError);
    assert.throws(() => parseTransferSpec(JSON.stringify({ source_environment_id: "rl-env", target_environment_id: "rl-target", checkpoint: id, run_id: "rl-a", gaps: [{ metric: "reward", gap: 0 }] }), "New transfer", "write"), isPmCliExpectedError);
    assert.throws(() => parseBenchmarkSpec(JSON.stringify({ name: "benchmark", version: "1", task_suite: {}, scoring_function: {}, pass_criteria: {}, direction: "maximize", contaminated_environments: [id] }), "New benchmark", "write"), isPmCliExpectedError);
    for (const field of ["parent", "approval", "environment_version", "collection_runs", "base_checkpoint", "policy"] as const) {
      const record = { base_checkpoint: "checkpoint", policy: "policy", parent: "rl-a", approval: null, environment_version: "rl-environment", reward_spec_version: "v1", collection_runs: ["rl-a"], training_config: {}, seed: false, [field]: field === "collection_runs" ? [id] : id };
      assert.throws(() => parseGenerationSpec(JSON.stringify(record), "Untrusted record", "write"), isPmCliExpectedError);
    }
    assert.throws(() => statePath(pmRoot, id), refusal);
    assert.throws(() => commitStateTransaction({ pmRoot, transactionId: id, author: "boundary-test", steps: [] }), refusal);
    await assert.rejects(commitProcessTransaction({ pmRoot, transactionId: id, author: "boundary-test", steps: [] }), refusal);
    assert.throws(() => processStaging(pmRoot, id), refusal);
    assert.throws(() => loopLeaseLockId(id), refusal);
    if ([" padded", "trailing "].includes(id)) await assert.rejects(async () => identifierClient(client).get(id), (error: unknown) => isPmCliExpectedError(error) && error.exitCode === 3);
    else assert.throws(() => identifierClient(client).get(id), refusal);
    await assert.rejects(withEvaluationLease(client, "rl-candidate", [id], async () => assert.fail("unsafe dependency executed")), refusal);
    await assert.rejects(withProcessJobFence({ pmRoot, author: "boundary-test" }, id, async () => assert.fail("unsafe fence executed")), refusal);
    await assert.rejects(registerEvaluationPlan(client, plan(id)), (error) => refusal(error) || (isPmCliExpectedError(error) && error.context.code === "eval_plan_invalid"));
    assert.equal(treeHash(tripwire), before, `sequence ${sequence}`);
    const good = valid[seed % valid.length]; const file = statePath(processStaging(pmRoot, good), "checkpoint.json");
    writeFileSync(file, `${sequence}`); assert.equal(readFileSync(file, "utf8"), String(sequence));
  }
  for (const dep of [null, new Array(1), [1], ["../escape"], ["id=../escape,kind=related"], Array(10001).fill("rl-a")]) assert.throws(() => identifierClient(client).create({ id: "invalid-relation", type: "Task", title: "Refused", dep } as never), refusal);
  // Fixed review case: even the SDK's expired-lock removal must never see this dependency.
  await assert.rejects(registerEvaluationPlan(client, plan("../../tripwire/expired")), refusal);
  await identifierClient(client).create({ id: "rl-candidate-evaluation-plan", type: "Plan", title: "Untrusted registered plan", body: JSON.stringify({ plan: plan("../../tripwire/expired"), incumbent_version: "v1" }), affectedVersion: "untrusted" });
  await assert.rejects(recordSequentialEvaluation(client, "rl-candidate", []), refusal);
  assert.equal(treeHash(tripwire), before); assert.ok(existsSync(join(tripwire, "expired.lock")));
  assert.throws(() => parseEvaluationPlan({ ...plan("rl-review") as object, candidate: "../escape" }, "write"), refusal);
});

test("state paths refuse symlinked roots, intermediate directories, leaves and cleanup gates", async () => {
  const root = mkdtempSync(join(tmpdir(), "rl-paths-")); roots.push(root);
  const state = join(root, "state"); const outside = join(root, "tripwire"); mkdirSync(state); mkdirSync(outside); writeFileSync(join(outside, "old.lock"), "sentinel");
  const before = treeHash(outside);
  symlinkSync(outside, join(state, "runtime"), "dir");
  assert.throws(() => processStaging(state, "valid"), refusal);
  assert.throws(() => statePath(join(state, "runtime"), "old.lock"), refusal);
  symlinkSync(join(outside, "old.lock"), join(state, "leaf"));
  assert.throws(() => checkedStateFile(join(state, "leaf")), refusal);
  symlinkSync("cycle", join(state, "cycle"));
  assert.throws(() => statePath(state, "cycle", "leaf"), refusal);
  symlinkSync(join(outside, "missing"), join(state, "dangling"));
  assert.throws(() => statePath(state, "dangling"), refusal);
  mkdirSync(join(state, "locks")); symlinkSync(outside, join(state, "locks", "valid.lock.stale-cleanup"), "dir");
  await assert.rejects(acquireStateLock(state, "valid", 30, "boundary-test"), refusal);
  assert.throws(() => checkpointArtifactPath(join(state, "runtime"), `sha256:${"a".repeat(64)}`), refusal);
  mkdirSync(join(state, "transactions")); symlinkSync(outside, join(state, "transactions", "sdk"), "dir");
  assert.throws(() => commitStateTransaction({ pmRoot: state, transactionId: "valid", author: "boundary-test", steps: [] }), refusal);
  assert.equal(treeHash(outside), before);
  assert.equal(statePath(state), state);
  for (const invalidRoot of [undefined, null, "", "\0", "x".repeat(256), "x".repeat(4097)]) assert.throws(() => statePath(invalidRoot as never, "file"), refusal);
  assert.throws(() => assertStatePathRoot(state, root), refusal);
  assert.throws(() => assertStatePathRoot(state, join(outside, "old.lock")), refusal);
  const context = `sha256:${"a".repeat(64)}`;
  assert.equal(identifier(context, "context"), context);
  assert.equal(identifier(context, "digest"), context);
  assert.equal(lmCheckpointPath({ digest: context } as never), `runtime/pm-rl/artifacts/${"a".repeat(64)}.json`);
  for (const badDigest of [null, "bad", `prefix:${"a".repeat(64)}`, `rl-${context}`, `sha256:${"A".repeat(64)}`]) {
    assert.throws(() => identifier(badDigest, "digest"), refusal);
    assert.throws(() => lmCheckpointPath({ digest: badDigest } as never), refusal);
  }
  assert.equal(identifier(`rl-${context}`, "context"), `rl-${context}`);
  assert.throws(() => identifier(context), refusal);
  assert.throws(() => identifier("sha256:../escape", "context"), refusal);
  assert.throws(() => identifier(null, "context"), refusal);
  assert.throws(() => identifier(null), refusal);
  assert.throws(() => identifier("x".repeat(256), "component"), refusal);
});

test("native release retains a peer successor and rechecks confinement before cleanup", async () => {
  const root = mkdtempSync(join(tmpdir(), "rl-release-")); roots.push(root);
  const state = join(root, "state"); mkdirSync(state);
  const release = await acquireStateLock(state, "valid", 30, "boundary-test");
  const lock = join(state, "locks", "valid.lock"); const peer = { ...JSON.parse(readFileSync(lock, "utf8")), token: "peer-success" };
  writeFileSync(lock, JSON.stringify(peer)); await release(); assert.equal(JSON.parse(readFileSync(lock, "utf8")).token, "peer-success");
  rmSync(lock); const again = await acquireStateLock(state, "valid", 30, "boundary-test");
  const outside = join(root, "tripwire"); mkdirSync(outside); writeFileSync(join(outside, "valid.lock"), "sentinel");
  const before = treeHash(outside); rmSync(join(state, "locks"), { recursive: true }); symlinkSync(outside, join(state, "locks"), "dir");
  await assert.rejects(again(), refusal); assert.equal(treeHash(outside), before);
});

test("native fenceable leases confine acquisition, both fence boundaries and final release", async () => {
  const root = mkdtempSync(join(tmpdir(), "rl-fence-confinement-")); roots.push(root);
  const state = join(root, "state"); const outside = join(root, "tripwire"); mkdirSync(state); mkdirSync(outside);
  writeFileSync(join(outside, "valid.lock"), "expired foreign sentinel"); const before = treeHash(outside);
  mkdirSync(join(state, "locks")); symlinkSync(outside, join(state, "locks", "valid.lock.stale-cleanup"), "dir");
  await assert.rejects(acquireStateLease(state, "valid", 30, "fence-test"), refusal);
  rmSync(join(state, "locks", "valid.lock.stale-cleanup"));
  const lease = await acquireStateLease(state, "valid", 30, "fence-test");
  assert.equal(await lease.fence(async () => 17), 17);
  await lease.release();
  const escaped = await acquireStateLease(state, "valid", 30, "fence-test");
  rmSync(join(state, "locks"), { recursive: true }); symlinkSync(outside, join(state, "locks"), "dir");
  await assert.rejects(escaped.fence(async () => assert.fail("unsafe fence")), refusal);
  await assert.rejects(escaped.release(), refusal); assert.equal(treeHash(outside), before);
});
