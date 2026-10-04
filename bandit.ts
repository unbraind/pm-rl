/**
 * A deterministic numerical adapter for recursive execution acceptance.
 *
 * A logistic two-action policy collects an on-policy batch and performs one
 * REINFORCE update from observed rewards. Evaluation examples never enter that
 * gradient. Only a changed checkpoint meeting the declared evaluation and gap
 * bounds supplies the next generation's collection policy. This synchronous
 * adapter does not grant a PM approval, launch jobs, or claim LLM training.
 */
import { createHash } from "node:crypto";

import { decidePromotion, type PromotionCriterion, type PromotionEvidence } from "./promotion.ts";

/** A synthetic contextual bandit example with bounded feature and action rewards. */
export interface BanditExample {
  /** Stable dataset-local identity, disjoint across training and evaluation. */
  readonly id: string;
  /** Scalar observation in [-1, 1] consumed by the logistic policy. */
  readonly feature: number;
  /** Reward for actions zero and one, each in [0, 1]. */
  readonly rewards: readonly [number, number];
}

/** Explicit resource and promotion bounds for this small in-process adapter. */
export interface BanditProgramme {
  /** Examples available to the collector; only sampled rewards train the policy. */
  readonly training: readonly BanditExample[];
  /** Disjoint examples for adaptive validation, never a source of gradients. */
  readonly evaluation: readonly BanditExample[];
  /** Starting scalar weight, bounded to [-20, 20] for numerical stability. */
  readonly initialWeight: number;
  /** Unsigned 32-bit seed for reproducible policy action sampling. */
  readonly seed: number;
  /** Maximum generations, from 1 to 100. */
  readonly generations: number;
  /** Batch size; the entire programme may collect at most 100,000 samples. */
  readonly samplesPerGeneration: number;
  /** Positive gradient-ascent learning rate, at most one. */
  readonly learningRate: number;
  /** Minimum evaluation-score increase required for each promotion. */
  readonly minimumImprovement: number;
  /** Maximum positive training-to-evaluation expected reward gap. */
  readonly maximumGap: number;
  /** Number of held-out evaluation episodes sampled per policy for the promotion gate; 1..100000. */
  readonly evaluationSamples: number;
  /** Confidence level 1-alpha for the promotion gate's Hoeffding bound, in (0, 1). */
  readonly confidence: number;
  /** Minimum sample count the promotion gate requires from each side; a positive integer. */
  readonly minSamples: number;
}

/** A reproducible policy checkpoint whose digest binds format and actual weight. */
export interface BanditCheckpoint {
  /** Scalar policy parameter, changed by the measured reward gradient. */
  readonly weight: number;
  /** SHA-256 of the versioned, canonically serialized checkpoint. */
  readonly digest: string;
}

/** One collected on-policy sample: the example visited, the action the source policy sampled, and the reward the environment returned. */
export interface BanditObservation {
  /** Dataset-local identity of the example this sample drew. */
  readonly example: string;
  /** The action the source policy sampled for that example: zero or one. */
  readonly action: 0 | 1;
  /** The bounded reward the environment returned for the sampled action. */
  readonly reward: number;
}

/** The terminal condition one generation ended a bounded programme with. */
export type BanditStopReason = "unchanged_checkpoint" | "evaluation_rejected" | "gap_rejected";

