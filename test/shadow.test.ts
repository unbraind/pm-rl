/** Online deployment regressions use real SDK trackers with no Git or mocked clients. */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, symlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { after, test } from "node:test";
import { PmClient } from "@unbrained/pm-cli/sdk/core";
import { init, isPmCliExpectedError } from "@unbrained/pm-cli/sdk/runtime";
import { createExtensionTestHarness } from "@unbrained/pm-cli/sdk/testing";
import extension, { hashJson, generationProvenance, extractGenerationSpec, readCompleteLoopItem, type JsonValue, type RlCommandResult } from "../index.ts";
import { registerShadowDeployment, parseShadowDeployment, shadowInputDigest, observeShadow, compareShadow, enforceShadowComparison, type ShadowDeployment } from "../shadow.ts";
import { evaluationComparison, registerEvaluationPlan, readEvaluationPlan, recordPlanEvaluation, enforceEvaluationPlan, type EvaluationPlan } from "../evaluation-plan.ts";
import type { GenerationSpec, ScoreRecord } from "../lineage.ts";

const roots: string[] = [];
after(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });
/** A ten-input explicitly consented lookup deployment. */
function deployment(candidate: ShadowDeployment["candidate"] = { event: "accept" }): ShadowDeployment {
  return { format: "pm-rl/shadow/1", consent: "rl-consent", generation: "rl-candidate", incumbent: "rl-seed", active: { event: "hold" }, candidate,
    inputs: Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`event-${i}`, shadowInputDigest("event")])), budget: { active_calls: 10, candidate_calls: 10 } };
}
/** Checkpoint provenance binds the same inert artifacts later interpreted online. */
function spec(policy: ShadowDeployment["active"], parent: string | null = null): GenerationSpec {
  return { base_checkpoint: "checkpoint", policy: parent === null ? "" : "collection-policy", collection_runs: parent === null ? [] : ["rl-collection"], training_config: { shadow_policy: hashJson(policy as JsonValue) }, environment_version: parent === null ? "" : "train-env", reward_spec_version: parent === null ? "" : "rewards", parent, seed: parent === null, promoted: false, approval: null, proxy_score: null, held_out_score: null, gap: null, promotion_evidence: null };
}
/** Freeze statistical choices before collection; these independent units are synthetic controls only. */
function plan(d = deployment()): EvaluationPlan {
  return { format: "pm-rl/evaluation-plan/1", candidate: "rl-candidate", incumbent: "rl-seed", incumbent_version: hashJson(generationProvenance(spec(d.active))), population: "Consented events", selection: "all events", correlation_unit: "event", members: Object.keys(d.inputs).map((id) => ({ id, unit: id })), objective: "decision_reward", objective_version: "v1", evaluation_context: "held-out", direction: "maximize", reward_bounds: [0, 1], criterion: { confidence: 0.5, minSamples: 10, effectThreshold: 0 }, stopping: { kind: "fixed", observations: 10, independent_units: 10 } };
}
/** Initialize a non-Git tracker and install actual extension schema. */
async function workspace(d = deployment()) {
  const root = mkdtempSync(join(tmpdir(), "rl-shadow-")); roots.push(root);
  const initialized = await init("rl", { defaults: true, author: "shadow-test", agentGuidance: "skip" }, { cwd: root });
  const client = new PmClient({ pmRoot: initialized.path, cwd: root, author: "shadow-test", noExtensions: true });
  for (const [type, folder] of [["Generation", "generations"], ["Run", "runs"]]) await client.schemaAddType(type, { folder, defaultStatus: "open" });
  await addGeneration(client, "rl-seed", spec(d.active));
  await client.create({ id: d.consent, title: "Explicit shadow input consent", type: "Decision", body: JSON.stringify({ format: "pm-rl/shadow-consent/1", deployment: hashJson(d as unknown as JsonValue) }) });
  return { root, pmRoot: initialized.path, client, d, p: plan(d) };
}
/** Store the same provenance shape as real generation registration. */
async function addGeneration(client: PmClient, id: string, value: GenerationSpec) {
  await client.create({ id, title: id, type: "Generation", body: `\`\`\`json\n${JSON.stringify(value)}\n\`\`\``, affectedVersion: hashJson(generationProvenance(value)) });
}
/** Collection follows reservation, including SDK creation timestamps. */
async function collect(w: Awaited<ReturnType<typeof workspace>>) {
  await w.client.create({ id: "rl-collection", title: "Training collection", type: "Run", environment: "train-env" });
  const registered = (await readEvaluationPlan(w.client, "rl-candidate"))!;
  await addGeneration(w.client, "rl-candidate", { ...spec(w.d.candidate, "rl-seed"), evaluation_plan: registered.comparison });
}
/** Check stable typed codes and concrete recovery text. */
function refusal(code: string) { return (error: unknown): boolean => isPmCliExpectedError(error) && error.context.code === code && error.exitCode === 4 && /fresh|Complete/.test(error.message); }
/** One reward-bearing observation; these rewards are synthetic controls. */
function input(id = "event-0") { return { id, input: "event", rewards: { accept: 1, hold: 0 } }; }
/** The held-out score is derived from the frozen plan identity. */
function score(p: EvaluationPlan): ScoreRecord { return { objective: p.objective, objective_version: p.objective_version, evaluation_context: p.evaluation_context, seed_set: evaluationComparison(p), direction: "maximize", scale: 1, value: 1 }; }

