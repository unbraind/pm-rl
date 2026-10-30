/** Previously published writers are the oracle for persisted version-1 records and hashes. */
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { PmClient, type GetResult } from "@unbrained/pm-cli/sdk/core";
import { createExtensionTestHarness } from "@unbrained/pm-cli/sdk/testing";
import { exportPolicyCard } from "../policy-card.ts";
import extension, { hashJson, parseBenchmarkSpec, parseEvalResultSpec, promoteGenerationCore, readCompleteLoopItem, type JsonValue, type RlCommandResult } from "../index.ts";
import { enforceEvaluationPlan, evaluatePlan, evaluationComparison, parseEvaluationPlan, readEvaluationPlan, recordPlanEvaluation, registerEvaluationPlan, type EvaluationPlan, type EvaluationPlanReport } from "../evaluation-plan.ts";
import { parseGenerationSpec, parseScoreRecord, canonicalizeGenerationSpec, canonicalizeScoreRecord, canonicalizeIdentifier, type ScoreRecord } from "../lineage.ts";
import { requiredTrimmedString } from "../refuse.ts";
import { parseSweepSpec } from "../sweep.ts";
import { parseTransferSpec } from "../transfer.ts";
import { readProcessJob, type ProcessJob } from "../process.ts";
import { processWorkspace } from "./fixtures/process-workspace.ts";
import { compatibilityInputs } from "./fixtures/compatibility-inputs.ts";

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
    const path = join(pmRoot, name); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, contents);
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
    const benchmarkFile = join(w.root, "benchmark.json"); writeFileSync(benchmarkFile, JSON.stringify(fixture.benchmark_input));
    const benchmarkRetry = (await harness.runCommand({ command: "rl benchmark register", pmRoot: w.pmRoot, options: { file: benchmarkFile } })).result as RlCommandResult;
    assert.equal(benchmarkRetry.created, false);
    const evalRetry = (await harness.runCommand({ command: "rl eval record", pmRoot: w.pmRoot, options: { run: "rl-run", benchmark: fixture.coordinates.benchmark, checkpoint: " legacy checkpoint:2 ", score: "1", passed: true } })).result as RlCommandResult;
    assert.equal(evalRetry.created, false);
    const score = legacyScore();
    const candidateCard = await exportPolicyCard(w.client, fixture.plan.candidate);
    assert.equal(candidateCard.subject, fixture.plan.candidate);
    if (surface === "sdk") await promoteGenerationCore(w.client, { pmRoot: w.pmRoot, author: "compatibility-test" }, fixture.plan.candidate, "rl-approval", { ...score, evaluation_context: "proxy:legacy" }, score, "Released fixture compatibility");
    else {
      const file = join(w.root, "scores.json"); writeFileSync(file, JSON.stringify({ proxy_score: { ...score, evaluation_context: "proxy:legacy" }, held_out_score: score }));
      const result = (await harness.runCommand({ command: "rl generation promote", pmRoot: w.pmRoot, args: [fixture.plan.candidate], options: { approval: "rl-approval", scores: file, evidence: "Released fixture compatibility", json: surface === "json" } })).result as RlCommandResult;
      assert.equal(result.action, "rl-generation-promote");
    }
    const promoted = parseGenerationSpec(String((await readCompleteLoopItem(w.client, fixture.plan.candidate)).item.body).match(/```json\n([\s\S]+?)\n```/)![1], "Promoted compatibility fixture");
    assert.equal(promoted.promoted, true); assert.equal(promoted.approval, "rl-approval");
    // Promotion changes only its targets; all released sources and their native histories remain untouched.
    for (const expected of fixture.snapshots.filter((item) => item.id !== fixture.plan.candidate && item.id !== fixture.coordinates.long_candidate)) assert.deepEqual((await readCompleteLoopItem(w.client, expected.id)).item, expected);
    assert.deepEqual((await readEvaluationPlan(w.client, fixture.plan.candidate))?.plan, fixture.plan);
  }
});

test("native Node and Bun clock fixtures retain their exact SDK receipt fields", async () => {
  const clocks = JSON.parse(readFileSync(new URL("./fixtures/main-process-clocks.json", import.meta.url), "utf8")) as { records: readonly { job: ProcessJob; body: string; approval: string; clock_ms: number }[] };
  assert.deepEqual(clocks.records.map(record => record.job.charge.wall_ms), [31, 30]);
  for (const record of clocks.records) {
    const w = await processWorkspace();
    await w.client.create({ id: record.job.approval, type: "Decision", title: "Main process approval", body: record.approval });
    await w.client.create({ id: record.job.id, type: "Task", title: "Main process receipt", tags: "rl-process-job", body: record.body });
    assert.deepEqual(await readProcessJob(w.client, record.job.id), record.job);
    assert.equal((await readCompleteLoopItem(w.client, record.job.id)).item.body, record.body);
  }
});
