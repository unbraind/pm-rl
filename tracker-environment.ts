/** Sealed tracker evaluator capabilities: search receives scores and policies, never inner or final examples. */
import assert from "node:assert/strict";
import type { PmClient } from "@unbrained/pm-cli/sdk/core";
import { banditCheckpoint, type BanditExample } from "./bandit.ts";
import { hashJson, readCompleteLoopItem, runRlLoop, type JsonValue } from "./index.ts";
import { readTrackerDataset, readTrackerSplit, trackerFeature, type TrackerDataset, type TrackerExample } from "./dataset.ts";
import { parseStoredLoopGeneration } from "./loop.ts";
import { parseGenerationSpec } from "./lineage.ts";
import type { ProcessCoordinates } from "./process.ts";
import type { Recipe } from "./recipe.ts";
import type { MetaConfig, MetaRequest, MetaReport, RecipePolicy, TrackerScore } from "./meta.ts";

/** The outer search has no dataset coordinate or example-reading method. */
export interface TrackerEnvironment {
  readonly digest: string;
  fit(recipe: Recipe, id: string, signal: AbortSignal): Promise<RecipePolicy>;
  selection(candidate: RecipePolicy, incumbent: RecipePolicy): { score: TrackerScore; baseline: TrackerScore };
  finalTest(initial: RecipePolicy, incumbent: RecipePolicy): MetaReport["final_test"];
}

/** Open evaluator capabilities without loading either held-out compartment; final testing stays lazy until selection ends. */
export function openTrackerEnvironment(client: PmClient, coordinates: ProcessCoordinates, directory: string, config: MetaConfig, approval: string): TrackerEnvironment {
  const manifest = readTrackerDataset(directory);
  return {
    digest: manifest.digest,
    fit: async (recipe, id, signal) => fitRecipe(client, coordinates, { config, dataset: directory, approval }, manifest, recipe, id, signal),
    selection(candidate, incumbent) {
      const examples = readTrackerSplit(directory, manifest, "meta-validation");
      const context = manifest.splits["meta-validation"].digest;
      return { score: scoreTrackerPolicy(examples, candidate, context, config.seed), baseline: scoreTrackerPolicy(examples, incumbent, context, config.seed) };
    },
    finalTest(initial, incumbent) {
      const examples = readTrackerSplit(directory, manifest, "final-test");
      const context = manifest.splits["final-test"].digest;
      return { before: scoreTrackerPolicy(examples, initial, context, config.seed), after: scoreTrackerPolicy(examples, incumbent, context, config.seed) };
    },
  };
}

/** Convert training-only prefixes to a binary exact-match environment, applying only declared recipe knobs. */
export function recipeExamples(examples: readonly TrackerExample[], recipe: Recipe, training: boolean): BanditExample[] {
  let selected = [...examples];
  if (training && recipe.knobs.selection === "balanced") {
    const completed = selected.filter((example) => example.label === "completed");
    const cancelled = selected.filter((example) => example.label === "cancelled");
    const limit = Math.min(completed.length, cancelled.length);
    assert.ok(limit > 0, "meta_balanced_class_missing");
    selected = [...completed.slice(0, limit), ...cancelled.slice(0, limit)];
  }
  if (training && recipe.knobs.curriculum === "reverse") selected.reverse();
  return selected.map((example) => {
    const correct = training ? recipe.knobs.correct_weight : 1;
    const incorrect = training ? recipe.knobs.incorrect_weight : 0;
    return { id: example.id, feature: trackerFeature(example) / recipe.knobs.temperature,
      rewards: example.label === "completed" ? [incorrect, correct] : [correct, incorrect] };
  });
}

/** Sample one action per unique prefix on a stream shared across policies, rewarding only exact class matches. */
export function scoreTrackerPolicy(examples: readonly TrackerExample[], policy: RecipePolicy, context: string, seed: number): TrackerScore {
  let correct = 0;
  for (const example of examples) {
    const draw = Number.parseInt(hashJson({ seed, id: example.id }).slice(7, 15), 16) / 0x100000000;
    const probability = 1 / (1 + Math.exp(-policy.weight * trackerFeature(example) / policy.recipe.knobs.temperature));
    const prediction = draw < probability ? "completed" : "cancelled";
    if (prediction === example.label) correct += 1;
  }
  return { mean: correct / examples.length, samples: examples.length, context };
}

/** Run the inner loop behind a compartment boundary; its held-out examples and scores never return to search. */
async function fitRecipe(client: PmClient, coordinates: ProcessCoordinates, request: Pick<MetaRequest, "config" | "dataset" | "approval">, manifest: TrackerDataset, recipe: Recipe, id: string, signal: AbortSignal): Promise<RecipePolicy> {
  const training = recipeExamples(readTrackerSplit(request.dataset, manifest, "train"), recipe, true);
  const evaluation = recipeExamples(readTrackerSplit(request.dataset, manifest, "inner-held-out"), recipe, false);
  assert.ok(!training.some((example) => new Set(evaluation.map((held) => held.id)).has(example.id)), "meta_inner_overlap");
  const config = request.config;
  const report = await runRlLoop(client, coordinates, { id, approval: request.approval, signal, config: {
    recipe: recipe as unknown as JsonValue, environment: { name: "Public tracker terminal disposition", version: manifest.digest },
    training: training as unknown as JsonValue, evaluation: evaluation as unknown as JsonValue, initial_weight: 0,
    seed: config.seed, max_generations: recipe.knobs.steps, samples_per_generation: recipe.knobs.batch,
    budget: recipe.knobs.steps * recipe.knobs.batch, learning_rate: recipe.knobs.learning_rate,
    minimum_improvement: config.criterion.effectThreshold, maximum_gap: config.maximum_gap,
    evaluation_samples: config.evaluation_samples, confidence: config.criterion.confidence, min_samples: config.criterion.minSamples,
    adapter: config.adapter as unknown as JsonValue,
  } });
  assert.ok(!["process_failed", "process_cancelled", "process_invalidated", "wall_limit_exceeded", "checkpoint_limit_exceeded"].includes(report.stop_reason), "meta_inner_failed");
  let weight = 0;
  const accepted = report.generations.filter((generation) => generation.promoted).at(-1);
  if (accepted !== undefined) {
    const item = await readCompleteLoopItem(client, accepted.item);
    const fence = /```json\n([\s\S]+?)\n```/.exec(String(item.item.body));
    assert.ok(fence !== null, "meta_checkpoint_receipt");
    weight = parseStoredLoopGeneration(parseGenerationSpec(fence[1], "Inner generation").training_config as JsonValue, "Inner generation").candidateWeight;
  }
  assert.equal(banditCheckpoint(weight).digest, report.final_checkpoint, "meta_checkpoint_identity");
  return { recipe, weight, checkpoint: report.final_checkpoint };
}
