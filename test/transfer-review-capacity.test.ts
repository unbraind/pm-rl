/** Powered storage regressions retain released formats and use real native SDK histories. */
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { isPmCliExpectedError } from "@unbrained/pm-cli/sdk/runtime";
import type { PmClient } from "@unbrained/pm-cli/sdk/core";
import { createExtensionTestHarness } from "@unbrained/pm-cli/sdk/testing";
import extension, { readCompleteLoopItem } from "../index.ts";
import { hashJson, type JsonValue } from "../json-identity.ts";
import { planImproverRoleFiles, readImproverTasks, type ImproverTask } from "../improver-data.ts";
import { parseProposerEvolutionConfig, proposerCorpusReader, proposerEvolutionConfiguration, runProposerEvolution } from "../proposer-evolution.ts";
import { archiveTransferCorpus, loadTransferCorpus, recordTransferPlan, readTransferPlan, recordTransferEvaluation, replayTransferEvaluation, transferPower, TRANSFER_DESIGN, TRANSFER_MAX_TASKS, type TransferCorpus } from "../proposer-transfer.ts";
import { MAX_JSON_BYTES, MAX_TRACKER_RECORD_BYTES } from "../tracker-record.ts";
import { transferCorpus, sealTransferCorpus, writeTransferDataset } from "./fixtures/transfer-corpus.ts";
import { processWorkspace } from "./fixtures/process-workspace.ts";

const design = { ...TRANSFER_DESIGN, effect: 0.081, looks: 2 };
let powered: TransferCorpus | undefined;
/** Realistic hashed identifiers and epoch timestamps exceed both old aggregate storage limits. */
function poweredCorpus(): TransferCorpus {
  if (powered !== undefined) return powered;
  const value = transferCorpus({ development: 1, meta: 1, audit: transferPower(0, design).minimum_trackers });
  /** Keep all chronological labels and split membership unchanged while using realistic coordinate widths. */
  const realistic = (task: ImproverTask): ImproverTask => {
    const rows = [...task.train, ...task.evaluation].map((row) => ({ ...row, id: hashJson(row.id), prediction_at: row.prediction_at + 1_700_000_000_000, available_at: row.available_at + 1_700_000_000_000 }));
    return { ...task, id: hashJson(task.id), cutoff: task.cutoff + 1_700_000_000_000, train: rows.slice(0, 4), evaluation: rows.slice(4) };
  };
  powered = sealTransferCorpus({ ...value, tasks: { development: value.tasks.development.map(realistic), meta: value.tasks.meta.map(realistic), audit: value.tasks.audit.map(realistic) } });
  return powered;
}
/** Deliberate corrupted roots are genuine SDK creations, not mocked reads. */
async function native(client: PmClient, value: unknown): Promise<string> {
  const digest = hashJson(value as JsonValue);
  await client.create({ id: `transfer-${digest}`, type: "Decision", title: "Synthetic paired boundary", body: JSON.stringify(value), affectedVersion: digest, component: "proposer-transfer" });
  return digest;
}

