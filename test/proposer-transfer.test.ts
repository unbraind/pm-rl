/** Native SDK trackers exercise power, leakage and digest refusals without a simulated host. */
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { createExtensionTestHarness } from "@unbrained/pm-cli/sdk/testing";
import extension, { hashJson, type JsonValue, type RlCommandResult } from "../index.ts";
import { IMPROVER_ROLES, type ImproverTask } from "../improver-data.ts";
import { archiveTransferCorpus, evaluateTransfer, loadTransferCorpus, recordTransferEvaluation, replayTransferCorpus, replayTransferEvaluation, transferMembers, transferPower, verifyTransferCorpus, TRANSFER_DESIGN, type TransferCorpus } from "../proposer-transfer.ts";
import { proposerEvolutionConfiguration, runProposerEvolution, requireProposerTransfer, proposerEvaluationPlan } from "../proposer-evolution.ts";
import { initialProposer } from "../proposer-program.ts";
import { evaluatePlan } from "../evaluation-plan.ts";
import { processWorkspace } from "./fixtures/process-workspace.ts";

/** Eight real-format chronological rows carry no raw text, authors or machine coordinates. */
function task(role: string, index: number, target: ImproverTask["target"]): ImproverTask {
  const rows = Array.from({ length: 8 }, (_, n) => ({ id: `${role}-${index}-${n}`, prediction_at: n, available_at: n, label: n % 2 as 0 | 1, prefix: { events: ["create"], fields: [], words: [n % 2], authors: 1, elapsed_ms: 0 } }));
  return { id: `${role}-${index}-${target}`, repo: `public-fixture/${role}-${index}`, commit: "a".repeat(40), target, cutoff: 4, threshold_ms: target === "issue-type" ? null : 10, train: rows.slice(0, 4), evaluation: rows.slice(4) };
}
/** Use the released dataset envelope so old persisted input remains a supported positive control. */
function corpus(count = 1): TransferCorpus {
  const tasks = Object.fromEntries(IMPROVER_ROLES.map((role) => [role, Array.from({ length: count }, (_, index) => TRANSFER_DESIGN.targets.map((target) => task(role, index, target))).flat()])) as unknown as TransferCorpus["tasks"];
  const record = { format: "pm-rl/improver-dataset/1" as const, seed: 42, sources: IMPROVER_ROLES.flatMap((role) => Array.from({ length: count }, (_, index) => ({ repo: `public-fixture/${role}-${index}`, commit: "a".repeat(40), role }))), splits: Object.fromEntries(IMPROVER_ROLES.map((role) => [role, { tasks: tasks[role].length, digest: hashJson(tasks[role] as unknown as JsonValue) }])) as TransferCorpus["manifest"]["splits"], omitted: [] };
  return { tasks, manifest: { ...record, digest: hashJson(record as unknown as JsonValue) } };
}
/** Rehash deliberate invalid fixtures so structural protection, rather than a stale outer hash, must detect them. */
function seal(value: TransferCorpus): TransferCorpus {
  const { digest: _, ...old } = value.manifest;
  const record = { ...old, splits: Object.fromEntries(IMPROVER_ROLES.map((role) => [role, { tasks: value.tasks[role].length, digest: hashJson(value.tasks[role] as unknown as JsonValue) }])) as TransferCorpus["manifest"]["splits"] };
  return { ...value, manifest: { ...record, digest: hashJson(record as unknown as JsonValue) } };
}
/** Persist only synthetic projected input files needed to enter the existing full controller path. */
function dataset(root: string, value: TransferCorpus): string {
  const directory = join(root, "dataset"); mkdirSync(directory);
  for (const role of IMPROVER_ROLES) writeFileSync(join(directory, `${role}.json`), JSON.stringify(value.tasks[role]));
  writeFileSync(join(directory, "improver-dataset.json"), JSON.stringify(value.manifest)); return directory;
}

