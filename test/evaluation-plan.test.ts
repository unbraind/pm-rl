/** Real non-git trackers and adversarial cohorts for predeclared policy comparisons. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, symlinkSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { after, test } from "node:test";
import { PmClient } from "@unbrained/pm-cli/sdk/core";
import { init, isPmCliExpectedError } from "@unbrained/pm-cli/sdk/runtime";
import { createExtensionTestHarness } from "@unbrained/pm-cli/sdk/testing";
import extension, { extractGenerationSpec, generationProvenance, hashJson, readCompleteLoopItem, type JsonValue, type RlCommandResult } from "../index.ts";
import { evaluationComparison, evaluationPlanId, evaluatePlan, parseEvaluationPlan, registerEvaluationPlan, readEvaluationPlan, recordPlanEvaluation, enforceEvaluationPlan, type EvaluationPlan, type EvaluationObservation } from "../evaluation-plan.ts";
import type { GenerationSpec, ScoreRecord } from "../lineage.ts";

const roots: string[] = [];
after(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });
/** A fixed paired design, with independent cohorts by default. */
function plan(overrides: Partial<EvaluationPlan> = {}): EvaluationPlan {
  return { format: "pm-rl/evaluation-plan/1", candidate: "rl-candidate", incumbent: "rl-seed", incumbent_version: hashJson(generationProvenance(spec())), population: "Public tracker items", selection: "Frozen snapshot; all declared members", correlation_unit: "independent project",
    members: Array.from({ length: 100 }, (_, i) => ({ id: `item-${i}`, unit: `project-${i}` })), objective: "episode_return", objective_version: "v1", evaluation_context: "held-out", direction: "maximize", reward_bounds: [0, 1],
    criterion: { confidence: 0.95, minSamples: 10, effectThreshold: 0 }, stopping: { kind: "fixed", observations: 100, independent_units: 100 }, ...overrides };
}
/** Perfect paired outcomes provide a clearly powered positive control. */
function observations(p: EvaluationPlan = plan()): EvaluationObservation[] { return p.members.map((m) => ({ id: m.id, candidate: 1, incumbent: 0 })); }
/** Check the machine code, conflict exit and actionable remedy together. */
function refusal(code: string) { return (error: unknown): boolean => isPmCliExpectedError(error) && error.exitCode === 4 && error.context.code === code && /new plan|fresh candidate/.test(error.message); }
/** A provenance-complete seed or candidate for SDK tests. */
function spec(parent: string | null = null, runs: string[] = []): GenerationSpec {
  return { base_checkpoint: "checkpoint", policy: parent === null ? "" : "policy", collection_runs: parent === null ? [] : runs.length === 0 ? ["rl-collection"] : runs, training_config: {}, environment_version: parent === null ? "" : "training-env", reward_spec_version: parent === null ? "" : "reward-v1", parent, seed: parent === null, promoted: false, approval: null, proxy_score: null, held_out_score: null, gap: null, promotion_evidence: null };
}
/** Use the same provenance hashing contract as command-created generations. */
async function generation(client: PmClient, id: string, value: GenerationSpec) {
  for (const run of value.collection_runs) {
    try { await client.get(run); } catch { await client.create({ id: run, type: "Run", title: "Planned collection" }); }
  }
  await client.create({ id, type: "Generation", title: id, body: `\`\`\`json\n${JSON.stringify(value)}\n\`\`\``, affectedVersion: hashJson(generationProvenance(value)) });
  return (await readCompleteLoopItem(client, id)).item;
}
/** A real tracker rooted outside any Git repository; no SDK methods are mocked. */
async function workspace() {
  const root = mkdtempSync(join(tmpdir(), "rl-evaluation-")); roots.push(root);
  const tracker = await init("rl", { defaults: true, author: "evaluation-test", agentGuidance: "skip" }, { cwd: root, pmRoot: join(root, ".agents/pm") });
  const client = new PmClient({ pmRoot: tracker.path, cwd: root, author: "evaluation-test", noExtensions: true });
  for (const type of ["Generation", "Run"]) await client.schemaAddType(type, { folder: `${type.toLowerCase()}s`, defaultStatus: "open" });
  await generation(client, "rl-seed", spec());
  return { root, pmRoot: tracker.path, client };
}
/** A held-out score for the planned objective and comparison context. */
function score(overrides: Partial<ScoreRecord> = {}): ScoreRecord { return { objective: "episode_return", objective_version: "v1", evaluation_context: "held-out", direction: "maximize", seed_set: evaluationComparison(plan()), scale: 1, value: 1, ...overrides }; }

