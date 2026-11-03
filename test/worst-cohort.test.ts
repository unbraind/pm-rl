/** Protected cohort decisions and immutable state are exercised through real non-git SDK trackers. */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { after, test } from "node:test";
import { PmClient, type GetResult } from "@unbrained/pm-cli/sdk/core";
import { init, isPmCliExpectedError } from "@unbrained/pm-cli/sdk/runtime";
import { createExtensionTestHarness } from "@unbrained/pm-cli/sdk/testing";
import extension, { generationProvenance, hashJson, readCompleteLoopItem, type RlCommandResult } from "../index.ts";
import { validateEvaluationReport, parseEvaluationPlan, evaluationComparison, evaluatePlan, registerEvaluationPlan, readEvaluationPlan, recordPlanEvaluation, enforceEvaluationPlan, type EvaluationPlan, type EvaluationObservation } from "../evaluation-plan.ts";
import type { GenerationSpec, ScoreRecord } from "../lineage.ts";

const roots: string[] = [];
after(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });
/** Independent reference fixtures are bounded binary rewards unless a boundary test overrides them. */
function design(candidate = "rl-candidate"): EvaluationPlan {
  return { format: "pm-rl/evaluation-plan/1", candidate, incumbent: "rl-seed", incumbent_version: hashJson(generationProvenance(seed())), population: "Declared tasks", selection: "Frozen ids", correlation_unit: "independent task", objective: "reward", objective_version: "1", evaluation_context: "held-out", direction: "maximize", reward_bounds: [0, 1],
    criterion: { confidence: 0.95, minSamples: 10, effectThreshold: 0 }, stopping: { kind: "fixed", observations: 100, independent_units: 100 }, members: Array.from({ length: 100 }, (_, i) => ({ id: `task-${i}`, unit: `unit-${i}` })),
    protected_cohorts: [{ id: "protected", members: ["task-0", "task-1"], min_units: 2, max_regression: 0 }] };
}
/** Sealed generation provenance uses exactly the same producer as production registration. */
function seed(): GenerationSpec { return { base_checkpoint: "checkpoint", policy: "", collection_runs: [], training_config: {}, environment_version: "", reward_spec_version: "", parent: null, seed: true, promoted: false, approval: null, proxy_score: null, held_out_score: null, gap: null, promotion_evidence: null }; }
/** A powered aggregate improvement with optional protected failures. */
function rows(p: EvaluationPlan, regress = false): EvaluationObservation[] { return p.members.map((m, i) => ({ id: m.id, candidate: regress && i < 2 ? 0 : 1, incumbent: regress && i < 2 ? 1 : 0 })); }
/** Match only actionable package refusals. */
function refused(code: string) { return (error: unknown): boolean => isPmCliExpectedError(error) && error.context.code === code && /fresh candidate/.test(error.message); }
/** Real tracker, fresh SDK clients and no inherited session focus. */
async function workspace() {
  const root = mkdtempSync(join(tmpdir(), "rl-cohort-")); roots.push(root);
  const tracker = await init("rl", { defaults: true, author: "cohort-test", agentGuidance: "skip" }, { cwd: root, pmRoot: join(root, ".agents/pm") });
  const client = new PmClient({ cwd: root, pmRoot: tracker.path, author: "cohort-test", noExtensions: true });
  for (const name of ["Generation", "Run"]) await client.schemaAddType(name, { folder: `${name.toLowerCase()}s`, defaultStatus: "open" });
  await client.create({ id: "rl-seed", type: "Generation", title: "Seed", body: `\`\`\`json\n${JSON.stringify(seed())}\n\`\`\``, affectedVersion: hashJson(generationProvenance(seed())), unset: ["parent"] });
  return { root, pmRoot: tracker.path, client };
}
/** Collection and candidate are created after registration, with a pinned comparison. */
async function candidate(client: PmClient, p: EvaluationPlan): Promise<void> {
  const run = `${p.candidate}-collection`; await client.create({ id: run, type: "Run", title: "Collection", unset: ["parent"] });
  const spec: GenerationSpec = { ...seed(), parent: "rl-seed", seed: false, policy: "candidate", collection_runs: [run], environment_version: "train", reward_spec_version: "1", evaluation_plan: evaluationComparison(p) };
  await client.create({ id: p.candidate, type: "Generation", title: "Candidate", body: `\`\`\`json\n${JSON.stringify(spec)}\n\`\`\``, affectedVersion: hashJson(generationProvenance(spec)), unset: ["parent"] });
}
/** A score binds the exact producer output, without handwritten rounding or normalization. */
function score(p: EvaluationPlan, value: number): ScoreRecord { return { objective: p.objective, objective_version: p.objective_version, evaluation_context: p.evaluation_context, direction: p.direction, seed_set: evaluationComparison(p), scale: p.reward_bounds[1] - p.reward_bounds[0], value }; }
/** A fixed seed gives reproducible operation sequences and native input variants. */
function random(seedValue: number): () => number { let state = seedValue; return () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state; }; }

