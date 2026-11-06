/** Malformed native packets are real SDK records; replay must refuse them with stable coded errors. */
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { PmClient } from "@unbrained/pm-cli/sdk/core";
import { isPmCliExpectedError, EXIT_CODE } from "@unbrained/pm-cli/sdk/runtime";
import { createExtensionTestHarness } from "@unbrained/pm-cli/sdk/testing";
import extension from "../index.ts";
import { hashJson, type JsonValue } from "../json-identity.ts";
import { archiveTransferCorpus, replayTransferCorpus, replayTransferEvaluation, recordTransferPlan, readTransferPlan, recordTransferEvaluation, planTransferArchive, verifyTransferCorpus, TRANSFER_DESIGN, type TransferCorpus } from "../proposer-transfer.ts";
import { readImproverTasks } from "../improver-data.ts";
import { proposerCorpusReader } from "../proposer-evolution.ts";
import { processWorkspace } from "./fixtures/process-workspace.ts";
import { transferCorpus, writeTransferDataset } from "./fixtures/transfer-corpus.ts";

/** Create an addressed malformed body through the same registered native fields as production. */
async function native(client: PmClient, value: unknown): Promise<string> {
  const digest = hashJson(value as JsonValue);
  await client.create({ id: `transfer-${digest}`, type: "Decision", title: "Synthetic native shape boundary", body: JSON.stringify(value), affectedVersion: digest, component: "proposer-transfer" });
  return digest;
}
/** Malformed shapes must never escape as raw TypeError or an unclassified assertion. */
function typedTransfer(error: unknown): boolean { return isPmCliExpectedError(error) && error.exitCode === EXIT_CODE.USAGE && String(error.context.code).startsWith("transfer_"); }

test("malformed native envelope roots refuse through SDK and CLI before field access", async () => {
  const w = await processWorkspace(); const value = transferCorpus();
  const good = await archiveTransferCorpus(w.client, value); assert.deepEqual(await replayTransferCorpus(w.client, good), value);
  const harness = await createExtensionTestHarness(extension, { name: "pm-rl", capabilities: ["commands", "hooks", "schema"] });
  for (const body of [null, [], 1, false, "record", {}, { format: null }, { format: "unknown" }]) {
    const address = await native(w.client, body);
    await assert.rejects(replayTransferCorpus(w.client, address), typedTransfer);
    await assert.rejects(harness.runCommand({ pmRoot: w.pmRoot, command: "rl proposer transfer replay", args: [address] }), typedTransfer);
  }
});

test("malformed native corpus shards and legacy references refuse with coded shape evidence", async () => {
  const w = await processWorkspace(); const value = transferCorpus(); const plan = planTransferArchive(value);
  await archiveTransferCorpus(w.client, value);
  for (const shards of [null, "abc", {}, [null], ["abc"]]) {
    await assert.rejects(replayTransferCorpus(w.client, await native(w.client, { ...plan.root, shards })), typedTransfer);
  }
  for (const entries of [null, "abc", {}, [null], [1], [{}], [{ kind: "unknown" }], [{ kind: "source", source: null }], [{ kind: "omission", omission: null }], [{ kind: "task", role: "development", task: null }], [{ kind: "task", role: "other", task: {} }]]) {
    const bad = await native(w.client, { ...plan.shards[0], entries });
    await assert.rejects(replayTransferCorpus(w.client, await native(w.client, { ...plan.root, entry_count: plan.root.entry_count - plan.shards[0].entries.length + (Array.isArray(entries) ? entries.length : 0), shards: [bad, ...plan.root.shards.slice(1)] })), typedTransfer);
  }
  const task = value.tasks.development[0];
  for (const patch of [{ cutoff: { toString: null, valueOf: null } }, { train: [null] }, { train: [{ ...task.train[0], prefix: null }] }, { train: [{ ...task.train[0], prefix: { ...task.train[0].prefix, fields: [null] } }] }]) {
    const bad = await native(w.client, { ...plan.shards[1], entries: [{ kind: "task", role: "development", task: { ...task, ...patch } }, ...plan.shards[1].entries.slice(1)] });
    await assert.rejects(replayTransferCorpus(w.client, await native(w.client, { ...plan.root, shards: [plan.root.shards[0], bad, ...plan.root.shards.slice(2)] })), typedTransfer);
  }
  for (const tasks of [null, "abc", [null], [{ role: "meta", digest: null }]]) {
    await assert.rejects(replayTransferCorpus(w.client, await native(w.client, { format: "pm-rl/proposer-transfer-corpus/1", manifest: value.manifest, tasks })), typedTransfer);
  }
  const packet = await native(w.client, { format: "pm-rl/proposer-transfer-task/1", role: "meta", task: null });
  await assert.rejects(replayTransferCorpus(w.client, await native(w.client, { format: "pm-rl/proposer-transfer-corpus/1", manifest: null, tasks: [{ role: "meta", digest: packet }] })), typedTransfer);
});