test("all plan fields and correlation assignments determine comparison identity", () => {
  const p = plan(); const identity = evaluationComparison(p);
  assert.equal(evaluationComparison({ ...p, members: [...p.members].reverse() }), identity);
  assert.equal(evaluationPlanId(" rl-candidate "), evaluationPlanId("rl-candidate"));
  const changes: Partial<EvaluationPlan>[] = [ { candidate: "next" }, { incumbent: "other" }, { incumbent_version: "changed" }, { population: "other" }, { selection: "sample" }, { correlation_unit: "session" }, { objective: "accuracy" }, { objective_version: "v2" }, { evaluation_context: "other" }, { direction: "minimize" }, { reward_bounds: [-1, 1] }, { criterion: { ...p.criterion, confidence: 0.99 } }, { criterion: { ...p.criterion, minSamples: 20 } }, { criterion: { ...p.criterion, effectThreshold: 0.1 } }, { members: p.members.map((m) => ({ ...m, unit: `new-${m.unit}` })) }, { members: [...p.members, { id: "extra", unit: "extra" }], stopping: { kind: "fixed", observations: 101, independent_units: 101 } } ];
  for (const change of changes) assert.notEqual(evaluationComparison({ ...p, ...change }), identity);
  assert.equal(parseEvaluationPlan({ ...p, population: "  Population  " }).population, "Population");
});

test("invalid, ambiguous and adaptive plans refuse with a remedy", () => {
  const p = plan();
  for (const value of [null, [], "plan", { ...p, surprise: 1 }, { ...p, format: "v2" }, { ...p, direction: "other" }, { ...p, direction: ["maximize"] }, { ...p, direction: { value: "maximize" } }, { ...p, candidate: "rl-seed" }, { ...p, population: " " }, { ...p, population: 1 }, { ...p, population: "x".repeat(1025) }, { ...p, members: null }, { ...p, members: [] }, { ...p, members: Array.from({ length: 10001 }, () => ({ id: "x", unit: "x" })) }, { ...p, members: [{ id: "x" }] }, { ...p, members: [p.members[0], p.members[0]] }, { ...p, stopping: { ...p.stopping, kind: "adaptive" } }, { ...p, stopping: { ...p.stopping, observations: 101 } }, { ...p, stopping: { ...p.stopping, independent_units: 1 } }, { ...p, reward_bounds: null }, { ...p, reward_bounds: [0] }, { ...p, reward_bounds: [0, NaN] }, { ...p, reward_bounds: [1, 0] }, { ...p, reward_bounds: [-1e308, 1e308] }]) assert.throws(() => parseEvaluationPlan(value), refusal("eval_plan_invalid"));
  for (const [field, values] of Object.entries({ confidence: ["x", NaN, 0, 1], minSamples: ["x", 0, 1.5], effectThreshold: ["x", NaN, -1] })) for (const value of values) assert.throws(() => parseEvaluationPlan({ ...p, criterion: { ...p.criterion, [field]: value } }), refusal("eval_plan_invalid"));
});

test("correlated synthetic rows cannot masquerade as independent samples", () => {
  const independent = plan(); assert.equal(evaluatePlan(independent, observations()).verdict.decision, "promote");
  const correlated = plan({ members: independent.members.map((m) => ({ ...m, unit: "one-project" })), stopping: { kind: "fixed", observations: 100, independent_units: 1 } });
  const result = evaluatePlan(correlated, observations());
  assert.equal(result.observations, 100); assert.equal(result.independent_units, 1); assert.equal(result.verdict.decision, "refuse");
  if (result.verdict.decision === "refuse") assert.equal(result.verdict.code, "insufficient_samples");
  const unequal = plan({ members: [{ id: "a", unit: "one" }, { id: "b", unit: "one" }, { id: "c", unit: "two" }], stopping: { kind: "fixed", observations: 3, independent_units: 2 } });
  assert.equal(evaluatePlan(unequal, [{ id: "a", candidate: 1, incumbent: 0 }, { id: "b", candidate: 1, incumbent: 0 }, { id: "c", candidate: 0, incumbent: 0 }]).candidate_mean, 0.5);
  const minimized = plan({ direction: "minimize" }); assert.equal(evaluatePlan(minimized, observations().map((row) => ({ ...row, candidate: 0, incumbent: 1 }))).verdict.decision, "promote");
});

test("fixed stopping and exact paired membership forbid extra looks, duplication and aggregate counts", () => {
  const rows = observations();
  for (const input of [null, {}, rows.slice(1), [...rows, rows[0]]]) assert.throws(() => evaluatePlan(plan(), input), refusal("eval_plan_stopping"));
  for (const patch of [{ id: "unknown" }, { id: rows[1].id }, { candidate: 2 }, { incumbent: -1 }, { candidate: NaN }, { incumbent: "1" }]) assert.throws(() => evaluatePlan(plan(), [{ ...rows[0], ...patch }, ...rows.slice(1)]), refusal("eval_plan_evidence"));
  assert.throws(() => evaluatePlan(plan(), [{ ...rows[0], samples: 10000 }, ...rows.slice(1)]), refusal("eval_plan_invalid"));
});

