/** Side-effect-free configuration shared by live acceptance and checkpoint benchmarks. */
import type { MetaConfig } from "../meta.ts";
import { INITIAL_RECIPE } from "../recipe.ts";

/** Two meta-generations and two candidates, with every fit covered by the same pre-approved resource Decision. */
export function liveMetaConfiguration(): MetaConfig {
  return { initial_recipe: INITIAL_RECIPE, seed: 42, meta_generations: 2, candidates: 2, timeout_ms: 840_000,
    criterion: { confidence: 0.95, minSamples: 10, effectThreshold: 0.01 }, maximum_gap: 0.3, evaluation_samples: 40_000,
    adapter: { kind: "process-bandit", allowance: { training_steps: 1, wall_ms: 30_000, storage_bytes: 4096, compute_units: 30_000, tokens: 0 } } };
}
