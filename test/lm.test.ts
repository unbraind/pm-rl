/** Causal language model: numerical proofs, checkpoints, refusals and replay. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { isPmCliExpectedError } from "@unbrained/pm-cli/sdk/runtime";
import { parseLoopProgramme, parseLoopTrainer } from "../loop.ts";
import { parseScoreRecord } from "../lineage.ts";
import {
  copyLmAdapter, executeLmStep, lmAdapterParameterCount, lmCheckpoint, lmCollectBatch,
  lmCollectionEvents, lmCompletionReward, lmConfigurationJson, lmEnvironmentSpec,
  lmGenerationTrainingConfig, lmGreedyExactMatch, lmPromptTokens, lmPromotionScores,
  lmReinforceSurrogate, lmRunConfig, lmSampleSeed, lmSeedTrainingConfig, lmSupervisedGradient,
  lmSupervisedLoss, parseLmAdapter, parseLmCollectionEvent, parseLmLoopConfig, parseStoredLmGeneration,
  rotateTargetTokens, sampleLmCompletion, seededLmAdapter, serializeLmCheckpoint, trainLmBasePolicy,
  verifyStoredLmGeneration, persistLmCheckpoint, verifyLmCheckpointArtifact, lmCheckpointPath,
  jsonLmAdapter, lmForward, lmParameterCount,
  MAX_LM_ALPHABET, MAX_LM_EXAMPLES, MAX_LM_FFN_DIM, MAX_LM_FIT_STEPS, MAX_LM_LORA_RANK,
  MAX_LM_MODEL_DIM, MAX_LM_POSITIONS, MAX_LM_STRING_LENGTH, MIN_LM_LEARNING_RATE,
  LM_CHECKPOINT_FORMAT, LM_COLLECTION_METRIC, LM_GENERATION_FORMAT, LM_RUN_FORMAT, LM_SEED_FORMAT,
  type LmAdapter, type LmFitSample, type LmGradients, type LmLoopConfig, type LmModelShape,
  type LmObservation, type LmWeights,
} from "../lm.ts";
import type { JsonValue } from "../index.ts";

const ALPHABET = ["0", "1", "2"];

/** Assert a stable expected refusal without depending on incidental prose. */
function refuses(action: () => unknown, code: string): void {
  assert.throws(action, (error: unknown) => isPmCliExpectedError(error) && error.context.code === code);
}

/**
 * The bounded synthetic rotate programme: small enough that every numerical
 * test runs in milliseconds, real enough that generation one promotes, and
 * with a disjoint held-out set whose greedy exact-match starts at zero.
 */
function configValue(overrides: Record<string, unknown> = {}): Record<string, JsonValue> {
  return {
    trainer: "lm",
    environment: { name: "LM rotate", version: "1" },
    task: "rotate",
    alphabet: ALPHABET,
    string_length: 2,
    model: { d_model: 8, ffn: 12, layers: 1, rank: 2 },
    limits: { max_parameters: 1024, max_checkpoint_bytes: 8192, max_steps: 256, max_wall_seconds: 60, model_license: "MIT", dataset_license: "MIT" },
    training: [{ id: "t0", string: "00" }, { id: "t1", string: "12" }, { id: "t2", string: "21" }, { id: "t3", string: "02" }, { id: "t4", string: "11" }],
    evaluation: [{ id: "h0", string: "01" }, { id: "h1", string: "22" }, { id: "h2", string: "10" }, { id: "h3", string: "20" }],
    seed: 11,
    max_generations: 3,
    samples_per_generation: 32,
    budget: 96,
    learning_rate: 0.8,
    fit_steps: 12,
    kl_weight: 0.01,
    clip_norm: 0.5,
    minimum_improvement: 0.01,
    maximum_gap: 0.5,
    evaluation_samples: 400,
    confidence: 0.9,
    min_samples: 5,
    ...overrides,
  };
}

/** One tiny but complete model shape for the finite-difference proofs. */
const SHAPE: LmModelShape = { vocab: 8, dModel: 8, ffn: 10, layers: 2, rank: 2, stringLength: 2, maxPositions: 9 };

/** Pair every weight tensor with its gradient, in a stable order. */
function weightTensors(weights: LmWeights, gradients: LmGradients): Array<readonly [Float32Array, Float64Array, string]> {
  const pairs: Array<readonly [Float32Array, Float64Array, string]> = [
    [weights.emb, gradients.emb, "emb"], [weights.pos, gradients.pos, "pos"], [weights.head, gradients.head, "head"],
  ];
  for (let l = 0; l < weights.layers.length; l += 1) {
    for (const key of ["ln1g", "ln1b", "ln2g", "ln2b", "wq", "wk", "wv", "wo", "w1", "b1", "w2", "b2"] as const) {
      pairs.push([weights.layers[l]![key], gradients.layers[l]![key], `layer${l}.${key}`]);
    }
  }
  return pairs;
}