test("large-offset tied rewards never promote the exact 100-unit reproduction", () => {
  const p = plan({ reward_bounds: [1e16, 1e16 + 2], criterion: { confidence: 0.95, minSamples: 10, effectThreshold: 0 } });
  const report = evaluatePlan(p, p.members.map((m) => ({ id: m.id, candidate: 1e16, incumbent: 1e16 })));
  assert.equal(report.independent_units, 100);
  assert.equal(report.candidate_mean, 1e16); assert.equal(report.incumbent_mean, 1e16);
  assert.equal(report.verdict.decision, "refuse");
  if (report.verdict.decision === "refuse") assert.equal(report.verdict.code, "no_statistical_improvement");
});

test("balanced large-offset rewards refuse despite different accumulation orders", () => {
  const members = Array.from({ length: 100 }, (_, i) => ({ id: String(i).padStart(3, "0"), unit: `unit-${i}` }));
  const p = plan({ members, reward_bounds: [1e16, 1e16 + 2] });
  const rows = members.map((m, i) => ({ id: m.id, candidate: i < 50 ? 1e16 + 2 : 1e16, incumbent: i < 50 ? 1e16 : 1e16 + 2 }));
  const report = evaluatePlan(p, rows);
  assert.equal(report.verdict.decision, "refuse");
  assert.equal(evaluatePlan(p, [...rows].reverse()).verdict.decision, "refuse");
});

test("reward magnitude and offset preserve tie refusals, powered controls and effect thresholds", () => {
  const bounds: readonly (readonly [number, number])[] = [[0, Number.MIN_VALUE], [0, 2 ** -1022], [1e-300, 1e-300 + 1e-315], [-1e-100, 1e-100], [0, 1], [1e16, 1e16 + 2], [-1e16, -1e16 + 2], [1e100, 1e100 + 1e85], [1e300, 1e300 + 1e285], [-1e308, -1e308 + 1e293], [0, 1e308], [Number.MAX_VALUE * 0.49, Number.MAX_VALUE], [-Number.MAX_VALUE, -Number.MAX_VALUE * 0.49]];
  for (const reward_bounds of bounds) for (const direction of ["maximize", "minimize"] as const) for (const units of [10, 100]) {
    const members = Array.from({ length: 100 }, (_, i) => ({ id: String(i).padStart(3, "0"), unit: `unit-${i % units}` }));
    const p = plan({ reward_bounds, direction, members, stopping: { kind: "fixed", observations: 100, independent_units: units } });
    const [lo, hi] = reward_bounds; const range = hi - lo;
    for (const value of [lo, lo + range / 2, hi]) {
      const report = evaluatePlan(p, members.map((m) => ({ id: m.id, candidate: value, incumbent: value })));
      assert.equal(report.verdict.decision, "refuse", `${reward_bounds}, ${direction}, ${units}, tie ${value}`);
      assert.equal(report.candidate_mean, report.incumbent_mean);
    }
    const balanced = members.map((m, i) => ({ id: m.id, candidate: i < 50 ? hi : lo, incumbent: i < 50 ? lo : hi }));
    assert.equal(evaluatePlan(p, balanced).verdict.decision, "refuse", `balanced ${reward_bounds}, ${direction}, ${units}`);
    const positive = members.map((m) => ({ id: m.id, candidate: direction === "maximize" ? hi : lo, incumbent: direction === "maximize" ? lo : hi }));
    const report = evaluatePlan(p, positive);
    assert.equal(report.verdict.decision, "promote", `powered ${reward_bounds}, ${direction}, ${units}`);
    assert.equal(report.candidate_mean, positive[0].candidate); assert.equal(report.incumbent_mean, positive[0].incumbent);
    assert.equal(evaluatePlan({ ...p, criterion: { ...p.criterion, effectThreshold: range * 0.9 } }, positive).verdict.decision, "refuse");
  }
});

test("real SDK plan reservation, single evaluation and promotion checks work without git", async () => {
  const w = await workspace(); const p = plan();
  const registered = await registerEvaluationPlan(w.client, p);
  assert.equal((await registerEvaluationPlan(w.client, p)).comparison, registered.comparison);
  await assert.rejects(registerEvaluationPlan(w.client, { ...p, population: "Changed" }), refusal("eval_plan_drift"));
  await generation(w.client, "rl-candidate", spec("rl-seed"));
  await assert.rejects(enforceEvaluationPlan(w.client, "rl-candidate", score()), refusal("eval_plan_missing"));
  const report = await recordPlanEvaluation(w.client, "rl-candidate", observations());
  assert.equal(report.verdict.decision, "promote");
  assert.deepEqual(await recordPlanEvaluation(w.client, "rl-candidate", [...observations()].reverse()), report);
  await assert.rejects(recordPlanEvaluation(w.client, "rl-candidate", observations().map((row) => ({ ...row, candidate: 0 }))), refusal("eval_plan_drift"));
  for (const patch of [{ objective: "other" }, { objective_version: "v2" }, { evaluation_context: "other" }, { direction: "minimize" as const }, { seed_set: "foreign" }, { scale: 2 }, { value: 0.5 }]) await assert.rejects(enforceEvaluationPlan(w.client, "rl-candidate", score(patch)), refusal("eval_plan_evidence"));
  await enforceEvaluationPlan(w.client, "rl-candidate", score());
  assert.equal(extractGenerationSpec(String((await readCompleteLoopItem(w.client, "rl-candidate")).item.body), "rl-candidate").promoted, false);
  assert.equal(await readEvaluationPlan(w.client, "absent"), null);
  await enforceEvaluationPlan(w.client, "legacy", score());
  await assert.rejects(recordPlanEvaluation(w.client, "absent", []), refusal("eval_plan_missing"));
  await assert.rejects(registerEvaluationPlan(w.client, plan({ candidate: "rl-seed", incumbent: "absent" })), refusal("eval_plan_late"));
  await assert.rejects(registerEvaluationPlan(w.client, plan({ candidate: "rl-new", incumbent: "absent" })), refusal("eval_plan_missing"));
  await assert.rejects(registerEvaluationPlan(w.client, plan({ candidate: "short-id" })), refusal("eval_plan_invalid"));
});

