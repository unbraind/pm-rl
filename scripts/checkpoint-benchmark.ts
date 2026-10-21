/** Reproducible checkpoint size/load measurements on an already sealed public tracker corpus. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { PmClient } from "@unbrained/pm-cli/sdk/core";
import { init } from "@unbrained/pm-cli/sdk/runtime";
import { checkpointArtifactPath, readCheckpointArtifact, readVerifiedFile, type CheckpointArtifact } from "../checkpoint-artifacts.ts";
import { readTrackerDataset } from "../dataset.ts";
import { runRlMeta, type MetaConfig } from "../meta.ts";
import { prefixCheckpoint, type PrefixCheckpoint } from "../prefix.ts";
import { recipeArtifact } from "../recipe.ts";
import { listProcessJobs } from "../process.ts";
import { liveMetaConfiguration } from "./live-meta.ts";
import { isMainInvocation } from "./script-launcher.ts";

/** Compare warm synchronous verified reads; legacy reads use the same bytes, hash and semantic validator. */
export function measureCheckpointLoads(root: string, ref: CheckpointArtifact, iterations = 100) {
  /** Measure wall time including filesystem read, parsing and integrity/schema verification. */
  const measure = (load: () => unknown) => {
    load(); const samples: number[] = [];
    for (let index = 0; index < iterations; index += 1) { const start = performance.now(); load(); samples.push(performance.now() - start); }
    samples.sort((a, b) => a - b);
    return { iterations, median_ms: samples[Math.floor(samples.length / 2)], mean_ms: samples.reduce((sum, value) => sum + value, 0) / samples.length };
  };
  const legacy = ref.bytes > 4096 ? null : measure(() => {
    const bytes = readVerifiedFile(checkpointArtifactPath(root, ref.digest), ref.digest, ref.bytes);
    assert.equal(`sha256:${createHash("sha256").update(bytes).digest("hex")}`, ref.digest);
    const policy = JSON.parse(bytes.toString("utf8")) as PrefixCheckpoint;
    assert.equal(prefixCheckpoint(policy.weights, policy.knobs).digest, policy.digest); return policy;
  });
  return { checkpoint_bytes: ref.bytes, legacy_4096_byte_reader: legacy, artifact_reader: measure(() => readCheckpointArtifact(root, ref)) };
}

/** Run identical two-generation compute/statistical programmes at legacy and expanded capacity on a plain tracker. */
export async function benchmarkCheckpointCorpus(dataset: string, scratch: string, baseline: MetaConfig) {
  const manifest = readTrackerDataset(dataset);
  const scratchRoot = resolve(scratch);
  mkdirSync(scratchRoot, { recursive: true });
  const runs = [];
  for (const width of [32, 4096]) {
    const project = mkdtempSync(join(scratchRoot, "capacity-"));
    const { path: pmRoot } = await init("rl", { defaults: true, author: "codex-agent", agentGuidance: "skip" }, { cwd: project, pmRoot: join(project, ".agents/pm") });
    const client = new PmClient({ cwd: project, pmRoot, author: "codex-agent", noExtensions: true });
    const config = { ...baseline, initial_recipe: recipeArtifact({ ...baseline.initial_recipe.knobs, prefix: { hashing_width: width, ngram_order: 2, regularisation: 0.001 } }),
      adapter: { ...baseline.adapter, allowance: { ...baseline.adapter.allowance, storage_bytes: width === 32 ? 4096 : 1_048_576 } } };
    const resources = Object.fromEntries(Object.entries(config.adapter.allowance).map(([key, value]) => [key, value * 20]));
    const approval = (await client.create({ id: "approval", type: "Decision", title: "Fixed compute and explicit checkpoint storage benchmark", body: '```json\n' + JSON.stringify({ permitted_promotions: 20, resource_budget: resources, meta_budget: { training_samples: 20_480, proposal_calls: 4, recipe_promotions: 2 } }) + '\n```' })).item.id;
    const started = performance.now();
    const report = await runRlMeta(client, { pmRoot, author: "codex-agent" }, { id: "capacity", config, dataset, approval, proposer: "seeded" });
    const resumed = await runRlMeta(client, { pmRoot, author: "codex-agent" }, { id: "capacity", config, dataset, approval, proposer: "seeded" });
    assert.deepEqual(resumed, report);
    const jobs = await listProcessJobs(client);
    const summary: unknown = JSON.parse(JSON.stringify(report, (key, value: unknown) => key === "weights" ? undefined : value));
    runs.push({ hashing_width: width, configuration: config, elapsed_ms_including_replay: performance.now() - started, summary,
      checkpoints: jobs.map((job) => ({ job: job.id, state: job.state, artifact: job.completion!.artifact!, storage_charge_bytes: job.charge.storage_bytes, ...measureCheckpointLoads(pmRoot, job.completion!.artifact!) })) });
  }
  return { format: "pm-rl/checkpoint-capacity-benchmark/1", dataset: manifest, runs };
}

/** Execute only on explicit invocation; raw source examples stay in the supplied scratch directory. */
export async function checkpointBenchmarkMain(argv = process.argv, moduleUrl = import.meta.url, config = liveMetaConfiguration()): Promise<void> {
  if (!isMainInvocation(argv, moduleUrl)) return;
  const evidence = await benchmarkCheckpointCorpus(argv[2], argv[3], config);
  writeFileSync(argv[4], JSON.stringify(evidence, null, 2) + "\n");
}
await checkpointBenchmarkMain();
