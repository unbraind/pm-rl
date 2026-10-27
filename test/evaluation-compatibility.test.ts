/** Previously published writers are the oracle for persisted version-1 records and hashes. */
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { PmClient, type GetResult } from "@unbrained/pm-cli/sdk/core";
import { isPmCliExpectedError } from "@unbrained/pm-cli/sdk/runtime";
import { createExtensionTestHarness } from "@unbrained/pm-cli/sdk/testing";
import { exportPolicyCard } from "../policy-card.ts";
import extension, { hashJson, parseBenchmarkSpec, parseEvalResultSpec, promoteGenerationCore, registerGenerationCore, readEvaluationDecision, readCompleteLoopItem, type JsonValue, type RlCommandResult } from "../index.ts";
import { enforceEvaluationPlan, evaluatePlan, evaluationComparison, parseEvaluationPlan, readEvaluationPlan, recordPlanEvaluation, registerEvaluationPlan, type EvaluationPlan, type EvaluationPlanReport } from "../evaluation-plan.ts";
import { parseGenerationSpec, parseScoreRecord, canonicalizeGenerationSpec, canonicalizeScoreRecord, canonicalizeIdentifier, type ScoreRecord } from "../lineage.ts";
import { requiredTrimmedString } from "../refuse.ts";
import { parseSweepSpec } from "../sweep.ts";
import { parseTransferSpec } from "../transfer.ts";
import { statePath, identifierClient, operationIdentifier } from "../state-boundary.ts";
import { compatibilityInputs, LEGACY_LABELS } from "./fixtures/compatibility-inputs.ts";

interface ReleasedFixture {
  readonly producer: { name: string; version: string; integrity: string };
  readonly coordinates: { environment: string; benchmark: string; long_seed: string; long_candidate: string; long_comparison: string };
  readonly benchmark_input: Readonly<Record<string, unknown>>;
  readonly plan: EvaluationPlan;
  readonly rows: readonly { id: string; candidate: number; incumbent: number }[];
  readonly report: EvaluationPlanReport;
  readonly snapshots: GetResult["item"][];
  readonly files: Record<string, string>;
  readonly cases: readonly { index: number; hashes: string[] }[];
}
const fixture = JSON.parse(readFileSync(new URL("./fixtures/released-compatibility.json", import.meta.url), "utf8")) as ReleasedFixture;
const roots: string[] = [];
after(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });

/** Rehydrate portable text files verbatim; the SDK reads and certifies the released history itself. */
function legacyTracker() {
  const root = mkdtempSync(join(tmpdir(), "rl-released-compat-")); roots.push(root);
  const pmRoot = join(root, ".agents/pm");
  for (const [name, contents] of Object.entries(fixture.files)) {
    const path = statePath(pmRoot, ...name.split("/")); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, contents);
  }
  return { root, pmRoot, client: new PmClient({ cwd: root, pmRoot, author: "compatibility-test", noExtensions: true }) };
}
/** Preserve exact statistical and design identity when passing the old evaluation into promotion. */
function legacyScore(): ScoreRecord {
  return { objective: fixture.plan.objective, objective_version: fixture.plan.objective_version, evaluation_context: fixture.plan.evaluation_context, direction: fixture.plan.direction, seed_set: fixture.report.comparison, scale: 1, value: fixture.report.candidate_mean };
}

test("published schema oracle: 500 generated cases retain every legacy label domain without rewriting hashes", () => {
  assert.equal(fixture.producer.version, "2026.7.31"); assert.equal(fixture.cases.length, 500);
  for (const expected of fixture.cases) {
    const input = compatibilityInputs(expected.index);
    const actual = [parseEvaluationPlan(input.plan), evaluationComparison(input.plan), evaluatePlan(input.plan, input.rows), parseGenerationSpec(JSON.stringify(input.generation), "Legacy generation"), parseScoreRecord(input.score, "Legacy score"), parseSweepSpec(JSON.stringify(input.sweep)), parseEvalResultSpec(JSON.stringify(input.evaluation)), parseBenchmarkSpec(JSON.stringify(input.benchmark)), requiredTrimmedString(input.example, "id", "Example", "example_"), canonicalizeGenerationSpec(parseGenerationSpec(JSON.stringify(input.generation), "Legacy generation"), "rl"), canonicalizeScoreRecord(parseScoreRecord(input.score, "Legacy score"), "rl"), canonicalizeIdentifier(input.example.id, "rl"), parseTransferSpec(JSON.stringify(input.transfer))];
    assert.deepEqual(actual.map((value) => hashJson(value as unknown as JsonValue)), expected.hashes, `published case ${expected.index}`);
  }
});

