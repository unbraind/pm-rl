/** Fifth-round regressions use native non-Git SDK trackers and deterministic boundary fixtures. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, symlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";
import type { PmClient } from "@unbrained/pm-cli/sdk/core";
import { isPmCliExpectedError, EXIT_CODE } from "@unbrained/pm-cli/sdk/runtime";
import { hashJson, type JsonValue } from "../json-identity.ts";
import { archiveTransferCorpus, recordTransferEvaluation, recordTransferPlan, readTransferPlan, replayTransferEvaluation, transferPower, TRANSFER_DESIGN } from "../proposer-transfer.ts";
import { parseProposerEvolutionConfig, proposerEvolutionConfiguration, proposerEvaluationPlan, requireProposerTransfer, runProposerEvolution } from "../proposer-evolution.ts";
import { initialProposer, ProposerRefusal } from "../proposer-program.ts";
import { evaluatePlan } from "../evaluation-plan.ts";
import { replayDiagnosticMain } from "./fixtures/transfer-replay.ts";
import { processWorkspace } from "./fixtures/process-workspace.ts";
import { transferCorpus } from "./fixtures/transfer-corpus.ts";

/** Seal deliberately malformed input through the real registered SDK fields and native history. */
async function native(client: PmClient, value: unknown): Promise<string> {
  const body = JSON.stringify(value); const digest = hashJson(JSON.parse(body) as JsonValue);
  await client.create({ id: `transfer-${digest}`, type: "Decision", title: "Synthetic final replay boundary", body, affectedVersion: digest, component: "proposer-transfer" });
  return digest;
}
/** Refusals carry actionable SDK usage context, rather than raw runtime assertions. */
function typed(error: unknown): boolean { return isPmCliExpectedError(error) && error.exitCode === EXIT_CODE.USAGE && String(error.context.code).startsWith("transfer_"); }

test("unrepresentable prospective power refuses before resource reservation or dataset access", async () => {
  const w = await processWorkspace(); const config = proposerEvolutionConfiguration();
  assert.deepEqual(parseProposerEvolutionConfig(config), config);
  const invalid = { ...config, transfer: { ...config.transfer!, effect: 0.01000001 } };
  assert.throws(() => parseProposerEvolutionConfig(invalid), ProposerRefusal);
  const before = (await w.client.listAllComplete({ includeBody: true })).items;
  const steps: string[] = [];
  await assert.rejects(runProposerEvolution(w.client, w.coordinates, { id: "capacity", approval: w.approval, dataset: "unopened-dataset", config: invalid, onStep: (key) => { steps.push(key); } }), ProposerRefusal);
  assert.deepEqual(steps, []);
  assert.deepEqual((await w.client.listAllComplete({ includeBody: true })).items, before);
});

test("transfer refusal preserves an existing comparison code and remedy", async () => {
  const w = await processWorkspace(); const corpus = transferCorpus();
  const root = await archiveTransferCorpus(w.client, corpus);
  const plan = await recordTransferPlan(w.client, corpus.manifest.digest, { ...TRANSFER_DESIGN, looks: 2 });
  const measured = await recordTransferEvaluation(w.client, root, "meta", corpus.tasks.meta.map(({ id }) => ({ id, candidate: 1, incumbent: 0 })), plan);
  const members = Array.from({ length: 256 }, (_, index) => ({ id: String(index), repo: String(index), target: "control" }));
  const control = evaluatePlan(proposerEvaluationPlan("control", initialProposer(), members, "context", 2), members.map(({ id }) => ({ id, candidate: 1, incumbent: 0 })));
  assert.equal(control.verdict.decision, "promote");
  const blocked = requireProposerTransfer(control, measured.report).verdict;
  assert.ok(blocked.decision === "refuse"); assert.equal(blocked.code, "transfer_underpowered");
  for (const code of ["proposer_budget", "protected_cohort"]) {
    const refused = { ...control, verdict: { decision: "refuse" as const, code, reason: "Existing comparison refusal" }, remedy: "Existing remedy" };
    assert.strictEqual(requireProposerTransfer(refused, measured.report), refused);
    assert.equal(requireProposerTransfer(refused, measured.report).remedy, "Existing remedy");
  }
  assert.strictEqual(requireProposerTransfer(control, { ...measured.report, passed: true }), control);
  assert.equal((await replayTransferEvaluation(w.client, measured.digest)).reason, "transfer_underpowered");
});

test("native plan designs refuse malformed declarations with typed errors", async () => {
  const w = await processWorkspace(); const corpus = transferCorpus();
  const root = await archiveTransferCorpus(w.client, corpus); const design = { ...TRANSFER_DESIGN, looks: 2 };
  const plan = await recordTransferPlan(w.client, corpus.manifest.digest, design);
  const pairs = corpus.tasks.meta.map(({ id }) => ({ id, candidate: 0.5, incumbent: 0.5 }));
  const good = await recordTransferEvaluation(w.client, root, "meta", pairs, plan);
  for (const declaration of [undefined, null, [], {}, { ...design, alpha: 1 }, { ...design, targets: null }, { ...design, targets: [] }, { ...design, targets: ["wrong", "time-to-close"] }, { ...design, looks: 0 }, { ...design, effect: 0.01000001 }]) {
    const bad = await native(w.client, { format: "pm-rl/proposer-transfer-plan/2", corpus: corpus.manifest.digest, design: declaration });
    await assert.rejects(readTransferPlan(w.client, bad), typed);
    await assert.rejects(replayTransferEvaluation(w.client, await native(w.client, { format: "pm-rl/proposer-transfer-evaluation/2", corpus: root, plan: bad, role: "meta", look: 1, pairs, report: good.report })), typed);
  }
  assert.deepEqual(await replayTransferEvaluation(w.client, good.digest), good.report);
});

