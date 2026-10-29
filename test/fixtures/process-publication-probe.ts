/** Installed-consumer probe uses public SDK imports and the installed package's actual process executor. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PmClient } from "@unbrained/pm-cli/sdk/core";
import { isPmCliExpectedError } from "@unbrained/pm-cli/sdk/runtime";
import { executeProcessTrainer, processJobId, readProcessJob, referenceTrainerArgv } from "../../process.ts";
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
process.stdout.write(JSON.stringify({ publication_refusals: 2, peer_state_retained: true, charged_dimensions: 5 }) + "\n");
