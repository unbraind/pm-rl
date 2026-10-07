/**
 * @module pm-rl/systemone
 *
 * A real, bounded decision-model trainer for the persisted recursive loop.
 *
 * The policy is a per-question calibration head — one temperature and one bias
 * per answer option, a small number of real scalar parameters — fitted over a
 * FROZEN System One decision model served at a TypeSafe-compatible
 * `POST {baseURL}/v1/systemone` endpoint. The frozen model answers questions
 * about pm items (for example routing an item to its type); the head learns a
 * temperature-and-bias rescaling of the model's answer probabilities from a
 * labelled collection batch by real gradient descent on the cross-entropy, so
 * a fitted checkpoint is content-addressed over parameters that actually
 * moved. The environment labels synthetic pm items whose true outcomes are
 * known, collection and held-out example identities are disjoint, and the
 * promotion gate bounds SAMPLED held-out evidence, so a lucky rollout cannot
 * promote a regression.
 *
 * Every endpoint interaction is a plain `fetch` against the configured base
 * URL — no new runtime dependency — and every collected or held-out decision
 * is persisted as one merge-safe metric event, so a crashed controller
 * resumes by appending only the missing queries rather than re-spending the
 * endpoint budget.
 */

import { createHash } from "node:crypto";

import { EXIT_CODE } from "@unbrained/pm-cli/sdk/runtime";

import { canonicalJson, hashJson, type EnvironmentSpec, type JsonValue } from "./index.ts";
import { trainerSampleSeed, trainerEvaluationSeeds as evaluationSeeds, type LoopStepConfig } from "./loop.ts";
import { decideTrainerPromotion } from "./promotion.ts";
import { asJsonObject, expectedFail, requiredTrimmedString, storedCheckpointNumber, storedCheckpointDigest, verifyReplayFields, verifyTrainerReceipt, verifyTrainerConfiguration } from "./refuse.ts";
import type { MetricEvent } from "./series.ts";

/** Format identity of one calibration head checkpoint. */
const SYSTEMONE_CHECKPOINT_FORMAT = "pm-rl/systemone-checkpoint/1";

/** Format identity of a candidate generation's derived training configuration. */
export const SYSTEMONE_GENERATION_FORMAT = "pm-rl/systemone-generation/1";

/** Format identity of the seed generation's programme configuration. */
export const SYSTEMONE_SEED_FORMAT = "pm-rl/systemone-seed/1";

/** Format identity of a collection run's pre-collection configuration. */
export const SYSTEMONE_RUN_FORMAT = "pm-rl/systemone-run/1";

/** Format identity of the whole decision-model loop programme. */
const SYSTEMONE_PROGRAMME_FORMAT = "pm-rl/systemone-programme/1";

/** Format identity of the environment's reward contract. */
const SYSTEMONE_REWARD_FORMAT = "pm-rl/systemone-reward/1";

/** Metric name of one persisted collected decision query. */
export const SYSTEMONE_COLLECTION_METRIC = "systemone_decision";

/** Metric name of one persisted held-out decision query. */
export const SYSTEMONE_HELD_OUT_METRIC = "systemone_held_out_decision";

/** Maximum examples one decision-model dataset may carry. */
export const MAX_SYSTEMONE_EXAMPLES = 10_000;

/** Maximum gradient steps one head fit may take. */
export const MAX_SYSTEMONE_FIT_STEPS = 10_000;

/** Bound on the stored log temperature: exp(+-10) spans four orders of magnitude. */
export const MAX_SYSTEMONE_LOG_TEMPERATURE = 10;

/** Bound on any stored option bias. */
export const MAX_SYSTEMONE_BIAS = 50;

/** Floor applied to raw answer probabilities before the logit transform. */
const PROBABILITY_FLOOR = 1e-12;

/** Question kind this adapter calibrates; the frozen model must answer choices. */
const CHOICE_QUESTION_TYPE = "choice";

/** Reward bounds the decision-model environment declares: correctness pays in [0, 1]. */
const SYSTEMONE_REWARD_BOUNDS: readonly [number, number] = [0, 1];

/** LCG multiplier shared with the bandit adapter, so both streams behave alike. */
const LCG_MULTIPLIER = 1_664_525;

/** LCG increment shared with the bandit adapter. */
const LCG_INCREMENT = 1_013_904_223;

/** One choice question the frozen decision model is asked about every item. */
export interface SystemOneChoiceSpec {
  /** Stable question name; also the key of the item's true answer. */
  readonly name: string;
  /** Instructions rendered into the decision request. */
  readonly instructions: string;
  /** Answer options mapped to their descriptions, or null for none. */
  readonly criteria: Readonly<Record<string, string | null>>;
}

/** One labelled pm item: a decision request with known true answers. */
export interface SystemOneExample {
  /** Dataset-local identity, disjoint across collection and held-out sets. */
  readonly id: string;
  /** Item title rendered into the decision request state. */
  readonly title: string;
  /** Item description rendered into the decision request state. */
  readonly description: string;
  /** True answer per question name. */
  readonly labels: Readonly<Record<string, string>>;
}

/** The frozen decision model's endpoint coordinates. */
export interface SystemOneEndpointSpec {
  /** Base URL the TypeSafe-compatible endpoint is served at. */
  readonly baseURL: string;
  /** Model name passed in every decision request. */
  readonly model: string;
  /** Per-request timeout in milliseconds. */
  readonly timeoutMs: number;
  /** Opt in to durable immutable endpoint receipts; omission retains the legacy protocol. */
  readonly receiptProtocol?: "idempotency-v1";
}

/** Per-question calibration parameters: one temperature and per-option biases. */
export interface SystemOneHeadParameters {
  /** Natural log of the per-question temperature; zero is the identity head. */
  readonly logTemperature: Readonly<Record<string, number>>;
  /** Per-question, per-option additive bias on the answer logit. */
  readonly biases: Readonly<Record<string, Readonly<Record<string, number>>>>;
}

/** A reproducible calibration-head checkpoint whose digest binds the real parameters. */
export interface SystemOneCheckpoint {
  /** The head's actual parameters; changed by the fit's gradient steps. */
  readonly parameters: SystemOneHeadParameters;
  /** SHA-256 of the versioned, canonically serialized checkpoint. */
  readonly digest: string;
}

/** One collected decision: the raw answer probabilities and the sampling reward. */
export interface SystemOneObservation {
  /** Dataset-local identity of the example this decision drew. */
  readonly example: string;
  /** Raw answer probabilities per question and option, exactly as the model answered. */
  readonly answers: Readonly<Record<string, Readonly<Record<string, number>>>>;
  /** Mean correctness of the collecting policy's sampled answers across questions. */
  readonly reward: number;
}

/** The terminal condition one decision-model generation ended a loop with. */
export type SystemOneStopReason = "unchanged_checkpoint" | "evaluation_rejected" | "gap_rejected";

/** Evidence retained for one collected decision batch and attempted head fit. */
export interface SystemOneGeneration {
  /** One-based attempted generation number. */
  readonly generation: number;
  /** Exact checkpoint whose head collected and evaluated this batch. */
  readonly source: SystemOneCheckpoint;
  /** Actual checkpoint obtained from the batch's gradient fit. */
  readonly candidate: SystemOneCheckpoint;
  /** Identity of the complete ordered collected batch and its source checkpoint. */
  readonly collectionDigest: string;
  /** The complete ordered batch of collected decisions. */
  readonly observations: readonly SystemOneObservation[];
  /** Mean cross-entropy of the source head over the collected batch, before the fit. */
  readonly lossBefore: number;
  /** Mean cross-entropy of the fitted head over the collected batch, after the fit. */
  readonly lossAfter: number;
  /** Expected reward under the source head on the held-out decisions. */
  readonly baselineScore: number;
  /** Expected reward under the candidate on the collected decisions. */
  readonly trainingScore: number;
  /** Expected reward under the candidate on the held-out decisions. */
  readonly evaluationScore: number;
  /** Whether this candidate became the next generation's collecting policy. */
  readonly promoted: boolean;
  /** Empirical mean reward of the incumbent on the sampled held-out episodes. */
  readonly incumbentHeldOutMean: number;
  /** Empirical mean reward of the candidate on the sampled held-out episodes. */
  readonly candidateHeldOutMean: number;
  /** The promotion gate's verdict reason; null when promoted. */
  readonly refusalReason: string | null;
  /** The condition this generation terminated the loop with; null when it promoted. */
  readonly stopReason: SystemOneStopReason | null;
  /** Decision-model tokens the endpoint reported for this generation's queries. */
  readonly usageTokens: number;
}

