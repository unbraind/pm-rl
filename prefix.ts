/** Bounded logistic classifier over hashed normalized history features; no model downloads. */
import assert from "node:assert/strict";
import { hashJson, type JsonValue } from "./index.ts";
import { validateHistoryPrefix, type HistoryPrefix } from "./prefix-data.ts";
import type { ProcessCompletion, ProcessInput } from "./process.ts";

/** Fixed domains form part of every fitted checkpoint and recipe identity. */
export const PREFIX_BOUNDS = { regularisation: [0, 0.1], ngram_order: [1, 3], hashing_width: [16, 4096], learning_rate: [0.01, 1] } as const;
/** Small feature spaces and one bounded SGD pass keep fits within existing process reservations. */
export interface PrefixKnobs { readonly regularisation: number; readonly ngram_order: number; readonly hashing_width: number }
/** Actual parameters, with their feature recipe and content digest. */
export interface PrefixCheckpoint { readonly digest: string; readonly weights: readonly number[]; readonly knobs: PrefixKnobs }
/** Only training observables and binary labels cross the process boundary. */
export interface PrefixPayload {
  readonly rows: readonly { readonly prefix: HistoryPrefix; readonly label: 0 | 1 }[];
  readonly knobs: PrefixKnobs;
}
/** Descriptive probability diagnostics; intervals treat items as independent and never change the gate. */
export interface BinaryCalibration {
  readonly samples: number;
  readonly accuracy: { readonly correct: number; readonly mean: number; readonly interval: readonly [number, number] };
  readonly brier: number;
  readonly log_loss: number;
  readonly ece: number;
  readonly bins: readonly { readonly samples: number; readonly probability: number | null; readonly frequency: number | null }[];
}

