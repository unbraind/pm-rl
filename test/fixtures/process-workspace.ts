/** Synthetic real trackers and bounded process programmes shared by the execution drills. */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after } from "node:test";
import { PmClient } from "@unbrained/pm-cli/sdk/core";
import { init } from "@unbrained/pm-cli/sdk/runtime";
import type { JsonValue } from "../../index.ts";
import { banditProcessInput, parseLoopConfig, runLoopGeneration } from "../../loop.ts";
import { banditCheckpoint } from "../../bandit.ts";
import { type Resources } from "../../process.ts";
const roots: string[] = [];
after(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });
export const allowance: Resources = { training_steps: 1, wall_ms: 5000, storage_bytes: 65536, compute_units: 1000, tokens: 0 };
export const configuration = { ...JSON.parse(readFileSync(new URL("../../examples/loop-bandit.json", import.meta.url), "utf8")) as Record<string, JsonValue>, max_generations: 2, adapter: { kind: "process-bandit", allowance: { ...allowance } } };
/** Initialize a real isolated tracker and its explicit, independently bounded resource approval. */
export async function processWorkspace(budget: Resources = { training_steps: 2, wall_ms: 10000, storage_bytes: 131072, compute_units: 2000, tokens: 0 }) {
  const root = mkdtempSync(join(tmpdir(), "rl-process-")); roots.push(root);
  const { path: pmRoot } = await init("rl", { defaults: true, agentGuidance: "skip", author: "process-test" }, { cwd: root, pmRoot: join(root, ".agents/pm") });
  const client = new PmClient({ pmRoot, cwd: root, author: "process-test", noExtensions: true });
  const { item } = await client.create({ id: "approval", type: "Decision", title: "Synthetic resource approval", body: `\`\`\`json\n${JSON.stringify({ permitted_promotions: 2, resource_budget: budget })}\n\`\`\`` });
  return { root, pmRoot, client, approval: item.id, coordinates: { pmRoot, author: "process-test" } };
}
/** Build one request from real source-policy actions while keeping held-out examples out of the trainer. */
export function trainingInput() {
  const config = parseLoopConfig(configuration);
  const step = { learningRate: config.learningRate, evaluationSamples: config.evaluationSamples };
  const collected = runLoopGeneration(config, step, 1, banditCheckpoint(config.initialWeight), banditCheckpoint(config.initialWeight));
  return banditProcessInput(config, step, 1, collected);
}