/** Evidence retained for one collected batch and attempted policy update. */
export interface BanditGeneration {
  /** One-based attempted generation number. */
  readonly generation: number;
  /** Exact checkpoint used to choose this batch's actions. */
  readonly source: BanditCheckpoint;
  /** Actual checkpoint obtained from the batch's policy-gradient update. */
  readonly candidate: BanditCheckpoint;
  /** Identity of the complete ordered observed batch and its source policy. */
  readonly collectionDigest: string;
  /** The complete ordered batch of collected samples, exposing actual collection work. */
  readonly observations: readonly BanditObservation[];
  /** The uint32 LCG state after this batch, so a caller can continue the stream deterministically. */
  readonly randomState: number;
  /** Counts of sampled actions zero and one, exposing actual collection work. */
  readonly actionCounts: readonly [number, number];
  /** Expected reward under the source policy on evaluation examples. */
  readonly baselineScore: number;
  /** Expected reward under the candidate on training examples. */
  readonly trainingScore: number;
  /** Expected reward under the candidate on evaluation examples. */
  readonly evaluationScore: number;
  /** Whether this candidate became the next generation's policy. */
  readonly promoted: boolean;
  /** Empirical mean reward of the incumbent on the sampled held-out evaluation episodes. */
  readonly incumbentHeldOutMean: number;
  /** Empirical mean reward of the candidate on the sampled held-out evaluation episodes. */
  readonly candidateHeldOutMean: number;
  /** The promotion gate's verdict reason; null when promoted, otherwise the recorded refusal. */
  readonly refusalReason: string | null;
  /** The condition this generation terminated the programme with; null when it promoted and the caller continued. */
  readonly stopReason: BanditStopReason | null;
}

/** Inputs for one policy-gradient generation step over validated datasets and bounds. */
export interface BanditStepInput {
  /** Validated training examples; only the sampled actions' rewards enter the gradient. */
  readonly training: readonly BanditExample[];
  /** Validated held-out examples; never a source of gradients. */
  readonly evaluation: readonly BanditExample[];
  /** Content identity of the ordered training examples. */
  readonly trainingDigest: string;
  /** Content identity of the ordered evaluation examples. */
  readonly evaluationDigest: string;
  /** Exact checkpoint whose policy chooses this batch's actions. */
  readonly source: BanditCheckpoint;
  /** One-based generation number, seeding the held-out evaluation streams. */
  readonly generation: number;
  /** Unsigned 32-bit base seed for the derived incumbent and candidate evaluation streams. */
  readonly seed: number;
  /** Incoming uint32 LCG state for this batch's action sampling. */
  readonly randomState: number;
  /** Number of samples this generation collects. */
  readonly samples: number;
  /** Positive gradient-ascent learning rate, at most one. */
  readonly learningRate: number;
  /** Minimum held-out improvement the promotion gate requires. */
  readonly minimumImprovement: number;
  /** Maximum positive training-to-evaluation expected reward gap. */
  readonly maximumGap: number;
  /** Held-out evaluation episodes sampled for the promotion gate's evidence. */
  readonly evaluationSamples: number;
  /** Confidence level 1-alpha for the gate's Hoeffding bound, in (0, 1). */
  readonly confidence: number;
  /** Minimum sample count the gate requires from each side. */
  readonly minSamples: number;
}

/** Both validated datasets with their content identities. */
export interface BanditDatasets {
  /** Validated collection examples, disjoint from the held-out set. */
  readonly training: readonly BanditExample[];
  /** Validated held-out examples, disjoint from the collection set. */
  readonly evaluation: readonly BanditExample[];
  /** Content identity of the ordered training examples. */
  readonly trainingDigest: string;
  /** Content identity of the ordered evaluation examples. */
  readonly evaluationDigest: string;
}

/** Terminal outcome; a rejection always retains the last accepted checkpoint. */
export interface BanditResult {
  /** Identity of algorithm, bounds, configuration and both datasets. */
  readonly programmeDigest: string;
  /** Content identity of the collector's ordered examples. */
  readonly trainingDigest: string;
  /** Content identity of the evaluator's ordered examples. */
  readonly evaluationDigest: string;
  /** Initial versioned checkpoint. */
  readonly initial: BanditCheckpoint;
  /** Last accepted checkpoint, or the initial checkpoint when first rejected. */
  readonly final: BanditCheckpoint;
  /** Attempted generations, including a rejected candidate's complete receipt. */
  readonly generations: readonly BanditGeneration[];
  /** Number of actions actually collected before termination. */
  readonly samplesConsumed: number;
  /** Exact condition that terminated this bounded programme. */
  readonly stopReason: BanditStopReason | "generation_limit";
}

/** Hash a typed, explicitly ordered adapter receipt without timestamps or paths. */
function digest(value: unknown): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}