test("underpowered real non-git controller refuses transfer and replays native evidence without dataset files", { timeout: 300_000 }, async () => {
  const w = await processWorkspace({ training_steps: 1000, wall_ms: 100_000_000, compute_units: 100_000_000, storage_bytes: 100_000_000, tokens: 0 });
  await w.client.update(w.approval, { body: '```json\n'+JSON.stringify({ permitted_promotions: 100, meta_budget: { training_samples: 100000, proposal_calls: 100, recipe_promotions: 100 }, resource_budget: { training_steps: 1000, wall_ms: 100_000_000, compute_units: 100_000_000, storage_bytes: 100_000_000, tokens: 0 } })+'\n```' });
  const value = corpus(); const directory = dataset(w.root, value);
  assert.deepEqual(loadTransferCorpus(directory), value);
  const request = { id: "power", approval: w.approval, dataset: directory, config: { ...proposerEvolutionConfiguration(), generations: 1, candidates: 1, updates: 1 } };
  const nativeCorpus = await archiveTransferCorpus(w.client, value);
  const underpowered = await recordTransferEvaluation(w.client, nativeCorpus, "meta", value.tasks.meta.map(({ id }) => ({ id, candidate: 1, incumbent: 0 })), 2);
  const control = evaluatePlan(proposerEvaluationPlan("control", initialProposer(), Array.from({ length: 256 }, (_, n) => ({ id: String(n), repo: String(n), target: "test" })), "ctx", 2), Array.from({ length: 256 }, (_, n) => ({ id: String(n), candidate: 1, incumbent: 0 })));
  assert.equal(control.verdict.decision, "promote");
  assert.equal(requireProposerTransfer(control, underpowered.report).verdict.decision, "refuse");
  const report = await runProposerEvolution(w.client, w.coordinates, request);
  assert.equal(report.generations.length, 1); assert.equal(report.generations[0].promoted, false);
  assert.equal(report.generations[0].comparison.verdict.decision, "refuse");
  assert.equal(report.generations[0].transfer?.report.reason, "transfer_underpowered");
  assert.equal(report.audit.verdict.decision, "refuse");
  assert.ok(report.transfer); assert.equal(report.transfer.report.tasks[0].power_lower_bound, 0);
  rmSync(directory, { recursive: true });
  assert.deepEqual(await replayTransferEvaluation(w.client, report.transfer.digest), report.transfer.report);
  const harness = await createExtensionTestHarness(extension, { name: "pm-rl", capabilities: ["commands", "hooks", "schema"] });
  const cli = await harness.runCommand({ pmRoot: w.pmRoot, command: "rl proposer transfer replay", args: [report.transfer.digest], global: { json: true } }).then((r) => r.result) as RlCommandResult;
  assert.deepEqual(cli.details, report.transfer.report);
  const before = readFileSync(join(w.pmRoot, "history", `rl-transfer-${report.transfer.digest}.jsonl`), "utf8");
  assert.ok(before.includes('"op":"create"'));
});

test("training tracker in held-out set is refused before native writes, including canonical aliases", async () => {
  const w = await processWorkspace(); const valid = corpus();
  await archiveTransferCorpus(w.client, valid);
  const before = (await w.client.listAllComplete({ includeBody: true })).items;
  for (const repo of [valid.manifest.sources[0].repo, `  ${valid.manifest.sources[0].repo.toUpperCase()}  `]) {
    const invalid = seal({ ...valid, manifest: { ...valid.manifest, sources: valid.manifest.sources.map((source) => source.role === "meta" ? { ...source, repo } : source) } });
    await assert.rejects(archiveTransferCorpus(w.client, invalid), /transfer_tracker_leak/);
  }
  assert.deepEqual((await w.client.listAllComplete({ includeBody: true })).items, before);
});