/** A complete validated decision-model loop programme. */
export interface SystemOneLoopConfig {
  /** Human-readable environment family name for the registered environment. */
  readonly environmentName: string;
  /** Environment version; changed content must change this value. */
  readonly environmentVersion: string;
  /** Ordered choice questions asked about every item. */
  readonly questions: readonly SystemOneChoiceSpec[];
  /** Validated collection examples; only collected decisions fit the head. */
  readonly training: readonly SystemOneExample[];
  /** Validated held-out examples, disjoint from collection and never a gradient source. */
  readonly evaluation: readonly SystemOneExample[];
  /** Content identity of the ordered collection examples. */
  readonly trainingDigest: string;
  /** Content identity of the ordered held-out examples. */
  readonly evaluationDigest: string;
  /** Content identity of the ordered question specifications. */
  readonly questionsDigest: string;
  /** The frozen decision model's endpoint coordinates. */
  readonly endpoint: SystemOneEndpointSpec;
  /** The starting calibration head. */
  readonly initial: SystemOneCheckpoint;
  /** Unsigned 32-bit base seed for reproducible answer sampling. */
  readonly seed: number;
  /** Maximum generations, from 1 to the loop's shared bound. */
  readonly maxGenerations: number;
  /** Decision queries each generation collects. */
  readonly samplesPerGeneration: number;
  /** Total decision queries (collection plus held-out evidence) the loop may spend. */
  readonly budget: number;
  /** Gradient-descent learning rate for the head fit. */
  readonly learningRate: number;
  /** Gradient steps each head fit takes. */
  readonly fitSteps: number;
  /** Strictly positive minimum held-out improvement every promotion must clear. */
  readonly minimumImprovement: number;
  /** Maximum positive training-to-evaluation expected reward gap. */
  readonly maximumGap: number;
  /** Held-out evaluation episodes sampled per policy for the promotion gate. */
  readonly evaluationSamples: number;
  /** Confidence level 1-alpha for the gate's Hoeffding bound, in (0, 1). */
  readonly confidence: number;
  /** Minimum sample count the promotion gate requires from each side. */
  readonly minSamples: number;
  /** Content identity of the whole programme. */
  readonly digest: string;
}

/** The persisted training configuration of one completed decision-model generation. */
export interface StoredSystemOneGeneration {
  /** One-based generation number. */
  readonly generation: number;
  /** The derived learning rate this generation ran under. */
  readonly learningRate: number;
  /** The held-out evaluation episode count this generation sampled. */
  readonly evaluationSamples: number;
  /** Gradient steps this generation's fit took. */
  readonly fitSteps: number;
  /** Decision queries this generation collected. */
  readonly samples: number;
  /** Held-out decision queries this generation recorded. */
  readonly heldOutSamples: number;
  /** Content identity of the complete ordered collected batch. */
  readonly collectionDigest: string;
  /** Content-addressed identity of the collecting checkpoint. */
  readonly sourceCheckpoint: string;
  /** Content-addressed identity of the candidate checkpoint. */
  readonly candidateCheckpoint: string;
  /** The candidate head's actual parameters. */
  readonly candidateParameters: SystemOneHeadParameters;
  /** Expected reward under the candidate on the collected decisions. */
  readonly trainingScore: number;
  /** Expected reward under the candidate on the held-out decisions. */
  readonly evaluationScore: number;
  /** The incumbent's sampled held-out mean this generation was judged against. */
  readonly incumbentHeldOutMean: number;
  /** The candidate's sampled held-out mean the gate bounded. */
  readonly candidateHeldOutMean: number;
  /** Decision-model tokens the endpoint reported for this generation. */
  readonly usageTokens: number;
}

