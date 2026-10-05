/** Shared deterministic routing configuration for HTTP adapter acceptance. */
import type { JsonValue } from "../../index.ts";

/** A fully bounded synthetic PM-routing programme. */
export function configValue(baseURL = "http://127.0.0.1:1"): Record<string, JsonValue> {
  return {
    trainer: "systemone", environment: { name: "PM routing", version: "1" },
    questions: { kind: { type: "choice", instructions: "Choose Bug or Feature", criteria: { Bug: "Repair broken behavior", Feature: "Add new behavior" } } },
    decision_model: { base_url: baseURL, model: "tev1:4b", timeout_ms: 10000 },
    training: [{ id: "train-bug", title: "Fix export crash", description: "Repair a crash.", labels: { kind: "Bug" } }, { id: "train-feature", title: "Add CSV export", description: "Add export support.", labels: { kind: "Feature" } }],
    evaluation: [{ id: "eval-bug", title: "Fix broken search", description: "Repair search.", labels: { kind: "Bug" } }, { id: "eval-feature", title: "Add PDF export", description: "Add a format.", labels: { kind: "Feature" } }],
    seed: 42, max_generations: 2, samples_per_generation: 2, budget: 8,
    learning_rate: 0.5, fit_steps: 2, minimum_improvement: 0.001, maximum_gap: 0.2,
    evaluation_samples: 40000, confidence: 0.95, min_samples: 10,
  };
}

