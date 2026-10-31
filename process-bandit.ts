import { statePath, checkedStateFile, operationIdentifier } from "./state-boundary.ts";
import { parseBoundedJson, encodeBoundedJson } from "./tracker-record.ts";
/** Real external TypeScript trainer: stdin request, stdout NDJSON, durable staged checkpoint and receipt. */
import type { Readable, Writable } from "node:stream";
import { dirname } from "node:path";
import { closeSync, fsyncSync, openSync, writeFileSync } from "node:fs";
import { fitBanditBatch } from "./bandit.ts";
import type { ProcessCompletion, ProcessInput } from "./process.ts";
import { createHash } from "node:crypto";
import { isMainInvocation } from "./scripts/script-launcher.ts";

/** Publish exclusive, fsynced files before emitting completion; never overwrite a prior checkpoint. */
export function writeTrainerArtifact(name: string, value: unknown, maximumBytes?: number): void {
  const text = encodeBoundedJson(value, maximumBytes);
  const handle = openSync(checkedStateFile(name), "wx");
  try { writeFileSync(handle, text); fsyncSync(handle); } finally { closeSync(handle); }
  const directory = openSync(dirname(name), "r");
  try { fsyncSync(directory); } finally { closeSync(directory); }
}
/** Train on the actual collected actions and rewards, retaining measured resources and full lineage. */
export async function runReferenceTrainer(stdin: Readable = process.stdin, stdout: Writable = process.stdout, directory = "."): Promise<void> {
  let text = "";
  for await (const chunk of stdin) text += String(chunk);
  const { job: rawJob, input } = parseBoundedJson(text) as { job: string; input: ProcessInput };
  const { job, format, marker } = trainerJobIdentity(rawJob);
  const start = performance.now();
  const cpu = process.cpuUsage();
  stdout.write(`${JSON.stringify({ ...marker, type: "progress", job, usage: { training_steps: 0, wall_ms: 0, storage_bytes: 0, compute_units: 0, tokens: 0 } })}\n`);
  const policy = fitBanditBatch(input.training, input.source, input.observations, input.training_config.learning_rate, input.training_config.steps);
  writeTrainerArtifact(statePath(directory, "checkpoint.json"), policy, 4096);
  const cpuUse = process.cpuUsage(cpu);
  const completion: ProcessCompletion = { format, job, checkpoint: "checkpoint.json", digest: `sha256:${createHash("sha256").update(JSON.stringify(policy)).digest("hex")}`, policy,
    training_config: input.training_config, source_policy: input.source.digest, lineage: input.lineage,
    usage: { training_steps: input.training_config.steps, wall_ms: Math.ceil(performance.now() - start), storage_bytes: Buffer.byteLength(JSON.stringify(policy)), compute_units: Math.ceil((cpuUse.user + cpuUse.system) / 1000), tokens: 0 } };
  writeTrainerCompletion(directory, completion, stdout);
}

/** Dispatch the packaged entry point while allowing the same real IO contract to be exercised under coverage. */
export async function referenceTrainerMain(argv = process.argv, moduleUrl = import.meta.url, stdin: Readable = process.stdin, stdout: Writable = process.stdout, directory = "."): Promise<void> {
  if (isMainInvocation(argv, moduleUrl, true)) await runReferenceTrainer(stdin, stdout, directory);
}

await referenceTrainerMain();


/**
 * The job identity and wire formats a trainer uses for one raw job id. This is the trainer-to-controller contract:
 * a canonical id keeps the version-1 completion format, while a normalized alias id uses version 2 and marks its
 * progress events as trainer-event/2. Every trainer derives them here, so no two trainers can emit different
 * formats for the same job.
 *
 * @param rawJob - The job id exactly as the controller passed it.
 * @returns The normalized job id, its completion format, and the progress-event marker to spread into events.
 */
export function trainerJobIdentity(rawJob: string): { job: string; format: "pm-rl/process-completion/1" | "pm-rl/process-completion/2"; marker: { format?: "pm-rl/trainer-event/2" } } {
  const job = operationIdentifier(rawJob);
  const format = job === rawJob ? "pm-rl/process-completion/1" as const : "pm-rl/process-completion/2" as const;
  return { job, format, marker: format === "pm-rl/process-completion/2" ? { format: "pm-rl/trainer-event/2" as const } : {} };
}
/** Publish the exclusive durable receipt before its matching versioned completion event. @internal */
export function writeTrainerCompletion(directory: string, receipt: ProcessCompletion<{ readonly digest: string }>, stdout: Writable, maximum = 65_536): void {
  writeTrainerArtifact(statePath(directory, "completion.json"), receipt, maximum);
  const marker = receipt.format === "pm-rl/process-completion/2" ? { format: "pm-rl/trainer-event/2" } : {};
  stdout.write(`${JSON.stringify({ ...marker, type: "complete", job: receipt.job, receipt })}\n`);
}
