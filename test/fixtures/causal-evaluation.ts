/** Shared real SDK setup for causal lifecycle integration and native process probes. */
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mock } from "node:test";
import { PmClient } from "@unbrained/pm-cli/sdk/core";
import { init } from "@unbrained/pm-cli/sdk/runtime";
import { createExtensionTestHarness } from "@unbrained/pm-cli/sdk/testing";
import extension, { registerGenerationCore, startRunCore, type RlCommandResult } from "../../index.ts";
import { approveEvaluationPlan } from "../../evaluation-lifecycle.ts";
import { evaluationComparison, registerEvaluationPlan, type EvaluationPlan } from "../../evaluation-plan.ts";
import { recordSequentialEvaluation } from "../../sequential-evaluation.ts";

/** Create a standalone tracker and real registered environment, seed and bounded sequential plan. */
export async function causalWorkspace() {
  const root = mkdtempSync(join(tmpdir(), "rl-causal-"));
  const { path: pmRoot } = await init("rl", { defaults: true, author: "lifecycle-test", agentGuidance: "skip" }, { cwd: root, pmRoot: join(root, ".agents/pm") });
  const client = new PmClient({ cwd: root, pmRoot, author: "lifecycle-test", noExtensions: true });
  const harness = await createExtensionTestHarness(extension, { name: "pm-rl", capabilities: ["commands", "hooks", "schema"] });
  const file = join(root, "environment.json");
  writeFileSync(file, JSON.stringify({ name: "causal-training", version: "1", task_suite: { name: "training", version: "1" }, observation_space: { type: "vector" }, action_space: { type: "discrete" }, reward_specification: { objective: "return", version: "1" }, seed_policy: { kind: "fixed", seeds: [1] } }));
  const environment = (await harness.runCommand({ command: "rl env register", pmRoot, options: { file } })).result as RlCommandResult;
  const seed = await registerGenerationCore(client, { id: "rl-seed", baseCheckpoint: "seed", parent: null, environment: undefined, policy: "", collectionRuns: [], config: {} });
  const members = Array.from({ length: 64 }, (_, i) => ({ id: `member-${i}`, unit: `unit-${i}` }));
  const plan: EvaluationPlan = { ordering: "causal/1", format: "pm-rl/evaluation-plan/1", candidate: "rl-candidate", incumbent: seed.id!, incumbent_version: String(seed.details!.spec_hash), population: "Public tracker test population", selection: "all", correlation_unit: "unit", members, objective: "return", objective_version: "1", evaluation_context: "held-out", direction: "maximize", reward_bounds: [0, 1], criterion: { confidence: 0.95, minSamples: 8, effectThreshold: 0 }, stopping: { kind: "sequential", method: "hoeffding-alpha-spending/1", observations: 64, independent_units: 64, unit_order: members.map(m => m.unit), looks: [16, 64], review: "rl-review" } };
  const request = { id: "rl-collection", environmentId: environment.id!, algorithm: "policy", config: {}, receipt: null, evaluationCandidate: plan.candidate };
  const generation = { id: plan.candidate, baseCheckpoint: "candidate", parent: plan.incumbent, policy: "policy", collectionRuns: [request.id], environment: environment.id!, config: {} };
  const rows = plan.members.map((m, i) => ({ id: m.id, candidate: i < 16 ? 0 : 1, incumbent: 0 }));
  return { root, pmRoot, client, harness, plan, request, generation, rows, comparison: evaluationComparison(plan) };
}
/** Execute one real durable step, shared by skew, concurrency and crash scenarios. */
export async function causalStep(w: Pick<Awaited<ReturnType<typeof causalWorkspace>>, "client" | "plan" | "request" | "generation" | "rows">, step: string): Promise<unknown> {
  if (step === "review") return approveEvaluationPlan(w.client, w.plan);
  if (step === "plan") return registerEvaluationPlan(w.client, w.plan);
  if (step === "run") return startRunCore(w.client, w.request);
  if (step === "candidate") return registerGenerationCore(w.client, w.generation);
  return recordSequentialEvaluation(w.client, w.plan.candidate, step === "first" ? w.rows.slice(0, 16) : w.rows);
}

/** Drive every SDK entry point with the same real-process clock and restore it after the operation. */
export async function withCausalClock<T>(clock: string, operation: () => Promise<T>): Promise<T> {
  mock.timers.enable({ apis: ["Date"], now: Date.parse(clock) });
  try { return await operation(); } finally { mock.timers.reset(); }
}