/** Construct a format-bound identity that changes whenever the real weight does. */
export function banditCheckpoint(weight: number): BanditCheckpoint {
  return { weight, digest: digest({ format: "pm-rl/bandit-checkpoint/1", weight }) };
}

/** Evaluate exact expected reward, avoiding an additional noisy sample budget. */
function evaluate(weight: number, examples: readonly BanditExample[]): number {
  let reward = 0;
  for (const example of examples) {
    const probability = 1 / (1 + Math.exp(-weight * example.feature));
    reward += (1 - probability) * example.rewards[0] + probability * example.rewards[1];
  }
  return reward / examples.length;
}

/**
 * Sample held-out evaluation episodes and return the empirical mean reward.
 *
 * The promotion gate bounds SAMPLED evidence, not the exact expected reward the
 * receipt records for determinism: a single noisy rollout beating the incumbent
 * is not improvement, and a bound over the exact mean would be a bound over a
 * constant. Each episode picks an evaluation example (cycling in declared
 * order), samples an action from the given policy under the supplied LCG seed,
 * and records the reward of the sampled action. The seed makes the empirical
 * mean deterministic, so a replay reproduces it byte-identically.
 *
 * @param weight - The policy parameter to evaluate.
 * @param examples - The held-out evaluation examples.
 * @param samples - Number of episodes to draw.
 * @param seed - Unsigned 32-bit LCG seed for reproducible action sampling.
 * @returns The empirical mean reward over the drawn episodes.
 */
function sampledHeldOutMean(weight: number, examples: readonly BanditExample[], samples: number, seed: number): number {
  let state = seed;
  let total = 0;
  for (let index = 0; index < samples; index += 1) {
    const example = examples[index % examples.length];
    const probability = 1 / (1 + Math.exp(-weight * example.feature));
    state = (Math.imul(1664525, state) + 1013904223) >>> 0;
    const action = state / 0x1_0000_0000 < probability ? 1 : 0;
    total += example.rewards[action];
  }
  return total / samples;
}

/**
 * Validate both datasets and return them with their content identities.
 *
 * One implementation serves the in-process programme and the persisted loop
 * controller, so a dataset a caller validates once cannot be re-validated
 * differently by the kernel that consumes it. Example identities must be
 * unique and disjoint across both sets, features bounded to [-1, 1], and each
 * action reward bounded to [0, 1].
 *
 * @param programme - The programme-shaped input carrying `training` and `evaluation`.
 * @returns Both validated datasets and their ordered content identities.
 * @throws When a dataset is empty, oversized, malformed, or reuses an example identity.
 */
export function validatedBanditDatasets(programme: Pick<BanditProgramme, "training" | "evaluation">): BanditDatasets {
  const identities = new Set<string>();
  const datasets: BanditExample[][] = [];
  for (const dataset of [programme.training, programme.evaluation]) {
    if (dataset.length === 0 || dataset.length > 10_000) throw new Error("bandit_invalid: dataset size must be 1..10000");
    const validated: BanditExample[] = [];
    for (const example of dataset) {
      if (example.id.trim().length === 0 || !Number.isFinite(example.feature) || Math.abs(example.feature) > 1
        || example.rewards.length !== 2
        || [example.rewards[0], example.rewards[1]].some((reward) => !Number.isFinite(reward) || reward < 0 || reward > 1)) {
        throw new Error("bandit_invalid: named examples require bounded features and rewards");
      }
      if (identities.has(example.id)) throw new Error("bandit_overlap: example identities must be unique and disjoint");
      identities.add(example.id);
      validated.push({ id: example.id, feature: example.feature, rewards: [example.rewards[0], example.rewards[1]] });
    }
    datasets.push(validated);
  }
  const [training, evaluation] = datasets;
  return { training, evaluation, trainingDigest: digest(training), evaluationDigest: digest(evaluation) };
}