test("powered role projections cross the old JSON bound without changing split identities or stale-cache protection", { timeout: 300_000 }, async () => {
  const w = await processWorkspace(); const value = poweredCorpus();
  assert.ok(Buffer.byteLength(JSON.stringify(value.tasks.audit)) > MAX_JSON_BYTES);
  const files = planImproverRoleFiles("audit", value.tasks.audit);
  assert.ok(files.length > 2 && files.every((file) => Buffer.byteLength(file.text) <= MAX_JSON_BYTES));
  const directory = writeTransferDataset(w.root, value);
  assert.deepEqual(loadTransferCorpus(directory), value);
  const current = proposerCorpusReader(directory); const prior = current(); assert.equal(current(), prior);
  const file = join(directory, files[0].name); const original = readFileSync(file, "utf8");
  writeFileSync(file, original.replace('"cutoff":1700000000004', '"cutoff":1700000000005'));
  assert.throws(current, (error) => isPmCliExpectedError(error) && error.context.code === "proposer_dataset_invalid");
  writeFileSync(file, original); assert.deepEqual(current(), value);
  rmSync(file); assert.throws(() => readImproverTasks(directory, value.manifest, "audit")); writeFileSync(file, original);
  const rootFile = join(directory, "audit.json"); const rootText = readFileSync(rootFile, "utf8");
  const root = JSON.parse(rootText) as { shards: string[]; count: number; role: string };
  for (const patch of [{ shards: [] }, { shards: root.shards.slice(0, -1) }, { shards: root.shards.slice(1) }, { shards: [...root.shards, root.shards[0]] }, { shards: [...root.shards].reverse() }, { shards: ["../bad"] }, { count: root.count + 1 }, { role: "meta" }, { format: "unknown" }, { digest: "0".repeat(64) }]) {
    writeFileSync(rootFile, JSON.stringify({ ...root, ...patch })); assert.throws(() => readImproverTasks(directory, value.manifest, "audit"));
  }
  const chunk = JSON.parse(original) as { tasks: unknown[] };
  for (const patch of [{ format: "unknown" }, { role: "meta" }, { index: -1 }, { tasks: null }, { tasks: [] }]) {
    const forged = { ...chunk, ...patch }; const address = hashJson(forged as unknown as JsonValue);
    writeFileSync(join(directory, `audit-${address}.json`), JSON.stringify(forged));
    writeFileSync(rootFile, JSON.stringify({ ...root, shards: [address, ...root.shards.slice(1)] }));
    assert.throws(() => readImproverTasks(directory, value.manifest, "audit"));
  }
  writeFileSync(rootFile, rootText); assert.deepEqual(readImproverTasks(directory, value.manifest, "audit"), value.tasks.audit);
});

test("powered paired evaluations exceeding one MiB replay through bounded native shards and reject corrupted roots", { timeout: 600_000 }, async () => {
  const w = await processWorkspace(); const value = poweredCorpus();
  const plan = await recordTransferPlan(w.client, value.manifest.digest, design);
  const corpus = await archiveTransferCorpus(w.client, value);
  const pairs = value.tasks.audit.map(({ id }) => ({ id, candidate: 0.9999999999999999, incumbent: 1 / 3 }));
  assert.ok(Buffer.byteLength(JSON.stringify(pairs)) > MAX_TRACKER_RECORD_BYTES);
  const result = await recordTransferEvaluation(w.client, corpus, "audit", pairs, plan);
  assert.equal(result.report.passed, true); assert.deepEqual(await replayTransferEvaluation(w.client, result.digest), result.report);
  const root = JSON.parse(String((await readCompleteLoopItem(w.client, `transfer-${result.digest}`)).item.body)) as { format: string; shards: string[]; pair_count: number };
  assert.equal(root.format, "pm-rl/proposer-transfer-evaluation/3"); assert.ok(root.shards.length > 1);
  for (const address of [result.digest, ...root.shards]) assert.ok(Buffer.byteLength(String((await readCompleteLoopItem(w.client, `transfer-${address}`)).item.body)) <= MAX_TRACKER_RECORD_BYTES);
  for (const patch of [{ shards: [] }, { shards: root.shards.slice(0, -1) }, { shards: root.shards.slice(1) }, { shards: [...root.shards, root.shards[0]] }, { shards: [...root.shards].reverse() }, { shards: ["0".repeat(64), ...root.shards.slice(1)] }, { pair_count: root.pair_count + 1 }]) {
    await assert.rejects(replayTransferEvaluation(w.client, await native(w.client, { ...root, ...patch })));
  }
  const shard = JSON.parse(String((await readCompleteLoopItem(w.client, `transfer-${root.shards[0]}`)).item.body)) as { pairs: unknown[] };
  for (const patch of [{ format: "unknown" }, { pairs: null }, { pairs: [] }]) {
    const malformed = await native(w.client, { ...shard, ...patch });
    await assert.rejects(replayTransferEvaluation(w.client, await native(w.client, { ...root, shards: [malformed, ...root.shards.slice(1)] })), /transfer_pair_shard/);
  }
  const oversized = await native(w.client, { ...root, padding: "x".repeat(MAX_TRACKER_RECORD_BYTES) });
  await assert.rejects(replayTransferEvaluation(w.client, oversized), /json_record_limit/);
  await w.client.update(`transfer-${root.shards[0]}`, { body: JSON.stringify({ ...shard, pairs: [] }) });
  await assert.rejects(replayTransferEvaluation(w.client, result.digest), /transfer_record_drift/);
});