test("documented held-out scores copy the unrounded JSON mean and refuse rounded values", async () => {
  const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
  const guidance = readme.split("## Predeclared causal evaluation plans")[1].split("\n## ")[0];
  assert.match(guidance, /`seed_set`[\s\S]*comparison hash/);
  assert.match(guidance, /`scale`[\s\S]*reward-bound width/);
  assert.match(guidance, /`value`[\s\S]*exactly[\s\S]*`candidate_mean`/);
  assert.match(guidance, /unrounded[\s\S]*`--json`/);

  const w = await workspace();
  await registerEvaluationPlan(w.client, plan());
  await generation(w.client, "rl-candidate", spec("rl-seed"));
  const report = await recordPlanEvaluation(w.client, "rl-candidate", observations().map((row) => ({ ...row, candidate: 2 / 3 })));
  assert.equal(report.verdict.decision, "promote");
  const copied = JSON.parse(JSON.stringify(report)) as { candidate_mean: number };
  assert.equal(copied.candidate_mean, report.candidate_mean);
  await enforceEvaluationPlan(w.client, "rl-candidate", score({ value: copied.candidate_mean }));
  const rounded = Number(copied.candidate_mean.toFixed(3));
  assert.notEqual(rounded, report.candidate_mean);
  await assert.rejects(enforceEvaluationPlan(w.client, "rl-candidate", score({ value: rounded })), refusal("eval_plan_evidence"));
});

test("raw stored evidence and plan drift are rechecked on every promotion", async () => {
  const w = await workspace(); const registered = await registerEvaluationPlan(w.client, plan());
  await generation(w.client, "rl-candidate", spec("rl-seed")); await recordPlanEvaluation(w.client, "rl-candidate", observations());
  const resultId = `${registered.id}-result`; const stored = (await readCompleteLoopItem(w.client, resultId)).item;
  for (const patch of [{ body: "invalid JSON" }, { body: JSON.stringify({ comparison: "foreign", observations: observations() }) }, { affectedVersion: "foreign" }, { type: "Plan" }]) {
    await w.client.update(resultId, patch); await assert.rejects(enforceEvaluationPlan(w.client, "rl-candidate", score()), refusal("eval_plan_drift"));
    await w.client.update(resultId, { type: "Decision", body: String(stored.body), affectedVersion: String(stored.affected_version) });
  }
  const item = (await readCompleteLoopItem(w.client, registered.id)).item;
  for (const patch of [{ body: "invalid JSON" }, { affectedVersion: "foreign" }, { type: "Decision" }]) {
    await w.client.update(registered.id, patch); await assert.rejects(readEvaluationPlan(w.client, "rl-candidate"), refusal("eval_plan_drift"));
    await w.client.update(registered.id, { type: "Plan", body: String(item.body), affectedVersion: String(item.affected_version) });
  }
  const changed = { comparison: registered.comparison, observations: observations().map((row) => ({ ...row, candidate: 0 })) };
  await w.client.update(resultId, { body: JSON.stringify(changed), affectedVersion: hashJson(changed) });
  await assert.rejects(enforceEvaluationPlan(w.client, "rl-candidate", score({ value: 0 })), refusal("eval_plan_drift"));
  await assert.rejects(recordPlanEvaluation(w.client, "rl-candidate", observations()), refusal("eval_plan_drift"));
});

test("sealed evaluation promotion refuses favorable replacement with a recomputed hash", async () => {
  const w = await workspace(); const registered = await registerEvaluationPlan(w.client, plan());
  await generation(w.client, "rl-candidate", spec("rl-seed"));
  const rejected = observations().map((row) => ({ ...row, candidate: 0 }));
  assert.equal((await recordPlanEvaluation(w.client, "rl-candidate", rejected)).verdict.decision, "refuse");
  await assert.rejects(enforceEvaluationPlan(w.client, "rl-candidate", score({ value: 0 })), refusal("eval_plan_refused"));
  const replacement = { comparison: registered.comparison, observations: observations().map((row) => ({ ...row })).sort((a, b) => a.id < b.id ? -1 : 1) };
  assert.equal(evaluatePlan(plan(), replacement.observations).verdict.decision, "promote");
  await w.client.update(`${registered.id}-result`, { body: JSON.stringify(replacement), affectedVersion: hashJson(replacement) });
  await assert.rejects(enforceEvaluationPlan(w.client, "rl-candidate", score()), refusal("eval_plan_drift"));
});

