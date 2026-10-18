/** Content-addressed search recipes; bounds are part of the artifact and cannot expand during search. */
import assert from "node:assert/strict";
import { validatePrefixKnobs, PREFIX_BOUNDS, type PrefixKnobs } from "./prefix.ts";
import { hashJson, type JsonValue } from "./index.ts";

/** Numeric and categorical domains supported by the bounded tracker trainer. */
export const RECIPE_BOUNDS = {
  learning_rate: [0.01, 1], steps: [1, 2], batch: [16, 256],
  temperature: [0.5, 2], correct_weight: [0.5, 1], incorrect_weight: [0, 0.25],
  selection: ["all", "balanced"], curriculum: ["forward", "reverse"],
} as const;

/** All tunable inputs to one inner programme, separate from immutable evaluation criteria. */
export interface RecipeKnobs {
  readonly learning_rate: number;
  readonly steps: number;
  readonly batch: number;
  readonly temperature: number;
  readonly correct_weight: number;
  readonly incorrect_weight: number;
  readonly selection: "all" | "balanced";
  readonly curriculum: "forward" | "reverse";
  readonly prefix?: PrefixKnobs;
}

/** Versioned recipe identity binds every knob and its declared search domain. */
export interface Recipe {
  readonly format: "pm-rl/recipe/1";
  readonly bounds: typeof RECIPE_BOUNDS;
  readonly knobs: RecipeKnobs;
  readonly digest: string;
}

/** Validate and canonically address a recipe without trusting a supplied digest. */
export function recipeArtifact(knobs: RecipeKnobs): Recipe {
  assert.deepEqual(Object.keys(knobs).filter((key) => key !== "prefix").sort(), Object.keys(RECIPE_BOUNDS).sort(), "recipe_knobs");
  for (const key of ["learning_rate", "steps", "batch", "temperature", "correct_weight", "incorrect_weight"] as const) {
    const value = knobs[key];
    const [low, high] = RECIPE_BOUNDS[key];
    assert.ok(Number.isFinite(value) && value >= low && value <= high, `recipe_bound: ${key}`);
  }
  assert.ok(Number.isInteger(knobs.steps) && Number.isInteger(knobs.batch), "recipe_integer");
  assert.ok(RECIPE_BOUNDS.selection.includes(knobs.selection) && RECIPE_BOUNDS.curriculum.includes(knobs.curriculum), "recipe_category");
  if (knobs.prefix !== undefined) validatePrefixKnobs(knobs.prefix);
  const record = { ...(knobs.prefix === undefined ? {} : { prefix_bounds: PREFIX_BOUNDS }), format: "pm-rl/recipe/1" as const, bounds: RECIPE_BOUNDS, knobs: { ...knobs } };
  return { ...record, digest: `sha256:${hashJson(record as unknown as JsonValue)}` };
}

/** Reject altered domains, versions, unknown fields and mismatched content identities. */
export function parseRecipe(value: unknown): Recipe {
  const record = value as Recipe;
  assert.ok(record !== null && typeof record === "object", "recipe_record");
  const recipe = recipeArtifact(record.knobs);
  assert.equal(hashJson(value as JsonValue), hashJson(recipe as unknown as JsonValue), "recipe_identity");
  return recipe;
}

/** Initial programme recipe: deliberately modest fits, exact reward, and no rebalancing. */
export const INITIAL_RECIPE = recipeArtifact({ learning_rate: 0.25, steps: 2, batch: 128, temperature: 1,
  correct_weight: 1, incorrect_weight: 0, selection: "all", curriculum: "forward" });

/** Propose bounded successors deterministically from the seed, generation and incumbent identity. */
export function seededRecipes(incumbent: Recipe, seed: number, generation: number, count: number): Recipe[] {
  assert.ok(Number.isInteger(count) && count >= 1 && count <= 8, "recipe_candidate_count");
  let state = Number.parseInt(hashJson({ seed, generation, incumbent: incumbent.digest }).slice(7, 15), 16);
  /** Advance an unsigned LCG whose domain is independent of collection and evaluation. */
  const draw = (): number => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 0x100000000; };
  return Array.from({ length: count }, () => recipeArtifact({
    learning_rate: 0.01 + draw() * 0.99, steps: 1 + Math.floor(draw() * 2), batch: 16 + Math.floor(draw() * 241),
    temperature: 0.5 + draw() * 1.5, correct_weight: 0.5 + draw() * 0.5, incorrect_weight: draw() * 0.25,
    ...(incumbent.knobs.prefix === undefined ? {} : { prefix: { regularisation: draw() * 0.1, ngram_order: 1 + Math.floor(draw() * 3), hashing_width: [16, 32, 64][Math.floor(draw() * 3)] } }),
    selection: draw() < 0.5 ? "all" : "balanced", curriculum: draw() < 0.5 ? "forward" : "reverse",
  }));
}
