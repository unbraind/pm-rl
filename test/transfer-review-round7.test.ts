/** Review regressions exercise released role readers and refusal before controller capacity effects. */
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { readImproverTasks, type ImproverTask } from "../improver-data.ts";
import { proposerEvolutionConfiguration, runProposerEvolution } from "../proposer-evolution.ts";
import { MAX_TRACKER_RECORD_BYTES } from "../tracker-record.ts";
import { processWorkspace } from "./fixtures/process-workspace.ts";
import { sealTransferCorpus, transferCorpus, writeTransferDataset } from "./fixtures/transfer-corpus.ts";

/** Preserve exact history bytes as well as visible items when preflight refuses input. */
function histories(root: string): string[] {
  return readdirSync(join(root, "history")).sort().map(file => readFileSync(join(root, "history", file), "utf8"));
}

test("role readers reject absent provenance even when the decoded commit is missing", async () => {
  for (const patch of [{ repo: "public-fixture/unknown" }, { repo: "public-fixture/meta-0" }, {}]) {
    const w = await processWorkspace(); const value = transferCorpus();
    const { commit: _commit, ...task } = { ...value.tasks.development[0], ...patch };
    const forged = sealTransferCorpus({ ...value, tasks: { ...value.tasks, development: [task as unknown as ImproverTask, value.tasks.development[1]] } });
    const directory = writeTransferDataset(w.root, forged);
    assert.throws(() => readImproverTasks(directory, forged.manifest, "development"), /improver_role_leakage/);
  }
  const w = await processWorkspace(); const value = transferCorpus();
  const directory = writeTransferDataset(w.root, value);
  assert.deepEqual(readImproverTasks(directory, value.manifest, "development"), value.tasks.development);
});

test("oversized native corpus packets refuse before reservation or any durable writes", async () => {
  const w = await processWorkspace({ training_steps: 10000, wall_ms: 100_000_000, storage_bytes: 100_000_000, compute_units: 100_000_000, tokens: 0 });
  const approval = String((await w.client.get(w.approval)).item.body);
  await w.client.update(w.approval, { body: approval.replace('"permitted_promotions":2', '"permitted_promotions":10000,"meta_budget":{"training_samples":10000000,"proposal_calls":10000,"recipe_promotions":10000}') });
  const value = transferCorpus(); const base = value.tasks.development[0];
  const rows = Array.from({ length: 10_000 }, (_, index) => ({ ...base.train[index % 4], id: `large-${index}`, label: index % 2 as 0 | 1, prediction_at: index, available_at: index, prefix: { ...base.train[0].prefix, words: new Array<number>(100).fill(999999) } }));
  const corpus = sealTransferCorpus({ ...value, tasks: { ...value.tasks, development: [{ ...base, cutoff: 5000, train: rows.slice(0, 5000), evaluation: rows.slice(5000) }, value.tasks.development[1]] } });
  assert.ok(Buffer.byteLength(JSON.stringify(corpus.tasks.development[0])) > MAX_TRACKER_RECORD_BYTES);
  const directory = writeTransferDataset(w.root, corpus);
  assert.deepEqual(readImproverTasks(directory, corpus.manifest, "development"), corpus.tasks.development);
  assert.equal(existsSync(join(w.root, ".git")), false);
  const before = (await w.client.listAllComplete({ includeBody: true })).items; const history = histories(w.pmRoot);
  for (let retry = 0; retry < 2; retry++) {
    let entered = false;
    await assert.rejects(runProposerEvolution(w.client, w.coordinates, { id: "large-packet", dataset: directory, approval: w.approval, config: { ...proposerEvolutionConfiguration(), generations: 1, candidates: 1, updates: 1 }, onStep() { entered = true; throw new Error("programme-committed-before-packet-preflight"); } }), /json_record_limit/);
    assert.equal(entered, false, "preflight must refuse before a programme step commits");
    assert.deepEqual((await w.client.listAllComplete({ includeBody: true })).items, before);
    assert.deepEqual(histories(w.pmRoot), history);
  }
});
