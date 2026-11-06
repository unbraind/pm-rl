/** Minimum powered populations and malicious shard arrangements use the real SDK in non-Git trackers. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { PmClient } from "@unbrained/pm-cli/sdk/core";
import { hashJson, type JsonValue } from "../json-identity.ts";
import { archiveTransferCorpus, replayTransferCorpus, planTransferArchive, parseTransferDesign, transferPower, recordTransferPlan, readTransferPlan, recordTransferEvaluation, replayTransferEvaluation, TRANSFER_DESIGN, type TransferDesign } from "../proposer-transfer.ts";
import { proposerEvolutionConfiguration, parseProposerEvolutionConfig, runProposerEvolution } from "../proposer-evolution.ts";
import { MAX_TRACKER_RECORD_BYTES } from "../tracker-record.ts";
import { transferCorpus, sealTransferCorpus } from "./fixtures/transfer-corpus.ts";
import { processWorkspace } from "./fixtures/process-workspace.ts";

/** Explicit historical parameters make the original capacity failure reproducible without fitting real trackers. */
const design: TransferDesign = { ...TRANSFER_DESIGN, looks: 2 };
/** Publish deliberately malformed envelopes through native creation rather than mocking a read. */
async function native(client: PmClient, value: unknown): Promise<string> {
  const digest = hashJson(value as JsonValue);
  await client.create({ id: `transfer-${digest}`, type: "Decision", title: "Synthetic transfer boundary", body: JSON.stringify(value), affectedVersion: digest, component: "proposer-transfer" }); return digest;
}

test("minimum powered corpus archives and replays through bounded native shards", { timeout: 600_000 }, async () => {
  const n = transferPower(0, design).minimum_trackers;
  assert.equal(n, 3062);
  const value = transferCorpus({ development: 1, meta: n, audit: n });
  assert.equal(value.tasks.meta.length + value.tasks.audit.length, 12248);
  const plan = planTransferArchive(value);
  const sizes = [...plan.shards, plan.root].map((record) => Buffer.byteLength(JSON.stringify(record)));
  assert.ok(sizes.every((size) => size <= MAX_TRACKER_RECORD_BYTES));
  assert.ok(Buffer.byteLength(JSON.stringify(plan.root)) < 16_384);
  const w = await processWorkspace();
  const declaration = await recordTransferPlan(w.client, value.manifest.digest, design);
  const digest = await archiveTransferCorpus(w.client, value);
  const replay = await replayTransferCorpus(w.client, digest); assert.deepEqual(replay, value);
  const result = await recordTransferEvaluation(w.client, digest, "meta", value.tasks.meta.map(({ id }) => ({ id, candidate: 1, incumbent: 0 })), declaration);
  assert.equal(result.report.passed, true);
  assert.deepEqual(await replayTransferEvaluation(w.client, result.digest), result.report);
  console.log(JSON.stringify({ minimum_trackers: n, references: 12248, shards: plan.shards.length, root_bytes: sizes.at(-1), maximum_record_bytes: Math.max(...sizes), powered_native_replay: true }));
});

test("native replay refuses missing extra reordered duplicated and altered shards", async () => {
  const w = await processWorkspace(); const value = transferCorpus(); const plan = planTransferArchive(value);
  const digest = await archiveTransferCorpus(w.client, value); assert.deepEqual(await replayTransferCorpus(w.client, digest), value);
  for (const shards of [plan.root.shards.slice(0, -1), [...plan.root.shards, plan.root.shards[0]], [...plan.root.shards.slice(0, -2), ...plan.root.shards.slice(-2).reverse()], ["0".repeat(64), ...plan.root.shards.slice(1)]]) {
    const forged = await native(w.client, { ...plan.root, shards });
    await assert.rejects(replayTransferCorpus(w.client, forged));
  }
  const oversized = await native(w.client, { ...plan.shards[0], padding: "x".repeat(MAX_TRACKER_RECORD_BYTES) });
  await assert.rejects(replayTransferCorpus(w.client, await native(w.client, { ...plan.root, shards: [oversized, ...plan.root.shards.slice(1)] })), /json_record_limit/);
  const altered = await native(w.client, { ...plan.shards[0], entries: [] });
  await assert.rejects(replayTransferCorpus(w.client, await native(w.client, { ...plan.root, shards: [altered, ...plan.root.shards.slice(1)] })), /transfer_shard_empty/);
  const changed = await native(w.client, { ...plan.shards[1], entries: plan.shards[1].entries.map((entry) => entry.kind === "task" ? { ...entry, task: { ...entry.task, cutoff: 5 } } : entry) });
  await assert.rejects(replayTransferCorpus(w.client, await native(w.client, { ...plan.root, shards: [plan.root.shards[0], changed, ...plan.root.shards.slice(2)] })), /improver_split_identity/);
  await assert.rejects(replayTransferCorpus(w.client, await native(w.client, { ...plan.root, entry_count: plan.root.entry_count + 1 })), /transfer_shard_count/);
});