test("empty planned meta looks refuse before native controller writes or any fit", async () => {
  const w = await processWorkspace(); const directory = writeTransferDataset(w.root, transferCorpus());
  const before = (await w.client.listAllComplete({ includeBody: true })).items;
  let entered = false;
  await assert.rejects(runProposerEvolution(w.client, w.coordinates, { id: "impossible-empty-look", dataset: directory, approval: w.approval, config: proposerEvolutionConfiguration() }), (error) => isPmCliExpectedError(error) && error.context.code === "transfer_underpowered" && error.message.includes("12872 meta tasks"));
  await assert.rejects(runProposerEvolution(w.client, w.coordinates, { id: "empty-look", dataset: directory, approval: w.approval, config: { ...proposerEvolutionConfiguration(), transfer: { effect: 0.5, alpha: 0.05, power: 0.8 }, candidates: 1, updates: 1 }, onStep() { entered = true; } }), (error) => isPmCliExpectedError(error) && error.context.code === "transfer_underpowered" && error.message.includes("Meta look 2"));
  assert.equal(entered, false); assert.deepEqual((await w.client.listAllComplete({ includeBody: true })).items, before);
});

test("corpus-capacity preflight matches the power oracle across SDK and CLI formats without writes", async () => {
  const w = await processWorkspace(); assert.equal(existsSync(join(w.root, ".git")), false);
  const directory = writeTransferDataset(w.root, transferCorpus(4)); const file = join(w.root, "declaration.json");
  const harness = await createExtensionTestHarness(extension, { name: "pm-rl", capabilities: ["commands", "hooks", "schema"] });
  // A real non-Decision approval proves feasible declarations reach the next preflight without fitting.
  const approval = (await w.client.create({ id: "capacity-control", type: "Task", title: "Synthetic preflight control" })).item.id;
  const config = proposerEvolutionConfiguration(); const historical = { ...TRANSFER_DESIGN, ...config.transfer, looks: config.generations + 1 };
  const plan = await recordTransferPlan(w.client, "a".repeat(64), historical);
  assert.deepEqual((await readTransferPlan(w.client, plan)).design, historical);
  const before = (await w.client.listAllComplete({ includeBody: true })).items;
  const histories = before.map((item) => [join(w.pmRoot, "history", `${item.id}.jsonl`), readFileSync(join(w.pmRoot, "history", `${item.id}.jsonl`), "utf8")] as const);
  for (const generations of [1, 2, 3, 4]) {
    const looks = generations + 1;
    // Independent inversion puts exact-capacity and one-tracker-over cases on both sides of every boundary.
    const coefficient = 2 * (Math.sqrt(Math.log(4 * looks / 0.05)) + Math.sqrt(Math.log(1 / (1 - 0.8)))) ** 2;
    const boundary = Math.floor(10_000 / (2 * generations));
    const effects = [1, 0.10, 0.08, 0.0100001, ...[boundary, boundary + 1].map((n) => 0.01 + Math.sqrt(coefficient / (n - 0.5)))];
    for (const effect of effects) {
      const value = { ...config, generations, transfer: { effect, alpha: 0.05, power: 0.8 } };
      assert.deepEqual(parseProposerEvolutionConfig(value), value); writeFileSync(file, JSON.stringify(value));
      const minimum = Math.ceil(coefficient / (effect - 0.01) ** 2);
      const audit = BigInt(minimum) * 2n; const meta = audit * BigInt(generations);
      const impossible = meta > 10_000n || audit > 10_000n;
      /** Feasibility is a run-only refusal; messages report exact requirements without reading approval. */
      const verdict = (error: unknown): boolean => {
        assert.ok(isPmCliExpectedError(error)); assert.equal(error.context.code, impossible ? "transfer_underpowered" : "proposer_approval");
        if (impossible) for (const text of [`${minimum} independent trackers`, `${meta} meta tasks`, `${audit} audit tasks`, "10000 tasks"]) assert.ok(error.message.includes(text), error.message);
        return true;
      };
      await assert.rejects(runProposerEvolution(w.client, w.coordinates, { id: "capacity", dataset: directory, approval, config: value, onStep() { assert.fail("Capacity preflight reached a controller step"); } }), verdict);
      for (const json of [false, true]) await assert.rejects(harness.runCommand({ command: "rl proposer run", pmRoot: w.pmRoot, args: ["capacity"], options: { file, dataset: directory, approval }, global: { json } }), verdict);
    }
  }
  assert.deepEqual((await w.client.listAllComplete({ includeBody: true })).items, before);
  for (const [path, text] of histories) assert.equal(readFileSync(path, "utf8"), text);
});

