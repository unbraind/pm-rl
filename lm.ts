/**
 * @module pm-rl/lm
 *
 * A real, bounded causal language-model trainer for the persisted recursive
 * loop.
 *
 * The model is a tiny decoder-only transformer — one or two layers, single-head
 * causal attention, `d_model <= 48`, learned positional embeddings — written
 * directly in TypeScript over `Float32Array` tensors with a hand-written
 * forward and backward pass, so no Python runtime, native dependency or GPU is
 * involved. The frozen base policy is produced by a short deterministic
 * supervised pretraining run over a synthetic copy task: the code regenerates
 * it byte-identically from the programme seed, so no weight blob is checked
 * in. Reinforcement learning trains only LoRA-style low-rank adapters on the
 * Q and V projections and the output head by REINFORCE with a mean baseline,
 * a KL penalty to the frozen base policy and gradient clipping; collection
 * samples completions from the promoted policy for a verifiable rotate task
 * (every symbol maps to its successor in the declared alphabet), and the
 * reward comes from an exact verifier: per-position accuracy plus an
 * exact-match bonus, bounded to `[0, 1]`.
 *
 * Every adapter checkpoint is canonically serialized and content-addressed
 * over its actual tensors, the declared limits (parameter count, checkpoint
 * bytes, gradient steps, wall seconds, licences) are validated fail-closed,
 * and promotion goes through the loop's shared Hoeffding gate. The module is
 * deliberately synchronous and CPU-only: a whole three-generation acceptance
 * run fits in seconds.
 */