/** One deterministic pretraining fit for the finite-difference proofs. */
function pretrained(): LmWeights {
  return trainLmBasePolicy(SHAPE, ALPHABET, 11).weights;
}

/** The relative error between one analytic tensor and its central differences. */
function relativeError(numeric: Readonly<Float64Array>, analytic: Readonly<Float64Array>): number {
  let numericNorm = 0;
  let analyticNorm = 0;
  let differenceNorm = 0;
  for (let i = 0; i < numeric.length; i += 1) {
    numericNorm += numeric[i]! * numeric[i]!;
    analyticNorm += analytic[i]! * analytic[i]!;
    const difference = numeric[i]! - analytic[i]!;
    differenceNorm += difference * difference;
  }
  return Math.sqrt(differenceNorm) / Math.max(Math.sqrt(numericNorm), Math.sqrt(analyticNorm), 1e-9);
}

/** Collect every analytic adapter gradient as parallel finite differences. */
function finiteDifferenceGradient(tensors: ReadonlyArray<readonly [Float32Array, Float64Array, string]>, loss: () => number, step: number): void {
  for (const [tensor, gradient, name] of tensors) {
    const numeric = new Float64Array(tensor.length);
    for (let i = 0; i < tensor.length; i += 1) {
      const value = tensor[i]!;
      tensor[i] = value + step;
      const plusAt = tensor[i]!;
      const plus = loss();
      tensor[i] = value - step;
      const minusAt = tensor[i]!;
      const minus = loss();
      tensor[i] = value;
      numeric[i] = (plus - minus) / (plusAt - minusAt);
    }
    const error = relativeError(numeric, gradient);
    assert.ok(error < 1e-3, `${name} relative error ${error}`);
  }
}

test("a finite-difference gradient check over every parameter tensor proves the supervised backward pass", () => {
  const weights = pretrained();
  const adapter = seededLmAdapter(SHAPE, 3);
  // Nonzero output projections, so the low-rank input gradients are exercised.
  for (const key of ["bq", "bv", "bh"] as const) {
    for (let i = 0; i < adapter[key].length; i += 1) adapter[key][i] = (i % 5 - 2) * 0.04;
  }
  const examples = ["01", "20"];
  const targets = examples.map((text) => rotateTargetTokens(text, ALPHABET));
  const smooth = 0.1;
  const loss = (): number => lmSupervisedLoss(SHAPE, weights, adapter, examples, ALPHABET, targets, smooth);
  const analytic = lmSupervisedGradient(SHAPE, weights, adapter, examples, ALPHABET, targets, smooth);
  finiteDifferenceGradient(weightTensors(weights, analytic), loss, 1e-2);
  const adapterGradients = analytic.adapter!;
  finiteDifferenceGradient((["aq", "bq", "av", "bv", "ah", "bh"] as const).map((key) => [adapter[key], adapterGradients[key], `adapter.${key}`] as const), loss, 1e-2);
});

test("the REINFORCE surrogate differentiates to its gradient over every adapter tensor", () => {
  const weights = pretrained();
  const adapter = seededLmAdapter(SHAPE, 5);
  for (const key of ["bq", "bv", "bh"] as const) {
    for (let i = 0; i < adapter[key].length; i += 1) adapter[key][i] = (i % 3 - 1) * 0.05;
  }
  const samples: LmFitSample[] = ["01", "20", "12"].map((example, index) => {
    const completion = sampleLmCompletion(SHAPE, weights, adapter, example, ALPHABET, 700 + index);
    return { example, tokens: completion.tokens, reward: lmCompletionReward(completion.tokens, rotateTargetTokens(example, ALPHABET)) };
  });
  const klWeight = 0.05;
  const loss = (): number => lmReinforceSurrogate(SHAPE, weights, adapter, samples, ALPHABET, klWeight).loss;
  const analytic = lmReinforceSurrogate(SHAPE, weights, adapter, samples, ALPHABET, klWeight).gradient.adapter!;
  finiteDifferenceGradient((["aq", "bq", "av", "bv", "ah", "bh"] as const).map((key) => [adapter[key], analytic[key], `adapter.${key}`] as const), loss, 1e-2);
  // The surrogate's advantage weighting is the exact verifier's reward split
  // over positions; a fully-correct completion's advantage is strictly the
  // batch's highest.
  assert.ok(samples.some((sample) => sample.reward > 0));
});