test("sealed evaluation retries refuse favorable replacement with a recomputed hash", async () => {
  const w = await workspace(); const registered = await registerEvaluationPlan(w.client, plan());
  await generation(w.client, "rl-candidate", spec("rl-seed"));
  await recordPlanEvaluation(w.client, "rl-candidate", observations().map((row) => ({ ...row, candidate: 0 })));
  const replacement = { comparison: registered.comparison, observations: observations().map((row) => ({ ...row })).sort((a, b) => a.id < b.id ? -1 : 1) };
  await w.client.update(`${registered.id}-result`, { body: JSON.stringify(replacement), affectedVersion: hashJson(replacement) });
  await assert.rejects(recordPlanEvaluation(w.client, "rl-candidate", replacement.observations), refusal("eval_plan_drift"));
});

test("sealed predeclarations refuse a rewritten cohort and matching replacement result", async () => {
  const w = await workspace(); const independent = plan();
  const correlated = plan({ members: independent.members.map((row) => ({ ...row, unit: "one-project" })), stopping: { kind: "fixed", observations: 100, independent_units: 1 } });
  const registered = await registerEvaluationPlan(w.client, correlated);
  await generation(w.client, "rl-candidate", spec("rl-seed"));
  assert.equal((await recordPlanEvaluation(w.client, "rl-candidate", observations())).verdict.decision, "refuse");
  const comparison = evaluationComparison(independent);
  await w.client.update(registered.id, { body: JSON.stringify({ plan: independent, incumbent_version: independent.incumbent_version }), affectedVersion: hashJson({ comparison, incumbent_version: independent.incumbent_version }) });
  const replacement = { comparison, observations: observations().map((row) => ({ ...row })).sort((a, b) => a.id < b.id ? -1 : 1) };
  await w.client.update(`${registered.id}-result`, { body: JSON.stringify(replacement), affectedVersion: hashJson(replacement) });
  await assert.rejects(readEvaluationPlan(w.client, "rl-candidate"), refusal("eval_plan_drift"));
  await assert.rejects(registerEvaluationPlan(w.client, independent), refusal("eval_plan_drift"));
  await assert.rejects(enforceEvaluationPlan(w.client, "rl-candidate", score()), refusal("eval_plan_drift"));
});

test("sealed creation history is required while unrelated annotations remain allowed", async () => {
  const w = await workspace(); const registered = await registerEvaluationPlan(w.client, plan());
  await generation(w.client, "rl-candidate", spec("rl-seed"));
  const report = await recordPlanEvaluation(w.client, "rl-candidate", observations());
  const resultId = `${registered.id}-result`;
  const annotated = [registered.id, resultId, "rl-candidate", "rl-collection"];
  for (const id of annotated) await w.client.update(id, { title: "Annotation without changing sealed fields" });
  assert.deepEqual(await recordPlanEvaluation(w.client, "rl-candidate", observations()), report);
  await enforceEvaluationPlan(w.client, "rl-candidate", score());
  for (const id of annotated) {
    const path = join(w.pmRoot, "history", `${id}.jsonl`); const history = readFileSync(path);
    rmSync(path);
    await assert.rejects(enforceEvaluationPlan(w.client, "rl-candidate", score()), refusal("eval_plan_drift"));
    const entries = history.toString("utf8").trimEnd().split("\n");
    entries[0] = JSON.stringify({ ...JSON.parse(entries[0]) as Record<string, unknown>, after_hash: "0".repeat(64) });
    for (const corrupt of ["invalid history\n", entries.join("\n") + "\n"]) {
      writeFileSync(path, corrupt);
      await assert.rejects(enforceEvaluationPlan(w.client, "rl-candidate", score()));
    }
    writeFileSync(path, history);
    await enforceEvaluationPlan(w.client, "rl-candidate", score());
  }
});

test("sealed candidate provenance refuses a replacement checkpoint with a recomputed hash", async () => {
  const w = await workspace(); const registered = await registerEvaluationPlan(w.client, plan());
  const original = { ...spec("rl-seed"), evaluation_plan: registered.comparison };
  await generation(w.client, "rl-candidate", original);
  await recordPlanEvaluation(w.client, "rl-candidate", observations());
  const replacement = { ...original, base_checkpoint: "replacement-checkpoint", policy: "replacement-policy" };
  await w.client.update("rl-candidate", { body: `\`\`\`json\n${JSON.stringify(replacement)}\n\`\`\``, affectedVersion: hashJson(generationProvenance(replacement)) });
  await assert.rejects(enforceEvaluationPlan(w.client, "rl-candidate", score()), refusal("eval_plan_drift"));
});