test("split digest mismatch on native replay is refused while the original released snapshot is allowed", async () => {
  const w = await processWorkspace(); const value = corpus(); const digest = await archiveTransferCorpus(w.client, value);
  assert.equal(await archiveTransferCorpus(w.client, value), digest); assert.deepEqual(await replayTransferCorpus(w.client, digest), value);
  const invalid = { ...value, tasks: { ...value.tasks, meta: value.tasks.meta.map((row) => ({ ...row, cutoff: 5 })) } };
  const stored = (await w.client.get(`transfer-${digest}`)).item;
  const body = JSON.parse(String(stored.body)) as { tasks: { digest: string }[] };
  const packet = (await w.client.get(`transfer-${body.tasks[2].digest}`)).item;
  const modifiedPacket = { ...JSON.parse(String(packet.body)) as Record<string, unknown>, task: invalid.tasks.meta[0] };
  const packetDigest = hashJson(modifiedPacket as unknown as JsonValue);
  await w.client.create({ id: `transfer-${packetDigest}`, type: "Decision", title: "Synthetic split drift", body: JSON.stringify(modifiedPacket), affectedVersion: packetDigest, component: "proposer-transfer" });
  const forged = { ...JSON.parse(String(stored.body)) as Record<string, unknown>, tasks: body.tasks.map((reference, index) => index === 2 ? { ...reference, digest: packetDigest } : reference) };
  const forgedDigest = hashJson(forged as JsonValue);
  await w.client.create({ id: `transfer-${forgedDigest}`, type: "Decision", title: "Synthetic mismatched split", body: JSON.stringify(forged), affectedVersion: forgedDigest, component: "proposer-transfer" });
  await assert.rejects(replayTransferCorpus(w.client, forgedDigest), /improver_split_identity|transfer_split_digest/);
  await assert.rejects(archiveTransferCorpus(w.client, invalid), /improver_split_identity|transfer_split_digest/);
  await w.client.update(packet.id, { body: String(packet.body).replace('"cutoff":4', '"cutoff":5') });
  await assert.rejects(replayTransferCorpus(w.client, digest), /transfer_record_drift/);
});

test("power bound, paired intervals and corrected decisions match independent analytic checks", async () => {
  const w = await processWorkspace(); const value = corpus(); const digest = await archiveTransferCorpus(w.client, value);
  const result = await recordTransferEvaluation(w.client, digest, "meta", value.tasks.meta.map(({ id }) => ({ id, candidate: 1, incumbent: 0 })), 2);
  assert.equal(result.report.passed, false); assert.equal(result.report.tasks[0].effect, 1);
  assert.equal(result.report.tasks[0].minimum_trackers, 3062);
  const n = result.report.tasks[0].minimum_trackers;
  assert.equal(transferPower(n, 2).powered, true); assert.ok(transferPower(n, 2).power_lower_bound >= 0.8);
  assert.ok(transferPower(n - 1, 2).power_lower_bound < 0.8);
  assert.ok(transferPower(n, 3).minimum_trackers > n);
  assert.deepEqual(transferPower(0, 2), { ...transferPower(0, 2), power_lower_bound: 0, radius: 2 });
  assert.deepEqual(await replayTransferEvaluation(w.client, result.digest), result.report);
  const comparison = evaluatePlan(proposerEvaluationPlan("pass", initialProposer(), Array.from({ length: 256 }, (_, index) => ({ id: String(index), repo: String(index), target: "test" })), "ctx", 2), Array.from({ length: 256 }, (_, index) => ({ id: String(index), candidate: 1, incumbent: 0 })));
  assert.equal(comparison.verdict.decision, "promote");
  assert.equal(requireProposerTransfer(comparison, result.report).verdict.decision, "refuse");
  assert.deepEqual(requireProposerTransfer(comparison, { ...result.report, passed: true }), comparison);
});

