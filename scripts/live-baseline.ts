/** Run three bounded proposals on an explicitly selected public tracker copy without Git or source writes. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { PmClient } from "@unbrained/pm-cli/sdk/core";
import { init } from "@unbrained/pm-cli/sdk/runtime";
import { buildTrackerLoopCorpus } from "../corpus.ts";
import { hashJson, resumeRlLoop, rlLoopStatus, runRlLoop, type JsonValue } from "../index.ts";
import { parseLoopConfig } from "../loop.ts";
import { isMainInvocation } from "./script-launcher.ts";
import { listProcessJobs, processStaging } from "../process.ts";

/** Hash source bytes excluding only SDK runtime/cache directories. */
function inventory(directory: string, prefix = ""): { file: string; digest: string }[] {
  return readdirSync(directory, { withFileTypes: true }).filter((entry) => !["runtime", "search", "locks"].includes(entry.name)).sort((a, b) => a.name.localeCompare(b.name)).flatMap((entry) => {
    const file = join(prefix, entry.name);
    return entry.isDirectory() ? inventory(join(directory, entry.name), file) : [{ file, digest: createHash("sha256").update(readFileSync(join(directory, entry.name))).digest("hex") }];
  });
}
/** Execute the supplied bounds on an isolated controller tracker and retain item-level refusal evidence. */
export async function runBaselineAcceptance(source: string, output: string, bounds: JsonValue): Promise<JsonValue> {
const before = inventory(source);
const corpus = await buildTrackerLoopCorpus(new PmClient({ pmRoot: source, noExtensions: true }), bounds);
mkdirSync(output, { recursive: true });
writeFileSync(join(output, "programme.json"), JSON.stringify(corpus.programme, null, 2), { flag: "wx" });
const { path: pmRoot } = await init("rl", { defaults: true, agentGuidance: "skip", author: "codex-agent" }, { cwd: output, pmRoot: join(output, ".agents/pm") });
const config = parseLoopConfig(corpus.programme);
const client = new PmClient({ pmRoot, author: "codex-agent", noExtensions: true });
const { item: approval } = await client.create({ id: "baseline-approval", type: "Decision", title: "Three bounded public-corpus proposals", body: '```json\n{"permitted_promotions":3,"resource_budget":{"training_steps":768,"wall_ms":90000,"storage_bytes":786432,"compute_units":30000,"tokens":0}}\n```' });
const request = { id: "baseline-frontier", config: corpus.programme, approval: approval.id };
const report = await runRlLoop(client, { pmRoot, author: "codex-agent" }, request);
assert.equal(report.generations.length, config.maxGenerations);
const jobs = await listProcessJobs(client);
assert.equal(jobs.length, config.maxGenerations); assert.ok(jobs.every((job) => job.settled && job.charge.training_steps === config.fitSteps));
const checkpoints = jobs.map((job) => readFileSync(join(processStaging(pmRoot, job.id), "checkpoint.json"), "utf8"));
const resumed = await resumeRlLoop(client, { pmRoot, author: "codex-agent" }, { id: request.id, approval: approval.id });
assert.equal(resumed.resumed_generations, config.maxGenerations); assert.equal(resumed.final_checkpoint, report.final_checkpoint);
assert.deepEqual(jobs.map((job) => readFileSync(join(processStaging(pmRoot, job.id), "checkpoint.json"), "utf8")), checkpoints);
assert.equal((await listProcessJobs(client)).length, config.maxGenerations);
const status = await rlLoopStatus(client, request.id, pmRoot);
assert.equal(status.promoted, report.promoted); assert.equal(status.generations.length, config.maxGenerations);
assert.equal(status.samples_consumed, report.samples_consumed);
assert.deepEqual(inventory(source), before);
const generations = [];
for (const row of report.generations) {
  const item = await client.get(row.item!);
  const fenced = /```json\s*([\s\S]*?)```/.exec(item.item.body!);
  assert.ok(fenced, "Generation JSON evidence required");
  const config = (JSON.parse(fenced[1]) as { training_config: Record<string, JsonValue> }).training_config;
  generations.push({ generation: row.generation, promoted: row.promoted, refusal: row.refusal_reason,
    source_checkpoint: config.source_checkpoint, candidate_checkpoint: config.candidate_checkpoint,
    learning_rate: config.learning_rate, held_out_reward: config.evaluation_score, training_reward: config.training_score,
    item_evidence: config.item_evidence, sampled_reward: row.held_out_mean });
}
const evidence = { format: "pm-rl/baseline-frontier/1", source: { files: before.length, digest: hashJson(before), bytes_unchanged: true },
  corpus: { snapshot: corpus.snapshot, training_items: corpus.training_items, held_out_items: corpus.held_out_items, held_out_closed: corpus.held_out_closed },
  baseline: corpus.held_out_closed / corpus.held_out_items, bounds, generations, promoted: report.promoted,
  final_checkpoint: report.final_checkpoint, samples_consumed: report.samples_consumed,
  charges: jobs.map((job) => ({ job: job.id, charge: job.charge, source_policy: job.completion!.source_policy })), replay: { generations: resumed.resumed_generations, unchanged_checkpoints: true, no_new_jobs: true } };
writeFileSync(join(output, "evidence.json"), JSON.stringify(evidence, null, 2), { flag: "wx" });
return evidence as unknown as JsonValue;
}

/** Dispatch the reproducible public-corpus experiment without executing on import. */
export async function baselineMain(argv = process.argv, moduleUrl = import.meta.url): Promise<void> {
  if (!isMainInvocation(argv, moduleUrl, true)) return;
  const [sourceArgument, outputArgument, boundsArgument] = argv.slice(2);
  assert.ok(sourceArgument && outputArgument && boundsArgument, "Supply a public tracker copy, a fresh output directory and a bounds file");
  const bounds = JSON.parse(readFileSync(boundsArgument, "utf8")) as JsonValue;
  const evidence = await runBaselineAcceptance(resolve(sourceArgument), resolve(outputArgument), bounds);
  process.stdout.write(`${JSON.stringify({ recorded: true, promoted: (evidence as Record<string, JsonValue>).promoted })}\n`);
}
await baselineMain();
