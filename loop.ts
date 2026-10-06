/**
 * @module pm-rl/loop
 *
 * The persisted recursive self-improvement loop's pure core: bounded
 * configuration parsing, the deterministic generation step over the built-in
 * contextual bandit, and the derivation of each successor generation's
 * training and evaluation configuration from the previous generation's
 * evaluation results.
 *
 * The functions here validate, compute, and build records without touching a
 * pm tracker; the command handler in {@link ./index.ts} owns persistence, so
 * every branch of the fail-closed bounds and every derivation rule is testable
 * without standing up a workspace. The numerical kernel is
 * {@link ./bandit.ts}'s {@link executeBanditStep}: one implementation serves
 * the in-process programme and the persisted controller, so the loop cannot
 * drift from the adapter it certifies.
 *
 * Hard bounds are the contract: the loop may run at most
 * {@link MAX_LOOP_GENERATIONS} generations, collect at most
 * {@link MAX_LOOP_BUDGET} samples in total, and promote nothing without a
 * strictly better held-out evaluation (`minimum_improvement` must be positive,
 * and the Hoeffding gate consumes the evidence), so a regression, a widening
 * proxy/held-out gap, an unchanged checkpoint, an exhausted budget, or a
 * statistically insufficient improvement all terminate it with a distinct
 * recorded reason.
 */

import { createHash } from "node:crypto";

import { EXIT_CODE } from "@unbrained/pm-cli/sdk/runtime";

import { banditCheckpoint, executeBanditStep, validatedBanditDatasets, type BanditCheckpoint, type BanditExample, type BanditGeneration } from "./bandit.ts";
import { hoeffdingEpsilon } from "./promotion.ts";
import { asJsonObject, expectedFail, requiredTrimmedString, storedCheckpointNumber, storedCheckpointDigest, verifyReplayFields, verifyTrainerReceipt } from "./refuse.ts";
import { canonicalJson, type EnvironmentSpec, type JsonValue } from "./index.ts";
import { parseLmLoopConfig, type LmLoopConfig } from "./lm.ts";
import { parseSystemOneLoopConfig, type SystemOneLoopConfig } from "./systemone.ts";
import type { MetricEvent } from "./series.ts";

/** Format identity of a candidate generation's derived training configuration. */
const LOOP_GENERATION_FORMAT = "pm-rl/loop-generation/1";

/** Format identity of the seed generation's programme configuration. */
const LOOP_SEED_FORMAT = "pm-rl/loop-seed/1";

/** Reward bounds every built-in bandit environment declares: actions pay in [0, 1]. */
const BANDIT_REWARD_BOUNDS: readonly [number, number] = [0, 1];

/** Maximum generations one bounded loop may attempt. */
export const MAX_LOOP_GENERATIONS = 100;

/** Maximum collected samples one bounded loop may consume in total. */
export const MAX_LOOP_BUDGET = 100_000;

/** Lower bound of the derived learning-rate schedule. */
export const MIN_LOOP_LEARNING_RATE = 0.01;

/** Upper bound of the derived held-out evaluation episode count. */
export const MAX_LOOP_EVALUATION_SAMPLES = 100_000;

/** Measured improvement at or above this multiple of the effect threshold counts as strong progress. */
const STRONG_IMPROVEMENT_FACTOR = 2;

