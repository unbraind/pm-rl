/** Reuse the same adversarial boundaries against source and the shipped npm artifact. */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { PmClient } from "@unbrained/pm-cli/sdk/core";
import { init, isPmCliExpectedError } from "@unbrained/pm-cli/sdk/runtime";
import { createExtensionTestHarness } from "@unbrained/pm-cli/sdk/testing";
import extension, { hashJson, type JsonValue } from "../../index.ts";
import { EXCLUDED_TRACKER_NAMES } from "../../dataset.ts";
import { archiveTransferCorpus, evaluateTransfer, loadTransferCorpus, planTransferArchive, recordTransferEvaluation, recordTransferPlan, replayTransferCorpus, verifyTransferCorpus, TRANSFER_DESIGN, TRANSFER_MAX_TASKS, transferPower, type TransferCorpus } from "../../proposer-transfer.ts";
import { parseProposerEvolutionConfig, proposerEvolutionConfiguration, runProposerEvolution } from "../../proposer-evolution.ts";
import { sealTransferCorpus, transferCorpus, writeTransferDataset } from "./transfer-corpus.ts";

/** Change one source identity consistently, so only semantic policy can reject it. */
function renamedCorpus(repo: string): TransferCorpus {
  const value = transferCorpus({ development: 1, meta: 2, audit: 1 });
  const previous = value.manifest.sources.find((source) => source.role === "meta")!.repo;
  return sealTransferCorpus({ manifest: { ...value.manifest, sources: value.manifest.sources.map((source) => source.repo === previous ? { ...source, repo } : source) }, tasks: { ...value.tasks, meta: value.tasks.meta.map((task) => task.repo === previous ? { ...task, repo } : task) } });
}

