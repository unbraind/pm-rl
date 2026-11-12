/** Early bounded refusals prevent extra native and filesystem reads of sealed corpus data. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { isPmCliExpectedError } from "@unbrained/pm-cli/sdk/runtime";
import { hashJson, type JsonValue } from "../json-identity.ts";
import { replayTransferCorpus, TRANSFER_MAX_ENTRIES, TRANSFER_MAX_TASKS } from "../proposer-transfer.ts";
import { runProposerEvolution, proposerEvolutionConfiguration } from "../proposer-evolution.ts";
import { readImproverTasks } from "../improver-data.ts";
import { processWorkspace } from "./fixtures/process-workspace.ts";
import { transferCorpus, writeTransferDataset } from "./fixtures/transfer-corpus.ts";

test("native corpus declarations and overflowing shards refuse before subsequent reads", async t => {
  const w = await processWorkspace(); const value = transferCorpus();
  const native = async (record: unknown) => {
    const digest = hashJson(record as JsonValue);
    await w.client.create({ id: `transfer-${digest}`, type: "Decision", title: "Synthetic replay bounds", body: JSON.stringify(record), affectedVersion: digest, component: "proposer-transfer" }); return digest;
  };
  const shard = await native({ format: "pm-rl/proposer-transfer-shard/2", index: 0, entries: [null, null, null] });
  const base = { format: "pm-rl/proposer-transfer-corpus/2", manifest: value.manifest, shards: [shard, "0".repeat(64)], entry_count: 2 };
  const cases = [
    { ...base, entry_count: TRANSFER_MAX_ENTRIES + 1 },
    { ...base, shards: [shard, "0".repeat(64), "1".repeat(64)] },
    { format: "pm-rl/proposer-transfer-corpus/1", manifest: value.manifest, tasks: new Array(3 * TRANSFER_MAX_TASKS + 1).fill(null) },
    base,
  ];
  const addresses = await Promise.all(cases.map(native));
  const original = w.client.get.bind(w.client); let reads = 0;
  t.mock.method(w.client, "get", (...args: Parameters<typeof original>) => { reads++; return original(...args); });
  for (const [index, address] of addresses.entries()) {
    reads = 0;
    await assert.rejects(replayTransferCorpus(w.client, address), error => isPmCliExpectedError(error) && error.context.code === (index === 1 ? "transfer_shard_order" : "transfer_shard_count"));
    assert.equal(reads, index === 3 ? 4 : 2, "proof:bounded_native_reads");
  }
});

test("role reader rejects overflowing collection before opening the following shard", async () => {
  const w = await processWorkspace(); const value = transferCorpus(); const directory = writeTransferDataset(w.root, value);
  const shard = { format: "pm-rl/improver-role-shard/1", role: "meta", index: 0, tasks: [...value.tasks.meta, value.tasks.meta[0]] };
  const address = hashJson(shard as unknown as JsonValue);
  writeFileSync(join(directory, `meta-${address}.json`), JSON.stringify(shard));
  writeFileSync(join(directory, "meta.json"), JSON.stringify({ format: "pm-rl/improver-role/2", role: "meta", digest: value.manifest.splits.meta.digest, count: 2, shards: [address, "0".repeat(64)] }));
  assert.throws(() => readImproverTasks(directory, value.manifest, "meta"), /improver_role_count/, "proof:bounded_role_reads");
  const manifest = { ...value.manifest, splits: { ...value.manifest.splits, meta: { ...value.manifest.splits.meta, tasks: TRANSFER_MAX_TASKS + 1 } } };
  assert.throws(() => readImproverTasks(directory, manifest, "meta"), /improver_role_count/);
});

test("malformed manifest preflight stays a typed dataset refusal before controller work", async () => {
  const w = await processWorkspace(); const value = transferCorpus(); const directory = writeTransferDataset(w.root, value);
  const record = { format: value.manifest.format, seed: value.manifest.seed, sources: value.manifest.sources, omitted: value.manifest.omitted, splits: null };
  writeFileSync(join(directory, "improver-dataset.json"), JSON.stringify({ ...record, digest: hashJson(record as unknown as JsonValue) }));
  await assert.rejects(runProposerEvolution(w.client, w.coordinates, { id: "malformed-preflight", approval: w.approval, dataset: directory, config: { ...proposerEvolutionConfiguration(), generations: 1, candidates: 1, updates: 1 }, onStep() { assert.fail("Malformed manifest reached controller work"); } }), error => isPmCliExpectedError(error) && error.context.code === "proposer_dataset_invalid", "proof:typed_manifest_preflight");
});

test("direct reader import initializes shared limits without a module cycle", () => {
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", 'await import("./improver-data.ts");'], { cwd: new URL("..", import.meta.url), encoding: "utf8", timeout: 30_000 });
  assert.ifError(result.error); assert.equal(result.status, 0, `proof:reader_import_cycle ${result.stdout}${result.stderr}`);
});