test("strict parsers reject executable, unbounded, ambiguous and invalid consent data", () => {
  const d = deployment(); assert.deepEqual(parseShadowDeployment(d), d);
  for (const value of [null, [], 1, { ...d, extra: true }, { ...d, format: "v2" }, { ...d, consent: "" }, { ...d, consent: 5 }, { ...d, consent: "x".repeat(1025) }, { ...d, inputs: { id: "not-a-hash" } }, { ...d, active: null }, { ...d, candidate: { event: 1 } }, { ...d, candidate: Object.fromEntries(Array.from({ length: 10001 }, (_, i) => [String(i), "a"])) }]) assert.throws(() => parseShadowDeployment(value), refusal("shadow_invalid"));
  for (const n of [-1, 1.2, NaN, Infinity, 10001, "2"]) assert.throws(() => parseShadowDeployment({ ...d, budget: { active_calls: n, candidate_calls: 10 } }), refusal("shadow_budget"));
  assert.throws(() => parseShadowDeployment({ ...d, budget: { active_calls: 10 } }), refusal("shadow_invalid"));
});

test("same input active action survives candidate failure; both attempts are charged and promotion refuses", async () => {
  const w = await workspace(deployment({})); const r = await registerShadowDeployment(w.client, w.d, w.p);
  assert.equal(r.reserved_calls, 20); await collect(w);
  for (const m of w.p.members) {
    const observation = await observeShadow(w.client, "rl-candidate", input(m.id));
    assert.equal(observation.active_action, "hold"); assert.equal(observation.candidate_action, null); assert.equal(observation.failure, "candidate_missing_action");
  }
  const report = await compareShadow(w.client, "rl-candidate");
  assert.equal(report.candidate_failures, 10); assert.equal(report.disagreements, 0); assert.deepEqual(report.charged, { active_calls: 10, candidate_calls: 10 }); assert.equal(report.outcome, null); assert.ok(report.remedy);
  await assert.rejects(enforceEvaluationPlan(w.client, "rl-candidate", score((await readEvaluationPlan(w.client, "rl-candidate"))!.plan)), refusal("shadow_failed"));
  assert.equal(extractGenerationSpec(String((await readCompleteLoopItem(w.client, "rl-candidate")).item.body), "candidate").promoted, false);
});

test("consent and complete dual-arm reservation precede all collection", async () => {
  const w = await workspace();
  await assert.rejects(registerShadowDeployment(w.client, { ...w.d, consent: "absent" }, w.p), refusal("shadow_consent"));
  await assert.rejects(registerShadowDeployment(w.client, { ...w.d, active: { event: "other" } }, w.p), refusal("shadow_consent"));
  await assert.rejects(registerShadowDeployment(w.client, w.d, { ...w.p, candidate: "rl-other" }), refusal("shadow_consent"));
  const invalid: ShadowDeployment[] = [{ ...deployment(), inputs: {} }, { ...deployment(), inputs: { extra: shadowInputDigest("event") } }, { ...deployment(), budget: { active_calls: 9, candidate_calls: 10 } }, { ...deployment(), budget: { active_calls: 10, candidate_calls: 9 } }];
  for (const d of invalid) {
    const other = await workspace(d);
    await assert.rejects(registerShadowDeployment(other.client, d, w.p), refusal(Object.keys(d.inputs).length === 10 ? "shadow_budget" : "shadow_consent"));
  }
  await assert.rejects(compareShadow(w.client, "missing"), refusal("shadow_missing"));
  await registerEvaluationPlan(w.client, w.p);
  await assert.rejects(compareShadow(w.client, "rl-candidate"), refusal("shadow_missing"));
  await enforceShadowComparison(w.client, "rl-candidate", w.p);
});

