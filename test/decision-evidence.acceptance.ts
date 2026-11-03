import { decode } from "@toon-format/toon";
import { printResult } from "@unbrained/pm-cli/sdk";
import { identityPath } from "./fixtures/identity-path.ts";
/** Packed SDK plus installed CLI provenance proof; copy static imports to the packed consumer before execution. */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { writeFileSync, mkdirSync, symlinkSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { devNull } from "node:os";
import { isPmCliExpectedError } from "@unbrained/pm-cli/sdk/runtime";
import { readEvaluationDecision, verifyDecisionEvidence, parseEvaluationEvidence, readCompleteLoopItem, withRlController, extractGenerationSpec, hashJson, type JsonValue, type RlCommandResult } from "../index.ts";
import { replayPolicyCard, type PolicyCard } from "../policy-card.ts";
import { decisionFixture } from "./fixtures/decision-evidence.ts";

const archive = resolve(process.argv[2]); const output = resolve(process.argv[3]);
const w = await decisionFixture(false, false);
const cli = resolve("node_modules/@unbrained/pm-cli/dist/cli.js");
const env: NodeJS.ProcessEnv = { ...process.env, PM_AUTHOR: "decision-test", PM_PATH: w.pmRoot, GIT_CEILING_DIRECTORIES: dirname(w.root), NPM_CONFIG_USERCONFIG: devNull, NODE_V8_COVERAGE: undefined };
env.PATH = identityPath(w.root);
execFileSync(process.execPath, [cli, "package", "install", archive, "--project", "--json"], { cwd: w.root, env, stdio: "pipe" });
/** Compare complete host representations using its public formatter, which intentionally omits empty TOON fields. */
function toonProjection(value: unknown): unknown {
  const chunks: string[] = []; const write = process.stdout.write;
  process.stdout.write = (chunk: string | Uint8Array): boolean => { chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8")); return true; };
  try { printResult(value, { outputFormat: "toon" }); } finally { process.stdout.write = write; }
  return decode(chunks.join(""));
}
/** Run the actual installed archive in a tracker with no Git executable. */
function command(args: string[]): string { return execFileSync(process.execPath, [cli, "rl", ...args], { cwd: w.root, env, encoding: "utf8" }); }
const scores = join(w.root, "scores.json"); writeFileSync(scores, JSON.stringify({ proxy_score: { ...w.score, evaluation_context: "proxy" }, held_out_score: w.score }));
const promoted = JSON.parse(command(["generation", "promote", w.plan.candidate, "--approval", "rl-approval", "--scores", scores, "--evidence", "Packed decision graph", "--json"])) as RlCommandResult;
assert.equal(promoted.details?.budget_consumed, 1);
const decision = await readEvaluationDecision(w.client, w.plan.candidate);
assert.equal(promoted.details?.decision_evidence, decision.evidence?.digest);
const aliased = { format: decision.evidence!.format, comparison: decision.evidence!.comparison, inputs: decision.evidence!.inputs.map((input) => input.id === w.plan.candidate ? { ...input, id: "candidate" } : input) };
await assert.rejects(verifyDecisionEvidence(w.client, parseEvaluationEvidence({ ...aliased, digest: hashJson(aliased as unknown as JsonValue) })), (error: unknown) => isPmCliExpectedError(error) && error.context.item_id === "candidate");
const resumed = JSON.parse(command(["eval", "plan", "resume", w.plan.candidate, "--json"])) as RlCommandResult;
assert.equal(resumed.details?.evidence_digest, decision.evidence?.digest);
await withRlController(w.client, { pmRoot: w.pmRoot, author: "decision-test" }, { id: "graph", approval: "rl-approval", recoveryCommand: "pm rl meta resume graph" }, new AbortController().signal,
  (step) => step("decision", { candidate: w.plan.candidate }, async () => { await readEvaluationDecision(w.client, w.plan.candidate); return { promoted: true, configs: [{ samples: 1 }, { samples: 2 }] }; }));
let cardBytes = 0; let cardTypes = 0; let outputPairs = 0;
const cards: { file: string; value: PolicyCard }[] = [];
for (const [subject, selection] of [[w.plan.candidate, null], ["rl-graph-step-decision", null], ["rl-graph-step-decision", 0], ["rl-graph-step-decision", 1]] as const) {
  const options = selection === null ? [] : ["--selection", String(selection)];
  const exported = JSON.parse(command(["policy-card", "export", subject, ...options, "--json"])) as { details: PolicyCard };
  const value = exported.details;
  assert.deepEqual(decode(command(["policy-card", "export", subject, ...options])), toonProjection(exported)); outputPairs += 1;
  const { digest: _cardDigest, decision_evidence: _graph, ...remaining } = value;
  await assert.rejects(replayPolicyCard(w.client, { ...remaining, digest: hashJson(remaining as unknown as JsonValue) }), (error: unknown) => isPmCliExpectedError(error) && error.context.item_id === subject);
  assert.ok(value.decision_evidence);
  const file = join(w.root, `card-${cardTypes++}.json`); writeFileSync(file, JSON.stringify(value));
  const replayed = JSON.parse(command(["policy-card", "replay", "--file", file, "--json"])) as RlCommandResult;
  assert.equal(replayed.details?.digest, value.digest);
  assert.deepEqual(decode(command(["policy-card", "replay", "--file", file])), toonProjection(replayed)); outputPairs += 1;
  cardBytes = Math.max(cardBytes, Buffer.byteLength(JSON.stringify(value))); cards.push({ file, value });
}
assert.deepEqual(cards[0].value.decision_evidence, decision.evidence);
const stepId = "rl-graph-step-decision";
const stepReceipt = await readCompleteLoopItem(w.client, stepId);
const stepBody = JSON.parse(String(stepReceipt.item.body)) as Record<string, JsonValue>;
await w.client.update(stepId, { body: JSON.stringify({ ...stepBody, state: "running", decision_evidence: undefined, result: undefined, digest: undefined }) });
await assert.rejects(withRlController(w.client, { pmRoot: w.pmRoot, author: "decision-test" }, { id: "graph", approval: "rl-approval", recoveryCommand: "pm rl meta resume graph" }, new AbortController().signal,
  (step) => step("decision", { candidate: w.plan.candidate }, async () => assert.fail("A completed receipt cannot be downgraded"))), (error: unknown) => isPmCliExpectedError(error) && error.context.item_id === stepId);
await w.client.update(stepId, { body: String(stepReceipt.item.body) });
const original = await readCompleteLoopItem(w.client, w.plan.candidate);
assert.deepEqual(extractGenerationSpec(String(original.item.body), "Packed receipt").evaluation_evidence, decision.evidence);
await w.client.update("rl-review", { body: "corrupt review" });
await w.client.update("rl-candidate-evaluation-plan-look-2", { affectedVersion: "corrupt final look" });
let frozenReplays = 0;
for (const { file, value } of cards.slice(1)) {
  const selection = value.selection === null ? [] : ["--selection", String(value.selection)];
  for (const args of [["policy-card", "export", value.subject, ...selection], ["policy-card", "replay", "--file", file]]) {
    const json = command([...args, "--json"]); const toon = command(args);
    assert.match(json, new RegExp(value.digest)); assert.match(toon, new RegExp(value.digest));
    assert.deepEqual(decode(toon), toonProjection(JSON.parse(json))); outputPairs += 1; frozenReplays += 2;
  }
}
const frozenGraph = parseEvaluationEvidence(stepBody.decision_evidence);
const damaged = { format: frozenGraph.format, comparison: frozenGraph.comparison, inputs: frozenGraph.inputs.map((ref, index) => index === 0 ? { ...ref, digest: "0".repeat(64) } : ref) };
await w.client.update(stepId, { body: JSON.stringify({ ...stepBody, decision_evidence: { ...damaged, digest: hashJson(damaged as unknown as JsonValue) } }) });
let snapshotRefusals = 0;
try {
  for (const json of [true, false]) for (const args of [["policy-card", "export", stepId], ["policy-card", "replay", "--file", cards[1].file]]) {
    const result = spawnSync(process.execPath, [cli, "rl", ...args, ...(json ? ["--json"] : [])], { cwd: w.root, env, encoding: "utf8" });
    assert.equal(result.status, 4, result.stdout + result.stderr);
    assert.match(result.stdout + result.stderr, new RegExp(`${frozenGraph.inputs[0].id}@${frozenGraph.inputs[0].at}`)); snapshotRefusals += 1;
  }
} finally { await w.client.update(stepId, { body: String(stepReceipt.item.body) }); }
let refusals = 0;
for (const json of [true, false]) for (const args of [
  ["policy-card", "export", w.plan.candidate], ["policy-card", "replay", "--file", cards[0].file],
  ["eval", "plan", "resume", w.plan.candidate],
  ["generation", "promote", w.plan.candidate, "--approval", "rl-approval", "--scores", scores, "--evidence", "Packed decision graph"],
]) {
  const result = spawnSync(process.execPath, [cli, "rl", ...args, ...(json ? ["--json"] : [])], { cwd: w.root, env, encoding: "utf8" });
  assert.equal(result.status, 4, result.stdout + result.stderr);
  assert.match(result.stdout + result.stderr, /card_drift|eval_plan_/); assert.match(result.stdout + result.stderr, /rl-review|rl-candidate-evaluation-plan-look-2/);
  refusals += 1;
}
assert.deepEqual(await readCompleteLoopItem(w.client, w.plan.candidate), original);
const evidence = { packed_sdk: true, installed_cli: true, card_types: cardTypes, graph_inputs: decision.evidence!.inputs.length, max_card_json_bytes: cardBytes, frozen_live_source_replays: frozenReplays, snapshot_corruption_refusals: snapshotRefusals, review_and_final_look_refusals: refusals, rehashed_graph_removal_refusals: cards.length, canonical_graph_ids: true, completed_step_downgrade_refusals: 1, json_and_toon: true, json_and_toon_comparison: "sdk-default-toon-projection", json_and_toon_envelope_pairs: outputPairs, promotion_receipt_graph: true, exact_sdk_graph_in_card: true, approval_consumed: 1, source_generation_unchanged_on_refusal: true, non_git: true, git_absent_from_path: true };
writeFileSync(output, JSON.stringify(evidence, null, 2) + "\n"); console.log(JSON.stringify(evidence));