/** Hash a typed, explicitly ordered decision-model artifact. */
function systemOneDigest(value: JsonValue): string {
  return `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
}

/** Render one example as the plain JSON value the environment spec stores. */
function jsonExample(example: SystemOneExample): JsonValue {
  return { id: example.id, title: example.title, description: example.description, labels: { ...example.labels } };
}

/** Read one required finite number from a decision-model configuration record. */
function requiredConfigNumber(record: Readonly<Record<string, unknown>>, key: string, code: string): number {
  const value = record[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    expectedFail(`SystemOne loop configuration requires a finite number ${key}.`, code);
  }
  return value;
}

/**
 * Validate both labelled datasets and return them with their content identities.
 *
 * Example identities must be unique and DISJOINT across the collection and
 * held-out sets: a held-out item that leaks into collection is refused here,
 * before any endpoint query is spent, because the promotion gate's
 * contamination verdict must stay null by construction. Every example must
 * carry exactly the configured questions and answer each with a declared
 * option, so a fit can never read a label it cannot score.
 *
 * @param training - The raw collection examples.
 * @param evaluation - The raw held-out examples.
 * @param questions - The validated question specifications.
 * @returns Both validated example sets with their ordered content identities.
 * @throws An expected CLI error when a dataset is empty, oversized, malformed, or overlapping.
 */
export function validatedSystemOneDatasets(training: readonly unknown[], evaluation: readonly unknown[], questions: readonly SystemOneChoiceSpec[]): { readonly training: readonly SystemOneExample[]; readonly evaluation: readonly SystemOneExample[]; readonly trainingDigest: string; readonly evaluationDigest: string } {
  const optionSets = new Map(questions.map((question) => [question.name, new Set(Object.keys(question.criteria))]));
  const identities = new Set<string>();
  const datasets: SystemOneExample[][] = [];
  for (const dataset of [training, evaluation]) {
    if (dataset.length === 0 || dataset.length > MAX_SYSTEMONE_EXAMPLES) {
      expectedFail(`SystemOne loop datasets must carry 1 to ${MAX_SYSTEMONE_EXAMPLES} examples.`, "systemone_invalid_dataset_size");
    }
    const validated: SystemOneExample[] = [];
    for (const entry of dataset) {
      const record = asJsonObject(entry, "SystemOne example", "systemone_invalid_example");
      const id = requiredTrimmedString(record, "id", "SystemOne example", "systemone_example_");
      const title = requiredTrimmedString(record, "title", "SystemOne example", "systemone_example_");
      if (typeof record["description"] !== "string") {
        expectedFail("SystemOne example requires a string description.", "systemone_example_description");
      }
      const labels = asJsonObject(record["labels"] ?? null, "SystemOne example labels", "systemone_example_labels");
      const names = [...optionSets.keys()];
      if (Object.keys(labels).length !== names.length || names.some((name) => !(name in labels))) {
        expectedFail(`SystemOne example ${id} must label exactly the configured questions: ${names.join(", ")}.`, "systemone_example_labels");
      }
      for (const question of questions) {
        const label = labels[question.name];
        if (typeof label !== "string" || !optionSets.get(question.name)!.has(label)) {
          expectedFail(`SystemOne example ${id} labels question ${question.name} with undeclared option ${String(label)}.`, "systemone_example_label_option");
        }
      }
      if (identities.has(id)) {
        expectedFail(`SystemOne example identity ${id} is reused across collection and held-out datasets; held-out items that leak into training stop the loop.`, "systemone_dataset_overlap");
      }
      identities.add(id);
      validated.push({ id, title, description: record["description"], labels: { ...labels as Record<string, string> } });
    }
    datasets.push(validated);
  }
  return {
    training: datasets[0],
    evaluation: datasets[1],
    trainingDigest: systemOneDigest(datasets[0].map(jsonExample)),
    evaluationDigest: systemOneDigest(datasets[1].map(jsonExample)),
  };
}

/** Build the neutral identity head: unit temperature and zero biases. */
export function neutralSystemOneHead(questions: readonly SystemOneChoiceSpec[]): SystemOneHeadParameters {
  return {
    logTemperature: Object.fromEntries(questions.map((question) => [question.name, 0])),
    biases: Object.fromEntries(questions.map((question) => [question.name, Object.fromEntries(Object.keys(question.criteria).map((option) => [option, 0]))])),
  };
}

/**
 * Construct a format-bound checkpoint identity over the real head parameters.
 *
 * The digest binds the checkpoint format, the question names and options, and
 * the actual parameter values, so any parameter the fit moves changes the
 * identity the next generation's collection run must match.
 *
 * @param parameters - The head parameters to bind.
 * @param questions - The question specifications the parameters calibrate.
 * @returns The checkpoint with its content-addressed digest.
 */
export function systemOneCheckpoint(parameters: SystemOneHeadParameters, questions: readonly SystemOneChoiceSpec[]): SystemOneCheckpoint {
  return {
    parameters,
    digest: systemOneDigest({
      format: SYSTEMONE_CHECKPOINT_FORMAT,
      questions: Object.fromEntries(questions.map((question) => [question.name, [...Object.keys(question.criteria)].sort()])),
      parameters: {
        log_temperature: { ...parameters.logTemperature },
        biases: Object.fromEntries(questions.map((question) => [question.name, { ...parameters.biases[question.name] }])),
      },
    }),
  };
}

/** Read one bounded log temperature or bias from a persisted head record. */
function storedHeadNumber(value: unknown, source: string, bound: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || Math.abs(value) > bound) {
    expectedFail(`${source} is not a finite parameter within [-${bound}, ${bound}]; the persisted checkpoint is invalid.`, "systemone_invalid_checkpoint");
  }
  return value;
}

/**
 * Parse and validate persisted calibration head parameters.
 *
 * The shape contract is exact: one log temperature per configured question
 * and one bias per declared option, nothing missing and nothing foreign. A
 * NaN parameter, an out-of-bound value, or a shape mismatch — a bias for an
 * option the question never declared — is refused as an invalid checkpoint,
 * so a tampered generation item cannot become the next collecting policy.
 *
 * @param value - The raw parameters JSON.
 * @param questions - The question specifications the parameters must match.
 * @param source - Human-readable origin for error messages.
 * @returns The validated head parameters.
 * @throws An expected CLI error with a stable invalid-checkpoint code.
 */
export function parseSystemOneHeadParameters(value: unknown, questions: readonly SystemOneChoiceSpec[], source: string): SystemOneHeadParameters {
  const record = asJsonObject(value, source, "systemone_invalid_checkpoint");
  const logRecord = asJsonObject(record["log_temperature"] ?? null, `${source} log_temperature`, "systemone_invalid_checkpoint");
  const biasRecord = asJsonObject(record["biases"] ?? null, `${source} biases`, "systemone_invalid_checkpoint");
  const names = questions.map((question) => question.name);
  if (Object.keys(logRecord).length !== names.length || names.some((name) => !(name in logRecord))) {
    expectedFail(`${source} must carry exactly one log temperature per configured question.`, "systemone_invalid_checkpoint_shape");
  }
  if (Object.keys(biasRecord).length !== names.length || names.some((name) => !(name in biasRecord))) {
    expectedFail(`${source} must carry exactly one bias vector per configured question.`, "systemone_invalid_checkpoint_shape");
  }
  const logTemperature: Record<string, number> = {};
  const biases: Record<string, Record<string, number>> = {};
  for (const question of questions) {
    logTemperature[question.name] = storedHeadNumber(logRecord[question.name], `${source} log_temperature ${question.name}`, MAX_SYSTEMONE_LOG_TEMPERATURE);
    const options = Object.keys(question.criteria);
    const vector = asJsonObject(biasRecord[question.name], `${source} biases ${question.name}`, "systemone_invalid_checkpoint");
    if (Object.keys(vector).length !== options.length || options.some((option) => !(option in vector))) {
      expectedFail(`${source} must carry exactly one bias per declared option of question ${question.name}.`, "systemone_invalid_checkpoint_shape");
    }
    const biased: Record<string, number> = {};
    for (const option of options) {
      biased[option] = storedHeadNumber(vector[option], `${source} bias ${question.name}/${option}`, MAX_SYSTEMONE_BIAS);
    }
    biases[question.name] = biased;
  }
  return { logTemperature, biases };
}

/** Render head parameters as the plain JSON value artifacts persist. */
export function jsonHeadParameters(parameters: SystemOneHeadParameters, questions: readonly SystemOneChoiceSpec[]): JsonValue {
  return {
    log_temperature: { ...parameters.logTemperature },
    biases: Object.fromEntries(questions.map((question) => [question.name, { ...parameters.biases[question.name] }])),
  };
}

/**
 * Parse and validate one decision-model loop configuration.
 *
 * Mirrors the bandit parser's fail-closed discipline for the shared bounds,
 * and validates the decision-model specifics: question specifications with
 * declared options, labelled disjoint datasets, endpoint coordinates with a
 * bounded timeout, and a bounded initial head. The optional `initial_head`
 * defaults to the neutral identity calibration so an uncalibrated model is
 * the honest starting policy.
 *
 * @param raw - The parsed loop configuration document.
 * @returns The validated decision-model configuration with all content identities.
 * @throws An expected CLI error naming the first missing, mistyped, or out-of-bounds field.
 */
export function parseSystemOneLoopConfig(raw: JsonValue): SystemOneLoopConfig {
  const record = asJsonObject(raw, "SystemOne loop configuration", "systemone_invalid_json");
  const environment = asJsonObject(record["environment"] ?? null, "SystemOne loop configuration environment", "systemone_invalid_environment");
  const environmentName = requiredTrimmedString(environment, "name", "SystemOne loop configuration environment", "systemone_environment_");
  const environmentVersion = requiredTrimmedString(environment, "version", "SystemOne loop configuration environment", "systemone_environment_");
  const questionRecord = asJsonObject(record["questions"] ?? null, "SystemOne loop configuration questions", "systemone_invalid_questions");
  const questions: SystemOneChoiceSpec[] = [];
  for (const name of Object.keys(questionRecord).sort()) {
    const spec = asJsonObject(questionRecord[name], `SystemOne question ${name}`, "systemone_invalid_question");
    if (spec["type"] !== undefined && spec["type"] !== "choice") expectedFail("Calibration requires choice questions.", "systemone_invalid_question");
    const instructions = requiredTrimmedString(spec, "instructions", `SystemOne question ${name}`, "systemone_question_");
    const criteria = asJsonObject(spec["criteria"] ?? null, `SystemOne question ${name} criteria`, "systemone_question_criteria");
    const options = Object.keys(criteria).sort();
    if (options.length < 2) {
      expectedFail(`SystemOne question ${name} must declare at least two answer options.`, "systemone_question_options");
    }
    for (const option of options) {
      const description = criteria[option];
      if (typeof description !== "string" && description !== null) {
        expectedFail(`SystemOne question ${name} criteria ${option} must be a description string or null.`, "systemone_question_criteria");
      }
    }
    questions.push({ name, instructions, criteria: Object.fromEntries(options.map((option) => [option, criteria[option] as string | null])) });
  }
  if (questions.length === 0) {
    expectedFail("SystemOne loop configuration requires at least one question.", "systemone_invalid_questions");
  }
  const model = asJsonObject(record["decision_model"] ?? null, "SystemOne loop configuration decision_model", "systemone_invalid_decision_model");
  const baseURL = requiredTrimmedString(model, "base_url", "SystemOne decision model", "systemone_decision_model_");
  try {
    const url = new URL(baseURL);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error("invalid endpoint");
  } catch {
    expectedFail("SystemOne decision model base_url must be an http(s) URL without credentials, query or fragment.", "systemone_decision_model_base_url");
  }
  const endpointModel = requiredTrimmedString(model, "model", "SystemOne decision model", "systemone_decision_model_");
  const receiptProtocol = model["receipt_protocol"];
  if (receiptProtocol !== undefined && receiptProtocol !== "idempotency-v1") {
    expectedFail("SystemOne receipt_protocol must be idempotency-v1 when supplied.", "systemone_invalid_receipt_protocol");
  }
  const receiptConfig = receiptProtocol === undefined ? {} : { receiptProtocol } as const;
  const receiptJson: Record<string, JsonValue> = receiptProtocol === undefined ? {} : { receipt_protocol: receiptProtocol };
  const timeoutMs = requiredConfigNumber(model, "timeout_ms", "systemone_invalid_timeout_ms");
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 600_000) {
    expectedFail("SystemOne decision model timeout_ms must be an integer from 1 to 600000 milliseconds.", "systemone_invalid_timeout_ms");
  }
  const trainingField = record["training"];
  const evaluationField = record["evaluation"];
  if (!Array.isArray(trainingField) || !Array.isArray(evaluationField)) {
    expectedFail("SystemOne loop configuration requires training and evaluation example arrays.", "systemone_invalid_datasets");
  }
  const datasets = validatedSystemOneDatasets(trainingField, evaluationField, questions);
  const head = record["initial_head"] === undefined
    ? systemOneCheckpoint(neutralSystemOneHead(questions), questions)
    : systemOneCheckpoint(parseSystemOneHeadParameters(record["initial_head"], questions, "SystemOne initial_head"), questions);
  const seed = requiredConfigNumber(record, "seed", "systemone_invalid_seed");
  const maxGenerations = requiredConfigNumber(record, "max_generations", "systemone_invalid_max_generations");
  const samplesPerGeneration = requiredConfigNumber(record, "samples_per_generation", "systemone_invalid_samples_per_generation");
  const budget = requiredConfigNumber(record, "budget", "systemone_invalid_budget");
  const learningRate = requiredConfigNumber(record, "learning_rate", "systemone_invalid_learning_rate");
  const fitSteps = requiredConfigNumber(record, "fit_steps", "systemone_invalid_fit_steps");
  const minimumImprovement = requiredConfigNumber(record, "minimum_improvement", "systemone_invalid_minimum_improvement");
  const maximumGap = requiredConfigNumber(record, "maximum_gap", "systemone_invalid_maximum_gap");
  const evaluationSamples = requiredConfigNumber(record, "evaluation_samples", "systemone_invalid_evaluation_samples");
  const confidence = requiredConfigNumber(record, "confidence", "systemone_invalid_confidence");
  const minSamples = requiredConfigNumber(record, "min_samples", "systemone_invalid_min_samples");
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffff_ffff) {
    expectedFail("SystemOne loop configuration seed must be an unsigned 32-bit integer.", "systemone_invalid_seed");
  }
  if (!Number.isInteger(maxGenerations) || maxGenerations < 1 || maxGenerations > 100) {
    expectedFail("SystemOne loop configuration max_generations must be an integer from 1 to 100.", "systemone_invalid_max_generations");
  }
  if (!Number.isInteger(samplesPerGeneration) || samplesPerGeneration < 1) {
    expectedFail("SystemOne loop configuration samples_per_generation must be a positive integer.", "systemone_invalid_samples_per_generation");
  }
  if (!Number.isInteger(fitSteps) || fitSteps < 1 || fitSteps > MAX_SYSTEMONE_FIT_STEPS) {
    expectedFail(`SystemOne loop configuration fit_steps must be an integer from 1 to ${MAX_SYSTEMONE_FIT_STEPS}.`, "systemone_invalid_fit_steps");
  }
  const batchCost = samplesPerGeneration + datasets.evaluation.length;
  if (!Number.isInteger(budget) || budget < batchCost || budget > 100_000) {
    expectedFail(`SystemOne loop configuration budget must be an integer covering one generation's query cost (${batchCost}) up to 100000; every decision query is charged.`, "systemone_invalid_budget");
  }
  if (learningRate < 0.01 || learningRate > 1) {
    expectedFail("SystemOne loop configuration learning_rate must be in [0.01, 1].", "systemone_invalid_learning_rate");
  }
  if (!Number.isFinite(minimumImprovement) || minimumImprovement <= 0) {
    expectedFail("SystemOne loop configuration minimum_improvement must be strictly positive.", "systemone_invalid_minimum_improvement");
  }
  if (!Number.isFinite(maximumGap) || maximumGap < 0) {
    expectedFail("SystemOne loop configuration maximum_gap must be finite and non-negative.", "systemone_invalid_maximum_gap");
  }
  if (!Number.isInteger(evaluationSamples) || evaluationSamples < 1 || evaluationSamples > 100_000) {
    expectedFail("SystemOne loop configuration evaluation_samples must be an integer from 1 to 100000.", "systemone_invalid_evaluation_samples");
  }
  if (!Number.isFinite(confidence) || confidence <= 0 || confidence >= 1) {
    expectedFail("SystemOne loop configuration confidence must be in (0, 1).", "systemone_invalid_confidence");
  }
  if (!Number.isInteger(minSamples) || minSamples < 1) {
    expectedFail("SystemOne loop configuration min_samples must be a positive integer.", "systemone_invalid_min_samples");
  }
  const questionsDigest = systemOneDigest(Object.fromEntries(questions.map((question) => [question.name, {
    instructions: question.instructions,
    criteria: { ...question.criteria },
  }])));
  const config: SystemOneLoopConfig = {
    environmentName,
    environmentVersion,
    questions,
    training: datasets.training,
    evaluation: datasets.evaluation,
    trainingDigest: datasets.trainingDigest,
    evaluationDigest: datasets.evaluationDigest,
    questionsDigest,
    endpoint: { baseURL, model: endpointModel, timeoutMs, ...receiptConfig },
    initial: head,
    seed,
    maxGenerations,
    samplesPerGeneration,
    budget,
    learningRate,
    fitSteps,
    minimumImprovement,
    maximumGap,
    evaluationSamples,
    confidence,
    minSamples,
    digest: "",
  };
  return { ...config, digest: systemOneDigest({
    format: SYSTEMONE_PROGRAMME_FORMAT,
    environment: { name: environmentName, version: environmentVersion },
    trainingDigest: datasets.trainingDigest,
    evaluationDigest: datasets.evaluationDigest,
    questionsDigest,
    endpoint: { base_url: baseURL, model: endpointModel, timeout_ms: timeoutMs, ...receiptJson },
    initial_checkpoint: head.digest,
    seed, maxGenerations, samplesPerGeneration, budget, learningRate, fitSteps,
    minimumImprovement, maximumGap, evaluationSamples, confidence, minSamples,
  }) };
}