test("sealed deleted reservations cannot become legacy by removing the candidate pin", async () => {
  const w = await workspace(); const registered = await registerEvaluationPlan(w.client, plan());
  await generation(w.client, "rl-candidate", { ...spec("rl-seed"), evaluation_plan: registered.comparison });
  await recordPlanEvaluation(w.client, "rl-candidate", observations().map((row) => ({ ...row, candidate: 0 })));
  await w.client.update("rl-candidate", { body: `\`\`\`json\n${JSON.stringify(spec("rl-seed"))}\n\`\`\``, affectedVersion: hashJson(generationProvenance(spec("rl-seed"))) });
  await w.client.delete(registered.id, { force: true });
  await assert.rejects(enforceEvaluationPlan(w.client, "rl-candidate", score()), refusal("eval_plan_missing"));
});

test("sealed deleted results cannot obtain another evaluation look", async () => {
  const w = await workspace(); const registered = await registerEvaluationPlan(w.client, plan());
  await generation(w.client, "rl-candidate", spec("rl-seed"));
  await recordPlanEvaluation(w.client, "rl-candidate", observations().map((row) => ({ ...row, candidate: 0 })));
  await w.client.delete(`${registered.id}-result`, { force: true });
  await assert.rejects(recordPlanEvaluation(w.client, "rl-candidate", observations()));
});

test("sealed creation timing refuses an early run with a rewritten current timestamp", async () => {
  const w = await workspace(); await w.client.create({ id: "rl-early-run", title: "Early collection", type: "Run" });
  await registerEvaluationPlan(w.client, plan());
  await generation(w.client, "rl-candidate", spec("rl-seed", ["rl-early-run"]));
  const path = join(w.pmRoot, "runs", "rl-early-run.toon"); const original = readFileSync(path, "utf8");
  const rewritten = original.replace(/^created_at: .*$/m, `created_at: "${new Date(Date.now() + 60_000).toISOString()}"`);
  assert.notEqual(rewritten, original);
  writeFileSync(path, rewritten);
  await assert.rejects(recordPlanEvaluation(w.client, "rl-candidate", observations()), refusal("eval_plan_late"));
});

test("original candidate sources must match the declared parent and unchanged incumbent", async () => {
  for (const invalid of ["parent", "incumbent"]) {
    const w = await workspace(); await registerEvaluationPlan(w.client, plan());
    await generation(w.client, "rl-candidate", spec(invalid === "parent" ? "rl-other" : "rl-seed"));
    if (invalid === "incumbent") {
      const replacement = { ...spec(), base_checkpoint: "replacement-incumbent" };
      await w.client.update("rl-seed", { body: `\`\`\`json\n${JSON.stringify(replacement)}\n\`\`\``, affectedVersion: hashJson(generationProvenance(replacement)) });
    }
    await assert.rejects(recordPlanEvaluation(w.client, "rl-candidate", observations()), refusal("eval_plan_drift"));
  }
});

test("orphaned generation comparison pins refuse without a plan or plan history", async () => {
  const w = await workspace();
  await generation(w.client, "rl-orphan", { ...spec("rl-seed"), evaluation_plan: "a".repeat(64) });
  await assert.rejects(enforceEvaluationPlan(w.client, "rl-orphan", score()), refusal("eval_plan_missing"));
});

test("late plans, early collection, changed parents and edited provenance never promote", async () => {
  const w = await workspace(); await w.client.create({ id: "rl-early-run", title: "Early collection", type: "Run" });
  await registerEvaluationPlan(w.client, plan()); const s = spec("rl-seed", ["rl-early-run"]); const item = await generation(w.client, "rl-candidate", s);
  await assert.rejects(recordPlanEvaluation(w.client, "rl-candidate", observations()), refusal("eval_plan_late"));
  for (const [value, hash] of [[spec("other"), true], [spec("rl-seed"), false]] as const) {
    await w.client.update("rl-candidate", { body: `\`\`\`json\n${JSON.stringify(value)}\n\`\`\``, affectedVersion: hash ? hashJson(generationProvenance(value)) : "foreign" });
    await assert.rejects(recordPlanEvaluation(w.client, "rl-candidate", observations()), refusal("eval_plan_drift"));
  }
  await w.client.update("rl-candidate", { body: String(item.body), affectedVersion: String(item.affected_version), type: "Task" });
  await assert.rejects(recordPlanEvaluation(w.client, "rl-candidate", observations()), refusal("eval_plan_drift"));
  await w.client.update("rl-candidate", { type: "Generation", body: `\`\`\`json\n${JSON.stringify(spec("rl-seed"))}\n\`\`\``, affectedVersion: hashJson(generationProvenance(spec("rl-seed"))) });
  await w.client.update("rl-seed", { affectedVersion: "changed" });
  await assert.rejects(recordPlanEvaluation(w.client, "rl-candidate", observations()), refusal("eval_plan_drift"));
});

