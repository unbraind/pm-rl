/** Inner history-prefix fits and final majority testing behind sealed evaluator capabilities. */
import assert from "node:assert/strict";
import type { PmClient } from "@unbrained/pm-cli/sdk/core";
import { hashJson, type JsonValue } from "./index.ts";
import { readTrackerSplit, type TrackerDataset, type TrackerExample } from "./dataset.ts";
import { compareRecipes, type MetaConfig, type RecipePolicy } from "./meta.ts";
import { prefixCheckpoint, prefixPrediction } from "./prefix.ts";
import { prefixTrainerArgv } from "./prefix-trainer.ts";
import { executeProcessTrainer, transitionProcessJob, type ProcessCoordinates, type ProcessInput } from "./process.ts";
import type { Recipe } from "./recipe.ts";

/** Exact-match accuracy counts each held-out item once, independent of the training sample budget. */
export function prefixAccuracy(examples: readonly TrackerExample[], policy: RecipePolicy): number {
  assert.ok(examples.length > 0 && policy.prefix !== undefined, "prefix_score_inputs");
  return examples.filter((example) => prefixPrediction(example.history!, policy.prefix!) === example.label).length / examples.length;
}
/** Materialize one actual fit inside the reserved process contract and retain every rejection explicitly. */
export async function fitHistoryPrefix(client: PmClient, coordinates: ProcessCoordinates, directory: string, manifest: TrackerDataset, config: MetaConfig, approval: string, recipe: Recipe, id: string, signal: AbortSignal): Promise<RecipePolicy> {
  const knobs = recipe.knobs.prefix;
  assert.ok(knobs !== undefined && config.adapter.kind === "process-bandit", "prefix_recipe_required");
  const training = readTrackerSplit(directory, manifest, "train");
  const evaluation = readTrackerSplit(directory, manifest, "inner-held-out");
  assert.ok(!training.some((row) => evaluation.some((held) => held.id === row.id)), "prefix_inner_overlap");
  let selected = [...training];
  if (recipe.knobs.selection === "balanced") {
    const fast = selected.filter((row) => row.label === "fast"); const slow = selected.filter((row) => row.label === "slow");
    const count = Math.min(fast.length, slow.length);
    assert.ok(count > 0, "prefix_balanced_class_missing");
    selected = Array.from({ length: count }, (_, index) => [fast[index], slow[index]]).flat();
  }
  if (recipe.knobs.curriculum === "reverse") selected.reverse();
  const source = prefixCheckpoint(new Array<number>(knobs.hashing_width).fill(0), knobs);
  const rows = Array.from({ length: recipe.knobs.steps * recipe.knobs.batch }, (_, index) => {
    const example = selected[index % selected.length];
    return { prefix: example.history!, label: example.label === "slow" ? 1 as const : 0 as const };
  });
  const input: ProcessInput<typeof source> = {
    identity: { programme_id: id, programme: recipe.digest, dataset: manifest.digest, criterion: config.criterion as unknown as JsonValue, maximum_gap: config.maximum_gap }, source, training: [], observations: [],
    training_config: { learning_rate: recipe.knobs.learning_rate, steps: 1 },
    lineage: { training: manifest.splits.train.digest, held_out: manifest.splits["inner-held-out"].digest, collection: hashJson(rows as unknown as JsonValue) },
    prefix: { rows, knobs },
  };
  const job = await executeProcessTrainer(client, coordinates, input, approval, config.adapter, signal, prefixTrainerArgv());
  assert.ok(job.completion !== null, "prefix_fit_receipt_required");
  const candidate: RecipePolicy = { recipe, weight: 0, checkpoint: job.completion.policy.digest, prefix: job.completion.policy };
  const seed: RecipePolicy = { recipe, weight: 0, checkpoint: source.digest, prefix: source };
  const context = manifest.splits["inner-held-out"].digest;
  const score = { mean: prefixAccuracy(evaluation, candidate), samples: evaluation.length, context };
  const baseline = { ...score, mean: prefixAccuracy(evaluation, seed) };
  const comparison = compareRecipes(candidate, seed, score, baseline, config.criterion, "checkpoint");
  const changed = candidate.checkpoint !== seed.checkpoint;
  const gap = prefixAccuracy(training, candidate) - score.mean;
  const refusal = gap > config.maximum_gap ? "gap_rejected" : comparison.verdict.decision === "promote" ? null : comparison.verdict.reason;
  const accepted = refusal === null;
  const predictions = evaluation.map((example) => prefixPrediction(example.history!, candidate.prefix!));
  const fit = { job: job.id, changed, accepted, gain: comparison.gain, gain_lower_bound: comparison.gain_lower_bound,
    refusal, candidate: candidate.prefix!, samples: evaluation.length, mean: score.mean, baseline: baseline.mean,
    predictions: { fast: predictions.filter((label) => label === "fast").length, slow: predictions.filter((label) => label === "slow").length } };
  const evaluated = job.state === "materialized" ? await transitionProcessJob(client, coordinates, job, "evaluated", refusal ?? "inner_gate_accepted") : job;
  if (accepted && evaluated.state === "evaluated") await transitionProcessJob(client, coordinates, evaluated, "promoted", "inner_gate_accepted");
  await client.update(job.id, { comment: [`History-prefix fit ${id}: changed=${changed}, accepted=${accepted}, gain=${fit.gain}, lower_bound=${fit.gain_lower_bound}, refusal=${refusal ?? "none"}.`] });
  return { ...(accepted ? candidate : seed), fit };
}