test("retry-safe observations and comparisons cannot authorize a switch without the sealed outcome", async () => {
  const w = await workspace({ ...deployment(), active: { unused: "hold", event: "hold" }, candidate: { unused: "accept", event: "accept" } }); const registered = await registerShadowDeployment(w.client, w.d, w.p);
  const reordered = { ...w.d, active: { event: "hold", unused: "hold" }, candidate: { event: "accept", unused: "accept" } };
  assert.deepEqual(await registerShadowDeployment(w.client, reordered, w.p), registered);
  await collect(w); const p = (await readEvaluationPlan(w.client, "rl-candidate"))!.plan;
  await assert.rejects(enforceEvaluationPlan(w.client, "rl-candidate", score(p)), refusal("shadow_missing"));
  await assert.rejects(compareShadow(w.client, "rl-candidate"), refusal("shadow_incomplete"));
  const observations = p.members.map((m) => ({ id: m.id, candidate: 1, incumbent: 0 }));
  await recordPlanEvaluation(w.client, "rl-candidate", observations);
  await assert.rejects(enforceEvaluationPlan(w.client, "rl-candidate", score(p)), refusal("shadow_missing"));
  for (const m of p.members) {
    const observed = await observeShadow(w.client, "rl-candidate", input(m.id)); assert.equal(observed.active_action, "hold"); assert.equal(observed.candidate_action, "accept");
    assert.deepEqual(await observeShadow(w.client, "rl-candidate", input(m.id)), observed);
  }
  const report = await compareShadow(w.client, "rl-candidate");
  assert.equal(report.outcome?.verdict.decision, "promote"); assert.equal(report.candidate_failures, 0); assert.equal(report.remedy, null); assert.ok(JSON.stringify(report).length < 1600);
  assert.deepEqual(await compareShadow(w.client, "rl-candidate"), report);
  await enforceEvaluationPlan(w.client, "rl-candidate", score(p));
  await assert.rejects(observeShadow(w.client, "rl-candidate", { ...input(), rewards: { accept: 0, hold: 1 } }), refusal("shadow_drift"));
  await w.client.delete(`${report.outcome!.plan}-result`);
  await assert.rejects(enforceEvaluationPlan(w.client, "rl-candidate", score(p)), refusal("eval_plan_missing"));
  await assert.rejects(w.client.get(`${report.outcome!.plan}-result`));
  assert.equal(extractGenerationSpec(String((await readCompleteLoopItem(w.client, "rl-candidate")).item.body), "candidate").promoted, false);
});

test("unconsented, malformed and out-of-bound inputs cannot invoke either arm", async () => {
  const w = await workspace(); await registerShadowDeployment(w.client, w.d, w.p); await collect(w);
  for (const patch of [{ id: "foreign" }, { input: "other" }]) await assert.rejects(observeShadow(w.client, "rl-candidate", { ...input(), ...patch }), refusal("shadow_consent"));
  for (const value of [null, { ...input(), extra: 1 }, { ...input(), rewards: { hold: NaN } }, { ...input(), rewards: { hold: -1 } }, { ...input(), rewards: { hold: 2 } }, { ...input(), rewards: { hold: "0" } }, { ...input(), rewards: { accept: 1 } }]) await assert.rejects(observeShadow(w.client, "rl-candidate", value), refusal("shadow_invalid"));
  const valid = await observeShadow(w.client, "rl-candidate", { ...input(), rewards: { hold: 0 } }); assert.equal(valid.failure, "candidate_missing_outcome");
  const missingActive = await workspace({ ...deployment(), active: {} });
  await registerShadowDeployment(missingActive.client, missingActive.d, missingActive.p); await collect(missingActive);
  await assert.rejects(observeShadow(missingActive.client, "rl-candidate", input()), refusal("shadow_invalid"));
});