/** Render the validated configuration as the JSON the seed item persists for replay. */
export function systemOneConfigurationJson(config: SystemOneLoopConfig): JsonValue {
  return {
    trainer: "systemone",
    environment: { name: config.environmentName, version: config.environmentVersion },
    questions: Object.fromEntries(config.questions.map((question) => [question.name, { instructions: question.instructions, criteria: { ...question.criteria } }])),
    decision_model: { base_url: config.endpoint.baseURL, model: config.endpoint.model, timeout_ms: config.endpoint.timeoutMs, ...(config.endpoint.receiptProtocol === undefined ? {} : { receipt_protocol: config.endpoint.receiptProtocol }) },
    training: config.training.map(jsonExample),
    evaluation: config.evaluation.map(jsonExample),
    initial_head: jsonHeadParameters(config.initial.parameters, config.questions),
    seed: config.seed,
    max_generations: config.maxGenerations,
    samples_per_generation: config.samplesPerGeneration,
    budget: config.budget,
    learning_rate: config.learningRate,
    fit_steps: config.fitSteps,
    minimum_improvement: config.minimumImprovement,
    maximum_gap: config.maximumGap,
    evaluation_samples: config.evaluationSamples,
    confidence: config.confidence,
    min_samples: config.minSamples,
  };
}

/**
 * Build the content-addressed environment the decision-model loop registers.
 *
 * The task suite carries both disjoint labelled datasets verbatim, so the
 * environment's content hash is the identity every collection run's
 * provenance records, and the reward specification pins the bounded
 * correctness contract the gate's Hoeffding bound assumes.
 *
 * @param config - The validated decision-model loop configuration.
 * @returns The environment specification to register.
 */
export function systemOneEnvironmentSpec(config: SystemOneLoopConfig): EnvironmentSpec {
  return {
    name: config.environmentName,
    version: config.environmentVersion,
    task_suite: { collection: config.training.map(jsonExample), held_out: config.evaluation.map(jsonExample) },
    reward_specification: {
      format: SYSTEMONE_REWARD_FORMAT,
      reward_bounds: [SYSTEMONE_REWARD_BOUNDS[0], SYSTEMONE_REWARD_BOUNDS[1]],
      held_out_isolated_from_collection: true,
    },
  };
}

/**
 * Rescale raw answer probabilities through one question's head parameters.
 *
 * The head is the policy: raw probabilities become logits, the temperature
 * divides them, the biases shift them, and a softmax returns the calibrated
 * distribution the loop samples answers from.
 *
 * @param raw - The frozen model's answer probabilities for one question.
 * @param logTemperature - The question's log temperature.
 * @param biases - The question's per-option biases.
 * @returns The calibrated probability per option, summing to one.
 */
export function calibratedProbabilities(raw: Readonly<Record<string, number>>, logTemperature: number, biases: Readonly<Record<string, number>>): Record<string, number> {
  const options = Object.keys(raw);
  const logits = options.map((option) => Math.log(Math.max(raw[option], PROBABILITY_FLOOR)) * Math.exp(-logTemperature) + biases[option]);
  const peak = Math.max(...logits);
  const weights = logits.map((logit) => Math.exp(logit - peak));
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  return Object.fromEntries(options.map((option, index) => [option, weights[index] / total]));
}

/** Look up the calibrated distribution of one observation's question. */
function observationQuestion(observation: SystemOneObservation, question: SystemOneChoiceSpec): Readonly<Record<string, number>> {
  const answers = observation.answers[question.name];
  if (answers === undefined) {
    expectedFail(`Decision for example ${observation.example} is missing question ${question.name}.`, "systemone_decision_shape");
  }
  const options = Object.keys(question.criteria);
  const probabilities: Record<string, number> = {};
  for (const option of options) {
    const value = answers[option];
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
      expectedFail(`Decision for example ${observation.example} carries a non-probability for ${question.name}/${option}.`, "systemone_decision_shape");
    }
    probabilities[option] = value;
  }
  const sum = Object.values(probabilities).reduce((total, value) => total + value, 0);
  if (Math.abs(sum - 1) > 1e-6) expectedFail("Decision probabilities must sum to one.", "systemone_decision_shape");
  return probabilities;
}

/** Score each question answer against its labelled outcome under a checkpoint. */
function scoredAnswers(observations: readonly SystemOneObservation[], examples: readonly SystemOneExample[], questions: readonly SystemOneChoiceSpec[], checkpoint: SystemOneCheckpoint): Array<{ correct: number; confidence: number; reward: number }> {
  if (observations.length === 0) expectedFail("Scoring requires at least one decision.", "systemone_empty_evidence");
  const labels = new Map(examples.map((example) => [example.id, example]));
  const scores: Array<{ correct: number; confidence: number; reward: number }> = [];
  for (const observation of observations) {
    const example = labels.get(observation.example);
    if (example === undefined) expectedFail(`Decision names unknown example ${observation.example}.`, "systemone_decision_example");
    for (const question of questions) {
      const probabilities = calibratedProbabilities(observationQuestion(observation, question), checkpoint.parameters.logTemperature[question.name], checkpoint.parameters.biases[question.name]);
      const [top, confidence] = Object.entries(probabilities).reduce((best, entry) => entry[1] > best[1] ? entry : best);
      scores.push({ correct: top === example.labels[question.name] ? 1 : 0, confidence, reward: probabilities[example.labels[question.name]] });
    }
  }
  return scores;
}

/** Mean expected correctness over the fixed labelled observations. */
function expectedReward(observations: readonly SystemOneObservation[], examples: readonly SystemOneExample[], questions: readonly SystemOneChoiceSpec[], checkpoint: SystemOneCheckpoint): number {
  const scores = scoredAnswers(observations, examples, questions, checkpoint);
  return scores.reduce((sum, score) => sum + score.reward, 0) / scores.length;
}

/** Fraction of answers whose highest-probability option matches the label. */
export function systemOneAccuracy(observations: readonly SystemOneObservation[], examples: readonly SystemOneExample[], questions: readonly SystemOneChoiceSpec[], checkpoint: SystemOneCheckpoint): number {
  const scores = scoredAnswers(observations, examples, questions, checkpoint);
  return scores.reduce((sum, score) => sum + score.correct, 0) / scores.length;
}