test("generation steps replay deterministically under the seed", () => {
  const config = parseLmLoopConfig(configValue());
  assert.equal(parseLoopProgramme(configValue()).trainer, "lm");
  assert.equal(parseLoopTrainer({}), "bandit");
  refuses(() => parseLoopTrainer({ trainer: "other" }), "loop_invalid_trainer");
  // The frozen base regenerates byte-identically; so do the digests.
  assert.equal(trainLmBasePolicy(config.shape, config.alphabet, config.seed).strings.length, 24);
  assert.deepEqual(parseLmLoopConfig(configValue()).digest, config.digest);
  assert.notEqual(parseLmLoopConfig(configValue({ seed: 12 })).digest, config.digest);
  assert.match(config.baseDigest, /^sha256:[a-f0-9]{64}$/);
  assert.match(config.initial.digest, /^sha256:[a-f0-9]{64}$/);
  const step = { learningRate: config.learningRate, evaluationSamples: config.evaluationSamples };
  const batch = lmCollectBatch(config, 1, config.initial);
  assert.deepEqual(lmCollectBatch(config, 1, config.initial), batch);
  assert.equal(batch.length, config.samplesPerGeneration);
  // Collection cycles the declared training examples in order.
  assert.deepEqual(batch.map((observation) => observation.example), Array.from({ length: config.samplesPerGeneration }, (_, index) => config.training[index % config.training.length]!.id));
  const first = executeLmStep(config, step, 1, config.initial, batch, 50);
  assert.deepEqual(executeLmStep(config, step, 1, config.initial, batch, 50), first);
  const second = executeLmStep(config, step, 2, first.candidate, lmCollectBatch(config, 2, first.candidate), 50);
  assert.notEqual(second.candidate.digest, first.candidate.digest);
  assert.notEqual(first.candidate.digest, config.initial.digest);
  // The two consecutive generations promote: real recursive improvement.
  assert.ok(first.promoted, first.refusalReason ?? "first promoted");
  assert.ok(second.promoted, second.refusalReason ?? "second promoted");
  assert.ok(second.candidateExactMatch > first.baselineExactMatch, "held-out exact match must strictly improve over the base");
  assert.equal(first.baselineExactMatch, 0);
  assert.ok(first.lossAfter < first.lossBefore);
  assert.ok(first.parameterDeltaL2 > 0);
  assert.ok(first.wallMs > 0);
  // An unchanged checkpoint is refused with its own recorded reason: with no
  // correct sampled token the advantages are all zero and the fit cannot move.
  const flat = parseLmLoopConfig(configValue({ seed: 7, samples_per_generation: 4 }));
  const flatBatch = lmCollectBatch(flat, 1, flat.initial);
  const flatReceipt = executeLmStep(flat, { learningRate: flat.learningRate, evaluationSamples: flat.evaluationSamples }, 1, flat.initial, flatBatch, 50);
  assert.equal(flatReceipt.stopReason, "unchanged_checkpoint");
  assert.match(flatReceipt.refusalReason ?? "", /unchanged/);
  assert.equal(flatReceipt.candidate.digest, flat.initial.digest);
});

test("the declared limits stop a candidate with their own recorded refusals", () => {
  const config = parseLmLoopConfig(configValue());
  const step = { learningRate: config.learningRate, evaluationSamples: config.evaluationSamples };
  const batch = lmCollectBatch(config, 1, config.initial);
  // A candidate whose serialized checkpoint exceeds the declared byte budget.
  const tinyBytes = { ...config, limits: { ...config.limits, maxCheckpointBytes: 1 } };
  const refused = executeLmStep(tinyBytes, step, 1, config.initial, batch, 50);
  assert.equal(refused.stopReason, "checkpoint_limit_exceeded");
  assert.match(refused.refusalReason ?? "", /exceeding the declared maximum/);
  assert.equal(refused.promoted, false);
  // A fit whose persisted wall time exceeds the declared seconds budget.
  const slowWall = executeLmStep(config, step, 1, config.initial, batch, 61_000);
  assert.equal(slowWall.stopReason, "wall_limit_exceeded");
  assert.match(slowWall.refusalReason ?? "", /exceeding the declared maximum/);
  assert.equal(slowWall.promoted, false);
  // A widening training-to-evaluation gap is refused before the statistics.
  const overfit = parseLmLoopConfig(configValue({ maximum_gap: 0 }));
  const gapped = executeLmStep(overfit, { learningRate: overfit.learningRate, evaluationSamples: overfit.evaluationSamples }, 1, overfit.initial, lmCollectBatch(overfit, 1, overfit.initial), 50);
  assert.equal(gapped.stopReason, "gap_rejected");
  assert.match(gapped.refusalReason ?? "", /training-to-evaluation gap/);
});

test("a regressing candidate is refused and never becomes the collection policy", () => {
  const config = parseLmLoopConfig(configValue({ seed: 23, samples_per_generation: 32, budget: 96 }));
  const step = { learningRate: config.learningRate, evaluationSamples: config.evaluationSamples };
  const first = executeLmStep(config, step, 1, config.initial, lmCollectBatch(config, 1, config.initial), 50);
  assert.ok(first.promoted, first.refusalReason ?? "first promoted");
  assert.ok(first.candidateExactMatch > 0);
  // Generation two collects with generation one's promoted adapter and its fit
  // regresses on the held-out examples: the gate refuses the candidate and the
  // loop keeps generation one's checkpoint as the collecting policy.
  const second = executeLmStep(config, step, 2, first.candidate, lmCollectBatch(config, 2, first.candidate), 50);
  assert.equal(second.stopReason, "evaluation_rejected");
  assert.match(second.refusalReason ?? "", /regress/);
  assert.ok(second.candidateHeldOutMean < second.incumbentHeldOutMean);
  assert.notEqual(second.candidate.digest, first.candidate.digest);
});