test("changed policy bindings and edited sealed records fail closed", async () => {
  const w = await workspace(); const registered = await registerShadowDeployment(w.client, w.d, w.p); await collect(w);
  const candidate = (await readCompleteLoopItem(w.client, "rl-candidate")).item;
  const changed = { ...spec(w.d.candidate, "rl-seed"), training_config: {} };
  await w.client.update("rl-candidate", { body: `\`\`\`json\n${JSON.stringify(changed)}\n\`\`\`` });
  await assert.rejects(observeShadow(w.client, "rl-candidate", input()), refusal("shadow_drift"));
  await w.client.update("rl-candidate", { body: String(candidate.body) });
  await w.client.update(registered.id, { body: "{}" });
  await assert.rejects(compareShadow(w.client, "rl-candidate"), refusal("shadow_drift"));
});

test("CLI online observation and authoritative promotion work with git absent from PATH", async () => {
  const w = await workspace(); const bin = join(w.root, "bin"); mkdirSync(bin); symlinkSync(process.execPath, join(bin, "node"));
  const oldPath = process.env.PATH; const oldCeiling = process.env.GIT_CEILING_DIRECTORIES;
  process.env.PATH = bin; process.env.GIT_CEILING_DIRECTORIES = dirname(w.root);
  try {
    const harness = await createExtensionTestHarness(extension, { name: "pm-rl", capabilities: ["commands", "hooks", "schema"] });
    /** Exercise the actual typed extension handlers and persisted SDK data. */
    async function command(name: string, args: string[] = [], options: Record<string, string> = {}): Promise<RlCommandResult> {
      const result = await harness.runCommand({ command: name, pmRoot: w.pmRoot, args, options }); assert.equal(result.handled, true); return result.result as RlCommandResult;
    }
    const configFile = join(w.root, "deployment.json"); writeFileSync(configFile, JSON.stringify({ deployment: w.d, plan: w.p }));
    assert.equal((await command("rl shadow register", [], { file: configFile })).details?.reserved_calls, 20);
    await collect(w);
    const p = (await readEvaluationPlan(w.client, "rl-candidate"))!.plan;
    const scoresFile = join(w.root, "scores.json"); writeFileSync(scoresFile, JSON.stringify({ proxy_score: { ...score(p), evaluation_context: "proxy" }, held_out_score: score(p) }));
    await w.client.create({ id: "rl-approval", title: "One promotion", type: "Decision", body: '```json\n{"permitted_promotions":1}\n```' });
    const options = { scores: scoresFile, approval: "rl-approval", evidence: "Validated online paired outcomes" };
    await assert.rejects(command("rl generation promote", ["rl-candidate"], options), refusal("shadow_missing"));
    for (const m of p.members) { const rowFile = join(w.root, "input.json"); writeFileSync(rowFile, JSON.stringify(input(m.id))); const result = await command("rl shadow observe", ["candidate"], { file: rowFile }); assert.equal(result.details?.active_action, "hold"); }
    assert.equal((await command("rl shadow compare", ["candidate"])).details?.candidate_failures, 0);
    assert.equal((await command("rl generation promote", ["rl-candidate"], options)).details?.budget_consumed, 1);
  } finally { process.env.PATH = oldPath; if (oldCeiling === undefined) delete process.env.GIT_CEILING_DIRECTORIES; else process.env.GIT_CEILING_DIRECTORIES = oldCeiling; }
});


test("agreement and tied outcomes preserve the incumbent and require a fresh experiment", async () => {
  const w = await workspace(deployment({ event: "hold" })); await registerShadowDeployment(w.client, w.d, w.p); await collect(w);
  for (const m of w.p.members) { const row = await observeShadow(w.client, "rl-candidate", input(m.id)); assert.equal(row.disagreement, false); }
  const report = await compareShadow(w.client, "rl-candidate"); assert.equal(report.outcome?.verdict.decision, "refuse"); assert.equal(report.disagreements, 0); assert.ok(report.remedy);
  await assert.rejects(enforceEvaluationPlan(w.client, "rl-candidate", { ...score((await readEvaluationPlan(w.client, "rl-candidate"))!.plan), value: 0 }), refusal("eval_plan_refused"));
});

test("deleting sealed manifests never restores a legacy promotion path", async () => {
  const w = await workspace(); const registration = await registerShadowDeployment(w.client, w.d, w.p); await collect(w);
  await w.client.delete(registration.id);
  await assert.rejects(compareShadow(w.client, "rl-candidate"), refusal("shadow_drift"));
});