test("higher aggregate mean refuses on any protected cohort, while legacy and passing designs retain the original gate", () => {
  const p = design(); const result = evaluatePlan(p, rows(p, true));
  assert.equal(result.aggregate_verdict?.decision, "promote"); assert.equal(result.verdict.decision, "refuse");
  assert.equal(result.cohorts?.[0].code, "eval_cohort_regression"); assert.ok(result.candidate_mean > result.incumbent_mean); assert.ok(result.remedy);
  assert.equal(evaluatePlan(p, rows(p)).verdict.decision, "promote");
  const { protected_cohorts: _cohorts, ...legacy } = p;
  assert.equal(evaluatePlan(legacy, rows(p, true)).verdict.decision, "promote");
  assert.equal(Object.hasOwn(parseEvaluationPlan(legacy), "protected_cohorts"), false);
  const sparse = { ...p, protected_cohorts: [{ ...p.protected_cohorts![0], min_units: 3 }] };
  assert.equal(evaluatePlan(sparse, rows(p)).cohorts?.[0].code, "eval_cohort_samples");
  const correlated = { ...p, members: p.members.map((m, i) => ({ ...m, unit: i < 2 ? "shared" : m.unit })), stopping: { ...p.stopping, independent_units: 99 } };
  assert.equal(evaluatePlan(correlated, rows(p)).cohorts?.[0].independent_units, 1);
  assert.equal(evaluatePlan(correlated, rows(p)).verdict.decision, "refuse");
  const tied = rows(p).map((row) => ({ ...row, candidate: 0, incumbent: 0 }));
  assert.equal(evaluatePlan(p, tied).verdict.decision, "refuse");
});

test("protected cohorts cannot silently bypass their fixed-sample contract in a sequential design", () => {
  const p = design();
  const stopping = { kind: "sequential", method: "hoeffding-alpha-spending/1", observations: 100, independent_units: 100, unit_order: p.members.map((member) => member.unit), looks: [50, 100], review: "rl-review" };
  assert.throws(() => parseEvaluationPlan({ ...p, stopping }), (error: unknown) => isPmCliExpectedError(error) && error.context.code === "eval_plan_stopping" && /fixed-sample/.test(error.message));
});