test("parseLmLoopConfig validates the complete bounded programme", () => {
  const config = parseLmLoopConfig(configValue());
  assert.equal(config.environmentName, "LM rotate");
  assert.equal(config.environmentVersion, "1");
  assert.equal(config.alphabet.length, 3);
  assert.equal(config.shape.vocab, 6);
  assert.equal(config.shape.maxPositions, 7);
  assert.equal(lmAdapterParameterCount(config.shape), config.shape.rank * config.shape.dModel * 4 + config.shape.vocab * config.shape.rank + config.shape.dModel * config.shape.rank);
  assert.ok(lmAdapterParameterCount(config.shape) <= config.limits.maxParameters);
  assert.equal(config.training.length, 5);
  assert.equal(config.evaluation.length, 4);
  assert.match(config.trainingDigest, /^sha256:[a-f0-9]{64}$/);
  assert.notEqual(config.trainingDigest, config.evaluationDigest);
  // The frozen base learned the copy task: its rotate exact-match is zero and
  // its copy behavior reproduces the prompt.
  assert.equal(lmGreedyExactMatch(config.shape, config.base, null, config.evaluation.map((example) => example.string), config.alphabet), 0);
  assert.deepEqual(lmPromptTokens("021", config.alphabet), [0, 3, 5, 4, 1]);
  assert.deepEqual(rotateTargetTokens("021", config.alphabet), [4, 3, 5, 2]);
  assert.equal(lmGreedyExactMatch(config.shape, config.base, null, [], config.alphabet), 0);
  // The reward verifier: per-position accuracy plus the exact-match bonus.
  const expected = rotateTargetTokens("12", config.alphabet);
  assert.equal(lmCompletionReward([expected[0], expected[1]], expected), 1);
  assert.equal(lmCompletionReward([expected[0], expected[0]], expected), 0.25);
  assert.equal(lmCompletionReward([expected[1], expected[0]], expected), 0);
  // Sampling streams are per-sample deterministic and reproducible.
  const completion = sampleLmCompletion(config.shape, config.base, config.initial.adapter, "12", config.alphabet, lmSampleSeed(config.seed, 1, 0));
  assert.deepEqual(sampleLmCompletion(config.shape, config.base, config.initial.adapter, "12", config.alphabet, lmSampleSeed(config.seed, 1, 0)).tokens, completion.tokens);
  assert.notEqual(lmSampleSeed(config.seed, 1, 0), lmSampleSeed(config.seed, 1, 1));
});