test("concurrent declarations and identical result writers converge on one immutable record", async () => {
  const w = await workspace();
  const declarations = await Promise.allSettled(Array.from({ length: 3 }, () => registerEvaluationPlan(w.client, plan())));
  assert.ok(declarations.some((entry) => entry.status === "fulfilled"));
  await generation(w.client, "rl-candidate", spec("rl-seed"));
  const results = await Promise.allSettled(Array.from({ length: 3 }, () => recordPlanEvaluation(w.client, "rl-candidate", observations())));
  assert.ok(results.some((entry) => entry.status === "fulfilled")); await enforceEvaluationPlan(w.client, "rl-candidate", score());
});

test("CLI plan commands and actual promotion enforce the reservation with git absent from PATH", async () => {
  const w = await workspace(); const bin = join(w.root, "bin"); mkdirSync(bin); symlinkSync(process.execPath, join(bin, "node"));
  const previousPath = process.env.PATH; const previousCeiling = process.env.GIT_CEILING_DIRECTORIES;
  process.env.PATH = bin; process.env.GIT_CEILING_DIRECTORIES = dirname(w.root);
  try {
    const harness = await createExtensionTestHarness(extension, { name: "pm-rl", capabilities: ["commands", "hooks", "schema"] });
    /** Route through the host command surface, using bounded files and real SDK storage. */
    async function command(name: string, args: string[] = [], options: Record<string, string> = {}): Promise<RlCommandResult> {
      const run = await harness.runCommand({ command: name, pmRoot: w.pmRoot, args, options }); assert.equal(run.handled, true); return run.result as RlCommandResult;
    }
    await assert.rejects(command("rl eval plan show", ["missing"]), refusal("eval_plan_missing"));
    const planFile = join(w.root, "plan.json"); writeFileSync(planFile, JSON.stringify(plan()));
    const registered = await command("rl eval plan register", [], { file: planFile }); assert.ok(registered.id);
    const shown = await command("rl eval plan show", ["rl-candidate"]); assert.equal(shown.details?.comparison, evaluationComparison(plan()));
    // Collection and the candidate are created only after predeclaration.
    const envFile = join(w.root, "env.json"); writeFileSync(envFile, JSON.stringify({ name: "Training", version: "1", task_suite: ["train"], reward_specification: { reward: 1 } }));
    const environment = (await command("rl env register", [], { file: envFile })).id!;
    await command("rl run start", ["collection"], { environment, algorithm: "bandit" });
    await command("rl generation register", ["rl-candidate"], { baseCheckpoint: "candidate-policy", parent: "rl-seed", policy: "policy", collectionRuns: "collection", environment });
    const approval = await w.client.create({ id: "approval", title: "Bounded promotion approval", type: "Decision", body: '```json\n{"permitted_promotions":1}\n```' });
    const scoresFile = join(w.root, "scores.json"); writeFileSync(scoresFile, JSON.stringify({ proxy_score: score({ evaluation_context: "proxy" }), held_out_score: score() }));
    const options = { approval: String(approval.item.id), scores: scoresFile, evidence: "Fixed predeclared evaluation" };
    await assert.rejects(command("rl generation promote", ["rl-candidate"], options), refusal("eval_plan_missing"));
    const rowsFile = join(w.root, "rows.json"); writeFileSync(rowsFile, JSON.stringify(observations()));
    const evaluated = await command("rl eval plan evaluate", ["rl-candidate"], { file: rowsFile }); assert.equal(evaluated.details?.independent_units, 100);
    assert.ok(JSON.stringify(evaluated).length < 1500);
    assert.equal(extractGenerationSpec(String((await readCompleteLoopItem(w.client, "rl-candidate")).item.body), "candidate").evaluation_plan, evaluationComparison(plan()));
    const generationView = await command("rl generation show", ["rl-candidate"]); assert.equal(generationView.details?.evaluation_plan, evaluationComparison(plan()));
    const promoted = await command("rl generation promote", ["rl-candidate"], options); assert.equal(promoted.details?.budget_consumed, 1);
    assert.equal(extractGenerationSpec(String((await readCompleteLoopItem(w.client, "rl-candidate")).item.body), "rl-candidate").promoted, true);
    const planPath = join(w.pmRoot, "plans", `${registered.id}.toon`); const original = readFileSync(planPath); rmSync(planPath);
    await assert.rejects(enforceEvaluationPlan(w.client, "rl-candidate", score()), refusal("eval_plan_missing")); writeFileSync(planPath, original);
  } finally {
    if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath;
    if (previousCeiling === undefined) delete process.env.GIT_CEILING_DIRECTORIES; else process.env.GIT_CEILING_DIRECTORIES = previousCeiling;
  }
});

