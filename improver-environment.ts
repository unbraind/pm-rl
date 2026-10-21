/** Evaluation capabilities isolate tracker rows from the versioned proposal policy and its updater. */
import assert from "node:assert/strict";
import type { PmClient } from "@unbrained/pm-cli/sdk/core";
import { isPmCliExpectedError } from "@unbrained/pm-cli/sdk/runtime";
import { hashJson, type JsonValue } from "./index.ts";
import { readImproverTasks, type ImproverDataset, type ImproverTask, type ImproverRow, type IMPROVER_ROLES } from "./improver-data.ts";
import type { LearnerConfig } from "./improver.ts";
import { binaryCalibration, prefixCheckpoint, prefixPrediction, prefixProbability, type BinaryCalibration, type PrefixCheckpoint } from "./prefix.ts";
import type { HistoryPrefix } from "./prefix-data.ts";
import { prefixTrainerArgv } from "./prefix-trainer.ts";
import { executeProcessTrainer, processJobId, readProcessJob, transitionProcessJob, verifyProcessJobBudget, type ProcessAdapter, type ProcessCoordinates, type ProcessInput, type ProcessJob } from "./process.ts";
import { decidePromotion, hoeffdingEpsilon, type PromotionDecision, type PromotionCriterion } from "./promotion.ts";

/** Both levels use the existing unchanged confidence, sample and effect thresholds. */
export const IMPROVER_CRITERION = { confidence: 0.95, minSamples: 10, effectThreshold: 0.01 } as const;
/** Each matched fit has the same CPU-only, zero-token reservation and fixed optimizer update allowance. */
export const IMPROVER_ADAPTER = { kind: "process-bandit", allowance: { training_steps: 1, wall_ms: 30_000, storage_bytes: 4096, compute_units: 30_000, tokens: 0 } } as const;
/** Larger feature spaces require a separately approved storage reservation; existing runs retain their exact budget. */
export function improverAdapter(input: ProcessInput<PrefixCheckpoint>): ProcessAdapter {
  return input.prefix!.knobs.hashing_width <= 64 ? IMPROVER_ADAPTER : { ...IMPROVER_ADAPTER, allowance: { ...IMPROVER_ADAPTER.allowance, storage_bytes: 1_048_576 } };
}
/** One recoverable lost receipt may consume a second reservation; repeated losses cannot replenish this cap. */
export const IMPROVER_MAX_ATTEMPTS = 2;
/** Retained learners bind prediction parameters to their feature mask. */
export interface ImproverLearner { readonly config: LearnerConfig; readonly checkpoint: PrefixCheckpoint }
/** Full proposal evidence stays on its PM step, including fitted parameters even on refusal. */
export interface LearnerTrial {
  readonly job: string;
  readonly candidate: ImproverLearner;
  readonly retained: ImproverLearner;
  readonly mean: number;
  readonly retained_mean: number;
  readonly baseline: number;
  readonly majority: number;
  readonly samples: number;
  readonly promoted: boolean;
  readonly gain: number;
  readonly lower_bound: number;
  readonly verdict: PromotionDecision;
  readonly gap: number;
  readonly diagnostics: LearnerDiagnostics;
  readonly retained_calibration: BinaryCalibration;
}
/** Aggregate candidate behavior distinguishes collapse, training failure and gate refusal without exposing examples. */
export interface LearnerDiagnostics {
  readonly calibration: BinaryCalibration;
  readonly training_frequency_calibration: BinaryCalibration;
  readonly held_out_classes: Readonly<Record<"0" | "1", number>>;
  readonly distinct_predictions: number;
  readonly train_accuracy: number;
  readonly train_majority: number;
  readonly beats_train_majority: boolean;
}