test("malformed native evaluation pairs and plan coordinates refuse before score use", async () => {
  const w = await processWorkspace(); const value = transferCorpus();
  const corpus = await archiveTransferCorpus(w.client, value);
  const design = { ...TRANSFER_DESIGN, looks: 2 }; const plan = await recordTransferPlan(w.client, value.manifest.digest, design);
  const good = await recordTransferEvaluation(w.client, corpus, "meta", value.tasks.meta.map(({ id }) => ({ id, candidate: 0.5, incumbent: 0.5 })), plan);
  assert.deepEqual(await replayTransferEvaluation(w.client, good.digest), good.report);
  await assert.rejects(readTransferPlan(w.client, await native(w.client, { format: "pm-rl/proposer-transfer-plan/2", corpus: null, design })), typedTransfer);
  const envelope = { corpus, plan, role: "meta", look: 1, report: {}, comparisons: 2 };
  for (const format of ["pm-rl/proposer-transfer-evaluation/1", "pm-rl/proposer-transfer-evaluation/2"]) {
    for (const pairs of [null, "abc", [null], new Array<number>(150_000).fill(0)]) await assert.rejects(replayTransferEvaluation(w.client, await native(w.client, { ...envelope, format, pairs })), typedTransfer);
  }
  for (const patch of [{ corpus: null }, { plan: null }]) await assert.rejects(replayTransferEvaluation(w.client, await native(w.client, { ...envelope, format: "pm-rl/proposer-transfer-evaluation/2", pairs: [], ...patch })), typedTransfer);
  for (const shards of [null, "abc", [null], ["abc"]]) await assert.rejects(replayTransferEvaluation(w.client, await native(w.client, { ...envelope, format: "pm-rl/proposer-transfer-evaluation/3", pair_count: 2, shards })), typedTransfer);
  const shard = await native(w.client, { format: "pm-rl/proposer-transfer-pairs/2", index: 0, pairs: [null] });
  await assert.rejects(replayTransferEvaluation(w.client, await native(w.client, { ...envelope, format: "pm-rl/proposer-transfer-evaluation/3", pair_count: 10_001, shards: [shard] })), (error) => isPmCliExpectedError(error) && error.context.code === "transfer_pair_shards");
  for (const pair_count of [1, { valueOf: null, toString: null }]) await assert.rejects(replayTransferEvaluation(w.client, await native(w.client, { ...envelope, format: "pm-rl/proposer-transfer-evaluation/3", pair_count, shards: [shard] })), typedTransfer);
});