test("power documentation consistently states look-count declarations for the study and shipped configuration", () => {
  const required = transferPower(0, { ...TRANSFER_DESIGN, looks: 2 }).minimum_trackers.toLocaleString("en-US");
  for (const file of ["README.md", "ARCHITECTURE.md", "docs/proposer-transfer.md"]) {
    const text = readFileSync(new URL(`../${file}`, import.meta.url), "utf8").replace(/\s+/g, " ").replaceAll("**", "");
    assert.ok(text.includes(`${required} independent trackers per task at each look for two looks (one generation plus audit)`), file);
    const config = proposerEvolutionConfiguration(); const looks = config.generations + 1; assert.ok(config.transfer !== undefined);
    const shipped = transferPower(0, { ...TRANSFER_DESIGN, ...config.transfer, looks }).minimum_trackers.toLocaleString("en-US");
    assert.ok(text.includes(`three looks and requires ${shipped} independent trackers per task at each look`), file);
    assert.ok(text.includes("look-count table"), file);
  }
});

test("documentation pages presenting the shipped runnable declaration state the task-cap refusal", () => {
  const config = proposerEvolutionConfiguration(); const looks = config.generations + 1; assert.ok(config.transfer !== undefined);
  const perLook = transferPower(0, { ...TRANSFER_DESIGN, ...config.transfer, looks }).minimum_trackers;
  const metaTasks = perLook * TRANSFER_DESIGN.targets.length * config.generations;
  /** The shipped declaration must actually exceed the cap for this documentation contract to apply. */
  assert.ok(metaTasks > TRANSFER_MAX_TASKS, `expected ${metaTasks} meta tasks to exceed the ${TRANSFER_MAX_TASKS}-task cap`);
  for (const file of ["README.md", "docs/proposer-programs.md"]) {
    const text = readFileSync(new URL(`../${file}`, import.meta.url), "utf8").replace(/\s+/g, " ").replaceAll("**", "");
    /** Every page that shows a runnable proposer example with the shipped declaration must explain the refusal. */
    assert.ok(/rl proposer run|runProposerEvolution/.test(text), `${file} presents the shipped runnable declaration`);
    assert.ok(text.includes("transfer_underpowered"), `${file} names the refusal code`);
    assert.ok(text.includes("10,000-task"), `${file} names the compartment cap`);
    assert.ok(/sizing table|look-count table/.test(text), `${file} points to a feasible declaration`);
  }
  const guide = readFileSync(new URL("../docs/proposer-programs.md", import.meta.url), "utf8").replace(/\s+/g, " ").replaceAll("**", "");
  assert.ok(guide.includes(`${perLook.toLocaleString("en-US")} independent trackers per task at each look`), "docs/proposer-programs.md states the derived per-look requirement");
  assert.ok(guide.includes(`${metaTasks.toLocaleString("en-US")} meta tasks`), "docs/proposer-programs.md states the derived meta-task requirement");
  assert.ok(guide.includes("diagnostic replay"), "docs/proposer-programs.md keeps the shipped declaration usable for validation and diagnostic replay");
});