/** Assert all public corpus boundaries share path-component exclusions before native writes. */
export async function checkTransferBoundaries(project: string, examples: string): Promise<{ examples: number; paths: number; native_replay: boolean }> {
  assert.equal(existsSync(join(project, ".git")), false);
  const { path: pmRoot } = await init("boundary", { defaults: true, agentGuidance: "skip", author: "boundary-test" }, { cwd: project, pmRoot: join(project, ".agents/pm") });
  const client = new PmClient({ cwd: project, pmRoot, noExtensions: true, author: "boundary-test" });
  const approval = (await client.create({ id: "control", type: "Task", title: "Stop at approval before any fit" })).item.id;
  const harness = await createExtensionTestHarness(extension, { name: "pm-rl", capabilities: ["commands", "hooks", "schema"] });
  const dataset = writeTransferDataset(project, transferCorpus({ development: 1, meta: 2, audit: 1 }));
  let exampleCount = 0;
  for (const name of readdirSync(examples).filter((name) => /^proposer.*\.json$/.test(name))) {
    const file = join(examples, name); const config = parseProposerEvolutionConfig(JSON.parse(readFileSync(file, "utf8")));
    assert.ok(config.transfer !== undefined); assert.equal(config.transfer.alpha, 0.05); assert.equal(config.transfer.power, 0.8);
    const looks = config.generations + 1;
    // Independent oracle: every task and every fresh meta look must fit the fixed role cap.
    const minimum = Math.ceil(2 * (Math.sqrt(Math.log(4 * looks / config.transfer.alpha)) + Math.sqrt(Math.log(1 / (1 - config.transfer.power)))) ** 2 / (config.transfer.effect - 0.01) ** 2);
    assert.equal(transferPower(0, { ...TRANSFER_DESIGN, ...config.transfer, looks }).minimum_trackers, minimum);
    assert.ok(minimum * 2 * config.generations <= TRANSFER_MAX_TASKS, `${name}: infeasible meta capacity`);
    assert.ok(minimum * 2 <= TRANSFER_MAX_TASKS, `${name}: infeasible audit capacity`);
    assert.deepEqual(config, proposerEvolutionConfiguration(), "shipped JSON and prospective SDK defaults agree");
    /** A feasible declaration reaches the independent approval guard without starting training. */
    const approvalRefusal = (error: unknown): boolean => isPmCliExpectedError(error) && error.context.code === "proposer_approval";
    await assert.rejects(runProposerEvolution(client, { pmRoot, author: "boundary-test" }, { id: "example", approval, dataset, config }), approvalRefusal);
    for (const json of [false, true]) await assert.rejects(harness.runCommand({ command: "rl proposer run", pmRoot, args: ["example"], options: { file, approval, dataset }, global: { json } }), approvalRefusal);
    exampleCount++;
  }
  assert.ok(exampleCount > 0);
  const before = (await client.listAllComplete({ includeBody: true })).items;
  let paths = 0;
  for (const name of EXCLUDED_TRACKER_NAMES) {
    for (const repo of [name, `public-fixture/${name}`, `public-fixture/${name}/`, `public-fixture/${name}//`, `public-fixture/${name}/extra`, `public-fixture/extra/${name}/more`, `PUBLIC-FIXTURE/ ${name.toUpperCase()} /`, `public-fixture/${name.replaceAll("p", "ｐ")}/extra`]) {
      const corpus = renamedCorpus(repo); const directory = join(project, `case-${paths++}`); mkdirSync(directory);
      const input = writeTransferDataset(directory, corpus);
      for (const check of [() => verifyTransferCorpus(corpus), () => loadTransferCorpus(input), () => planTransferArchive(corpus), () => evaluateTransfer(corpus, "audit", [], { ...TRANSFER_DESIGN, looks: 2 })]) assert.throws(check, /transfer_private_source/);
      await assert.rejects(archiveTransferCorpus(client, corpus), /transfer_private_source/);
      const file = join(examples, "proposer-program.json"); const config = parseProposerEvolutionConfig(JSON.parse(readFileSync(file, "utf8")));
      await assert.rejects(runProposerEvolution(client, { pmRoot, author: "boundary-test" }, { id: "private", approval, dataset: input, config }), (error) => isPmCliExpectedError(error) && error.context.code === "proposer_dataset_invalid");
      for (const json of [false, true]) await assert.rejects(harness.runCommand({ command: "rl proposer run", pmRoot, args: ["private"], options: { file, approval, dataset: input }, global: { json } }), (error) => isPmCliExpectedError(error) && error.context.code === "proposer_dataset_invalid");
    }
  }
  assert.deepEqual((await client.listAllComplete({ includeBody: true })).items, before);
  // Historical permissive identities and an excluded owner are still supported.
  for (const repo of ["legacy", "public-fixture/pm-client/", "pm-cli/public-control", "public-fixture/extra/control"]) verifyTransferCorpus(renamedCorpus(repo));
  /** Real native birth records prevent a forged but correctly hashed corpus bypassing replay. */
  const native = async (value: JsonValue): Promise<string> => {
    const digest = hashJson(value); await client.create({ id: `transfer-${digest}`, type: "Decision", title: "Synthetic boundary replay", body: JSON.stringify(value), affectedVersion: digest, component: "proposer-transfer" }); return digest;
  };
  const corpus = renamedCorpus("public-fixture/pm-cli/"); const tasks: { role: string; digest: string }[] = [];
  for (const [role, members] of Object.entries(corpus.tasks)) for (const task of members) tasks.push({ role, digest: await native({ format: "pm-rl/proposer-transfer-task/1", role, task } as unknown as JsonValue) });
  const root = await native({ format: "pm-rl/proposer-transfer-corpus/1", manifest: corpus.manifest, tasks } as unknown as JsonValue);
  const plan = await recordTransferPlan(client, corpus.manifest.digest, { ...TRANSFER_DESIGN, looks: 2 });
  const sealed = (await client.listAllComplete({ includeBody: true })).items;
  await assert.rejects(replayTransferCorpus(client, root), /transfer_private_source/);
  await assert.rejects(recordTransferEvaluation(client, root, "audit", [], plan), /transfer_private_source/);
  assert.deepEqual((await client.listAllComplete({ includeBody: true })).items, sealed);
  return { examples: exampleCount, paths, native_replay: true };
}
