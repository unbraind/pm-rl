import { statePath, checkedStateFile, identifier } from "./state-boundary.ts";
import { parseBoundedJson } from "./tracker-record.ts";
/** Real external TypeScript trainer: stdin request, stdout NDJSON, durable staged checkpoint and receipt. */
import type { Readable, Writable } from "node:stream";
import { dirname } from "node:path";
import { closeSync, fsyncSync, openSync, writeFileSync } from "node:fs";
import { fitBanditBatch } from "./bandit.ts";
import type { ProcessCompletion, ProcessInput } from "./process.ts";
import { createHash } from "node:crypto";
import { isMainInvocation } from "./scripts/script-launcher.ts";

/** Publish exclusive, fsynced files before emitting completion; never overwrite a prior checkpoint. */
export function writeTrainerArtifact(name: string, value: unknown): void {
  const handle = openSync(checkedStateFile(name), "wx");
  try { writeFileSync(handle, JSON.stringify(value)); fsyncSync(handle); } finally { closeSync(handle); }
  const directory = openSync(dirname(name), "r");
  try { fsyncSync(directory); } finally { closeSync(directory); }
}
/** Train on the actual collected actions and rewards, retaining measured resources and full lineage. */
export async function runReferenceTrainer(stdin: Readable = process.stdin, stdout: Writable = process.stdout, directory = "."): Promise<void> {
  let text = "";
  for await (const chunk of stdin) text += String(chunk);
  const { job: rawJob, input } = parseBoundedJson(text) as { job: string; input: ProcessInput };
  const job = identifier(rawJob);
  const start = performance.now();
  const cpu = process.cpuUsage();
  stdout.write(`${JSON.stringify({ type: "progress", job, usage: { training_steps: 0, wall_ms: 0, storage_bytes: 0, compute_units: 0, tokens: 0 } })}\n`);
  const policy = fitBanditBatch(input.training, input.source, input.observations, input.training_config.learning_rate, input.training_config.steps);
  writeTrainerArtifact(statePath(directory, "checkpoint.json"), policy);
  const cpuUse = process.cpuUsage(cpu);
  const completion: ProcessCompletion = { format: "pm-rl/process-completion/1", job, checkpoint: "checkpoint.json", digest: `sha256:${createHash("sha256").update(JSON.stringify(policy)).digest("hex")}`, policy,
    training_config: input.training_config, source_policy: input.source.digest, lineage: input.lineage,
    usage: { training_steps: input.training_config.steps, wall_ms: Math.ceil(performance.now() - start), storage_bytes: Buffer.byteLength(JSON.stringify(policy)), compute_units: Math.ceil((cpuUse.user + cpuUse.system) / 1000), tokens: 0 } };
  writeTrainerArtifact(statePath(directory, "completion.json"), completion);
  stdout.write(`${JSON.stringify({ type: "complete", job, receipt: completion })}\n`);
}

/** Dispatch the packaged entry point while allowing the same real IO contract to be exercised under coverage. */
export async function referenceTrainerMain(argv = process.argv, moduleUrl = import.meta.url, stdin: Readable = process.stdin, stdout: Writable = process.stdout, directory = "."): Promise<void> {
  if (isMainInvocation(argv, moduleUrl, true)) await runReferenceTrainer(stdin, stdout, directory);
}

await referenceTrainerMain();