test("unreadable stores, invalid incumbents and divergent concurrent writes fail closed", async () => {
  const w = await workspace();
  const broken = join(w.pmRoot, "plans", `${evaluationPlanId("rl-broken")}.toon`); mkdirSync(join(w.pmRoot, "plans"), { recursive: true });
  writeFileSync(broken, "[not valid TOON\n");
  await assert.rejects(readEvaluationPlan(w.client, "rl-broken")); rmSync(broken);
  await w.client.create({ id: "rl-task", type: "Task", title: "Wrong incumbent type" });
  await assert.rejects(registerEvaluationPlan(w.client, plan({ incumbent: "rl-task" })), refusal("eval_plan_missing"));
  await assert.rejects(registerEvaluationPlan(w.client, plan({ incumbent: "seed" })), refusal("eval_plan_missing"));
  await w.client.create({ id: "rl-unversioned", type: "Generation", title: "Unversioned incumbent" });
  await assert.rejects(registerEvaluationPlan(w.client, plan({ incumbent: "rl-unversioned" })), refusal("eval_plan_missing"));
  await assert.rejects(registerEvaluationPlan(w.client, plan({ incumbent_version: "wrong" })), refusal("eval_plan_drift"));
  const seed = (await readCompleteLoopItem(w.client, "rl-seed")).item;
  await w.client.update("rl-seed", { body: `\`\`\`json\n${JSON.stringify({ ...spec(), policy: "changed" })}\n\`\`\`` });
  await assert.rejects(registerEvaluationPlan(w.client, plan()), refusal("eval_plan_drift"));
  await w.client.update("rl-seed", { body: String(seed.body) });
  const declarations = await Promise.allSettled([registerEvaluationPlan(w.client, plan()), registerEvaluationPlan(w.client, plan({ selection: "Changed cohort rule" }))]);
  assert.equal(declarations.filter((entry) => entry.status === "fulfilled").length, 1);
  const registered = (await readEvaluationPlan(w.client, "rl-candidate"))!;
  await generation(w.client, "rl-candidate", spec("rl-seed"));
  const results = await Promise.allSettled([recordPlanEvaluation(w.client, "rl-candidate", observations()), recordPlanEvaluation(w.client, "rl-candidate", observations().map((row) => ({ ...row, candidate: 0.9 })))]);
  assert.equal(results.filter((entry) => entry.status === "fulfilled").length, 1);
  const raw = JSON.parse(String((await readCompleteLoopItem(w.client, registered.id)).item.body)) as { plan: EvaluationPlan; incumbent_version: string };
  raw.incumbent_version = "foreign";
  await w.client.update(registered.id, { body: JSON.stringify(raw) });
  await assert.rejects(readEvaluationPlan(w.client, "rl-candidate"), refusal("eval_plan_drift"));
});

test("generation comparison pins survive parsing and reject malformed or changed plan identities", async () => {
  for (const value of [null, "", "wrong", 7]) assert.throws(() => extractGenerationSpec(`\`\`\`json\n${JSON.stringify({ ...spec(), evaluation_plan: value })}\n\`\`\``, "Generation"), (error: unknown) => isPmCliExpectedError(error) && error.context.code === "invalid_evaluation_plan");
  const w = await workspace(); await registerEvaluationPlan(w.client, plan());
  await generation(w.client, "rl-candidate", { ...spec("rl-seed"), evaluation_plan: "a".repeat(64) });
  await assert.rejects(recordPlanEvaluation(w.client, "rl-candidate", observations()), refusal("eval_plan_drift"));
});


test("generation JSON fences retain exact delimiters and first-match behavior", () => {
  const value = spec(); const json = JSON.stringify(value);
  for (const body of ["", "```JSON\n" + json + "\n```", "```json\r\n" + json + "\r\n```", "```json\n\n```", "```json\n" + json]) {
    assert.throws(() => extractGenerationSpec(body, "Generation"), (error: unknown) => isPmCliExpectedError(error) && error.context.code === "generation_missing_spec");
  }
  const fence = "```json\n" + json + "\n```";
  for (const body of [fence, "prefix\n" + fence + "\nsuffix", fence + "\n```json\ninvalid\n```", "```text\nignore\n```\n" + fence]) assert.deepEqual(extractGenerationSpec(body, "Generation"), value);
});

test("generation JSON fence scan bounds 100k repeated unclosed openers", () => {
  const script = `
    import assert from "node:assert/strict";
    import { isPmCliExpectedError } from "@unbrained/pm-cli/sdk/runtime";
    import { extractGenerationSpec } from "./index.ts";
    const input = ${JSON.stringify("```json\nx")}.repeat(100_000);
    const start = performance.now();
    assert.throws(() => extractGenerationSpec(input, "Generation"),
      (error) => isPmCliExpectedError(error) && error.context.code === "generation_missing_spec");
    assert.ok(performance.now() - start < 2000, "100k openers must scan within two seconds");
    console.log("100k linear scan passed");
  `;
  assert.match(execFileSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8", timeout: 20_000 }), /100k linear scan passed/);
});