/** Score class-one probabilities with five fixed reliability bins and a two-sided 95% Hoeffding accuracy interval. */
export function binaryCalibration(probabilities: readonly number[], labels: readonly (0 | 1)[]): BinaryCalibration {
  assert.ok(labels.length > 0 && labels.length === probabilities.length, "prefix_calibration_samples");
  assert.ok(labels.every((label) => label === 0 || label === 1) && probabilities.every((value) => Number.isFinite(value) && value >= 0 && value <= 1), "prefix_calibration_values");
  const counts = Array.from({ length: 5 }, () => ({ samples: 0, probability: 0, frequency: 0 }));
  let correct = 0; let brier = 0; let loss = 0;
  for (const [index, probability] of probabilities.entries()) {
    const label = labels[index];
    if ((probability >= 0.5 ? 1 : 0) === label) correct += 1;
    brier += (probability - label) ** 2;
    // Fixed clipping only bounds the reporting logarithm; prediction and fitting use the original probability.
    const clipped = Math.max(1e-12, Math.min(1 - 1e-12, probability));
    loss -= label * Math.log(clipped) + (1 - label) * Math.log1p(-clipped);
    const bin = counts[Math.min(4, Math.floor(probability * 5))];
    bin.samples += 1; bin.probability += probability; bin.frequency += label;
  }
  const samples = labels.length; const mean = correct / samples;
  const epsilon = Math.sqrt(Math.log(40) / (2 * samples));
  return { samples, accuracy: { correct, mean, interval: [Math.max(0, mean - epsilon), Math.min(1, mean + epsilon)] },
    brier: brier / samples, log_loss: loss / samples,
    ece: counts.reduce((sum, bin) => sum + Math.abs(bin.probability - bin.frequency), 0) / samples,
    bins: counts.map((bin) => ({ samples: bin.samples, probability: bin.samples === 0 ? null : bin.probability / bin.samples, frequency: bin.samples === 0 ? null : bin.frequency / bin.samples })) };
}
/** Validate each declared domain before allocating weights or processing rows. */
export function validatePrefixKnobs(knobs: PrefixKnobs): void {
  assert.deepEqual(Object.keys(knobs).sort(), ["hashing_width", "ngram_order", "regularisation"], "prefix_knobs");
  assert.ok(Number.isFinite(knobs.regularisation) && knobs.regularisation >= 0 && knobs.regularisation <= 0.1, "prefix_regularisation");
  assert.ok(Number.isInteger(knobs.ngram_order) && knobs.ngram_order >= 1 && knobs.ngram_order <= 3, "prefix_ngram_order");
  assert.ok(Number.isInteger(knobs.hashing_width) && knobs.hashing_width >= 16 && knobs.hashing_width <= 4096 && (knobs.hashing_width & (knobs.hashing_width - 1)) === 0, "prefix_hashing_width");
}
/** Hash event counts, order n-grams, field changes, elapsed buckets, author count and first-text words. */
export function prefixFeatures(prefix: HistoryPrefix, knobs: PrefixKnobs): number[] {
  validateHistoryPrefix(prefix); validatePrefixKnobs(knobs);
  const values = new Array<number>(knobs.hashing_width).fill(0); values[0] = 1;
  /** Add bounded counts to signed hash buckets, leaving the intercept separate. */
  const add = (token: string, amount = 1): void => {
    const hash = Number.parseInt(hashJson(token).slice(0, 8), 16);
    const index = 1 + hash % (values.length - 1);
    values[index] += (hash % 2 === 0 ? 1 : -1) * amount;
  };
  for (let order = 1; order <= knobs.ngram_order; order += 1) {
    for (let index = order - 1; index < prefix.events.length; index += 1) add(`event:${prefix.events.slice(index + 1 - order, index + 1).join(",")}`);
  }
  for (const field of prefix.fields) add(`field:${field}`);
  for (const word of prefix.words) add(`word:${word}`);
  add(`elapsed:${Math.min(24, Math.floor(Math.log2(1 + prefix.elapsed_ms / 1000)))}`);
  add(`authors:${Math.min(8, prefix.authors)}`);
  for (let index = 1; index < values.length; index += 1) values[index] = Math.sign(values[index]) * Math.log1p(Math.abs(values[index])) / 8;
  return values;
}
/** Canonical checkpoint identity binds finite bounded parameters and the complete feature recipe. */
export function prefixCheckpoint(weights: readonly number[], knobs: PrefixKnobs): PrefixCheckpoint {
  validatePrefixKnobs(knobs);
  assert.ok(weights.length === knobs.hashing_width && weights.every((weight) => Number.isFinite(weight) && Math.abs(weight) <= 20), "prefix_weights");
  return { weights: [...weights], knobs: { ...knobs }, digest: `sha256:${hashJson({ format: "pm-rl/prefix-checkpoint/1", weights: [...weights], knobs } as unknown as JsonValue)}` };
}
/** Compute the shared linear score without changing the existing hard-decision tie rule. */
function prefixLogit(prefix: HistoryPrefix, policy: PrefixCheckpoint): number {
  const features = prefixFeatures(prefix, policy.knobs);
  return features.reduce((total, value, index) => total + value * policy.weights[index], 0);
}
/** Return the uncalibrated logistic probability of slow/class one without fitting on evaluation labels. */
export function prefixProbability(prefix: HistoryPrefix, policy: PrefixCheckpoint): number {
  return 1 / (1 + Math.exp(-prefixLogit(prefix, policy)));
}
/** Keep the existing deterministic decision rule, including the zero-weight tie to slow. */
export function prefixPrediction(prefix: HistoryPrefix, policy: PrefixCheckpoint): "fast" | "slow" {
  return prefixLogit(prefix, policy) >= 0 ? "slow" : "fast";
}
/** Perform exactly one bounded SGD pass over the explicitly budgeted training rows. */
export function fitPrefix(payload: PrefixPayload, source: PrefixCheckpoint, learningRate: number): PrefixCheckpoint {
  validatePrefixKnobs(payload.knobs);
  assert.ok(hashJson(source.knobs as unknown as JsonValue) === hashJson(payload.knobs as unknown as JsonValue), "prefix_source_knobs");
  assert.ok(payload.rows.length > 0 && payload.rows.length <= 512 && Number.isFinite(learningRate) && learningRate >= 0.01 && learningRate <= 1, "prefix_fit_bounds");
  const weights = [...source.weights];
  for (const row of payload.rows) {
    assert.ok(row.label === 0 || row.label === 1, "prefix_fit_label");
    const features = prefixFeatures(row.prefix, payload.knobs);
    const logit = features.reduce((total, value, index) => total + value * weights[index], 0);
    const error = row.label - 1 / (1 + Math.exp(-logit));
    for (let index = 0; index < weights.length; index += 1) weights[index] = Math.max(-20, Math.min(20, weights[index] + learningRate * (error * features[index] - payload.knobs.regularisation * weights[index])));
  }
  return prefixCheckpoint(weights.map((weight) => Math.round(weight * 10_000) / 10_000), payload.knobs);
}
/** Verify schema, digest and feature recipe independently of the fitting process. */
export function validatePrefixCompletion(content: Buffer, completion: Pick<ProcessCompletion<{ readonly digest: string }>, "policy">, input: Pick<ProcessInput, "prefix">): void {
  const policy = JSON.parse(content.toString("utf8")) as PrefixCheckpoint;
  const verified = prefixCheckpoint(policy.weights, policy.knobs);
  assert.equal(policy.digest, verified.digest, "prefix_checkpoint_identity");
  assert.equal(hashJson(policy as unknown as JsonValue), hashJson(completion.policy as unknown as JsonValue), "prefix_receipt_policy");
  assert.equal(hashJson(policy.knobs as unknown as JsonValue), hashJson(input.prefix!.knobs as unknown as JsonValue), "prefix_receipt_knobs");
}
