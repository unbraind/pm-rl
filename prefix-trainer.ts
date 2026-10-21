/** Packaged history-prefix trainer using the existing stdin, NDJSON and durable disk contract. */
import { join } from "node:path";
import type { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { fitPrefix, type PrefixCheckpoint } from "./prefix.ts";
import { writeTrainerArtifact } from "./process-bandit.ts";
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
  const { job, input, artifactRoot = directory } = JSON.parse(text) as { job: string; input: ProcessInput<PrefixCheckpoint>; artifactRoot?: string };
  const start = performance.now(); const cpu = process.cpuUsage();
  const policy = fitPrefix(input.prefix!, input.source, input.training_config.learning_rate);
  const artifact = await encodeCheckpointArtifacts(artifactRoot, `job:${job}:staged`, policy) as CheckpointArtifact;
  writeTrainerArtifact(join(directory, "checkpoint.json"), artifact);
  const consumed = process.cpuUsage(cpu);
  const completion: ProcessCompletion<{ readonly digest: string }> = {
    format: "pm-rl/process-completion/1", job, checkpoint: "checkpoint.json", digest: artifact.digest, artifact,
    policy: { digest: policy.digest }, source_policy: input.source.digest, training_config: input.training_config, lineage: input.lineage,
    usage: { training_steps: 1, wall_ms: Math.ceil(performance.now() - start), storage_bytes: Buffer.byteLength(JSON.stringify(policy)), compute_units: Math.ceil((consumed.user + consumed.system) / 1000), tokens: 0 },
  };
  writeTrainerArtifact(join(directory, "completion.json"), completion);
  stdout.write(`${JSON.stringify({ type: "complete", job, receipt: completion })}\n`);
}
/** Dispatch the same IO implementation for direct and external-process acceptance. */
export async function prefixTrainerMain(argv = process.argv, moduleUrl = import.meta.url, stdin: Readable = process.stdin, stdout: Writable = process.stdout, directory = "."): Promise<void> {
  if (isMainInvocation(argv, moduleUrl)) await runPrefixTrainer(stdin, stdout, directory);
}
await prefixTrainerMain();