/** Compute count-weighted absolute confidence/accuracy gaps over reliability bins. */
export function systemOneCalibrationError(observations: readonly SystemOneObservation[], examples: readonly SystemOneExample[], questions: readonly SystemOneChoiceSpec[], checkpoint: SystemOneCheckpoint, bins: number): number {
  if (!Number.isInteger(bins) || bins < 1) expectedFail("Calibration error requires at least one confidence bin.", "systemone_invalid_bins");
  const scores = scoredAnswers(observations, examples, questions, checkpoint);
  const counts = new Array<number>(bins).fill(0);
  const confidences = new Array<number>(bins).fill(0);
  const accuracies = new Array<number>(bins).fill(0);
  for (const score of scores) {
    const bin = Math.min(bins - 1, Math.floor(score.confidence * bins));
    counts[bin] += 1;
    confidences[bin] += score.confidence;
    accuracies[bin] += score.correct;
  }
  let error = 0;
  for (let bin = 0; bin < bins; bin += 1) {
    if (counts[bin] > 0) error += counts[bin] / scores.length * Math.abs(accuracies[bin] / counts[bin] - confidences[bin] / counts[bin]);
  }
  return error;
}
/** Sample one answer per question from the calibrated policy of one observation. */
function sampleObservationAnswers(observation: SystemOneObservation, questions: readonly SystemOneChoiceSpec[], checkpoint: SystemOneCheckpoint, state: number): { answers: Record<string, string>; state: number } {
  const answers: Record<string, string> = {};
  let cursor = state;
  for (const question of questions) {
    const probabilities = calibratedProbabilities(observationQuestion(observation, question), checkpoint.parameters.logTemperature[question.name], checkpoint.parameters.biases[question.name]);
    const options = [...Object.keys(question.criteria)].sort();
    cursor = (Math.imul(LCG_MULTIPLIER, cursor) + LCG_INCREMENT) >>> 0;
    const draw = cursor / 0x1_0000_0000;
    let cumulative = 0;
    let chosen = options[options.length - 1]!;
    for (const option of options) {
      cumulative += probabilities[option];
      if (draw < cumulative) {
        chosen = option;
        break;
      }
    }
    answers[question.name] = chosen;
  }
  return { answers, state: cursor };
}

/** Derive the deterministic seed of one collection sample's answer stream. */
export function systemOneSampleSeed(base: number, generation: number, step: number): number {
  return trainerSampleSeed(base, generation, step);
}



/** Mean correctness of one sampled answer set against an example's true labels. */
function sampledAnswerReward(answers: Readonly<Record<string, string>>, example: SystemOneExample, questions: readonly SystemOneChoiceSpec[]): number {
  let correct = 0;
  for (const question of questions) {
    if (answers[question.name] === example.labels[question.name]) correct += 1;
  }
  return correct / questions.length;
}

/**
 * Sample one answer set from the calibrated policy of a single fresh decision.
 *
 * Collection uses this to record what the collecting policy actually did with
 * each fresh decision, exactly as the bandit samples actions from its logistic
 * policy: the reward persisted with the decision is the mean correctness of
 * the sampled answers, and the stream is a pure function of the base seed,
 * the generation, and the sample index, so a resume replays the sampled
 * answers without persisting them.
 *
 * @param observation - The decision whose calibrated distribution is acted on.
 * @param example - The labelled example the decision names.
 * @param questions - The question specifications.
 * @param checkpoint - The collecting policy's head.
 * @param seed - The sample's deterministic answer-stream seed.
 * @returns The sampled answer per question and their mean correctness.
 */
export function sampleSystemOneActions(observation: SystemOneObservation, example: SystemOneExample, questions: readonly SystemOneChoiceSpec[], checkpoint: SystemOneCheckpoint, seed: number): { readonly answers: Readonly<Record<string, string>>; readonly reward: number } {
  const { answers } = sampleObservationAnswers(observation, questions, checkpoint, seed);
  return { answers, reward: sampledAnswerReward(answers, example, questions) };
}

/** Sample held-out evaluation episodes and return the empirical mean reward. */
function sampledHeldOutMean(observations: readonly SystemOneObservation[], examples: readonly SystemOneExample[], questions: readonly SystemOneChoiceSpec[], checkpoint: SystemOneCheckpoint, episodes: number, seed: number): number {
  const labels = new Map(examples.map((example) => [example.id, example]));
  let state = seed;
  let total = 0;
  for (let episode = 0; episode < episodes; episode += 1) {
    const observation = observations[episode % observations.length];
    const example = labels.get(observation.example);
    const { answers } = sampleObservationAnswers(observation, questions, checkpoint, state);
    state = (Math.imul(LCG_MULTIPLIER, state) + LCG_INCREMENT) >>> 0;
    total += sampledAnswerReward(answers, example!, questions);
  }
  return total / episodes;
}

/**
 * Fit the calibration head on a collected batch by real gradient descent.
 *
 * The fit minimizes the mean cross-entropy of the calibrated distribution
 * over the batch's labelled decisions: full-batch analytic gradients with
 * respect to the log temperature and every option bias, stepped `fitSteps`
 * times at the derived learning rate, with parameters clipped to their stable
 * bounds after every step. These are real parameter updates on real
 * collected evidence; the loss before and after is returned so the receipt
 * can show the fit actually moved the objective.
 *
 * @param decisions - The collected decisions to fit on.
 * @param examples - The labelled examples the decisions name.
 * @param questions - The question specifications.
 * @param source - The collecting head the batch was sampled under.
 * @param learningRate - The gradient step size.
 * @param fitSteps - The number of full-batch gradient steps.
 * @returns The fitted parameters and the batch cross-entropy before and after.
 * @throws An expected CLI error when the batch is empty or names unknown examples.
 */
export function fitSystemOneHead(decisions: readonly SystemOneObservation[], examples: readonly SystemOneExample[], questions: readonly SystemOneChoiceSpec[], source: SystemOneHeadParameters, learningRate: number, fitSteps: number): { readonly parameters: SystemOneHeadParameters; readonly lossBefore: number; readonly lossAfter: number } {
  const labels = new Map(examples.map((example) => [example.id, example]));
  if (decisions.length === 0) {
    expectedFail("A calibration head fit requires at least one collected decision.", "systemone_empty_batch");
  }
  /** Accumulate the cross-entropy and its gradients under one parameter state. */
  function evaluate(parameters: SystemOneHeadParameters): { loss: number; logTemperatureGradients: Record<string, number>; biasGradients: Record<string, Record<string, number>> } {
    let loss = 0;
    const logTemperatureGradients: Record<string, number> = Object.fromEntries(questions.map((question) => [question.name, 0]));
    const biasGradients: Record<string, Record<string, number>> = Object.fromEntries(questions.map((question) => [question.name, Object.fromEntries(Object.keys(question.criteria).map((option) => [option, 0]))]));
    for (const decision of decisions) {
      const example = labels.get(decision.example);
      if (example === undefined) {
        expectedFail(`Decision names unknown example ${decision.example}.`, "systemone_decision_example");
      }
      for (const question of questions) {
        const raw = observationQuestion(decision, question);
        const logTemperature = parameters.logTemperature[question.name];
        const biases = parameters.biases[question.name];
        const options = Object.keys(question.criteria);
        const logits: Record<string, number> = {};
        for (const option of options) {
          logits[option] = Math.log(Math.max(raw[option], PROBABILITY_FLOOR)) * Math.exp(-logTemperature) + biases[option];
        }
        const peak = Math.max(...options.map((option) => logits[option]));
        const weights: Record<string, number> = {};
        let total = 0;
        for (const option of options) {
          weights[option] = Math.exp(logits[option] - peak);
          total += weights[option];
        }
        const calibrated: Record<string, number> = {};
        for (const option of options) {
          calibrated[option] = weights[option] / total;
        }
        const truth = example.labels[question.name];
        loss -= Math.log(Math.max(calibrated[truth], PROBABILITY_FLOOR));
        for (const option of options) {
          const error = calibrated[option] - (option === truth ? 1 : 0);
          biasGradients[question.name][option] += error;
          logTemperatureGradients[question.name] += error * Math.log(Math.max(raw[option], PROBABILITY_FLOOR)) * -Math.exp(-logTemperature);
        }
      }
    }
    const pairs = decisions.length * questions.length;
    for (const question of questions) {
      logTemperatureGradients[question.name] /= pairs;
      for (const option of Object.keys(question.criteria)) {
        biasGradients[question.name][option] /= pairs;
      }
    }
    return { loss: loss / pairs, logTemperatureGradients, biasGradients };
  }
  let parameters = source;
  const before = evaluate(parameters);
  for (let step = 0; step < fitSteps; step += 1) {
    const { logTemperatureGradients, biasGradients } = evaluate(parameters);
    const logTemperature: Record<string, number> = {};
    const biases: Record<string, Record<string, number>> = {};
    for (const question of questions) {
      logTemperature[question.name] = clipParameter(parameters.logTemperature[question.name] - learningRate * logTemperatureGradients[question.name], MAX_SYSTEMONE_LOG_TEMPERATURE);
      const vector: Record<string, number> = {};
      for (const option of Object.keys(question.criteria)) {
        vector[option] = clipParameter(parameters.biases[question.name][option] - learningRate * biasGradients[question.name][option], MAX_SYSTEMONE_BIAS);
      }
      biases[question.name] = vector;
    }
    parameters = { logTemperature, biases };
  }
  const after = evaluate(parameters);
  return { parameters, lossBefore: before.loss, lossAfter: after.loss };
}

/** Clamp one parameter to its stable bound. */
function clipParameter(value: number, bound: number): number {
  return Math.min(bound, Math.max(-bound, value));
}

/** Identity of the complete ordered collected batch and its collecting checkpoint. */
function systemOneCollectionDigest(source: SystemOneCheckpoint, trainingDigest: string, observations: readonly SystemOneObservation[]): string {
  return systemOneDigest({
    source: source.digest,
    trainingDigest,
    collection: observations.map((observation) => ({ example: observation.example, answers: observation.answers, reward: observation.reward })),
  });
}