/** A complete bounded loop configuration with validated datasets and identities. */
export interface LoopConfig {
  /** Human-readable environment family name for the registered environment. */
  readonly environmentName: string;
  /** Environment version; changed content must change this value. */
  readonly environmentVersion: string;
  /** Validated collection examples; only sampled rewards train the policy. */
  readonly training: readonly BanditExample[];
  /** Validated held-out examples, disjoint from training and never a gradient source. */
  readonly evaluation: readonly BanditExample[];
  /** Content identity of the ordered collection examples. */
  readonly trainingDigest: string;
  /** Content identity of the ordered held-out examples. */
  readonly evaluationDigest: string;
  /** Content identity of the whole loop programme: environment, datasets, and every bound. */
  readonly digest: string;
  /** Starting scalar policy weight, bounded to [-20, 20]. */
  readonly initialWeight: number;
  /** Unsigned 32-bit base seed for per-generation collection streams. */
  readonly seed: number;
  /** Maximum generations, from 1 to {@link MAX_LOOP_GENERATIONS}. */
  readonly maxGenerations: number;
  /** Samples each generation collects. */
  readonly samplesPerGeneration: number;
  /** Total samples the whole loop may collect before stopping. */
  readonly budget: number;
  /** Initial gradient-ascent learning rate, in [{@link MIN_LOOP_LEARNING_RATE}, 1]. */
  readonly learningRate: number;
  /** Strictly positive minimum held-out improvement every promotion must clear. */
  readonly minimumImprovement: number;
  /** Maximum positive training-to-evaluation expected reward gap. */
  readonly maximumGap: number;
  /** Held-out evaluation episodes sampled per generation for the promotion gate. */
  readonly evaluationSamples: number;
  /** Confidence level 1-alpha for the gate's Hoeffding bound, in (0, 1). */
  readonly confidence: number;
  /** Minimum sample count the promotion gate requires from each side. */
  readonly minSamples: number;
}

/** One generation's training and evaluation configuration, derived from the previous evaluation results. */
export interface LoopStepConfig {
  /** This generation's gradient-ascent learning rate. */
  readonly learningRate: number;
  /** Held-out evaluation episodes this generation samples for the gate. */
  readonly evaluationSamples: number;
}