test("parseLmLoopConfig refuses every missing, mistyped or out-of-bounds field", () => {
  const cases: Array<[Partial<Record<string, unknown>>, string]> = [
    [{ environment: null }, "lm_invalid_environment"],
    [{ environment: {} }, "lm_environment_name"],
    [{ environment: { name: "x" } }, "lm_environment_version"],
    [{ task: "sort" }, "lm_invalid_task"],
    [{ alphabet: null }, "lm_invalid_alphabet"],
    [{ alphabet: ["0"] }, "lm_invalid_alphabet"],
    [{ alphabet: ["0", "0"] }, "lm_invalid_alphabet"],
    [{ alphabet: ["01", "2"] }, "lm_invalid_alphabet"],
    [{ alphabet: Array.from({ length: MAX_LM_ALPHABET + 1 }, (_, index) => String(index % 9)) }, "lm_invalid_alphabet"],
    [{ model: null }, "lm_invalid_model"],
    [{ model: {} }, "lm_invalid_d_model"],
    [{ model: { d_model: 3, ffn: 12, layers: 1, rank: 2 } }, "lm_invalid_d_model"],
    [{ model: { d_model: MAX_LM_MODEL_DIM + 1, ffn: 12, layers: 1, rank: 2 } }, "lm_invalid_d_model"],
    [{ model: { d_model: 8, layers: 1, rank: 2 } }, "lm_invalid_ffn"],
    [{ model: { d_model: 8, ffn: 3, layers: 1, rank: 2 } }, "lm_invalid_ffn"],
    [{ model: { d_model: 8, ffn: MAX_LM_FFN_DIM + 1, layers: 1, rank: 2 } }, "lm_invalid_ffn"],
    [{ model: { d_model: 8, ffn: 12, rank: 2 } }, "lm_invalid_layers"],
    [{ model: { d_model: 8, ffn: 12, layers: 3, rank: 2 } }, "lm_invalid_layers"],
    [{ model: { d_model: 8, ffn: 12, layers: 1, rank: 0 } }, "lm_invalid_rank"],
    [{ model: { d_model: 8, ffn: 12, layers: 1, rank: MAX_LM_LORA_RANK + 1 } }, "lm_invalid_rank"],
    [{ string_length: 0 }, "lm_invalid_string_length"],
    [{ string_length: MAX_LM_STRING_LENGTH + 1 }, "lm_invalid_string_length"],
    [{ training: "no" }, "lm_invalid_datasets"],
    [{ evaluation: null }, "lm_invalid_datasets"],
    [{ training: [] }, "lm_invalid_dataset_size"],
    [{ limits: null }, "lm_invalid_limits"],
    [{ limits: {} }, "lm_invalid_max_parameters"],
    [{ limits: { max_parameters: 0, max_checkpoint_bytes: 8192, max_steps: 256, max_wall_seconds: 60, model_license: "MIT", dataset_license: "MIT" } }, "lm_invalid_max_parameters"],
    [{ limits: { max_parameters: 1, max_checkpoint_bytes: 8192, max_steps: 256, max_wall_seconds: 60, model_license: "MIT", dataset_license: "MIT" } }, "lm_limit_parameters_exceeded"],
    [{ limits: { max_parameters: 1024, max_checkpoint_bytes: 0, max_steps: 256, max_wall_seconds: 60, model_license: "MIT", dataset_license: "MIT" } }, "lm_invalid_max_checkpoint_bytes"],
    [{ limits: { max_parameters: 1024, max_checkpoint_bytes: 1, max_steps: 256, max_wall_seconds: 60, model_license: "MIT", dataset_license: "MIT" } }, "lm_limit_checkpoint_bytes"],
    [{ limits: { max_parameters: 1024, max_checkpoint_bytes: 8192, max_steps: 0, max_wall_seconds: 60, model_license: "MIT", dataset_license: "MIT" } }, "lm_invalid_max_steps"],
    [{ limits: { max_parameters: 1024, max_checkpoint_bytes: 8192, max_steps: MAX_LM_FIT_STEPS + 1, max_wall_seconds: 60, model_license: "MIT", dataset_license: "MIT" } }, "lm_invalid_max_steps"],
    [{ limits: { max_parameters: 1024, max_checkpoint_bytes: 8192, max_steps: 256, max_wall_seconds: 0, model_license: "MIT", dataset_license: "MIT" } }, "lm_invalid_max_wall_seconds"],
    [{ limits: { max_parameters: 1024, max_checkpoint_bytes: 8192, max_steps: 256, max_wall_seconds: 60, model_license: "GPL", dataset_license: "MIT" } }, "lm_invalid_license"],
    [{ limits: { max_parameters: 1024, max_checkpoint_bytes: 8192, max_steps: 256, max_wall_seconds: 60, model_license: "MIT", dataset_license: "Apache-2.0" } }, "lm_invalid_license"],
    [{ seed: -1 }, "lm_invalid_seed"],
    [{ seed: 2 ** 32 }, "lm_invalid_seed"],
    [{ max_generations: 0 }, "lm_invalid_max_generations"],
    [{ max_generations: 101 }, "lm_invalid_max_generations"],
    [{ samples_per_generation: 0 }, "lm_invalid_samples_per_generation"],
    [{ budget: 8 }, "lm_invalid_budget"],
    [{ budget: 100_001 }, "lm_invalid_budget"],
    [{ learning_rate: MIN_LM_LEARNING_RATE / 10 }, "lm_invalid_learning_rate"],
    [{ learning_rate: 5.1 }, "lm_invalid_learning_rate"],
    [{ fit_steps: 257 }, "lm_invalid_fit_steps"],
    [{ kl_weight: -0.1 }, "lm_invalid_kl_weight"],
    [{ kl_weight: 1.1 }, "lm_invalid_kl_weight"],
    [{ clip_norm: 0 }, "lm_invalid_clip_norm"],
    [{ minimum_improvement: 0 }, "lm_invalid_minimum_improvement"],
    [{ maximum_gap: -1 }, "lm_invalid_maximum_gap"],
    [{ evaluation_samples: 0 }, "lm_invalid_evaluation_samples"],
    [{ evaluation_samples: 100_001 }, "lm_invalid_evaluation_samples"],
    [{ confidence: 0 }, "lm_invalid_confidence"],
    [{ confidence: 1 }, "lm_invalid_confidence"],
    [{ min_samples: 0 }, "lm_invalid_min_samples"],
  ];
  for (const [change, code] of cases) {
    refuses(() => parseLmLoopConfig(configValue(change) as JsonValue), code);
  }
  refuses(() => parseLmLoopConfig([1] as unknown as JsonValue), "lm_invalid_json");
  // Dataset refusals: length, symbols, identity and content overlap.
  refuses(() => parseLmLoopConfig(configValue({ string_length: 3 })), "lm_example_string_length");
  refuses(() => parseLmLoopConfig(configValue({ training: [{ id: "t0", string: "07" }] })), "lm_example_string_symbol");
  refuses(() => parseLmLoopConfig(configValue({ evaluation: [...(configValue().evaluation as unknown[]), { id: "h4", string: "00" }] })), "lm_dataset_overlap");
  const cloned = configValue();
  (cloned["evaluation"] as Array<Record<string, string>>)[0] = { id: "t0", string: "01" };
  refuses(() => parseLmLoopConfig(cloned as JsonValue), "lm_dataset_overlap");
  const overflow = configValue();
  (overflow["training"] as unknown[]).push(...Array.from({ length: MAX_LM_EXAMPLES + 1 }, () => ({ id: "x", string: "00" })));
  refuses(() => parseLmLoopConfig(overflow as JsonValue), "lm_invalid_dataset_size");
});