/**
 * Execute one decision-model generation step over complete collected evidence.
 *
 * The step is pure over its inputs: the controller collects the batch and
 * the held-out decisions (persisting every query), then this function fits
 * the head on the batch, evaluates both checkpoints on the held-out
 * decisions, samples the gate's evidence on seeded streams, and renders the
 * verdict. A resume that re-reads the same persisted evidence replays this
 * exactly.
 *
 * @param config - The validated decision-model loop configuration.
 * @param step - This generation's derived step configuration.
 * @param generation - The one-based generation number.
 * @param source - The collecting checkpoint whose head produced the batch.
 * @param collection - The complete ordered collected decisions.
 * @param heldOut - The complete held-out decision evidence.
 * @param usageTokens - Decision-model tokens the endpoint reported for this generation.
 * @returns The generation's complete receipt, including its terminal condition.
 */
export function executeSystemOneStep(config: SystemOneLoopConfig, step: LoopStepConfig, generation: number, source: SystemOneCheckpoint, collection: readonly SystemOneObservation[], heldOut: readonly SystemOneObservation[], usageTokens: number): SystemOneGeneration {
  const validatedSource = parseSystemOneHeadParameters(jsonHeadParameters(source.parameters, config.questions), config.questions, "Source checkpoint");
  if (source.digest !== systemOneCheckpoint(validatedSource, config.questions).digest) {
    expectedFail("Source checkpoint digest does not match its parameters.", "systemone_invalid_checkpoint");
  }
  const fit = fitSystemOneHead(collection, config.training, config.questions, source.parameters, step.learningRate, config.fitSteps);
  const candidate = systemOneCheckpoint(fit.parameters, config.questions);
  const collectionDigest = systemOneCollectionDigest(source, config.trainingDigest, collection);
  const baselineScore = expectedReward(heldOut, config.evaluation, config.questions, source);
  const trainingScore = expectedReward(collection, config.training, config.questions, candidate);
  const evaluationScore = expectedReward(heldOut, config.evaluation, config.questions, candidate);
  const [incumbentSeed, candidateSeed] = evaluationSeeds(config.seed, generation);
  const incumbentHeldOutMean = sampledHeldOutMean(heldOut, config.evaluation, config.questions, source, step.evaluationSamples, incumbentSeed);
  const candidateHeldOutMean = sampledHeldOutMean(heldOut, config.evaluation, config.questions, candidate, step.evaluationSamples, candidateSeed);
  const evidence: Omit<SystemOneGeneration, "promoted" | "refusalReason" | "stopReason"> = {
    generation,
    source,
    candidate,
    collectionDigest,
    observations: collection,
    lossBefore: fit.lossBefore,
    lossAfter: fit.lossAfter,
    baselineScore,
    trainingScore,
    evaluationScore,
    incumbentHeldOutMean,
    candidateHeldOutMean,
    usageTokens,
  };
  const verdict = decideTrainerPromotion({ changed: source.digest !== candidate.digest, generation, training: trainingScore,
    evaluation: evaluationScore, baseline: baselineScore, maximumGap: config.maximumGap, version: "pm-rl/systemone/1", context: config.evaluationDigest,
    samples: step.evaluationSamples, candidateMean: candidateHeldOutMean, incumbentMean: incumbentHeldOutMean,
    criterion: { confidence: config.confidence, minSamples: config.minSamples, effectThreshold: config.minimumImprovement } });
  return { ...evidence, ...verdict };
}

/** Build the run item's pre-collection configuration for one decision-model generation. */
export function systemOneRunConfig(config: SystemOneLoopConfig, step: LoopStepConfig, generation: number, source: SystemOneCheckpoint): JsonValue {
  return {
    format: SYSTEMONE_RUN_FORMAT,
    generation,
    learning_rate: step.learningRate,
    evaluation_samples: step.evaluationSamples,
    fit_steps: config.fitSteps,
    samples: config.samplesPerGeneration,
    held_out_samples: config.evaluation.length,
    source_checkpoint: source.digest,
  };
}

/**
 * Build the training configuration recorded on one candidate generation item.
 *
 * Everything the generation's provenance needs to be replayed: the derived
 * configuration, both checkpoint identities, the candidate's ACTUAL head
 * parameters, the content identity of the collected batch, the evaluation
 * numbers the next generation's configuration is derived from, and the
 * decision-model tokens this generation spent.
 *
 * @param config - The validated decision-model loop configuration.
 * @param step - The configuration this generation ran under.
 * @param receipt - The generation's receipt.
 * @returns The training configuration to store in the generation item's body.
 */
export function systemOneGenerationTrainingConfig(config: SystemOneLoopConfig, step: LoopStepConfig, receipt: SystemOneGeneration): JsonValue {
  return {
    format: SYSTEMONE_GENERATION_FORMAT,
    generation: receipt.generation,
    learning_rate: step.learningRate,
    evaluation_samples: step.evaluationSamples,
    fit_steps: config.fitSteps,
    samples: config.samplesPerGeneration,
    held_out_samples: config.evaluation.length,
    collection_digest: receipt.collectionDigest,
    source_checkpoint: receipt.source.digest,
    candidate_checkpoint: receipt.candidate.digest,
    candidate_parameters: jsonHeadParameters(receipt.candidate.parameters, config.questions),
    training_score: receipt.trainingScore,
    evaluation_score: receipt.evaluationScore,
    incumbent_held_out_mean: receipt.incumbentHeldOutMean,
    candidate_held_out_mean: receipt.candidateHeldOutMean,
    usage_tokens: receipt.usageTokens,
  };
}

/** Build the seed generation's training configuration, embedding the whole programme for replay. */
export function systemOneSeedTrainingConfig(config: SystemOneLoopConfig): JsonValue {
  return {
    format: SYSTEMONE_SEED_FORMAT,
    programme: config.digest,
    initial_checkpoint: config.initial.digest,
    initial_parameters: jsonHeadParameters(config.initial.parameters, config.questions),
    configuration: systemOneConfigurationJson(config),
  };
}

/**
 * Parse and validate one persisted decision-model generation training configuration.
 *
 * The checkpoint guards live here: the candidate parameters must parse with
 * the exact question shape (no NaN, no foreign option, nothing missing) and
 * the recorded candidate digest must match the digest of those very
 * parameters, so a tampered hash or a corrupted parameter set is refused
 * before the chain advances from it.
 *
 * @param value - The training configuration JSON read from the generation item.
 * @param questions - The question specifications the parameters must match.
 * @param source - Human-readable origin for error messages.
 * @returns The validated stored generation.
 * @throws An expected CLI error with a stable invalid-checkpoint code.
 */
export function parseStoredSystemOneGeneration(value: JsonValue, questions: readonly SystemOneChoiceSpec[], source: string): StoredSystemOneGeneration {
  const record = asJsonObject(value, source, "systemone_invalid_training_config");
  if (record["format"] !== SYSTEMONE_GENERATION_FORMAT) {
    expectedFail(`${source} must carry the ${SYSTEMONE_GENERATION_FORMAT} format marker.`, "systemone_invalid_training_config");
  }
  const generation = storedCheckpointNumber(record, "generation", source, "systemone_invalid_training_config");
  if (!Number.isInteger(generation) || generation < 1) {
    expectedFail(`${source} requires a positive integer generation.`, "systemone_invalid_training_config");
  }
  const candidateParameters = parseSystemOneHeadParameters(record["candidate_parameters"], questions, `${source} candidate_parameters`);
  const stored: StoredSystemOneGeneration = {
    generation,
    learningRate: storedCheckpointNumber(record, "learning_rate", source, "systemone_invalid_training_config"),
    evaluationSamples: storedCheckpointNumber(record, "evaluation_samples", source, "systemone_invalid_training_config"),
    fitSteps: storedCheckpointNumber(record, "fit_steps", source, "systemone_invalid_training_config"),
    samples: storedCheckpointNumber(record, "samples", source, "systemone_invalid_training_config"),
    heldOutSamples: storedCheckpointNumber(record, "held_out_samples", source, "systemone_invalid_training_config"),
    collectionDigest: storedCheckpointDigest(record, "collection_digest", source, "systemone_invalid_checkpoint"),
    sourceCheckpoint: storedCheckpointDigest(record, "source_checkpoint", source, "systemone_invalid_checkpoint"),
    candidateCheckpoint: storedCheckpointDigest(record, "candidate_checkpoint", source, "systemone_invalid_checkpoint"),
    candidateParameters,
    trainingScore: storedCheckpointNumber(record, "training_score", source, "systemone_invalid_training_config"),
    evaluationScore: storedCheckpointNumber(record, "evaluation_score", source, "systemone_invalid_training_config"),
    incumbentHeldOutMean: storedCheckpointNumber(record, "incumbent_held_out_mean", source, "systemone_invalid_training_config"),
    candidateHeldOutMean: storedCheckpointNumber(record, "candidate_held_out_mean", source, "systemone_invalid_training_config"),
    usageTokens: storedCheckpointNumber(record, "usage_tokens", source, "systemone_invalid_training_config"),
  };
  if (!Number.isInteger(stored.samples) || stored.samples < 1
    || !Number.isInteger(stored.heldOutSamples) || stored.heldOutSamples < 1
    || !Number.isInteger(stored.evaluationSamples) || stored.evaluationSamples < 1
    || !Number.isInteger(stored.fitSteps) || stored.fitSteps < 1) {
    expectedFail(`${source} requires positive integer sample bounds.`, "systemone_invalid_training_config");
  }
  if (stored.candidateCheckpoint !== systemOneCheckpoint(candidateParameters, questions).digest) {
    expectedFail(`${source} records candidate checkpoint ${stored.candidateCheckpoint}, which does not match the digest of its own persisted parameters; the persisted checkpoint is invalid.`, "systemone_invalid_checkpoint");
  }
  return stored;
}

