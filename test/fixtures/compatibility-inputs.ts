/** Raw inputs shared with the published-package oracle; no output normalization is implemented here. */
import type { EvaluationPlan } from "../../evaluation-plan.ts";

/** Legacy text domains intentionally include values unsuitable for filesystem components. */
export const LEGACY_LABELS = ["case 1", "session:1", " leading and trailing ", "é", "e\u0301", ".", "..", "/absolute", "a/b", "a\\b", "C:\\drive", "%2e%2e", "line\nwrap", "tab\tlabel", "nul\0label", "x".repeat(1000)];

/** Generate deterministic raw schema inputs, including padding formerly normalized by the released readers. */
export function compatibilityInputs(index: number) {
  const label = LEGACY_LABELS[(Math.imul(index + 1, 1664525) >>> 0) % LEGACY_LABELS.length];
  const members = Array.from({ length: 16 }, (_, slot) => ({ id: `${label}-${slot}`, unit: `session:${index}-${slot}` }));
  const plan: EvaluationPlan = { format: "pm-rl/evaluation-plan/1", candidate: "rl-candidate", incumbent: "rl-seed", incumbent_version: "version", population: "Frozen legacy population", selection: "all", correlation_unit: "session", members, objective: "reward", objective_version: "v1", evaluation_context: `evaluation ${index}: ${label}`, direction: "maximize", reward_bounds: [0, 1], criterion: { confidence: 0.95, minSamples: 2, effectThreshold: 0 }, stopping: { kind: "fixed", observations: 16, independent_units: 16 } };
  // The 1000-character cohort case stays below the released 1024-character context domain too.
  const score = { objective: "reward", objective_version: "v1", evaluation_context: ` ${label} `, direction: "maximize", seed_set: "seed", scale: 1, value: 1 };
  const generation = { base_checkpoint: `checkpoint ${label}`, policy: `policy:${label}`, collection_runs: [` ${label} `], training_config: {}, environment_version: ` ${label} `, reward_spec_version: "v1", parent: ` ${label} `, seed: false, promoted: false, approval: null, proxy_score: null, held_out_score: null, gap: null, promotion_evidence: null };
  const sweep = { algorithm: "algorithm:1", environment_id: " rl-training ", environment_spec_hash: "spec", search_space: { rate: [1] }, selection_rule: { kind: "none" }, arms: [{ id: ` ${label} `, config: { rate: 1 } }] };
  const evaluation = { checkpoint: `checkpoint ${label}`, run_id: " rl-run ", benchmark_id: " rl-benchmark ", environment_id: " rl-training ", environment_spec_hash: " spec ", reward_spec_hash: " reward ", score: 1, passed: true };
  const benchmark = { name: "Legacy benchmark", version: "1", task_suite: [], scoring_function: "score", pass_criteria: "all", direction: "maximize", contaminated_environments: [" rl-training "] };
  const transfer = { source_environment_id: " rl-training ", target_environment_id: " rl-deploy ", checkpoint: `checkpoint ${label}`, run_id: ` ${label} `, gaps: [{ metric: " reward ", gap: 0 }] };
  return { transfer, plan, rows: members.map((member) => ({ id: member.id, candidate: 1, incumbent: 0 })), score, generation, sweep, evaluation, benchmark, example: { id: ` ${label} ` } };
}
