/** Diagnostic receipts rebuild real native evidence without polluting a development tracker. */
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { hashJson, type JsonValue } from "../json-identity.ts";
import { archiveTransferCorpus, recordTransferPlan, recordTransferEvaluation, replayTransferEvaluation, planTransferArchive, TRANSFER_DESIGN } from "../proposer-transfer.ts";
import { readDiagnosticReceipt, requireDiagnosticScratch, restoreDiagnosticReceipt, replayDiagnosticMain, type DiagnosticReceipt } from "./fixtures/transfer-replay.ts";
import { processWorkspace } from "./fixtures/process-workspace.ts";
import { transferCorpus, sealTransferCorpus } from "./fixtures/transfer-corpus.ts";

test("diagnostic replay requires explicit non-Git scratch roots before effects including symlinks", async () => {
  const w = await processWorkspace();
  assert.equal(requireDiagnosticScratch(w.pmRoot), w.pmRoot);
  await assert.rejects(replayDiagnosticMain([]), /diagnostic_explicit_pm_root_required/);
  await assert.rejects(replayDiagnosticMain(["--unknown", "x"]), /diagnostic_arguments/);
  const gitProject = join(w.root, "development"); mkdirSync(gitProject); mkdirSync(join(gitProject, ".git"));
  const target = join(gitProject, ".agents/pm");
  assert.throws(() => requireDiagnosticScratch(target), /diagnostic_requires_non_git_scratch_tracker/);
  await assert.rejects(replayDiagnosticMain(["--pm-root", target, "--receipt", "missing.json"]), /diagnostic_requires_non_git_scratch_tracker/);
  symlinkSync(gitProject, join(w.root, "alias"), "dir");
  assert.throws(() => requireDiagnosticScratch(join(w.root, "alias/.agents/pm")), /diagnostic_requires_non_git_scratch_tracker/);
  assert.equal(readFileSync(join(w.pmRoot, "settings.json"), "utf8").length > 0, true);
});

test("compact receipt restores native transfer evidence without development tracker records", async () => {
  const source = await processWorkspace(); const target = await processWorkspace(); const original = transferCorpus();
  const corpus = sealTransferCorpus({ manifest: { ...original.manifest, sources: original.manifest.sources.map((source) => ({ ...source, repo: source.repo.replace("/", "/pm-") })) }, tasks: Object.fromEntries(Object.entries(original.tasks).map(([role, tasks]) => [role, tasks.map((task) => ({ ...task, repo: task.repo.replace("/", "/pm-") }))])) as unknown as typeof original.tasks });
  const root = await archiveTransferCorpus(source.client, corpus);
  const design = { ...TRANSFER_DESIGN, looks: 2 };
  const plan = await recordTransferPlan(source.client, corpus.manifest.digest, design);
  const pairs = corpus.tasks.audit.map(({ id }) => ({ id, candidate: 0.5, incumbent: 0.5 }));
  const measured = await recordTransferEvaluation(source.client, root, "audit", pairs, plan);
  const data = { format: "pm-rl/proposer-diagnostic-receipt/1" as const, full_manifest: corpus.manifest, manifest: corpus.manifest, task_ids: { development: corpus.tasks.development.map((t) => t.id), meta: corpus.tasks.meta.map((t) => t.id), audit: corpus.tasks.audit.map((t) => t.id) }, archive: { root, shards: planTransferArchive(corpus).root.shards, plan }, design, evaluations: [{ ...measured, role: "audit" as const, look: 1, pairs }] };
  const receipt: DiagnosticReceipt = { ...data, digest: hashJson(data as unknown as JsonValue) };
  const file = join(target.root, "receipt.json"); writeFileSync(file, JSON.stringify(receipt));
  assert.deepEqual(readDiagnosticReceipt(file), receipt);
  writeFileSync(file, JSON.stringify({ ...receipt, design: { ...design, effect: 0.5 } }));
  assert.throws(() => readDiagnosticReceipt(file), /diagnostic_receipt_digest/);
  rmSync(source.root, { recursive: true });
  assert.deepEqual(await restoreDiagnosticReceipt(target.client, receipt, corpus), [measured.digest]);
  assert.deepEqual(await replayTransferEvaluation(target.client, measured.digest), measured.report);
  const before = (await target.client.listAllComplete({ includeBody: true })).items;
  await assert.rejects(restoreDiagnosticReceipt(target.client, { ...receipt, archive: { ...receipt.archive, root: "0".repeat(64) } }, corpus), /diagnostic_root_drift/);
  await assert.rejects(restoreDiagnosticReceipt(target.client, { ...receipt, evaluations: receipt.evaluations.map((row) => ({ ...row, digest: "0".repeat(64) })) }, corpus), /diagnostic_evaluation_drift/);
  assert.deepEqual((await target.client.listAllComplete({ includeBody: true })).items, before);
});

test("committed diagnostic receipt records historical scores and explicit scratch replay", () => {
  const receipt = readDiagnosticReceipt(resolve(import.meta.dirname, "../docs/proposer-transfer-receipt.json"));
  assert.equal(receipt.evaluations.length, 2);
  for (const row of receipt.evaluations) {
    assert.equal(row.report.reason, "transfer_underpowered");
    assert.ok(row.report.tasks.every((task) => task.effect === 0 && task.trackers === 3 && task.power_lower_bound === 0));
  }
});