/**
 * Replay one decision-model generation from persisted evidence and verify it.
 *
 * The fit and the evaluation are deterministic functions of the collected
 * decisions, the held-out decisions, and the source checkpoint, so a resume
 * re-executes the step over the evidence read back from the run's notes and
 * compares every persisted number field-for-field. Any disagreement is a
 * drift refusal, because advancing from evidence that does not reproduce
 * would let a rewritten history steer the loop.
 *
 * @param config - The validated decision-model loop configuration.
 * @param step - The derived step configuration this generation ran under.
 * @param source - The checkpoint whose head collected this batch.
 * @param stored - The persisted training configuration to verify against.
 * @param collection - The complete collected decisions read from the run's notes.
 * @param heldOut - The complete held-out decisions read from the run's notes.
 * @returns The replayed generation receipt, proven identical to the persisted one.
 * @throws An expected CLI drift refusal when the replay and the persisted record disagree.
 */
export function verifyStoredSystemOneGeneration(config: SystemOneLoopConfig, step: LoopStepConfig, source: SystemOneCheckpoint, stored: StoredSystemOneGeneration, collection: readonly SystemOneObservation[], heldOut: readonly SystemOneObservation[]): SystemOneGeneration {
  const receipt = executeSystemOneStep(config, step, stored.generation, source, collection, heldOut, stored.usageTokens);
  const expected: Array<[string, unknown, unknown]> = [
    ["generation", stored.generation, receipt.generation],
    ["held_out_samples", stored.heldOutSamples, config.evaluation.length],
    ["collection_digest", stored.collectionDigest, receipt.collectionDigest],
  ];
  verifyTrainerConfiguration(stored, step, config);
  verifyReplayFields(expected, stored.generation);
  verifyTrainerReceipt(stored, receipt, stored.generation);
  return receipt;
}

/**
 * Build the promotion score records for one gate-promoted decision-model generation.
 *
 * The proxy score is the candidate's exact expected reward over the collected
 * decisions; the held-out score is the sampled mean the gate actually
 * bounded. Both carry content-addressed seed-set identities and the dataset
 * digest they were measured on, so the persisted promotion's contamination
 * walk can verify the held-out context is unreachable from the training data.
 *
 * @param config - The validated decision-model loop configuration.
 * @param step - The configuration the promoted generation ran under.
 * @param receipt - The promoted generation's receipt.
 * @returns Score records ready for the persisted promotion's parser.
 */
export function systemOnePromotionScores(config: SystemOneLoopConfig, step: LoopStepConfig, receipt: SystemOneGeneration): { readonly proxy_score: JsonValue; readonly held_out_score: JsonValue } {
  return {
    proxy_score: {
      objective: "expected_reward",
      objective_version: "pm-rl/systemone/1",
      evaluation_context: config.trainingDigest,
      seed_set: systemOneDigest({ format: "pm-rl/systemone-collection-seed/1", base_seed: config.seed, generation: receipt.generation, samples: config.samplesPerGeneration }),
      direction: "maximize",
      scale: 1,
      value: receipt.trainingScore,
    },
    held_out_score: {
      objective: "expected_reward",
      objective_version: "pm-rl/systemone/1",
      evaluation_context: config.evaluationDigest,
      seed_set: systemOneDigest({ format: "pm-rl/systemone-held-out-seed/1", generation: receipt.generation, seed: config.seed, samples: step.evaluationSamples }),
      direction: "maximize",
      scale: 1,
      value: receipt.candidateHeldOutMean,
    },
  };
}

/** Render one observation's raw answers as the canonical JSON a metric tag carries. */
function jsonAnswers(answers: Readonly<Record<string, Readonly<Record<string, number>>>>): string {
  return canonicalJson(Object.fromEntries(Object.keys(answers).sort().map((question) => [question, Object.fromEntries(Object.keys(answers[question]).sort().map((option) => [option, answers[question][option]]))])));
}

/**
 * Render one decision as one merge-safe metric event.
 *
 * The event is the durable unit of endpoint spend: its step is the query
 * index within the phase, its value is the collecting policy's sampled-answer
 * correctness (or the calibrated correctness for held-out queries), and its
 * tags carry the example identity plus the raw answer probabilities as
 * canonical JSON. A resume reads these back, so a persisted query is never
 * repeated.
 *
 * @param metric - The collection or held-out metric name.
 * @param step - The query index within the phase.
 * @param observation - The decision to persist.
 * @param usage - Token counts the endpoint reported for this one query.
 * @returns The validated metric event.
 */
export function systemOneDecisionEvent(metric: string, step: number, observation: SystemOneObservation, usage: { readonly input_tokens: number; readonly output_tokens: number; readonly latency_ms?: number; readonly receipt?: SystemOneDecisionReceipt }): MetricEvent {
  if (metric !== SYSTEMONE_COLLECTION_METRIC && metric !== SYSTEMONE_HELD_OUT_METRIC) {
    expectedFail("A decision event must use the collection or held-out metric name.", "systemone_invalid_metric");
  }
  return { step, metric, value: observation.reward, tags: { example: observation.example, answers: jsonAnswers(observation.answers), tokens: String(usage.input_tokens + usage.output_tokens), latency_ms: String(usage.latency_ms ?? 0), ...(usage.receipt === undefined ? {} : { request_id: usage.receipt.requestId, decision_id: usage.receipt.decisionId, physical_requests: "1", input_tokens: String(usage.input_tokens), output_tokens: String(usage.output_tokens) }) } };
}

/**
 * Parse one persisted decision event back into its observation.
 *
 * Every field is re-validated against the question specifications, so a
 * tampered or truncated note is refused as evidence rather than silently
 * rescaled: the metric must match, the example must be identified, the
 * answers JSON must decode to exactly the declared options with probability
 * values, and the recorded reward must be a bounded correctness.
 *
 * @param event - The metric event read from the run's notes.
 * @param metric - The collection or held-out metric name to expect.
 * @param questions - The question specifications the answers must match.
 * @param source - Human-readable origin for error messages.
 * @returns The decoded observation.
 * @throws An expected CLI error when the event is not a valid persisted decision.
 */
export function parseSystemOneDecisionEvent(event: MetricEvent, metric: string, questions: readonly SystemOneChoiceSpec[], source: string): SystemOneObservation {
  if (event.metric !== metric || (metric !== SYSTEMONE_COLLECTION_METRIC && metric !== SYSTEMONE_HELD_OUT_METRIC)) {
    expectedFail(`${source} must carry the ${metric} metric.`, "systemone_event_metric");
  }
  const example = event.tags?.["example"];
  if (typeof example !== "string" || example.trim().length === 0) {
    expectedFail(`${source} must tag its example identity.`, "systemone_event_example");
  }
  const encoded = event.tags?.["answers"];
  if (typeof encoded !== "string") {
    expectedFail(`${source} must tag its raw answers as canonical JSON.`, "systemone_event_answers");
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(encoded);
  } catch {
    expectedFail(`${source} answers tag is not valid JSON.`, "systemone_event_answers");
  }
  const record = asJsonObject(decoded, `${source} answers`, "systemone_event_answers");
  const names = questions.map((question) => question.name);
  if (Object.keys(record).length !== names.length || names.some((name) => !(name in record))) {
    expectedFail(`${source} must answer exactly the configured questions.`, "systemone_event_answers");
  }
  const answers: Record<string, Record<string, number>> = {};
  for (const question of questions) {
    const options = Object.keys(question.criteria);
    const vector = asJsonObject(record[question.name], `${source} answers ${question.name}`, "systemone_event_answers");
    if (Object.keys(vector).length !== options.length || options.some((option) => !(option in vector))) {
      expectedFail(`${source} must carry exactly the declared options of question ${question.name}.`, "systemone_event_answers");
    }
    const probabilities: Record<string, number> = {};
    for (const option of options) {
      const value = vector[option];
      if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
        expectedFail(`${source} carries a non-probability for ${question.name}/${option}.`, "systemone_event_answers");
      }
      probabilities[option] = value;
    }
    answers[question.name] = observationQuestion({ example, reward: event.value, answers: { [question.name]: probabilities } }, question);
  }
  if (!Number.isFinite(event.value) || event.value < 0 || event.value > 1) {
    expectedFail(`${source} must record a bounded correctness value.`, "systemone_event_value");
  }
  return { example, answers, reward: event.value };
}

/** Immutable provider receipt identity; usage belongs to the original inference, never the retry. */
export interface SystemOneDecisionReceipt {
  /** Content-bound idempotency key echoed by the endpoint. */
  readonly requestId: string;
  /** Provider-assigned immutable inference identity. */
  readonly decisionId: string;
}

/** Derive a replay-stable query key scoped to a durable run namespace and all decision inputs. */
export function systemOneDecisionRequestId(config: SystemOneLoopConfig, source: SystemOneCheckpoint, namespace: string, metric: string, step: number): string {
  return systemOneDigest({ format: "pm-rl/systemone-request/1", namespace, programme: config.digest, source: source.digest, metric, step });
}