/** Hash a typed, explicitly ordered loop artifact without timestamps or paths. */
function loopDigest(value: JsonValue): string {
  return `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
}

/** Read one required example array field from a parsed loop configuration record. */
function requiredExamples(record: Readonly<Record<string, unknown>>, key: "training" | "evaluation"): readonly BanditExample[] {
  const value = record[key];
  if (!Array.isArray(value)) {
    expectedFail(`Loop configuration ${key} must be an array of examples.`, `loop_invalid_${key}`);
  }
  return value as readonly BanditExample[];
}

/** Read one required finite number from a parsed loop configuration record. */
function requiredNumber(record: Readonly<Record<string, unknown>>, key: string, source: string, code: string): number {
  const value = record[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    expectedFail(`${source} requires a finite number ${key}.`, code);
  }
  return value;
}

/**
 * Parse and validate one bounded loop configuration.
 *
 * Every bound is checked here so the controller never starts collection on a
 * configuration that could run unbounded: generations and the total sample
 * budget are capped, the learning rate is bounded away from zero and one, and
 * `minimum_improvement` must be strictly positive, which is the requirement
 * that no promotion can happen without a strictly better held-out evaluation.
 * Datasets are validated by the bandit adapter's own
 * {@link validatedBanditDatasets}, so the loop and the numerical kernel agree
 * on what a valid example is.
 *
 * @param raw - The parsed JSON configuration document.
 * @returns The validated configuration with dataset and programme identities.
 * @throws An expected CLI error naming the first missing, mistyped, or out-of-bounds field.
 */
export function parseLoopConfig(raw: JsonValue): LoopConfig {
  const record = asJsonObject(raw, "Loop configuration", "loop_invalid_json");
  const environment = asJsonObject(record["environment"] ?? null, "Loop configuration environment", "loop_invalid_environment");
  const environmentName = requiredTrimmedString(environment, "name", "Loop configuration environment", "loop_environment_");
  const environmentVersion = requiredTrimmedString(environment, "version", "Loop configuration environment", "loop_environment_");
  let datasets;
  try {
    datasets = validatedBanditDatasets({ training: requiredExamples(record, "training"), evaluation: requiredExamples(record, "evaluation") });
  } catch (error) {
    expectedFail(`Loop configuration datasets are invalid: ${String(error)}`, "loop_invalid_datasets");
  }
  const source = "Loop configuration";
  const initialWeight = requiredNumber(record, "initial_weight", source, "loop_invalid_initial_weight");
  const seed = requiredNumber(record, "seed", source, "loop_invalid_seed");
  const maxGenerations = requiredNumber(record, "max_generations", source, "loop_invalid_max_generations");
  const samplesPerGeneration = requiredNumber(record, "samples_per_generation", source, "loop_invalid_samples_per_generation");
  const budget = requiredNumber(record, "budget", source, "loop_invalid_budget");
  const learningRate = requiredNumber(record, "learning_rate", source, "loop_invalid_learning_rate");
  const minimumImprovement = requiredNumber(record, "minimum_improvement", source, "loop_invalid_minimum_improvement");
  const maximumGap = requiredNumber(record, "maximum_gap", source, "loop_invalid_maximum_gap");
  const evaluationSamples = requiredNumber(record, "evaluation_samples", source, "loop_invalid_evaluation_samples");
  const confidence = requiredNumber(record, "confidence", source, "loop_invalid_confidence");
  const minSamples = requiredNumber(record, "min_samples", source, "loop_invalid_min_samples");
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffff_ffff) {
    expectedFail(`${source} seed must be an unsigned 32-bit integer.`, "loop_invalid_seed");
  }
  if (!Number.isInteger(maxGenerations) || maxGenerations < 1 || maxGenerations > MAX_LOOP_GENERATIONS) {
    expectedFail(`${source} max_generations must be an integer from 1 to ${MAX_LOOP_GENERATIONS}.`, "loop_invalid_max_generations");
  }
  if (!Number.isInteger(samplesPerGeneration) || samplesPerGeneration < 1) {
    expectedFail(`${source} samples_per_generation must be a positive integer.`, "loop_invalid_samples_per_generation");
  }
  if (!Number.isInteger(budget) || budget < samplesPerGeneration || budget > MAX_LOOP_BUDGET) {
    expectedFail(`${source} budget must be an integer from samples_per_generation (${samplesPerGeneration}) to ${MAX_LOOP_BUDGET}.`, "loop_invalid_budget");
  }
  if (!Number.isFinite(initialWeight) || Math.abs(initialWeight) > 20) {
    expectedFail(`${source} initial_weight must be finite and within [-20, 20].`, "loop_invalid_initial_weight");
  }
  if (!Number.isFinite(learningRate) || learningRate < MIN_LOOP_LEARNING_RATE || learningRate > 1) {
    expectedFail(`${source} learning_rate must be in [${MIN_LOOP_LEARNING_RATE}, 1].`, "loop_invalid_learning_rate");
  }
  // Strictly positive: this is the "no promotion without a strictly better
  // held-out evaluation" bound. A zero threshold would let an unimproved
  // candidate through wherever the sampled means tie.
  if (!Number.isFinite(minimumImprovement) || minimumImprovement <= 0) {
    expectedFail(`${source} minimum_improvement must be strictly positive.`, "loop_invalid_minimum_improvement");
  }
  if (!Number.isFinite(maximumGap) || maximumGap < 0) {
    expectedFail(`${source} maximum_gap must be finite and non-negative.`, "loop_invalid_maximum_gap");
  }
  if (!Number.isInteger(evaluationSamples) || evaluationSamples < 1 || evaluationSamples > MAX_LOOP_EVALUATION_SAMPLES) {
    expectedFail(`${source} evaluation_samples must be an integer from 1 to ${MAX_LOOP_EVALUATION_SAMPLES}.`, "loop_invalid_evaluation_samples");
  }
  if (!Number.isFinite(confidence) || confidence <= 0 || confidence >= 1) {
    expectedFail(`${source} confidence must be in (0, 1).`, "loop_invalid_confidence");
  }
  if (!Number.isInteger(minSamples) || minSamples < 1) {
    expectedFail(`${source} min_samples must be a positive integer.`, "loop_invalid_min_samples");
  }
  const config: LoopConfig = {
    environmentName,
    environmentVersion,
    training: datasets.training,
    evaluation: datasets.evaluation,
    trainingDigest: datasets.trainingDigest,
    evaluationDigest: datasets.evaluationDigest,
    digest: loopDigest({
      format: "pm-rl/loop-programme/1",
      environment: { name: environmentName, version: environmentVersion },
      trainingDigest: datasets.trainingDigest,
      evaluationDigest: datasets.evaluationDigest,
      initialWeight,
      seed,
      maxGenerations,
      samplesPerGeneration,
      budget,
      learningRate,
      minimumImprovement,
      maximumGap,
      evaluationSamples,
      confidence,
      minSamples,
    }),
    initialWeight,
    seed,
    maxGenerations,
    samplesPerGeneration,
    budget,
    learningRate,
    minimumImprovement,
    maximumGap,
    evaluationSamples,
    confidence,
    minSamples,
  };
  return config;
}

/** Render one validated example as the plain JSON value the environment spec stores. */
function jsonExample(example: BanditExample): JsonValue {
  return { id: example.id, feature: example.feature, rewards: [example.rewards[0], example.rewards[1]] };
}

/**
 * Build the content-addressed environment the loop registers and every run and generation references.
 *
 * The environment is the loop's world, not a dashboard entry: its task suite
 * carries both disjoint datasets verbatim and its reward specification pins
 * the bounded action-reward contract, so the environment item's content hash
 * is the identity every collection run's provenance records.
 *
 * @param config - The validated loop configuration.
 * @returns The environment specification to register.
 */
export function loopEnvironmentSpec(config: LoopConfig): EnvironmentSpec {
  return {
    name: config.environmentName,
    version: config.environmentVersion,
    task_suite: { collection: config.training.map(jsonExample), held_out: config.evaluation.map(jsonExample) },
    reward_specification: {
      format: "pm-rl/bandit-reward/1",
      reward_bounds: [BANDIT_REWARD_BOUNDS[0], BANDIT_REWARD_BOUNDS[1]],
      held_out_isolated_from_collection: true,
    },
  };
}

/**
 * Derive one generation's action-sampling seed from the loop's base seed.
 *
 * All streams start from base + imul(generation, 0x9e3779b1), modulo 2^32.
 * Collection adds 0x85ebca6b; incumbent held-out evaluation adds zero;
 * candidate held-out evaluation adds 0x6d5b5b5d. These distinct salts prevent
 * collection and either held-out stream from reusing the same LCG draws.
 *
 * @param base - The loop's unsigned 32-bit base seed.
 * @param generation - The one-based generation number.
 * @returns The generation's collection seed.
 */
export function stepSeed(base: number, generation: number): number {
  return (Math.imul(generation, 0x9e3779b1) + base + 0x85ebca6b) >>> 0;
}

/** The promotion bounds both loop trainers share, so one schedule derivation serves both. */
export interface LoopScheduleBounds {
  /** Strictly positive minimum held-out improvement every promotion must clear. */
  readonly minimumImprovement: number;
  /** Confidence level 1-alpha for the gate's Hoeffding bound, in (0, 1). */
  readonly confidence: number;
}

/**
 * Derive the next generation's training and evaluation configuration from the measured evaluation results.
 *
 * This is the recursion's self-improvement step: the previous generation's
 * held-out improvement decides both knobs. Weak progress (below twice the
 * effect threshold) halves the learning rate, floored at
 * {@link MIN_LOOP_LEARNING_RATE}, because bigger steps are not buying
 * measured progress. A positive improvement smaller than the Hoeffding width
 * at the current episode count doubles the next evaluation budget, capped at
 * {@link MAX_LOOP_EVALUATION_SAMPLES}, because the gate could not resolve a
 * difference that small and more evidence is the only honest way to try.
 *
 * @param config - The validated loop configuration.
 * @param step - The configuration the measured generation ran under.
 * @param improvement - The candidate's held-out mean minus the incumbent's.
 * @returns The successor generation's configuration.
 */
export function deriveNextStepConfig(config: LoopScheduleBounds, step: LoopStepConfig, improvement: number): LoopStepConfig {
  const learningRate = improvement >= STRONG_IMPROVEMENT_FACTOR * config.minimumImprovement
    ? step.learningRate
    : Math.max(step.learningRate / 2, MIN_LOOP_LEARNING_RATE);
  const width = hoeffdingEpsilon(step.evaluationSamples, BANDIT_REWARD_BOUNDS[1] - BANDIT_REWARD_BOUNDS[0], 1 - config.confidence);
  const evaluationSamples = improvement > 0 && improvement < width
    ? Math.min(step.evaluationSamples * 2, MAX_LOOP_EVALUATION_SAMPLES)
    : step.evaluationSamples;
  return { learningRate, evaluationSamples };
}

/**
 * Execute one bounded generation step over the built-in bandit environment.
 *
 * Collects `samplesPerGeneration` on-policy samples from the source checkpoint
 * under the generation's derived seed, applies the REINFORCE update, samples
 * the held-out evidence, and renders the promotion gate's verdict — exactly
 * the kernel the in-process programme runs, on the caller's derived
 * configuration.
 *
 * @param config - The validated loop configuration.
 * @param step - This generation's derived configuration.
 * @param generation - The one-based generation number.
 * @param source - The promoted checkpoint whose policy collects this batch.
 * @returns The generation's complete receipt, including its terminal condition.
 */
export function runLoopGeneration(config: LoopConfig, step: LoopStepConfig, generation: number, source: BanditCheckpoint): BanditGeneration {
  return executeBanditStep({
    training: config.training,
    evaluation: config.evaluation,
    trainingDigest: config.trainingDigest,
    evaluationDigest: config.evaluationDigest,
    source,
    generation,
    seed: config.seed,
    randomState: stepSeed(config.seed, generation),
    samples: config.samplesPerGeneration,
    learningRate: step.learningRate,
    minimumImprovement: config.minimumImprovement,
    maximumGap: config.maximumGap,
    evaluationSamples: step.evaluationSamples,
    confidence: config.confidence,
    minSamples: config.minSamples,
  });
}

/**
 * Render one generation's collected observations as ordered metric events.
 *
 * One event per collected sample, with the example and action in the tags, so
 * a run's merge-safe note history carries the actual collection work, not a
 * summary of it. Steps are the sample's index within the batch.
 *
 * @param receipt - The generation's receipt from {@link runLoopGeneration}.
 * @returns One metric event per collected sample, in collection order.
 */
export function collectionMetricEvents(receipt: BanditGeneration): MetricEvent[] {
  return receipt.observations.map((observation, index): MetricEvent => ({
    step: index,
    metric: "collection_reward",
    value: observation.reward,
    tags: { example: observation.example, action: String(observation.action) },
  }));
}

/**
 * Build the promotion score records for one gate-promoted generation.
 *
 * The proxy score is the candidate's exact expected reward over the collection
 * examples; the held-out score is the sampled mean the gate actually bounded.
 * Both carry content-addressed seed-set identities and the dataset digest they
 * were measured on, so the persisted promotion's contamination walk can verify
 * the held-out context is unreachable from the training data.
 *
 * @param config - The validated loop configuration.
 * @param step - The configuration the promoted generation ran under.
 * @param generation - The one-based generation number.
 * @param receipt - The promoted generation's receipt.
 * @returns Score records ready for the persisted promotion's parser.
 */
export function loopPromotionScores(config: LoopConfig, step: LoopStepConfig, generation: number, receipt: BanditGeneration): { readonly proxy_score: JsonValue; readonly held_out_score: JsonValue } {
  return {
    proxy_score: {
      objective: "expected_reward",
      objective_version: "pm-rl/bandit/1",
      evaluation_context: config.trainingDigest,
      seed_set: loopDigest({ format: "pm-rl/loop-collection-seed/1", seed: stepSeed(config.seed, generation), samples: config.samplesPerGeneration }),
      direction: "maximize",
      scale: 1,
      value: receipt.trainingScore,
    },
    held_out_score: {
      objective: "expected_reward",
      objective_version: "pm-rl/bandit/1",
      evaluation_context: config.evaluationDigest,
      seed_set: loopDigest({ format: "pm-rl/loop-held-out-seed/1", generation, seed: config.seed, samples: step.evaluationSamples }),
      direction: "maximize",
      scale: 1,
      value: receipt.candidateHeldOutMean,
    },
  };
}

/**
 * Build the training configuration recorded on one candidate generation item.
 *
 * Everything the generation's provenance needs to be replayed: the derived
 * learning rate and evaluation budget, the generation's collection seed, the
 * collected batch's content identity, both checkpoints with the actual
 * candidate weight, and the evaluation numbers the next generation's
 * configuration is derived from.
 *
 * @param config - The validated loop configuration.
 * @param step - The configuration this generation ran under.
 * @param generation - The one-based generation number.
 * @param receipt - The generation's receipt.
 * @returns The training configuration to store in the generation's body.
 */
export function generationTrainingConfig(config: LoopConfig, step: LoopStepConfig, generation: number, receipt: BanditGeneration): JsonValue {
  return {
    format: LOOP_GENERATION_FORMAT,
    generation,
    learning_rate: step.learningRate,
    evaluation_samples: step.evaluationSamples,
    collection_seed: stepSeed(config.seed, generation),
    samples: config.samplesPerGeneration,
    collection_digest: receipt.collectionDigest,
    action_counts: [receipt.actionCounts[0], receipt.actionCounts[1]],
    source_checkpoint: receipt.source.digest,
    candidate_checkpoint: receipt.candidate.digest,
    candidate_weight: receipt.candidate.weight,
    training_score: receipt.trainingScore,
    evaluation_score: receipt.evaluationScore,
    incumbent_held_out_mean: receipt.incumbentHeldOutMean,
    candidate_held_out_mean: receipt.candidateHeldOutMean,
  };
}

/**
 * Build the seed generation's training configuration.
 *
 * The seed records the programme identity and the initial weight it starts
 * from, so the whole loop is reconstructable from the seed item alone.
 *
 * @param config - The validated loop configuration.
 * @returns The training configuration to store in the seed generation's body.
 */
export function seedTrainingConfig(config: LoopConfig): JsonValue {
  return {
    format: LOOP_SEED_FORMAT,
    programme: config.digest,
    initial_weight: config.initialWeight,
    configuration: {
      environment: { name: config.environmentName, version: config.environmentVersion },
      training: config.training.map(jsonExample),
      evaluation: config.evaluation.map(jsonExample),
      initial_weight: config.initialWeight,
      seed: config.seed,
      max_generations: config.maxGenerations,
      samples_per_generation: config.samplesPerGeneration,
      budget: config.budget,
      learning_rate: config.learningRate,
      minimum_improvement: config.minimumImprovement,
      maximum_gap: config.maximumGap,
      evaluation_samples: config.evaluationSamples,
      confidence: config.confidence,
      min_samples: config.minSamples,
    },
  };
}


/** The trainer adapters a bounded loop programme may select. */
export const LOOP_TRAINER_VALUES = ["bandit", "systemone", "lm"] as const;

/** One validated trainer name for a loop configuration. */
export type LoopTrainer = (typeof LOOP_TRAINER_VALUES)[number];

/** The validated trainer programme a loop executes: one adapter plus its configuration. */
export type LoopProgramme =
  | { readonly trainer: "bandit"; readonly config: LoopConfig }
  | { readonly trainer: "systemone"; readonly config: SystemOneLoopConfig }
  | { readonly trainer: "lm"; readonly config: LmLoopConfig };

/**
 * Read the trainer selector of a loop configuration.
 *
 * The selector is optional and defaults to the built-in bandit, so every
 * existing loop configuration keeps executing exactly as before; only the
 * literal `systemone` selects the decision-model adapter and the literal `lm`
 * selects the causal language-model adapter. Any other value is refused
 * rather than guessed, because silently running the wrong trainer would charge
 * a different budget and produce different checkpoints under the same loop
 * identity.
 *
 * @param raw - The parsed loop configuration document.
 * @returns The validated trainer name.
 * @throws An expected CLI error naming the unsupported trainer value.
 */
export function parseLoopTrainer(raw: JsonValue): LoopTrainer {
  const record = asJsonObject(raw, "Loop configuration", "loop_invalid_json");
  const trainer = record["trainer"] ?? "bandit";
  if (trainer !== "bandit" && trainer !== "systemone" && trainer !== "lm") {
    expectedFail(`Loop configuration trainer must be one of ${LOOP_TRAINER_VALUES.join(", ")}.`, "loop_invalid_trainer");
  }
  return trainer;
}

/**
 * Parse and validate one bounded loop programme, dispatching on its trainer.
 *
 * One entry point serves the command handler, the typed SDK surface, and the
 * resume path, so all three agree on what a valid programme is. Each adapter's
 * own parser validates its datasets and bounds; this function only selects
 * which one runs.
 *
 * @param raw - The parsed loop configuration document.
 * @returns The validated trainer programme.
 * @throws An expected CLI error naming the first invalid field of the selected trainer.
 */
export function parseLoopProgramme(raw: JsonValue): LoopProgramme {
  const trainer = parseLoopTrainer(raw);
  if (trainer === "systemone") {
    return { trainer, config: parseSystemOneLoopConfig(raw) };
  }
  if (trainer === "lm") {
    return { trainer, config: parseLmLoopConfig(raw) };
  }
  return { trainer, config: parseLoopConfig(raw) };
}

/**
 * The persisted training configuration of one completed bandit generation.
 *
 * This is the resume contract: everything {@link generationTrainingConfig}
 * wrote, read back and re-validated, so a controller that never saw the
 * original process can verify the persisted generation against the
 * deterministic replay before advancing the chain.
 */
export interface StoredLoopGeneration {
  /** One-based generation number, matching the recomputed receipt. */
  readonly generation: number;
  /** The derived learning rate this generation ran under. */
  readonly learningRate: number;
  /** The held-out evaluation episode count this generation sampled. */
  readonly evaluationSamples: number;
  /** The generation's collection seed. */
  readonly collectionSeed: number;
  /** Collected samples this generation persisted. */
  readonly samples: number;
  /** Content identity of the complete ordered observed batch. */
  readonly collectionDigest: string;
  /** Counts of sampled actions zero and one. */
  readonly actionCounts: readonly [number, number];
  /** Content-addressed identity of the collecting policy. */
  readonly sourceCheckpoint: string;
  /** Content-addressed identity of the candidate policy. */
  readonly candidateCheckpoint: string;
  /** The candidate's actual scalar weight. */
  readonly candidateWeight: number;
  /** Expected reward under the candidate on the collection examples. */
  readonly trainingScore: number;
  /** Expected reward under the candidate on the held-out examples. */
  readonly evaluationScore: number;
  /** The incumbent's sampled held-out mean this generation was judged against. */
  readonly incumbentHeldOutMean: number;
  /** The candidate's sampled held-out mean the gate bounded. */
  readonly candidateHeldOutMean: number;
}

/**
 * Parse and validate one persisted bandit generation training configuration.
 *
 * Every field the resume walk advances the chain from is checked for shape and
 * finiteness here, so a tampered or corrupted checkpoint - a NaN weight, a
 * truncated digest, a misshapen action count - is refused as an invalid
 * checkpoint before it can become the next generation's collecting policy.
 *
 * @param value - The training configuration JSON read from the generation item.
 * @param source - Human-readable origin for error messages.
 * @returns The validated stored generation.
 * @throws An expected CLI error with a stable invalid-checkpoint code.
 */
export function parseStoredLoopGeneration(value: JsonValue, source: string): StoredLoopGeneration {
  const record = asJsonObject(value, source, "loop_invalid_training_config");
  if (record["format"] !== LOOP_GENERATION_FORMAT) {
    expectedFail(`${source} must carry the ${LOOP_GENERATION_FORMAT} format marker.`, "loop_invalid_training_config");
  }
  const generation = storedCheckpointNumber(record, "generation", source, "loop_invalid_training_config");
  const actionCounts = record["action_counts"];
  if (!Array.isArray(actionCounts) || actionCounts.length !== 2
    || typeof actionCounts[0] !== "number" || typeof actionCounts[1] !== "number"
    || !Number.isInteger(actionCounts[0]) || !Number.isInteger(actionCounts[1]) || actionCounts[0] < 0 || actionCounts[1] < 0) {
    expectedFail(`${source} requires integer action_counts for both actions; the persisted checkpoint is invalid.`, "loop_invalid_checkpoint");
  }
  if (!Number.isInteger(generation) || generation < 1) {
    expectedFail(`${source} requires a positive integer generation.`, "loop_invalid_training_config");
  }
  const candidateWeight = storedCheckpointNumber(record, "candidate_weight", source, "loop_invalid_checkpoint");
  if (Math.abs(candidateWeight) > 20) {
    expectedFail(`${source} candidate_weight is outside the stable policy bound [-20, 20]; the persisted checkpoint is invalid.`, "loop_invalid_checkpoint");
  }
  const stored: StoredLoopGeneration = {
    generation,
    learningRate: storedCheckpointNumber(record, "learning_rate", source, "loop_invalid_training_config"),
    evaluationSamples: storedCheckpointNumber(record, "evaluation_samples", source, "loop_invalid_training_config"),
    collectionSeed: storedCheckpointNumber(record, "collection_seed", source, "loop_invalid_training_config"),
    samples: storedCheckpointNumber(record, "samples", source, "loop_invalid_training_config"),
    collectionDigest: storedCheckpointDigest(record, "collection_digest", source, "loop_invalid_checkpoint"),
    actionCounts: [actionCounts[0], actionCounts[1]],
    sourceCheckpoint: storedCheckpointDigest(record, "source_checkpoint", source, "loop_invalid_checkpoint"),
    candidateCheckpoint: storedCheckpointDigest(record, "candidate_checkpoint", source, "loop_invalid_checkpoint"),
    candidateWeight,
    trainingScore: storedCheckpointNumber(record, "training_score", source, "loop_invalid_training_config"),
    evaluationScore: storedCheckpointNumber(record, "evaluation_score", source, "loop_invalid_training_config"),
    incumbentHeldOutMean: storedCheckpointNumber(record, "incumbent_held_out_mean", source, "loop_invalid_training_config"),
    candidateHeldOutMean: storedCheckpointNumber(record, "candidate_held_out_mean", source, "loop_invalid_training_config"),
  };
  if (!Number.isInteger(stored.samples) || stored.samples < 1
    || !Number.isInteger(stored.evaluationSamples) || stored.evaluationSamples < 1
    || !Number.isInteger(stored.collectionSeed) || stored.collectionSeed < 0) {
    expectedFail(`${source} requires positive integer sample bounds.`, "loop_invalid_training_config");
  }
  return stored;
}

/**
 * Replay one bandit generation and verify it against its persisted configuration.
 *
 * The bandit step is a pure function of the programme, the derived step
 * configuration, the generation number, and the source checkpoint, so a resume
 * replays it exactly and compares field-for-field against what the original
 * process persisted. Any disagreement - a tampered weight, a mismatched
 * digest, an edited score - is a drift refusal naming both sides, because
 * advancing from evidence that does not reproduce would let a rewritten
 * history steer the loop.
 *
 * @param config - The validated bandit loop configuration.
 * @param step - The derived step configuration this generation ran under.
 * @param generation - The one-based generation number.
 * @param source - The checkpoint whose policy collected this batch.
 * @param stored - The persisted training configuration to verify against.
 * @returns The replayed generation receipt, proven identical to the persisted one.
 * @throws An expected CLI drift refusal when the replay and the persisted record disagree.
 */
export function verifyStoredLoopGeneration(config: LoopConfig, step: LoopStepConfig, generation: number, source: BanditCheckpoint, stored: StoredLoopGeneration): BanditGeneration {
  const receipt = runLoopGeneration(config, step, generation, source);
  // The candidate digest is recomputed from the persisted weight before any
  // other comparison, so a tampered hash - a digest naming a checkpoint the
  // stored parameters cannot produce - is refused as an invalid checkpoint
  // rather than generic drift.
  if (stored.candidateCheckpoint !== banditCheckpoint(stored.candidateWeight).digest) {
    expectedFail(`Loop generation ${generation} records candidate checkpoint ${stored.candidateCheckpoint}, which does not match the digest of its own persisted weight; the persisted checkpoint is invalid.`, "loop_invalid_checkpoint", EXIT_CODE.CONFLICT);
  }
  const expected: Array<[string, unknown, unknown]> = [
    ["generation", stored.generation, generation],
    ["learning_rate", stored.learningRate, step.learningRate],
    ["evaluation_samples", stored.evaluationSamples, step.evaluationSamples],
    ["collection_seed", stored.collectionSeed, stepSeed(config.seed, generation)],
    ["samples", stored.samples, config.samplesPerGeneration],
    ["collection_digest", stored.collectionDigest, receipt.collectionDigest],
    ["action_counts", stored.actionCounts.join(","), receipt.actionCounts.join(",")],
    ["candidate_weight", stored.candidateWeight, receipt.candidate.weight],
  ];
  verifyReplayFields(expected, generation);
  verifyTrainerReceipt(stored, receipt, generation);
  return receipt;
}
