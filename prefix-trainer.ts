import { statePath, operationIdentifier } from "./state-boundary.ts";
import { parseBoundedJson } from "./tracker-record.ts";
/** Packaged history-prefix trainer using the existing stdin, NDJSON and durable disk contract. */

import type { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { fitPrefix, type PrefixCheckpoint } from "./prefix.ts";
import { writeTrainerArtifact, writeTrainerCompletion } from "./process-bandit.ts";
import type { ProcessInput, ProcessCompletion } from "./process.ts";
import { isMainInvocation } from "./scripts/script-launcher.ts";
import { encodeCheckpointArtifacts, type CheckpointArtifact } from "./checkpoint-artifacts.ts";

/** Resolve the trusted packaged trainer for both source and installed JavaScript execution. */
export function prefixTrainerArgv(moduleUrl = import.meta.url): readonly string[] {
  return [process.execPath, fileURLToPath(new URL(`./prefix-trainer.${moduleUrl.endsWith(".ts") ? "ts" : "js"}`, moduleUrl))];
}
/** Run one fit, measuring actual work and publishing exclusive fsynced artifacts before completion. */
export async function runPrefixTrainer(stdin: Readable, stdout: Writable, directory: string): Promise<void> {
  let text = "";
  for await (const chunk of stdin) text += String(chunk);
  const { job: rawJob, input, artifactRoot = directory } = parseBoundedJson(text) as { job: string; input: ProcessInput<PrefixCheckpoint>; artifactRoot?: string };
  const job = operationIdentifier(rawJob);
  const format = job === rawJob ? "pm-rl/process-completion/1" as const : "pm-rl/process-completion/2" as const;
  const start = performance.now(); const cpu = process.cpuUsage();
  const policy = fitPrefix(input.prefix!, input.source, input.training_config.learning_rate);
  const artifact = await encodeCheckpointArtifacts(artifactRoot, `job:${job}:staged`, policy) as CheckpointArtifact;
  writeTrainerArtifact(statePath(directory, "checkpoint.json"), artifact);
  const consumed = process.cpuUsage(cpu);
  const completion: ProcessCompletion<{ readonly digest: string }> = {
    format, job, checkpoint: "checkpoint.json", digest: artifact.digest, artifact,
    policy: { digest: policy.digest }, source_policy: input.source.digest, training_config: input.training_config, lineage: input.lineage,
    usage: { training_steps: 1, wall_ms: Math.ceil(performance.now() - start), storage_bytes: Buffer.byteLength(JSON.stringify(policy)), compute_units: Math.ceil((consumed.user + consumed.system) / 1000), tokens: 0 },
  };
  writeTrainerCompletion(directory, completion, stdout, 4096);
}
/** Dispatch the same IO implementation for direct and external-process acceptance. */
export async function prefixTrainerMain(argv = process.argv, moduleUrl = import.meta.url, stdin: Readable = process.stdin, stdout: Writable = process.stdout, directory = "."): Promise<void> {
  if (isMainInvocation(argv, moduleUrl, true)) await runPrefixTrainer(stdin, stdout, directory);
}
await prefixTrainerMain();
