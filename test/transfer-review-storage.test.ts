/** Real controller writes and executable source boundaries cover the remaining transfer review findings. */
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { isPmCliExpectedError } from "@unbrained/pm-cli/sdk/runtime";
import { withRlController, readCompleteLoopItem } from "../index.ts";
import { hashJson, type JsonValue } from "../json-identity.ts";
import { persistProposerEvaluationPlan, proposerEvaluationPlan, proposerEvolutionConfiguration, runProposerEvolution } from "../proposer-evolution.ts";
import { initialProposer } from "../proposer-program.ts";
import { MAX_TRACKER_RECORD_BYTES } from "../tracker-record.ts";
import { verifyPublicTrackerSource } from "../dataset.ts";
import { copyImproverSources } from "../scripts/live-improver.ts";
import { transferCorpus, sealTransferCorpus, writeTransferDataset } from "./fixtures/transfer-corpus.ts";
import { processWorkspace } from "./fixtures/process-workspace.ts";
import { git, withTrackerSources } from "./fixtures/meta-workspace.ts";
import { readDiagnosticReceipt, rebuildDiagnosticCorpus, replayDiagnosticMain } from "./fixtures/transfer-replay.ts";

test("large controller plans persist bounded references at generation and audit steps and resume without writes", async () => {
  const w = await processWorkspace(); const corpus = "c".repeat(64);
  const members = Array.from({ length: 9840 }, (_, index) => ({ id: hashJson(index), repo: `public-fixture/pm-unit-${Math.floor(index / 2)}`, target: index % 2 ? "time-to-close" : "issue-type" }));
  const plan = proposerEvaluationPlan("large", initialProposer(), members, corpus, 10);
  assert.ok(Buffer.byteLength(JSON.stringify(plan)) > MAX_TRACKER_RECORD_BYTES);
  const request = { id: "large", approval: w.approval, recoveryCommand: "resume synthetic controller" };
  /** Use the real fenced writer shared by both production plan steps, without running thousands of fits. */
  const run = () => withRlController(w.client, w.coordinates, request, new AbortController().signal, async (step) => {
    for (const key of ["g1-plan", "audit-plan"]) assert.deepEqual(await persistProposerEvaluationPlan(step, key, "unchanged-input", plan, corpus), plan);
  });
  await run();
  const histories = new Map<string, string>();
  for (const key of ["g1-plan", "audit-plan"]) {
    const item = (await readCompleteLoopItem(w.client, `large-step-${key}`)).item;
    assert.ok(Buffer.byteLength(String(item.body)) < MAX_TRACKER_RECORD_BYTES);
    const record = JSON.parse(String(item.body)) as { result: unknown };
    assert.deepEqual(record.result, { format: "pm-rl/proposer-evaluation-plan-reference/1", corpus, comparison: hashJson(plan as unknown as JsonValue) });
    histories.set(key, readFileSync(join(w.pmRoot, "history", `${item.id}.jsonl`), "utf8"));
  }
  await run();
  for (const [key, history] of histories) assert.equal(readFileSync(join(w.pmRoot, "history", `rl-large-step-${key}.jsonl`), "utf8"), history);
});

test("unrepresentable generation and audit plans refuse before resource reservation or training", async () => {
  for (const role of ["meta", "audit"] as const) {
    const budget = { training_steps: 1000, wall_ms: 100_000_000, compute_units: 100_000_000, storage_bytes: 100_000_000, tokens: 0 };
    const w = await processWorkspace(budget); const original = transferCorpus();
    await w.client.update(w.approval, { body: '```json\n' + JSON.stringify({ permitted_promotions: 100, meta_budget: { training_samples: 100000, proposal_calls: 100, recipe_promotions: 100 }, resource_budget: budget }) + '\n```' });
    const value = sealTransferCorpus({ ...original, tasks: { ...original.tasks, [role]: original.tasks[role].map((task) => ({ ...task, id: task.id + "x".repeat(1024) })) } });
    const directory = writeTransferDataset(w.root, value); const before = (await w.client.listAllComplete({ includeBody: true })).items;
    await assert.rejects(runProposerEvolution(w.client, w.coordinates, { id: "invalid-plan", approval: w.approval, dataset: directory, config: { ...proposerEvolutionConfiguration(), generations: 1, candidates: 1, updates: 1 }, onStep() { assert.fail("Invalid plan reached a durable controller step"); } }), (error) => isPmCliExpectedError(error) && error.context.code === "eval_plan_invalid");
    assert.deepEqual((await w.client.listAllComplete({ includeBody: true })).items, before);
  }
});