/** Validate persisted receipt identity and reconcile the individual token counts with their total. */
export function verifySystemOneReceiptEvent(event: MetricEvent, requestId: string): void {
  const tags = event.tags!;
  const input = Number(tags["input_tokens"]); const output = Number(tags["output_tokens"]);
  if (tags["request_id"] !== requestId || typeof tags["decision_id"] !== "string" || tags["decision_id"].trim().length === 0
    || tags["decision_id"].length > 256 || tags["physical_requests"] !== "1"
    || tags["input_tokens"] === undefined || tags["output_tokens"] === undefined
    || !Number.isSafeInteger(input) || input < 0 || !Number.isSafeInteger(output) || output < 0
    || !Number.isSafeInteger(input + output) || input + output !== Number(tags["tokens"])) {
    expectedFail("Persisted decision receipt identity or physical/token accounting disagrees with its request.", "loop_generation_drift", EXIT_CODE.CONFLICT);
  }
}

/** The frozen decision model's parsed answer for one request. */
export interface SystemOneDecisionResponse {
  /** Raw answer probabilities per question name and option. */
  readonly answers: Readonly<Record<string, Readonly<Record<string, number>>>>;
  /** Tokens the endpoint reported for the request. */
  readonly usage: { readonly input_tokens: number; readonly output_tokens: number; readonly latency_ms: number; readonly receipt?: SystemOneDecisionReceipt };
}

/**
 * Ask the frozen decision model one request's questions about one state.
 *
 * A plain `fetch` against the configured TypeSafe-compatible endpoint — no
 * new runtime dependency. The request shape, the response shape, and every
 * failure mode are validated here: a non-2xx status, an unreachable host, a
 * malformed body, usage counts or their sum outside non-negative safe integers,
 * a missing usage record, or an answer set that does not
 * match the declared questions is refused as an expected CLI error, and the
 * caller's abort signal plus the configured timeout are combined so a hung
 * endpoint can never pin the controller. An abort that originates from the
 * CALLER's signal is rethrown untouched, so a cancellation surfaces as a
 * cancellation and nothing else.
 *
 * @param endpoint - The decision model's endpoint coordinates.
 * @param state - The rendered decision request state.
 * @param questions - The questions to ask about the state.
 * @param signal - Optional caller cancellation signal.
 * @param requestId - Stable content-bound key required by the opted-in receipt protocol.
 * @returns The validated answer probabilities and token usage.
 * @throws An expected CLI endpoint error, or the caller's AbortError when the caller aborted.
 */
export async function requestSystemOneDecision(endpoint: SystemOneEndpointSpec, state: string, questions: readonly SystemOneChoiceSpec[], signal?: AbortSignal, requestId?: string): Promise<SystemOneDecisionResponse> {
  const recoverable = endpoint.receiptProtocol === "idempotency-v1";
  if (recoverable && (typeof requestId !== "string" || !/^sha256:[a-f0-9]{64}$/.test(requestId))) {
    expectedFail("Receipt requests require a content-bound request id.", "systemone_request_id_invalid");
  }
  const body = canonicalJson({
    ...(recoverable ? { request_id: requestId, receipt_protocol: "idempotency-v1" } : {}),
    model: endpoint.model,
    state,
    questions: Object.fromEntries(questions.map((question) => [question.name, { type: CHOICE_QUESTION_TYPE, instructions: question.instructions, criteria: { ...question.criteria } }])),
  });
  const started = performance.now();
  // Trim trailing slashes without a regex: `/\/+$/` backtracks polynomially on
  // long runs of "/" in caller-supplied configuration (CodeQL js/polynomial-redos).
  let baseURL = endpoint.baseURL;
  while (baseURL.endsWith("/")) baseURL = baseURL.slice(0, -1);
  let response: Response;
  try {
    response = await fetch(`${baseURL}/v1/systemone`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(recoverable ? { "idempotency-key": requestId! } : {}) },
      body,
      signal: signal === undefined ? AbortSignal.timeout(endpoint.timeoutMs) : AbortSignal.any([signal, AbortSignal.timeout(endpoint.timeoutMs)]),
    });
  } catch (error) {
    if (signal?.aborted === true) throw error;
    if (error instanceof Error && error.name === "TimeoutError") {
      expectedFail(`The decision model at ${endpoint.baseURL} did not answer within ${endpoint.timeoutMs}ms.`, "systemone_endpoint_timeout", EXIT_CODE.GENERIC_FAILURE);
    }
    expectedFail(`The decision model at ${endpoint.baseURL} could not be reached: ${String(error)}.`, "systemone_endpoint_unreachable", EXIT_CODE.GENERIC_FAILURE);
  }
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    expectedFail(`The decision model at ${endpoint.baseURL} answered HTTP ${response.status}: ${detail.slice(0, 500)}.`, "systemone_endpoint_status", EXIT_CODE.GENERIC_FAILURE);
  }
  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch (error) {
    if (signal?.aborted === true) throw error;
    expectedFail(`The decision model at ${endpoint.baseURL} returned a body that is not JSON.`, "systemone_endpoint_response_invalid", EXIT_CODE.GENERIC_FAILURE);
  }
  const record = asJsonObject(parsed, "Decision model response", "systemone_endpoint_response_invalid", EXIT_CODE.GENERIC_FAILURE);
  const answersRecord = asJsonObject(record["answers"] ?? null, "Decision model answers", "systemone_endpoint_answers_invalid", EXIT_CODE.GENERIC_FAILURE);
  const usageRecord = asJsonObject(record["usage"] ?? null, "Decision model usage", "systemone_endpoint_usage_invalid", EXIT_CODE.GENERIC_FAILURE);
  const inputTokens = usageRecord["input_tokens"];
  const outputTokens = usageRecord["output_tokens"];
  if (typeof inputTokens !== "number" || !Number.isSafeInteger(inputTokens) || inputTokens < 0
    || typeof outputTokens !== "number" || !Number.isSafeInteger(outputTokens) || outputTokens < 0
    || !Number.isSafeInteger(inputTokens + outputTokens)) {
    expectedFail("Decision model usage must report non-negative safe integer token counts whose sum is also a safe integer.", "systemone_endpoint_usage_invalid", EXIT_CODE.GENERIC_FAILURE);
  }
  let receipt: SystemOneDecisionReceipt | undefined;
  let latency = performance.now() - started;
  if (recoverable) {
    const decisionId = record["decision_id"];
    const reportedLatency = usageRecord["latency_ms"];
    if (record["request_id"] !== requestId || typeof decisionId !== "string" || decisionId.trim().length === 0
      || decisionId !== decisionId.trim() || decisionId.length > 256 || record["physical_requests"] !== 1
      || typeof reportedLatency !== "number" || !Number.isFinite(reportedLatency) || reportedLatency < 0) {
      expectedFail("The endpoint must return an immutable receipt for this request with one physical inference and original latency.", "systemone_endpoint_receipt_invalid", EXIT_CODE.GENERIC_FAILURE);
    }
    receipt = { requestId: requestId!, decisionId };
    latency = reportedLatency;
  }
  const names = questions.map((question) => question.name);
  if (Object.keys(answersRecord).length !== names.length || names.some((name) => !(name in answersRecord))) {
    expectedFail(`Decision model answers must cover exactly the requested questions: ${names.join(", ")}.`, "systemone_endpoint_answers_invalid", EXIT_CODE.GENERIC_FAILURE);
  }
  const answers: Record<string, Record<string, number>> = {};
  for (const question of questions) {
    const answer = asJsonObject(answersRecord[question.name], `Decision model answer ${question.name}`, "systemone_endpoint_answers_invalid", EXIT_CODE.GENERIC_FAILURE);
    if (answer["type"] !== undefined && answer["type"] !== CHOICE_QUESTION_TYPE) {
      expectedFail(`Decision model answer ${question.name} is not a choice answer.`, "systemone_endpoint_answers_invalid", EXIT_CODE.GENERIC_FAILURE);
    }
    const probabilities = asJsonObject(answer["probabilities"] ?? null, `Decision model answer ${question.name} probabilities`, "systemone_endpoint_answers_invalid", EXIT_CODE.GENERIC_FAILURE);
    const options = Object.keys(question.criteria);
    if (Object.keys(probabilities).length !== options.length || options.some((option) => !(option in probabilities))) {
      expectedFail(`Decision model answer ${question.name} must carry probabilities for exactly ${options.join(", ")}.`, "systemone_endpoint_answers_invalid", EXIT_CODE.GENERIC_FAILURE);
    }
    const values: Record<string, number> = {};
    for (const option of options) {
      const value = probabilities[option];
      if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
        expectedFail(`Decision model answer ${question.name} carries a non-probability for ${option}.`, "systemone_endpoint_answers_invalid", EXIT_CODE.GENERIC_FAILURE);
      }
      values[option] = value;
    }
    answers[question.name] = observationQuestion({ example: "endpoint", reward: 0, answers: { [question.name]: values } }, question);
  }
  return { answers, usage: { input_tokens: inputTokens, output_tokens: outputTokens, latency_ms: latency, ...(receipt === undefined ? {} : { receipt }) } };
}

/** Render one labelled example as the decision request state text. */
export function systemOneState(example: SystemOneExample): string {
  return `# ${example.title}\n\n${example.description}`;
}