/** Measure the fitted candidate, including proposals refused by the promotion gate. */
export function diagnoseImproverLearner(task: ImproverTask, learner: ImproverLearner): LearnerDiagnostics {
  const predictions = task.evaluation.map((row) => prefixPrediction(improverFeatures(row.prefix, learner.config), learner.checkpoint) === "slow" ? 1 : 0);
  const train_accuracy = improverAccuracy(task.train, learner);
  const ones = task.train.filter((row) => row.label === 1).length;
  const train_majority = Math.max(ones, task.train.length - ones) / task.train.length;
  return { calibration: improverCalibration(task.evaluation, learner),
    training_frequency_calibration: binaryCalibration(task.evaluation.map(() => ones / task.train.length), task.evaluation.map((row) => row.label)),
    held_out_classes: { "0": predictions.filter((value) => value === 0).length, "1": predictions.filter((value) => value === 1).length },
    distinct_predictions: new Set(predictions).size, train_accuracy, train_majority, beats_train_majority: train_accuracy > train_majority };
}
/** Probability reporting is evaluator-only and does not change the deterministic prediction or promotion rule. */
function improverCalibration(rows: readonly ImproverRow[], learner: ImproverLearner): BinaryCalibration {
  return binaryCalibration(rows.map((row) => prefixProbability(improverFeatures(row.prefix, learner.config), learner.checkpoint)), rows.map((row) => row.label));
}

/** Search receives task identities and aggregate outcomes, never a feature, label, or dataset path. */
export interface ImproverEnvironment {
  tasks(role: typeof IMPROVER_ROLES[number]): readonly { readonly id: string; readonly repo: string; readonly target: ImproverTask["target"] }[];
  fit(role: typeof IMPROVER_ROLES[number], index: number, config: LearnerConfig, job: string, incumbent: ImproverLearner | null, signal: AbortSignal): Promise<LearnerTrial>;
}

/** Apply a declared feature mask to already bounded history; no label or target field is accepted. */
export function improverFeatures(prefix: HistoryPrefix, config: LearnerConfig): HistoryPrefix {
  return { events: config.features === "all" || config.features === "events" ? prefix.events : ["other"],
    fields: config.features === "all" || config.features === "events" ? prefix.fields : [],
    words: config.features === "all" || config.features === "words" ? prefix.words : [],
    elapsed_ms: config.features === "all" || config.features === "timing" ? prefix.elapsed_ms : 0,
    authors: config.features === "all" || config.features === "timing" ? prefix.authors : 0 };
}

/** Exact deterministic accuracy counts each frozen evaluation item once. */
export function improverAccuracy(rows: readonly ImproverRow[], learner: ImproverLearner): number {
  assert.ok(rows.length > 0, "improver_score_empty");
  return rows.filter((row) => (prefixPrediction(improverFeatures(row.prefix, learner.config), learner.checkpoint) === "slow" ? 1 : 0) === row.label).length / rows.length;
}

/** Feed bounded evidence into the existing gate; task-level meta scores never pretend items are independent trackers. */
export function compareImprovers(candidate: string, incumbent: string, mean: number, baseline: number, samples: number, context: string, criterion: PromotionCriterion = IMPROVER_CRITERION): { verdict: PromotionDecision; gain: number; lower_bound: number } {
  const shared = { objective: "promoted_tracker_score", objective_version: "1", evaluation_context: context, direction: "maximize" as const, samples, rewardBounds: [0, 1] as const };
  const verdict = decidePromotion({ candidate: { ...shared, generation: candidate, mean }, incumbent: { ...shared, generation: incumbent, mean: baseline }, criterion, contaminationPath: null, expectedGeneration: candidate });
  const gain = mean - baseline;
  return { verdict, gain, lower_bound: gain - 2 * hoeffdingEpsilon(samples, 1, 1 - criterion.confidence) };
}

/** Bind deterministic recovery attempts to distinct immutable job identities while preserving exactly the same training input. */
export function improverProcessAttempt(input: ProcessInput<PrefixCheckpoint>, attempt: 0 | 1): ProcessInput<PrefixCheckpoint> {
  return { ...input, identity: { proposal: input.identity, recovery_attempt: attempt } };
}

/** Recover a missing or partially written receipt once, retaining the first charge; valid receipt drift and cancellation refuse. */
export async function executeImproverFit(client: PmClient, coordinates: ProcessCoordinates, input: ProcessInput<PrefixCheckpoint>, approval: string, signal: AbortSignal): Promise<ProcessJob<PrefixCheckpoint>> {
  signal.throwIfAborted();
  const argv = prefixTrainerArgv();
  const adapter = improverAdapter(input);
  /** Both attempts begin from the same source parameters and training rows; recovery adds no optimization opportunity. */
  const run = (attempt: 0 | 1): Promise<ProcessJob<PrefixCheckpoint>> => executeProcessTrainer(client, coordinates, improverProcessAttempt(input, attempt), approval, adapter, signal, argv);
  try { return await run(0); }
  catch (error) {
    signal.throwIfAborted();
    if (!(error instanceof SyntaxError) && !(isPmCliExpectedError(error) && ["process_receipt_required", "process_job_terminal"].includes(String(error.context.code)))) throw error;
    const failed = await readProcessJob(client, processJobId(improverProcessAttempt(input, 0), argv, adapter));
    assert.ok(failed, "improver_recovery_job_required"); assert.equal(failed.state, "failed", "improver_recovery_state");
    if (isPmCliExpectedError(error) && error.context.code === "process_job_terminal" && !["process_receipt_required", "trainer_failure"].includes(failed.outcome)) throw error;
    await verifyProcessJobBudget(client, failed);
    return run(1);
  }
}