test("strict schema rejects sparse, oversized, ambiguous and extreme cohort inputs before storage", () => {
  const p = design(); const c = p.protected_cohorts![0]; const sparse: string[] = []; sparse.length = 1;
  const invalid: unknown[] = [null, [], new Array(1), Array(33).fill(c), [{ ...c, extra: 1 }], [{ ...c, id: "x".repeat(129) }], [c, c], [{ ...c, members: sparse }], [{ ...c, members: [] }], [{ ...c, members: Array(10001).fill("task-0") }], [{ ...c, members: ["absent"] }], [{ ...c, members: ["task-0", " task-0 "] }]];
  for (const field of ["min_units", "max_regression"]) for (const value of [NaN, Infinity, -Infinity, -1, "1", Number.MAX_VALUE]) invalid.push([{ ...c, [field]: value }]);
  invalid.push([{ ...c, min_units: 0 }], [{ ...c, min_units: 1.5 }], [{ ...c, max_regression: 2 }]);
  for (const protected_cohorts of invalid) assert.throws(() => parseEvaluationPlan({ ...p, protected_cohorts }), refused("eval_plan_invalid"));
  assert.throws(() => parseEvaluationPlan({ ...p, members: new Array(100) }), refused("eval_plan_invalid"));
  assert.throws(() => parseEvaluationPlan({ ...p, reward_bounds: new Array(2) }), refused("eval_plan_invalid"));
  assert.throws(() => evaluatePlan(p, new Array(100)), refused("eval_plan_stopping"));
  const shuffled = { ...p, protected_cohorts: [{ ...c, id: " z ", members: [" task-1 ", "task-0"] }, { ...c, id: "a" }] };
  assert.equal(evaluationComparison(shuffled), evaluationComparison(parseEvaluationPlan(shuffled)));
  assert.deepEqual(parseEvaluationPlan(shuffled).protected_cohorts?.map((cohort) => cohort.id), ["a", "z"]);
});

test("exact rational boundaries use equal unit means and inclusive decimal limits in both directions", () => {
  const next = random(0xc0a07);
  for (let trial = 0; trial < 500; trial += 1) {
    const p = design(); const n = next() % 17 + 1; const losses = next() % (n + 1);
    const members = Array.from({ length: n }, (_, i) => ({ id: `m-${i}`, unit: `u-${i}` }));
    // Integer rewards and a rational count oracle are independent of production arithmetic.
    for (const direction of ["maximize", "minimize"] as const) {
      const limit = (next() % 11) / 10;
      const plan = { ...p, direction, members, stopping: { kind: "fixed" as const, observations: n, independent_units: n }, protected_cohorts: [{ id: "count", members: members.map((m) => m.id), min_units: 1, max_regression: limit }] };
      const input = members.map((m, i) => ({ id: m.id, candidate: direction === "maximize" ? 0 : i < losses ? 1 : 0, incumbent: direction === "maximize" && i < losses ? 1 : 0 }));
      const expected = BigInt(losses) * 10n > BigInt(Math.round(limit * 10)) * BigInt(n);
      assert.equal(evaluatePlan(plan, input).cohorts![0].code, expected ? "eval_cohort_regression" : null);
    }
  }
  const p = design();
  const decimals = rows(p).map((r, i) => ({ ...r, candidate: i < 2 ? 0.2 : 1, incumbent: i < 2 ? 0.3 : 0 }));
  assert.equal(evaluatePlan({ ...p, protected_cohorts: [{ ...p.protected_cohorts![0], max_regression: 0.1 }] }, decimals).cohorts![0].code, null);
  const decimalBounds = { ...p, reward_bounds: [0.1, 0.3] as const, protected_cohorts: [{ ...p.protected_cohorts![0], max_regression: 0.2 }] };
  assert.equal(evaluatePlan(decimalBounds, rows(p).map((r) => ({ ...r, candidate: 0.1, incumbent: 0.3 }))).cohorts![0].code, null);
  for (const range of [Number.MIN_VALUE, 1e-100, 1e100, 1e308]) {
    const plan = { ...p, reward_bounds: [0, range] as const, protected_cohorts: [{ ...p.protected_cohorts![0], max_regression: range }] };
    const report = evaluatePlan(plan, rows(p).map((r) => ({ ...r, candidate: 0, incumbent: range })));
    assert.equal(report.cohorts![0].code, null); assert.ok(Number.isFinite(report.cohorts![0].improvement));
  }
  const unequal = { ...p, members: p.members.map((m, i) => ({ ...m, unit: i === 1 ? "unit-0" : m.unit })), stopping: { ...p.stopping, independent_units: 99 }, protected_cohorts: [{ id: "unequal", members: ["task-0", "task-1", "task-2"], min_units: 2, max_regression: 0 }] };
  assert.equal(evaluatePlan(unequal, rows(p).map((r, i) => ({ ...r, candidate: i < 2 ? 0 : 1, incumbent: i < 2 ? 1 : 0 }))).cohorts![0].code, null);
});