test("original malformed manifests, missing manifests and forged observation identities refuse", async () => {
  const w = await workspace();
  for (const [name, body, expected] of [["missing", null, "shadow_missing"], ["json", "invalid-json", "shadow_drift"], ["digest", JSON.stringify(w.d), "shadow_drift"]] as const) {
    const candidate = `rl-${name}`; const p = { ...w.p, candidate, shadow: "wrong-digest" };
    const registered = await registerEvaluationPlan(w.client, p);
    if (body !== null) await w.client.create({ id: `${registered.id}-shadow`, title: "Invalid original manifest", type: "Decision", body, affectedVersion: "wrong-digest" });
    await assert.rejects(compareShadow(w.client, candidate), refusal(expected));
  }
  const registered = await registerShadowDeployment(w.client, w.d, w.p); await collect(w);
  const fake = { id: "foreign", input_digest: "foreign" };
  await w.client.create({ id: `${registered.id}-${hashJson(w.p.members[0].id)}`, type: "Decision", title: "Invalid original observation", body: JSON.stringify(fake), affectedVersion: hashJson(fake) });
  await assert.rejects(compareShadow(w.client, "rl-candidate"), refusal("shadow_drift"));
});

test("concurrent identical observations converge and conflicting outcomes cannot replace the winner", async () => {
  const w = await workspace(); await registerShadowDeployment(w.client, w.d, w.p); await collect(w);
  const identical = await Promise.all([observeShadow(w.client, "rl-candidate", input()), observeShadow(w.client, "rl-candidate", input())]);
  assert.deepEqual(identical[0], identical[1]);
  const races = await Promise.allSettled([observeShadow(w.client, "rl-candidate", input("event-1")), observeShadow(w.client, "rl-candidate", { ...input("event-1"), rewards: { hold: 1, accept: 0 } })]);
  assert.equal(races.filter((result) => result.status === "fulfilled").length, 1); assert.equal(races.filter((result) => result.status === "rejected").length, 1);
});

test("a forged original aggregate receipt cannot authorize valid individual observations", async () => {
  const w = await workspace(); const registered = await registerShadowDeployment(w.client, w.d, w.p); await collect(w);
  for (const m of w.p.members) await observeShadow(w.client, "rl-candidate", input(m.id));
  await w.client.create({ id: `${registered.id}-comparison`, title: "Unvalidated aggregate", type: "Decision", body: "{}", affectedVersion: hashJson({}) });
  await assert.rejects(enforceEvaluationPlan(w.client, "rl-candidate", score((await readEvaluationPlan(w.client, "rl-candidate"))!.plan)), refusal("shadow_drift"));
});

test("online incumbent lineage cannot bypass shadow observation through an unreserved or offline-only child", async () => {
  const w = await workspace();
  await w.client.create({ id: "rl-collection", title: "Unreserved collection", type: "Run", environment: "train-env" });
  await addGeneration(w.client, "rl-unreserved", { ...spec(w.d.candidate, "rl-seed"), training_config: {} });
  await assert.rejects(enforceEvaluationPlan(w.client, "rl-unreserved", score(w.p)), refusal("shadow_missing"));
  await addGeneration(w.client, "rl-bound", spec(w.d.candidate, "rl-seed"));
  await assert.rejects(enforceEvaluationPlan(w.client, "rl-bound", score(w.p)), refusal("shadow_missing"));
  const planned = await workspace(); const reserved = await registerEvaluationPlan(planned.client, planned.p); await collect(planned);
  await recordPlanEvaluation(planned.client, "rl-candidate", planned.p.members.map((m) => ({ id: m.id, candidate: 1, incumbent: 0 })));
  await assert.rejects(enforceEvaluationPlan(planned.client, "rl-candidate", score(reserved.plan)), refusal("shadow_missing"));
  await addGeneration(w.client, "rl-offline-seed", { ...spec(w.d.active), training_config: null });
  await addGeneration(w.client, "rl-offline-child", { ...spec(w.d.candidate, "rl-offline-seed"), training_config: [] });
  await enforceEvaluationPlan(w.client, "rl-offline-child", score(w.p));
  await enforceShadowComparison(w.client, "rl-offline-seed", null);
  await w.client.create({ id: "rl-not-generation", title: "Offline task", type: "Task" });
  await enforceShadowComparison(w.client, "rl-not-generation", null);
});