test("shard preflight rejects oversized entries before native mutation and allows omission records", async () => {
  const w = await processWorkspace(); const original = transferCorpus();
  const allowed = sealTransferCorpus({ ...original, manifest: { ...original.manifest, omitted: [{ repo: "public-fixture/omitted", target: "issue-type" }] } });
  assert.deepEqual(await replayTransferCorpus(w.client, await archiveTransferCorpus(w.client, allowed)), allowed);
  const base = original.tasks.development[0];
  const rows = Array.from({ length: 10000 }, (_, index) => ({ ...base.train[index % 4], id: `oversized-${index}`, label: index % 2 as 0 | 1, prediction_at: index, available_at: index, prefix: { ...base.train[0].prefix, words: new Array<number>(100).fill(999999) } }));
  const tooBig = sealTransferCorpus({ ...original, tasks: { ...original.tasks, development: [{ ...base, cutoff: 5000, train: rows.slice(0, 5000), evaluation: rows.slice(5000) }, original.tasks.development[1]] } });
  const before = (await w.client.listAllComplete({ includeBody: true })).items;
  await assert.rejects(archiveTransferCorpus(w.client, tooBig), /json_record_limit/);
  assert.deepEqual((await w.client.listAllComplete({ includeBody: true })).items, before);
});

test("explicit prospective designs control power and native evaluations retain the sealed plan", async () => {
  for (const patch of [{ effect: 0.01 }, { alpha: 0 }, { alpha: 1 }, { power: NaN }, { power: 1 }, { looks: 0 }, { looks: 65 }, { margin: 0 }, { extra: true }]) assert.throws(() => parseTransferDesign({ ...design, ...patch }), /transfer_design/);
  for (const invalid of [null, [], "design"]) assert.throws(() => parseTransferDesign(invalid), /transfer_design/);
  assert.ok(transferPower(0, { ...design, effect: 0.5 }).minimum_trackers < transferPower(0, design).minimum_trackers);
  assert.ok(transferPower(0, { ...design, alpha: 0.01 }).minimum_trackers > transferPower(0, design).minimum_trackers);
  assert.ok(transferPower(0, { ...design, power: 0.9 }).minimum_trackers > transferPower(0, design).minimum_trackers);
  assert.ok(transferPower(0, { ...design, looks: 4 }).minimum_trackers > transferPower(0, design).minimum_trackers);
  assert.throws(() => transferPower(0, { ...design, effect: 0.010000000000000002 }), /transfer_design_capacity/);
  const w = await processWorkspace(); const value = transferCorpus();
  const chosen = { ...design, effect: 0.5, alpha: 0.025, power: 0.9 };
  const declaration = await recordTransferPlan(w.client, value.manifest.digest, chosen);
  assert.deepEqual((await readTransferPlan(w.client, declaration)).design, chosen);
  const archive = await archiveTransferCorpus(w.client, value);
  const result = await recordTransferEvaluation(w.client, archive, "meta", value.tasks.meta.map(({ id }) => ({ id, candidate: 1, incumbent: 0 })), declaration);
  assert.equal(result.report.reason, "transfer_underpowered"); assert.deepEqual(result.report.design, chosen);
  assert.deepEqual(await replayTransferEvaluation(w.client, result.digest), result.report);
  const wrong = await recordTransferPlan(w.client, "0".repeat(64), chosen);
  await assert.rejects(recordTransferEvaluation(w.client, archive, "meta", value.tasks.meta.map(({ id }) => ({ id, candidate: 1, incumbent: 0 })), wrong), /transfer_plan_corpus/);
});

test("legacy configurations remain inspectable but new execution requires a prospective transfer declaration", async () => {
  const { transfer: _transfer, ...legacy } = proposerEvolutionConfiguration();
  assert.deepEqual(parseProposerEvolutionConfig(legacy), legacy);
  const w = await processWorkspace(); const before = (await w.client.listAllComplete({ includeBody: true })).items;
  await assert.rejects(runProposerEvolution(w.client, w.coordinates, { id: "unplanned", approval: w.approval, dataset: "unread-dataset", config: legacy }), /transfer_plan_required/);
  assert.deepEqual((await w.client.listAllComplete({ includeBody: true })).items, before);
  for (const transfer of [{ effect: 0.1, alpha: 0.05, power: 0.8, extra: true }, { effect: 0.1, alpha: 0, power: 0.8 }]) assert.throws(() => parseProposerEvolutionConfig({ ...legacy, transfer }), /proposer_invalid/);
});