test("released native fixtures read evaluate retry export and promote unchanged through SDK and CLI", async () => {
  const harness = await createExtensionTestHarness(extension, { name: "pm-rl", capabilities: ["commands", "hooks", "schema"] });
  for (const surface of ["sdk", "json", "toon"] as const) {
    const w = legacyTracker();
    for (const expected of fixture.snapshots) {
      assert.deepEqual((await readCompleteLoopItem(w.client, expected.id)).item, expected);
      if (expected.type === "Plan") {
        const stored = JSON.parse(String(expected.body)) as { plan: EvaluationPlan };
        assert.deepEqual((await readEvaluationPlan(w.client, stored.plan.candidate))?.plan, stored.plan);
      }
    }
    const registered = await readEvaluationPlan(w.client, fixture.plan.candidate);
    assert.deepEqual(registered?.plan, fixture.plan);
    assert.equal(registered?.comparison, fixture.report.comparison);
    assert.deepEqual(evaluatePlan(fixture.plan, fixture.rows), fixture.report);
    assert.deepEqual(await recordPlanEvaluation(w.client, fixture.plan.candidate, fixture.rows), fixture.report);
    assert.deepEqual(await registerEvaluationPlan(w.client, fixture.plan), registered); // An old declaration retry is a read.
    await enforceEvaluationPlan(w.client, fixture.plan.candidate, legacyScore());
    const seedRetry = await registerGenerationCore(w.client, { id: "rl-seed", parent: null, baseCheckpoint: " seed checkpoint:1 ", policy: "", collectionRuns: [], environment: undefined, config: {} });
    assert.equal(seedRetry.created, false);
    assert.equal((await registerGenerationCore(w.client, { id: fixture.coordinates.long_seed, parent: null, baseCheckpoint: " seed checkpoint:1 ", policy: "", collectionRuns: [], environment: undefined, config: {} })).created, false);
    const benchmarkFile = join(w.root, "benchmark.json"); writeFileSync(benchmarkFile, JSON.stringify(fixture.benchmark_input));
    const benchmarkRetry = (await harness.runCommand({ command: "rl benchmark register", pmRoot: w.pmRoot, options: { file: benchmarkFile } })).result as RlCommandResult;
    assert.equal(benchmarkRetry.created, false);
    const evalRetry = (await harness.runCommand({ command: "rl eval record", pmRoot: w.pmRoot, options: { run: "rl-run", benchmark: fixture.coordinates.benchmark, checkpoint: " legacy checkpoint:2 ", score: "1", passed: true } })).result as RlCommandResult;
    assert.equal(evalRetry.created, false);
    const score = legacyScore();
    const candidateCard = await exportPolicyCard(w.client, fixture.plan.candidate);
    assert.deepEqual(candidateCard.decision_evidence, (await readEvaluationDecision(w.client, fixture.plan.candidate)).evidence);
    assert.ok(candidateCard.evidence.some((entry) => entry.id === `${fixture.plan.candidate}-evaluation-plan`));
    if (surface === "sdk") await promoteGenerationCore(w.client, { pmRoot: w.pmRoot, author: "compatibility-test" }, fixture.plan.candidate, "rl-approval", { ...score, evaluation_context: "proxy:legacy" }, score, "Released fixture compatibility");
    else {
      const file = join(w.root, "scores.json"); writeFileSync(file, JSON.stringify({ proxy_score: { ...score, evaluation_context: "proxy:legacy" }, held_out_score: score }));
      const result = (await harness.runCommand({ command: "rl generation promote", pmRoot: w.pmRoot, args: [fixture.plan.candidate], options: { approval: "rl-approval", scores: file, evidence: "Released fixture compatibility", json: surface === "json" } })).result as RlCommandResult;
      assert.equal(result.action, "rl-generation-promote");
    }
    const promoted = parseGenerationSpec(String((await readCompleteLoopItem(w.client, fixture.plan.candidate)).item.body).match(/```json\n([\s\S]+?)\n```/)![1], "Promoted compatibility fixture");
    assert.equal(promoted.promoted, true); assert.equal(promoted.approval, "rl-approval");
    const longScore = { ...score, seed_set: fixture.coordinates.long_comparison };
    await promoteGenerationCore(w.client, { pmRoot: w.pmRoot, author: "compatibility-test" }, fixture.coordinates.long_candidate, "rl-long-approval", { ...longScore, evaluation_context: "proxy:legacy" }, longScore, "Long legacy SDK identity");
    assert.equal(parseGenerationSpec(String((await readCompleteLoopItem(w.client, fixture.coordinates.long_candidate)).item.body).match(/```json\n([\s\S]+?)\n```/)![1], "Long promotion").promoted, true);
    // Promotion changes only its targets; all released sources and their native histories remain untouched.
    for (const expected of fixture.snapshots.filter((item) => item.id !== fixture.plan.candidate && item.id !== fixture.coordinates.long_candidate)) assert.deepEqual((await readCompleteLoopItem(w.client, expected.id)).item, expected);
    assert.deepEqual((await readEvaluationPlan(w.client, fixture.plan.candidate))?.plan, fixture.plan);
  }
});

