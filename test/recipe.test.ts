/** Recipe domains, identities, deterministic search and inner lineage are behavioural contracts. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { INITIAL_RECIPE, RECIPE_BOUNDS, parseRecipe, recipeArtifact, seededRecipes } from "../recipe.ts";
import { parseLoopConfig, generationTrainingConfig, seedTrainingConfig, runLoopGeneration, parseStoredLoopGeneration, verifyStoredLoopGeneration } from "../loop.ts";
import { banditCheckpoint } from "../bandit.ts";
import { configuration } from "./fixtures/process-workspace.ts";
import type { JsonValue } from "../index.ts";

test("recipes bind every declared knob and refuse malformed domains or identities", () => {
  assert.deepEqual(parseRecipe(INITIAL_RECIPE), INITIAL_RECIPE);
  assert.match(INITIAL_RECIPE.digest, /^sha256:[a-f0-9]{64}$/);
  assert.throws(() => parseRecipe(null), /recipe_record/);
  assert.throws(() => parseRecipe({ ...INITIAL_RECIPE, format: "2" }), /recipe_identity/);
  assert.throws(() => parseRecipe({ ...INITIAL_RECIPE, bounds: {} }), /recipe_identity/);
  assert.throws(() => parseRecipe({ ...INITIAL_RECIPE, unknown: true }), /recipe_identity/);
  assert.throws(() => recipeArtifact({ ...INITIAL_RECIPE.knobs, unknown: true } as typeof INITIAL_RECIPE.knobs), /recipe_knobs/);
  for (const key of ["learning_rate", "steps", "batch", "temperature", "correct_weight", "incorrect_weight"] as const) {
    for (const value of [NaN, RECIPE_BOUNDS[key][0] - 1, RECIPE_BOUNDS[key][1] + 1]) assert.throws(() => recipeArtifact({ ...INITIAL_RECIPE.knobs, [key]: value }), /recipe_bound/);
  }
  assert.throws(() => recipeArtifact({ ...INITIAL_RECIPE.knobs, steps: 1.1 }), /recipe_integer/);
  assert.throws(() => recipeArtifact({ ...INITIAL_RECIPE.knobs, batch: 16.1 }), /recipe_integer/);
  assert.throws(() => recipeArtifact({ ...INITIAL_RECIPE.knobs, selection: "bad" as "all" }), /recipe_category/);
  assert.throws(() => recipeArtifact({ ...INITIAL_RECIPE.knobs, curriculum: "bad" as "forward" }), /recipe_category/);
});

test("seeded proposals replay exactly, stay bounded and vary all training decisions", () => {
  const first = seededRecipes(INITIAL_RECIPE, 42, 1, 8);
  assert.deepEqual(first, seededRecipes(INITIAL_RECIPE, 42, 1, 8));
  assert.notDeepEqual(first, seededRecipes(INITIAL_RECIPE, 42, 2, 8));
  for (const recipe of first) assert.deepEqual(parseRecipe(recipe), recipe);
  assert.equal(new Set(first.map((recipe) => recipe.knobs.selection)).size, 2);
  assert.equal(new Set(first.map((recipe) => recipe.knobs.curriculum)).size, 2);
  for (const count of [0, 9, 1.1]) assert.throws(() => seededRecipes(INITIAL_RECIPE, 42, 1, count));
});

test("each inner programme and generation names its actual recipe, and resume refuses recipe drift", () => {
  const recipe = recipeArtifact({ ...INITIAL_RECIPE.knobs, steps: 2, batch: 128, learning_rate: 0.5 });
  const raw = { ...configuration, learning_rate: 0.5, recipe: recipe as unknown as JsonValue };
  const config = parseLoopConfig(raw);
  const receipt = runLoopGeneration(config, { learningRate: 0.5, evaluationSamples: config.evaluationSamples }, 1, banditCheckpoint(0));
  const serialized = generationTrainingConfig(config, { learningRate: 0.5, evaluationSamples: config.evaluationSamples }, 1, receipt);
  const stored = parseStoredLoopGeneration(serialized, "recipe fixture");
  assert.equal(stored.recipeDigest, recipe.digest);
  assert.equal((seedTrainingConfig(config) as Record<string, JsonValue>).recipe, recipe.digest);
  assert.deepEqual(verifyStoredLoopGeneration(config, { learningRate: 0.5, evaluationSamples: config.evaluationSamples }, 1, banditCheckpoint(0), stored), receipt);
  assert.throws(() => verifyStoredLoopGeneration(config, { learningRate: 0.5, evaluationSamples: config.evaluationSamples }, 1, banditCheckpoint(0), { ...stored, recipeDigest: INITIAL_RECIPE.digest }), /recipe/);
  for (const override of [{ learning_rate: 0.6 }, { max_generations: 3 }, { samples_per_generation: 64 }]) assert.throws(() => parseLoopConfig({ ...raw, ...override }), /Recipe knobs/);
});
