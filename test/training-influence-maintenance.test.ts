/** Real SDK compaction recovery and category-preserving dataset admission. */
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PmClient } from "@unbrained/pm-cli/sdk/core";
import { init, isPmCliExpectedError } from "@unbrained/pm-cli/sdk/runtime";
import { createExtensionTestHarness } from "@unbrained/pm-cli/sdk/testing";
import extension, { runRlLoop, resumeRlLoop, rlLoopStatus, extractGenerationSpec, type JsonValue, type RlCommandResult } from "../index.ts";
import { parseLoopConfig } from "../loop.ts";
import { attachTrainingInfluence, measureTrainingInfluence, parseTrainingInfluence, recordTrainingInfluence, replayTrainingInfluence, verifyTrainingInfluenceProposal, type TrainingInfluenceRequest } from "../training-influence.ts";

const roots: string[] = [];
after(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });
/** Small independent partitions exercise scalar and vector schema boundaries. */
function input(): TrainingInfluenceRequest {
  return { format: "pm-rl/training-influence/1", learner: { seed: 42, initial_weight: 0, samples: 32, fit_steps: 2, learning_rate: 0.5 }, training: [{ id: "a", feature: -1, rewards: [1, 0] }, { id: "b", feature: 1, rewards: [0, 1] }, { id: "c", feature: 0.4, rewards: [1, 0] }], held_out: [{ id: "x", feature: -0.8, rewards: [1, 0] }, { id: "y", feature: 0.8, rewards: [0, 1] }], slices: [{ id: "omit", members: ["b"], weight: 0 }], evaluations: [{ id: "all", members: ["x", "y"] }], budget: { fits: 2, samples: 64, updates: 4 } };
}
/** Every fixture uses a fresh non-git tracker, without ambient scope inheritance. */
async function workspace() {
  const root = mkdtempSync(join(tmpdir(), "rl-maintenance-")); roots.push(root); process.env.GIT_CEILING_DIRECTORIES = dirname(root);
  const tracker = await init("rl", { defaults: true, agentGuidance: "skip", author: "maintenance-test" }, { cwd: root });
  const client = new PmClient({ cwd: root, pmRoot: tracker.path, author: "maintenance-test", noExtensions: true });
  const approval = await client.create({ id: "approval", type: "Decision", title: "Bounded promotions", body: '```json\n{"permitted_promotions":2}\n```', unset: ["parent", "goal", "objective", "sprint", "release", "assignee", "reviewer", "blocked_by"], clearDeps: true });
  const p = input(); const saved = await recordTrainingInfluence(client, p);
  const proposal = await attachTrainingInfluence(client, { environment: { name: "Compaction recovery", version: "1" }, training: p.training as unknown as JsonValue, evaluation: p.held_out as unknown as JsonValue, initial_weight: 0, seed: 42, max_generations: 2, samples_per_generation: 100, budget: 200, learning_rate: 0.5, minimum_improvement: 0.00001, maximum_gap: 1, evaluation_samples: 10000, confidence: 0.9, min_samples: 2 }, saved.id);
  return { root, client, pmRoot: tracker.path, coordinates: { pmRoot: tracker.path, author: "maintenance-test" }, approval: approval.item.id, saved, proposal };
}
/** Stable typed categories remain distinguishable without matching untrusted dataset text. */
function code(expected: string) { return (error: unknown): boolean => isPmCliExpectedError(error) && error.context.code === expected; }

test("dataset categories agree across every influence SDK and CLI entry point", async (context) => {
  const w = await workspace(); const p = input(); const report = measureTrainingInfluence(p);
  const malformed = { ...p, training: p.training.map((row, index) => ({ ...row, ...(index ? {} : { features: [1] }) })) };
  const overlap = { ...p, training: [...p.training, p.held_out[0]] };
  let seed = 0x31415926;
  for (let i = 0; i < 500; i += 1) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const dimensions = 1 + seed % 64;
    const vector = { ...p, training: p.training.map((row) => ({ ...row, features: Array.from({ length: dimensions }, () => row.feature) })), held_out: p.held_out.map((row) => ({ ...row, features: Array.from({ length: dimensions }, () => row.feature) })) };
    assert.deepEqual(parseTrainingInfluence(vector), JSON.parse(JSON.stringify(vector)));
    const bad = seed % 2 ? { ...vector, training: [...vector.training, vector.held_out[0]] } : { ...vector, held_out: vector.held_out.map((row, index) => index ? row : { ...row, features: [...row.features, 0] }) };
    const expected = seed % 2 ? "influence_overlap" : "influence_invalid";
    for (const parse of [parseTrainingInfluence, measureTrainingInfluence]) assert.throws(() => parse(bad), code(expected));
    assert.throws(() => replayTrainingInfluence(bad, report), code(expected));
  }
  const harness = await createExtensionTestHarness(extension, { name: "pm-rl", capabilities: ["commands", "hooks", "schema"] });
  for (const [value, expected] of [[malformed, "influence_invalid"], [overlap, "influence_overlap"]] as const) {
    const before = await w.client.get(w.saved.id, { full: true });
    await assert.rejects(recordTrainingInfluence(w.client, value), code(expected));
    const proposal = { ...w.proposal as Record<string, JsonValue>, training: value.training as unknown as JsonValue };
    await assert.rejects(verifyTrainingInfluenceProposal(w.client, proposal), code(expected));
    const file = join(w.root, `${expected}.json`); writeFileSync(file, JSON.stringify(value));
    const next = join(w.root, `${expected}-proposal.json`); writeFileSync(next, JSON.stringify(proposal));
    for (const json of [false, true]) {
      await assert.rejects(harness.runCommand({ command: "rl influence run", pmRoot: w.pmRoot, options: { file }, global: { json } }), code(expected));
      await assert.rejects(harness.runCommand({ command: "rl influence propose", pmRoot: w.pmRoot, args: [w.saved.id], options: { file: next, output: join(w.root, "never-written.json") }, global: { json } }), code(expected));
    }
    assert.deepEqual(await w.client.get(w.saved.id, { full: true }), before);
  }
  context.diagnostic("500 seeded shape/category cases plus real SDK and both CLI output modes");
});