test("controller plan references verify corpus and plan identities while historical inline receipts remain readable", async () => {
  const w = await processWorkspace(); const corpus = "d".repeat(64);
  const plan = proposerEvaluationPlan("legacy", initialProposer(), [{ id: "task", repo: "public-fixture/pm-one", target: "issue-type" }], corpus, 2);
  const request = { id: "legacy", approval: w.approval, recoveryCommand: "resume synthetic controller" };
  await withRlController(w.client, w.coordinates, request, new AbortController().signal, async (step) => {
    await step("inline-plan", null, async () => plan as unknown as JsonValue);
    assert.deepEqual(await persistProposerEvaluationPlan(step, "inline-plan", null, plan, corpus), plan);
    await persistProposerEvaluationPlan(step, "reference-plan", null, plan, corpus);
  });
  /** Drift tests keep valid native receipts intact and change only the reconstruction input. */
  for (const key of ["inline-plan", "reference-plan"]) {
    await assert.rejects(withRlController(w.client, w.coordinates, request, new AbortController().signal, (step) => persistProposerEvaluationPlan(step, key, null, { ...plan, selection: "different" }, corpus)), (error) => isPmCliExpectedError(error) && error.context.code === "proposer_drift");
  }
  await assert.rejects(withRlController(w.client, w.coordinates, request, new AbortController().signal, (step) => persistProposerEvaluationPlan(step, "reference-plan", null, plan, "e".repeat(64))), /proposer_drift|Stored proposer evaluation plan/);
});

test("diagnostic remote and fleet copies preflight every public MIT commit before any Git or scratch mutation", async () => {
  await withTrackerSources(async ({ root, bin, gh, directories }) => {
    const receipt = readDiagnosticReceipt(resolve(import.meta.dirname, "../docs/proposer-transfer-receipt.json"));
    const pins = directories.map((directory) => ({ repo: `public-fixture/${dirname(dirname(directory)).split("/").at(-1)}`, commit: git(dirname(dirname(directory)), ["rev-parse", "HEAD"]) }));
    const selected = { ...receipt, full_manifest: { ...receipt.full_manifest, sources: pins.map((pin) => ({ ...pin, role: "development" as const, license: "MIT" as const })) } };
    const log = join(root, "commands.jsonl"); const fakeGit = join(bin, "git");
    writeFileSync(fakeGit, `#!${process.execPath}\nrequire('node:fs').appendFileSync(${JSON.stringify(log)}, JSON.stringify(['git',...process.argv.slice(2)])+'\\n'); process.exit(91);\n`); chmodSync(fakeGit, 0o755);
    const modes = ["private", "internal", "unlicensed", "wrong-name", "missing-name", "null", "wrong-commit", "missing-commit"];
    for (const mode of modes) {
      // The last source fails, proving all sources must pass before even the first clone.
      writeFileSync(gh, `#!${process.execPath}\nconst fs=require('node:fs'); const a=process.argv.slice(2); fs.appendFileSync(${JSON.stringify(log)},JSON.stringify(['gh',...a])+'\\n'); const bad=a.join('/').includes('pm-epsilon'); const mode=${JSON.stringify(mode)}; if(a[0]==='api'){if(bad&&mode==='missing-commit')process.exit(1);console.log(bad&&mode==='wrong-commit'?'0'.repeat(40):a[1].split('/').at(-1));}else{const m={visibility:bad&&mode==='private'?'PRIVATE':bad&&mode==='internal'?'INTERNAL':'PUBLIC',licenseInfo:bad&&mode==='unlicensed'?null:{key:'mit'},nameWithOwner:bad&&mode==='wrong-name'?'other/pm-source':bad&&mode==='missing-name'?null:a[2]}; console.log(JSON.stringify(bad&&mode==='null'?null:m));}\n`);
      for (const fleet of [undefined, root]) {
        writeFileSync(log, "");
        const scratch = join(root, `refused-${mode}-${fleet === undefined ? "remote" : "fleet"}`);
        assert.throws(() => rebuildDiagnosticCorpus(selected, scratch, fleet));
        assert.equal(existsSync(scratch), false);
        assert.equal(existsSync(join(scratch, "dataset")), false);
        assert.doesNotMatch(readFileSync(log, "utf8"), /\["git"/);
      }
      const { digest: _digest, ...record } = selected;
      const file = join(root, "supplied-receipt.json"); writeFileSync(file, JSON.stringify({ ...record, digest: hashJson(record as unknown as JsonValue) }));
      const project = join(root, `cli-refused-${mode}`);
      await assert.rejects(replayDiagnosticMain(["--receipt", file, "--pm-root", join(project, ".agents/pm")]));
      assert.equal(existsSync(project), false);
    }
    // Public MIT sources with reachable exact pins pass preflight, then reach Git.
    writeFileSync(gh, `#!${process.execPath}\nconst a=process.argv.slice(2); console.log(a[0]==='api'?a[1].split('/').at(-1):JSON.stringify({visibility:'PUBLIC',licenseInfo:{key:'mit'},nameWithOwner:a[2]}));\n`);
    for (const fleet of [undefined, root]) {
      writeFileSync(log, ""); const scratch = join(root, `allowed-${fleet === undefined ? "remote" : "fleet"}`); mkdirSync(scratch);
      assert.throws(() => rebuildDiagnosticCorpus(selected, scratch, fleet), /Command failed/);
      assert.match(readFileSync(log, "utf8"), /\["git","clone"/);
    }
    const before = readFileSync(log, "utf8");
    for (const pin of [{ repo: "owner/pm-observer", commit: pins[0].commit }, { repo: "invalid", commit: pins[0].commit }, { ...pins[0], commit: "bad" }]) {
      assert.throws(() => verifyPublicTrackerSource(pin.repo, pin.commit, root));
    }
    assert.equal(readFileSync(log, "utf8"), before);
    const output = join(root, "direct-copy");
    assert.throws(() => copyImproverSources(root, output, [{ ...pins[0], commit: "bad" }])); assert.equal(existsSync(output), false);
  });
});