test("new declarations refuse invalid identities before writes while legacy labels stay readable", async () => {
  const w = legacyTracker(); const before = (await w.client.listAllComplete({ includeBody: true })).items;
  for (const field of ["id", "parent", "blockedBy", "environment"]) for (const value of [1, true, {}, [], NaN, Infinity]) {
    assert.throws(() => identifierClient(w.client).create({ id: "rl-refused-reference", title: "Refused", [field]: value } as never), (error: unknown) => isPmCliExpectedError(error) && error.context.code === "rl_identifier_invalid");
  }
  for (const label of LEGACY_LABELS.filter((value) => !["é", "e\u0301"].includes(value))) {
    const p: EvaluationPlan = { ...fixture.plan, candidate: "rl-new", evaluation_context: "held-out", members: fixture.plan.members.map((_, index) => ({ id: index === 0 ? label : `m-${index}`, unit: `u-${index}` })) };
    assert.doesNotThrow(() => parseEvaluationPlan(p));
    await assert.rejects(registerEvaluationPlan(w.client, p), (error: unknown) => isPmCliExpectedError(error) && error.context.code === "rl_identifier_invalid");
  }
  await assert.rejects(registerGenerationCore(w.client, { id: `rl-${"n".repeat(198)}`, parent: null, baseCheckpoint: "checkpoint", policy: "", collectionRuns: [], environment: undefined, config: {} }), (error: unknown) => isPmCliExpectedError(error) && error.context.code === "rl_identifier_invalid");
  assert.deepEqual((await w.client.listAllComplete({ includeBody: true })).items, before);
  for (const [index, label] of ["é", "e\u0301"].entries()) {
    const p: EvaluationPlan = { ...fixture.plan, candidate: `rl-valid-${index}`, evaluation_context: "held-out", members: fixture.plan.members.map((_, slot) => ({ id: slot === 0 ? label : `m-${slot}`, unit: `u-${slot}` })) };
    await registerEvaluationPlan(w.client, p);
    assert.ok((await readEvaluationPlan(w.client, p.candidate))!.plan.members.some((member) => member.id === label));
  }
  const clean = compatibilityInputs(0);
  assert.doesNotThrow(() => parseScoreRecord({ ...clean.score, evaluation_context: "held-out" }, "New score", "write"));
  assert.throws(() => parseScoreRecord(clean.score, "New score", "write"), (error: unknown) => isPmCliExpectedError(error) && error.context.code === "rl_identifier_invalid");
  assert.doesNotThrow(() => parseGenerationSpec(JSON.stringify({ ...clean.generation, base_checkpoint: "checkpoint", policy: "policy", collection_runs: ["rl-run"], parent: "rl-seed", environment_version: "rl-training" }), "New generation", "write"));
  assert.doesNotThrow(() => parseTransferSpec(JSON.stringify({ ...clean.transfer, source_environment_id: "rl-training", target_environment_id: "rl-deploy", run_id: "rl-run", checkpoint: "checkpoint" }), "New transfer", "write"));
  const newSweep = { ...clean.sweep, environment_id: "rl-training", arms: [{ id: "rl-run", config: {} }] };
  assert.doesNotThrow(() => parseSweepSpec(JSON.stringify(newSweep), "New sweep", "write"));
  assert.throws(() => parseSweepSpec(JSON.stringify({ ...newSweep, arms: clean.sweep.arms }), "New sweep", "write"), (error: unknown) => isPmCliExpectedError(error) && error.context.code === "rl_identifier_invalid");
  assert.equal(requiredTrimmedString({ checkpoint: "checkpoint" }, "checkpoint", "New", "new_", 2, "write"), "checkpoint");
  assert.throws(() => requiredTrimmedString({ checkpoint: "unsafe checkpoint:1" }, "checkpoint", "New", "new_", 2, "write"), (error: unknown) => isPmCliExpectedError(error) && error.context.code === "rl_identifier_invalid");
  for (const value of [null, undefined, 1, {}, "x".repeat(1025)]) {
    assert.throws(() => operationIdentifier(value), (error: unknown) => isPmCliExpectedError(error) && error.context.code === "rl_identifier_invalid" && typeof error.context.value === "string");
  }
  // A legacy value requiring an unsafe filename refuses only that operation and names the value.
  const value = "../../legacy-tripwire";
  const input = compatibilityInputs(0); input.generation.policy = value;
  assert.equal(parseGenerationSpec(JSON.stringify(input.generation), "Legacy").policy, value);
  const tripwire = join(w.root, "legacy-tripwire"); mkdirSync(tripwire); const lock = join(tripwire, "expired.lock"); writeFileSync(lock, "foreign expired lease"); const beforeLock = hashJson(readFileSync(lock, "utf8"));
  assert.throws(() => statePath(w.pmRoot, value), (error: unknown) => isPmCliExpectedError(error) && error.context.code === "rl_identifier_invalid" && error.context.value === value && error.message.includes(value));
  const reference = canonicalizeIdentifier(value, "rl");
  await assert.rejects(readCompleteLoopItem(w.client, reference), (error: unknown) => isPmCliExpectedError(error) && error.context.value === reference && error.message.includes(value));
  assert.equal(hashJson(readFileSync(lock, "utf8")), beforeLock);
});