test("meta tracker shards are fresh for adaptive generations and missing targets remain underpowered", () => {
  const value = corpus(3);
  const first = transferMembers(value, "meta", 3, 1); const second = transferMembers(value, "meta", 3, 2);
  assert.ok(first.length > 0 && second.length > 0);
  assert.equal(first.some((task) => second.some((other) => other.repo === task.repo)), false);
  assert.equal(first.length + second.length, value.tasks.meta.length);
  assert.deepEqual(transferMembers(value, "audit", 3), value.tasks.audit);
  assert.equal(evaluateTransfer(value, "meta", first.map(({ id }) => ({ id, candidate: 0, incumbent: 1 })), 3).tasks[0].effect, -1);
  const missing = seal({ ...value, tasks: { ...value.tasks, meta: value.tasks.meta.filter((task) => task.target === "issue-type") } });
  const report = evaluateTransfer(missing, "meta", missing.tasks.meta.map(({ id }) => ({ id, candidate: 0.5, incumbent: 0.5 })), 1);
  assert.equal(report.tasks[1].trackers, 0); assert.deepEqual(report.tasks[1].interval, [-1, 1]); assert.equal(report.passed, false);
  for (const [n, comparisons] of [[-1, 2], [1.1, 2], [NaN, 2], [1, 0], [1, 6]]) assert.throws(() => transferPower(n, comparisons), /transfer_counts/);
  for (const look of [0, 4, NaN]) assert.throws(() => transferMembers(value, "meta", 3, look), /transfer_look/);
});

test("invalid corpus seals, private sources and malformed paired evidence refuse", async () => {
  const w = await processWorkspace(); const valid = corpus();
  assert.throws(() => verifyTransferCorpus(valid, "0".repeat(64)), /transfer_corpus_digest/);
  assert.throws(() => verifyTransferCorpus({ ...valid, manifest: { ...valid.manifest, seed: 1 } }), /transfer_corpus_digest/);
  for (const name of ["pm-observer", "pm-web-hosted", "pm-web", "pm-gpt", "pm-cli"]) {
    const invalid = seal({ ...valid, manifest: { ...valid.manifest, sources: valid.manifest.sources.map((source, index) => index === 0 ? { ...source, repo: `public-fixture/${name}` } : source) } });
    await assert.rejects(archiveTransferCorpus(w.client, invalid), /transfer_private_source/);
  }
  const pairs = valid.tasks.meta.map(({ id }) => ({ id, candidate: 0.5, incumbent: 0.5 }));
  for (const invalid of [[], [pairs[0], pairs[0]], [{ ...pairs[0], id: "foreign" }, pairs[1]], [{ ...pairs[0], candidate: NaN }, pairs[1]], [{ ...pairs[0], incumbent: -1 }, pairs[1]]]) assert.throws(() => evaluateTransfer(valid, "meta", invalid, 2), /transfer_pairs|transfer_score/);
  await assert.rejects(replayTransferCorpus(w.client, "bad"), /transfer_digest/);
});

 test("a powered synthetic paired control passes while a powered null still refuses", () => {
  const value = corpus(transferPower(0, 2).minimum_trackers);
  const improvement = evaluateTransfer(value, "meta", value.tasks.meta.map(({ id }) => ({ id, candidate: 1, incumbent: 0 })), 2);
  assert.equal(improvement.passed, true); assert.equal(improvement.reason, "transfer_passed");
  const nullEffect = evaluateTransfer(value, "meta", value.tasks.meta.map(({ id }) => ({ id, candidate: 0.5, incumbent: 0.5 })), 2);
  assert.equal(nullEffect.passed, false); assert.equal(nullEffect.reason, "transfer_no_improvement");
});

 test("native record IO failures propagate without overwriting unavailable evidence", async () => {
  const w = await processWorkspace(); const value = corpus(); const digest = await archiveTransferCorpus(w.client, value);
  const record = JSON.parse(String((await w.client.get(`transfer-${digest}`)).item.body)) as { tasks: { digest: string }[] };
  const id = (await w.client.get(`transfer-${record.tasks[0].digest}`)).item.id;
  const file = join(w.pmRoot, "decisions", `${id}.toon`); const original = readFileSync(file);
  try {
    writeFileSync(file, "not a valid tracker item");
    await assert.rejects(archiveTransferCorpus(w.client, value));
  } finally { writeFileSync(file, original); }
  assert.deepEqual(await replayTransferCorpus(w.client, digest), value);
});