test("native evaluation coordinates and reports refuse across all supported versions", async () => {
  const w = await processWorkspace(); const corpus = transferCorpus();
  const root = await archiveTransferCorpus(w.client, corpus); const design = { ...TRANSFER_DESIGN, looks: 2 };
  const plan = await recordTransferPlan(w.client, corpus.manifest.digest, design);
  const pairs = corpus.tasks.meta.map(({ id }) => ({ id, candidate: 0.5, incumbent: 0.5 }));
  const good = await recordTransferEvaluation(w.client, root, "meta", pairs, plan);
  const shard = await native(w.client, { format: "pm-rl/proposer-transfer-pairs/2", index: 0, pairs });
  for (const version of [1, 2, 3]) {
    const report = version === 1 ? { ...good.report, format: "pm-rl/proposer-transfer-report/1", design: TRANSFER_DESIGN } : good.report;
    const envelope = { format: `pm-rl/proposer-transfer-evaluation/${version}`, corpus: root, plan, role: "meta", look: 1, comparisons: 2, pairs, report, pair_count: pairs.length, shards: [shard] };
    assert.deepEqual(await replayTransferEvaluation(w.client, await native(w.client, envelope)), report);
    for (const patch of [{ role: undefined }, { role: null }, { role: "development" }, { look: undefined }, { look: null }, { look: 0 }, { look: 2 }, { look: 65 }, { report: undefined }, { report: null }, { report: [] }, { report: {} }, ...(version === 1 ? [{ comparisons: undefined }, { comparisons: 0 }, { comparisons: 65 }] : [])]) {
      await assert.rejects(replayTransferEvaluation(w.client, await native(w.client, { ...envelope, ...patch })), typed);
    }
  }
});

test("diagnostic replay rejects alternate scratch layouts before receipt reads or writes", async () => {
  const w = await processWorkspace();
  const receipt = join(w.root, "missing-receipt.json");
  const before = (await w.client.listAllComplete({ includeBody: true })).items;
  for (const suffix of ["pm", "other/pm", "other.agents/pm", ".agents/other"]) {
    const directory = join(w.root, "unopened");
    await assert.rejects(replayDiagnosticMain(["--pm-root", join(directory, suffix), "--receipt", receipt]), /diagnostic_scratch_layout/);
    assert.equal(existsSync(directory), false);
  }
  await assert.rejects(replayDiagnosticMain(["--pm-root", join(w.root, "valid/.agents/pm"), "--receipt", "missing-receipt.json"]), /ENOENT/);
  assert.equal(existsSync(join(w.root, "valid")), false);
  assert.deepEqual((await w.client.listAllComplete({ includeBody: true })).items, before);
});

test("MDE documentation table matches every prospective power calculation", () => {
  const text = readFileSync(resolve(import.meta.dirname, "../docs/proposer-transfer.md"), "utf8");
  const parameters = text.match(/For alpha ([\d.]+), per-task power ([\d.]+), margin ([\d.]+), two tasks and two looks:/)!;
  assert.ok(parameters);
  const table = text.split("| Prospective MDE (accuracy units) | Required trackers per task per look |\n")[1].split("\n\n")[0];
  const rows = table.split("\n").slice(1).map((row) => row.split("|").slice(1, -1).map((value) => value.trim()));
  assert.deepEqual(rows.map(([effect]) => Number.parseFloat(effect)), [0.05, 0.10, 0.20, 0.30, 0.50, 0.80]);
  for (const [effect, count] of rows) assert.equal(Number(count.replaceAll(",", "")), transferPower(0, { ...TRANSFER_DESIGN, alpha: Number(parameters[1]), power: Number(parameters[2]), margin: Number(parameters[3]), looks: 2, effect: Number.parseFloat(effect) }).minimum_trackers);
});

test("public source controls accept a symlinked temporary directory", async () => {
  const w = await processWorkspace(); const physical = join(w.root, "physical"); mkdirSync(physical);
  const alias = join(w.root, "temporary"); symlinkSync(physical, alias, "dir");
  const run = spawnSync(process.execPath, ["--test", "--test-concurrency=2", "--test-name-pattern=shared source exclusions", "test/transfer-review-policy.test.ts"], { cwd: resolve(import.meta.dirname, ".."), encoding: "utf8", timeout: 180_000, env: { PATH: process.env.PATH, HOME: w.root, TMPDIR: alias, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } });
  assert.equal(run.status, 0, run.stdout + run.stderr);
});