import { createHash, randomUUID } from "node:crypto";
import { link, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { EXIT_CODE } from "@unbrained/pm-cli/sdk/runtime";

import { canonicalJson, type EnvironmentSpec, type JsonValue } from "./index.ts";
import { trainerSampleSeed, trainerEvaluationSeeds as evaluationSeeds, type LoopStepConfig } from "./loop.ts";
import { decideTrainerPromotion } from "./promotion.ts";
import type { MetricEvent } from "./series.ts";
import { asJsonObject, expectedFail, storedCheckpointDigest, requiredTrimmedString, verifyReplayFields, storedCheckpointNumber, verifyTrainerReceipt, verifyTrainerConfiguration } from "./refuse.ts";

/** Format identity of one adapter checkpoint. */
export const LM_CHECKPOINT_FORMAT = "pm-rl/lm-checkpoint/1";

/** Format identity of a candidate generation's derived training configuration. */
export const LM_GENERATION_FORMAT = "pm-rl/lm-generation/1";

/** Format identity of the seed generation's programme configuration. */
export const LM_SEED_FORMAT = "pm-rl/lm-seed/1";

/** Format identity of a collection run's pre-collection configuration. */
export const LM_RUN_FORMAT = "pm-rl/lm-run/1";

/** Format identity of the whole language-model loop programme. */
const LM_PROGRAMME_FORMAT = "pm-rl/lm-programme/1";

/** Format identity of the environment's reward contract. */
const LM_REWARD_FORMAT = "pm-rl/lm-reward/1";

/** Metric name of one persisted collected completion. */
export const LM_COLLECTION_METRIC = "lm_completion";

/** Maximum symbols one task alphabet may declare, excluding BOS/SEP/EOS. */
export const MAX_LM_ALPHABET = 37;

/** Maximum positions the positional embedding table carries. */
export const MAX_LM_POSITIONS = 16;

/** Maximum model width the adapter accepts. */
export const MAX_LM_MODEL_DIM = 48;

/** Maximum feed-forward width the adapter accepts. */
export const MAX_LM_FFN_DIM = 128;

/** Maximum LoRA rank the adapter accepts. */
export const MAX_LM_LORA_RANK = 4;

/** Maximum REINFORCE gradient steps one generation's fit may take. */
export const MAX_LM_FIT_STEPS = 10_000;

/** Maximum examples one language-model dataset may carry. */
export const MAX_LM_EXAMPLES = 10_000;

/** Maximum string length one task example may carry. */
export const MAX_LM_STRING_LENGTH = 6;

/** Lower bound of the language-model learning rate, shared with the loop schedule. */
export const MIN_LM_LEARNING_RATE = 0.01;

/** Supervised pretraining steps the deterministic base fit takes. */
export const PRETRAIN_STEP_COUNT = 60;

/** Supervised pretraining strings the deterministic base fit draws. */
const PRETRAIN_STRING_COUNT = 24;

/** The only licences this adapter is authorized to train under. */
const LM_SUPPORTED_LICENCE = "MIT";

/** Reward bounds the language-model environment declares. correctness pays in [0, 1]. */
const LM_REWARD_BOUNDS: readonly [number, number] = [0, 1];

/** The special token opening every sequence. */
const BOS_TOKEN = 0;

/** The special token separating prompt from completion. */
const SEP_TOKEN = 1;

/** The special token closing every sequence. */
const EOS_TOKEN = 2;

/** The first alphabet symbol's token id. */
const FIRST_SYMBOL_TOKEN = 3;

/** LCG multiplier shared with the bandit adapter, so all streams behave alike. */
const LCG_MULTIPLIER = 1_664_525;

/** LCG increment shared with the bandit adapter. */
const LCG_INCREMENT = 1_013_904_223;

/** Numerical epsilon inside every layer norm. */
const LAYER_NORM_EPSILON = 1e-5;

/** Probability floor inside every logarithm the loss differentiates through. */
const LOG_PROBABILITY_FLOOR = 1e-12;

/** Label smoothing the deterministic supervised pretraining fit applies. */
const PRETRAIN_LABEL_SMOOTHING = 0.3;

/** One declared task alphabet symbol. */
export interface LmExample {
  /** Dataset-local identity, disjoint across collection and held-out sets. */
  readonly id: string;
  /** The task string: one declared alphabet symbol per character. */
  readonly string: string;
}

/** The frozen base model's weights, regenerated deterministically from the seed. */
export interface LmWeights {
  /** Token embedding table, `[vocab, d_model]`. */
  readonly emb: Float32Array;
  /** Learned positional embedding table, `[max_positions, d_model]`. */
  readonly pos: Float32Array;
  /** The transformer blocks, in execution order. */
  readonly layers: readonly LmLayerWeights[];
  /** The output head, `[vocab, d_model]`. */
  readonly head: Float32Array;
}

/** One transformer block's weights. */
export interface LmLayerWeights {
  /** Pre-attention layer-norm gain. */
  readonly ln1g: Float32Array;
  /** Pre-attention layer-norm bias. */
  readonly ln1b: Float32Array;
  /** Pre-feed-forward layer-norm gain. */
  readonly ln2g: Float32Array;
  /** Pre-feed-forward layer-norm bias. */
  readonly ln2b: Float32Array;
  /** Query projection, `[d_model, d_model]`. */
  readonly wq: Float32Array;
  /** Key projection, `[d_model, d_model]`. */
  readonly wk: Float32Array;
  /** Value projection, `[d_model, d_model]`. */
  readonly wv: Float32Array;
  /** Attention output projection, `[d_model, d_model]`. */
  readonly wo: Float32Array;
  /** Feed-forward input projection, `[ffn, d_model]`. */
  readonly w1: Float32Array;
  /** Feed-forward input bias. */
  readonly b1: Float32Array;
  /** Feed-forward output projection, `[d_model, ffn]`. */
  readonly w2: Float32Array;
  /** Feed-forward output bias. */
  readonly b2: Float32Array;
}

/** The trainable LoRA-style adapter: low-rank updates on Q, V and the output head. */
export interface LmAdapter {
  /** Query low-rank input projection, `[rank, d_model]`. */
  readonly aq: Float32Array;
  /** Query low-rank output projection, `[d_model, rank]`. */
  readonly bq: Float32Array;
  /** Value low-rank input projection, `[rank, d_model]`. */
  readonly av: Float32Array;
  /** Value low-rank output projection, `[d_model, rank]`. */
  readonly bv: Float32Array;
  /** Head low-rank input projection, `[rank, d_model]`. */
  readonly ah: Float32Array;
  /** Head low-rank output projection, `[vocab, rank]`. */
  readonly bh: Float32Array;
}

/** Gradients for every weight and adapter tensor, accumulated by the backward pass. */
export interface LmGradients {
  /** Gradient of the token embedding table. */
  readonly emb: Float64Array;
  /** Gradient of the positional embedding table. */
  readonly pos: Float64Array;
  /** Gradients of the transformer blocks, in execution order. */
  readonly layers: readonly LmLayerGradients[];
  /** Gradient of the output head. */
  readonly head: Float64Array;
  /** Gradient of the adapter tensors, or null when no adapter was applied. */
  readonly adapter: LmAdapterGradients | null;
}

/** Gradients of one transformer block's weights. */
export interface LmLayerGradients {
  /** Gradient of the pre-attention layer-norm gain. */
  readonly ln1g: Float64Array;
  /** Gradient of the pre-attention layer-norm bias. */
  readonly ln1b: Float64Array;
  /** Gradient of the pre-feed-forward layer-norm gain. */
  readonly ln2g: Float64Array;
  /** Gradient of the pre-feed-forward layer-norm bias. */
  readonly ln2b: Float64Array;
  /** Gradient of the query projection. */
  readonly wq: Float64Array;
  /** Gradient of the key projection. */
  readonly wk: Float64Array;
  /** Gradient of the value projection. */
  readonly wv: Float64Array;
  /** Gradient of the attention output projection. */
  readonly wo: Float64Array;
  /** Gradient of the feed-forward input projection. */
  readonly w1: Float64Array;
  /** Gradient of the feed-forward input bias. */
  readonly b1: Float64Array;
  /** Gradient of the feed-forward output projection. */
  readonly w2: Float64Array;
  /** Gradient of the feed-forward output bias. */
  readonly b2: Float64Array;
}

/** Gradients of the adapter tensors. */
export interface LmAdapterGradients {
  /** Gradient of the query low-rank input projection. */
  readonly aq: Float64Array;
  /** Gradient of the query low-rank output projection. */
  readonly bq: Float64Array;
  /** Gradient of the value low-rank input projection. */
  readonly av: Float64Array;
  /** Gradient of the value low-rank output projection. */
  readonly bv: Float64Array;
  /** Gradient of the head low-rank input projection. */
  readonly ah: Float64Array;
  /** Gradient of the head low-rank output projection. */
  readonly bh: Float64Array;
}

/** Everything the forward pass caches so the backward pass never recomputes. */
interface LmForwardCache {
  /** The embedded inputs per position. */
  readonly x: readonly Float64Array[];
  /** Per-layer activations. */
  readonly layers: readonly LmLayerCache[];
  /** The final block outputs the head consumes. */
  readonly top: readonly Float64Array[];
}

/** One transformer block's cached activations. */
interface LmLayerCache {
  /** The block's input stream, one vector per position. */
  readonly input: readonly Float64Array[];
  /** Layer-normed inputs feeding the attention projections. */
  readonly u: readonly Float64Array[];
  /** Layer-norm statistics for the attention layer norm. */
  readonly ln1: readonly LmNormCache[];
  /** Query vectors per position. */
  readonly q: readonly Float64Array[];
  /** Key vectors per position. */
  readonly k: readonly Float64Array[];
  /** Value vectors per position. */
  readonly v: readonly Float64Array[];
  /** Attention probabilities per position over its causal prefix. */
  readonly probs: readonly Float64Array[];
  /** Attention mixes per position. */
  readonly attn: readonly Float64Array[];
  /** Cached query low-rank reductions per position, empty when no adapter applies. */
  readonly rq: readonly Float64Array[];
  /** Cached value low-rank reductions per position, empty when no adapter applies. */
  readonly rv: readonly Float64Array[];
  /** Residual sums after the attention block. */
  readonly h: readonly Float64Array[];
  /** Layer-norm statistics for the feed-forward layer norm. */
  readonly ln2: readonly LmNormCache[];
  /** Feed-forward hidden pre-activations per position. */
  readonly hidPre: readonly Float64Array[];
  /** Feed-forward hidden tanh activations per position. */
  readonly hid: readonly Float64Array[];
}

/** One layer norm's cached statistics and normalized output. */
interface LmNormCache {
  /** The input mean. */
  readonly mean: number;
  /** The reciprocal normalization scale. */
  readonly inv: number;
  /** The normalized input before gain and bias. */
  readonly hat: Float64Array;
  /** The layer-normed output after gain and bias. */
  readonly out: Float64Array;
}

/** The model architecture the adapter instantiates. */
export interface LmModelShape {
  /** Vocabulary size: three special tokens plus the declared alphabet. */
  readonly vocab: number;
  /** Model width, at most {@link MAX_LM_MODEL_DIM}. */
  readonly dModel: number;
  /** Feed-forward width, at most {@link MAX_LM_FFN_DIM}. */
  readonly ffn: number;
  /** Transformer blocks, one or two. */
  readonly layers: number;
  /** LoRA rank, at most {@link MAX_LM_LORA_RANK}. */
  readonly rank: number;
  /** The one declared string length every task example carries. */
  readonly stringLength: number;
  /** Positional embedding table size. */
  readonly maxPositions: number;
}

/** One collected completion: the prompt, the sampled tokens and the verifier's reward. */
export interface LmObservation {
  /** Dataset-local identity of the example this completion drew. */
  readonly example: string;
  /** The sampled answer tokens, one per prompt symbol. */
  readonly tokens: readonly number[];
  /** The exact verifier's reward: per-position accuracy plus the exact-match bonus. */
  readonly reward: number;
}

/** The terminal condition one language-model generation ended a loop with. */
export type LmStopReason = "unchanged_checkpoint" | "evaluation_rejected" | "gap_rejected" | "checkpoint_limit_exceeded" | "wall_limit_exceeded";

/** Evidence retained for one collected batch and attempted adapter fit. */
export interface LmGeneration {
  /** One-based attempted generation number. */
  readonly generation: number;
  /** Exact checkpoint whose policy collected and evaluated this batch. */
  readonly source: LmCheckpoint;
  /** Actual checkpoint obtained from the batch's REINFORCE update. */
  readonly candidate: LmCheckpoint;
  /** Identity of the complete ordered collected batch and its source checkpoint. */
  readonly collectionDigest: string;
  /** The complete ordered batch of collected completions. */
  readonly observations: readonly LmObservation[];
  /** Summed surrogate loss over the collected batch before the fit. */
  readonly lossBefore: number;
  /** Summed surrogate loss over the collected batch after the fit. */
  readonly lossAfter: number;
  /** L2 norm of the parameter delta between source and candidate adapters. */
  readonly parameterDeltaL2: number;
  /** Greedy held-out exact-match fraction of the source policy. */
  readonly baselineExactMatch: number;
  /** Greedy held-out exact-match fraction of the candidate policy. */
  readonly candidateExactMatch: number;
  /** Teacher-forced reward proxy under the source policy on the held-out examples. */
  readonly baselineScore: number;
  /** Teacher-forced reward proxy under the candidate on the collected examples. */
  readonly trainingScore: number;
  /** Teacher-forced reward proxy under the candidate on the held-out examples. */
  readonly evaluationScore: number;
  /** Empirical mean reward of the incumbent on the sampled held-out episodes. */
  readonly incumbentHeldOutMean: number;
  /** Empirical mean reward of the candidate on the sampled held-out episodes. */
  readonly candidateHeldOutMean: number;
  /** Whether this candidate became the next generation's collecting policy. */
  readonly promoted: boolean;
  /** The promotion gate's verdict reason; null when promoted, otherwise the recorded refusal. */
  readonly refusalReason: string | null;
  /** The condition this generation terminated the loop with; null when it promoted and the caller continued. */
  readonly stopReason: LmStopReason | null;
  /** Wall milliseconds this generation's fit and evaluation measured. */
  readonly wallMs: number;
}

/** A reproducible adapter checkpoint whose digest binds the frozen base and the real tensors. */
export interface LmCheckpoint {
  /** The adapter's actual tensors; changed by the REINFORCE update. */
  readonly adapter: LmAdapter;
  /** SHA-256 of the versioned, canonically serialized checkpoint. */
  readonly digest: string;
}

/** The declared resource and licence limits, validated fail-closed before collection. */
export interface LmLimits {
  /** Maximum parameters in the frozen base plus the shared adapter. */
  readonly maxParameters: number;
  /** Maximum serialized checkpoint bytes one candidate may occupy. */
  readonly maxCheckpointBytes: number;
  /** Maximum optimizer steps across pretraining and all declared generations. */
  readonly maxSteps: number;
  /** Maximum wall seconds one generation's fit and evaluation may take. */
  readonly maxWallSeconds: number;
  /** Declared licence of the self-authored model weights. */
  readonly modelLicense: string;
  /** Declared licence of the synthetic datasets. */
  readonly datasetLicense: string;
}

/** A complete validated language-model loop programme. */
export interface LmLoopConfig {
  /** Human-readable environment family name for the registered environment. */
  readonly environmentName: string;
  /** Environment version; changed content must change this value. */
  readonly environmentVersion: string;
  /** The declared task alphabet; token ids start after the three special tokens. */
  readonly alphabet: readonly string[];
  /** Validated collection examples; only collected rewards train the adapter. */
  readonly training: readonly LmExample[];
  /** Validated held-out examples, disjoint from collection by identity and content. */
  readonly evaluation: readonly LmExample[];
  /** Content identity of the ordered collection examples. */
  readonly trainingDigest: string;
  /** Content identity of the ordered held-out examples. */
  readonly evaluationDigest: string;
  /** The frozen base policy, regenerated deterministically from the seed. */
  readonly base: LmWeights;
  /** Content identity of the regenerated frozen base policy. */
  readonly baseDigest: string;
  /** The model architecture the declared dimensions instantiate. */
  readonly shape: LmModelShape;
  /** The starting adapter checkpoint: zero output projections over a seeded low-rank input. */
  readonly initial: LmCheckpoint;
  /** The declared fail-closed limits. */
  readonly limits: LmLimits;
  /** Unsigned 32-bit base seed for reproducible completion sampling. */
  readonly seed: number;
  /** Maximum generations, from 1 to the loop's shared bound. */
  readonly maxGenerations: number;
  /** Completions each generation collects. */
  readonly samplesPerGeneration: number;
  /** Total completions the loop may collect. */
  readonly budget: number;
  /** REINFORCE learning rate for the adapter fit. */
  readonly learningRate: number;
  /** Gradient steps each generation's fit takes. */
  readonly fitSteps: number;
  /** Weight of the KL penalty to the frozen base policy. */
  readonly klWeight: number;
  /** Global gradient-norm clip applied to every adapter update. */
  readonly clipNorm: number;
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

/** The persisted training configuration of one completed language-model generation. */
export interface StoredLmGeneration {
  /** Measured surrogate before fitting. */
  readonly lossBefore: number;
  /** Measured surrogate after fitting. */
  readonly lossAfter: number;
  /** One-based generation number. */
  readonly generation: number;
  /** The derived learning rate this generation ran under. */
  readonly learningRate: number;
  /** The held-out evaluation episode count this generation sampled. */
  readonly evaluationSamples: number;
  /** Gradient steps this generation's fit took. */
  readonly fitSteps: number;
  /** Completions this generation collected. */
  readonly samples: number;
  /** Content identity of the complete ordered collected batch. */
  readonly collectionDigest: string;
  /** Content-addressed identity of the collecting checkpoint. */
  readonly sourceCheckpoint: string;
  /** Content-addressed identity of the candidate checkpoint. */
  readonly candidateCheckpoint: string;
  /** The candidate adapter's actual tensors. */
  readonly candidateAdapter: LmAdapter;
  /** L2 norm of the parameter delta between source and candidate adapters. */
  readonly parameterDeltaL2: number;
  /** Greedy held-out exact-match fraction of the source policy. */
  readonly baselineExactMatch: number;
  /** Greedy held-out exact-match fraction of the candidate policy. */
  readonly candidateExactMatch: number;
  /** Teacher-forced reward proxy under the candidate on the collected completions. */
  readonly trainingScore: number;
  /** Teacher-forced reward proxy under the candidate on the held-out examples. */
  readonly evaluationScore: number;
  /** The incumbent's sampled held-out mean this generation was judged against. */
  readonly incumbentHeldOutMean: number;
  /** The candidate's sampled held-out mean the gate bounded. */
  readonly candidateHeldOutMean: number;
  /** Wall milliseconds this generation's fit and evaluation measured. */
  readonly wallMs: number;
}

/** Hash a typed, explicitly ordered language-model artifact. */
function lmDigest(value: JsonValue): string {
  return `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
}

/** Advance one uint32 LCG step. */
function lcgStep(state: number): number {
  return (Math.imul(LCG_MULTIPLIER, state) + LCG_INCREMENT) >>> 0;
}

/** Render one weights tensor as the canonical JSON array artifacts persist. */
function jsonTensor(tensor: Readonly<Float32Array>): number[] {
  for (const value of tensor) {
    if (!Number.isFinite(value)) expectedFail("LM tensor contains a non-finite parameter.", "lm_nonfinite_tensor");
  }
  return [...tensor];
}

/** Stop CPU work at phase boundaries when the declared clock is exhausted. */
function checkLmDeadline(started: number, maxWallSeconds: number): void {
  if (performance.now() - started > maxWallSeconds * 1000) {
    expectedFail("LM phase exceeded the declared wall seconds; no candidate may promote.", "lm_limit_wall_seconds");
  }
}

/** The number of trainable parameters one adapter carries. */
export function lmAdapterParameterCount(shape: LmModelShape): number {
  return shape.rank * shape.dModel * 4 + shape.vocab * shape.rank + shape.dModel * shape.rank;
}

/** Count every frozen and trainable scalar before allocating model tensors. */
export function lmParameterCount(shape: LmModelShape): number {
  const { vocab, dModel, ffn, layers, maxPositions } = shape;
  return 2 * vocab * dModel + maxPositions * dModel
    + layers * (4 * dModel * dModel + 2 * dModel * ffn + 5 * dModel + ffn)
    + lmAdapterParameterCount(shape);
}

/** Allocate one zeroed adapter over the declared shape. */
function zeroAdapter(shape: LmModelShape): LmAdapter {
  return {
    aq: new Float32Array(shape.rank * shape.dModel),
    bq: new Float32Array(shape.dModel * shape.rank),
    av: new Float32Array(shape.rank * shape.dModel),
    bv: new Float32Array(shape.dModel * shape.rank),
    ah: new Float32Array(shape.rank * shape.dModel),
    bh: new Float32Array(shape.vocab * shape.rank),
  };
}

/** Copy one adapter's tensors. */
export function copyLmAdapter(adapter: LmAdapter): LmAdapter {
  return {
    aq: new Float32Array(adapter.aq), bq: new Float32Array(adapter.bq),
    av: new Float32Array(adapter.av), bv: new Float32Array(adapter.bv),
    ah: new Float32Array(adapter.ah), bh: new Float32Array(adapter.bh),
  };
}

/**
 * Construct the seeded starting adapter over the declared shape.
 *
 * The low-rank input projections (`a*`) are seeded small random values and the
 * output projections (`b*`) are zero, so the adapter contributes nothing at
 * the start: the initial policy IS the frozen base, and every gradient step
 * from real collected rewards moves it away from that anchor measurably.
 *
 * @param shape - The model architecture the adapter applies to.
 * @param seed - Unsigned 32-bit seed for the deterministic low-rank draws.
 * @returns The starting adapter tensors.
 */
export function seededLmAdapter(shape: LmModelShape, seed: number): LmAdapter {
  const adapter = zeroAdapter(shape);
  let state = seed;
  for (const key of ["aq", "av", "ah"] as const) {
    const tensor = adapter[key];
    for (let index = 0; index < tensor.length; index += 1) {
      state = lcgStep(state);
      tensor[index] = (state / 0x1_0000_0000 * 2 - 1) * 0.05;
    }
  }
  return adapter;
}

/** Render the adapter tensors as the plain JSON value artifacts persist. */
export function jsonLmAdapter(adapter: LmAdapter): JsonValue {
  return { aq: jsonTensor(adapter.aq), bq: jsonTensor(adapter.bq), av: jsonTensor(adapter.av), bv: jsonTensor(adapter.bv), ah: jsonTensor(adapter.ah), bh: jsonTensor(adapter.bh) };
}

/** Render the base weights as the canonical JSON the base digest is taken over. */
function jsonLmWeights(shape: LmModelShape, weights: LmWeights): JsonValue {
  return {
    emb: jsonTensor(weights.emb), pos: jsonTensor(weights.pos), head: jsonTensor(weights.head),
    layers: weights.layers.map((layer) => ({
      ln1g: jsonTensor(layer.ln1g), ln1b: jsonTensor(layer.ln1b), ln2g: jsonTensor(layer.ln2g), ln2b: jsonTensor(layer.ln2b),
      wq: jsonTensor(layer.wq), wk: jsonTensor(layer.wk), wv: jsonTensor(layer.wv), wo: jsonTensor(layer.wo),
      w1: jsonTensor(layer.w1), b1: jsonTensor(layer.b1), w2: jsonTensor(layer.w2), b2: jsonTensor(layer.b2),
    })),
    shape: { vocab: shape.vocab, d_model: shape.dModel, ffn: shape.ffn, layers: shape.layers, rank: shape.rank, max_positions: shape.maxPositions },
  };
}

/**
 * Construct a format-bound checkpoint identity over the real adapter tensors.
 *
 * The digest binds the checkpoint format, the frozen base identity, the
 * architecture and the actual adapter values, so any tensor the fit moves
 * changes the identity the next generation's collection run must match.
 *
 * @param adapter - The adapter tensors to bind.
 * @param config - The validated programme supplying the base and shape identities.
 * @returns The checkpoint with its content-addressed digest.
 */
export function lmCheckpoint(adapter: LmAdapter, config: Pick<LmLoopConfig, "baseDigest" | "shape">): LmCheckpoint {
  return {
    adapter,
    digest: `sha256:${createHash("sha256").update(serializeLmCheckpoint({ adapter, digest: "" }, config).text).digest("hex")}`,
  };
}

/**
 * The canonical serialized checkpoint document and its byte length.
 *
 * One implementation serves the checkpoint-bytes limit, the artifact receipt
 * and the digest, so what is measured is exactly what is stored.
 *
 * @param checkpoint - The checkpoint to serialize.
 * @param config - The validated programme supplying the base and shape identities.
 * @returns The canonical JSON text and its length in UTF-8 bytes.
 */
export function serializeLmCheckpoint(checkpoint: LmCheckpoint, config: Pick<LmLoopConfig, "baseDigest" | "shape">): { readonly text: string; readonly bytes: number } {
  const text = canonicalJson({
    format: LM_CHECKPOINT_FORMAT,
    base: config.baseDigest,
    shape: { vocab: config.shape.vocab, d_model: config.shape.dModel, ffn: config.shape.ffn, layers: config.shape.layers, rank: config.shape.rank, string_length: config.shape.stringLength, max_positions: config.shape.maxPositions },
    tensors: jsonLmAdapter(checkpoint.adapter),
  });
  return { text, bytes: Buffer.byteLength(text, "utf8") };
}

/** Tracker-relative location of immutable, content-addressed adapter artifacts. */
export function lmCheckpointPath(checkpoint: LmCheckpoint): string {
  return `runtime/pm-rl/artifacts/${checkpoint.digest.slice(7)}.json`;
}

/** Verify the bytes on disk against the canonical checkpoint and its identity. */
export async function verifyLmCheckpointArtifact(pmRoot: string, checkpoint: LmCheckpoint, config: LmLoopConfig): Promise<void> {
  let text: string;
  try {
    text = await readFile(join(pmRoot, lmCheckpointPath(checkpoint)), "utf8");
  } catch {
    expectedFail("LM checkpoint artifact is missing or unreadable.", "lm_checkpoint_artifact_missing", EXIT_CODE.CONFLICT);
  }
  if (text !== serializeLmCheckpoint(checkpoint, config).text) {
    expectedFail("LM checkpoint artifact bytes disagree with the receipt.", "lm_checkpoint_artifact_corrupt", EXIT_CODE.CONFLICT);
  }
}

/**
 * Store a checkpoint without overwriting existing evidence, then verify its bytes.
 * The bytes go to a private temporary file first and are published with `link`,
 * which refuses an existing target: a crash mid-write never leaves a partial
 * artifact at the content-addressed path, so a resumed loop can still persist it.
 */
export async function persistLmCheckpoint(pmRoot: string, checkpoint: LmCheckpoint, config: LmLoopConfig, write: typeof writeFile = writeFile): Promise<void> {
  await mkdir(join(pmRoot, "runtime/pm-rl/artifacts"), { recursive: true });
  const target = join(pmRoot, lmCheckpointPath(checkpoint));
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    await write(temporary, serializeLmCheckpoint(checkpoint, config).text, { flag: "wx" });
    await link(temporary, target);
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error;
  } finally {
    await rm(temporary, { force: true });
  }
  await verifyLmCheckpointArtifact(pmRoot, checkpoint, config);
}

/** Softmax over one logits vector. */
function softmax(logits: Readonly<Float64Array>): Float64Array {
  let peak = Number.NEGATIVE_INFINITY;
  for (let index = 0; index < logits.length; index += 1) if (logits[index] > peak) peak = logits[index];
  const out = new Float64Array(logits.length);
  let total = 0;
  for (let index = 0; index < logits.length; index += 1) {
    out[index] = Math.exp(logits[index] - peak);
    total += out[index];
  }
  for (let index = 0; index < logits.length; index += 1) out[index] /= total;
  return out;
}

/** Apply a low-rank input projection in both forward and backward kernels. */
function rankProjection(matrix: Readonly<Float32Array>, value: Readonly<Float64Array>, rank: number, width: number): Float64Array {
  const projected = new Float64Array(rank);
  for (let row = 0; row < rank; row += 1) {
    for (let column = 0; column < width; column += 1) projected[row] += matrix[row * width + column]! * value[column]!;
  }
  return projected;
}

/** One layer-norm forward, caching the statistics the backward pass needs. */
function layerNormForward(value: Readonly<Float64Array>, gain: Readonly<Float32Array>, bias: Readonly<Float32Array>, dModel: number): LmNormCache {
  let mean = 0;
  for (let i = 0; i < dModel; i += 1) mean += value[i];
  mean /= dModel;
  let variance = 0;
  for (let i = 0; i < dModel; i += 1) {
    const centered = value[i] - mean;
    variance += centered * centered;
  }
  const inv = 1 / Math.sqrt(variance / dModel + LAYER_NORM_EPSILON);
  const hat = new Float64Array(dModel);
  const out = new Float64Array(dModel);
  for (let i = 0; i < dModel; i += 1) {
    hat[i] = (value[i] - mean) * inv;
    out[i] = hat[i] * gain[i] + bias[i];
  }
  return { mean, inv, hat, out };
}

/**
 * One full forward pass of the causal language model.
 *
 * Hand-written decoder-only transformer: token plus learned positional
 * embeddings, then per block a pre-norm single-head causal attention with the
 * adapter's low-rank updates on Q and V, a residual sum, a pre-norm tanh
 * feed-forward and a second residual sum; the output head plus its low-rank
 * update produces the logits. Every intermediate the backward pass needs is
 * cached, so {@link lmBackward} never recomputes activations.
 *
 * @param shape - The model architecture to run.
 * @param weights - The frozen base weights.
 * @param adapter - The trainable adapter, or null to evaluate the pure base policy.
 * @param tokens - The token ids to run over, in order.
 * @returns The per-position logits and the backward cache.
 */
export function lmForward(shape: LmModelShape, weights: LmWeights, adapter: LmAdapter | null, tokens: readonly number[]): { readonly logits: readonly Float64Array[]; readonly cache: LmForwardCache } {
  const { dModel, ffn, layers } = shape;
  const length = tokens.length;
  const x: Float64Array[] = [];
  for (let t = 0; t < length; t += 1) {
    const embedded = new Float64Array(dModel);
    for (let i = 0; i < dModel; i += 1) embedded[i] = weights.emb[tokens[t]! * dModel + i] + weights.pos[t * dModel + i];
    x.push(embedded);
  }
  const layerCaches: LmLayerCache[] = [];
  let current: readonly Float64Array[] = x;
  for (let l = 0; l < layers; l += 1) {
    const layer = weights.layers[l]!;
    const u: Float64Array[] = [];
    const ln1: LmNormCache[] = [];
    const q: Float64Array[] = [];
    const k: Float64Array[] = [];
    const v: Float64Array[] = [];
    const rq: Float64Array[] = [];
    const rv: Float64Array[] = [];
    for (let t = 0; t < length; t += 1) {
      const norm = layerNormForward(current[t]!, layer.ln1g, layer.ln1b, dModel);
      ln1.push(norm);
      u.push(norm.out);
      const rank = adapter === null ? 0 : shape.rank;
      const reducedQ = new Float64Array(rank);
      const reducedV = new Float64Array(rank);
      if (adapter !== null) {
        for (let r = 0; r < rank; r += 1) {
          let sum = 0;
          for (let i = 0; i < dModel; i += 1) sum += adapter.aq[r * dModel + i] * norm.out[i];
          reducedQ[r] = sum;
        }
        for (let r = 0; r < rank; r += 1) {
          let sum = 0;
          for (let i = 0; i < dModel; i += 1) sum += adapter.av[r * dModel + i] * norm.out[i];
          reducedV[r] = sum;
        }
      }
      const qt = new Float64Array(dModel);
      const kt = new Float64Array(dModel);
      const vt = new Float64Array(dModel);
      for (let o = 0; o < dModel; o += 1) {
        let sumQ = 0, sumK = 0, sumV = 0;
        for (let i = 0; i < dModel; i += 1) {
          sumQ += layer.wq[o * dModel + i] * norm.out[i];
          sumK += layer.wk[o * dModel + i] * norm.out[i];
          sumV += layer.wv[o * dModel + i] * norm.out[i];
        }
        qt[o] = sumQ;
        kt[o] = sumK;
        vt[o] = sumV;
        if (adapter !== null) {
          for (let r = 0; r < shape.rank; r += 1) {
            qt[o] += adapter.bq[o * shape.rank + r] * reducedQ[r];
            vt[o] += adapter.bv[o * shape.rank + r] * reducedV[r];
          }
        }
      }
      q.push(qt); k.push(kt); v.push(vt);
      rq.push(reducedQ);
      rv.push(reducedV);
    }
    const probs: Float64Array[] = [];
    const attn: Float64Array[] = [];
    const scale = 1 / Math.sqrt(dModel);
    for (let t = 0; t < length; t += 1) {
      const scores = new Float64Array(t + 1);
      for (let j = 0; j <= t; j += 1) {
        let sum = 0;
        for (let i = 0; i < dModel; i += 1) sum += q[t]![i] * k[j]![i];
        scores[j] = sum * scale;
      }
      let peak = Number.NEGATIVE_INFINITY;
      for (let j = 0; j <= t; j += 1) if (scores[j] > peak) peak = scores[j];
      const row = new Float64Array(t + 1);
      let total = 0;
      for (let j = 0; j <= t; j += 1) {
        row[j] = Math.exp(scores[j] - peak);
        total += row[j];
      }
      for (let j = 0; j <= t; j += 1) row[j] /= total;
      probs.push(row);
      const mixed = new Float64Array(dModel);
      for (let j = 0; j <= t; j += 1) {
        const weight = row[j];
        for (let i = 0; i < dModel; i += 1) mixed[i] += weight * v[j]![i];
      }
      attn.push(mixed);
    }
    const h: Float64Array[] = [];
    const ln2: LmNormCache[] = [];
    const hidPre: Float64Array[] = [];
    const hid: Float64Array[] = [];
    const output: Float64Array[] = [];
    for (let t = 0; t < length; t += 1) {
      const projected = new Float64Array(dModel);
      for (let o = 0; o < dModel; o += 1) {
        let sum = 0;
        for (let i = 0; i < dModel; i += 1) sum += layer.wo[o * dModel + i] * attn[t]![i];
        projected[o] = sum;
      }
      const residual = new Float64Array(dModel);
      for (let i = 0; i < dModel; i += 1) residual[i] = current[t]![i] + projected[i];
      const norm2 = layerNormForward(residual, layer.ln2g, layer.ln2b, dModel);
      const pre = new Float64Array(ffn);
      const hidden = new Float64Array(ffn);
      for (let o = 0; o < ffn; o += 1) {
        let sum = 0;
        for (let i = 0; i < dModel; i += 1) sum += layer.w1[o * dModel + i] * norm2.out[i];
        pre[o] = sum + layer.b1[o];
        hidden[o] = Math.tanh(pre[o]);
      }
      const out = new Float64Array(dModel);
      for (let o = 0; o < dModel; o += 1) {
        let sum = 0;
        for (let i = 0; i < ffn; i += 1) sum += layer.w2[o * ffn + i] * hidden[i];
        out[o] = residual[o] + sum + layer.b2[o];
      }
      h.push(residual);
      ln2.push(norm2);
      hidPre.push(pre);
      hid.push(hidden);
      output.push(out);
    }
    layerCaches.push({ input: current, u, ln1, q, k, v, probs, attn, rq, rv, h, ln2, hidPre, hid });
    current = output;
  }
  const top: Float64Array[] = [];
  const logits: Float64Array[] = [];
  for (let t = 0; t < length; t += 1) {
    const out = current[t]!;
    top.push(out);
    const reduced = adapter === null ? new Float64Array(0) : rankProjection(adapter.ah, out, shape.rank, dModel);
    const row = new Float64Array(shape.vocab);
    for (let o = 0; o < shape.vocab; o += 1) {
      let sum = 0;
      for (let i = 0; i < dModel; i += 1) sum += weights.head[o * dModel + i] * out[i];
      if (adapter !== null) {
        for (let r = 0; r < shape.rank; r += 1) sum += adapter.bh[o * shape.rank + r] * reduced[r];
      }
      row[o] = sum;
    }
    logits.push(row);
  }
  return { logits, cache: { x, layers: layerCaches, top } };
}

/** Allocate one zeroed gradient bundle for a full backward pass. */
function zeroGradients(shape: LmModelShape, withAdapter: boolean): LmGradients {
  const layers: LmLayerGradients[] = [];
  for (let l = 0; l < shape.layers; l += 1) {
    layers.push({
      ln1g: new Float64Array(shape.dModel), ln1b: new Float64Array(shape.dModel),
      ln2g: new Float64Array(shape.dModel), ln2b: new Float64Array(shape.dModel),
      wq: new Float64Array(shape.dModel * shape.dModel), wk: new Float64Array(shape.dModel * shape.dModel),
      wv: new Float64Array(shape.dModel * shape.dModel), wo: new Float64Array(shape.dModel * shape.dModel),
      w1: new Float64Array(shape.ffn * shape.dModel), b1: new Float64Array(shape.ffn),
      w2: new Float64Array(shape.dModel * shape.ffn), b2: new Float64Array(shape.dModel),
    });
  }
  return {
    emb: new Float64Array(shape.vocab * shape.dModel),
    pos: new Float64Array(shape.maxPositions * shape.dModel),
    layers,
    head: new Float64Array(shape.vocab * shape.dModel),
    adapter: withAdapter ? {
      aq: new Float64Array(shape.rank * shape.dModel), bq: new Float64Array(shape.dModel * shape.rank),
      av: new Float64Array(shape.rank * shape.dModel), bv: new Float64Array(shape.dModel * shape.rank),
      ah: new Float64Array(shape.rank * shape.dModel), bh: new Float64Array(shape.vocab * shape.rank),
    } : null,
  };
}

/** Propagate one layer norm's output gradient to its input and accumulate its parameter gradients. */
function layerNormBackward(norm: LmNormCache, gain: Readonly<Float32Array>, dOut: Readonly<Float64Array>, gGain: Float64Array, gBias: Float64Array, dModel: number): Float64Array {
  const dHat = new Float64Array(dModel);
  let meanDHat = 0;
  let meanDHatHat = 0;
  for (let i = 0; i < dModel; i += 1) {
    dHat[i] = dOut[i] * gain[i];
    gGain[i] += dOut[i] * norm.hat[i];
    gBias[i] += dOut[i];
    meanDHat += dHat[i];
    meanDHatHat += dHat[i] * norm.hat[i];
  }
  meanDHat /= dModel;
  meanDHatHat /= dModel;
  const dInput = new Float64Array(dModel);
  for (let i = 0; i < dModel; i += 1) dInput[i] = norm.inv * (dHat[i] - meanDHat - norm.hat[i] * meanDHatHat);
  return dInput;
}

/**
 * The hand-written backward pass of {@link lmForward}.
 *
 * Given the loss's gradient with respect to every used logit position, this
 * accumulates the analytic gradient of every base weight tensor and every
 * adapter tensor by walking the cached activations in reverse: the output
 * head and its low-rank update, then per block the feed-forward, the second
 * layer norm, the attention output projection, the masked softmax attention,
 * the Q/K/V projections with their low-rank updates, the first layer norm and
 * the residual, and finally the token and positional embeddings. A
 * finite-difference gradient check over every parameter tensor proves this
 * pass (see `test/lm.test.ts`).
 *
 * @param shape - The model architecture the forward pass ran under.
 * @param weights - The frozen base weights, for the transposed projections.
 * @param adapter - The adapter the forward pass applied, or null for the pure base.
 * @param tokens - The token ids the forward pass ran over.
 * @param cache - The forward pass's cached activations.
 * @param logitGradients - The loss gradient per logit position; null positions are skipped.
 * @returns The accumulated gradients for every weight and adapter tensor.
 */
export function lmBackward(shape: LmModelShape, weights: LmWeights, adapter: LmAdapter | null, tokens: readonly number[], cache: LmForwardCache, logitGradients: ReadonlyArray<Float64Array | null>): LmGradients {
  const { dModel, ffn, layers, rank, vocab } = shape;
  const length = tokens.length;
  const gradients = zeroGradients(shape, adapter !== null);
  const scale = 1 / Math.sqrt(dModel);
  // Output head and its low-rank update: the incoming gradient of the final
  // residual stream, one vector per position, zero where the loss contributes nothing.
  const dTop: Float64Array[] = [];
  for (let t = 0; t < length; t += 1) {
    const dLogit = logitGradients[t];
    const out = cache.top[t]!;
    const dOut = new Float64Array(dModel);
    if (dLogit !== null) {
      for (let o = 0; o < vocab; o += 1) {
        const d = dLogit[o];
        for (let i = 0; i < dModel; i += 1) {
          gradients.head[o * dModel + i] += d * out[i];
          dOut[i] += weights.head[o * dModel + i] * d;
        }
      }
    }
    dTop.push(dOut);
  }
  // The head's low-rank update: the forward logits were base + Bh (Ah out), so
  // the backward recomputes Ah out once per used position and accumulates the
  // low-rank gradients plus the head input gradient they flow through.
  for (let t = 0; t < length; t += 1) {
    const dLogit = logitGradients[t];
    if (dLogit === null || adapter === null) continue;
    const out = cache.top[t]!;
    const reduced = rankProjection(adapter.ah, out, rank, dModel);
    const dReduced = new Float64Array(rank);
    for (let o = 0; o < vocab; o += 1) {
      for (let r = 0; r < rank; r += 1) {
        gradients.adapter!.bh[o * rank + r] += dLogit[o] * reduced[r];
        dReduced[r] += adapter.bh[o * rank + r] * dLogit[o];
      }
    }
    for (let r = 0; r < rank; r += 1) {
      for (let i = 0; i < dModel; i += 1) {
        gradients.adapter!.ah[r * dModel + i] += dReduced[r] * out[i];
        dTop[t]![i] += adapter.ah[r * dModel + i] * dReduced[r];
      }
    }
  }
  // Transformer blocks in reverse.
  let dOutStream = dTop;
  for (let l = layers - 1; l >= 0; l -= 1) {
    const layerCache = cache.layers[l]!;
    const layerWeights = weights.layers[l]!;
    const layerGradients = gradients.layers[l]!;
    const dH: Float64Array[] = [];
    const dAttn: Float64Array[] = [];
    for (let t = 0; t < length; t += 1) {
      const dBlockOut = dOutStream[t]!;
      const dh = new Float64Array(dModel);
      for (let i = 0; i < dModel; i += 1) dh[i] = dBlockOut[i];
      // Feed-forward branch: blockOut = h + W2 tanh(W1 ln2(h) + b1) + b2.
      const dHid = new Float64Array(ffn);
      for (let o = 0; o < dModel; o += 1) {
        const d = dBlockOut[o];
        layerGradients.b2[o] += d;
        for (let i = 0; i < ffn; i += 1) {
          layerGradients.w2[o * ffn + i] += d * layerCache.hid[t]![i];
          dHid[i] += layerWeights.w2[o * ffn + i] * d;
        }
      }
      const dHidPre = new Float64Array(ffn);
      for (let i = 0; i < ffn; i += 1) {
        const tanhValue = layerCache.hid[t]![i];
        dHidPre[i] = dHid[i] * (1 - tanhValue * tanhValue);
      }
      const dM = new Float64Array(dModel);
      for (let o = 0; o < ffn; o += 1) {
        const d = dHidPre[o];
        layerGradients.b1[o] += d;
        for (let i = 0; i < dModel; i += 1) {
          layerGradients.w1[o * dModel + i] += d * layerCache.ln2[t]!.out[i];
          dM[i] += layerWeights.w1[o * dModel + i] * d;
        }
      }
      const dHFromNorm = layerNormBackward(layerCache.ln2[t]!, layerWeights.ln2g, dM, layerGradients.ln2g, layerGradients.ln2b, dModel);
      for (let i = 0; i < dModel; i += 1) dh[i] += dHFromNorm[i];
      // Attention branch: h = input + Wo attn.
      const dattn = new Float64Array(dModel);
      for (let o = 0; o < dModel; o += 1) {
        const d = dh[o];
        for (let i = 0; i < dModel; i += 1) {
          layerGradients.wo[o * dModel + i] += d * layerCache.attn[t]![i];
          dattn[i] += layerWeights.wo[o * dModel + i] * d;
        }
      }
      dH.push(dh);
      dAttn.push(dattn);
    }
    // Masked softmax attention backward, accumulating value and key gradients
    // across every position that attends to them.
    const dV: Float64Array[] = [];
    const dK: Float64Array[] = [];
    const dQ: Float64Array[] = [];
    for (let j = 0; j < length; j += 1) {
      dV.push(new Float64Array(dModel));
      dK.push(new Float64Array(dModel));
    }
    for (let t = 0; t < length; t += 1) {
      dQ.push(new Float64Array(dModel));
      const dP = new Float64Array(t + 1);
      for (let j = 0; j <= t; j += 1) {
        const weight = layerCache.probs[t]![j];
        let sum = 0;
        for (let i = 0; i < dModel; i += 1) {
          dV[j]![i] += weight * dAttn[t]![i];
          sum += layerCache.v[j]![i] * dAttn[t]![i];
        }
        dP[j] = sum;
      }
      let pDotDp = 0;
      for (let j = 0; j <= t; j += 1) pDotDp += layerCache.probs[t]![j] * dP[j];
      const dS = new Float64Array(t + 1);
      for (let j = 0; j <= t; j += 1) dS[j] = layerCache.probs[t]![j] * (dP[j] - pDotDp);
      for (let j = 0; j <= t; j += 1) {
        const d = dS[j];
        for (let i = 0; i < dModel; i += 1) {
          dQ[t]![i] += d * layerCache.k[j]![i] * scale;
          dK[j]![i] += d * layerCache.q[t]![i] * scale;
        }
      }
    }
    // Q/K/V projection backward, including the low-rank updates on Q and V.
    const dU: Float64Array[] = [];
    for (let t = 0; t < length; t += 1) {
      const u = layerCache.u[t]!;
      const du = new Float64Array(dModel);
      for (let o = 0; o < dModel; o += 1) {
        const dq = dQ[t]![o];
        const dk = dK[t]![o];
        const dv = dV[t]![o];
        for (let i = 0; i < dModel; i += 1) {
          layerGradients.wq[o * dModel + i] += dq * u[i];
          layerGradients.wk[o * dModel + i] += dk * u[i];
          layerGradients.wv[o * dModel + i] += dv * u[i];
          du[i] += layerWeights.wq[o * dModel + i] * dq + layerWeights.wk[o * dModel + i] * dk + layerWeights.wv[o * dModel + i] * dv;
        }
        if (adapter !== null) {
          for (let r = 0; r < rank; r += 1) {
            gradients.adapter!.bq[o * rank + r] += dq * layerCache.rq[t]![r];
            gradients.adapter!.bv[o * rank + r] += dv * layerCache.rv[t]![r];
          }
        }
      }
      if (adapter !== null) {
        const dReducedQ = new Float64Array(rank);
        const dReducedV = new Float64Array(rank);
        for (let o = 0; o < dModel; o += 1) {
          for (let r = 0; r < rank; r += 1) {
            dReducedQ[r] += adapter.bq[o * rank + r] * dQ[t]![o];
            dReducedV[r] += adapter.bv[o * rank + r] * dV[t]![o];
          }
        }
        for (let r = 0; r < rank; r += 1) {
          for (let i = 0; i < dModel; i += 1) {
            gradients.adapter!.aq[r * dModel + i] += dReducedQ[r] * u[i];
            gradients.adapter!.av[r * dModel + i] += dReducedV[r] * u[i];
            du[i] += adapter.aq[r * dModel + i] * dReducedQ[r] + adapter.av[r * dModel + i] * dReducedV[r];
          }
        }
      }
      dU.push(du);
    }
    // First layer norm and the residual path from h back to the block input.
    const dInput: Float64Array[] = [];
    for (let t = 0; t < length; t += 1) {
      const dFromNorm = layerNormBackward(layerCache.ln1[t]!, layerWeights.ln1g, dU[t]!, layerGradients.ln1g, layerGradients.ln1b, dModel);
      const dinput = new Float64Array(dModel);
      for (let i = 0; i < dModel; i += 1) dinput[i] = dH[t]![i] + dFromNorm[i];
      dInput.push(dinput);
    }
    dOutStream = dInput;
  }
  // Embedding gradients: the first block's input IS the embedded stream, so the
  // gradient that survived every block lands on the token and position tables.
  for (let t = 0; t < length; t += 1) {
    for (let i = 0; i < dModel; i += 1) {
      gradients.emb[tokens[t]! * dModel + i] += dOutStream[t]![i];
      gradients.pos[t * dModel + i] += dOutStream[t]![i];
    }
  }
  return gradients;
}

/** Token ids of one example's prompt: BOS, the string's symbols, SEP. */
export function lmPromptTokens(example: string, alphabet: readonly string[]): number[] {
  const tokens = [BOS_TOKEN];
  for (const symbol of example) tokens.push(FIRST_SYMBOL_TOKEN + alphabet.indexOf(symbol));
  tokens.push(SEP_TOKEN);
  return tokens;
}

/**
 * The rotate task's expected answer tokens for one example string.
 *
 * Every symbol maps to its successor in the declared alphabet, cyclically,
 * and the final answer position expects EOS, so the target is an exact
 * verifiable function of the declared alphabet alone.
 *
 * @param example - The example string to rotate.
 * @param alphabet - The declared task alphabet.
 * @returns The expected answer tokens, including the closing EOS.
 */
export function rotateTargetTokens(example: string, alphabet: readonly string[]): number[] {
  const tokens: number[] = [];
  for (const symbol of example) {
    const index = alphabet.indexOf(symbol);
    tokens.push(FIRST_SYMBOL_TOKEN + ((index + 1) % alphabet.length));
  }
  tokens.push(EOS_TOKEN);
  return tokens;
}

/** The full teacher-forced sequence of one example under a target answer. */
function fullTokens(example: string, alphabet: readonly string[], target: readonly number[]): number[] {
  return [...lmPromptTokens(example, alphabet), ...target];
}

/**
 * The exact verifier's reward for one completion.
 *
 * Per-position accuracy counts the answer positions whose sampled token equals
 * the rotate task's expected token; the exact-match bonus pays the other half
 * of the reward only when every position is correct. The reward is therefore
 * bounded to `[0, 1]` with no clipping, exactly the bounds the Hoeffding gate
 * declares.
 *
 * @param sampled - The sampled answer tokens, one per prompt symbol.
 * @param expected - The rotate task's expected answer tokens, including EOS.
 * @returns The bounded verifier reward.
 */
export function lmCompletionReward(sampled: readonly number[], expected: readonly number[]): number {
  const answerLength = expected.length - 1;
  let correct = 0;
  for (let i = 0; i < answerLength; i += 1) if (sampled[i] === expected[i]) correct += 1;
  const exact = correct === answerLength ? 1 : 0;
  return 0.5 * (correct / answerLength) + 0.5 * exact;
}

/** Sample one token from a probability vector under a uniform draw. */
function sampleFromProbabilities(probabilities: Readonly<Float64Array>, draw: number): number {
  let cumulative = 0;
  for (let index = 0; index < probabilities.length - 1; index += 1) {
    cumulative += probabilities[index];
    if (draw < cumulative) return index;
  }
  return probabilities.length - 1;
}

/**
 * Sample one completion from a policy for one example.
 *
 * The prompt is fed, then answer tokens are drawn one at a time from the
 * policy's next-token distribution; the number of answer tokens equals the
 * prompt's symbol count, so every episode is bounded by the declared string
 * length and the positional embedding table. The caller's LCG state advances
 * once per drawn token, so the completion is a pure function of the seed.
 *
 * @param shape - The model architecture.
 * @param weights - The frozen base weights.
 * @param adapter - The collecting policy's adapter, or null for the base policy.
 * @param example - The example string whose rotate completion is sampled.
 * @param alphabet - The declared task alphabet.
 * @param state - The incoming uint32 LCG state.
 * @returns The sampled answer tokens and the advanced LCG state.
 */
export function sampleLmCompletion(shape: LmModelShape, weights: LmWeights, adapter: LmAdapter | null, example: string, alphabet: readonly string[], state: number): { readonly tokens: readonly number[]; readonly state: number } {
  const prefix = lmPromptTokens(example, alphabet);
  const answerLength = example.length;
  const tokens: number[] = [];
  let cursor = state;
  for (let step = 0; step < answerLength; step += 1) {
    const { logits } = lmForward(shape, weights, adapter, [...prefix, ...tokens]);
    const probabilities = softmax(logits[logits.length - 1]!);
    cursor = lcgStep(cursor);
    tokens.push(sampleFromProbabilities(probabilities, cursor / 0x1_0000_0000));
  }
  return { tokens, state: cursor };
}

/**
 * The mean supervised cross-entropy over a batch of task examples.
 *
 * Every loss position is an answer position (the SEP and answer tokens
 * predicting the next answer token, and the last answer token predicting
 * EOS), so the loss is the objective the deterministic pretraining run and the
 * gradient check optimize. Label smoothing keeps the base policy's
 * probabilities diffused, which is what makes on-policy exploration in the
 * RL phase possible at all.
 *
 * @param shape - The model architecture.
 * @param weights - The base weights.
 * @param adapter - The adapter to apply, or null for the pure base policy.
 * @param examples - The example strings to fit.
 * @param targets - The expected answer tokens per example, including EOS.
 * @param labelSmoothing - The smoothing mass spread over the wrong tokens, in [0, 1).
 * @returns The mean cross-entropy over every answer position of every example.
 */
export function lmSupervisedLoss(shape: LmModelShape, weights: LmWeights, adapter: LmAdapter | null, examples: readonly string[], alphabet: readonly string[], targets: readonly (readonly number[])[], labelSmoothing: number): number {
  let loss = 0;
  let count = 0;
  for (let index = 0; index < examples.length; index += 1) {
    const example = examples[index]!;
    const target = targets[index]!;
    const tokens = fullTokens(example, alphabet, target);
    const { logits } = lmForward(shape, weights, adapter, tokens);
    const start = example.length + 1;
    for (let i = 0; i < target.length; i += 1) {
      const probabilities = softmax(logits[start + i]!);
      const truth = tokens[start + 1 + i]!;
      for (let c = 0; c < shape.vocab; c += 1) {
        const mass = c === truth ? 1 - labelSmoothing : labelSmoothing / (shape.vocab - 1);
        loss -= mass * Math.log(Math.max(probabilities[c], LOG_PROBABILITY_FLOOR));
      }
      count += 1;
    }
  }
  return loss / count;
}

/**
 * The analytic gradient of {@link lmSupervisedLoss}.
 *
 * The logit gradient of one answer position is `p - q` where `q` is the
 * smoothed target distribution, the exact softmax cross-entropy derivative;
 * everything below the logits is {@link lmBackward}'s hand-written chain.
 *
 * @param shape - The model architecture.
 * @param weights - The base weights.
 * @param adapter - The adapter to differentiate through, or null for the base policy.
 * @param examples - The example strings to fit.
 * @param targets - The expected answer tokens per example, including EOS.
 * @param labelSmoothing - The smoothing mass spread over the wrong tokens, in [0, 1).
 * @returns The gradients of every weight and adapter tensor.
 */
export function lmSupervisedGradient(shape: LmModelShape, weights: LmWeights, adapter: LmAdapter | null, examples: readonly string[], alphabet: readonly string[], targets: readonly (readonly number[])[], labelSmoothing: number): LmGradients {
  const gradient = zeroGradients(shape, adapter !== null);
  // The loss is a MEAN over every answer position, so the gradient divides by
  // the same count the loss divided by, keeping the two exactly consistent.
  const positions = targets.reduce((total, target) => total + target.length, 0);
  for (let index = 0; index < examples.length; index += 1) {
    const target = targets[index]!;
    const example = examples[index]!;
    const tokens = fullTokens(example, alphabet, target);
    const { logits, cache } = lmForward(shape, weights, adapter, tokens);
    const start = example.length + 1;
    const logitGradients: Array<Float64Array | null> = new Array(tokens.length).fill(null);
    for (let i = 0; i < target.length; i += 1) {
      const position = start + i;
      const probabilities = softmax(logits[position]!);
      const truth = tokens[start + 1 + i]!;
      const row = new Float64Array(shape.vocab);
      for (let c = 0; c < shape.vocab; c += 1) {
        row[c] = (probabilities[c] - (c === truth ? 1 - labelSmoothing : labelSmoothing / (shape.vocab - 1))) / positions;
      }
      logitGradients[position] = row;
    }
    accumulateGradients(gradient, lmBackward(shape, weights, adapter, tokens, cache, logitGradients));
  }
  return gradient;
}

/** Add one gradient bundle into an accumulating bundle in place. */
function accumulateGradients(total: LmGradients, addendum: LmGradients): void {
  accumulateTensor(total.emb, addendum.emb);
  accumulateTensor(total.pos, addendum.pos);
  accumulateTensor(total.head, addendum.head);
  for (let l = 0; l < total.layers.length; l += 1) {
    const into = total.layers[l]!;
    const from = addendum.layers[l]!;
    for (const key of ["ln1g", "ln1b", "ln2g", "ln2b", "wq", "wk", "wv", "wo", "w1", "b1", "w2", "b2"] as const) {
      accumulateTensor(into[key], from[key]);
    }
  }
  if (total.adapter !== null && addendum.adapter !== null) {
    for (const key of ["aq", "bq", "av", "bv", "ah", "bh"] as const) {
      accumulateTensor(total.adapter[key], addendum.adapter[key]);
    }
  }
}

/** Add one gradient tensor into another in place. */
function accumulateTensor(into: Float64Array, from: Readonly<Float64Array>): void {
  for (let i = 0; i < into.length; i += 1) into[i] += from[i];
}

/**
 * Deterministically seed the base weights from the programme seed.
 *
 * Xavier-scaled draws from the same uint32 LCG every other stream uses, so the
 * initialization is a pure function of the seed and identical across replays.
 *
 * @param shape - The model architecture to initialize.
 * @param seed - Unsigned 32-bit seed for the deterministic draws.
 * @returns The freshly initialized base weights.
 */
function seededLmWeights(shape: LmModelShape, seed: number): LmWeights {
  let state = seed;
  const draw = (): number => {
    state = lcgStep(state);
    return state / 0x1_0000_0000 * 2 - 1;
  };
  const tensor = (size: number, scale: number): Float32Array => {
    const values = new Float32Array(size);
    for (let i = 0; i < size; i += 1) values[i] = draw() * scale;
    return values;
  };
  const layers: LmLayerWeights[] = [];
  for (let l = 0; l < shape.layers; l += 1) {
    layers.push({
      ln1g: new Float32Array(shape.dModel).fill(1), ln1b: new Float32Array(shape.dModel),
      ln2g: new Float32Array(shape.dModel).fill(1), ln2b: new Float32Array(shape.dModel),
      wq: tensor(shape.dModel * shape.dModel, Math.sqrt(1 / shape.dModel)),
      wk: tensor(shape.dModel * shape.dModel, Math.sqrt(1 / shape.dModel)),
      wv: tensor(shape.dModel * shape.dModel, Math.sqrt(1 / shape.dModel)),
      wo: tensor(shape.dModel * shape.dModel, Math.sqrt(1 / shape.dModel)),
      w1: tensor(shape.ffn * shape.dModel, Math.sqrt(1 / shape.dModel)),
      b1: new Float32Array(shape.ffn),
      w2: tensor(shape.dModel * shape.ffn, Math.sqrt(1 / shape.ffn)),
      b2: new Float32Array(shape.dModel),
    });
  }
  return {
    emb: tensor(shape.vocab * shape.dModel, 0.5),
    pos: tensor(shape.maxPositions * shape.dModel, 0.1),
    layers,
    head: tensor(shape.vocab * shape.dModel, Math.sqrt(1 / shape.dModel)),
  };
}

/**
 * Regenerate the frozen base policy by a deterministic supervised pretraining run.
 *
 * This is the shipped-as-code base: no weight blob is checked in, because the
 * fit is a pure function of the declared architecture and the programme seed.
 * The task family is copy — every pretraining string's answer is itself, at
 * the declared string length, so a one-layer causal attention can learn the
 * fixed prompt-to-answer offset — and the fit is deterministic Adam descent on
 * the label-smoothed cross-entropy, so the base policy learns to reproduce the
 * prompt while its probabilities stay diffused enough for the RL phase to
 * explore. The base is frozen the moment this returns; only the adapter moves
 * afterwards.
 *
 * @param shape - The model architecture to pretrain.
 * @param alphabet - The declared task alphabet.
 * @param seed - Unsigned 32-bit seed for every deterministic draw.
 * @returns The frozen base weights and the identity of the pretraining strings.
 */
export function trainLmBasePolicy(shape: LmModelShape, alphabet: readonly string[], seed: number, trainingStrings?: readonly string[], maxWallSeconds: number = 3600): { readonly weights: LmWeights; readonly strings: readonly string[] } {
  const started = performance.now();
  const strings: string[] = [];
  let state = seed;
  for (let index = 0; index < PRETRAIN_STRING_COUNT; index += 1) {
    let text = "";
    for (let i = 0; i < shape.stringLength; i += 1) {
      text += alphabet[state % alphabet.length]!;
      state = lcgStep(state);
    }
    strings.push(trainingStrings === undefined ? text : trainingStrings[index % trainingStrings.length]!);
  }
  const copyTargets = strings.map((text) => [...text].map((symbol) => FIRST_SYMBOL_TOKEN + alphabet.indexOf(symbol)).concat([EOS_TOKEN]));
  const weights = seededLmWeights(shape, (Math.imul(seed, 0x9e3779b1) ^ 0x51ed270b) >>> 0);
  // Deterministic Adam state: one first and second moment per weight tensor.
  const moments = new Map<Float32Array, { first: Float64Array; second: Float64Array }>();
  for (let l = 0; l < shape.layers; l += 1) {
    for (const key of ["ln1g", "ln1b", "ln2g", "ln2b", "wq", "wk", "wv", "wo", "w1", "b1", "w2", "b2"] as const) {
      moments.set(weights.layers[l]![key], { first: new Float64Array(weights.layers[l]![key].length), second: new Float64Array(weights.layers[l]![key].length) });
    }
  }
  for (const tensor of [weights.emb, weights.pos, weights.head]) {
    moments.set(tensor, { first: new Float64Array(tensor.length), second: new Float64Array(tensor.length) });
  }
  for (let step = 0; step < PRETRAIN_STEP_COUNT; step += 1) {
    checkLmDeadline(started, maxWallSeconds);
    const gradients = lmSupervisedGradient(shape, weights, null, strings, alphabet, copyTargets, PRETRAIN_LABEL_SMOOTHING);
    for (const [tensor, gradient] of gradientTensors(weights, gradients)) {
      const moment = moments.get(tensor)!;
      for (let i = 0; i < tensor.length; i += 1) {
        const g = gradient[i]!;
        moment.first[i] = 0.9 * moment.first[i]! + 0.1 * g;
        moment.second[i] = 0.999 * moment.second[i]! + 0.001 * g * g;
        const firstHat = moment.first[i]! / (1 - Math.pow(0.9, step + 1));
        const secondHat = moment.second[i]! / (1 - Math.pow(0.999, step + 1));
        tensor[i] -= 0.03 * firstHat / (Math.sqrt(secondHat) + 1e-8);
      }
    }
  }
  checkLmDeadline(started, maxWallSeconds);
  return { weights, strings };
}

/** Pair every weight tensor with its gradient tensor, in a stable order. */
function gradientTensors(weights: LmWeights, gradients: LmGradients): Array<readonly [Float32Array, Float64Array]> {
  const pairs: Array<readonly [Float32Array, Float64Array]> = [
    [weights.emb, gradients.emb], [weights.pos, gradients.pos], [weights.head, gradients.head],
  ];
  for (let l = 0; l < weights.layers.length; l += 1) {
    for (const key of ["ln1g", "ln1b", "ln2g", "ln2b", "wq", "wk", "wv", "wo", "w1", "b1", "w2", "b2"] as const) {
      pairs.push([weights.layers[l]![key], gradients.layers[l]![key]]);
    }
  }
  return pairs;
}

/** Teacher-forced reward proxy; only the exact-match term is an exact sequence probability. */
function teacherForcedRewardProxy(shape: LmModelShape, weights: LmWeights, adapter: LmAdapter | null, example: string, alphabet: readonly string[]): number {
  const target = rotateTargetTokens(example, alphabet);
  const tokens = fullTokens(example, alphabet, target);
  const { logits } = lmForward(shape, weights, adapter, tokens);
  const start = example.length + 1;
  const answerLength = target.length - 1;
  let positional = 0;
  let exactLog = 0;
  for (let i = 0; i < target.length; i += 1) {
    const probabilities = softmax(logits[start + i]!);
    const correct = probabilities[target[i]!]!;
    if (i < answerLength) {
      positional += correct;
      exactLog += Math.log(Math.max(correct, LOG_PROBABILITY_FLOOR));
    }
  }
  return 0.5 * (positional / answerLength) + 0.5 * Math.exp(exactLog);
}

/**
 * The greedy exact-match fraction of a policy over a set of examples.
 *
 * Greedy decoding: at every answer position the argmax token is compared with
 * the rotate task's expected token; a string counts as an exact match only
 * when every position agrees. This is the held-out headline number the
 * acceptance run reports: the base policy copies instead of rotating, so its
 * exact-match is zero, and a promoted adapter moves it strictly up.
 *
 * @param shape - The model architecture.
 * @param weights - The frozen base weights.
 * @param adapter - The policy's adapter, or null for the pure base policy.
 * @param examples - The example strings to decode.
 * @param alphabet - The declared task alphabet.
 * @returns The fraction of examples whose greedy completion exactly matches.
 */
export function lmGreedyExactMatch(shape: LmModelShape, weights: LmWeights, adapter: LmAdapter | null, examples: readonly string[], alphabet: readonly string[]): number {
  let matches = 0;
  for (const example of examples) {
    const target = rotateTargetTokens(example, alphabet);
    const tokens = fullTokens(example, alphabet, target);
    const { logits } = lmForward(shape, weights, adapter, tokens);
    const start = example.length + 1;
    let exact = true;
    for (let i = 0; i < target.length - 1; i += 1) {
      const probabilities = softmax(logits[start + i]!);
      let best = 0;
      for (let c = 1; c < shape.vocab; c += 1) if (probabilities[c]! > probabilities[best]!) best = c;
      if (best !== target[i]) exact = false;
    }
    if (exact) matches += 1;
  }
  return examples.length === 0 ? 0 : matches / examples.length;
}

/** Average teacher-forced proxy, distinct from the sampled verifier reward and greedy accuracy. */
function meanExpectedReward(shape: LmModelShape, weights: LmWeights, adapter: LmAdapter | null, examples: readonly string[], alphabet: readonly string[]): number {
  let total = 0;
  for (const example of examples) total += teacherForcedRewardProxy(shape, weights, adapter, example, alphabet);
  return total / examples.length;
}

/** One collected completion the REINFORCE fit trains on. */
export interface LmFitSample {
  /** The example string the completion was sampled for. */
  readonly example: string;
  /** The sampled answer tokens. */
  readonly tokens: readonly number[];
  /** The exact verifier's reward. */
  readonly reward: number;
}

/**
 * The REINFORCE surrogate objective over a collected batch, with its KL anchor.
 *
 * The surrogate each fit step descends: the exact verifier's sequence reward minus its batch mean
 * gives the advantage that
 * weights the sampled tokens' log-probabilities, and the KL penalty to the
 * frozen base policy anchors the fit. The returned loss differentiates to the
 * returned gradient exactly, which the finite-difference property test proves
 * over every adapter tensor.
 *
 * @param shape - The model architecture.
 * @param weights - The frozen base weights.
 * @param adapter - The adapter to differentiate through, or null for the base policy.
 * @param samples - The collected completions the fit trains on.
 * @param alphabet - The declared task alphabet.
 * @param klWeight - The weight of the KL penalty to the base policy.
 * @param deadline - Optional wall allowance checked between sampled sequences.
 * @returns The surrogate loss and its gradient over every tensor.
 */
export function lmReinforceSurrogate(shape: LmModelShape, weights: LmWeights, adapter: LmAdapter | null, samples: readonly LmFitSample[], alphabet: readonly string[], klWeight: number, deadline?: { readonly started: number; readonly seconds: number }): { loss: number; gradient: LmGradients } {
  const gradient = zeroGradients(shape, adapter !== null);
  const baseline = samples.reduce((total, sample) => total + sample.reward, 0) / samples.length;
  let loss = 0;
  for (const sample of samples) {
    if (deadline !== undefined) checkLmDeadline(deadline.started, deadline.seconds);
    const tokens = fullTokens(sample.example, alphabet, [...sample.tokens, EOS_TOKEN]);
    const baseRun = lmForward(shape, weights, null, tokens);
    const { logits, cache } = lmForward(shape, weights, adapter, tokens);
    const start = sample.example.length + 1;
    const logitGradients: Array<Float64Array | null> = new Array(tokens.length).fill(null);
    for (let i = 0; i < sample.tokens.length; i += 1) {
      const position = start + i;
      const probabilities = softmax(logits[position]!);
      const baseProbabilities = softmax(baseRun.logits[position]!);
      const sampled = sample.tokens[i]!;
      const advantage = sample.reward - baseline;
      loss -= advantage * Math.log(Math.max(probabilities[sampled]!, LOG_PROBABILITY_FLOOR));
      let kl = 0;
      for (let c = 0; c < shape.vocab; c += 1) {
        const policyMass = probabilities[c]!;
        const baseMass = baseProbabilities[c]!;
        kl += policyMass * (Math.log(Math.max(policyMass, LOG_PROBABILITY_FLOOR)) - Math.log(Math.max(baseMass, LOG_PROBABILITY_FLOOR)));
      }
      loss += klWeight * kl;
      const row = new Float64Array(shape.vocab);
      for (let c = 0; c < shape.vocab; c += 1) {
        const policyMass = probabilities[c]!;
        const baseMass = baseProbabilities[c]!;
        // The advantage term is the exact REINFORCE log-likelihood gradient;
        // the KL term is the exact softmax-KL gradient p (log(p/q) - KL),
        // which is NOT the cross-entropy gradient p - q.
        row[c] = -advantage * ((c === sampled ? 1 : 0) - policyMass)
          + klWeight * policyMass * (Math.log(Math.max(policyMass, LOG_PROBABILITY_FLOOR)) - Math.log(Math.max(baseMass, LOG_PROBABILITY_FLOOR)) - kl);
      }
      logitGradients[position] = row;
    }
    accumulateGradients(gradient, lmBackward(shape, weights, adapter, tokens, cache, logitGradients));
  }
  return { loss, gradient };
}

/** The global L2 norm of one adapter gradient bundle. */
function adapterGradientNorm(gradient: LmAdapterGradients): number {
  let sum = 0;
  for (const key of ["aq", "bq", "av", "bv", "ah", "bh"] as const) {
    const tensor = gradient[key];
    for (let i = 0; i < tensor.length; i += 1) sum += tensor[i]! * tensor[i]!;
  }
  return Math.sqrt(sum);
}

/** Apply one gradient step to every adapter tensor with global-norm clipping. */
function stepAdapter(adapter: LmAdapter, gradient: LmAdapterGradients, learningRate: number, clipNorm: number): void {
  const norm = adapterGradientNorm(gradient);
  const scale = norm > clipNorm ? clipNorm / norm : 1;
  for (const key of ["aq", "bq", "av", "bv", "ah", "bh"] as const) {
    const tensor = adapter[key];
    const grad = gradient[key];
    for (let i = 0; i < tensor.length; i += 1) tensor[i] -= learningRate * scale * grad[i]!;
  }
}

/** The L2 norm of the difference between two adapters' tensors. */
function adapterDeltaL2(source: LmAdapter, candidate: LmAdapter): number {
  let sum = 0;
  for (const key of ["aq", "bq", "av", "bv", "ah", "bh"] as const) {
    for (let i = 0; i < source[key].length; i += 1) {
      const delta = candidate[key][i]! - source[key][i]!;
      sum += delta * delta;
    }
  }
  return Math.sqrt(sum);
}

/** Derive the deterministic seed of one collection sample's completion stream. */
export function lmSampleSeed(base: number, generation: number, sample: number): number {
  return trainerSampleSeed(base, generation, sample);
}



/**
 * Collect one generation's on-policy completion batch from the source policy.
 *
 * Collection cycles the training examples in declared order and samples every
 * completion from the SOURCE checkpoint's policy under per-sample deterministic
 * seeds, so the batch is a pure function of the programme, the generation and
 * the collecting checkpoint — a replay reproduces it token for token. Only the
 * verifier's reward is kept from each episode; the targets never enter the
 * gradient directly.
 *
 * @param config - The validated language-model loop configuration.
 * @param generation - The one-based generation number.
 * @param source - The promoted checkpoint whose policy collects this batch.
 * @returns The complete ordered batch of collected completions.
 */
export function lmCollectBatch(config: LmLoopConfig, generation: number, source: LmCheckpoint): readonly LmObservation[] {
  const started = performance.now();
  const observations: LmObservation[] = [];
  for (let sample = 0; sample < config.samplesPerGeneration; sample += 1) {
    checkLmDeadline(started, config.limits.maxWallSeconds);
    const example = config.training[sample % config.training.length]!;
    const completion = sampleLmCompletion(config.shape, config.base, source.adapter, example.string, config.alphabet, lmSampleSeed(config.seed, generation, sample));
    const expected = rotateTargetTokens(example.string, config.alphabet);
    observations.push({ example: example.id, tokens: completion.tokens, reward: lmCompletionReward(completion.tokens, expected) });
  }
  return observations;
}

/**
 * Render one collected batch as ordered, tagged, merge-safe metric events.
 *
 * One event per collected completion: the step is the sample index, the value
 * is the exact verifier's reward, and the tags carry the example identity and
 * the sampled tokens, so a run's note history is the durable reward curve and a
 * resume can decode the batch back from it.
 *
 * @param observations - The complete ordered collected batch.
 * @returns One metric event per collected completion, in collection order.
 */
export function lmCollectionEvents(observations: readonly LmObservation[]): readonly MetricEvent[] {
  return observations.map((observation, index): MetricEvent => ({
    step: index,
    metric: LM_COLLECTION_METRIC,
    value: observation.reward,
    tags: { example: observation.example, tokens: JSON.stringify(observation.tokens) },
  }));
}

/**
 * Decode one persisted collection event back into its observation.
 *
 * Every field is re-validated: the metric must be the collection metric, the
 * example must be a declared training identity, the tokens must decode to the
 * declared string length, and the recorded reward must equal the exact
 * verifier's reward of those tokens, so a tampered or truncated note is refused
 * as evidence rather than rescaled.
 *
 * @param event - The metric event read from the run's notes.
 * @param config - The validated loop configuration the event belongs to.
 * @param source - Human-readable origin for error messages.
 * @returns The decoded observation.
 * @throws An expected CLI error when the event is not a valid persisted completion.
 */
export function parseLmCollectionEvent(event: MetricEvent, config: LmLoopConfig, source: string): LmObservation {
  if (event.metric !== LM_COLLECTION_METRIC) {
    expectedFail(`${source} must carry the ${LM_COLLECTION_METRIC} metric.`, "lm_event_metric");
  }
  const example = event.tags?.["example"];
  if (typeof example !== "string" || example.trim().length === 0) {
    expectedFail(`${source} must tag its example identity.`, "lm_event_example");
  }
  const encoded = event.tags?.["tokens"];
  if (typeof encoded !== "string") {
    expectedFail(`${source} must tag its sampled tokens as JSON.`, "lm_event_tokens");
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(encoded);
  } catch {
    expectedFail(`${source} tokens tag is not valid JSON.`, "lm_event_tokens");
  }
  if (!Array.isArray(decoded) || decoded.length !== config.shape.stringLength || decoded.some((token) => typeof token !== "number" || !Number.isInteger(token) || token < 0 || token >= config.shape.vocab)) {
    expectedFail(`${source} tokens tag must be an array of ${config.shape.stringLength} valid token ids.`, "lm_event_tokens");
  }
  const match = config.training.find((candidate) => candidate.id === example);
  if (match === undefined) {
    expectedFail(`${source} names training example ${example}, which this programme does not declare.`, "lm_event_example");
  }
  const tokens = decoded as number[];
  const reward = lmCompletionReward(tokens, rotateTargetTokens(match.string, config.alphabet));
  if (!Number.isFinite(event.value) || event.value < 0 || event.value > 1 || Math.abs(event.value - reward) > 1e-12) {
    expectedFail(`${source} must record the exact verifier reward of its sampled tokens.`, "lm_event_value");
  }
  return { example, tokens, reward: event.value };
}

/** Sample one policy's held-out completions and return the empirical mean reward. */
function sampledHeldOutMean(config: LmLoopConfig, generation: number, adapter: LmAdapter | null, episodes: number, seed: number, started: number | null): number {
  let state = seed;
  let total = 0;
  for (let episode = 0; episode < episodes; episode += 1) {
    if (started !== null) checkLmDeadline(started, config.limits.maxWallSeconds);
    const example = config.evaluation[episode % config.evaluation.length]!;
    const completion = sampleLmCompletion(config.shape, config.base, adapter, example.string, config.alphabet, state);
    state = completion.state;
    total += lmCompletionReward(completion.tokens, rotateTargetTokens(example.string, config.alphabet));
  }
  return total / episodes;
}

/**
 * Execute one language-model generation step over a complete collected batch.
 *
 * The step is pure over its inputs: it fits the adapter on the collected batch
 * by REINFORCE with the batch-mean baseline, the KL penalty to the frozen base
 * policy and global-norm gradient clipping, evaluates both checkpoints on the
 * held-out examples, samples the gate's evidence on seeded streams, checks
 * the declared checkpoint-bytes and wall-seconds limits, and renders the
 * verdict. The wall time is `null` when this call IS the work: the fit and the
 * evaluation are then measured around their own execution and the measured
 * value is persisted with the receipt. A replay passes the persisted value
 * instead, so it re-renders the identical verdict — including the wall-limit
 * verdict — without re-charging the clock.
 *
 * @param config - The validated language-model loop configuration.
 * @param step - This generation's derived step configuration.
 * @param generation - The one-based generation number.
 * @param source - The promoted checkpoint whose policy collected the batch.
 * @param observations - The complete ordered collected batch.
 * @param wallMs - The persisted wall milliseconds to replay, or null to measure this execution.
 * @returns The generation's complete receipt, including its terminal condition.
 */
export function executeLmStep(config: LmLoopConfig, step: LoopStepConfig, generation: number, source: LmCheckpoint, observations: readonly LmObservation[], wallMs: number | null): LmGeneration {
  const startedAt = wallMs === null ? performance.now() : 0;
  const samples: LmFitSample[] = observations.map((observation) => {
    const example = config.training.find((candidate) => candidate.id === observation.example);
    if (example === undefined) {
      expectedFail(`Collected completion names training example ${observation.example}, which this programme does not declare.`, "lm_collection_example");
    }
    return { example: example.string, tokens: observation.tokens, reward: observation.reward };
  });
  const deadline = wallMs === null ? { started: startedAt, seconds: config.limits.maxWallSeconds } : undefined;
  const adapter = copyLmAdapter(source.adapter);
  const before = lmReinforceSurrogate(config.shape, config.base, source.adapter, samples, config.alphabet, config.klWeight, deadline);
  for (let fitStep = 0; fitStep < config.fitSteps; fitStep += 1) {
    if (wallMs === null) checkLmDeadline(startedAt, config.limits.maxWallSeconds);
    const { gradient } = lmReinforceSurrogate(config.shape, config.base, adapter, samples, config.alphabet, config.klWeight, deadline);
    stepAdapter(adapter, gradient.adapter!, step.learningRate, config.clipNorm);
  }
  const after = lmReinforceSurrogate(config.shape, config.base, adapter, samples, config.alphabet, config.klWeight, deadline);
  const candidate = lmCheckpoint(adapter, config);
  const collectionDigest = lmDigest({
    source: source.digest,
    trainingDigest: config.trainingDigest,
    collection: observations.map((observation) => ({ example: observation.example, tokens: [...observation.tokens], reward: observation.reward })),
  });
  const baselineScore = meanExpectedReward(config.shape, config.base, source.adapter, config.evaluation.map((example) => example.string), config.alphabet);
  const trainingScore = meanExpectedReward(config.shape, config.base, adapter, config.training.map((example) => example.string), config.alphabet);
  const evaluationScore = meanExpectedReward(config.shape, config.base, adapter, config.evaluation.map((example) => example.string), config.alphabet);
  const [incumbentSeed, candidateSeed] = evaluationSeeds(config.seed, generation);
  const incumbentHeldOutMean = sampledHeldOutMean(config, generation, source.adapter, step.evaluationSamples, incumbentSeed, wallMs === null ? startedAt : null);
  const candidateHeldOutMean = sampledHeldOutMean(config, generation, adapter, step.evaluationSamples, candidateSeed, wallMs === null ? startedAt : null);
  // The wall clock stops after the last unit of charged work: the fit, the
  // expected-reward and exact-match evaluations, and the gate's sampled
  // episodes. A replay passes the persisted value and skips this measurement.
  const evidence: Omit<LmGeneration, "promoted" | "refusalReason" | "stopReason"> = {
    generation,
    source,
    candidate,
    collectionDigest,
    observations,
    lossBefore: before.loss,
    lossAfter: after.loss,
    parameterDeltaL2: adapterDeltaL2(source.adapter, adapter),
    baselineExactMatch: lmGreedyExactMatch(config.shape, config.base, source.adapter, config.evaluation.map((example) => example.string), config.alphabet),
    candidateExactMatch: lmGreedyExactMatch(config.shape, config.base, adapter, config.evaluation.map((example) => example.string), config.alphabet),
    baselineScore,
    trainingScore,
    evaluationScore,
    incumbentHeldOutMean,
    candidateHeldOutMean,
    wallMs: wallMs === null ? performance.now() - startedAt : wallMs,
  };
  // The declared limits are fail-closed bounds on the artifacts themselves: a
  // candidate whose serialized checkpoint exceeds the declared byte budget,
  // or a fit that exceeded the declared wall budget, is refused with its own
  // recorded reason and never becomes a collection policy.
  const serialized = serializeLmCheckpoint(candidate, config);
  if (serialized.bytes > config.limits.maxCheckpointBytes) {
    return { ...evidence, promoted: false,
      refusalReason: `serialized checkpoint occupies ${serialized.bytes} bytes, exceeding the declared maximum ${config.limits.maxCheckpointBytes}`,
      stopReason: "checkpoint_limit_exceeded" };
  }
  if (evidence.wallMs > config.limits.maxWallSeconds * 1000) {
    return { ...evidence, promoted: false,
      refusalReason: `fit and evaluation took ${evidence.wallMs.toFixed(0)}ms, exceeding the declared maximum ${config.limits.maxWallSeconds}s`,
      stopReason: "wall_limit_exceeded" };
  }
  if (evidence.candidateExactMatch < evidence.baselineExactMatch) {
    return { ...evidence, promoted: false, stopReason: "evaluation_rejected",
      refusalReason: "cannot promote a regression in greedy held-out exact-match" };
  }
  return { ...evidence, ...decideTrainerPromotion({ changed: source.digest !== candidate.digest, generation, training: trainingScore,
    evaluation: evaluationScore, baseline: baselineScore, maximumGap: config.maximumGap, version: "pm-rl/lm/1", context: config.evaluationDigest,
    samples: step.evaluationSamples, candidateMean: candidateHeldOutMean, incumbentMean: incumbentHeldOutMean,
    criterion: { confidence: config.confidence, minSamples: config.minSamples, effectThreshold: config.minimumImprovement } }) };

}

/** Render one example as the plain JSON value the environment spec stores. */
function jsonExample(example: LmExample): JsonValue {
  return { id: example.id, string: example.string };
}

/** Validate one declared alphabet: unique single characters, at least two symbols. */
function validatedAlphabet(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length < 2 || value.length > MAX_LM_ALPHABET) {
    expectedFail(`LM loop configuration alphabet must be an array of 2 to ${MAX_LM_ALPHABET} symbols.`, "lm_invalid_alphabet");
  }
  const symbols: string[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== "string" || entry.length !== 1 || seen.has(entry)) {
      expectedFail("LM loop configuration alphabet must be an array of unique single-character symbols.", "lm_invalid_alphabet");
    }
    seen.add(entry);
    symbols.push(entry);
  }
  return symbols;
}

/**
 * Validate both task datasets and return them with their content identities.
 *
 * Every example's string must use exactly the declared string length and the
 * declared alphabet. Example identities must be unique and disjoint across the
 * collection and held-out sets, AND the string content digests must be disjoint
 * too: a held-out string that reappears under a different id is contamination,
 * refused here before any completion is collected.
 *
 * @param training - The raw collection examples.
 * @param evaluation - The raw held-out examples.
 * @param alphabet - The validated task alphabet.
 * @param stringLength - The one declared string length.
 * @returns Both validated example sets with their ordered content identities.
 * @throws An expected CLI error when a dataset is empty, oversized, malformed, or overlapping.
 */
export function validatedLmDatasets(training: readonly unknown[], evaluation: readonly unknown[], alphabet: readonly string[], stringLength: number): { readonly training: readonly LmExample[]; readonly evaluation: readonly LmExample[]; readonly trainingDigest: string; readonly evaluationDigest: string } {
  const identities = new Set<string>();
  const contents = new Set<string>();
  const datasets: LmExample[][] = [];
  for (const dataset of [training, evaluation]) {
    if (dataset.length === 0 || dataset.length > MAX_LM_EXAMPLES) {
      expectedFail(`LM loop datasets must carry 1 to ${MAX_LM_EXAMPLES} examples.`, "lm_invalid_dataset_size");
    }
    const validated: LmExample[] = [];
    for (const entry of dataset) {
      const record = asJsonObject(entry, "LM example", "lm_invalid_example");
      const id = requiredTrimmedString(record, "id", "LM example", "lm_example_");
      const string = requiredTrimmedString(record, "string", "LM example", "lm_example_");
      if (string.length !== stringLength) {
        expectedFail(`LM example ${id} carries a string of length ${string.length}; the programme declares string length ${stringLength}.`, "lm_example_string_length");
      }
      for (const symbol of string) {
        if (!alphabet.includes(symbol)) {
          expectedFail(`LM example ${id} uses symbol ${symbol}, which the declared alphabet does not carry.`, "lm_example_string_symbol");
        }
      }
      const content = lmDigest({ string });
      if (identities.has(id)) {
        expectedFail(`LM example identity ${id} is reused across collection and held-out datasets; held-out items that leak into training stop the loop.`, "lm_dataset_overlap");
      }
      if (contents.has(content)) {
        expectedFail(`LM string ${string} appears in both collection and held-out datasets; held-out content that leaks into training stops the loop.`, "lm_dataset_overlap");
      }
      identities.add(id);
      contents.add(content);
      validated.push({ id, string });
    }
    datasets.push(validated);
  }
  return {
    training: datasets[0],
    evaluation: datasets[1],
    trainingDigest: lmDigest(datasets[0].map(jsonExample)),
    evaluationDigest: lmDigest(datasets[1].map(jsonExample)),
  };
}

/**
 * Parse and validate one bounded language-model loop configuration.
 *
 * Mirrors the shared fail-closed discipline for the loop bounds, and validates
 * the language-model specifics: a declared alphabet of unique single-character
 * symbols, a declared model width bounded to {@link MAX_LM_MODEL_DIM}, one or
 * two transformer blocks, a LoRA rank bounded to {@link MAX_LM_LORA_RANK}, a
 * declared string length bounded to {@link MAX_LM_STRING_LENGTH}, disjoint
 * datasets by identity AND by string content, declared fail-closed limits, and
 * exactly the MIT licences this adapter is authorized to train under. Parsing
 * regenerates the frozen base policy deterministically from the seed, so the
 * returned configuration carries real base weights, their content identity,
 * and the seeded starting adapter.
 *
 * @param raw - The parsed loop configuration document.
 * @returns The validated language-model configuration with all content identities.
 * @throws An expected CLI error naming the first missing, mistyped, or out-of-bounds field.
 */
export function parseLmLoopConfig(raw: JsonValue): LmLoopConfig {
  const record = asJsonObject(raw, "LM loop configuration", "lm_invalid_json");
  const environment = asJsonObject(record["environment"] ?? null, "LM loop configuration environment", "lm_invalid_environment");
  const environmentName = requiredTrimmedString(environment, "name", "LM loop configuration environment", "lm_environment_");
  const environmentVersion = requiredTrimmedString(environment, "version", "LM loop configuration environment", "lm_environment_");
  if (record["task"] !== undefined && record["task"] !== "rotate") {
    expectedFail('LM loop configuration task must be "rotate"; it is the only verifiable target task this adapter implements.', "lm_invalid_task");
  }
  const alphabet = validatedAlphabet(record["alphabet"]);
  const model = asJsonObject(record["model"] ?? null, "LM loop configuration model", "lm_invalid_model");
  const dModel = storedCheckpointNumber(model, "d_model", "LM loop configuration", "lm_invalid_d_model");
  const ffn = storedCheckpointNumber(model, "ffn", "LM loop configuration", "lm_invalid_ffn");
  const layers = storedCheckpointNumber(model, "layers", "LM loop configuration", "lm_invalid_layers");
  const rank = storedCheckpointNumber(model, "rank", "LM loop configuration", "lm_invalid_rank");
  const stringLength = storedCheckpointNumber(record, "string_length", "LM loop configuration", "lm_invalid_string_length");
  if (!Number.isInteger(dModel) || dModel < 4 || dModel > MAX_LM_MODEL_DIM) {
    expectedFail(`LM loop configuration model d_model must be an integer from 4 to ${MAX_LM_MODEL_DIM}.`, "lm_invalid_d_model");
  }
  if (!Number.isInteger(ffn) || ffn < 4 || ffn > MAX_LM_FFN_DIM) {
    expectedFail(`LM loop configuration model ffn must be an integer from 4 to ${MAX_LM_FFN_DIM}.`, "lm_invalid_ffn");
  }
  if (!Number.isInteger(layers) || layers < 1 || layers > 2) {
    expectedFail("LM loop configuration model layers must be 1 or 2.", "lm_invalid_layers");
  }
  if (!Number.isInteger(rank) || rank < 1 || rank > MAX_LM_LORA_RANK) {
    expectedFail(`LM loop configuration model rank must be an integer from 1 to ${MAX_LM_LORA_RANK}.`, "lm_invalid_rank");
  }
  if (!Number.isInteger(stringLength) || stringLength < 1 || stringLength > MAX_LM_STRING_LENGTH) {
    expectedFail(`LM loop configuration string_length must be an integer from 1 to ${MAX_LM_STRING_LENGTH}.`, "lm_invalid_string_length");
  }
  const shape: LmModelShape = {
    vocab: alphabet.length + 3,
    dModel, ffn, layers, rank,
    stringLength,
    maxPositions: 2 * stringLength + 3,
  };
  const trainingField = record["training"];
  const evaluationField = record["evaluation"];
  if (!Array.isArray(trainingField) || !Array.isArray(evaluationField)) {
    expectedFail("LM loop configuration requires training and evaluation example arrays.", "lm_invalid_datasets");
  }
  const datasets = validatedLmDatasets(trainingField, evaluationField, alphabet, stringLength);
  const limitsRecord = asJsonObject(record["limits"] ?? null, "LM loop configuration limits", "lm_invalid_limits");
  const maxParameters = storedCheckpointNumber(limitsRecord, "max_parameters", "LM loop configuration", "lm_invalid_max_parameters");
  const maxCheckpointBytes = storedCheckpointNumber(limitsRecord, "max_checkpoint_bytes", "LM loop configuration", "lm_invalid_max_checkpoint_bytes");
  const maxSteps = storedCheckpointNumber(limitsRecord, "max_steps", "LM loop configuration", "lm_invalid_max_steps");
  const maxWallSeconds = storedCheckpointNumber(limitsRecord, "max_wall_seconds", "LM loop configuration", "lm_invalid_max_wall_seconds");
  const modelLicense = requiredTrimmedString(limitsRecord, "model_license", "LM loop configuration limits", "lm_limits_");
  const datasetLicense = requiredTrimmedString(limitsRecord, "dataset_license", "LM loop configuration limits", "lm_limits_");
  if (modelLicense !== LM_SUPPORTED_LICENCE || datasetLicense !== LM_SUPPORTED_LICENCE) {
    expectedFail(`LM loop configuration limits must declare the ${LM_SUPPORTED_LICENCE} licence for both model and dataset; this adapter trains only self-authored synthetic MIT-licensed content.`, "lm_invalid_license");
  }
  if (!Number.isInteger(maxParameters) || maxParameters < 1 || maxParameters > 100_000) {
    expectedFail("LM loop configuration limits max_parameters must be a positive integer up to 100000.", "lm_invalid_max_parameters");
  }
  const modelParameters = lmParameterCount(shape);
  if (modelParameters > maxParameters) {
    expectedFail(`LM loop configuration limits max_parameters ${maxParameters} is below the ${modelParameters} total parameters the declared model carries.`, "lm_limit_parameters_exceeded");
  }
  if (!Number.isInteger(maxCheckpointBytes) || maxCheckpointBytes < 1) {
    expectedFail("LM loop configuration limits max_checkpoint_bytes must be a positive integer.", "lm_invalid_max_checkpoint_bytes");
  }
  if (!Number.isInteger(maxSteps) || maxSteps < 1 || maxSteps > MAX_LM_FIT_STEPS) {
    expectedFail(`LM loop configuration limits max_steps must be an integer from 1 to ${MAX_LM_FIT_STEPS}.`, "lm_invalid_max_steps");
  }
  if (!Number.isFinite(maxWallSeconds) || maxWallSeconds <= 0 || maxWallSeconds > 3600) {
    expectedFail("LM loop configuration limits max_wall_seconds must be a positive number up to 3600.", "lm_invalid_max_wall_seconds");
  }
  const limits: LmLimits = { maxParameters, maxCheckpointBytes, maxSteps, maxWallSeconds, modelLicense, datasetLicense };
  const seed = storedCheckpointNumber(record, "seed", "LM loop configuration", "lm_invalid_seed");
  const maxGenerations = storedCheckpointNumber(record, "max_generations", "LM loop configuration", "lm_invalid_max_generations");
  const samplesPerGeneration = storedCheckpointNumber(record, "samples_per_generation", "LM loop configuration", "lm_invalid_samples_per_generation");
  const budget = storedCheckpointNumber(record, "budget", "LM loop configuration", "lm_invalid_budget");
  const learningRate = storedCheckpointNumber(record, "learning_rate", "LM loop configuration", "lm_invalid_learning_rate");
  const fitSteps = storedCheckpointNumber(record, "fit_steps", "LM loop configuration", "lm_invalid_fit_steps");
  const klWeight = storedCheckpointNumber(record, "kl_weight", "LM loop configuration", "lm_invalid_kl_weight");
  const clipNorm = storedCheckpointNumber(record, "clip_norm", "LM loop configuration", "lm_invalid_clip_norm");
  const minimumImprovement = storedCheckpointNumber(record, "minimum_improvement", "LM loop configuration", "lm_invalid_minimum_improvement");
  const maximumGap = storedCheckpointNumber(record, "maximum_gap", "LM loop configuration", "lm_invalid_maximum_gap");
  const evaluationSamples = storedCheckpointNumber(record, "evaluation_samples", "LM loop configuration", "lm_invalid_evaluation_samples");
  const confidence = storedCheckpointNumber(record, "confidence", "LM loop configuration", "lm_invalid_confidence");
  const minSamples = storedCheckpointNumber(record, "min_samples", "LM loop configuration", "lm_invalid_min_samples");
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffff_ffff) {
    expectedFail("LM loop configuration seed must be an unsigned 32-bit integer.", "lm_invalid_seed");
  }
  if (!Number.isInteger(maxGenerations) || maxGenerations < 1 || maxGenerations > 100) {
    expectedFail("LM loop configuration max_generations must be an integer from 1 to 100.", "lm_invalid_max_generations");
  }
  if (!Number.isInteger(samplesPerGeneration) || samplesPerGeneration < 1) {
    expectedFail("LM loop configuration samples_per_generation must be a positive integer.", "lm_invalid_samples_per_generation");
  }
  if (!Number.isInteger(budget) || budget < samplesPerGeneration || budget > 100_000) {
    expectedFail(`LM loop configuration budget must be an integer covering at least one generation (${samplesPerGeneration}) up to 100000.`, "lm_invalid_budget");
  }
  if (learningRate < MIN_LM_LEARNING_RATE || learningRate > 5) {
    expectedFail(`LM loop configuration learning_rate must be in [${MIN_LM_LEARNING_RATE}, 5].`, "lm_invalid_learning_rate");
  }
  if (!Number.isInteger(fitSteps) || fitSteps < 1 || fitSteps > limits.maxSteps) {
    expectedFail(`LM loop configuration fit_steps must be an integer from 1 to the declared max_steps (${limits.maxSteps}).`, "lm_invalid_fit_steps");
  }
  if (!Number.isFinite(klWeight) || klWeight < 0 || klWeight > 1) {
    expectedFail("LM loop configuration kl_weight must be in [0, 1].", "lm_invalid_kl_weight");
  }
  if (!Number.isFinite(clipNorm) || clipNorm <= 0 || clipNorm > 100) {
    expectedFail("LM loop configuration clip_norm must be a positive number up to 100.", "lm_invalid_clip_norm");
  }
  if (!Number.isFinite(minimumImprovement) || minimumImprovement <= 0) {
    expectedFail("LM loop configuration minimum_improvement must be strictly positive.", "lm_invalid_minimum_improvement");
  }
  if (!Number.isFinite(maximumGap) || maximumGap < 0) {
    expectedFail("LM loop configuration maximum_gap must be finite and non-negative.", "lm_invalid_maximum_gap");
  }
  if (!Number.isInteger(evaluationSamples) || evaluationSamples < 1 || evaluationSamples > 100_000) {
    expectedFail("LM loop configuration evaluation_samples must be an integer from 1 to 100000.", "lm_invalid_evaluation_samples");
  }
  if (!Number.isFinite(confidence) || confidence <= 0 || confidence >= 1) {
    expectedFail("LM loop configuration confidence must be in (0, 1).", "lm_invalid_confidence");
  }
  if (!Number.isInteger(minSamples) || minSamples < 1) {
    expectedFail("LM loop configuration min_samples must be a positive integer.", "lm_invalid_min_samples");
  }
  if (PRETRAIN_STEP_COUNT + maxGenerations * fitSteps > maxSteps) {
    expectedFail("Declared optimizer step limit cannot cover pretraining and the bounded generations.", "lm_limit_steps_exceeded");
  }
  // The frozen base is regenerated deterministically from the seed and its
  // content identity is what every checkpoint binds; the starting adapter is
  // the seeded low-rank draw whose output projections are zero, so the initial
  // policy IS the base. The declared byte budget must already fit that seed
  // checkpoint: a programme whose own seed exceeds its declared limit never
  // starts collecting.
  const base = trainLmBasePolicy(shape, alphabet, seed, datasets.training.map((example) => example.string), maxWallSeconds);
  const baseDigest = lmDigest(jsonLmWeights(shape, base.weights));
  const initial = lmCheckpoint(seededLmAdapter(shape, (Math.imul(seed, 0x85ebca6b) ^ 0xc2b2ae35) >>> 0), { baseDigest, shape });
  if (serializeLmCheckpoint(initial, { baseDigest, shape }).bytes > maxCheckpointBytes) {
    expectedFail(`LM loop configuration limits max_checkpoint_bytes ${maxCheckpointBytes} cannot hold the serialized seed checkpoint; the programme is unbounded as declared.`, "lm_limit_checkpoint_bytes");
  }
  const config: LmLoopConfig = {
    environmentName,
    environmentVersion,
    alphabet,
    training: datasets.training,
    evaluation: datasets.evaluation,
    trainingDigest: datasets.trainingDigest,
    evaluationDigest: datasets.evaluationDigest,
    base: base.weights,
    baseDigest,
    shape,
    initial,
    limits,
    seed,
    maxGenerations,
    samplesPerGeneration,
    budget,
    learningRate,
    fitSteps,
    klWeight,
    clipNorm,
    minimumImprovement,
    maximumGap,
    evaluationSamples,
    confidence,
    minSamples,
    digest: "",
  };
  return { ...config, digest: lmDigest({
    format: LM_PROGRAMME_FORMAT,
    environment: { name: environmentName, version: environmentVersion },
    task: "rotate",
    alphabet: [...alphabet],
    trainingDigest: datasets.trainingDigest,
    evaluationDigest: datasets.evaluationDigest,
    model: { d_model: dModel, ffn, layers, rank, string_length: stringLength },
    limits: { max_parameters: maxParameters, max_checkpoint_bytes: maxCheckpointBytes, max_steps: maxSteps, max_wall_seconds: maxWallSeconds, model_license: modelLicense, dataset_license: datasetLicense },
    base_checkpoint: baseDigest,
    initial_checkpoint: config.initial.digest,
    seed, maxGenerations, samplesPerGeneration, budget, learningRate, fitSteps, klWeight, clipNorm,
    minimumImprovement, maximumGap, evaluationSamples, confidence, minSamples,
  }) };
}

/** Render the validated configuration as the JSON the seed item persists for replay. */
export function lmConfigurationJson(config: LmLoopConfig): JsonValue {
  return {
    trainer: "lm",
    environment: { name: config.environmentName, version: config.environmentVersion },
    task: "rotate",
    alphabet: [...config.alphabet],
    model: { d_model: config.shape.dModel, ffn: config.shape.ffn, layers: config.shape.layers, rank: config.shape.rank },
    limits: { max_parameters: config.limits.maxParameters, max_checkpoint_bytes: config.limits.maxCheckpointBytes, max_steps: config.limits.maxSteps,
      max_wall_seconds: config.limits.maxWallSeconds, model_license: config.limits.modelLicense, dataset_license: config.limits.datasetLicense },
    training: config.training.map(jsonExample),
    evaluation: config.evaluation.map(jsonExample),
    string_length: config.shape.stringLength,
    seed: config.seed,
    max_generations: config.maxGenerations,
    samples_per_generation: config.samplesPerGeneration,
    budget: config.budget,
    learning_rate: config.learningRate,
    fit_steps: config.fitSteps,
    kl_weight: config.klWeight,
    clip_norm: config.clipNorm,
    minimum_improvement: config.minimumImprovement,
    maximum_gap: config.maximumGap,
    evaluation_samples: config.evaluationSamples,
    confidence: config.confidence,
    min_samples: config.minSamples,
  };
}

/**
 * Build the content-addressed environment the language-model loop registers.
 *
 * The task suite carries the declared alphabet, the rotate task contract, and
 * both disjoint datasets verbatim, so the environment item's content hash is
 * the identity every collection run's provenance records, and the reward
 * specification pins the bounded verifier contract the gate's Hoeffding bound
 * assumes.
 *
 * @param config - The validated language-model loop configuration.
 * @returns The environment specification to register.
 */
export function lmEnvironmentSpec(config: LmLoopConfig): EnvironmentSpec {
  return {
    name: config.environmentName,
    version: config.environmentVersion,
    task_suite: {
      alphabet: [...config.alphabet],
      task: "rotate",
      collection: config.training.map(jsonExample),
      held_out: config.evaluation.map(jsonExample),
    },
    reward_specification: {
      format: LM_REWARD_FORMAT,
      reward_bounds: [LM_REWARD_BOUNDS[0], LM_REWARD_BOUNDS[1]],
      held_out_isolated_from_collection: true,
    },
  };
}

/** Build the run item's pre-collection configuration for one language-model generation. */
export function lmRunConfig(config: LmLoopConfig, step: LoopStepConfig, generation: number, source: LmCheckpoint): JsonValue {
  return {
    format: LM_RUN_FORMAT,
    generation,
    learning_rate: step.learningRate,
    evaluation_samples: step.evaluationSamples,
    fit_steps: config.fitSteps,
    samples: config.samplesPerGeneration,
    source_checkpoint: source.digest,
  };
}

/**
 * Build the training configuration recorded on one candidate generation item.
 *
 * Everything the generation's provenance needs to be replayed: the derived
 * configuration, both checkpoint identities, the candidate's ACTUAL adapter
 * tensors — the canonical serialized checkpoint artifact — the measured
 * parameter delta, the reward and evaluation curve numbers, the exact-match
 * fractions, and the measured wall milliseconds.
 *
 * @param config - The validated language-model loop configuration.
 * @param step - The configuration this generation ran under.
 * @param receipt - The generation's receipt.
 * @returns The training configuration to store in the generation item's body.
 */
export function lmGenerationTrainingConfig(config: LmLoopConfig, step: LoopStepConfig, receipt: LmGeneration): JsonValue {
  return {
    format: LM_GENERATION_FORMAT,
    generation: receipt.generation,
    learning_rate: step.learningRate,
    evaluation_samples: step.evaluationSamples,
    fit_steps: config.fitSteps,
    samples: config.samplesPerGeneration,
    collection_digest: receipt.collectionDigest,
    source_checkpoint: receipt.source.digest,
    candidate_checkpoint: receipt.candidate.digest,
    candidate_adapter: jsonLmAdapter(receipt.candidate.adapter),
    checkpoint_path: lmCheckpointPath(receipt.candidate),
    checkpoint_bytes: serializeLmCheckpoint(receipt.candidate, config).bytes,
    total_parameters: lmParameterCount(config.shape),
    optimizer_steps_reserved: PRETRAIN_STEP_COUNT + config.maxGenerations * config.fitSteps,
    parameter_delta_l2: receipt.parameterDeltaL2,
    loss_before: receipt.lossBefore,
    loss_after: receipt.lossAfter,
    baseline_exact_match: receipt.baselineExactMatch,
    candidate_exact_match: receipt.candidateExactMatch,
    training_score: receipt.trainingScore,
    evaluation_score: receipt.evaluationScore,
    incumbent_held_out_mean: receipt.incumbentHeldOutMean,
    candidate_held_out_mean: receipt.candidateHeldOutMean,
    wall_ms: receipt.wallMs,
  };
}

/** Build the seed generation's training configuration, embedding the whole programme for replay. */
export function lmSeedTrainingConfig(config: LmLoopConfig): JsonValue {
  return {
    format: LM_SEED_FORMAT,
    programme: config.digest,
    base_checkpoint: config.baseDigest,
    pretraining_digest: lmDigest(config.training.map((example) => example.string)),
    initial_checkpoint: config.initial.digest,
    initial_adapter: jsonLmAdapter(config.initial.adapter),
    configuration: lmConfigurationJson(config),
  };
}

/** Read one adapter tensor from a persisted record with its exact expected length. */
function storedTensor(record: Readonly<Record<string, unknown>>, key: string, length: number, source: string): Float32Array {
  const value = record[key];
  if (!Array.isArray(value) || value.length !== length) {
    expectedFail(`${source} requires a ${key} tensor of exactly ${length} values; the persisted checkpoint is invalid.`, "lm_invalid_checkpoint");
  }
  const tensor = new Float32Array(length);
  for (let index = 0; index < length; index += 1) {
    const entry = value[index];
    if (typeof entry !== "number" || !Number.isFinite(entry)) {
      expectedFail(`${source} requires finite values in its ${key} tensor; the persisted checkpoint is invalid.`, "lm_invalid_checkpoint");
    }
    tensor[index] = entry;
    if (tensor[index] !== entry) {
      expectedFail("LM checkpoint tensor values must be exactly representable as Float32.", "lm_invalid_checkpoint");
    }
  }
  return tensor;
}

/** Parse one persisted adapter into validated tensors of the declared shape. */
export function parseLmAdapter(value: unknown, shape: LmModelShape, source: string): LmAdapter {
  const record = asJsonObject(value, source, "lm_invalid_checkpoint");
  return {
    aq: storedTensor(record, "aq", shape.rank * shape.dModel, source),
    bq: storedTensor(record, "bq", shape.dModel * shape.rank, source),
    av: storedTensor(record, "av", shape.rank * shape.dModel, source),
    bv: storedTensor(record, "bv", shape.dModel * shape.rank, source),
    ah: storedTensor(record, "ah", shape.rank * shape.dModel, source),
    bh: storedTensor(record, "bh", shape.vocab * shape.rank, source),
  };
}

/**
 * Parse and validate one persisted language-model generation training configuration.
 *
 * The checkpoint guards live here: the candidate adapter must parse to exactly
 * the declared tensor shapes (no NaN, nothing foreign, nothing missing), and
 * the recorded candidate digest must match the digest of those very tensors,
 * so a tampered hash or a corrupted parameter set is refused before the chain
 * can advance from it.
 *
 * @param value - The training configuration JSON read from the generation item.
 * @param config - The validated loop configuration the generation belongs to.
 * @param source - Human-readable origin for error messages.
 * @returns The validated stored generation.
 * @throws An expected CLI error with a stable invalid-checkpoint code.
 */
export function parseStoredLmGeneration(value: JsonValue, config: LmLoopConfig, source: string): StoredLmGeneration {
  const record = asJsonObject(value, source, "lm_invalid_training_config");
  if (record["format"] !== LM_GENERATION_FORMAT) {
    expectedFail(`${source} must carry the ${LM_GENERATION_FORMAT} format marker.`, "lm_invalid_training_config");
  }
  const generation = storedCheckpointNumber(record, "generation", source, "lm_invalid_training_config");
  if (!Number.isInteger(generation) || generation < 1) {
    expectedFail(`${source} requires a positive integer generation.`, "lm_invalid_training_config");
  }
  const candidateAdapter = parseLmAdapter(record["candidate_adapter"], config.shape, `${source} candidate_adapter`);
  const stored: StoredLmGeneration = {
    lossBefore: storedCheckpointNumber(record, "loss_before", source, "lm_invalid_training_config"),
    lossAfter: storedCheckpointNumber(record, "loss_after", source, "lm_invalid_training_config"),
    generation,
    learningRate: storedCheckpointNumber(record, "learning_rate", source, "lm_invalid_training_config"),
    evaluationSamples: storedCheckpointNumber(record, "evaluation_samples", source, "lm_invalid_training_config"),
    fitSteps: storedCheckpointNumber(record, "fit_steps", source, "lm_invalid_training_config"),
    samples: storedCheckpointNumber(record, "samples", source, "lm_invalid_training_config"),
    collectionDigest: storedCheckpointDigest(record, "collection_digest", source, "lm_invalid_checkpoint"),
    sourceCheckpoint: storedCheckpointDigest(record, "source_checkpoint", source, "lm_invalid_checkpoint"),
    candidateCheckpoint: storedCheckpointDigest(record, "candidate_checkpoint", source, "lm_invalid_checkpoint"),
    candidateAdapter,
    parameterDeltaL2: storedCheckpointNumber(record, "parameter_delta_l2", source, "lm_invalid_training_config"),
    baselineExactMatch: storedCheckpointNumber(record, "baseline_exact_match", source, "lm_invalid_training_config"),
    candidateExactMatch: storedCheckpointNumber(record, "candidate_exact_match", source, "lm_invalid_training_config"),
    trainingScore: storedCheckpointNumber(record, "training_score", source, "lm_invalid_training_config"),
    evaluationScore: storedCheckpointNumber(record, "evaluation_score", source, "lm_invalid_training_config"),
    incumbentHeldOutMean: storedCheckpointNumber(record, "incumbent_held_out_mean", source, "lm_invalid_training_config"),
    candidateHeldOutMean: storedCheckpointNumber(record, "candidate_held_out_mean", source, "lm_invalid_training_config"),
    wallMs: storedCheckpointNumber(record, "wall_ms", source, "lm_invalid_training_config"),
  };
  if (!Number.isInteger(stored.samples) || stored.samples < 1
    || !Number.isInteger(stored.evaluationSamples) || stored.evaluationSamples < 1
    || !Number.isInteger(stored.fitSteps) || stored.fitSteps < 1) {
    expectedFail(`${source} requires positive integer sample bounds.`, "lm_invalid_training_config");
  }
  const checkpoint = lmCheckpoint(candidateAdapter, config);
  if (record["checkpoint_path"] !== lmCheckpointPath(checkpoint)
    || record["checkpoint_bytes"] !== serializeLmCheckpoint(checkpoint, config).bytes
    || record["total_parameters"] !== lmParameterCount(config.shape)
    || record["optimizer_steps_reserved"] !== PRETRAIN_STEP_COUNT + config.maxGenerations * config.fitSteps) {
    expectedFail("LM stored resource or artifact receipt disagrees with the programme.", "lm_invalid_checkpoint");
  }
  if (stored.candidateCheckpoint !== checkpoint.digest) {
    expectedFail(`${source} records candidate checkpoint ${stored.candidateCheckpoint}, which does not match the digest of its own persisted tensors; the persisted checkpoint is invalid.`, "lm_invalid_checkpoint");
  }
  return stored;
}

/**
 * Replay one language-model generation from persisted evidence and verify it.
 *
 * The fit and the evaluation are deterministic functions of the collected
 * completions, the source checkpoint and the persisted wall milliseconds, so a
 * resume re-executes the step over the evidence read back from the run's
 * notes and compares every persisted number field-for-field. Any disagreement
 * is a drift refusal, because advancing from evidence that does not reproduce
 * would let a rewritten history steer the loop.
 *
 * @param config - The validated language-model loop configuration.
 * @param step - The derived step configuration this generation ran under.
 * @param source - The checkpoint whose policy collected this batch.
 * @param stored - The persisted training configuration to verify against.
 * @param observations - The complete collected batch read from the run's notes.
 * @returns The replayed generation receipt, proven identical to the persisted one.
 * @throws An expected CLI drift refusal when the replay and the persisted record disagree.
 */
export function verifyStoredLmGeneration(config: LmLoopConfig, step: LoopStepConfig, source: LmCheckpoint, stored: StoredLmGeneration, observations: readonly LmObservation[]): LmGeneration {
  const receipt = executeLmStep(config, step, stored.generation, source, observations, stored.wallMs);
  const expected: Array<[string, unknown, unknown]> = [
    ["loss_before", stored.lossBefore, receipt.lossBefore],
    ["loss_after", stored.lossAfter, receipt.lossAfter],
    ["generation", stored.generation, receipt.generation],
    ["collection_digest", stored.collectionDigest, receipt.collectionDigest],
    ["parameter_delta_l2", stored.parameterDeltaL2, receipt.parameterDeltaL2],
    ["baseline_exact_match", stored.baselineExactMatch, receipt.baselineExactMatch],
    ["candidate_exact_match", stored.candidateExactMatch, receipt.candidateExactMatch],
  ];
  verifyTrainerConfiguration(stored, step, config);
  verifyReplayFields(expected, stored.generation);
  verifyTrainerReceipt(stored, receipt, stored.generation);
  return receipt;
}

/**
 * Build the promotion score records for one gate-promoted language-model generation.
 *
 * The proxy score is the candidate's teacher-forced reward proxy over the collected
 * examples; the held-out score is the sampled mean the gate actually bounded.
 * Both carry content-addressed seed-set identities and the dataset digest they
 * were measured on, so the persisted promotion's contamination walk can verify
 * the held-out context is unreachable from the training data.
 *
 * @param config - The validated language-model loop configuration.
 * @param step - The configuration the promoted generation ran under.
 * @param receipt - The promoted generation's receipt.
 * @returns Score records ready for the persisted promotion's parser.
 */
export function lmPromotionScores(config: LmLoopConfig, step: LoopStepConfig, receipt: LmGeneration): { readonly proxy_score: JsonValue; readonly held_out_score: JsonValue } {
  return {
    proxy_score: {
      objective: "completion_reward",
      objective_version: "pm-rl/lm/1",
      evaluation_context: config.trainingDigest,
      seed_set: lmDigest({ format: "pm-rl/lm-collection-seed/1", base_seed: config.seed, generation: receipt.generation, samples: config.samplesPerGeneration }),
      direction: "maximize",
      scale: 1,
      value: receipt.trainingScore,
    },
    held_out_score: {
      objective: "completion_reward",
      objective_version: "pm-rl/lm/1",
      evaluation_context: config.evaluationDigest,
      seed_set: lmDigest({ format: "pm-rl/lm-held-out-seed/1", generation: receipt.generation, seed: config.seed, samples: step.evaluationSamples }),
      direction: "maximize",
      scale: 1,
      value: receipt.candidateHeldOutMean,
    },
  };
}