test("sealed loop evidence survives pruned report history through run resume and status", async () => {
  const w = await workspace(); const request = { id: "maintenance", config: w.proposal, approval: w.approval };
  const control = await workspace();
  const expected = await runRlLoop(control.client, control.coordinates, { id: request.id, config: control.proposal, approval: control.approval });
  await assert.rejects(runRlLoop(w.client, w.coordinates, { ...request, onPhase(phase) { if (phase === "train") throw new Error("pause before fit"); } }), /pause before fit/);
  const original = (await w.client.get("maintenance-seed", { full: true })).item;
  const specification = extractGenerationSpec(String(original.body), "Fixture seed");
  for (let i = 0; i < 5; i += 1) await w.client.update(w.saved.id, { title: `Annotation ${i}` });
  assert.equal((await w.client.historyCompact(w.saved.id, { before: "5" })).changed, true);
  await assert.rejects(verifyTrainingInfluenceProposal(w.client, w.proposal), code("history_version_pruned"));
  await assert.rejects(runRlLoop(w.client, w.coordinates, { ...request, id: "new-proposal" }), code("history_version_pruned"));
  for (const field of ["programme", "configuration", "native-hash"] as const) {
    const training = { ...specification.training_config as Record<string, JsonValue> };
    if (field === "programme") training.programme = "different";
    if (field === "configuration") training.configuration = { ...training.configuration as Record<string, JsonValue>, seed: 43 };
    await w.client.update(original.id, { body: String(original.body).replace(/```json\n[\s\S]*?\n```/, "```json\n" + JSON.stringify({ ...specification, training_config: training }) + "\n```"), affectedVersion: field === "native-hash" ? "different" : original.affected_version });
    await assert.rejects(resumeRlLoop(w.client, w.coordinates, { id: request.id, approval: w.approval }), code("loop_seed_drift"));
    await assert.rejects(rlLoopStatus(w.client, request.id, w.pmRoot), code("loop_seed_drift"));
    await assert.rejects(runRlLoop(w.client, w.coordinates, request), code("loop_seed_drift"));
    await w.client.update(original.id, { body: String(original.body), affectedVersion: original.affected_version });
  }
  await assert.rejects(runRlLoop(w.client, w.coordinates, { ...request, config: { ...w.proposal as Record<string, JsonValue>, seed: 43 } }), code("loop_seed_drift"));
  const resumed = await resumeRlLoop(w.client, w.coordinates, { id: request.id, approval: w.approval });
  assert.ok(resumed.generations.length); assert.equal(resumed.samples_consumed, expected.samples_consumed);
  assert.equal(resumed.final_checkpoint, expected.final_checkpoint); assert.equal(resumed.promoted, expected.promoted);
  const repeated = await runRlLoop(w.client, w.coordinates, request);
  assert.equal(repeated.final_checkpoint, resumed.final_checkpoint); assert.equal(repeated.samples_consumed, resumed.samples_consumed);
  const harness = await createExtensionTestHarness(extension, { name: "pm-rl", capabilities: ["commands", "hooks", "schema"] });
  for (const json of [false, true]) {
    const result = (await harness.runCommand({ command: "rl loop resume", pmRoot: w.pmRoot, args: [request.id], options: { approval: w.approval }, global: { json } })).result as RlCommandResult;
    assert.equal(result.details?.final_checkpoint, resumed.final_checkpoint);
  }
  const final = extractGenerationSpec(String((await w.client.get(original.id)).item.body), "Final seed");
  assert.deepEqual((final.training_config as Record<string, JsonValue>).configuration, (specification.training_config as Record<string, JsonValue>).configuration);
  assert.equal(parseLoopConfig(w.proposal).digest, (specification.training_config as Record<string, JsonValue>).programme);
  // A seal for influence evidence does not replace unrelated required policy-card history.
  assert.equal((await w.client.historyCompact(original.id, { before: "5" })).changed, true);
  await assert.rejects(resumeRlLoop(w.client, w.coordinates, { id: request.id, approval: w.approval }), code("loop_generation_drift"));
});