/**
 * Execute one bounded policy-gradient generation step.
 *
 * The step is the whole numerical kernel of a recursive loop: it collects an
 * on-policy batch from the source policy under the supplied LCG state, applies
 * one REINFORCE update from the observed rewards, evaluates both checkpoints on
 * the held-out set, and renders the promotion gate's verdict. The caller owns
 * bounds and dataset validation, so the step performs no redundant checks and
 * a persisted controller reuses exactly the kernel the in-process programme
 * runs. Evaluation examples never enter the gradient; evaluation is an adaptive
 * promotion set, and independent final benchmarks remain necessary for
 * unbiased claims after repeated selection.
 *
 * @param input - Validated datasets, bounds, the source checkpoint, and the incoming LCG state.
 * @returns The generation's complete receipt, including the advanced LCG state and terminal condition.
 */
export function executeBanditStep(input: BanditStepInput): BanditGeneration {
  const { training, evaluation, trainingDigest, evaluationDigest, source, generation, seed, samples, learningRate, minimumImprovement, maximumGap, evaluationSamples, confidence, minSamples } = input;
  const observations: BanditObservation[] = [];
  const actionCounts: [number, number] = [0, 0];
  let gradient = 0;
  let randomState = input.randomState;
  for (let sample = 0; sample < samples; sample += 1) {
    const example = training[sample % training.length];
    const probability = 1 / (1 + Math.exp(-source.weight * example.feature));
    randomState = (Math.imul(1664525, randomState) + 1013904223) >>> 0;
    const action = (randomState / 0x1_0000_0000 < probability ? 1 : 0) as 0 | 1;
    const reward = example.rewards[action];
    gradient += reward * (action - probability) * example.feature;
    actionCounts[action] += 1;
    observations.push({ example: example.id, action, reward });
  }
  const candidate = banditCheckpoint(source.weight + learningRate * gradient / samples);
  const baselineScore = evaluate(source.weight, evaluation);
  const trainingScore = evaluate(candidate.weight, training);
  const evaluationScore = evaluate(candidate.weight, evaluation);
  const collectionDigest = digest({ source: source.digest, trainingDigest, observations });
  const evidence = {
    generation,
    source,
    candidate,
    collectionDigest,
    observations,
    randomState,
    actionCounts,
    baselineScore,
    trainingScore,
    evaluationScore,
    incumbentHeldOutMean: 0,
    candidateHeldOutMean: 0,
  };
  // The promotion gate bounds SAMPLED held-out evidence, so a single noisy
  // rollout beating the incumbent cannot admit a generation. The incumbent
  // and candidate are evaluated on independent seeded streams: independence
  // is what the Hoeffding bound assumes, and the seeds make the empirical
  // means deterministic. The training and evaluation example identities are
  // validated disjoint by the caller, so the held-out set is structurally
  // unreachable from the gradient; the gate's contamination verdict is null.
  const incumbentSeed = (Math.imul(generation, 0x9E3779B1) + seed) >>> 0;
  const candidateSeed = (incumbentSeed + 0x6D5B5B5D) >>> 0;
  evidence.incumbentHeldOutMean = sampledHeldOutMean(source.weight, evaluation, evaluationSamples, incumbentSeed);
  evidence.candidateHeldOutMean = sampledHeldOutMean(candidate.weight, evaluation, evaluationSamples, candidateSeed);
  if (candidate.digest === source.digest) {
    return { ...evidence, promoted: false,
      refusalReason: "candidate checkpoint unchanged; no policy update to promote", stopReason: "unchanged_checkpoint" };
  }
  if (trainingScore - evaluationScore > maximumGap) {
    return { ...evidence, promoted: false,
      refusalReason: `training-to-evaluation gap ${Math.max(0, trainingScore - evaluationScore).toFixed(6)} exceeds the maximum ${maximumGap}`,
      stopReason: "gap_rejected" };
  }
  if (evaluationScore <= baselineScore) {
    return { ...evidence, promoted: false,
      refusalReason: "candidate does not improve held-out expected reward; statistically better sampled evidence cannot promote a regression or tie",
      stopReason: "evaluation_rejected" };
  }
  const candidateEvidence: PromotionEvidence = {
    generation: `gen-${generation}`, objective: "expected_reward", objective_version: "1",
    evaluation_context: evaluationDigest, direction: "maximize",
    samples: evaluationSamples, mean: evidence.candidateHeldOutMean, rewardBounds: [0, 1],
  };
  const incumbentEvidence: PromotionEvidence = {
    generation: generation === 1 ? "seed" : `gen-${generation - 1}`, objective: "expected_reward", objective_version: "1",
    evaluation_context: evaluationDigest, direction: "maximize",
    samples: evaluationSamples, mean: evidence.incumbentHeldOutMean, rewardBounds: [0, 1],
  };
  const criterion: PromotionCriterion = { confidence, minSamples, effectThreshold: minimumImprovement };
  const verdict = decidePromotion({ candidate: candidateEvidence, incumbent: incumbentEvidence, criterion, contaminationPath: null, expectedGeneration: `gen-${generation}` });
  if (verdict.decision === "promote") {
    return { ...evidence, promoted: true, refusalReason: null, stopReason: null };
  }
  return { ...evidence, promoted: false, refusalReason: verdict.reason, stopReason: "evaluation_rejected" };
}