test("producer reports round-trip and reject every nonfinite or out-of-domain numeric output", () => {
  const p = design(); const report = evaluatePlan(p, rows(p));
  assert.deepEqual(validateEvaluationReport(JSON.parse(JSON.stringify(report)), p.reward_bounds), report);
  for (const cohorts of [[], new Array(1), Array(33).fill(report.cohorts![0])]) assert.throws(() => validateEvaluationReport({ ...report, cohorts }, p.reward_bounds), refused("eval_plan_evidence"));
  for (const field of ["candidate_mean", "incumbent_mean", "observations", "independent_units"]) for (const value of [NaN, Infinity, -Infinity, -1, Number.MAX_VALUE]) assert.throws(() => validateEvaluationReport({ ...report, [field]: value }, p.reward_bounds), refused("eval_plan_evidence"));
  for (const patch of [{ observations: 0 }, { observations: 10001 }, { observations: 1.5 }, { independent_units: 0 }, { independent_units: 101 }, { independent_units: 1.5 }]) assert.throws(() => validateEvaluationReport({ ...report, ...patch }, p.reward_bounds), refused("eval_plan_evidence"));
  for (const patch of [{ improvement: Infinity }, { improvement: 2 }, { max_regression: -1 }, { max_regression: 2 }, { independent_units: 0 }, { independent_units: 3 }, { independent_units: 1.5 }, { observations: 0 }, { observations: 1.5 }, { observations: 10001 }, { min_units: 0 }, { min_units: 1.5 }, { min_units: 10001 }]) assert.throws(() => validateEvaluationReport({ ...report, cohorts: [{ ...report.cohorts![0], ...patch }] }, p.reward_bounds), refused("eval_plan_evidence"));
  assert.throws(() => validateEvaluationReport({ ...report, aggregate_verdict: { decision: "promote", reason: "Synthetic", candidateBound: 0, incumbentBound: 0, candidateEpsilon: 0, incumbentEpsilon: 0, margin: Infinity } }, p.reward_bounds), refused("eval_plan_evidence"));
});

