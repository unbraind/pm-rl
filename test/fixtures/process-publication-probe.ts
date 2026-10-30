/** Installed-consumer probe uses public SDK imports and the installed package's actual process executor. */
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { PmClient } from "@unbrained/pm-cli/sdk/core";
import { isPmCliExpectedError } from "@unbrained/pm-cli/sdk/runtime";
import { executeProcessTrainer, processJobId, processStaging, readProcessJob, referenceTrainerArgv, reserveProcessJob, transitionProcessJob, type ProcessCompletion } from "../../process.ts";
import { readLoopRevision } from "../../index.ts";
import { banditCheckpoint } from "../../bandit.ts";
import { banditProcessInput, parseLoopConfig, runLoopGeneration } from "../../loop.ts";

const [root, pmRoot, configFile] = process.argv.slice(2);
const resources = { training_steps: 1, wall_ms: 5000, storage_bytes: 65536, compute_units: 1000, tokens: 4 };
const adapter = { kind: "process-bandit", allowance: resources } as const;
const config = parseLoopConfig({ ...JSON.parse(readFileSync(configFile, "utf8")) as Record<string, unknown>, adapter });
const step = { learningRate: config.learningRate, evaluationSamples: config.evaluationSamples };
const checkpoint = banditCheckpoint(config.initialWeight);
const collected = runLoopGeneration(config, step, 1, checkpoint, checkpoint);
const base = banditProcessInput(config, step, 1, collected);
const client = new PmClient({ cwd: root, pmRoot, noExtensions: true, author: "publication-packed" });
const budget = Object.fromEntries(Object.entries(resources).map(([key, value]) => [key, value * 2]));
const approval = await client.create({ id: "packed-publication-approval", type: "Decision", title: "Bounded publication probe", body: "```json\n" + JSON.stringify({ permitted_promotions: 2, resource_budget: budget }) + "\n```" });
for (const phase of ["running", "materialized"] as const) {
  const input = { ...base, identity: { phase, original: base.identity } }; const command = referenceTrainerArgv(); const id = processJobId(input, command, adapter);
  let expected: unknown; let revision = 0;
  await assert.rejects(executeProcessTrainer(client, { pmRoot, author: "publication-packed", async onTransition(context) {
    if (context.transactionId.includes(`-${phase}-v`) && context.transition === "step_applied") {
      const job = (await readProcessJob(client, id))!;
      await client.update(id, { body: JSON.stringify({ ...job, outcome: "installed-peer-progress" }), addTags: ["peer-evidence"] });
      expected = (await client.get(id, { full: true })).item; revision = await readLoopRevision(client, id);
      throw new Error(`installed-${phase}-publication`);
    }
  } }, input, approval.item.id, adapter, undefined, command), (error: unknown) => {
    assert.ok(isPmCliExpectedError(error)); assert.equal(error.context.code, "superseded"); assert.ok(String(error).includes(`installed-${phase}-publication`)); return true;
  });
  assert.ok(expected); assert.deepEqual((await client.get(id, { full: true })).item, expected); assert.equal(await readLoopRevision(client, id), revision);
  if (phase === "running") { const job = (await readProcessJob(client, id))!; assert.deepEqual(job.charge, resources); assert.equal(job.settled, false); }
}
for (const state of ["planned", "running"] as const) {
  const input = { ...base, identity: { staging: state, original: base.identity } }; const command = referenceTrainerArgv(); const id = processJobId(input, command, adapter);
  const approved = await client.create({ id: `packed-staging-${state}`, type: "Decision", title: "Bounded staging recovery", parent: "none", goal: "none", objective: "none", sprint: "none", release: "none", body: "```json\n" + JSON.stringify({ permitted_promotions: 1, resource_budget: resources }) + "\n```" });
  const coordinates = { pmRoot, author: "publication-packed" };
  const reserved = await reserveProcessJob(client, coordinates, id, input, approved.item.id, resources);
  if (state === "running") {
    const running = await transitionProcessJob(client, coordinates, reserved, state, "previous-execution");
    const charge = { ...resources, training_steps: 0 };
    const claimed: ProcessCompletion = { format: "pm-rl/process-completion/1", job: id, checkpoint: "checkpoint.json", digest: input.source.digest, policy: input.source, source_policy: input.source.digest, training_config: input.training_config, lineage: input.lineage, usage: charge };
    const revision = await readLoopRevision(client, id);
    await assert.rejects(transitionProcessJob(client, coordinates, running, "materialized", "unproven-refund", claimed, charge), (error: unknown) => isPmCliExpectedError(error) && error.context.code === "process_charge_regression");
    assert.equal(await readLoopRevision(client, id), revision);
  }
  const directory = processStaging(pmRoot, id); mkdirSync(dirname(directory), { recursive: true }); writeFileSync(directory, "retained staging obstruction");
  await assert.rejects(executeProcessTrainer(client, coordinates, input, approved.item.id, adapter, undefined, command));
  const failed = (await readProcessJob(client, id))!; assert.equal(failed.state, "failed"); assert.equal(failed.settled, true);
  for (const key of Object.keys(resources) as (keyof typeof resources)[]) assert.equal(failed.charge[key], state === "running" ? resources[key] : 0);
  const next = { ...input, identity: { next: true, original: input.identity } }; const nextId = processJobId(next, command, adapter);
  if (state === "running") {
    await assert.rejects(reserveProcessJob(client, coordinates, nextId, next, approved.item.id, resources), (error: unknown) => isPmCliExpectedError(error) && error.context.code === "process_budget_exhausted");
    assert.equal(await readProcessJob(client, nextId), null);
  } else assert.equal((await reserveProcessJob(client, coordinates, nextId, next, approved.item.id, resources)).state, "planned");
}
process.stdout.write(JSON.stringify({ publication_refusals: 2, peer_state_retained: true, charged_dimensions: 5, staging_recoveries: 2, resumed_budget_retained: true, materialization_refusals: 1 }) + "\n");