/**
 * Execute real bounded policy-gradient generations without external processes.
 *
 * Inputs are validated before collection. The uint32 LCG makes every selected
 * action reproducible. Each generation delegates to {@link executeBanditStep},
 * so the in-process programme and the persisted loop controller run one
 * numerical kernel. A rejected candidate always retains the last accepted
 * checkpoint as the next collection policy.
 */
export function runBanditProgramme(programme: BanditProgramme): BanditResult {
  const { initialWeight, seed, generations, samplesPerGeneration, learningRate, minimumImprovement, maximumGap, evaluationSamples, confidence, minSamples } = programme;
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffff_ffff
    || !Number.isInteger(generations) || generations < 1 || generations > 100
    || !Number.isInteger(samplesPerGeneration) || samplesPerGeneration < 1
    || generations * samplesPerGeneration > 100_000
    || !Number.isFinite(initialWeight) || Math.abs(initialWeight) > 20
    || !Number.isFinite(learningRate) || learningRate <= 0 || learningRate > 1
    || !Number.isFinite(minimumImprovement) || minimumImprovement < 0
    || !Number.isFinite(maximumGap) || maximumGap < 0
    || !Number.isInteger(evaluationSamples) || evaluationSamples < 1 || evaluationSamples > 100_000
    || !Number.isFinite(confidence) || confidence <= 0 || confidence >= 1
    || !Number.isInteger(minSamples) || minSamples < 1) {
    throw new Error("bandit_invalid: finite policy, seed, sample and promotion bounds required");
  }
  const { training: collector, evaluation: evaluator, trainingDigest, evaluationDigest } = validatedBanditDatasets(programme);
  const programmeDigest = digest({ format: "pm-rl/bandit-programme/1", trainingDigest, evaluationDigest,
    initialWeight, seed, generations, samplesPerGeneration, learningRate, minimumImprovement, maximumGap, evaluationSamples, confidence, minSamples });
  const initial = banditCheckpoint(initialWeight);
  let current = initial;
  let randomState = seed;
  let stopReason: BanditResult["stopReason"] = "generation_limit";
  const receipts: BanditGeneration[] = [];
  for (let generation = 1; generation <= generations; generation += 1) {
    const step = executeBanditStep({ training: collector, evaluation: evaluator, trainingDigest, evaluationDigest,
      source: current, generation, seed, randomState, samples: samplesPerGeneration,
      learningRate, minimumImprovement, maximumGap, evaluationSamples, confidence, minSamples });
    randomState = step.randomState;
    receipts.push(step);
    if (step.promoted) {
      current = step.candidate;
      continue;
    }
    stopReason = step.stopReason!;
    break;
  }
  return { programmeDigest, trainingDigest, evaluationDigest, initial, final: current,
    generations: receipts, samplesConsumed: receipts.length * samplesPerGeneration, stopReason };
}