test("real CLI and promotion refuse protected regressions and insufficient samples without changing labels", async () => {
  const w = await workspace(); const harness = await createExtensionTestHarness(extension, { name: "pm-rl", capabilities: ["commands", "hooks", "schema"] });
  /** Use actual command-created run provenance, including the independent leakage check. */
  async function command(name: string, args: string[] = [], options: Record<string, string> = {}): Promise<RlCommandResult> {
    return (await harness.runCommand({ command: name, pmRoot: w.pmRoot, args, options })).result as RlCommandResult;
  }
  const envFile = join(w.root, "env.json"); writeFileSync(envFile, JSON.stringify({ name: "Training", version: "1", task_suite: ["train"], reward_specification: { reward: 1 } }));
  const environment = (await command("rl env register", [], { file: envFile })).id!;
  const approval = await w.client.create({ id: "rl-approval", type: "Decision", title: "Approval", body: '```json\n{"permitted_promotions":1}\n```', unset: ["parent"] });
  for (const [suffix, minimum, expected] of [["regression", 2, "eval_cohort_regression"], ["samples", 3, "eval_cohort_samples"]] as const) {
    const p = design(`rl-${suffix}`); const input = { ...p, protected_cohorts: [{ ...p.protected_cohorts![0], min_units: minimum }] };
    const file = join(w.root, "plan.json"); writeFileSync(file, JSON.stringify(input));
    const registered = await harness.runCommand({ command: "rl eval plan register", pmRoot: w.pmRoot, options: { file } });
    assert.equal((registered.result as RlCommandResult).details?.protected_cohorts, 1);
    const shown = await harness.runCommand({ command: "rl eval plan show", pmRoot: w.pmRoot, args: [p.candidate] });
    assert.equal((shown.result as RlCommandResult).details?.protected_cohorts, 1);
    await command("rl run start", [`${suffix}-collection`], { environment, algorithm: "bandit" });
    await command("rl generation register", [p.candidate], { baseCheckpoint: "candidate", parent: "rl-seed", policy: "candidate", collectionRuns: `${suffix}-collection`, environment });
    const observations = rows(input, true); const rowFile = join(w.root, "rows.json"); writeFileSync(rowFile, JSON.stringify(observations));
    const run = await harness.runCommand({ command: "rl eval plan evaluate", pmRoot: w.pmRoot, args: [p.candidate], options: { file: rowFile } });
    assert.ok(Number((run.result as RlCommandResult).details?.candidate_mean) > 0.9);
    const report = await recordPlanEvaluation(w.client, p.candidate, observations);
    assert.equal(report.verdict.decision, "refuse");
    await assert.rejects(enforceEvaluationPlan(w.client, p.candidate, score(input, report.candidate_mean)), refused(expected));
    const scores = join(w.root, "scores.json"); writeFileSync(scores, JSON.stringify({ held_out_score: score(input, report.candidate_mean), proxy_score: { ...score(input, report.candidate_mean), evaluation_context: "proxy" } }));
    await assert.rejects(command("rl generation promote", [p.candidate], { approval: approval.item.id, scores, evidence: "Frozen protected cohort comparison" }), refused(expected));
    assert.ok(JSON.stringify(run.result).length < 2500);
    await assert.rejects(registerEvaluationPlan(w.client, { ...input, protected_cohorts: [{ ...input.protected_cohorts[0], max_regression: 1 }] }), refused("eval_plan_drift"));
    const stored = await readEvaluationPlan(w.client, p.candidate); assert.equal(stored?.comparison, evaluationComparison(input));
  }
  const late = design("rl-late"); await candidate(w.client, late);
  await assert.rejects(registerEvaluationPlan(w.client, late), refused("eval_plan_late"));
  const p = { ...design("rl-leakage"), evaluation_context: environment };
  await registerEvaluationPlan(w.client, p);
  await command("rl run start", ["leakage-collection"], { environment, algorithm: "bandit" });
  await command("rl generation register", [p.candidate], { baseCheckpoint: "candidate", parent: "rl-seed", policy: "candidate", collectionRuns: "leakage-collection", environment });
  const report = await recordPlanEvaluation(w.client, p.candidate, rows(p)); assert.equal(report.verdict.decision, "promote");
  const scoreFile = join(w.root, "scores.json"); writeFileSync(scoreFile, JSON.stringify({ held_out_score: score(p, report.candidate_mean), proxy_score: { ...score(p, report.candidate_mean), evaluation_context: "proxy" } }));
  await assert.rejects(command("rl generation promote", [p.candidate], { approval: approval.item.id, scores: scoreFile, evidence: "Protected slices passed; training leakage still refuses" }), (error: unknown) => isPmCliExpectedError(error) && error.context.code === "contamination_refused");
});

