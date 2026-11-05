/** Trusted process adapter for the sealed interpreter; stdin contains development counts only. */
import type { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { executeProposal, type ProposalExecution } from "./proposer-program.ts";
import { isMainInvocation } from "./scripts/script-launcher.ts";
import type { ProcessInput } from "./process.ts";

/** Packaged source files are readable, but tracker, dataset, credential and arbitrary filesystem reads are denied. */
export function proposerWorkerArgv(directory: string, moduleUrl = import.meta.url): readonly string[] {
  const root = dirname(fileURLToPath(moduleUrl)); const suffix = moduleUrl.endsWith(".ts") ? "ts" : "js";
  const allowed = ["proposer-worker", "proposer-program", "json-identity", "scripts/script-launcher"].map((name) => join(root, `${name}.${suffix}`));
  return [process.execPath, "--permission", "--max-old-space-size=96", ...[...allowed, join(root, "package.json"), join(root, "../package.json"), directory].map((path) => `--allow-fs-read=${path}`), join(root, `proposer-worker.${suffix}`)];
}
/** Emit a bounded completion; the trusted parent verifies it and fsyncs artifacts before publishing success. */
export async function runProposerWorker(stdin: Readable, stdout: Writable, directory: string): Promise<void> {
  let text = "";
  for await (const chunk of stdin) { text += String(chunk); if (Buffer.byteLength(text) > 65_536) throw new Error("proposer_input_limit"); }
  const { job, input } = JSON.parse(text) as { job: string; input: ProcessInput<ProposalExecution> };
  const start = performance.now(); const cpu = process.cpuUsage();
  const policy = executeProposal(input.proposal);
  const content = JSON.stringify(policy); const used = process.cpuUsage(cpu);
  const receipt = { policy,
    usage: { training_steps: 0, wall_ms: Math.ceil(performance.now() - start), storage_bytes: Buffer.byteLength(content), compute_units: Math.ceil((used.user + used.system) / 1000), tokens: 0 } };
  stdout.write(`${JSON.stringify({ type: "complete", job, receipt })}\n`);
}
/** Importable IO entry point permits direct coverage of the shipped worker protocol. */
export async function proposerWorkerMain(argv = process.argv, moduleUrl = import.meta.url, stdin: Readable = process.stdin, stdout: Writable = process.stdout, directory = "."): Promise<void> {
  if (isMainInvocation(argv, moduleUrl, true)) await runProposerWorker(stdin, stdout, directory);
}
await proposerWorkerMain();