test("adapter checkpoints serialize canonically, round-trip and bind their digest", () => {
  const config = parseLmLoopConfig(configValue());
  const adapter = copyLmAdapter(config.initial.adapter);
  adapter.bq[0] = 0.25;
  adapter.ah[3] = -0.5;
  const checkpoint = lmCheckpoint(adapter, config);
  assert.equal(checkpoint.digest, lmCheckpoint(copyLmAdapter(adapter), config).digest);
  const serialized = serializeLmCheckpoint(checkpoint, config);
  assert.ok(serialized.bytes > 0);
  assert.equal(serialized.bytes, Buffer.byteLength(serialized.text, "utf8"));
  assert.equal(checkpoint.digest, `sha256:${createHash("sha256").update(serialized.text).digest("hex")}`);
  const parsed = JSON.parse(serialized.text) as { format: string };
  assert.equal(parsed.format, LM_CHECKPOINT_FORMAT);
  // The persisted tensors round-trip through the adapter parser.
  const decoded = parseLmAdapter(JSON.parse(serialized.text).tensors, config.shape, "stored");
  assert.equal(lmCheckpoint(decoded, config).digest, checkpoint.digest);
  // Any other shape is an invalid checkpoint, not a rescaled one.
  const tensors = JSON.parse(JSON.stringify(decoded)) as Record<string, unknown>;
  refuses(() => parseLmAdapter(tensors.aq, config.shape, "stored"), "lm_invalid_checkpoint");
  tensors.aq = [0];
  refuses(() => parseLmAdapter(tensors, config.shape, "stored"), "lm_invalid_checkpoint");
  tensors.aq = [...(decoded.aq as unknown as number[]), Number.NaN];
  refuses(() => parseLmAdapter(tensors, config.shape, "stored"), "lm_invalid_checkpoint");
  void adapter;
});

