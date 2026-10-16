/** Packaged TypeScript LM entrypoint implementing the shared durable process protocol. */
import { createHash } from "node:crypto";
import { closeSync, fsyncSync, openSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Readable, Writable } from "node:stream";
import { trainLmStep, lmTrainingJson, serializeLmCheckpoint } from "./lm.ts";
import { restoreLmProcessInput, lmFitTokens } from "./process-lm.ts";
import type { ProcessCompletion, ProcessInput } from "./process.ts";
import { writeTrainerArtifact } from "./process-bandit.ts";
import { isMainInvocation } from "./scripts/script-launcher.ts";

/** Fit actual collected rewards, fsync the canonical checkpoint and then publish completion. */
export async function runLmTrainer(stdin: Readable = process.stdin, stdout: Writable = process.stdout, directory = "."): Promise<void> {
  let text = "";
  for await (const chunk of stdin) text += String(chunk);
  const { job, input } = JSON.parse(text) as { job: string; input: ProcessInput<{ readonly digest: string }> };
  const start = performance.now(); const cpu = process.cpuUsage();
  const { config, source, payload } = restoreLmProcessInput(input);
  stdout.write(`${JSON.stringify({ type: "progress", job, usage: { training_steps: 0, wall_ms: 0, storage_bytes: 0, compute_units: 0, tokens: 0 } })}\n`);
  const training = trainLmStep(config, payload.step, payload.generation, source, payload.observations, null);
  const checkpoint = serializeLmCheckpoint(training.candidate, config);
  const handle = openSync(join(directory, "checkpoint.json"), "wx");
  try { writeFileSync(handle, checkpoint.text); fsyncSync(handle); } finally { closeSync(handle); }
  const consumed = process.cpuUsage(cpu);
  const completion: ProcessCompletion<{ readonly digest: string }> = {
    format: "pm-rl/process-completion/1", job, checkpoint: "checkpoint.json",
    digest: `sha256:${createHash("sha256").update(checkpoint.text).digest("hex")}`, policy: { digest: training.candidate.digest },
    source_policy: input.source.digest, training_config: input.training_config, lineage: input.lineage, training: lmTrainingJson(training),
    peak_memory_bytes: process.resourceUsage().maxRSS * 1024,
    usage: { training_steps: config.fitSteps, wall_ms: Math.ceil(performance.now() - start), storage_bytes: checkpoint.bytes,
      compute_units: Math.ceil((consumed.user + consumed.system) / 1000), tokens: lmFitTokens(payload) },
  };
  writeTrainerArtifact(join(directory, "completion.json"), completion);
  stdout.write(`${JSON.stringify({ type: "complete", job, receipt: completion })}\n`);
}

/** Dispatch the same trainer through a real process or direct IO under coverage. */
export async function lmTrainerMain(argv = process.argv, moduleUrl = import.meta.url, stdin: Readable = process.stdin, stdout: Writable = process.stdout, directory = "."): Promise<void> {
  if (isMainInvocation(argv, moduleUrl)) await runLmTrainer(stdin, stdout, directory);
}

await lmTrainerMain();
