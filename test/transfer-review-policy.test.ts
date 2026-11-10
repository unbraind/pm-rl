/** Current-head review regressions exercise public-source policy and typed CLI errors through real SDK trackers. */
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, realpathSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { EXIT_CODE, isPmCliExpectedError } from "@unbrained/pm-cli/sdk/runtime";
import { createExtensionTestHarness } from "@unbrained/pm-cli/sdk/testing";
import extension, { type RlCommandResult } from "../index.ts";
import { checkedTrackerSourcePath, excludedTrackerName } from "../dataset.ts";
import { archiveTransferCorpus, parseTransferDesign, recordTransferEvaluation, recordTransferPlan, replayTransferEvaluation, TRANSFER_DESIGN, type TransferCorpus } from "../proposer-transfer.ts";
import { parseProposerEvolutionConfig, proposerEvolutionConfiguration, runProposerEvolution } from "../proposer-evolution.ts";
import { processWorkspace } from "./fixtures/process-workspace.ts";
import { transferCorpus, sealTransferCorpus } from "./fixtures/transfer-corpus.ts";
import { withTrackerSources, git } from "./fixtures/meta-workspace.ts";
import { transferLiveMain } from "./fixtures/transfer-live.ts";

test("shared source exclusions reject every forbidden repository while permitting enclosing fleet containers", async () => {
  const w = await processWorkspace(); const original = transferCorpus();
  const before = (await w.client.listAllComplete({ includeBody: true })).items;
  for (const name of ["pm-cli", "pm-hosted-data", "pm-web", "pm-gpt", "pm-observer", "pm-web-hosted"]) {
    assert.equal(excludedTrackerName(` ${name.toUpperCase()} `), true);
    assert.equal(excludedTrackerName(name.replaceAll("p", "ｐ")), true);
    const physical = join(w.root, "sources", name, ".agents/pm"); mkdirSync(physical, { recursive: true });
    assert.throws(() => checkedTrackerSourcePath(physical), /dataset_forbidden_source/);
    const alias = join(w.root, `${name}-alias`); symlinkSync(join(w.root, "sources", name), alias, "dir");
    assert.throws(() => checkedTrackerSourcePath(join(alias, ".agents/pm")), /dataset_forbidden_source/);
    for (const repo of [`public-fixture/${name}`, `public-fixture/${name}/`, `public-fixture/${name}/extra`]) {
      const invalid = sealTransferCorpus({ ...original, manifest: { ...original.manifest, sources: original.manifest.sources.map((source) => source.role === "meta" ? { ...source, repo } : source) }, tasks: { ...original.tasks, meta: original.tasks.meta.map((task) => ({ ...task, repo })) } });
      await assert.rejects(archiveTransferCorpus(w.client, invalid), /transfer_private_source/);
    }
  }
  assert.deepEqual((await w.client.listAllComplete({ includeBody: true })).items, before);
  await withTrackerSources(async ({ root, directories }) => {
    const fleet = join(root, "pm-cli", "fleet"); mkdirSync(fleet, { recursive: true });
    for (const directory of directories) {
      const repository = join(directory, "../..");
      // Distinct creation dates and alternating types provide a usable chronological public-source control.
      for (let index = 0; index < 32; index++) {
        const file = join(directory, "history", `item-${index}.jsonl`);
        const events = readFileSync(file, "utf8").split("\n").map((line) => JSON.parse(line) as { ts: string; patch: { path: string; value: unknown }[] });
        for (const event of events) event.ts = new Date(Date.parse(event.ts) + index * 86_400_000).toISOString();
        events[0].patch.find((patch) => patch.path === "/metadata/type")!.value = index % 2 === 0 ? "Issue" : "Task";
        writeFileSync(file, events.map((event) => JSON.stringify(event)).join("\n"));
      }
      git(repository, ["add", ".agents/pm/history"]);
      git(repository, ["-c", "user.name=Public Fixture", "-c", "user.email=public@example.test", "commit", "-qm", "Chronological public source control"]);
      const name = directory.split("/").at(-3)!;
      renameSync(repository, join(fleet, name));
      assert.equal(checkedTrackerSourcePath(join(fleet, name, ".agents/pm")), realpathSync(join(fleet, name, ".agents/pm")));
    }
    for (const name of ["pm-cli", "pm-hosted-data", "pm-web", "pm-gpt", "pm-observer", "pm-web-hosted"]) mkdirSync(join(fleet, name));
    const output = join(root, "projection");
    await transferLiveMain(["build", fleet, output]);
    const manifest = JSON.parse(readFileSync(join(output, "dataset/improver-dataset.json"), "utf8")) as TransferCorpus["manifest"];
    assert.equal(manifest.sources.length, directories.length);
    assert.ok(manifest.sources.every((source) => !excludedTrackerName(source.repo.split("/")[1])));
  });
});