test("malformed role indexes and shard roots refuse while bounded and legacy files remain readable", async () => {
  const w = await processWorkspace(); const value = transferCorpus(); const directory = writeTransferDataset(w.root, value);
  const shard = { format: "pm-rl/improver-role-shard/1", role: "meta", index: 0, tasks: value.tasks.meta };
  const address = hashJson(shard as unknown as JsonValue);
  const root = { format: "pm-rl/improver-role/2", role: "meta", digest: value.manifest.splits.meta.digest, count: 2, shards: [address] };
  const file = join(directory, "meta.json");
  writeFileSync(join(directory, `meta-${address}.json`), JSON.stringify(shard)); writeFileSync(file, JSON.stringify(root));
  assert.deepEqual(readImproverTasks(directory, value.manifest, "meta"), value.tasks.meta);
  for (const malformed of [null, 1, "role"]) {
    writeFileSync(file, JSON.stringify(malformed));
    assert.throws(() => readImproverTasks(directory, value.manifest, "meta"), /improver_role_identity/);
    assert.throws(proposerCorpusReader(directory), (error) => isPmCliExpectedError(error) && error.context.code === "proposer_dataset_invalid");
  }
  for (const malformed of [null, [], "shard"]) {
    const digest = hashJson(malformed); writeFileSync(join(directory, `meta-${digest}.json`), JSON.stringify(malformed));
    writeFileSync(file, JSON.stringify({ ...root, shards: [digest] }));
    assert.throws(() => readImproverTasks(directory, value.manifest, "meta"), /improver_role_shard/);
  }
  const dense = { ...shard, tasks: new Array<null>(150_000).fill(null) }; const denseDigest = hashJson(dense as JsonValue);
  writeFileSync(join(directory, `meta-${denseDigest}.json`), JSON.stringify(dense)); writeFileSync(file, JSON.stringify({ ...root, shards: [denseDigest] }));
  assert.throws(() => readImproverTasks(directory, value.manifest, "meta"), /improver_role_count/);
  writeFileSync(file, JSON.stringify(value.tasks.meta)); assert.deepEqual(readImproverTasks(directory, value.manifest, "meta"), value.tasks.meta);
});

test("corpus structural validation refuses malformed decoded prerequisites before semantic hashing", async () => {
  const w = await processWorkspace(); const value = transferCorpus(); await archiveTransferCorpus(w.client, value);
  const manifest = value.manifest; const task = value.tasks.meta[0]; const row = task.train[0];
  const malformed: unknown[] = [null, [], {}, { ...value, manifest: null }, { ...value, tasks: null },
    ...[{ digest: null }, { format: null }, { seed: "42" }, { sources: null }, { omitted: null }, { splits: null },
      { sources: [null] }, { sources: [{ ...manifest.sources[0], repo: null }] }, { sources: [{ ...manifest.sources[0], commit: null }] }, { sources: [{ ...manifest.sources[0], role: null }] },
      { omitted: [null] }, { omitted: [{ repo: null, target: "issue-type" }] }, { omitted: [{ repo: "public-fixture/x", target: null }] },
      { splits: { ...manifest.splits, meta: null } }, { splits: { ...manifest.splits, meta: { digest: null, tasks: 2 } } }, { splits: { ...manifest.splits, meta: { digest: manifest.splits.meta.digest, tasks: "2" } } },
    ].map((patch) => ({ ...value, manifest: { ...manifest, ...patch } })),
    { ...value, tasks: { ...value.tasks, meta: null } },
    ...[null, ...[{ id: null }, { repo: null }, { commit: null }, { target: null }, { cutoff: null }, { train: null }, { evaluation: null },
      { train: [null] }, { train: [{ ...row, id: null }] }, { train: [{ ...row, prefix: null }] },
      ...[{ events: null }, { fields: null }, { words: null }, { events: [null] }].map((prefix) => ({ train: [{ ...row, prefix: { ...row.prefix, ...prefix } }] })),
    ].map((patch) => ({ ...task, ...patch }))].map((entry) => ({ ...value, tasks: { ...value.tasks, meta: [entry] } })),
  ];
  for (const candidate of malformed) assert.throws(() => verifyTransferCorpus(candidate as TransferCorpus), typedTransfer);
});

test("promotion documentation distinguishes a passed gate from prospective execution", () => {
  const text = readFileSync(new URL("../README.md", import.meta.url), "utf8").replaceAll("`", "").replace(/\s+/g, " ");
  assert.ok(text.includes("Promotion of a proposer requires a passed tracker-transfer evaluation."));
  assert.ok(text.includes("A new rl proposer run requires a prospective transfer declaration; an underpowered run may complete while retaining the prior proposer."));
});