test("500 seeded operation sequences replay normalized declarations and evidence against an SDK-read reference model", { timeout: 600_000 }, async () => {
  const w = await workspace(); const next = random(0x500c0a); const pick = () => next() >>> 16;
  const fields = "id,type,body,affected_version,parent,sprint,release,dependencies,title,status,created_at";
  const model = new Map<string, { plan: EvaluationPlan; native: GetResult["item"]; result: GetResult["item"]; input: EvaluationObservation[] }>();
  const focus = await w.client.create({ id: "rl-focus", title: "Unrelated ambient scope", type: "Task", unset: ["parent"] });
  const scopes = [focus.item.id];
  for (let i = 0; i < 3; i += 1) scopes.push((await w.client.create({ id: `rl-focus-${pick()}`, title: "Random ambient scope", type: "Task", unset: ["parent"] })).item.id);
  const emptyScope = (await readCompleteLoopItem(w.client, "rl-seed", undefined, "parent,sprint,release,dependencies")).item;
  await w.client.focus(focus.item.id);
  // Distinct custom status names prove that no status spelling is interpreted by this feature.
  for (let i = 0; i < 3; i += 1) await w.client.schemaAddStatus(`custom-${pick()}`, { role: ["active"] });
  for (let sequence = 0; sequence < 500; sequence += 1) {
    const key = `rl-model-${pick() % 4}`; const prior = model.get(key); const p = prior?.plan ?? parseEvaluationPlan(design(key));
    if (prior === undefined) await w.client.focus(scopes[pick() % scopes.length]);
    const variant = JSON.parse(JSON.stringify({ ...p, population: ` \r\n${p.population}\r\n `, members: [...p.members].reverse(), protected_cohorts: p.protected_cohorts!.map((c) => ({ ...c, members: [...c.members].reverse() })) })) as unknown;
    const registered = prior === undefined || sequence % 50 === 0 ? await registerEvaluationPlan(w.client, variant) : { id: `${key}-evaluation-plan` };
    assert.deepEqual(parseEvaluationPlan(variant), p);
    if (prior === undefined) {
      await candidate(w.client, p); const input = rows(p, (pick() & 1) === 1);
      await recordPlanEvaluation(w.client, key, input);
      const native = (await readCompleteLoopItem(w.client, registered.id, undefined, fields)).item;
      const result = (await readCompleteLoopItem(w.client, `${registered.id}-result`, undefined, fields)).item;
      assert.deepEqual(JSON.parse(String(native.body)), { plan: p, incumbent_version: p.incumbent_version });
      assert.equal(native.title, "Predeclared paired policy evaluation"); assert.equal(native.type, "Plan");
      assert.equal(result.title, "Fixed-stop paired evaluation result"); assert.equal(result.type, "Decision");
      for (const item of [native, result]) {
        assert.equal(item.parent, emptyScope.parent); assert.equal(item.sprint, emptyScope.sprint);
        assert.equal(item.release, emptyScope.release); assert.deepEqual(item.dependencies, emptyScope.dependencies);
      }
      model.set(key, { plan: p, native, result, input });
    }
    const expected = model.get(key)!;
    if ((pick() & 31) === 0) {
      const target = (pick() & 1) === 0 ? "native" : "result"; const parent = scopes[pick() % scopes.length];
      await w.client.update(expected[target].id, { parent, dep: [`id=${parent},kind=related_to`], unset: ["sprint", "release"] });
      // Native edits are an independent operation in the model; SDK read-back supplies canonical relationships.
      expected[target] = (await readCompleteLoopItem(w.client, expected[target].id, undefined, fields)).item;
    }
    // Older saved inputs and CRLF/whitespace payloads must not change a sealed target.
    if ((pick() & 31) === 0) await assert.rejects(registerEvaluationPlan(w.client, { ...p, selection: `changed-${sequence}` }), refused("eval_plan_drift"));
    const report = sequence % 50 === 0 ? await recordPlanEvaluation(w.client, ` \r\n${key}\r\n `, [...expected.input].reverse()) : evaluatePlan(variant, JSON.parse(JSON.stringify([...expected.input].reverse())));
    assert.deepEqual(report, evaluatePlan(expected.plan, expected.input));
    const native = (await readCompleteLoopItem(w.client, registered.id, undefined, fields)).item;
    assert.deepEqual(native, expected.native);
    if (sequence % 50 === 0) assert.deepEqual((await readEvaluationPlan(w.client, key))!.plan, expected.plan);
    if (sequence % 2 !== 0) continue;
    const sealed = (await readCompleteLoopItem(w.client, `${registered.id}-result`, undefined, fields)).item;
    assert.deepEqual(sealed, expected.result);
    const result = JSON.parse(String(sealed.body)) as { comparison: string; observations: EvaluationObservation[] };
    assert.equal(result.comparison, evaluationComparison(expected.plan));
    assert.deepEqual(result.observations, [...expected.input].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    assert.equal(readFileSync(join(w.pmRoot, "plans", `${registered.id}.toon`), "utf8").includes("protected_cohorts"), true);
  }
});

test("native annotations, custom active statuses and relationships survive all plan and evidence retries", async () => {
  const w = await workspace(); const p = design(); const next = random(0x123456);
  const status = `custom-${next()}`; await w.client.schemaAddStatus(status, { role: ["active"] });
  await w.client.create({ id: "rl-related", type: "Task", title: "Unrelated target", unset: ["parent"] });
  const registered = await registerEvaluationPlan(w.client, p); await candidate(w.client, p); await recordPlanEvaluation(w.client, p.candidate, rows(p));
  for (const id of [registered.id, `${registered.id}-result`]) {
    await w.client.update(id, { title: "Operator annotation", status, parent: "rl-related", dep: ["id=rl-related,kind=related_to"], unset: ["sprint", "release"] });
    const fields = "id,type,body,affected_version,parent,sprint,release,dependencies,title,status,created_at";
    const before = (await readCompleteLoopItem(w.client, id, undefined, fields)).item;
    await registerEvaluationPlan(w.client, p); await recordPlanEvaluation(w.client, p.candidate, rows(p));
    assert.deepEqual((await readCompleteLoopItem(w.client, id, undefined, fields)).item, before);
  }
  await enforceEvaluationPlan(w.client, p.candidate, score(p, 1));
});

test("competing declarations and evaluations serialize at every SDK step boundary on one non-git tracker", { timeout: 600_000 }, async () => {
  const w = await workspace(); const peer = new PmClient({ cwd: w.root, pmRoot: w.pmRoot, author: "cohort-peer", noExtensions: true });
  let boundary = 0; let injectAt = -1; let inject: (() => void) | null = null;
  /** Reset only after the prior invocation and its competing writer have settled. */
  function resetBoundary(): void { boundary = 0; }
  // Instrument native operations after they execute; successful reads and writes always use the real SDK.
  for (const name of ["config", "get", "create"] as const) {
    const original = w.client[name].bind(w.client);
    Reflect.set(w.client, name, (async (...args: Parameters<typeof original>) => {
      const result = await Reflect.apply(original, w.client, args);
      boundary += 1;
      if (boundary === injectAt) inject!();
      return result;
    }) as typeof w.client[typeof name]);
  }
  const probe = design("rl-probe"); await registerEvaluationPlan(w.client, probe); const registrationSteps = boundary;
  await candidate(w.client, probe); resetBoundary(); await recordPlanEvaluation(w.client, probe.candidate, rows(probe)); const evaluationSteps = boundary;
  for (const path of ["registration", "evaluation"] as const) for (let step = 1; step <= (path === "registration" ? registrationSteps : evaluationSteps); step += 1) {
    const p = design(`rl-${path}-${step}`); const input = rows(p); let competing: Promise<unknown> | undefined;
    if (path === "evaluation") { await registerEvaluationPlan(w.client, p); await candidate(w.client, p); }
    resetBoundary(); injectAt = step;
    inject = () => { competing = (path === "registration" ? registerEvaluationPlan(peer, { ...p, selection: "Peer frozen selection" }) : recordPlanEvaluation(peer, p.candidate, rows(p, true))).then((value) => ({ ok: true, value }), (error: unknown) => ({ ok: false, error })); };
    const own = await (path === "registration" ? registerEvaluationPlan(w.client, p) : recordPlanEvaluation(w.client, p.candidate, input)).then((value) => ({ ok: true, value }), (error: unknown) => ({ ok: false, error }));
    assert.ok(competing, `${path} boundary ${step} was not reached`); const other = await competing as { ok: boolean };
    assert.notEqual(own.ok, other.ok, `${path} boundary ${step} must have exactly one immutable winner`);
    injectAt = -1;
    const native = (await readCompleteLoopItem(peer, `${p.candidate}-evaluation-plan${path === "evaluation" ? "-result" : ""}`)).item;
    const created = (await readCompleteLoopItem(peer, native.id, "1")).item;
    assert.equal(native.body, created.body); assert.equal(native.affected_version, created.affected_version);
    if (path === "evaluation") {
      const saved = JSON.parse(String(native.body)) as { observations: EvaluationObservation[] };
      assert.deepEqual(evaluatePlan(p, saved.observations), "value" in own ? own.value : await recordPlanEvaluation(peer, p.candidate, rows(p, true)));
    } else assert.equal((await readEvaluationPlan(peer, p.candidate))!.plan.selection, own.ok ? p.selection : "Peer frozen selection");
  }
});