test("transfer replay CLI refuses malformed unprefixed digests with typed usage errors and replays a valid receipt", async () => {
  const w = await processWorkspace(); const corpus = transferCorpus();
  const root = await archiveTransferCorpus(w.client, corpus);
  const plan = await recordTransferPlan(w.client, corpus.manifest.digest, { ...TRANSFER_DESIGN, looks: 2 });
  const result = await recordTransferEvaluation(w.client, root, "audit", corpus.tasks.audit.map(({ id }) => ({ id, candidate: 0.5, incumbent: 0.5 })), plan);
  const harness = await createExtensionTestHarness(extension, { name: "pm-rl", capabilities: ["commands", "hooks", "schema"] });
  const valid = (await harness.runCommand({ pmRoot: w.pmRoot, command: "rl proposer transfer replay", args: [result.digest] })).result as RlCommandResult;
  assert.deepEqual(valid.details, result.report);
  const before = (await w.client.listAllComplete({ includeBody: true })).items;
  for (const digest of ["abc", "g".repeat(64), result.digest.toUpperCase(), `sha256:${result.digest}`, "../bad"]) {
    await assert.rejects(harness.runCommand({ pmRoot: w.pmRoot, command: "rl proposer transfer replay", args: [digest] }), (error) => isPmCliExpectedError(error) && error.exitCode === EXIT_CODE.USAGE);
  }
  await assert.rejects(harness.runCommand({ pmRoot: w.pmRoot, command: "rl proposer transfer replay", args: ["abc"] }), (error) => isPmCliExpectedError(error) && error.context.code === "transfer_digest");
  assert.deepEqual((await w.client.listAllComplete({ includeBody: true })).items, before);
});

test("missing prospective transfer plan refuses through SDK and CLI before opening data while legacy inspection remains supported", async () => {
  const w = await processWorkspace(); const { transfer: _transfer, ...legacy } = proposerEvolutionConfiguration();
  assert.deepEqual(parseProposerEvolutionConfig(legacy), legacy);
  const file = join(w.root, "legacy.json"); writeFileSync(file, JSON.stringify(legacy));
  const harness = await createExtensionTestHarness(extension, { name: "pm-rl", capabilities: ["commands", "hooks", "schema"] });
  const inspection = (await harness.runCommand({ pmRoot: w.pmRoot, command: "rl proposer validate", options: { file } })).result as RlCommandResult;
  assert.equal(inspection.details!.valid, true);
  const before = (await w.client.listAllComplete({ includeBody: true })).items;
  await assert.rejects(runProposerEvolution(w.client, w.coordinates, { id: "unplanned", approval: w.approval, dataset: "unopened-dataset", config: legacy }), (error) => isPmCliExpectedError(error) && error.context.code === "transfer_plan_required" && error.message.includes("Declare transfer.effect"));
  await assert.rejects(harness.runCommand({ pmRoot: w.pmRoot, command: "rl proposer run", args: ["unplanned"], options: { file, dataset: "unopened-dataset", approval: w.approval } }), (error) => isPmCliExpectedError(error) && error.context.code === "transfer_plan_required");
  assert.deepEqual((await w.client.listAllComplete({ includeBody: true })).items, before);
});

test("prospective transfer designs cannot relax alpha or power and stricter native plans remain replayable", async () => {
  const w = await processWorkspace(); const design = { ...TRANSFER_DESIGN, looks: 2 };
  const before = (await w.client.listAllComplete({ includeBody: true })).items;
  for (const patch of [{ alpha: 0.9 }, { power: 0.1 }, { alpha: 0.050001 }, { power: 0.799999 }]) {
    const invalid = { ...design, ...patch };
    assert.throws(() => parseTransferDesign(invalid), /transfer_design/);
    await assert.rejects(recordTransferPlan(w.client, "a".repeat(64), invalid), /transfer_design/);
  }
  assert.deepEqual((await w.client.listAllComplete({ includeBody: true })).items, before);
  const value = transferCorpus(); const root = await archiveTransferCorpus(w.client, value);
  for (const declared of [design, { ...design, alpha: 0.01, power: 0.9 }]) {
    const plan = await recordTransferPlan(w.client, value.manifest.digest, declared);
    const measured = await recordTransferEvaluation(w.client, root, "meta", value.tasks.meta.map(({ id }) => ({ id, candidate: 1, incumbent: 0 })), plan);
    assert.equal(measured.report.passed, false); assert.equal(measured.report.reason, "transfer_underpowered");
    assert.deepEqual(measured.report.design, declared);
    assert.deepEqual(await replayTransferEvaluation(w.client, measured.digest), measured.report);
  }
  assert.equal(Reflect.set(TRANSFER_DESIGN, "alpha", 0.9), false);
  assert.equal(Reflect.set(TRANSFER_DESIGN.targets, "0", "other"), false);
});