/** Keep task data lazy: the audit role is never read until all improver promotions are durable. */
export function openImproverEnvironment(client: PmClient, coordinates: ProcessCoordinates, directory: string, manifest: ImproverDataset, approval: string, updates: number, seed: number, criterion: PromotionCriterion): ImproverEnvironment {
  const cache = new Map<string, ImproverTask[]>();
  /** Only the trusted evaluator can open a task compartment. */
  const tasks = (role: typeof IMPROVER_ROLES[number]): ImproverTask[] => {
    if (!cache.has(role)) cache.set(role, readImproverTasks(directory, manifest, role));
    return cache.get(role)!;
  };
  return {
    tasks: (role) => tasks(role).map((task) => ({ id: task.id, repo: task.repo, target: task.target })),
    async fit(role, index, config, jobId, incumbent, signal) {
      const task = tasks(role)[index];
      const source = prefixCheckpoint(new Array<number>(config.prefix.hashing_width).fill(0), config.prefix);
      const baseline = incumbent ?? { config, checkpoint: source };
      const ordered = [...task.train].sort((a, b) => hashJson({ id: a.id, seed }).localeCompare(hashJson({ id: b.id, seed })));
      const rows = Array.from({ length: updates }, (_, offset) => ({ prefix: improverFeatures(ordered[offset % ordered.length].prefix, config), label: ordered[offset % ordered.length].label }));
      const input: ProcessInput<PrefixCheckpoint> = { identity: { programme_id: jobId, dataset: manifest.digest, task: task.id, config: config as unknown as JsonValue }, source, training: [], observations: [],
        training_config: { learning_rate: config.learning_rate, steps: 1 }, lineage: { training: hashJson(task.train as unknown as JsonValue), held_out: hashJson(task.evaluation as unknown as JsonValue), collection: hashJson(rows as unknown as JsonValue) }, prefix: { rows, knobs: config.prefix } };
      const job = await executeImproverFit(client, coordinates, input, approval, signal);
      assert.ok(job.completion !== null, "improver_fit_incomplete");
      const candidate = { config, checkpoint: job.completion.policy };
      const mean = improverAccuracy(task.evaluation, candidate);
      const baselineMean = improverAccuracy(task.evaluation, baseline);
      const comparison = compareImprovers(hashJson(candidate as unknown as JsonValue), hashJson(baseline as unknown as JsonValue), mean, baselineMean, task.evaluation.length, hashJson(task.evaluation as unknown as JsonValue), criterion);
      const diagnostics = diagnoseImproverLearner(task, candidate);
      const gap = diagnostics.train_accuracy - mean;
      const promoted = comparison.verdict.decision === "promote" && gap <= 0.3;
      const retained = promoted ? candidate : baseline;
      const evaluated = job.state === "materialized" ? await transitionProcessJob(client, coordinates, job, "evaluated", promoted ? "inner_gate_accepted" : gap > 0.3 ? "gap_rejected" : comparison.verdict.reason) : job;
      if (promoted && evaluated.state === "evaluated") await transitionProcessJob(client, coordinates, evaluated, "promoted", "inner_gate_accepted");
      // The sealed reader requires exactly balanced fit labels; resolve its majority tie to class one.
      const majority = 1;
      return { job: job.id, candidate, retained, mean, retained_mean: improverAccuracy(task.evaluation, retained), baseline: baselineMean,
        majority: task.evaluation.filter((row) => row.label === majority).length / task.evaluation.length,
        samples: task.evaluation.length, promoted, ...comparison, gap, diagnostics, retained_calibration: improverCalibration(task.evaluation, retained) };
    },
  };
}