/** One-sided exact binomial tail against the training-majority classifier's observed final accuracy. */
export function majorityBinomial(correct: number, samples: number, baselineAccuracy: number): { p_value: number; beats_majority: boolean; baseline_accuracy: number; accuracy_lower_bound: number } {
  assert.ok(Number.isInteger(samples) && samples > 0 && Number.isInteger(correct) && correct >= 0 && correct <= samples && baselineAccuracy >= 0 && baselineAccuracy <= 1, "prefix_binomial_inputs");
  let probability: number;
  if (baselineAccuracy === 0) probability = correct > 0 ? 0 : 1;
  else if (baselineAccuracy === 1) probability = 1;
  else {
    let logChoose = 0;
    for (let index = 1; index <= correct; index += 1) logChoose += Math.log(samples + 1 - index) - Math.log(index);
    let logTerm = logChoose + correct * Math.log(baselineAccuracy) + (samples - correct) * Math.log1p(-baselineAccuracy);
    let largest = logTerm; let scaled = 1;
    for (let index = correct; index < samples; index += 1) {
      logTerm += Math.log(samples - index) - Math.log(index + 1) + Math.log(baselineAccuracy) - Math.log1p(-baselineAccuracy);
      if (logTerm > largest) { scaled = scaled * Math.exp(largest - logTerm) + 1; largest = logTerm; }
      else scaled += Math.exp(logTerm - largest);
    }
    probability = Math.exp(largest) * scaled;
  }
  return { p_value: Math.min(1, probability), beats_majority: correct / samples > baselineAccuracy && probability < 0.05,
    baseline_accuracy: baselineAccuracy, accuracy_lower_bound: Math.max(0, correct / samples - Math.sqrt(Math.log(20) / (2 * samples))) };
}

/** Require advantage over both predeclared constant classifiers using paired tests and simultaneous gain bounds. */
export function prefixMajorityComparison(examples: readonly TrackerExample[], policy: RecipePolicy): {
  readonly p_value: number; readonly beats_majority: boolean; readonly baseline_accuracy: number;
  readonly accuracy_lower_bound: number; readonly wins: number; readonly losses: number; readonly gain_lower_bound: number;
} {
  const accuracy = prefixAccuracy(examples, policy);
  const fast = examples.filter((example) => example.label === "fast").length;
  const majority = fast >= examples.length - fast ? "fast" : "slow";
  const baseline = Math.max(fast, examples.length - fast) / examples.length;
  const predictions = examples.map((example) => prefixPrediction(example.history!, policy.prefix!));
  const wins = examples.filter((example, index) => predictions[index] === example.label && majority !== example.label).length;
  const losses = examples.filter((example, index) => predictions[index] !== example.label && majority === example.label).length;
  const constantTests = ["fast", "slow"].map((constant) => {
    const better = examples.filter((example, index) => predictions[index] === example.label && constant !== example.label).length;
    const worse = examples.filter((example, index) => predictions[index] !== example.label && constant === example.label).length;
    return better + worse === 0 ? 1 : majorityBinomial(better, better + worse, 0.5).p_value;
  });
  const pValue = Math.max(...constantTests);
  return { p_value: pValue, beats_majority: accuracy > baseline && pValue < 0.05, baseline_accuracy: baseline,
    accuracy_lower_bound: Math.max(0, accuracy - Math.sqrt(Math.log(20) / (2 * examples.length))), wins, losses,
    gain_lower_bound: (wins - losses) / examples.length - Math.sqrt(2 * Math.log(40) / examples.length) };
}