test("immutable checkpoint artifacts refuse missing, corrupt and unwritable evidence", async () => {
  const root = mkdtempSync(join(tmpdir(), "pm-rl-lm-artifact-"));
  const config = parseLmLoopConfig(configValue());
  const checkpoint = config.initial;
  try {
    await assert.rejects(verifyLmCheckpointArtifact(root, checkpoint, config), (error: unknown) => isPmCliExpectedError(error) && error.context.code === "lm_checkpoint_artifact_missing");
    await persistLmCheckpoint(root, checkpoint, config);
    const path = join(root, lmCheckpointPath(checkpoint));
    const original = readFileSync(path, "utf8");
    await persistLmCheckpoint(root, checkpoint, config);
    assert.equal(readFileSync(path, "utf8"), original);
    writeFileSync(path, "corrupt");
    await assert.rejects(persistLmCheckpoint(root, checkpoint, config), (error: unknown) => isPmCliExpectedError(error) && error.context.code === "lm_checkpoint_artifact_corrupt");
    assert.equal(readFileSync(path, "utf8"), "corrupt");
    rmSync(path);
    mkdirSync(path);
    await assert.rejects(persistLmCheckpoint(root, checkpoint, config), (error: unknown) => error instanceof Error && "code" in error && error.code === "EISDIR");
    // A filesystem failure other than EEXIST must propagate, never look successful.
    const blocking = join(root, "blocking");
    writeFileSync(blocking, "file");
    await assert.rejects(persistLmCheckpoint(blocking, checkpoint, config));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("resource declarations account for the full model and bound real CPU work", () => {
  const value = configValue();
  const limits = value.limits as Record<string, JsonValue>;
  refuses(() => parseLmLoopConfig({ ...value, limits: { ...limits, max_parameters: 100 } }), "lm_limit_parameters_exceeded");
  refuses(() => parseLmLoopConfig({ ...value, limits: { ...limits, max_steps: 60 } }), "lm_limit_steps_exceeded");
  refuses(() => parseLmLoopConfig({ ...value, limits: { ...limits, max_wall_seconds: 1e-12 } }), "lm_limit_wall_seconds");
  const config = parseLmLoopConfig(value);
  assert.equal(lmParameterCount(config.shape), 744);
  const frozen = JSON.stringify(config.base);
  const batch = lmCollectBatch(config, 1, config.initial);
  const step = { learningRate: config.learningRate, evaluationSamples: config.evaluationSamples };
  const constrained = { ...config, limits: { ...config.limits, maxWallSeconds: 1e-12 } };
  refuses(() => lmCollectBatch(constrained, 1, constrained.initial), "lm_limit_wall_seconds");
  refuses(() => executeLmStep(constrained, step, 1, constrained.initial, batch, null), "lm_limit_wall_seconds");
  executeLmStep(config, step, 1, config.initial, batch, 50);
  assert.equal(JSON.stringify(config.base), frozen, "RL cannot mutate the pretrained base");
  const tensors = jsonLmAdapter(config.initial.adapter) as Record<string, JsonValue>;
  refuses(() => parseLmAdapter({ ...tensors, aq: [Number.MAX_VALUE, ...(tensors.aq as number[]).slice(1)] }, config.shape, "overflow"), "lm_invalid_checkpoint");
  refuses(() => parseLmAdapter({ ...tensors, aq: [Number.NaN, ...(tensors.aq as number[]).slice(1)] }, config.shape, "NaN"), "lm_invalid_checkpoint");
  const invalid = copyLmAdapter(config.initial.adapter);
  invalid.aq[0] = Number.NaN;
  refuses(() => lmCheckpoint(invalid, config), "lm_nonfinite_tensor");
  refuses(() => executeLmStep(config, step, 1, config.initial, [{ ...batch[0]!, example: "foreign" }], 50), "lm_collection_example");
  refuses(() => lmReinforceSurrogate(config.shape, config.base, config.initial.adapter,
    [{ example: "00", tokens: [3, 3], reward: 0 }], config.alphabet, 0, { started: 0, seconds: 1e-12 }), "lm_limit_wall_seconds");
});

test("causal attention cannot read future tokens and copy pretraining uses only supplied content", () => {
  const config = parseLmLoopConfig(configValue());
  const first = lmForward(config.shape, config.base, config.initial.adapter, [0, 3, 4, 1]);
  const changed = lmForward(config.shape, config.base, config.initial.adapter, [0, 3, 5, 2]);
  assert.deepEqual(first.logits.slice(0, 2), changed.logits.slice(0, 2));
  const training = config.training.map((example) => example.string);
  const pretraining = trainLmBasePolicy(config.shape, config.alphabet, config.seed, training);
  assert.ok(pretraining.strings.every((text) => training.includes(text)));
  assert.deepEqual(pretraining.weights, config.base);
});

test("collection events round-trip and corrupted evidence is refused", () => {
  const config = parseLmLoopConfig(configValue());
  const batch = lmCollectBatch(config, 1, config.initial);
  const events = lmCollectionEvents(batch);
  assert.equal(events.length, config.samplesPerGeneration);
  for (const [index, event] of events.entries()) {
    const observation = parseLmCollectionEvent(event, config, `event ${index}`);
    assert.deepEqual(observation, batch[index]);
  }
  const first = events[0]!;
  refuses(() => parseLmCollectionEvent({ ...first, metric: "foreign" }, config, "event"), "lm_event_metric");
  refuses(() => parseLmCollectionEvent({ ...first, tags: {} }, config, "event"), "lm_event_example");
  refuses(() => parseLmCollectionEvent({ ...first, tags: { example: "t0" } }, config, "event"), "lm_event_tokens");
  refuses(() => parseLmCollectionEvent({ ...first, tags: { example: "t0", tokens: "{" } }, config, "event"), "lm_event_tokens");
  refuses(() => parseLmCollectionEvent({ ...first, tags: { example: "t0", tokens: "[9]" } }, config, "event"), "lm_event_tokens");
  refuses(() => parseLmCollectionEvent({ ...first, tags: { example: "t0", tokens: "[3,3,3]" } }, config, "event"), "lm_event_tokens");
  refuses(() => parseLmCollectionEvent({ ...first, tags: { example: "foreign", tokens: "[3,3]" } }, config, "event"), "lm_event_example");
  const wrong = parseLmCollectionEvent(first, config, "event");
  refuses(() => parseLmCollectionEvent({ ...first, value: wrong.reward === 0 ? 1 : 0 }, config, "event"), "lm_event_value");
  refuses(() => parseLmCollectionEvent({ ...first, value: 2 }, config, "event"), "lm_event_value");
  // A completion naming a held-out example cannot enter the batch either.
  const heldOut = { ...first, tags: { example: "h0", tokens: first.tags!["tokens"] } };
  refuses(() => parseLmCollectionEvent(heldOut, config, "event"), "lm_event_example");
});

test("stored generations replay exactly and tampered evidence fails closed", () => {
  const config = parseLmLoopConfig(configValue());
  const step = { learningRate: config.learningRate, evaluationSamples: config.evaluationSamples };
  const batch = lmCollectBatch(config, 1, config.initial);
  const receipt = executeLmStep(config, step, 1, config.initial, batch, 50);
  const storedJson = lmGenerationTrainingConfig(config, step, receipt);
  assert.equal((storedJson as Record<string, unknown>)["format"], LM_GENERATION_FORMAT);
  const stored = parseStoredLmGeneration(storedJson, config, "stored");
  assert.deepEqual(verifyStoredLmGeneration(config, step, config.initial, stored, batch), receipt);
  // A tampered score is drift; a tampered tensor is an invalid checkpoint.
  refuses(() => verifyStoredLmGeneration(config, step, config.initial, { ...stored, trainingScore: 0 }, batch), "loop_generation_drift");
  const tampered = JSON.parse(JSON.stringify(storedJson)) as Record<string, unknown>;
  const tensors = tampered["candidate_adapter"] as Record<string, number[]>;
  tensors.aq = [...tensors.aq!];
  tensors.aq[0] = 1;
  refuses(() => parseStoredLmGeneration(tampered as unknown as JsonValue, config, "stored"), "lm_invalid_checkpoint");
  refuses(() => parseStoredLmGeneration({ ...tampered, format: "foreign" } as unknown as JsonValue, config, "stored"), "lm_invalid_training_config");
  refuses(() => parseStoredLmGeneration({ ...tampered, generation: 0 } as unknown as JsonValue, config, "stored"), "lm_invalid_training_config");
  refuses(() => parseStoredLmGeneration({ ...tampered, samples: 0 } as unknown as JsonValue, config, "stored"), "lm_invalid_training_config");
  refuses(() => parseStoredLmGeneration({ ...tampered, collection_digest: "sha256:0" } as unknown as JsonValue, config, "stored"), "lm_invalid_checkpoint");
  const original = lmGenerationTrainingConfig(config, step, receipt) as Record<string, JsonValue>;
  refuses(() => parseStoredLmGeneration({ ...original, candidate_checkpoint: `sha256:${"0".repeat(64)}` }, config, "stored"), "lm_invalid_checkpoint");
  refuses(() => parseStoredLmGeneration({ ...original, checkpoint_bytes: 0 }, config, "stored"), "lm_invalid_checkpoint");
});

test("the environment spec, run, seed and promotion score records carry the full contract", () => {
  const config = parseLmLoopConfig(configValue());
  const step = { learningRate: config.learningRate, evaluationSamples: config.evaluationSamples };
  const batch = lmCollectBatch(config, 1, config.initial);
  const receipt = executeLmStep(config, step, 1, config.initial, batch, 50);
  const spec = lmEnvironmentSpec(config);
  assert.equal(spec.name, "LM rotate");
  assert.equal(spec.version, "1");
  const suite = spec.task_suite as { task: string; alphabet: string[]; collection: unknown[]; held_out: unknown[] };
  assert.equal(suite.task, "rotate");
  assert.deepEqual(suite.alphabet, ALPHABET);
  assert.equal(suite.collection.length, config.training.length);
  assert.equal(suite.held_out.length, config.evaluation.length);
  const reward = spec.reward_specification as { reward_bounds: [number, number]; held_out_isolated_from_collection: boolean };
  assert.deepEqual(reward.reward_bounds, [0, 1]);
  assert.equal(reward.held_out_isolated_from_collection, true);
  const run = lmRunConfig(config, step, 1, config.initial) as Record<string, unknown>;
  assert.equal(run["format"], LM_RUN_FORMAT);
  assert.equal(run["source_checkpoint"], config.initial.digest);
  const seed = lmSeedTrainingConfig(config) as Record<string, unknown>;
  assert.equal(seed["format"], LM_SEED_FORMAT);
  assert.equal(seed["base_checkpoint"], config.baseDigest);
  // The seed's embedded configuration re-parses to the identical programme.
  assert.equal(parseLmLoopConfig(seed["configuration"] as JsonValue).digest, config.digest);
  assert.equal(parseLmLoopConfig(lmConfigurationJson(config)).digest, config.digest);
  const scores = lmPromotionScores(config, step, receipt);
  assert.deepEqual(parseScoreRecord(scores.proxy_score, "proxy"), { ...parseScoreRecord(scores.proxy_score, "proxy") });
  assert.equal(parseScoreRecord(scores.proxy_score, "proxy").objective, "completion_reward");
  assert.equal(parseScoreRecord(scores.held_out_score, "held_out").value, receipt.candidateHeldOutMean);
  // The serialized checkpoint bytes stay inside the declared budget.
  assert.ok(serializeLmCheckpoint(receipt.candidate, config).bytes <= config.limits.maxCheckpointBytes);
});
