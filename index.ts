import { canonicalIdentifier, canonicalProgrammeId, canonicalProgrammeRequest, acquireStateLock, statePath, identifier, checkedStateFile, identifierClient, commitStateTransaction, schemaIdentity, operationIdentifier, DECISION_INPUT_FIELDS, type ValidationMode } from "./state-boundary.ts";
/** Select released-schema reads or explicit validation of a new declaration. */
export type { ValidationMode } from "./state-boundary.ts";
import type { HistoryResult } from "@unbrained/pm-cli/sdk/query";
import { decodeTrackerRecord, skippedTrackerRecords, parseBoundedJson, encodeBoundedJson, MAX_JSON_BYTES, MAX_TRACKER_RECORD_BYTES } from "./tracker-record.ts";
/**
 * @module pm-rl
 *
 * Registers the first production pm-rl slab: immutable, content-addressed
 * environment specifications and run metric streams stored as repeatable pm
 * notes. Notes are append-only history mutations and merge as a set across
 * concurrent branches, unlike a scalar item body.
 */

export type { JsonEncodingRefusal } from "./tracker-record.ts";

export { runBanditProgramme, type BanditCheckpoint, type BanditExample, type BanditGeneration, type BanditProgramme, type BanditResult } from "./bandit.ts";
export { checkpointArtifactPath, collectCheckpointArtifacts, readCheckpointArtifact, readCheckpointLedger, type CheckpointArtifact } from "./checkpoint-artifacts.ts";
export { buildIntakeLoopCorpus, intakeHeuristic, projectIntakeHistory, sealIntakeCorpus, type IntakeRow, buildTrackerLoopCorpus, corpusHeldOut, sealTrackerLoopCorpus, verifyTrackerLoopCorpus, type CorpusRow, type TrackerLoopCorpus } from "./corpus.ts";

export { banditCheckpoint, executeBanditStep, validatedBanditDatasets, type BanditDatasets, type BanditObservation, type BanditStepInput, type BanditStopReason } from "./bandit.ts";

export {
  banditProcessInput,
  banditCollectionConfig,
  collectionMetricEvents,
  deriveNextStepConfig,
  generationTrainingConfig,
  loopEnvironmentSpec,
  loopPromotionScores,
  MAX_LOOP_BUDGET,
  MAX_LOOP_EVALUATION_SAMPLES,
  MAX_LOOP_GENERATIONS,
  MIN_LOOP_LEARNING_RATE,
  parseLoopConfig,
  parseLoopProgramme,
  parseLoopTrainer,
  parseStoredLoopGeneration,
  runLoopGeneration,
  seedTrainingConfig,
  stepSeed,
  verifyStoredLoopGeneration,
  LOOP_TRAINER_VALUES,
  type LoopConfig,
  type LoopProgramme,
  type LoopScheduleBounds,
  type LoopStepConfig,
  type LoopTrainer,
  type StoredLoopGeneration,
} from "./loop.ts";

export {
  calibratedProbabilities,
  executeSystemOneStep,
  fitSystemOneHead,
  jsonHeadParameters,
  neutralSystemOneHead,
  parseStoredSystemOneGeneration,
  parseSystemOneDecisionEvent,
  parseSystemOneHeadParameters,
  parseSystemOneLoopConfig,
  requestSystemOneDecision,
  sampleSystemOneActions,
  systemOneAccuracy,
  systemOneCalibrationError,
  systemOneCheckpoint,
  systemOneDecisionEvent,
  systemOneDecisionRequestId,
  verifySystemOneReceiptEvent,
  systemOneEnvironmentSpec,
  systemOneGenerationTrainingConfig,
  systemOnePromotionScores,
  systemOneRunConfig,
  systemOneSampleSeed,
  systemOneSeedTrainingConfig,
  systemOneState,
  verifyStoredSystemOneGeneration,
  validatedSystemOneDatasets,
  MAX_SYSTEMONE_BIAS,
  MAX_SYSTEMONE_EXAMPLES,
  MAX_SYSTEMONE_FIT_STEPS,
  MAX_SYSTEMONE_LOG_TEMPERATURE,
  SYSTEMONE_COLLECTION_METRIC,
  SYSTEMONE_GENERATION_FORMAT,
  SYSTEMONE_HELD_OUT_METRIC,
  SYSTEMONE_RUN_FORMAT,
  SYSTEMONE_SEED_FORMAT,
  type StoredSystemOneGeneration,
  type SystemOneCheckpoint,
  type SystemOneChoiceSpec,
  type SystemOneDecisionResponse,
  type SystemOneDecisionReceipt,
  type SystemOneEndpointSpec,
  type SystemOneExample,
  type SystemOneGeneration,
  type SystemOneHeadParameters,
  type SystemOneLoopConfig,
  type SystemOneObservation,
  type SystemOneStopReason,
} from "./systemone.ts";

export {
  copyLmAdapter,
  executeLmStep,
  lmAdapterParameterCount,
  lmCheckpoint,
  lmCollectBatch,
  lmCollectionEvents,
  lmCompletionReward,
  lmConfigurationJson,
  lmEnvironmentSpec,
  lmGenerationTrainingConfig,
  lmGreedyExactMatch,
  lmPromptTokens,
  lmPromotionScores,
  lmRunConfig,
  lmSampleSeed,
  lmSeedTrainingConfig,
  lmSupervisedGradient,
  lmSupervisedLoss,
  lmReinforceSurrogate,
  parseLmAdapter,
  parseLmCollectionEvent,
  parseLmLoopConfig,
  rotateTargetTokens,
  seededLmAdapter,
  serializeLmCheckpoint,
  trainLmBasePolicy,
  verifyStoredLmGeneration,
  validatedLmDatasets,
  lmBackward,
  lmForward,
  MAX_LM_ALPHABET,
  MAX_LM_EXAMPLES,
  MAX_LM_FFN_DIM,
  MAX_LM_FIT_STEPS,
  MAX_LM_LORA_RANK,
  MAX_LM_MODEL_DIM,
  MAX_LM_POSITIONS,
  MAX_LM_STRING_LENGTH,
  MIN_LM_LEARNING_RATE,
  LM_CHECKPOINT_FORMAT,
  LM_COLLECTION_METRIC,
  LM_GENERATION_FORMAT,
  LM_RUN_FORMAT,
  LM_SEED_FORMAT,
  type LmAdapter,
  type LmCheckpoint,
  type LmExample,
  type LmGeneration,
  type LmGradients,
  type LmLimits,
  type LmLoopConfig,
  type LmModelShape,
  type LmObservation,
  type LmStopReason,
  type LmWeights,
  type StoredLmGeneration,
} from "./lm.ts";

export { exportPolicyCard, replayPolicyCard, adoptPolicyCard, recordRecursivePolicyCards, recordPolicyCard, POLICY_CARD_MAX_BYTES, type PolicyCard, type PolicyCardDecisionEvidence, type PolicyCardDecisionReference, type PolicyCardEvidence, type PolicyCardRefusal } from "./policy-card.ts";
export { parseShadowDeployment, shadowInputDigest, registerShadowDeployment, observeShadow, compareShadow, type ShadowPolicy, type ShadowDeployment, type ShadowInput, type ShadowObservation, type ShadowReport, type ShadowRefusal } from "./shadow.ts";
export { recordSequentialEvaluation, readSequentialEvaluation, type SequentialStopping, type SequentialBoundary, type SequentialEvaluationResult, type SequentialEvaluationSkip } from "./sequential-evaluation.ts";
export { parseEvaluationPlan, resolveEvaluationPlan, evaluationPlanId, evaluationComparison, registerEvaluationPlan, readEvaluationPlan, readEvaluationDecision, parseEvaluationEvidence, evaluatePlan, recordPlanEvaluation, enforceEvaluationPlan, type EvaluationPlan, type EvaluationMember, type EvaluationObservation, type EvaluationPlanReport, type RegisteredEvaluationPlan, type EvaluationPlanRefusal, type ProtectedCohort, type CohortReport, type CohortRefusal } from "./evaluation-plan.ts";

export { decidePromotion, hoeffdingEpsilon, parsePromotionCriterion, parsePromotionEvidence, type PromotionCriterion, type PromotionDecision, type PromotionEvidence, type PromotionGateInput } from "./promotion.ts";
export { recipeArtifact, parseRecipe, seededRecipes, INITIAL_RECIPE, RECIPE_BOUNDS, type Recipe, type RecipeKnobs } from "./recipe.ts";
export { buildTrackerDataset, readTrackerDataset, readTrackerSplit, type TrackerDataset, type TrackerExample } from "./dataset.ts";
export { runRlMeta, parseMetaConfig, type MetaConfig, type MetaRequest, type MetaReport } from "./meta.ts";
export { runRecursiveImprover, improverConfiguration, improverBudget, parseImproverConfig, type ImproverConfig, type ImproverReport, type ImproverRequest } from "./recursive-improver.ts";
export { initialImprover, improverArtifact, parseImprover, proposeLearners, updateImprover, type ImproverPolicy, type LearnerConfig, type ProposalOutcome } from "./improver.ts";
export { buildImproverDataset, readImproverDataset, type ImproverDataset } from "./improver-data.ts";
export { IMPROVER_ADAPTER, IMPROVER_CRITERION, IMPROVER_MAX_ATTEMPTS } from "./improver-environment.ts";
import { runRecursiveImprover, parseImproverConfig, type ImproverConfig } from "./recursive-improver.ts";
import { buildImproverDataset } from "./improver-data.ts";

import { buildTrackerDataset } from "./dataset.ts";
import { runRlMeta, parseMetaConfig, retainedMetaPromotionHeadroom, type MetaReport } from "./meta.ts";

import {
  trainLmStep, evaluateLmStep, lmTrainingJson, restoreLmTraining, restoreLmGeneration, serializeLmCheckpoint,
  lmCheckpoint,
  lmCollectBatch,
  lmCollectionEvents,
  lmEnvironmentSpec,
  lmGenerationTrainingConfig,
  lmPromotionScores,
  lmRunConfig,
  lmSeedTrainingConfig,
  parseLmCollectionEvent,
  persistLmCheckpoint,
  verifyLmCheckpointArtifact,
  parseStoredLmGeneration,
  verifyStoredLmGeneration,
  type LmCheckpoint,
  type LmGeneration,
  type LmObservation,
  type LmLoopConfig,
} from "./lm.ts";

import { AsyncLocalStorage } from "node:async_hooks";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants, existsSync, lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { basename, delimiter, dirname, join, relative, resolve, sep } from "node:path";
import { StringDecoder } from "node:string_decoder";

import {
  defineBeforeMutationHook,
  defineCommand,
  defineExtension,
  defineItemType,
  type CommandHandlerContext,
  type ExtensionApi,
} from "@unbrained/pm-cli/sdk/authoring";
import { applyTerminalOrderingPolicy, mutateItem, readSettings, runWithActiveExtensions, type CommitWorkspaceTransactionOptions, type ItemDocument, resolveRuntimeStatusRegistry, type LogNote } from "@unbrained/pm-cli/sdk";
import { PmClient, type GetResult, type ItemMetadata } from "@unbrained/pm-cli/sdk/core";
import { certifyCompleteListResult, createPmCliExpectedError, EXIT_CODE, isPmCliExpectedError, isTerminalStatus, type PmCliExpectedError } from "@unbrained/pm-cli/sdk/runtime";

import { parseJsonRecord, rethrowOperationalRead, rethrowProvenanceRead } from "./refuse.ts";
import { exportPolicyCard, replayPolicyCard, adoptPolicyCard, recordRecursivePolicyCards, recordPolicyCard, validatePromotedPolicyCard, validatePolicyCardWrite, validateRefusedPolicyCard, discoverPolicyCards, verifyRetainedGenerationEvidence } from "./policy-card.ts";
import { registerShadowDeployment, observeShadow, compareShadow } from "./shadow.ts";
import { recordSequentialEvaluation, readSequentialEvaluation, withEvaluationLease } from "./sequential-evaluation.ts";
/** Typed persisted input graphs returned by the evaluation SDK. */
export type { EvaluationEvidence } from "./lineage.ts";
import { registerEvaluationPlan, readEvaluationPlan, recordPlanEvaluation, enforceEvaluationPlan, enforceEvaluationDecision, readEvaluationDecision, evaluationEvidence, parseEvaluationEvidence, evaluationInputDigest, decisionSnapshotDigest } from "./evaluation-plan.ts";
import { buildIntakeLoopCorpus, buildTrackerLoopCorpus } from "./corpus.ts";
import { decodeCheckpointArtifacts, encodeCheckpointArtifacts, collectCheckpointArtifacts, inspectCheckpointArtifact } from "./checkpoint-artifacts.ts";

import { encodeEventSegments, parseNdjsonStream, readSeries, type MetricEvent } from "./series.ts";

import {
  buildCompareView,
  renderCompareReport,
  type RunCompareInput,
} from "./compare.ts";

import {
  INVALIDATED_RESULT_TYPES,
  INVALIDATION_ROOT_TYPES,
  renderInvalidateReport,
  transitiveInvalidation,
  type ItemDependencyEdge,
} from "./invalidate.ts";

import {
  buildLineageAncestry,
  canonicalizeIdentifier,
  canonicalizeGenerationSpec,
  canonicalizeScoreRecord,
  directionAwareGap,
  findContaminationPath,
  GENERATION_EDGE_TYPES,
  parseApprovalSpec,
  type ApprovalSpec,
  parseGenerationSpec,
  parseScoreRecord,
  renderContaminationPath,
  renderLineageTable,
  DEFAULT_GAP_WINDOW,
  type AncestryEntry,
  type GenerationSpec, type EvaluationEvidence,
  type LineageAncestry,
  type LineageView,
  type ScoreRecord,
} from "./lineage.ts";

import {
  rankLeaderboard,
  renderLeaderboard,
  type BenchmarkSpec,
  type EvalResultSpec,
  type LeaderboardCandidate,
} from "./leaderboard.ts";

import {
  compareReceipts,
  parseReceipt,
  renderReceiptDifferences,
  type ReceiptSpec,
} from "./receipt.ts";

import {
  buildTransferGapReport,
  parseTransferMetrics,
  parseTransferSpec,
  renderTransferGapReport,
  TRANSFER_RUN,
  TRANSFER_SOURCE_ENVIRONMENT,
  TRANSFER_TARGET_ENVIRONMENT,
  type TransferSpec,
} from "./transfer.ts";

import {
  buildSweepStatus,
  expandSearchSpace,
  parseSelectionRule,
  parseSweepSpec,
  renderSweepStatus,
  type SweepSpec,
} from "./sweep.ts";

import {
  assertNoCredentials,
  buildSimRealGap,
  deriveVerdict,
  parseEpisodeSpec,
  parseGateEnvironmentSpec,
  parseGateResults,
  parseOutcomeSpec,
  renderSimRealGap,
  type EpisodeSpec,
  type GateEnvironmentSpec,
} from "./gatesim.ts";

import {
  banditProcessInput,
  banditCollectionConfig,
  collectionMetricEvents,
  deriveNextStepConfig,
  generationTrainingConfig,
  loopEnvironmentSpec,
  loopPromotionScores,
  parseLoopProgramme,
  parseStoredLoopGeneration,
  runLoopGeneration,
  seedTrainingConfig,
  verifyStoredLoopGeneration,
  type LoopConfig,
  type LoopProgramme,
  type LoopStepConfig,
} from "./loop.ts";

import {
  executeSystemOneStep,
  parseStoredSystemOneGeneration,
  parseSystemOneDecisionEvent,
  parseSystemOneLoopConfig,
  requestSystemOneDecision,
  sampleSystemOneActions,
  systemOneDecisionEvent,
  systemOneDecisionRequestId,
  verifySystemOneReceiptEvent,
  systemOneEnvironmentSpec,
  systemOneGenerationTrainingConfig,
  systemOnePromotionScores,
  systemOneRunConfig,
  systemOneSampleSeed,
  systemOneState,
  systemOneSeedTrainingConfig,
  verifyStoredSystemOneGeneration,
  SYSTEMONE_COLLECTION_METRIC,
  SYSTEMONE_HELD_OUT_METRIC,
  type SystemOneCheckpoint,
  type SystemOneChoiceSpec,
  type SystemOneDecisionResponse,
  type SystemOneExample,
  type SystemOneGeneration,
  type SystemOneLoopConfig,
  type SystemOneObservation,
} from "./systemone.ts";

import { lmProcessInput, processLmTraining, verifyLmProcessJob } from "./process-lm.ts";
import { controllerCallback, executeProcessTrainer, listProcessJobs, readProcessJob, processJobId, verifiedProcessPolicy, transitionProcessJob, verifyProcessJobBudget, type ProcessJob, type ProcessJobState, type TrainerPolicy } from "./process.ts";
export { executeProcessTrainer, reserveProcessJob, readProcessJob, processJobId, processStaging, parseResources, parseProcessAdapter, validateProcessCompletion, referenceTrainerArgv, type ProcessJob, type ProcessCompletion, type ProcessAdapter, type ProcessInput, type Resources } from "./process.ts";

import { banditCheckpoint, type BanditCheckpoint, type BanditGeneration } from "./bandit.ts";

/** Yield nonempty JSON fences in one forward scan, preserving the exact LF delimiters. */
function* jsonSpecFences(body: string): Generator<string, undefined> {
  let offset = 0;
  for (;;) {
    const opening = body.indexOf("```json\n", offset);
    if (opening < 0) return;
    const start = opening + 8;
    const end = body.indexOf("\n```", start + 1);
    if (end < 0) return;
    yield body.slice(start, end);
    offset = end + 4;
  }
}

/**
 * How long a promotion waits for the workspace writer lock before giving up.
 *
 * Concurrent promotions serialize on this lock rather than racing, so the wait
 * has to cover a peer's whole critical section: a full generation count plus
 * the promoting write. Thirty seconds is far above the observed cost of both
 * and still bounded, so a stuck peer surfaces as a timeout rather than hanging
 * a recursive loop indefinitely.
 */
const PROMOTION_LOCK_WAIT_MS = 30_000;

/** Dependency provenance marker for a benchmark's declared contamination edge. */
const BENCHMARK_CONTAMINATION_SOURCE = "pm-rl:benchmark:contaminated_by";

/** Dependency provenance marker connecting an evaluation to its source run. */
const EVAL_RUN_SOURCE = "pm-rl:eval:run";

/** Dependency provenance marker connecting an evaluation to its benchmark. */
const EVAL_BENCHMARK_SOURCE = "pm-rl:eval:benchmark";

/** Dependency provenance marker connecting a gate episode to its environment. */
const EPISODE_ENVIRONMENT_SOURCE = "pm-rl:episode:environment";

/** JSON values accepted in environment and run configuration files. */
export type JsonValue = null | boolean | number | string | JsonValue[] | { readonly [key: string]: JsonValue };

/** Minimal environment contract whose complete source remains in the item body. */
export interface EnvironmentSpec {
  /** Human-readable environment family name. */
  readonly name: string;
  /** Version being registered; changing behavior requires changing this value. */
  readonly version: string;
  /** Tasks the environment exposes. */
  readonly task_suite: JsonValue;
  /** Reward calculation whose identity must remain attributable to every run. */
  readonly reward_specification: JsonValue;
  /** Additional environment data retained without pm-rl inventing a framework schema. */
  readonly [key: string]: JsonValue;
}

/** Stable, structured result shared by pm-rl commands. */
export interface RlCommandResult {
  /** Domain action that completed. */
  readonly action: string;
  /** Primary item affected by the command. */
  readonly id?: string;
  /** Whether an idempotent registration created a new item. */
  readonly created?: boolean;
  /** Command-specific bounded details. */
  readonly details?: Readonly<Record<string, unknown>>;
}

/** pm item types contributed by this package. */
export const RL_ITEM_TYPES = [
  defineItemType({
    name: "Environment",
    folder: "environments",
    aliases: ["rl-environment", "rl-env"],
    description: "An immutable, content-addressed RL environment and reward specification.",
    default_status: "open",
    required_create_fields: ["affected_version", "fixed_version"],
  }),
  defineItemType({
    name: "Run",
    folder: "runs",
    aliases: ["rl-run"],
    description: "One RL run whose metric series is appended to pm history through repeatable notes.",
    default_status: "in_progress",
    required_create_fields: ["environment", "affected_version", "component", "fixed_version"],
  }),
  defineItemType({
    name: "Generation",
    folder: "generations",
    aliases: ["rl-generation", "rl-gen"],
    description: "One policy generation in a recursive self-improvement lineage, gated by an approved promotion budget.",
    default_status: "open",
    required_create_fields: ["affected_version", "fixed_version", "component"],
  }),
  defineItemType({
    name: "Benchmark",
    folder: "benchmarks",
    aliases: ["rl-benchmark", "rl-bench"],
    description: "An immutable, content-addressed evaluation suite with explicit contamination edges.",
    default_status: "open",
    required_create_fields: ["affected_version", "fixed_version", "component"],
  }),
  defineItemType({
    name: "EvalResult",
    folder: "eval-results",
    aliases: ["rl-eval-result", "rl-eval"],
    description: "One immutable checkpoint verdict linked to its source run and exact benchmark version.",
    default_status: "closed",
    required_create_fields: ["affected_version", "fixed_version", "component", "environment"],
  }),
  defineItemType({
    name: "GateEpisode",
    folder: "gate-episodes",
    aliases: ["rl-gate-episode", "rl-episode"],
    description: "One judged candidate against the fleet's mandatory gates: a content-addressed candidate tree, its gate results and extracted verdict, linked to its pull request.",
    default_status: "closed",
    required_create_fields: ["affected_version", "fixed_version", "component", "environment"],
  }),
  defineItemType({
    name: "Transfer",
    folder: "transfers",
    aliases: ["rl-transfer"],
    description: "One measured per-metric sim-to-real gap for one checkpoint, linking both environment versions.",
    default_status: "open",
    required_create_fields: ["affected_version", "fixed_version", "component", "environment"],
  }),
  defineItemType({
    name: "Sweep",
    folder: "sweeps",
    aliases: ["rl-sweep"],
    description: "A declared search space and selection rule whose arms are independent child Run items.",
    default_status: "open",
    required_create_fields: ["affected_version", "fixed_version", "component"],
  }),
  defineItemType({
    name: "MergeOutcome",
    folder: "merge-outcomes",
    aliases: ["rl-merge-outcome"],
    description: "The real-side result of one pull request: whether it actually merged.",
    default_status: "closed",
    required_create_fields: ["affected_version", "fixed_version", "component"],
  }),
] as const;

/** Item types whose stored provenance can make an Environment version immutable. */
const ENVIRONMENT_REFERENCE_TYPES = new Set([
  "Run",
  "Generation",
  "Sweep",
  "Benchmark",
  "EvalResult",
  "GateEpisode",
  "Transfer",
]);

/** Return whether one known provenance record names an Environment id. */
function metadataReferencesEnvironment(item: ItemMetadata, environmentId: string): boolean {
  if (!ENVIRONMENT_REFERENCE_TYPES.has(item.type)) return false;
  if (typeof item.environment === "string" && item.environment.trim() === environmentId) return true;
  return item.dependencies?.some((dependency) => typeof dependency.id === "string" && dependency.id.trim() === environmentId) ?? false;
}

/**
 * Refuse every mutation to an Environment after a run, generation, or result
 * records that version. The host invokes this guard under the target item lock
 * before writing either the item or its history, so SDK, command, and direct
 * core mutations share one write-boundary refusal rather than relying on each
 * pm-rl command to remember a preflight check.
 */
const guardReferencedEnvironmentMutation = defineBeforeMutationHook(async (context) => {
  if (context.before === null || context.before.metadata.type !== "Environment") return { allow: true };
  const environmentId = context.before.metadata.id;
  const references = (await context.sdk.list())
    .filter((item) => item.id !== environmentId && metadataReferencesEnvironment(item, environmentId))
    .map((item) => `${item.type} ${item.id}`)
    .sort((left, right) => left.localeCompare(right));
  if (references.length === 0) return { allow: true };
  return {
    allow: false,
    code: "environment_referenced",
    message: `Environment ${environmentId} is immutable; refusing ${context.operation} because ${references.join(", ")} reference it.`,
    remediation: `Register changed environment content as a new version instead of mutating ${environmentId}.`,
  };
});

/**
 * The provenance subset of a generation specification, in a stable shape.
 *
 * `affected_version` is a content identity for what a generation was trained
 * FROM, so it must not move when the generation is promoted. Promotion rewrites
 * the outcome fields — `promoted`, `approval`, both scores, `gap` and
 * `promotion_evidence` — and those are excluded here so the identity survives
 * it and stays checkable by a re-hash of the stored body.
 *
 * @param spec - The generation specification to reduce to its provenance.
 * @returns The provenance fields, ordered by the caller's key order for hashing.
 */
export function generationProvenance(spec: GenerationSpec): JsonValue {
  return {
    ...(spec.evaluation_plan === undefined ? {} : { evaluation_plan: spec.evaluation_plan }),
    base_checkpoint: spec.base_checkpoint,
    policy: spec.policy,
    collection_runs: [...spec.collection_runs],
    training_config: spec.training_config,
    environment_version: spec.environment_version,
    reward_spec_version: spec.reward_spec_version,
    parent: spec.parent,
    seed: spec.seed,
  } as JsonValue;
}

/** Throw an expected command error with stable machine context. */
function fail(message: string, code: string, exitCode: number = EXIT_CODE.USAGE): never {
  throw createPmCliExpectedError(message, { exitCode, context: { code } });
}

/** Return a required non-empty command option. */
function stringOption(context: CommandHandlerContext, key: string, required = true): string | undefined {
  const camel = key.replaceAll(/_([a-z])/g, (_match, letter: string) => letter.toUpperCase());
  const value = context.options[key] ?? context.options[camel];
  if (typeof value === "string" && ["checkpoint", "base_checkpoint", "policy"].includes(key)) return value; // Labels are validated only when a new record will be written.
  if (typeof value === "string" && ["environment", "parent", "approval", "run", "benchmark", "candidate", "incumbent", "source", "target"].includes(key)) { operationIdentifier(value); return value; }
  if (typeof value === "string" && ["collection_runs", "contaminated_by"].includes(key)) { value.split(",").forEach((id) => operationIdentifier(id)); return value; }
  if (typeof value === "string" && value.trim().length > 0) return value.trim();
  if (required) fail(`pm rl requires --${key.replaceAll("_", "-")}.`, `missing_${key}`);
  return undefined;
}

/** Return the first positional argument or fail with actionable usage. */
function requiredArgument(context: CommandHandlerContext, label: string, kind: "item" | "digest" = "item"): string {
  const value = context.args.find((argument) => !argument.startsWith("-"));
  if (value === undefined || value.trim().length === 0) fail(`pm rl requires ${label}.`, "missing_argument");
  if (kind === "item") { operationIdentifier(value); return value; }
  return identifier(value, kind);
}

/**
 * Resolve a real tracker-bound client.
 *
 * Current hosts inject the client. Direct command consumers and older hosts may
 * omit `context.sdk`, so the fallback constructs the same public host client
 * rather than replacing it with a test double.
 */
function clientFor(context: CommandHandlerContext): PmClient {
  if (context.sdk !== undefined) return context.sdk.client;
  return PmClient.forActiveExtensionHost({ pmRoot: context.pm_root, author: authorFor(context) });
}

/**
 * Resolve the attributable actor for a command invocation.
 *
 * The host supplies `--author` on `context.global`, not `context.options`. It
 * attributes both the client's item mutations and the durable transaction
 * journal, so both read back to the same actor rather than one of them
 * recording an anonymous default.
 *
 * @param context - The invoking command's handler context.
 * @returns The trimmed caller author, or `pm-rl` when none was supplied.
 */
function authorFor(context: CommandHandlerContext): string {
  return typeof context.global.author === "string" && context.global.author.trim().length > 0
    ? context.global.author.trim()
    : "pm-rl";
}

/** Classify a missing item through the injected SDK or its structural public contract. */
function isItemNotFound(error: unknown): boolean {
  return isPmCliExpectedError(error) && error.exitCode === EXIT_CODE.NOT_FOUND;
}


/** Narrow a parsed value to a JSON object. */
function jsonObject(value: unknown, source: string): Record<string, JsonValue> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(`${source} must contain one JSON object.`, "invalid_json_object");
  }
  return value as Record<string, JsonValue>;
}

/** Parse a completed collection receipt into a typed run id and event list; malformed payloads are step drift. */
function collectionReceipt(value: JsonValue): { run: string; events: readonly MetricEvent[] } {
  const record = jsonObject(value, "Loop collection step");
  const run = record["run"];
  const events = record["events"];
  if (typeof run !== "string" || run.length === 0 || !Array.isArray(events)
    || events.some((event) => event === null || typeof event !== "object" || Array.isArray(event))) {
    fail("Loop collection receipt payload is malformed.", "loop_step_drift", EXIT_CODE.CONFLICT);
  }
  return { run, events: events as unknown as readonly MetricEvent[] };
}


/** Parse one JSON object while preserving a domain-specific machine error code. */
function parseJsonObject(text: string, source: string, code: string, exitCode: number = EXIT_CODE.USAGE): Record<string, JsonValue> {
  try {
    return jsonObject(parseBoundedJson(text), source);
  } catch (error) {
    if (isPmCliExpectedError(error)) throw error;
    fail(`${source} is not valid JSON.`, code, exitCode);
  }
}

/** Require non-empty string values for a domain specification's identity fields. */
function requireJsonStrings(record: Record<string, JsonValue>, keys: readonly string[], source: string, codePrefix: string, exitCode: number = EXIT_CODE.USAGE, mode: ValidationMode = "read"): void {
  for (const key of keys) {
    const value = record[key];
    if (typeof value !== "string" || value.trim().length === 0) {
      fail(`${source} requires a non-empty string ${key}.`, `${codePrefix}_${key}`, exitCode);
    }
    if (mode === "write" && key.endsWith("_id")) record[key] = identifier(value);
    if (mode === "write" && key === "checkpoint") identifier(value, "artifact");
  }
}

/**
 * Serialize JSON with recursively byte-ordered object keys.
 *
 * A content identity must be independent of property insertion order. Arrays
 * remain ordered because task and reward sequences can be semantically ordered.
 */
export function canonicalJson(value: JsonValue): string {
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key]!)}`).join(",")}}`;
  }
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  return String(value);
}

/** Parse and validate an environment specification. */
export function parseEnvironmentSpec(text: string, source = "Environment file"): EnvironmentSpec {
  const record = parseJsonObject(text, source, "invalid_environment_json");
  requireJsonStrings(record, ["name", "version"], source, "invalid_environment");
  for (const key of ["task_suite", "reward_specification"] as const) {
    if (!(key in record)) fail(`${source} requires ${key}.`, `missing_environment_${key}`);
  }
  return record as EnvironmentSpec;
}

/** Parse and validate a benchmark specification and canonicalize contamination ids. */
export function parseBenchmarkSpec(text: string, source = "Benchmark file", mode: ValidationMode = "read"): BenchmarkSpec {
  const record = parseJsonObject(text, source, "invalid_benchmark_json");
  requireJsonStrings(record, ["name", "version"], source, "invalid_benchmark");
  for (const key of ["task_suite", "scoring_function", "pass_criteria"] as const) {
    if (!(key in record)) fail(`${source} requires ${key}.`, `missing_benchmark_${key}`);
  }
  if (record.direction !== "maximize" && record.direction !== "minimize") {
    fail(`${source} direction must be maximize or minimize.`, "invalid_benchmark_direction");
  }
  const contamination = record.contaminated_environments ?? [];
  if (!Array.isArray(contamination) || contamination.some((id) => typeof id !== "string" || id.trim().length === 0)) {
    fail(`${source} contaminated_environments must be an array of non-empty environment ids.`, "invalid_benchmark_contamination");
  }
  const contaminatedEnvironments = contamination as string[];
  return {
    ...record,
    name: (record.name as string).trim(),
    version: (record.version as string).trim(),
    task_suite: record.task_suite!,
    scoring_function: record.scoring_function!,
    pass_criteria: record.pass_criteria!,
    direction: record.direction,
    contaminated_environments: [...new Set(contaminatedEnvironments.map((id) => schemaIdentity(id, "item", mode)))].sort(),
  };
}

/** Parse and validate one stored evaluation provenance record. */
export function parseEvalResultSpec(text: string, source = "EvalResult", mode: ValidationMode = "read"): EvalResultSpec {
  const record = parseJsonObject(text, source, "invalid_eval_result_json", EXIT_CODE.CONFLICT);
  requireJsonStrings(record, ["checkpoint", "run_id", "benchmark_id", "environment_id", "environment_spec_hash", "reward_spec_hash"], source, "invalid_eval_result", EXIT_CODE.CONFLICT, mode);
  if (typeof record.score !== "number" || !Number.isFinite(record.score)) {
    fail(`${source} score must be finite.`, "invalid_eval_result_score", EXIT_CODE.CONFLICT);
  }
  if (typeof record.passed !== "boolean") {
    fail(`${source} passed must be a boolean.`, "invalid_eval_result_passed", EXIT_CODE.CONFLICT);
  }
  return {
    checkpoint: (record.checkpoint as string).trim(),
    score: record.score,
    passed: record.passed,
    run_id: (record.run_id as string).trim(),
    benchmark_id: (record.benchmark_id as string).trim(),
    environment_id: (record.environment_id as string).trim(),
    environment_spec_hash: (record.environment_spec_hash as string).trim(),
    reward_spec_hash: (record.reward_spec_hash as string).trim(),
  };
}

/** SHA-256 identity of a JSON value's canonical encoding. */
export function hashJson(value: JsonValue): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

/** Turn a human label into a bounded pm id segment. */
export function idSegment(value: string): string {
  const segment = value.toLowerCase().replaceAll(/[^a-z0-9]+/g, "-").replaceAll(/^-|-$/g, "").slice(0, 28);
  return segment.length > 0 ? segment : "environment";
}

/** One SDK projection whose exact current revision contributed to a promotion decision. */
interface PromotionEvidenceRead { readonly at?: string; readonly fields?: string; readonly item: GetResult["item"] | null; readonly authorization?: true }
/** SDK-certified records actually read by a decision; nested readers contribute to their enclosing decision too. */
interface DecisionReads { readonly client: PmClient; readonly inputs: Map<string, GetResult["item"]>; readonly parent?: DecisionReads; readonly childrenOnly: boolean; lastId?: string }
const decisionReads = new AsyncLocalStorage<DecisionReads>();
/** Complete SDK domain projection shared by decision input hashing and citations. @internal */
export { DECISION_INPUT_FIELDS } from "./state-boundary.ts";
/** Add provenance location without replacing the exception used by controller verdict classification. */
function annotateDecisionError(error: PmCliExpectedError, fallback: string): PmCliExpectedError {
  const id = String(error.context.item_id ?? fallback);
  if (id !== "evaluation-input" && !error.message.includes(id)) error.message = `${error.message} Record ${id}.`;
  Object.assign(error.context, { item_id: id });
  return error;
}
/** Return the inputs read by the decision itself, without maintaining a parallel dependency list. @internal */
export async function captureDecisionInputs<T>(client: PmClient, execute: () => Promise<T>, childrenOnly = false): Promise<{ value: T; inputs: GetResult["item"][] }> {
  const state: DecisionReads = { client, inputs: new Map(), parent: decisionReads.getStore(), childrenOnly };
  return decisionReads.run(state, async () => {
    try { return { value: await execute(), inputs: [...state.inputs.values()].sort((a, b) => a.id.localeCompare(b.id)) }; }
    catch (error) {
      if (!isPmCliExpectedError(error)) throw error;
      throw annotateDecisionError(error, state.lastId ?? "evaluation-input");
    }
  });
}
/** Historical reads establish dependencies too; prefer live projections when the validator also reads them. */
function observeDecisionInput(client: PmClient, item: GetResult["item"], at: string | undefined): void {
  // Only a decision reader can certify inputs. A nested controller is still
  // bookkeeping, not an evaluator, even when another controller encloses it.
  const reader = decisionReads.getStore();
  if (reader?.childrenOnly !== false) return;
  for (let state: DecisionReads | undefined = reader; state !== undefined; state = state.parent) {
    if (state.client === client && (!state.childrenOnly || state !== decisionReads.getStore())) { state.lastId = item.id; if (at === undefined || !state.inputs.has(item.id)) state.inputs.set(item.id, structuredClone(item)); }
  }
}
const promotionEvidence = new AsyncLocalStorage<{ client: PmClient; reads: Map<string, PromotionEvidenceRead[]>; detectChanges: boolean }>();
/** Collect every live evidence read, including absent slots, until the guarded promotion write. @internal */
export function withPromotionEvidence<T>(client: PmClient, execute: () => Promise<T>, detectChanges = false): Promise<T> {
  return promotionEvidence.run({ client, reads: new Map(), detectChanges }, execute);
}
/** Retain SDK projections unchanged; historical coordinates and live revisions remain distinct. */
function observePromotionEvidence(id: string, fields: string | undefined, item: GetResult["item"] | null, at: string | undefined, authorization = false): void {
  const reads = promotionEvidence.getStore()!.reads;
  // Refresh authorization to its latest SDK revision; retain every statistical
  // projection, including when a Decision also serves as a review record.
  const previous = (reads.get(id) ?? []).filter((read) => !authorization || read.authorization !== true);
  if (!authorization && promotionEvidence.getStore()!.detectChanges && at === undefined && previous.some((read) => read.authorization !== true && read.at === undefined && read.fields === fields && canonicalJson(read.item as JsonValue) !== canonicalJson(item as JsonValue))) {
    fail("Promotion evidence changed during validation; retry from current evidence. No new approval was consumed.", "loop_write_conflict", EXIT_CODE.CONFLICT);
  }
  if (!previous.some((read) => read.authorization === (authorization ? true : undefined) && read.at === at && read.fields === fields && canonicalJson(read.item as JsonValue) === canonicalJson(item as JsonValue))) previous.push({ at, fields, item: structuredClone(item), ...(authorization ? { authorization: true } : {}) });
  reads.set(id, previous);
}
/** Read complete current or verified historical domain evidence without an output ceiling. */
export async function readCompleteLoopItem(client: PmClient, id: string, at?: string, fields?: string): Promise<GetResult> {
  const observing = promotionEvidence.getStore()?.client === client;
  if (observing) {
    operationIdentifier(id);
    const prefix = String((await identifierClient(client).config("project", "get", "id_prefix")).nested_setting!.value);
    id = canonicalizeIdentifier(id, prefix);
  }
  const result = await identifierClient(client).get(id, { ...(fields === undefined ? { depth: "standard" } : { fields }), outputLimit: "unbounded", outputBudget: "unbounded", ...(at === undefined ? {} : { at }) }).catch((error: unknown) => {
    if (observing && isPmCliExpectedError(error) && error.exitCode === EXIT_CODE.NOT_FOUND) observePromotionEvidence(id, fields, null, at);
    try { return rethrowProvenanceRead(error); }
    catch (classified) {
      if (decisionReads.getStore()?.client === client && isPmCliExpectedError(classified)) throw annotateDecisionError(classified, id);
      throw classified;
    }
  });
  if (!("item" in result) || "output_budget_exceeded" in result) {
    fail(`Item ${id} was omitted despite an unbounded read request.`, "loop_history_incomplete", EXIT_CODE.CONFLICT);
  }
  if (observing) observePromotionEvidence(result.item.id, fields, result.item, at);
  const tracing = decisionReads.getStore();
  if (at === undefined && result.item.type === "Run" && tracing?.client === client && !tracing.childrenOnly && fields !== DECISION_INPUT_FIELDS) {
    await readCompleteLoopItem(client, result.item.id, undefined, DECISION_INPUT_FIELDS);
    return result as GetResult;
  }
  if (at !== undefined && tracing?.client === client && !tracing.childrenOnly && !tracing.inputs.has(result.item.id)) {
    await readCompleteLoopItem(client, result.item.id).catch((error: unknown) => {
      // A certified historical projection survives a later native deletion.
      // Only absence of the current counterpart is optional; storage failures still retry.
      if (!isItemNotFound(error)) throw error;
    });
  }
  observeDecisionInput(client, result.item, at);
  return result as GetResult;
}

/** Locate the first certified semantic version through the SDK, retaining compaction coordinates. @internal */
export async function firstDecisionSnapshot(client: PmClient, id: string, matches: (item: GetResult["item"]) => boolean, fields?: string): Promise<{ item: GetResult["item"]; at: string }> {
  const history = await identifierClient(client).run("history", { id, options: { compact: true, verify: true, outputLimit: "unbounded", outputBudget: "unbounded" } }).catch(rethrowProvenanceRead) as HistoryResult;
  if (!history.verification?.ok || history.limit !== null || history.compact_history?.length !== history.count) fail("Decision input history is incomplete.", "loop_history_incomplete", EXIT_CODE.CONFLICT);
  for (const row of history.compact_history) {
    const at = String(row.version ?? row.index);
    const item = (await readCompleteLoopItem(client, id, at, fields)).item;
    if (matches(item)) return { item, at };
  }
  throw createPmCliExpectedError(`Restore certified input ${id} before replaying its receipt.`, { exitCode: EXIT_CODE.CONFLICT, context: { code: "eval_plan_drift", item_id: id } });
}
/** Recognize actual completed executions; malformed historical envelopes establish no completion seal. @internal */
export function completedDecisionReceipt(row: Readonly<Record<string, unknown>>): boolean {
  if (row.format !== "pm-rl/loop-step/1" || row.state !== "complete" || typeof row.input !== "string" || !/^[a-f0-9]{64}$/.test(row.input)
    || row.result === null || typeof row.result !== "object" || Array.isArray(row.result) || row.digest !== hashJson(row.result as JsonValue)) return false;
  try { if (row.decision_evidence !== undefined) parseEvaluationEvidence(row.decision_evidence); }
  catch { return false; }
  return true;
}
/** A completed receipt cannot shed its input graph or replace it with a freshly rehashed subset. @internal */
export async function verifyCompletedDecisionReceipt(client: PmClient, id: string, body: Readonly<Record<string, unknown>>, prospective = false): Promise<void> {
  let original: Awaited<ReturnType<typeof firstDecisionSnapshot>>;
  try {
    original = await firstDecisionSnapshot(client, id, (item) => {
      return decodeTrackerRecord(null, item, { type: "Decision", format: "pm-rl/loop-step/1", valid: completedDecisionReceipt }) !== null;
    });
  } catch (error) {
    if (prospective && isPmCliExpectedError(error) && error.context.code === "eval_plan_drift") return;
    if (prospective && isPmCliExpectedError(error) && error.exitCode === EXIT_CODE.NOT_FOUND) return;
    throw error;
  }
  const sealed = parseBoundedJson(String(original.item.body)) as Record<string, unknown>;
  if ((sealed.decision_evidence !== undefined || body.decision_evidence !== undefined) && canonicalJson(sealed as JsonValue) !== canonicalJson(body as JsonValue)) {
    const originalGraph = sealed.decision_evidence as EvaluationEvidence | undefined;
    const changedGraph = body.decision_evidence as EvaluationEvidence | undefined;
    const changed = originalGraph?.inputs.find((input, index) => canonicalJson(input as unknown as JsonValue) !== canonicalJson((changedGraph?.inputs?.[index] ?? null) as unknown as JsonValue));
    const snapshot = changed === undefined ? id : `${changed.id}@${changed.at ?? "unversioned"}`;
    throw createPmCliExpectedError(`Completed decision ${id} changed at snapshot ${snapshot}; restore its original receipt.`, { exitCode: EXIT_CODE.CONFLICT, context: { code: "loop_step_drift", item_id: id, required: `Restore original snapshot ${snapshot}.` } });
  }
}
/** Distinguish terminal evaluator outcomes without interpreting tracker status names. */
function terminalEvaluation(spec: GenerationSpec): boolean { return spec.promoted || (spec.policy_evaluation as Record<string, JsonValue> | undefined)?.["decision"] === "refuse"; }
/** Bind new promotion/rejection graphs to their first terminal SDK snapshot, including removal attempts. @internal */
export async function verifyTerminalEvaluationReceipt(client: PmClient, item: GetResult["item"]): Promise<void> {
  const current = extractGenerationSpec(String(item.body), "Decision receipt");
  let first: Awaited<ReturnType<typeof firstDecisionSnapshot>>;
  try { first = await firstDecisionSnapshot(client, item.id, (source) => terminalEvaluation(extractGenerationSpec(String(source.body), "Historical decision"))); }
  catch (error) {
    if (!terminalEvaluation(current) && isPmCliExpectedError(error) && error.context.code === "eval_plan_drift") return;
    throw error;
  }
  const original = extractGenerationSpec(String(first.item.body), "First decision receipt");
  /** Outcome fields are sealed together; provenance itself retains its original generation hash. */
  function outcome(spec: GenerationSpec): JsonValue { return { graph: spec.evaluation_evidence as unknown as JsonValue ?? null, promoted: spec.promoted, approval: spec.approval, proxy: spec.proxy_score as unknown as JsonValue, held_out: spec.held_out_score as unknown as JsonValue, gap: spec.gap, evidence: spec.promotion_evidence, evaluator: spec.policy_evaluation ?? null }; }
  if ((original.evaluation_evidence !== undefined || current.evaluation_evidence !== undefined) && canonicalJson(outcome(original)) !== canonicalJson(outcome(current))) {
    throw createPmCliExpectedError(`Terminal decision ${item.id} changed; restore its first receipt.`, { exitCode: EXIT_CODE.CONFLICT, context: { code: "eval_plan_drift", item_id: item.id } });
  }
}
/** Persist the exact history coordinates of evaluator reads in a durable enclosing step. @internal */
export async function sealDecisionEvidence(client: PmClient, comparison: string, inputs: readonly GetResult["item"][]): Promise<EvaluationEvidence> {
  return decisionReads.exit(async () => {
    const refs = [];
    for (const item of inputs) {
      const digest = decisionSnapshotDigest(item);
      const original = await firstDecisionSnapshot(client, item.id, (historical) => decisionSnapshotDigest(historical) === digest, DECISION_INPUT_FIELDS);
      refs.push({ id: item.id, digest, at: original.at });
    }
    const body = { format: "pm-rl/evaluation-evidence/2" as const, comparison, inputs: refs };
    return parseEvaluationEvidence({ ...body, digest: hashJson(body as unknown as JsonValue) });
  });
}
/** Read only a certified historical input; enclosing decisions must not substitute a live projection. @internal */
export async function readDecisionSnapshot(client: PmClient, id: string, at: string): Promise<GetResult> {
  return decisionReads.exit(() => readCompleteLoopItem(client, id, at, DECISION_INPUT_FIELDS));
}
/** Completed executions consume recorded snapshots, including legacy comparison-based digests. @internal */
export async function verifyDecisionSnapshots(client: PmClient, evidence: EvaluationEvidence): Promise<void> {
  for (const input of evidence.inputs) {
    const snapshot = `${input.id}@${input.at ?? "unversioned"}`;
    try {
      if (input.at === undefined) throw createPmCliExpectedError(`Receipt has no certified coordinate for ${snapshot}; restore the original versioned receipt.`, { exitCode: EXIT_CODE.CONFLICT, context: { code: "eval_plan_drift", item_id: input.id } });
      const historical = await readDecisionSnapshot(client, input.id, input.at);
      const digest = evidence.format === "pm-rl/evaluation-evidence/2" ? decisionSnapshotDigest(historical.item) : evaluationInputDigest(historical.item, evidence.comparison);
      if (historical.item.id === input.id && digest === input.digest) continue;
    } catch (error) { rethrowOperationalRead(error); }
    throw createPmCliExpectedError(`Restore certified decision snapshot ${snapshot} before replay.`, { exitCode: EXIT_CODE.CONFLICT, context: { code: "eval_plan_drift", item_id: input.id, required: `Restore original snapshot ${snapshot}.` } });
  }
}
/** One replay scope deduplicates upstream decisions while never caching across calls. */
interface EvidenceVerification { readonly client: PmClient; readonly graphs: Set<string>; readonly subjects: Set<string> }
const evidenceVerification = new AsyncLocalStorage<EvidenceVerification>();
/** Revalidate certified versions and live content, using the actual evaluator for every upstream decision. @internal */
export async function verifyDecisionEvidence(client: PmClient, evidence: EvaluationEvidence): Promise<void> {
  if (evidence.format !== "pm-rl/evaluation-evidence/1") fail("Promotion requires current evaluator evidence; immutable execution snapshots are replay-only.", "eval_plan_evidence", EXIT_CODE.CONFLICT);
  const current = evidenceVerification.getStore();
  if (current?.client === client) return verifyDecisionInputs(client, evidence, current);
  const scope: EvidenceVerification = { client, graphs: new Set(), subjects: new Set() };
  return evidenceVerification.run(scope, () => verifyDecisionInputs(client, evidence, scope));
}
/** Traverse a complete evidence closure once, preserving SDK historical addresses and decision semantics. */
async function verifyDecisionInputs(client: PmClient, evidence: EvaluationEvidence, scope: EvidenceVerification): Promise<void> {
  if (scope.graphs.has(evidence.digest)) return;
  scope.graphs.add(evidence.digest);
  for (const input of evidence.inputs) {
    const historical = await readCompleteLoopItem(client, input.id, input.at, DECISION_INPUT_FIELDS);
    if (historical.item.id !== input.id || evaluationInputDigest(historical.item, evidence.comparison) !== input.digest) throw createPmCliExpectedError(`Restore cited decision input ${input.id} before replay.`, { exitCode: EXIT_CODE.CONFLICT, context: { code: "eval_plan_drift", item_id: input.id } });
    const current = input.at === undefined ? historical : await readCompleteLoopItem(client, input.id, undefined, DECISION_INPUT_FIELDS);
    if (evaluationInputDigest(current.item, evidence.comparison) !== input.digest) throw createPmCliExpectedError(`Decision input ${input.id} changed after sealing; restore the cited record.`, { exitCode: EXIT_CODE.CONFLICT, context: { code: "eval_plan_drift", item_id: input.id } });
    if (current.item.type !== "Generation" || scope.subjects.has(current.item.id)) continue;
    const nested = extractGenerationSpec(String(current.item.body), "Upstream decision evidence").evaluation_evidence;
    if (nested !== undefined) {
      scope.subjects.add(current.item.id);
      const decision = await readEvaluationDecision(client, current.item.id);
      if (decision.evidence?.digest !== nested.digest) throw createPmCliExpectedError(`Upstream decision ${current.item.id} does not match its evaluator.`, { exitCode: EXIT_CODE.CONFLICT, context: { code: "eval_plan_drift", item_id: current.item.id } });
    }
  }
}

/** Hold every certified SDK read through an outcome or publication write, releasing only owned leases. */
async function withLockedPromotionEvidence<T>(client: PmClient, pmRoot: string, settings: Awaited<ReturnType<typeof readSettings>>, target: string | null, preconditions: readonly GetResult[], author: string, execute: () => Promise<T>): Promise<T> {
  const releases: (() => Promise<void>)[] = [];
  try {
    // These are the SDK's native item locks, also observed by ordinary CLI and SDK peer writes.
    const observed = promotionEvidence.getStore();
    const reads = observed?.client === client ? observed.reads : new Map<string, PromotionEvidenceRead[]>();
    const dependencies = new Map(preconditions.map((dependency) => [dependency.item.id, dependency]));
    const ids = [...new Set([...dependencies.keys(), ...reads.keys()])].filter((id) => id !== target).sort();
    for (const id of ids) releases.push(await acquireStateLock(pmRoot, id, settings.locks.ttl_seconds, author, false, false, settings.locks.wait_ms));
    // All SDK writers now contend on these native leases. Validate after the last acquisition,
    // and retain every lease through the authoritative SDK mutation and its terminal record.
    await promotionEvidence.exit(async () => {
      for (const [id, projections] of reads) for (const projection of projections) {
        let current: GetResult["item"] | null;
        try { current = (await readCompleteLoopItem(client, id, projection.at, projection.fields)).item; }
        catch (error) { if (isPmCliExpectedError(error) && error.exitCode === EXIT_CODE.NOT_FOUND) current = null; else throw error; }
        if (canonicalJson(current as JsonValue) !== canonicalJson(projection.item as JsonValue)) fail(projection.authorization === true ? "Promotion authorization changed after its budget decision; retry from current capacity. No new approval was consumed." : "Promotion evidence changed after validation; retry from current evidence. No new approval was consumed.", "loop_write_conflict", EXIT_CODE.CONFLICT);
      }
      for (const dependency of dependencies.values()) {
        const current = await readCompleteLoopItem(client, dependency.item.id);
        if (current.item.updated_at !== dependency.item.updated_at || current.item.body !== dependency.item.body) fail("Promotion evidence or budget changed after it was read; retry from current evidence.", "loop_write_conflict", EXIT_CODE.CONFLICT);
      }
    });
    return await promotionEvidence.exit(execute);
  } finally {
    for (const release of releases.reverse()) await release();
  }
}

/** Apply a read-derived change through the SDK item transaction, refusing a stale revision under its item lock. @internal */
export async function mutateLoopItem(client: PmClient, before: GetResult, message: string, change: (document: ItemDocument, closeStatus: string, terminal: boolean) => string[], preconditions: readonly GetResult[] = [], author = "pm-rl", op: "update" | "close" = "update"): Promise<GetResult> {
  operationIdentifier(before.item.id); preconditions.forEach((dependency) => operationIdentifier(dependency.item.id));
  const config = await identifierClient(client).config("project", "get", "id_prefix");
  const pmRoot = dirname(config.settings_path);
  const settings = await readSettings(pmRoot);
  const expected = { updated: before.item.updated_at, body: String(before.item.body) };
  try {
    return await withLockedPromotionEvidence(client, pmRoot, settings, before.item.id, preconditions, author, async () => {
      const result = await runWithActiveExtensions({ path: pmRoot }, () => mutateItem({ pmRoot, settings, id: before.item.id, op, author, message, skipNoop: true,
        mutate: (document) => {
          if (document.metadata.updated_at !== expected.updated || document.body !== expected.body) fail("Tracker item changed after it was read; retry from current evidence.", "loop_write_conflict", EXIT_CODE.CONFLICT);
          const registry = resolveRuntimeStatusRegistry(settings.schema);
          return { changedFields: change(document, registry.close_status, isTerminalStatus(document.metadata.status, registry)) };
        },
      }));
      return { item: { ...result.item, body: result.body } };
    });
  } catch (error) {
    if (isPmCliExpectedError(error)) {
      try {
        const authoritative = await readCompleteLoopItem(client, before.item.id, undefined, "id,status,updated_at");
        Object.assign(error.context, { authoritative_status: authoritative.item.status, authoritative_revision: authoritative.item.updated_at });
      } catch (readError) {
        Object.assign(error.context, { authoritative_item_read_error: isPmCliExpectedError(readError) ? String(readError.context.code) : "unavailable" });
      }
    }
    throw error;
  }
}

/** Close a generation and optionally publish its outcome in one guarded SDK item transaction. */
async function completeLoopGeneration(client: PmClient, before: GetResult, body: string, evidence: string, actual: string, preconditions: readonly GetResult[] = [], author = "pm-rl"): Promise<GetResult> {
  return mutateLoopItem(client, before, "Complete RL promotion atomically", (document, closeStatus, terminal) => {
    if (terminal) fail("A terminal generation cannot be promoted again.", "generation_terminal", EXIT_CODE.CONFLICT);
    document.body = body;
    const at = new Date().toISOString();
    Object.assign(document.metadata, { status: closeStatus, close_reason: "promoted", closed_at: at, completed_at: document.metadata.completed_at ?? at, resolution: evidence,
      expected_result: "The generation reaches a promoted state with both scores and the direction-aware gap recorded.", actual_result: actual });
    const fields = ["body", "status", "close_reason", "closed_at", "completed_at", "resolution", "expected_result", "actual_result"];
    if (document.metadata.assignee !== undefined) { delete document.metadata.assignee; fields.push("assignee"); }
    fields.push(...applyTerminalOrderingPolicy(document.metadata, { orderingEdges: "preserve" }).changedFields);
    return fields;
  }, preconditions, author, "close");
}

/** Validate that an existing item has the expected domain type. */
async function getTypedItem(client: PmClient, id: string, type: "Decision" | "Environment" | "Run" | "Generation" | "Benchmark" | "EvalResult" | "GateEpisode" | "MergeOutcome" | "Sweep" | "Transfer"): Promise<GetResult> {
  // Benchmarks validate edge roles, which deep presentation reads omit; every
  // other domain type uses the complete, unbounded loop read.
  const result = type === "Benchmark" ? await identifierClient(client).get(id, { full: true }) : await readCompleteLoopItem(client, id);
  if (result.item.type !== type) fail(`pm rl expected ${type} ${id}, not ${String(result.item.type)}.`, "wrong_item_type", EXIT_CODE.CONFLICT);
  return result;
}

/**
 * Persist the registered types so every core mutation can locate their folders.
 *
 * pm-cli 2026.8.1 resolves extension types for reads and creates but not core
 * updates or closes (upstream #855). `schemaAddType` is byte-idempotent, so this
 * compatibility step changes a tracker only on its first pm-rl mutation and can
 * be removed once the host uses one registry across all store paths.
 */
async function ensurePersistentTypes(client: PmClient): Promise<void> {
  for (const itemType of RL_ITEM_TYPES) {
    await identifierClient(client).schemaAddType(itemType.name, {
      folder: itemType.folder,
      alias: [...itemType.aliases],
      description: itemType.description,
      defaultStatus: itemType.default_status,
      author: "pm-rl",
    });
  }
}

/** Read a UTF-8 input file and convert filesystem failures into expected CLI errors. */
function readTextFile(path: string, label: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    fail(`${label} could not be read from ${path}: ${String(error)}`, "file_read_failed");
  }
}

/** Read a JSON file and validate its value without guessing an external schema. */
function readJsonFile(path: string, label: string): JsonValue {
  const text = readTextFile(path, label);
  try {
    return parseBoundedJson(text) as JsonValue;
  } catch {
    fail(`${label} at ${path} is not valid JSON.`, "invalid_json");
  }
}

/**
 * Read every note required to reconstruct an immutable metric series.
 *
 * Universal reads intentionally default to bounded agent output. Metric history
 * is a correctness input, so compacting a row or its compressed text would turn
 * valid data into an apparent corrupt segment. Both dimensions are therefore
 * explicitly unbounded and any omission envelope still fails closed.
 */
async function readCompleteNotes(client: PmClient, id: string): Promise<LogNote[]> {
  const result = await identifierClient(client).notes(id, { outputBudget: "unbounded", outputLimit: "unbounded" });
  if ("output_budget_exceeded" in result) {
    fail(`Run ${id} note history was omitted despite an unbounded read request.`, "metric_history_incomplete", EXIT_CODE.CONFLICT);
  }
  return result.notes;
}

/**
 * Create an immutable identity or verify the item that won a concurrent create.
 * @internal
 *
 * Only the SDK's typed already-exists refusal permits recovery. The pinned SDK
 * has no context code for create collisions, so its exact resolved-id message
 * is checked as well as its conflict exit code. Other errors propagate.
 * Neither path rewrites the winner or its history.
 *
 * @param client - Client bound to the target workspace.
 * @param options - Complete create envelope with an explicit identity and type.
 * @param collisionCode - Typed refusal when the existing identity differs.
 * @param matches - Checks the stored content and provenance, not just the id.
 * @param beforeCreate - Validate new-write policy only after certified absence, never on legacy retries.
 * @returns The created or verified item and whether this caller created it.
 */
export async function createOrReadIdentical(client: PmClient, options: Parameters<PmClient["create"]>[0] & { id: string; type: "Decision" | "Environment" | "Run" | "Generation" }, collisionCode: string, matches: (item: GetResult["item"]) => boolean, beforeCreate?: () => void | Promise<void>): Promise<{ item: GetResult["item"]; created: boolean }> {
  /** Read and validate the winner at either the initial read or collision boundary. */
  async function readMatching(): Promise<GetResult["item"]> {
    const existing = await getTypedItem(client, options.id, options.type);
    if (!matches(existing.item)) {
      fail(`${options.type} id ${options.id} already exists with a different specification hash or provenance content.`, collisionCode, EXIT_CODE.CONFLICT);
    }
    return existing.item;
  }
  try {
    return { item: await readMatching(), created: false };
  } catch (error) {
    if (!isItemNotFound(error)) throw error;
  }
  await beforeCreate?.();
  try {
    return { item: (await identifierClient(client).create(options)).item, created: true };
  } catch (error) {
    if (!isPmCliExpectedError(error) || error.exitCode !== EXIT_CODE.CONFLICT || !/^Item "[^"]+" already exists$/.test(error.message)) throw error;
    const item = await readMatching();
    if (error.message !== `Item "${String(item.id)}" already exists`) throw error;
    return { item, created: false };
  }
}

/**
 * Register one immutable content-addressed Environment, or return the existing one.
 *
 * The idempotency discipline is written once for both the generic and the
 * gate-simulator environment commands: derive the id from the content hash,
 * return the existing item only when its recorded identity still matches, and
 * refuse a squatter on the derived id that carries a different hash — trusting
 * the id alone would let a foreign specification inherit an environment's
 * provenance. When nothing exists yet, the caller's create envelope runs.
 *
 * @param client - Client bound to the target workspace.
 * @param requestedId - Content-derived item id.
 * @param specHash - Content identity the stored item must still match.
 * @param action - Command action label for both outcomes.
 * @param create - The create envelope for a genuinely new registration.
 * @param details - Bounded details shared by both outcomes.
 * @returns The command result naming the resolved id and whether it was created.
 */
async function registerImmutableEnvironment(client: PmClient, requestedId: string, specHash: string, action: string, create: () => Parameters<PmClient["create"]>[0], details: Readonly<Record<string, unknown>>): Promise<RlCommandResult> {
  const result = await createOrReadIdentical(client, { ...create(), id: requestedId, type: "Environment" }, "environment_identity_collision", (item) =>
    item.affected_version === specHash && hashJson(parseJsonRecord(storedJson(String(item.body), `Environment ${requestedId}`, "environment_missing_spec"), `Environment ${requestedId}`, "environment_identity_collision", EXIT_CODE.CONFLICT) as JsonValue) === specHash,
  );
  return { action, id: String(result.item.id), created: result.created, details };
}

/** Register one immutable environment spec, idempotently by content identity. */
async function registerEnvironment(context: CommandHandlerContext): Promise<RlCommandResult> {
  const path = stringOption(context, "file")!;
  const spec = parseEnvironmentSpec(readTextFile(path, "Environment file"), `Environment file ${path}`);
  const client = clientFor(context);
  await ensurePersistentTypes(client);
  return registerEnvironmentSpecValue(client, spec);
}

/**
 * Register one immutable environment specification value, idempotently.
 *
 * The idempotency discipline is shared by the file-driven command and the
 * recursive loop: two loops over the same built-in environment content derive
 * the same content-addressed id, and the second registration returns the
 * first item rather than creating a squatter.
 *
 * @param client - Client bound to the target workspace.
 * @param spec - The complete environment specification to register.
 * @returns The command result naming the resolved id and whether it was created.
 */
async function registerEnvironmentSpecValue(client: PmClient, spec: EnvironmentSpec): Promise<RlCommandResult> {
  const specHash = hashJson(spec);
  const requestedId = `env-${idSegment(spec.name)}-${idSegment(spec.version)}-${specHash.slice(0, 12)}`;
  return registerImmutableEnvironment(client, requestedId, specHash, "rl-env-register", () => ({
    id: requestedId,
    title: `${spec.name} ${spec.version}`,
    type: "Environment",
    status: "open",
    acceptanceCriteria: "The complete specification is stored, its SHA-256 identity matches the item id, and changed behavior is registered as a new version.",
    estimatedMinutes: "1",
    body: `# ${spec.name} ${spec.version}\n\n\`\`\`json\n${encodeBoundedJson(spec, undefined, 2)}\n\`\`\``,
    affectedVersion: specHash,
    fixedVersion: spec.version,
    message: "Register immutable RL environment specification",
  }), { spec_hash: specHash });
}

/** Start one run linked to an exact environment and immutable configuration. */
async function startRun(context: CommandHandlerContext): Promise<RlCommandResult> {
  const requestedId = requiredArgument(context, "a run id");
  const environmentId = stringOption(context, "environment")!;
  const algorithm = stringOption(context, "algorithm")!;
  const configPath = stringOption(context, "config_file", false);
  const config = configPath === undefined ? {} : readJsonFile(configPath, "Run configuration");
  // A determinism receipt is optional at start but immutable once recorded: it
  // is written into the body here and re-derived later by `rl run verify`.
  const receiptPath = stringOption(context, "receipt_file", false);
  const receipt: ReceiptSpec | null = receiptPath === undefined ? null : parseReceipt(readTextFile(receiptPath, "Determinism receipt"), `Determinism receipt ${receiptPath}`);
  const client = clientFor(context);
  await ensurePersistentTypes(client);
  return startRunCore(client, { id: requestedId, environmentId, algorithm, config, receipt });
}

/** The resolved inputs of one attributable run, shared by the command and the recursive loop. */
interface RunStartRequest {
  /** Requested run item id. */
  readonly id: string;
  /** Environment item id the run trains under. */
  readonly environmentId: string;
  /** Training algorithm, recorded as the run's component identity. */
  readonly algorithm: string;
  /** Immutable run configuration, hashed into the run's fixed version. */
  readonly config: JsonValue;
  /** Optional determinism receipt recorded at start; null when absent. */
  readonly receipt: ReceiptSpec | null;
}

/**
 * Create one attributable run linked to an exact environment version.
 *
 * The write-boundary invariants live here once: the environment is verified
 * content-addressed before the run records it, and a receipt naming a
 * different environment is refused at the write rather than born
 * unverifiable. The recursive loop's collection runs go through the same
 * path, so a loop-generated run is attributable exactly like a manual one.
 *
 * @param client - Client bound to the target workspace.
 * @param request - The resolved run inputs.
 * @returns The command result naming the created run and its identities.
 */
async function startRunCore(client: PmClient, request: RunStartRequest): Promise<RlCommandResult> {
  const verifiedEnvironment = await verifyEnvironmentIdentity(client, request.environmentId, "runs");
  // A receipt that names an environment other than the one this run records
  // would be born already unverifiable; refuse it at the write, not at verify.
  if (request.receipt !== null && request.receipt.environment_version !== verifiedEnvironment.id) {
    fail(`Determinism receipt names environment "${request.receipt.environment_version}" but the run records ${verifiedEnvironment.id}. A receipt must pin the exact environment item id the run trains under.`, "receipt_environment_mismatch", EXIT_CODE.CONFLICT);
  }
  const storedSpec = verifiedEnvironment.spec;
  const specHash = hashJson(storedSpec);
  const configHash = hashJson(request.config);
  const createOptions = {
    id: request.id,
    title: request.id,
    type: "Run" as const,
    status: "in_progress",
    acceptanceCriteria: "The run retains its exact environment and configuration identities, metric input is complete, and finish records the terminal outcome.",
    estimatedMinutes: "1",
    body: `# ${request.id}\n\nAlgorithm: ${request.algorithm}\n\nEnvironment snapshot:\n\n\`\`\`json\n${encodeBoundedJson(storedSpec, undefined, 2)}\n\`\`\`\n\nRun configuration:\n\n\`\`\`json\n${encodeBoundedJson(request.config, undefined, 2)}\n\`\`\`${request.receipt === null ? "" : `\n\n${RECEIPT_HEADING}\n\n\`\`\`json\n${encodeBoundedJson(request.receipt, undefined, 2)}\n\`\`\``}`,
    // Both edges name the RESOLVED id. `environmentId` is the raw --environment
    // input, which may be an alias; recording it on one edge and the resolved id
    // on the other would make a single create call describe two different
    // environments, and the dependency graph would then disagree with the typed
    // field the contamination walk reads.
    dep: [verifiedEnvironment.id],
    environment: verifiedEnvironment.id,
    affectedVersion: specHash,
    component: request.algorithm,
    fixedVersion: configHash,
    message: "Start attributable RL run",
  };
  const result = await createOrReadIdentical(client, createOptions, "run_identity_collision", (item) =>
    item.affected_version === specHash && item.fixed_version === configHash && item.component === request.algorithm
    && normalizeRunEnvironment(item.environment) === verifiedEnvironment.id && item.body === createOptions.body,
  );
  return { action: "rl-run-start", id: result.item.id, created: result.created, details: { environment_id: verifiedEnvironment.id, spec_hash: specHash, config_hash: configHash } };
}

/**
 * Re-derive a run's determinism receipt against a fresh one.
 *
 * Verification is a pure read over two inputs — the receipt recorded at start
 * and the receipt the caller can still produce today — plus the run's own
 * recorded environment, which the receipt must name even when it agrees with
 * itself. Any difference refuses with `receipt_mismatch` naming each drifted
 * field; a run with no stored receipt is refused rather than treated as
 * matching an empty one. Verify never writes: an unverifiable claim must stay
 * exactly as it was claimed so the disagreement remains inspectable.
 */
async function verifyRun(context: CommandHandlerContext): Promise<RlCommandResult> {
  const id = requiredArgument(context, "a run id");
  const receiptPath = stringOption(context, "receipt_file")!;
  const rederived = parseReceipt(readTextFile(receiptPath, "Determinism receipt"), `Determinism receipt ${receiptPath}`);
  const client = clientFor(context);
  const run = await getTypedItem(client, id, "Run");
  const resolvedId = String(run.item.id);
  const storedReceipt = fencedSection(String(run.item.body), RECEIPT_HEADING);
  if (storedReceipt === null) {
    fail(`Run ${resolvedId} records no determinism receipt; restart it with pm rl run start --receipt-file to make it verifiable.`, "receipt_unrecorded", EXIT_CODE.CONFLICT);
  }
  const recorded = parseReceipt(storedReceipt, `Run ${resolvedId} recorded determinism receipt`);
  const differences = compareReceipts(recorded, rederived);
  // The receipt must also agree with the RUN ITSELF: an internally consistent
  // receipt naming an environment this run never used would otherwise verify.
  const runEnvironment = normalizeRunEnvironment(run.item.environment);
  if (typeof runEnvironment === "string" && runEnvironment.length > 0 && recorded.environment_version !== runEnvironment) {
    differences.unshift({ field: "environment_version", recorded: `"${recorded.environment_version}"`, now: `the run's recorded environment ${runEnvironment}` });
  }
  if (differences.length > 0) {
    fail(`pm rl run verify reports run ${resolvedId} as UNVERIFIABLE. Receipt no longer re-derives: ${renderReceiptDifferences(differences)}.`, "receipt_mismatch", EXIT_CODE.CONFLICT);
  }
  return {
    action: "rl-run-verify",
    id: resolvedId,
    details: {
      verified: true,
      differences: [],
      seed_policy: recorded.seed_policy,
      device: recorded.device,
      library_versions: recorded.library_versions,
      environment_version: recorded.environment_version,
    },
  };
}

/**
 * Read an async iterable to EOF, returning its concatenated UTF-8 content.
 *
 * The previous synchronous `readFileSync(0)` drain normalised a transient
 * `EAGAIN` into an empty string. On a non-blocking stdin descriptor `EAGAIN`
 * means the read *would block*, not that the stream reached EOF, so a producer
 * that is merely slow — `some-generator | pm rl run log <id>` where the
 * generator thinks for a moment before writing — had its valid NDJSON
 * discarded and was told the stream was empty. Reading asynchronously until the
 * iterable ends removes the `EAGAIN` interpretation entirely: a pipe at EOF
 * ends, a slow producer is waited for, and a non-blocking socket ends when it
 * is closed, so local and CI behaviour is identical — which was the whole
 * point of the original normalisation, achieved without the data loss.
 *
 * Binary chunks are decoded through a {@link StringDecoder} rather than
 * per-chunk `Buffer.toString`, because a stream splits on byte boundaries, not
 * character boundaries: a multi-byte UTF-8 sequence straddling two chunks would
 * decode to two replacement characters on each side of the split and silently
 * corrupt the NDJSON. The decoder holds the incomplete tail until the next
 * chunk supplies it, and `end()` flushes whatever remains of a truncated final
 * sequence.
 *
 * @param stream - Async iterable of string or binary chunks to drain. Defaults
 *   to the real `process.stdin` for direct production callers; tests pass an
 *   iterable that ends so the suite never blocks on the test runner's
 *   non-blocking fd 0, which never reaches EOF.
 * @returns The concatenated UTF-8 content, or `""` when the stream was empty.
 */
export async function readStdin(
  stream: AsyncIterable<string | Uint8Array> = process.stdin,
): Promise<string> {
  const decoder = new StringDecoder("utf8");
  const chunks: string[] = [];
  for await (const chunk of stream) {
    chunks.push(typeof chunk === "string" ? chunk : decoder.write(Buffer.from(chunk)));
  }
  chunks.push(decoder.end());
  return chunks.join("");
}

/**
 * Injectable async stdin source for {@link logRun}'s pipe path. Defaults to the
 * real `process.stdin` so production reads from the process's fd 0; tests
 * substitute an `AsyncIterable` that ends, because the test runner's fd 0 is a
 * non-blocking socket that never reaches EOF and would hang the suite forever.
 */
export const stdinSource: { stream: AsyncIterable<string | Uint8Array> } = {
  stream: process.stdin,
};

/**
 * Append validated metric events to a run's merge-safe note history.
 *
 * One write path for the file-driven command and the recursive loop: events
 * are packed into bounded compressed segments and appended as one atomic
 * mutation, so concurrent branches keep every accepted occurrence.
 *
 * @param client - Client bound to the target workspace.
 * @param runId - The run item id whose history the events join.
 * @param events - At least one validated metric event.
 * @returns Bounded receipt details shared by both callers.
 */
async function appendRunMetrics(client: PmClient, runId: string, events: readonly MetricEvent[]): Promise<Readonly<Record<string, unknown>>> {
  const notes = encodeEventSegments(events);
  await identifierClient(client).update(runId, {
    note: notes,
    message: `Append ${events.length} RL metric event(s) in ${notes.length} bounded segment(s) atomically`,
  });
  return {
    appended: events.length,
    segments: notes.length,
    stored_bytes: notes.reduce((total, note) => total + Buffer.byteLength(note), 0),
    first_step: events[0]!.step,
    last_step: events.at(-1)!.step,
  };
}

/** Append NDJSON metric events from a file or stdin to a run's merge-safe notes. */
async function logRun(context: CommandHandlerContext): Promise<RlCommandResult> {
  const id = requiredArgument(context, "a run id");
  const path = stringOption(context, "file", false);
  if (path === undefined && process.stdin.isTTY === true) {
    fail("pm rl run log requires --file or piped NDJSON on stdin.", "missing_metric_input");
  }
  let input: string;
  try {
    input = path !== undefined ? readFileSync(path, "utf8") : await readStdin(stdinSource.stream);
  } catch (error) {
    fail(`Metric input could not be read: ${String(error)}`, "metric_input_failed");
  }
  const events = parseNdjsonStream(input);
  if (events.length === 0) fail("Metric input contains no events.", "empty_metric_stream");
  const client = clientFor(context);
  const run = await getTypedItem(client, id, "Run");
  if (run.item.status !== "in_progress") fail(`Run ${id} is ${String(run.item.status)}; only an in-progress run accepts metrics.`, "run_not_active", EXIT_CODE.CONFLICT);
  const details = await appendRunMetrics(client, id, events);
  return { action: "rl-run-log", id: String(run.item.id), details };
}

/** Read one run and decode only pm-rl event notes into an ordered series. */
async function showRun(context: CommandHandlerContext): Promise<RlCommandResult> {
  const id = requiredArgument(context, "a run id");
  const client = clientFor(context);
  const run = await getTypedItem(client, id, "Run");
  const series = readSeries((await readCompleteNotes(client, id)).map((note) => note.text));
  return { action: "rl-run-show", id: String(run.item.id), details: { status: run.item.status, environment_id: run.item.environment, events: series.events, comments: series.comments } };
}

/** Close a run while preserving its final metric history. */
async function finishRun(context: CommandHandlerContext): Promise<RlCommandResult> {
  const id = requiredArgument(context, "a run id");
  const reason = stringOption(context, "reason")!;
  const client = clientFor(context);
  await getTypedItem(client, id, "Run");
  const series = readSeries((await readCompleteNotes(client, id)).map((note) => note.text));
  if (series.events.length === 0) {
    fail(`Run ${id} has no metric events and cannot be finished. Log the trainer's final finite measurements first.`, "run_has_no_metrics", EXIT_CODE.CONFLICT);
  }
  const actualResult = `Run closed with ${series.events.length} metric event(s) and ${series.comments} non-metric note(s).`;
  const result = await identifierClient(client).close(id, reason, {
    message: "Finish RL run",
    resolution: reason,
    expectedResult: "The run reaches a terminal state without rewriting its metric history.",
    actualResult,
  });
  return { action: "rl-run-finish", id: String(result.item.id), details: { status: result.item.status, reason, metric_events: series.events.length, comments: series.comments } };
}

/** List environments without exposing their potentially large source bodies. */
async function listEnvironments(context: CommandHandlerContext): Promise<RlCommandResult> {
  const result = await clientFor(context).list({ type: "Environment", status: "all", noTruncate: true });
  const items = result.items.map((item) => ({ id: item.id, title: item.title, version: item.fixed_version, spec_hash: item.affected_version }));
  return { action: "rl-env-list", details: { count: items.length, environments: items } };
}

/** Show one complete environment specification and its content identity. */
async function showEnvironment(context: CommandHandlerContext): Promise<RlCommandResult> {
  const id = requiredArgument(context, "an environment id");
  const result = await getTypedItem(clientFor(context), id, "Environment");
  return { action: "rl-env-show", id: String(result.item.id), details: { title: result.item.title, version: result.item.fixed_version, spec_hash: result.item.affected_version, body: result.item.body } };
}

/** Return the JSON fence stored in a domain item's body or fail closed. */
function storedJson(body: string, source: string, code: string): string {
  const fenced = jsonSpecFences(body).next().value;
  if (fenced === undefined) fail(`${source} has no JSON specification fence.`, code, EXIT_CODE.CONFLICT);
  return fenced;
}

/** Verify a benchmark remains content-addressed and its contamination graph matches its body. */
async function verifyBenchmarkIdentity(client: PmClient, benchmarkId: string): Promise<{ id: string; spec: BenchmarkSpec }> {
  const benchmark = await getTypedItem(client, benchmarkId, "Benchmark");
  const benchmarkHash = benchmark.item.affected_version;
  if (typeof benchmarkHash !== "string" || benchmarkHash.length === 0) {
    fail(`Benchmark ${benchmarkId} has no specification affected_version.`, "benchmark_missing_hash", EXIT_CODE.CONFLICT);
  }
  const spec = parseBenchmarkSpec(storedJson(String(benchmark.item.body), `Benchmark ${benchmarkId}`, "benchmark_missing_spec"), `Benchmark ${benchmarkId} specification`);
  const resolvedId = String(benchmark.item.id);
  if (hashJson(spec as unknown as JsonValue) !== benchmarkHash || !resolvedId.endsWith(benchmarkHash.slice(0, 12))) {
    fail(`Benchmark ${benchmarkId} no longer matches its content-addressed identity. Register the changed suite as a new version.`, "benchmark_was_mutated", EXIT_CODE.CONFLICT);
  }
  const edgeIds = (benchmark.item.dependencies ?? [])
    .filter((dependency) => dependency.kind === "related" && dependency.source_kind === BENCHMARK_CONTAMINATION_SOURCE)
    .map((dependency) => dependency.id)
    .sort();
  if (JSON.stringify(edgeIds) !== JSON.stringify(spec.contaminated_environments)) {
    fail(`Benchmark ${resolvedId} contamination edges do not match its immutable specification.`, "benchmark_contamination_graph_mismatch", EXIT_CODE.CONFLICT);
  }
  return { id: resolvedId, spec };
}

/** Register one immutable benchmark suite and its typed contamination edges. */
async function registerBenchmark(context: CommandHandlerContext): Promise<RlCommandResult> {
  const path = stringOption(context, "file")!;
  const suppliedText = readTextFile(path, "Benchmark file");
  const supplied = parseBenchmarkSpec(suppliedText, `Benchmark file ${path}`);
  const flagIds = (stringOption(context, "contaminated_by", false) ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter((id) => id.length > 0);
  const client = clientFor(context);
  const resolvedContamination = new Set<string>();
  for (const environmentId of [...new Set([...supplied.contaminated_environments, ...flagIds])]) {
    resolvedContamination.add((await verifyEnvironmentIdentity(client, environmentId, "benchmark contamination edges")).id);
  }
  const spec: BenchmarkSpec = { ...supplied, contaminated_environments: [...resolvedContamination].sort() };
  const specHash = hashJson(spec as unknown as JsonValue);
  const requestedId = `benchmark-${idSegment(spec.name)}-${idSegment(spec.version)}-${specHash.slice(0, 12)}`;
  try {
    const existing = await verifyBenchmarkIdentity(client, requestedId);
    return { action: "rl-benchmark-register", id: existing.id, created: false, details: { spec_hash: specHash, contaminated_environments: spec.contaminated_environments } };
  } catch (error) {
    if (!isItemNotFound(error)) throw error;
  }
  parseBenchmarkSpec(suppliedText, `Benchmark file ${path}`, "write");
  await ensurePersistentTypes(client);
  const result = await identifierClient(client).create({
    id: requestedId,
    title: `${spec.name} ${spec.version}`,
    type: "Benchmark",
    status: "open",
    acceptanceCriteria: "The complete suite, scoring rule, pass criteria, direction, and contamination edges match its content identity.",
    estimatedMinutes: "1",
    body: `# ${spec.name} ${spec.version}\n\n\`\`\`json\n${encodeBoundedJson(spec, undefined, 2)}\n\`\`\``,
    dep: spec.contaminated_environments.map((id) => `id=${id},kind=related,source_kind=${BENCHMARK_CONTAMINATION_SOURCE}`),
    affectedVersion: specHash,
    fixedVersion: spec.version,
    component: spec.direction,
    message: "Register immutable RL benchmark specification",
  });
  return { action: "rl-benchmark-register", id: result.item.id, created: true, details: { spec_hash: specHash, contaminated_environments: spec.contaminated_environments } };
}

/** Record one immutable checkpoint evaluation with complete run and benchmark provenance. */
async function recordEvalResult(context: CommandHandlerContext): Promise<RlCommandResult> {
  const runId = stringOption(context, "run")!;
  const benchmarkId = stringOption(context, "benchmark")!;
  const rawCheckpoint = stringOption(context, "checkpoint")!;
  const checkpoint = rawCheckpoint.trim();
  const score = Number(stringOption(context, "score")!);
  if (!Number.isFinite(score)) fail("pm rl eval record requires a finite --score.", "invalid_eval_result_score");
  const passedRaw = context.options.passed;
  const passed = typeof passedRaw === "boolean" ? passedRaw : passedRaw === "true" ? true : passedRaw === "false" ? false : undefined;
  if (passed === undefined) fail("pm rl eval record requires --passed true or --passed false.", "invalid_eval_result_passed");
  const client = clientFor(context);
  const run = await getTypedItem(client, runId, "Run");
  const resolvedRunId = String(run.item.id);
  const environmentId = normalizeRunEnvironment(run.item.environment);
  if (typeof environmentId !== "string" || environmentId.length === 0) {
    fail(`Run ${resolvedRunId} records no environment and cannot produce an attributable evaluation.`, "run_environment_unrecorded", EXIT_CODE.CONFLICT);
  }
  const environment = await verifyEnvironmentIdentity(client, environmentId, "evaluations");
  const benchmark = await verifyBenchmarkIdentity(client, benchmarkId);
  const spec: EvalResultSpec = {
    checkpoint,
    score,
    passed,
    run_id: resolvedRunId,
    benchmark_id: benchmark.id,
    environment_id: environment.id,
    environment_spec_hash: hashJson(environment.spec),
    reward_spec_hash: hashJson(environment.spec.reward_specification),
  };
  const resultHash = hashJson(spec as unknown as JsonValue);
  const requestedId = `eval-${idSegment(benchmark.spec.name)}-${resultHash.slice(0, 12)}`;
  const existingEval = await matchingImmutableRecord(client, requestedId, "EvalResult", "EvalResult", "eval_result_identity_collision", resultHash, (body) =>
    parseEvalResultSpec(storedJson(body, `EvalResult ${requestedId}`, "eval_result_missing_spec"), `EvalResult ${requestedId} specification`) as unknown as JsonValue,
  );
  if (existingEval !== undefined) {
    return { action: "rl-eval-record", id: String(existingEval.item.id), created: false, details: spec as unknown as Readonly<Record<string, unknown>> };
  }
  identifier(rawCheckpoint, "artifact");
  await ensurePersistentTypes(client);
  const result = await identifierClient(client).create({
    id: requestedId,
    title: `${benchmark.spec.name} ${benchmark.spec.version}: ${checkpoint}`,
    type: "EvalResult",
    status: "closed",
    closeReason: "Immutable evaluation verdict recorded",
    completedAt: new Date().toISOString(),
    acceptanceCriteria: "The verdict traces through typed graph edges to one source run, benchmark, environment, reward specification, and checkpoint.",
    estimatedMinutes: "1",
    body: `# Evaluation ${checkpoint}\n\n\`\`\`json\n${encodeBoundedJson(spec, undefined, 2)}\n\`\`\``,
    dep: [
      `id=${resolvedRunId},kind=discovered_from,source_kind=${EVAL_RUN_SOURCE}`,
      `id=${benchmark.id},kind=verifies,source_kind=${EVAL_BENCHMARK_SOURCE}`,
    ],
    environment: environment.id,
    affectedVersion: resultHash,
    fixedVersion: checkpoint,
    component: benchmark.id,
    resolution: passed ? "passed" : "failed",
    expectedResult: "The checkpoint is evaluated under the benchmark's immutable scoring and pass contracts.",
    actualResult: `${score} (${passed ? "passed" : "failed"})`,
    message: "Record immutable RL evaluation result",
  });
  return { action: "rl-eval-record", id: result.item.id, created: true, details: spec as unknown as Readonly<Record<string, unknown>> };
}

/** Build one benchmark leaderboard only after certifying graph-derived comparability. */
async function showLeaderboard(context: CommandHandlerContext): Promise<RlCommandResult> {
  const requestedBenchmarkId = requiredArgument(context, "a benchmark id");
  const client = clientFor(context);
  await ensurePersistentTypes(client);
  const benchmark = await verifyBenchmarkIdentity(client, requestedBenchmarkId);
  const inventory = await identifierClient(client).listAllComplete({ includeBody: true });
  const byId = new Map(inventory.items.map((item) => [item.id, item]));
  const environmentCache = new Map<string, Awaited<ReturnType<typeof verifyEnvironmentIdentity>>>();
  const candidates: LeaderboardCandidate[] = [];
  for (const item of inventory.items) {
    if (item.type !== "EvalResult") continue;
    // Parsed before the benchmark filter because benchmark_id lives only in
    // the immutable body. A typed component pre-filter would let drift hide a
    // row, so a malformed record refuses the corpus and names both records.
    const spec = parseEvalResultSpec(
      storedJson(String(item.body), `EvalResult ${item.id} (read while ranking ${benchmark.id})`, "eval_result_missing_spec"),
      `EvalResult ${item.id} specification (read while ranking ${benchmark.id})`,
    );
    if (spec.benchmark_id !== benchmark.id) continue;
    const resultHash = hashJson(spec as unknown as JsonValue);
    if (item.affected_version !== resultHash || !item.id.endsWith(resultHash.slice(0, 12))) {
      fail(`EvalResult ${item.id} no longer matches its content-addressed provenance.`, "eval_result_was_mutated", EXIT_CODE.CONFLICT);
    }
    const typedEdges = (item.dependencies ?? [])
      .filter((dependency) => dependency.source_kind === EVAL_RUN_SOURCE || dependency.source_kind === EVAL_BENCHMARK_SOURCE)
      .map((dependency) => `${dependency.id}\0${dependency.kind}\0${dependency.source_kind}`)
      .sort();
    const expectedEdges = [
      `${spec.run_id}\0discovered_from\0${EVAL_RUN_SOURCE}`,
      `${benchmark.id}\0verifies\0${EVAL_BENCHMARK_SOURCE}`,
    ].sort();
    if (JSON.stringify(typedEdges) !== JSON.stringify(expectedEdges)) {
      fail(`EvalResult ${item.id} typed provenance edges do not exactly identify run ${spec.run_id} and benchmark ${benchmark.id}.`, "eval_result_graph_mismatch", EXIT_CODE.CONFLICT);
    }
    const run = byId.get(spec.run_id);
    if (run?.type !== "Run") {
      fail(`EvalResult ${item.id} source run ${spec.run_id} is missing or is not a Run.`, "eval_result_graph_mismatch", EXIT_CODE.CONFLICT);
    }
    const runEnvironment = normalizeRunEnvironment(run.environment);
    if (runEnvironment !== spec.environment_id || !run.dependencies?.some((dependency) => dependency.id === spec.environment_id)) {
      fail(`EvalResult ${item.id} environment ${spec.environment_id} does not match source run ${spec.run_id}.`, "eval_result_graph_mismatch", EXIT_CODE.CONFLICT);
    }
    let environment = environmentCache.get(spec.environment_id);
    if (environment === undefined) {
      environment = await verifyEnvironmentIdentity(client, spec.environment_id, "leaderboard rows");
      environmentCache.set(spec.environment_id, environment);
    }
    if (hashJson(environment.spec) !== spec.environment_spec_hash || hashJson(environment.spec.reward_specification) !== spec.reward_spec_hash) {
      fail(`EvalResult ${item.id} environment or reward-spec provenance no longer matches ${spec.environment_id}.`, "eval_result_provenance_mismatch", EXIT_CODE.CONFLICT);
    }
    if (item.environment !== spec.environment_id || item.fixed_version !== spec.checkpoint || item.component !== benchmark.id) {
      fail(`EvalResult ${item.id} typed metadata does not match its immutable provenance body.`, "eval_result_metadata_mismatch", EXIT_CODE.CONFLICT);
    }
    candidates.push({ eval_id: item.id, ...spec });
  }
  const environments = [...new Set(candidates.map((candidate) => candidate.environment_id))].sort();
  if (environments.length > 1) {
    fail(`Leaderboard refused for ${benchmark.spec.name} ${benchmark.spec.version} (${benchmark.id}): results span incompatible environment versions ${environments.join(", ")}. Rank one environment version at a time.`, "environment_version_mismatch", EXIT_CODE.CONFLICT);
  }
  const contaminated = environments.filter((environmentId) => benchmark.spec.contaminated_environments.includes(environmentId));
  if (contaminated.length > 0) {
    fail(`Leaderboard refused for contaminated benchmark suite ${benchmark.spec.name} ${benchmark.spec.version} (${benchmark.id}): evaluation tasks overlap training environment ${contaminated.join(", ")}.`, "benchmark_contaminated", EXIT_CODE.CONFLICT);
  }
  const rows = rankLeaderboard(benchmark.spec.direction, candidates);
  const details: Record<string, unknown> = {
    benchmark_id: benchmark.id,
    benchmark_name: benchmark.spec.name,
    benchmark_version: benchmark.spec.version,
    direction: benchmark.spec.direction,
    environment_id: environments[0] ?? null,
    count: rows.length,
    rows,
    complete_list: inventory.complete_list,
  };
  if (context.global.json === true) {
    return { action: "rl-leaderboard", id: benchmark.id, details: { format: "json", ...details } };
  }
  return { action: "rl-leaderboard", id: benchmark.id, details: { format: "table", output: renderLeaderboard(benchmark.id, benchmark.spec, rows), ...details } };
}

/**
 * Return the existing immutable record when it still matches its content identity.
 *
 * Three commands (eval results, gate episodes, merge outcomes) share one
 * idempotency contract: derive the id from the content hash; if a record already
 * exists there, its stored body must re-hash to the same identity, otherwise a
 * squatter is carrying different provenance under this record's name and the
 * collision is refused. A genuinely absent record returns undefined and the
 * caller proceeds to create.
 *
 * @param client - Client bound to the target workspace.
 * @param requestedId - Content-derived item id.
 * @param itemType - The record's item type.
 * @param label - Human-readable noun used in the collision refusal.
 * @param collisionCode - Typed refusal code for the identity collision.
 * @param specHash - Content identity the stored record must still match.
 * @param rehydrate - Parses the stored body fence back into the record's spec.
 * @returns The existing verified item, or undefined when none exists.
 */
async function matchingImmutableRecord(client: PmClient, requestedId: string, itemType: "EvalResult" | "GateEpisode" | "MergeOutcome", label: string, collisionCode: string, specHash: string, rehydrate: (body: string) => JsonValue): Promise<GetResult | undefined> {
  try {
    const existing = await getTypedItem(client, requestedId, itemType);
    const existingSpec = rehydrate(String(existing.item.body));
    if (existing.item.affected_version !== specHash || hashJson(existingSpec) !== specHash) {
      fail(`${label} id ${requestedId} already exists with different provenance.`, collisionCode, EXIT_CODE.CONFLICT);
    }
    return existing;
  } catch (error) {
    if (isItemNotFound(error)) return undefined;
    throw error;
  }
}

/**
 * Read an Environment item and demand its two provenance preconditions.
 *
 * Both the generic and the gate-simulator verification paths depend on the same
 * two conditions before a body can even be checked: a recorded
 * `affected_version` naming what the specification hashed to, and a readable
 * JSON specification fence in the body. The conditions and their refusal codes
 * are written once here so the two verifiers cannot drift on them.
 *
 * @param client - Client bound to the workspace holding the environment.
 * @param environmentId - Environment item id to read.
 * @param dependents - Plural noun naming what the caller is attributing, used
 *   only in the missing-hash message (e.g. `runs`, `gate episodes`).
 * @returns The resolved id, the recorded hash, and the fence's JSON text.
 */
async function verifiedEnvironmentFence(client: PmClient, environmentId: string, dependents: string): Promise<{ id: string; specHash: string; json: string }> {
  const environment = await getTypedItem(client, environmentId, "Environment");
  const specHash = environment.item.affected_version;
  if (typeof specHash !== "string" || specHash.length === 0) {
    fail(`Environment ${environmentId} has no specification affected_version and cannot support attributable ${dependents}.`, "environment_missing_hash", EXIT_CODE.CONFLICT);
  }
  const fenced = jsonSpecFences(String(environment.item.body)).next().value;
  if (fenced === undefined) {
    fail(`Environment ${environmentId} has no JSON specification fence.`, "environment_missing_spec", EXIT_CODE.CONFLICT);
  }
  return { id: String(environment.item.id), specHash, json: fenced };
}

/**
 * Re-verify a gate-simulator Environment still matches its content identity.
 *
 * Gate environments are ordinary content-addressed Environment items whose
 * specification is parsed by {@link parseGateEnvironmentSpec} instead of the
 * generic environment parser. The verification discipline is deliberately the
 * same as {@link verifyEnvironmentIdentity}: a recorded `affected_version`, a
 * readable specification fence, a re-hash that still agrees, and an item id
 * carrying the hash prefix — so an edited gate set cannot silently re-judge
 * candidates under rules it no longer matches.
 *
 * @param client - Client bound to the workspace holding the environment.
 * @param environmentId - Environment item id to re-verify.
 * @returns The resolved id and the re-parsed gate specification.
 * @throws When the environment lacks a hash or fence, or no longer matches its
 *   content-addressed identity.
 */
async function verifyGateEnvironmentIdentity(client: PmClient, environmentId: string): Promise<{ id: string; spec: GateEnvironmentSpec }> {
  const verified = await verifiedEnvironmentFence(client, environmentId, "gate episodes");
  const storedSpec = parseGateEnvironmentSpec(verified.json, `Gate environment ${environmentId} specification`);
  if (hashJson(storedSpec as unknown as JsonValue) !== verified.specHash || !verified.id.endsWith(verified.specHash.slice(0, 12))) {
    fail(`Environment ${environmentId} no longer matches its content-addressed identity. Register the changed gate set as a new version.`, "environment_was_mutated", EXIT_CODE.CONFLICT);
  }
  return { id: verified.id, spec: storedSpec };
}

/** Register one immutable gate-simulator environment by content identity. */
async function registerGateEnvironment(context: CommandHandlerContext): Promise<RlCommandResult> {
  const path = stringOption(context, "file")!;
  const spec = parseGateEnvironmentSpec(readTextFile(path, "Gate environment file"), `Gate environment file ${path}`);
  const specHash = hashJson(spec as unknown as JsonValue);
  const requestedId = `env-${idSegment(spec.name)}-${idSegment(spec.version)}-${specHash.slice(0, 12)}`;
  const client = clientFor(context);
  await ensurePersistentTypes(client);
  return registerImmutableEnvironment(client, requestedId, specHash, "rl-episode-env-register", () => ({
    id: requestedId,
    title: `${spec.name} ${spec.version} gates at ${spec.commit.slice(0, 12)}`,
    type: "Environment",
    status: "open",
    acceptanceCriteria: "The pinned repository commit, mandatory gate set and verdict extraction match the environment's content identity.",
    estimatedMinutes: "1",
    body: `# ${spec.name} ${spec.version} gates\n\n\`\`\`json\n${encodeBoundedJson(spec, undefined, 2)}\n\`\`\``,
    affectedVersion: specHash,
    fixedVersion: spec.version,
    message: "Register immutable gate-simulator environment",
  }), { spec_hash: specHash });
}

/**
 * Record one sandbox episode: the judged candidate artifact, its gate results
 * and extracted verdict, and its stable pull-request link.
 *
 * The episode stores a content-addressed identity for the candidate tree — the
 * resulting git tree id, or the SHA-256 of the patch producing it — because the
 * base commit alone identifies only the tree the action started from. Both the
 * pull-request link and any patch content are refused when they capture
 * repository credentials: episodes are committed, merged fleet data.
 */
async function recordEpisode(context: CommandHandlerContext): Promise<RlCommandResult> {
  const environmentId = stringOption(context, "environment")!;
  const baseCommit = stringOption(context, "base_commit")!;
  const pullRequest = stringOption(context, "pull_request")!;
  const resultsPath = stringOption(context, "gates_results")!;
  const candidateTree = stringOption(context, "candidate_tree", false);
  const patchPath = stringOption(context, "patch_file", false);
  let patchHash: string | null = null;
  if (patchPath !== undefined) {
    const patchText = readTextFile(patchPath, "Candidate patch");
    assertNoCredentials("The candidate patch", patchText);
    patchHash = createHash("sha256").update(patchText).digest("hex");
  }
  if (candidateTree === undefined && patchHash === null) {
    fail("pm rl episode record requires --candidate-tree or --patch-file: the base commit alone identifies only the tree the action started from, not the artifact that was judged.", "candidate_tree_unrecorded", EXIT_CODE.CONFLICT);
  }
  assertNoCredentials("The pull request link", pullRequest);
  const client = clientFor(context);
  await ensurePersistentTypes(client);
  const verified = await verifyGateEnvironmentIdentity(client, environmentId);
  const resultsText = readTextFile(resultsPath, "Gate results");
  const gateResults = parseGateResults(resultsText, `Gate results ${resultsPath}`, verified.spec);
  const verdict = deriveVerdict(gateResults);
  const spec: EpisodeSpec = {
    environment_id: verified.id,
    environment_spec_hash: hashJson(verified.spec as unknown as JsonValue),
    repository: verified.spec.repository,
    base_commit: baseCommit,
    candidate_tree: candidateTree ?? null,
    patch_hash: patchHash,
    gate_results: gateResults,
    verdict,
    pull_request: pullRequest,
  };
  const specHash = hashJson(spec as unknown as JsonValue);
  const requestedId = `episode-${specHash.slice(0, 12)}`;
  const existingEpisode = await matchingImmutableRecord(client, requestedId, "GateEpisode", "Episode", "episode_identity_collision", specHash, (body) =>
    parseEpisodeSpec(storedJson(body, `Episode ${requestedId}`, "episode_missing_spec"), `Episode ${requestedId} specification`) as unknown as JsonValue,
  );
  if (existingEpisode !== undefined) {
    return { action: "rl-episode-record", id: String(existingEpisode.item.id), created: false, details: episodeDetails(spec, verified.id) };
  }
  const result = await identifierClient(client).create({
    id: requestedId,
    title: `Gates ${verified.spec.name} ${verified.spec.version}: ${(candidateTree ?? patchHash!)!.slice(0, 16)}`,
    type: "GateEpisode",
    status: "closed",
    closeReason: "Immutable gate-simulator episode recorded",
    completedAt: new Date().toISOString(),
    acceptanceCriteria: "The episode traces to its exact candidate artifact, gate environment, gate results, extracted verdict, and pull request.",
    estimatedMinutes: "1",
    body: `# Episode ${requestedId}\n\n\`\`\`json\n${encodeBoundedJson(spec, undefined, 2)}\n\`\`\``,
    dep: [`id=${verified.id},kind=related,source_kind=${EPISODE_ENVIRONMENT_SOURCE}`],
    environment: verified.id,
    affectedVersion: specHash,
    fixedVersion: baseCommit,
    component: verified.spec.repository,
    resolution: verdict,
    expectedResult: "The gate results decide the verdict under the environment's pinned extraction.",
    actualResult: verdict,
    message: "Record immutable gate-simulator episode",
  });
  return { action: "rl-episode-record", id: result.item.id, created: true, details: episodeDetails(spec, verified.id) };
}

/** Build the bounded details block shared by both episode-record outcomes. */
function episodeDetails(spec: EpisodeSpec, environmentId: string): Readonly<Record<string, unknown>> {
  return {
    environment_id: environmentId,
    candidate_tree: spec.candidate_tree,
    patch_hash: spec.patch_hash,
    base_commit: spec.base_commit,
    verdict: spec.verdict,
    pull_request: spec.pull_request,
    spec_hash: hashJson(spec as unknown as JsonValue),
  };
}

/**
 * Replay one episode against a re-resolved candidate artifact and fresh gate
 * results, refusing anything that no longer reproduces.
 *
 * The artifact is resolved FIRST: replay must judge the exact tree or patch the
 * episode recorded, not one it merely hopes is the same. Only then is the
 * verdict re-derived from the fresh results under the environment's pinned
 * extraction; a different verdict is refused, naming every gate whose outcome
 * moved. Replay is a pure read: it never mutates the episode.
 */
async function replayEpisode(context: CommandHandlerContext): Promise<RlCommandResult> {
  const id = requiredArgument(context, "an episode id");
  const suppliedTree = stringOption(context, "candidate_tree", false);
  const patchPath = stringOption(context, "patch_file", false);
  const resultsPath = stringOption(context, "gates_results")!;
  const client = clientFor(context);
  await ensurePersistentTypes(client);
  const episode = await getTypedItem(client, id, "GateEpisode");
  const resolvedId = String(episode.item.id);
  const spec = parseEpisodeSpec(
    storedJson(String(episode.item.body), `Episode ${resolvedId}`, "episode_missing_spec"),
    `Episode ${resolvedId} specification`,
  );
  if (spec.candidate_tree === null && spec.patch_hash === null) {
    fail(`Episode ${resolvedId} records no candidate-tree identity and no patch hash, so replay cannot resolve what was judged. Re-record the episode with --candidate-tree or --patch-file.`, "candidate_tree_unrecorded", EXIT_CODE.CONFLICT);
  }
  let suppliedPatchHash: string | null = null;
  if (patchPath !== undefined) {
    suppliedPatchHash = createHash("sha256").update(readTextFile(patchPath, "Candidate patch")).digest("hex");
  }
  if (suppliedTree === undefined && suppliedPatchHash === null) {
    fail(`Replay of episode ${resolvedId} requires --candidate-tree or --patch-file to resolve the exact artifact that was judged.`, "candidate_tree_unresolved", EXIT_CODE.CONFLICT);
  }
  if (suppliedTree !== undefined && (spec.candidate_tree === null || suppliedTree !== spec.candidate_tree)) {
    fail(`Replay refused: episode ${resolvedId} judged candidate tree ${String(spec.candidate_tree)}, not "${suppliedTree}". Replay resolves the exact recorded artifact.`, "candidate_tree_mismatch", EXIT_CODE.CONFLICT);
  }
  if (suppliedPatchHash !== null && (spec.patch_hash === null || suppliedPatchHash !== spec.patch_hash)) {
    fail(`Replay refused: episode ${resolvedId} judged the patch hashed ${String(spec.patch_hash)}, not "${suppliedPatchHash}". Replay resolves the exact recorded artifact.`, "candidate_patch_mismatch", EXIT_CODE.CONFLICT);
  }
  const verified = await verifyGateEnvironmentIdentity(client, spec.environment_id);
  const freshResults = parseGateResults(readTextFile(resultsPath, "Gate results"), `Gate results ${resultsPath}`, verified.spec);
  const freshVerdict = deriveVerdict(freshResults);
  if (freshVerdict !== spec.verdict) {
    const moved = spec.gate_results.filter((entry) => {
      const now = freshResults.find((fresh) => fresh.name === entry.name);
      return now === undefined || now.exit_code !== entry.exit_code;
    }).map((entry) => `${entry.name} (${entry.exit_code} -> ${freshResults.find((fresh) => fresh.name === entry.name)?.exit_code})`);
    fail(`Replay refused: episode ${resolvedId} recorded verdict "${spec.verdict}" but the fresh gate results derive "${freshVerdict}". Gates that moved: ${moved.join(", ")}.`, "verdict_changed", EXIT_CODE.CONFLICT);
  }
  return {
    action: "rl-episode-replay",
    id: resolvedId,
    details: {
      reproduced: true,
      verdict: freshVerdict,
      candidate_tree: spec.candidate_tree,
      patch_hash: spec.patch_hash,
      pull_request: spec.pull_request,
    },
  };
}

/** Record one real-side merge outcome for a pull request. */
async function recordOutcome(context: CommandHandlerContext): Promise<RlCommandResult> {
  const pullRequest = stringOption(context, "pull_request")!;
  const mergedRaw = context.options.merged;
  const merged = typeof mergedRaw === "boolean" ? mergedRaw : mergedRaw === "true" ? true : mergedRaw === "false" ? false : undefined;
  if (merged === undefined) fail("pm rl outcome record requires --merged true or --merged false.", "invalid_outcome_merged");
  assertNoCredentials("The pull request link", pullRequest);
  const spec = { pull_request: pullRequest, merged };
  const specHash = hashJson(spec as unknown as JsonValue);
  const requestedId = `outcome-${specHash.slice(0, 12)}`;
  const client = clientFor(context);
  await ensurePersistentTypes(client);
  const existingOutcome = await matchingImmutableRecord(client, requestedId, "MergeOutcome", "MergeOutcome", "outcome_identity_collision", specHash, (body) =>
    parseOutcomeSpec(storedJson(body, `MergeOutcome ${requestedId}`, "outcome_missing_spec"), `MergeOutcome ${requestedId} specification`) as unknown as JsonValue,
  );
  if (existingOutcome !== undefined) {
    return { action: "rl-outcome-record", id: String(existingOutcome.item.id), created: false, details: spec as unknown as Readonly<Record<string, unknown>> };
  }
  const result = await identifierClient(client).create({
    id: requestedId,
    title: `Merge outcome: ${pullRequest}`,
    type: "MergeOutcome",
    status: "closed",
    closeReason: "Immutable merge outcome recorded",
    completedAt: new Date().toISOString(),
    acceptanceCriteria: "The outcome names one pull request and whether it merged, content-addressed by both.",
    estimatedMinutes: "1",
    body: `# Outcome ${requestedId}\n\n\`\`\`json\n${encodeBoundedJson(spec, undefined, 2)}\n\`\`\``,
    affectedVersion: specHash,
    fixedVersion: pullRequest,
    component: merged ? "merged" : "not_merged",
    resolution: merged ? "merged" : "not_merged",
    message: "Record real-side merge outcome",
  });
  return { action: "rl-outcome-record", id: result.item.id, created: true, details: spec as unknown as Readonly<Record<string, unknown>> };
}

/**
 * Report the sim-to-real gap over the paired cohort.
 *
 * Reads every recorded episode and outcome from the complete corpus, pairs them
 * by pull-request link, and reports the sandbox gate-pass rate against the real
 * merge rate with both denominators stated. Candidates on only one side are
 * reported separately as coverage. Unreadable records refuse the report rather
 * than silently shrinking the cohort, and two outcomes that disagree about one
 * pull request make the merge rate undecidable and are refused.
 */
async function simRealGap(context: CommandHandlerContext): Promise<RlCommandResult> {
  const client = clientFor(context);
  await ensurePersistentTypes(client);
  const episodes: Array<{ id: string; spec: EpisodeSpec }> = [];
  for (const item of (await identifierClient(client).list({ type: "GateEpisode", status: "all", noTruncate: true, fields: "id,body" })).items) {
    // A listed item the SDK types without an id carries no identity to report
    // or pair, so it contributes no row rather than failing the corpus.
    if (item.id === undefined) continue;
    let text: string;
    try {
      text = storedJson(String(item.body), `Episode ${item.id}`, "episode_missing_spec");
    } catch {
      fail(`Episode ${item.id} has no readable specification fence and cannot enter the sim-to-real cohort.`, "episode_unreadable", EXIT_CODE.CONFLICT);
    }
    episodes.push({ id: item.id, spec: parseEpisodeSpec(text, `Episode ${item.id} specification`) });
  }
  const outcomes: Array<{ id: string; spec: { pull_request: string; merged: boolean } }> = [];
  for (const item of (await identifierClient(client).list({ type: "MergeOutcome", status: "all", noTruncate: true, fields: "id,body" })).items) {
    if (item.id === undefined) continue;
    let text: string;
    try {
      text = storedJson(String(item.body), `MergeOutcome ${item.id}`, "outcome_missing_spec");
    } catch {
      fail(`MergeOutcome ${item.id} has no readable specification fence and cannot enter the sim-to-real cohort.`, "outcome_unreadable", EXIT_CODE.CONFLICT);
    }
    outcomes.push({ id: item.id, spec: parseOutcomeSpec(text, `MergeOutcome ${item.id} specification`) });
  }
  const report = buildSimRealGap(episodes, outcomes);
  const details: Record<string, unknown> = {
    paired: report.paired,
    unpaired_episodes: report.unpaired_episodes,
    unpaired_outcomes: report.unpaired_outcomes,
  };
  if (context.global.json === true) {
    return { action: "rl-simreal-gap", details: { format: "json", ...details } };
  }
  return { action: "rl-simreal-gap", details: { format: "table", output: renderSimRealGap(report), ...details } };
}

/** Extract and parse a generation spec from an item body's JSON fence. */
export function extractGenerationSpec(body: string, source: string): GenerationSpec {
  const fenced = jsonSpecFences(body).next().value;
  if (fenced === undefined) {
    fail(`${source} has no JSON specification fence.`, "generation_missing_spec", EXIT_CODE.CONFLICT);
  }
  return parseGenerationSpec(fenced, source);
}

/**
 * Re-verify an Environment still matches its content-addressed identity.
 *
 * Both the run and the generation paths depend on the same four conditions: a
 * recorded `affected_version`, a readable specification fence, a re-hash that
 * still agrees, and an item id that carries the hash prefix. The
 * `specHash.slice(0, 12)` identity rule in particular must never diverge
 * between the two, so it is written once here rather than duplicated per
 * caller with only the noun in the message changed.
 *
 * @param client - Client bound to the workspace holding the environment.
 * @param environmentId - Environment item id to re-verify.
 * @param dependents - Plural noun naming what the caller is attributing, used
 *   only in the missing-hash message (e.g. `runs`, `generations`).
 * @returns The resolved id and the re-parsed specification.
 * @throws When the environment lacks a hash or fence, or no longer matches its
 *   content-addressed identity.
 */
async function verifyEnvironmentIdentity(client: PmClient, environmentId: string, dependents: string): Promise<{ id: string; spec: EnvironmentSpec }> {
  const verified = await verifiedEnvironmentFence(client, environmentId, dependents);
  const storedSpec = parseEnvironmentSpec(verified.json, `Environment ${environmentId} specification`);
  if (hashJson(storedSpec) !== verified.specHash || !verified.id.endsWith(verified.specHash.slice(0, 12))) {
    fail(`Environment ${environmentId} no longer matches its content-addressed identity. Register the changed specification as a new version.`, "environment_was_mutated", EXIT_CODE.CONFLICT);
  }
  return { id: verified.id, spec: storedSpec };
}

/** Verify an environment is content-addressed and return its id and reward-spec hash. */
async function verifyEnvironmentForGeneration(client: PmClient, envId: string): Promise<{ id: string; rewardSpecHash: string }> {
  const verified = await verifyEnvironmentIdentity(client, envId, "generations");
  return { id: verified.id, rewardSpecHash: hashJson(verified.spec.reward_specification) };
}

/**
 * Return the reason an environment a generation recorded is no longer valid, or
 * null when it is still content-addressed.
 *
 * Replacing the prior boolean with a reason string lets the lineage view report
 * DISTINCT diagnoses instead of one fixed "environment was edited" for every
 * failure. An environment that never resolves (absent, wrong type, or any read
 * failure) is reported as absent, not as edited — an operator who sees "edited"
 * for an environment that was never touched receives a wrong diagnosis of a
 * provenance failure. The four conditions a generation's environment can be in
 * each carry their own wording:
 *
 * - the item does not resolve (absent, wrong type, or any read failure) →
 *   `environment could not be resolved`;
 * - it resolves but carries no recorded specification identity
 *   (`affected_version`) → `environment has no recorded specification identity`;
 * - it has an identity but its JSON fence is absent or does not parse →
 *   `environment specification is unreadable`;
 * - the stored body no longer hashes to the recorded identity → `environment was edited`.
 *
 * An empty `envId` (the seed records none) returns null: the seed has no
 * environment to invalidate, which is distinct from an environment that is
 * present but invalid.
 *
 * @param client - The tracker client used to resolve the environment item.
 * @param envId - Content-addressed Environment item id, or `""` for the seed.
 * @returns The invalidation reason, or null when the environment is still valid.
 */
export async function environmentInvalidationReason(client: PmClient, envId: string): Promise<string | null> {
  if (envId.length === 0) return null;
  try {
    const environment = await getTypedItem(client, envId, "Environment");
    const specHash = environment.item.affected_version;
    if (typeof specHash !== "string" || specHash.length === 0) {
      return "environment has no recorded specification identity";
    }
    const fenced = jsonSpecFences(String(environment.item.body)).next().value;
    const envJson = fenced;
    if (envJson === undefined) return "environment specification is unreadable";
    // Parsed inside its own try so an invalid fence is reported as unreadable
    // rather than falling through to the outer catch, which reports the
    // environment as unresolvable. Those say different things to an operator:
    // unresolvable reads as the item being absent, when in fact it exists and
    // its body cannot be parsed. Only the resolution itself belongs to the
    // outer catch.
    let storedSpec: EnvironmentSpec;
    try {
      storedSpec = parseEnvironmentSpec(envJson, `Environment ${envId}`);
    } catch {
      return "environment specification is unreadable";
    }
    return hashJson(storedSpec) !== specHash ? "environment was edited" : null;
  } catch {
    return "environment could not be resolved";
  }
}

/** Validate the SDK-read Environment reference without trimming an identifier in package code. */
function normalizeRunEnvironment(value: string | undefined): string | undefined {
  return typeof value === "string" ? value.trim() : value;
}

/**
 * Build the ancestry from a head generation back to the seed, resolving the
 * environment each collection run used.
 *
 * Unreadable provenance is treated differently by caller: a PROMOTION decided on
 * a degraded graph is refused, while a lineage VIEW stays tolerant because a
 * degraded view is still useful. When `strict` is true, a collection run that
 * does not resolve (it is absent, the wrong type, or otherwise unreadable) is a
 * hard refusal — the contamination check cannot decide overlap for a run whose
 * environment is unknown, and treating it as clean inverts the contract. The
 * refusal names the run id and the generation that declared it. When `strict`
 * is false the prior tolerant behaviour is kept: a missing run contributes no
 * environment to the contamination check, so a lineage still renders.
 *
 * @param client - The tracker client used to resolve items.
 * @param headId - The head generation id to walk back from.
 * @param strict - When true, an unresolvable collection run fails the call.
 * @returns The ancestry from the head back to the seed.
 */
async function buildAncestry(client: PmClient, headId: string, strict: boolean): Promise<AncestryEntry[]> {
  const prefix = String((await identifierClient(client).config("project", "get", "id_prefix")).nested_setting!.value);
  const ancestry: AncestryEntry[] = [];
  const visited = new Set<string>();
  let currentId: string | null = canonicalizeIdentifier(headId, prefix);
  while (currentId !== null) {
    if (visited.has(currentId)) {
      // A repeat means the parent chain loops, so the walk can never reach a
      // seed. Truncating silently is safe for the VIEW, which stays tolerant of
      // degraded provenance, but not for the strict path: findContaminationPath
      // compares only the generations this walk returned, so an environment
      // reachable only past the repeat point is never compared and a
      // contaminated candidate passes a gate that reported nothing wrong. Two
      // hand-authored generation bodies are enough to construct the cycle, and
      // hand-authored bodies are the reachable path for every other refusal in
      // this module.
      if (strict) {
        fail(`Promotion refused: generation ${currentId} appears twice in its own parent chain, so the ancestry cannot be walked back to a seed and the contamination graph is incomplete.`, "lineage_cycle", EXIT_CODE.CONFLICT);
      }
      break;
    }
    visited.add(currentId);
    // An unreadable ancestor truncates the TOLERANT walk the same way a cycle
    // does: the view stays useful with a degraded chain, and only the strict
    // promotion gate may refuse on it. The strict path re-throws so the
    // promotion refusal message is unchanged.
    //
    // `getTypedItem` is INSIDE the try, not just the body parse. An ancestry
    // can be unreadable two ways — a parent id that resolves to a missing item
    // or to something that is not a Generation, and a parent that resolves
    // fine but carries no usable JSON fence. Only the second was tolerated
    // before, so a chain pointing at a deleted parent still threw out of the
    // tolerant walk and took the readable descendants with it.
    let spec: GenerationSpec;
    try {
      const item = await getTypedItem(client, currentId, "Generation");
      spec = canonicalizeGenerationSpec(extractGenerationSpec(String(item.item.body), `Generation ${currentId}`), prefix);
    } catch (error) {
      if (strict) throw error;
      break;
    }
    const runEnvironments = new Map<string, string>();
    for (const runId of spec.collection_runs) {
      let run: GetResult;
      try {
        run = await getTypedItem(client, runId, "Run");
      } catch (error) {
        rethrowOperationalRead(error);
        if (strict) {
          fail(`Promotion refused: collection run ${runId} of generation ${currentId} could not be resolved, so the contamination graph is unreadable. ${String(error)}`, "provenance_unreadable", EXIT_CODE.CONFLICT);
        }
        // A missing run contributes no environment to the contamination check.
        continue;
      }
      // Deliberately outside the try: `fail` throws, and inside the block above
      // its own catch would swallow it and re-report the unresolvable-run reason
      // for a run that resolved perfectly well.
      // Defence in depth, not a fix for a reachable bypass. The pm SDK already
      // normalizes typed item fields: a Run whose `.toon` literally stores
      // `environment: "  env-padded  "` reads back as `env-padded`, verified
      // directly. So a padded run identity cannot reach findContaminationPath
      // today, and the strict-equality comparison there is safe.
      //
      // The trim stays anyway because this feeds a SECURITY gate and the
      // normalization it relies on belongs to another package. The dependency
      // is pinned by a test asserting the SDK boundary trims, so if that ever
      // stops being true this package finds out from its own suite rather than
      // from a contaminated promotion passing.
      //
      // Note the asymmetry with `collection_runs`: those live inside the JSON
      // fence, which pm treats as opaque body text and does NOT normalize, so
      // padding there IS reachable and is trimmed at the parse boundary.
      const environment = normalizeRunEnvironment(run.item.environment);
      if (typeof environment === "string" && environment.length > 0) {
        runEnvironments.set(runId, canonicalizeIdentifier(environment, prefix));
        continue;
      }
      if (strict) {
        // A run that resolves but records no environment is as undecidable as one
        // that does not resolve: findContaminationPath would read `undefined`,
        // compare it against the held-out environment, and treat the run as clean.
        fail(`Promotion refused: collection run ${runId} of generation ${currentId} records no environment, so the contamination graph is unreadable.`, "provenance_unreadable", EXIT_CODE.CONFLICT);
      }
    }
    ancestry.push({ id: currentId, spec, runEnvironments });
    currentId = spec.parent;
  }
  return ancestry;
}

/**
 * List promoted generation identities that recorded a given approval item as their
 * authorization.
 *
 * Promotion and reservation accounting cannot establish the approved budget
 * while any Generation is uncountable. A Generation whose body has
 * no JSON fence or whose spec fails to parse is therefore refused rather than
 * skipped: treating unreadable provenance as absent provenance inverts the
 * contract, since the budget exists to bound a recursive loop that promotes
 * programmatically. The refusal names the offending generation id and why.
 *
 * A listed item the SDK types without an `id` cannot be fetched and is skipped,
 * not refused: it carries no identity to report and no consumer can act on it.
 *
 * @param client - Client bound to the workspace holding the generations.
 * @param approvalId - Approval Decision item whose consumed budget is counted.
 * @returns Canonical ids of generations promoted under this approval, without exposing their bodies.
 * @throws When any generation's specification cannot be read or parsed.
 */
export async function promotedGenerationIdsUnderApproval(client: PmClient, approvalId: string): Promise<readonly string[]> {
  // Generation bodies come back with the listing. Callers hold the writer lock;
  // resolve each distinct recorded approval spelling once, caching its canonical
  // identity rather than fetching an approval for every historical generation.
  const canonical = (await readApprovalSpec(client, approvalId)).id;
  const identities = new Map<string, string>([[canonical, canonical], [approvalId, canonical]]);
  const result = await identifierClient(client).list({ type: "Generation", status: "all", noTruncate: true, fields: "id,body" });
  const promoted: string[] = [];
  for (const item of result.items) {
    // The SDK types a listed item's `id` as optional; a record without one
    // carries no identity to report, so it is skipped rather than counted.
    if (item.id === undefined) continue;
    const fenced = jsonSpecFences(String(item.body)).next().value;
    const json = fenced;
    if (json === undefined) {
      fail(`Promotion refused: generation ${item.id} has no JSON specification fence, so the approved budget cannot be established.`, "budget_undecidable", EXIT_CODE.CONFLICT);
    }
    let spec: GenerationSpec;
    try {
      spec = parseGenerationSpec(json, `Generation ${item.id}`);
    } catch (error) {
      fail(`Promotion refused: generation ${item.id} has an unparseable specification (${String(error)}), so the approved budget cannot be established.`, "budget_undecidable", EXIT_CODE.CONFLICT);
    }
    if (spec.promoted && spec.approval !== null) {
      let identity = identities.get(spec.approval);
      if (identity === undefined) {
        try { identity = (await readApprovalSpec(client, spec.approval)).id; }
        catch (error) { rethrowOperationalRead(error); fail(`Promotion refused: generation ${item.id} has an unreadable approval (${String(error)}), so the approved budget cannot be established.`, "budget_undecidable", EXIT_CODE.CONFLICT); }
        identities.set(spec.approval, identity);
      }
      if (identity === canonical) promoted.push(item.id);
    }
  }
  return promoted;
}


/** Find generation item ids that are not a parent of any other generation. */
async function findGenerationHeads(client: PmClient): Promise<string[]> {
  const prefix = String((await identifierClient(client).config("project", "get", "id_prefix")).nested_setting!.value);
  const result = await identifierClient(client).list({ type: "Generation", status: "all", noTruncate: true, fields: "id,body" });
  const parentIds = new Set<string>();
  const allIds: string[] = [];
  for (const item of result.items) {
    // A listed item's `id` is optional in the SDK types; one without an id can
    // be neither a head nor a parent, so it takes no part in the lineage graph.
    if (item.id === undefined) continue;
    // The SPECIFICATION parent is the lineage edge. `item.parent` is the pm
    // dependency field and the two can disagree, which would report a
    // generation as a head at the same time as it appears inside another
    // generation's ancestry. Reading the spec keeps one source for both.
    //
    // Enumeration stays TOLERANT of an unreadable body, unlike the promotion
    // path: `rl lineage` with no head argument comes through here, so refusing
    // would let one malformed Generation anywhere in the workspace break the
    // view for every ancestry, including clean ones. An unreadable generation
    // contributes no parent edge and remains eligible to be its own head.
    let parent: string | null = null;
    try {
      parent = extractGenerationSpec(String(item.body), `Generation ${item.id}`).parent;
    } catch {
      // Skipped BEFORE it joins the id list: a generation whose ancestry cannot
      // be walked must not be enumerated as a head either, or the command fails
      // on the very row that could not be read.
      continue;
    }
    allIds.push(item.id);
    if (typeof parent === "string" && parent.length > 0) parentIds.add(canonicalizeIdentifier(parent, prefix));
  }
  return allIds.filter((id) => !parentIds.has(id)).sort();
}

/**
 * Parse the gap-window option, requiring at least two consecutive gaps.
 *
 * A widening trend needs at least two points to compare, so a window below 2
 * is refused rather than reported as widening for any single promotion.
 */
function parseGapWindow(raw: string): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 2) {
    fail(`pm rl lineage --gap-window must be an integer of at least 2, got "${raw}".`, "invalid_gap_window");
  }
  return value;
}

/**
 * Register one policy generation (seed or candidate) with its full provenance.
 *
 * A seed may optionally declare a `--policy` (the content-addressed identity of
 * the policy that collected its data); a seed without one records an empty
 * policy, and a candidate parented to such a seed skips the run-policy check,
 * because there is no declared policy to violate. A seed that DOES declare a
 * policy still enforces the check, so a run collected by a different policy is
 * refused (`run_policy_mismatch`). Every candidate requires its own `--policy`.
 */
async function registerGeneration(context: CommandHandlerContext): Promise<RlCommandResult> {
  const requestedId = requiredArgument(context, "a generation id");
  const baseCheckpoint = stringOption(context, "base_checkpoint")!;
  // Preserve raw references until the SDK resolves them; only a new declaration
  // applies write policy after an existing immutable registration is ruled out.
  const parentInput = stringOption(context, "parent", false);
  const isSeed = parentInput === undefined;
  const configPath = stringOption(context, "config_file", false);
  const config = configPath === undefined ? {} : readJsonFile(configPath, "Generation configuration");
  const client = clientFor(context);
  return registerGenerationCore(client, {
    id: requestedId,
    baseCheckpoint,
    parent: isSeed ? null : parentInput,
    policy: isSeed ? (stringOption(context, "policy", false) ?? "") : stringOption(context, "policy")!,
    collectionRuns: isSeed ? [] : stringOption(context, "collection_runs")!.split(","),
    environment: isSeed ? undefined : stringOption(context, "environment")!,
    config,
  });
}

/** The resolved provenance of one generation registration, shared by the command and the recursive loop. */
interface GenerationRegistrationRequest {
  /** Requested generation item id. */
  readonly id: string;
  /** Content-addressed base checkpoint identity the generation started from. */
  readonly baseCheckpoint: string;
  /** Parent generation id; null for the seed generation. */
  readonly parent: string | null;
  /** Policy that collected the training data; empty only for a policyless seed. */
  readonly policy: string;
  /** Collection run item ids; empty for the seed generation. */
  readonly collectionRuns: readonly string[];
  /** Environment item id the collection runs used; undefined for the seed generation. */
  readonly environment: string | undefined;
  /** Training configuration recorded in the generation's body. */
  readonly config: JsonValue;
  /** Sealed evaluation outcome is separate from the training provenance identity. */
  readonly evaluation?: { readonly decision: "promote" | "refuse"; readonly reason_digest: string };
}

/**
 * Register one policy generation with its full provenance and typed edges.
 *
 * The write-boundary invariants live here once: a candidate's parent must be
 * promoted (or the seed), each collection run must have been collected by the
 * parent's declared policy under the declared environment, and the spec is
 * hashed over provenance only so promotion can record its outcome without
 * breaking the stored identity. The recursive loop registers its seed and
 * every candidate through this path, so a loop-generated generation carries
 * exactly the provenance discipline a manual one does.
 *
 * @param client - Client bound to the target workspace.
 * @param request - The resolved generation provenance.
 * @returns The command result naming the created generation and its identities.
 * @internal
 */
export async function registerGenerationCore(client: PmClient, request: GenerationRegistrationRequest): Promise<RlCommandResult> {
  operationIdentifier(request.id);
  const baseCheckpoint = request.baseCheckpoint.trim();
  const prefix = String((await identifierClient(client).config("project", "get", "id_prefix")).nested_setting!.value);
  const requestedId = canonicalizeIdentifier(request.id, prefix);
  const parentInput = request.parent === null ? null : canonicalizeIdentifier(request.parent, prefix);
  const config = request.config;
  const isSeed = parentInput === null;
  let policy = "";
  let collectionRuns: string[] = [];
  let environmentId = "";
  let rewardSpecVersion = "";
  let deps: string[] = [];
  if (isSeed) {
    // A seed may declare the policy that collected its data; without one the
    // recorded policy is empty and candidates parented to it skip the check.
    policy = request.policy.trim();
  } else {
    const parent = await getTypedItem(client, parentInput!, "Generation");
    const parentSpec = extractGenerationSpec(String(parent.item.body), `Parent generation ${parentInput}`);
    if (!parentSpec.promoted && !parentSpec.seed) {
      fail(`Parent generation ${parentInput} is not promoted. Only a promoted generation (or the seed) may parent a candidate.`, "parent_not_promoted", EXIT_CODE.CONFLICT);
    }
    policy = request.policy.trim();
    collectionRuns = [...new Set(request.collectionRuns.map((id) => canonicalizeIdentifier(id, prefix)))].sort();
    if (collectionRuns.length === 0) {
      fail("pm rl generation register requires --collection-runs for a non-seed generation.", "missing_collection_runs");
    }
    // Resolve the declared environment BEFORE iterating collection runs so each
    // run's recorded environment can be compared against the resolved identity.
    // A generation that declares --environment env-a while its runs used env-b
    // would store env-a in `environment_version` but the contamination walk
    // reads the run's own environment, so the gate and the provenance field
    // would disagree — the same class of silent drift the identity checks exist
    // to prevent.
    const envResult = await verifyEnvironmentForGeneration(client, request.environment!);
    environmentId = envResult.id;
    rewardSpecVersion = envResult.rewardSpecHash;
    for (const runId of collectionRuns) {
      const run = await getTypedItem(client, runId, "Run");
      if (parentSpec.policy.length > 0 && String(run.item.component) !== parentSpec.policy) {
        fail(`Collection run ${runId} references policy ${String(run.item.component)}, not the parent generation's policy ${parentSpec.policy}.`, "run_policy_mismatch", EXIT_CODE.CONFLICT);
      }
      const runEnv = normalizeRunEnvironment(run.item.environment);
      if (String(runEnv) !== environmentId) {
        fail(`Collection run ${runId} records environment ${String(runEnv)}, not the declared environment ${environmentId}.`, "run_environment_mismatch", EXIT_CODE.CONFLICT);
      }
    }
    deps = [environmentId, ...collectionRuns];
  }
  const reservation = await readEvaluationPlan(client, requestedId);
  const spec: GenerationSpec = {
    ...(reservation === null ? {} : { evaluation_plan: reservation.comparison }),
    ...(request.evaluation === undefined ? {} : { policy_evaluation: request.evaluation }),
    base_checkpoint: baseCheckpoint,
    policy,
    collection_runs: collectionRuns,
    training_config: config,
    environment_version: environmentId,
    reward_spec_version: rewardSpecVersion,
    parent: isSeed ? null : parentInput,
    seed: isSeed,
    promoted: false,
    approval: null,
    proxy_score: null,
    held_out_score: null,
    gap: null,
    promotion_evidence: null,
  };
  // Hashed over the PROVENANCE only, deliberately excluding the promotion
  // outcome fields. Promotion legitimately rewrites `promoted`, `approval`,
  // both scores, `gap` and `promotion_evidence`; hashing the whole spec would
  // make `affected_version` disagree with the stored body the moment a
  // generation is promoted, so any integrity check applying the
  // re-hash-and-compare rule that `verifyEnvironmentIdentity` applies to
  // Environments would report every promoted generation as mutated.
  //
  // The provenance is what the identity is for: what the generation was trained
  // from. The outcome is what it earned, and it is recorded separately in the
  // body. So the field pins provenance and stays verifiable across a promotion.
  const specHash = hashJson(generationProvenance(spec));
  const createOptions = {
    id: requestedId,
    title: requestedId,
    type: "Generation" as const,
    status: "open" as const,
    acceptanceCriteria: "The generation retains its exact provenance identities and is promoted only after contamination and budget checks pass.",
    estimatedMinutes: "1",
    body: `# ${requestedId}\n\n\`\`\`json\n${encodeBoundedJson(spec, undefined, 2)}\n\`\`\``,
    affectedVersion: specHash,
    fixedVersion: baseCheckpoint,
    component: policy.length > 0 ? policy : baseCheckpoint,
    message: isSeed ? "Register seed RL generation" : "Register candidate RL generation",
    ...(isSeed ? {} : { parent: parentInput, dep: deps, environment: environmentId }),
  };
  const result = await createOrReadIdentical(client, createOptions, "generation_identity_collision", (item) =>
    item.affected_version === specHash && hashJson(generationProvenance(extractGenerationSpec(String(item.body), `Generation ${requestedId}`))) === specHash,
    async () => {
      identifier(request.id);
      if (request.parent !== null) operationIdentifier(request.parent, "item", "write");
      if (request.environment !== undefined) operationIdentifier(request.environment, "item", "write");
      request.collectionRuns.forEach((id) => operationIdentifier(id, "item", "write"));
      identifier(request.baseCheckpoint, "artifact");
      if (request.policy !== "") identifier(request.policy, "artifact");
      await validatePolicyCardWrite(client, createOptions);
      await ensurePersistentTypes(client);
    },
  );
  await recordPolicyCard(client, String(result.item.id));
  return {
    action: "rl-generation-register",
    id: result.item.id,
    created: result.created,
    details: {
      seed: isSeed,
      parent: isSeed ? null : parentInput,
      spec_hash: specHash,
      base_checkpoint: baseCheckpoint,
      policy,
      collection_runs: collectionRuns,
      environment: environmentId,
      reward_spec_version: rewardSpecVersion,
      edge_types: [...GENERATION_EDGE_TYPES],
    },
  };
}

/**
 * Read and validate one approval Decision's permitted promotion count.
 *
 * One implementation serves the pre-lock fast refusal, the in-lock decision,
 * and the loop's fail-fast start check, so the three cannot drift apart. The
 * budget a promotion is checked against must come from a read taken INSIDE the
 * lock: an approval whose permitted count is lowered while this caller waits
 * would otherwise be compared against the capacity it had before, and the
 * promotion would exceed the approval that actually governs it.
 *
 * @param client - Client bound to the target workspace.
 * @param approvalId - The approval Decision item id.
 * @returns The parsed approval specification and its canonical SDK identity.
 */
export async function readApprovalSpec(client: PmClient, approvalId: string): Promise<ApprovalSpec & { id: string; snapshot: GetResult }> {
  // Capacity is authorization, not statistical evidence. The locked budget
  // decision uses this SDK snapshot explicitly as a write precondition.
  const approval = await promotionEvidence.exit(() => readCompleteLoopItem(client, approvalId));
  if (promotionEvidence.getStore()?.client === client) observePromotionEvidence(approval.item.id, undefined, approval.item, undefined, true);
  if (String(approval.item.type) !== "Decision") {
    fail(`pm rl expected a Decision ${approvalId} as the approval item, not ${String(approval.item.type)}.`, "wrong_approval_type", EXIT_CODE.CONFLICT);
  }
  const approvalFenced = jsonSpecFences(String(approval.item.body)).next().value;
  if (approvalFenced === undefined) {
    fail(`Approval item ${approvalId} has no JSON specification fence.`, "approval_missing_spec", EXIT_CODE.CONFLICT);
  }
  const id = approval.item.id;
  return { ...parseApprovalSpec(approvalFenced, `Approval ${approvalId}`), id, snapshot: approval };
}

/** Promote a candidate generation after contamination and budget checks pass. */
async function promoteGeneration(context: CommandHandlerContext): Promise<RlCommandResult> {
  const requestedId = requiredArgument(context, "a generation id");
  // Already trimmed: `stringOption` returns `value.trim()`. The normalization
  // that matters for the budget is at the PARSE boundary, because a generation
  // body can be authored without ever passing through this flag.
  const requestedApproval = stringOption(context, "approval")!;
  const scoresPath = stringOption(context, "scores")!;
  const evidence = stringOption(context, "evidence")!;
  const client = clientFor(context);
  const prefix = String((await identifierClient(client).config("project", "get", "id_prefix")).nested_setting!.value);
  const id = canonicalizeIdentifier(requestedId, prefix);
  const approvalId = canonicalizeIdentifier(requestedApproval, prefix);
  const generation = await getTypedItem(client, id, "Generation");
  const spec = extractGenerationSpec(String(generation.item.body), `Generation ${id}`);
  if (spec.seed) {
    fail(`The seed generation ${id} is registered, not promoted. Promote a candidate generation instead.`, "seed_not_promoted", EXIT_CODE.CONFLICT);
  }
  const scoresRaw = readJsonFile(scoresPath, "Promotion scores");
  const scoresRecord = jsonObject(scoresRaw, "Promotion scores");
  const proxyScoreRaw = scoresRecord["proxy_score"];
  if (proxyScoreRaw === undefined || proxyScoreRaw === null) {
    fail("Promotion scores require a proxy_score. A generation without both a proxy and a held-out score cannot be promoted.", "missing_proxy_score");
  }
  const proxyScore = parseScoreRecord(proxyScoreRaw, "proxy_score");
  const heldOutScoreRaw = scoresRecord["held_out_score"];
  if (heldOutScoreRaw === undefined || heldOutScoreRaw === null) {
    fail("Promotion scores require a held_out_score. A generation without both a proxy and a held-out score cannot be promoted.", "missing_held_out_score");
  }
  const heldOutScore = parseScoreRecord(heldOutScoreRaw, "held_out_score");
  // The committed Generation is the durable intent/completion marker for step one.
  // An identical retry resumes publication; a different request cannot claim the old promotion.
  let outcome: PromotionOutcome;
  if (spec.promoted) outcome = await recoverManualPromotion(client, generation, approvalId, proxyScore, heldOutScore, evidence);
  else {
    try { outcome = await promoteGenerationCore(client, { pmRoot: context.pm_root, author: authorFor(context) }, id, approvalId, proxyScore, heldOutScore, evidence); await recordPolicyCard(client, id); }
    catch (error) {
      if (!isPmCliExpectedError(error) || error.context.code !== "already_promoted") throw error;
      // A matching peer can commit after our first read and fail before publication.
      // Its sealed request is authoritative; a different request still refuses.
      outcome = await recoverManualPromotion(client, await getTypedItem(client, id, "Generation"), approvalId, proxyScore, heldOutScore, evidence);
    }
  }
  return {
    action: "rl-generation-promote",
    id,
    details: {
      status: outcome.status,
      gap: outcome.gap,
      proxy_score: proxyScore.value,
      held_out_score: heldOutScore.value,
      approval: approvalId,
      budget_consumed: outcome.promotedCount + 1,
      budget_permitted: outcome.permittedPromotions,
      evidence,
      ...(outcome.evidenceDigest === undefined ? {} : { decision_evidence: outcome.evidenceDigest }),
    },
  };
}

/** Resume after the atomic promotion boundary using its sealed request, without another budget mutation. */
async function recoverManualPromotion(client: PmClient, previous: GetResult, approvalId: string, proxy: ScoreRecord, held: ScoreRecord, evidence: string): Promise<PromotionOutcome> {
  return withPromotionEvidence(client, async () => {
    const generation = await getTypedItem(client, previous.item.id, "Generation");
    const config = await identifierClient(client).config("project", "get", "id_prefix");
    const prefix = String(config.nested_setting!.value);
    const spec = canonicalizeGenerationSpec(extractGenerationSpec(String(generation.item.body), "Committed promotion"), prefix);
    if (!spec.promoted) fail("Committed promotion changed; retry from the current Generation.", "loop_write_conflict", EXIT_CODE.CONFLICT);
    requirePromotionEvidence(spec, generation.item.id);
    if (canonicalizeIdentifier(approvalId, prefix) !== canonicalizeIdentifier(spec.approval!, prefix)
      || canonicalJson(canonicalizeScoreRecord(proxy, prefix) as unknown as JsonValue) !== canonicalJson(spec.proxy_score as unknown as JsonValue)
      || canonicalJson(canonicalizeScoreRecord(held, prefix) as unknown as JsonValue) !== canonicalJson(spec.held_out_score as unknown as JsonValue)
      || evidence !== spec.promotion_evidence) {
      fail(`Generation ${generation.item.id} is already promoted by a different request.`, "already_promoted", EXIT_CODE.CONFLICT);
    }
    // Verify the current source and all citations before repairing its publication.
    await enforceEvaluationPlan(client, generation.item.id, spec.held_out_score!);
    await exportPolicyCard(client, generation.item.id);
    const approval = await readApprovalSpec(client, approvalId);
    const consumed = await promotedGenerationIdsUnderApproval(client, approval.id);
    const root = dirname(config.settings_path);
    return withLockedPromotionEvidence(client, root, await readSettings(root), null, [], "pm-rl", async () => {
      await recordPolicyCard(client, generation.item.id);
      return { status: String(generation.item.status), gap: spec.gap!, promotedCount: consumed.length - 1, permittedPromotions: approval.permitted_promotions, ...(spec.evaluation_evidence === undefined ? {} : { evidenceDigest: spec.evaluation_evidence.digest }) };
    });
  });
}

/** Refuse incomplete committed outcomes before recovery evaluates, closes or republishes them. */
function requirePromotionEvidence(spec: GenerationSpec, id: string): void {
  if (spec.approval === null || spec.proxy_score === null || spec.held_out_score === null || spec.gap === null || spec.promotion_evidence === null) {
    fail(`Promoted generation ${id} is missing its approval or scored evidence; restore its sealed promotion receipt before recovery.`, "promoted_missing_evidence", EXIT_CODE.CONFLICT);
  }
}

/** The workspace coordinates a transactional promotion needs outside the client. */
interface WorkspaceCoordinates {
  /** The tracker root the workspace transaction coordinator journals into. */
  readonly pmRoot: string;
  /** The attributable actor for the transaction journal. */
  readonly author: string;
}

/** The persisted outcome of one transactional promotion. */
interface PromotionOutcome {
  /** The promoted generation's terminal status. */
  readonly status: string;
  /** The direction-aware proxy-to-held-out gap recorded at promotion. */
  readonly gap: number;
  /** Promotions already consumed under the approval before this one. */
  readonly promotedCount: number;
  /** The approval's permitted promotion count, re-read inside the lock. */
  readonly permittedPromotions: number;
  /** Root of the persisted evaluation inputs when a plan governed this promotion. */
  readonly evidenceDigest?: string;
}

/**
 * Promote one candidate generation through the transactional, budget-checked flow. @internal
 *
 * Contamination is decided twice — once before the writer lock as a fast
 * refusal and once inside it as the authoritative verdict — and the approved
 * promotion budget is counted and consumed inside the same critical section,
 * so two concurrent promoters cannot both spend headroom they both read. The
 * recursive loop promotes through this path, so a loop-generated promotion is
 * bounded by exactly the invariants a manual one is.
 *
 * @param client - Client bound to the target workspace.
 * @param coordinates - Workspace root and author for the transaction journal.
 * @param id - The candidate generation item id.
 * @param approvalId - The approval Decision item id.
 * @param proxyScore - The parsed proxy score record.
 * @param heldOutScore - The parsed held-out score record.
 * @param evidence - Human-readable promotion evidence.
 * @param onTransition - Optional SDK transaction observer for native failure and recovery drills.
 * @returns The promotion's persisted outcome.
 */
export async function promoteGenerationCore(client: PmClient, coordinates: WorkspaceCoordinates, id: string, approvalId: string, proxyScore: ScoreRecord, heldOutScore: ScoreRecord, evidence: string, onTransition?: CommitWorkspaceTransactionOptions["onTransition"]): Promise<PromotionOutcome> {
  const { pmRoot, author } = coordinates;
  const prefix = String((await identifierClient(client).config("project", "get", "id_prefix")).nested_setting!.value);
  const evaluationEnvironment = canonicalizeScoreRecord(heldOutScore, prefix).evaluation_context;
  const ancestry = await buildAncestry(client, id, true);
  const contamination = findContaminationPath(ancestry, evaluationEnvironment);
  if (contamination !== null) {
    fail(`Promotion refused: the evaluation set is reachable from the candidate's training data over provenance edges. Path: ${renderContaminationPath(contamination)}`, "contamination_refused", EXIT_CODE.CONFLICT);
  }
  const gap = directionAwareGap(canonicalizeScoreRecord(proxyScore, prefix), canonicalizeScoreRecord(heldOutScore, prefix));
  // Called for its refusals, not its value: it rejects a non-Decision approval,
  // a missing JSON fence, and an unparseable spec BEFORE the writer lock is
  // taken, so an obviously invalid approval never queues behind a live promotion.
  // The value is deliberately discarded — every number the decision and the
  // receipt use is re-read inside the lock.
  // Count the consumed budget and write the promotion inside one workspace
  // writer lock. Two concurrent promotions would otherwise both read the same
  // count, both observe headroom, and both promote — the race a recursive loop
  // that promotes programmatically is precisely the caller to win. Serializing
  // (rather than refusing the loser outright) means the second caller re-reads
  // the count a winner just changed and gets the accurate `budget_exceeded`,
  // which is a terminal condition a loop must respect, instead of a contention
  // error it would retry forever.
  // Renders the promoted body from a spec read INSIDE the lock. Building it
  // from the pre-lock `spec` would spread a snapshot taken before any peer
  // could be excluded, so a peer edit that does not set `promoted` — a changed
  // `training_config`, a corrected `collection_runs` — survives the
  // already-promoted guard and is then overwritten by this write, discarded on
  // the SUCCESS path with no receipt. The revert path had the same defect and
  // was fixed a round earlier; this is its other half.
  let canonicalApprovalId = "";
  const renderPromotedBody = (base: GenerationSpec, evaluated?: EvaluationEvidence): string => {
    const promotedSpec: GenerationSpec = {
      ...base,
      ...(evaluated === undefined ? {} : { evaluation_evidence: evaluated }),
      promoted: true,
      approval: canonicalApprovalId,
      proxy_score: proxyScore,
      held_out_score: heldOutScore,
      gap,
      promotion_evidence: evidence,
    };
    return `# ${id}\n\n\`\`\`json\n${encodeBoundedJson(promotedSpec, undefined, 2)}\n\`\`\``;
  };
  await withPromotionEvidence(client, async () => {
    await readApprovalSpec(client, approvalId);
    await exportPolicyCard(client, id);
    const prospective = await getTypedItem(client, id, "Generation");
    canonicalApprovalId = (await readApprovalSpec(client, approvalId)).id;
    await validatePromotedPolicyCard(client, id, renderPromotedBody(extractGenerationSpec(String(prospective.item.body), "Prospective promotion")));
  }, true);
  let promotedCount = 0;
  // Neutral like its two neighbours, NOT seeded from `approvalSpec`. That is the
  // pre-lock read, and seeding it here makes this the one variable of the three
  // whose initial value is plausible rather than obviously empty. If the
  // transaction body never runs — a journal replay does not re-execute `apply` —
  // `promotedCount` and `closedStatus` stay visibly neutral while a seeded
  // budget would report a real capacity that no in-lock read ever confirmed.
  // The assignment at the budget check below is the only source for the decision
  // and for the receipt.
  let permittedPromotions = 0;
  let closedStatus = "";
  let evidenceDigest: string | undefined;
  await commitStateTransaction({
    pmRoot,
    // Unique per invocation. The transaction is used here for MUTUAL EXCLUSION,
    // not for idempotent replay, and the two must not share a key: keying on the
    // generation makes concurrent callers promoting the SAME generation look
    // like replays of one committed transaction, so the journal skips `apply`
    // and every caller reports success for a promotion only one of them
    // performed. Correctness under concurrency comes from the re-check inside
    // the lock instead.
    transactionId: `pm-rl-generation-promote-${hashJson(id).slice(0, 32)}-${randomUUID()}`,
    onTransition,
    author,
    lockWaitMs: PROMOTION_LOCK_WAIT_MS,
    steps: [{
      id: "promote-generation",
      // Only this invocation's successful atomic write can report applied. A peer's
      // promoted body must still reach the authoritative already-promoted refusal.
      inspect: async () => ({ state: closedStatus === "" ? "pending" : "applied" }),
      apply: () => withPromotionEvidence(client, async () => {
        // Re-read inside the lock. The pre-lock `already_promoted` check runs on
        // a read every concurrent caller performs before any of them holds the
        // lock, so all of them pass it and would each promote the same
        // generation. Only a re-check inside the critical section makes "a
        // generation promotes at most once" true under concurrency.
        const current = await getTypedItem(client, id, "Generation");
        const currentSpec = extractGenerationSpec(String(current.item.body), `Generation ${id}`);
        if (currentSpec.promoted) {
          fail(`Generation ${id} is already promoted.`, "already_promoted", EXIT_CODE.CONFLICT);
        }
        if (currentSpec.seed) fail("A seed generation cannot be promoted.", "seed_not_promoted", EXIT_CODE.CONFLICT);
        // Authorization has precedence over statistical evidence. This read,
        // consumed count and retained capacity all belong to this writer lock;
        // the approval snapshot remains fenced through the eventual SDK write.
        const lockedApprovalSpec = await readApprovalSpec(client, approvalId);
        canonicalApprovalId = lockedApprovalSpec.id;
        const promotedIds = await promotedGenerationIdsUnderApproval(client, canonicalApprovalId);
        promotedCount = promotedIds.length;
        const retainedHeadroom = await retainedMetaPromotionHeadroom(client, canonicalApprovalId, promotedIds, String(current.item.id));
        permittedPromotions = lockedApprovalSpec.permitted_promotions;
        if (promotedCount + retainedHeadroom >= permittedPromotions) {
          fail(`Advancing past the approved promotion budget is refused. ${promotedCount} promotion(s) consumed; ${retainedHeadroom} promotion(s) held for meta search; approval ${approvalId} permits ${permittedPromotions}. Extend approval item ${approvalId} to authorize more promotions.`, "budget_exceeded", EXIT_CODE.CONFLICT);
        }
        const evaluated = await enforceEvaluationDecision(client, String(current.item.id), heldOutScore);
        evidenceDigest = evaluated?.digest;
        // THE authoritative contamination decision, taken inside the lock over
        // the ancestry the verdict actually depends on.
        //
        // Comparing only the candidate's own fields was not enough: the verdict
        // is computed by walking every ancestor and reading each one's
        // collection_runs and environment_version, so a peer editing an
        // ANCESTOR leaves the leaf identical and the verdict stale. Re-walking
        // here also subsumes the leaf comparison, because the candidate is the
        // walk's first entry.
        //
        // The pre-lock check above is kept as a fast refusal so an obviously
        // contaminated candidate never takes the lock at all; this one decides.
        // The cost is one extra ancestry walk per successful promotion, inside
        // the critical section — the price of the analysis and the write being
        // atomic, which is what makes the refusal a gate rather than a hint.
        const lockedAncestry = await buildAncestry(client, id, true);
        const lockedContamination = findContaminationPath(lockedAncestry, evaluationEnvironment);
        if (lockedContamination !== null) {
          fail(`Promotion refused: the evaluation set is reachable from the candidate's training data over provenance edges. Path: ${renderContaminationPath(lockedContamination)}`, "contamination_refused", EXIT_CODE.CONFLICT);
        }
        if ((currentSpec.policy_evaluation as Record<string, JsonValue> | undefined)?.["decision"] === "refuse") fail("Generation was refused by its evaluator.", "already_refused", EXIT_CODE.CONFLICT);
        const promotedBody = renderPromotedBody(currentSpec, evaluated);
        await validatePromotedPolicyCard(client, id, promotedBody);
        const result = await completeLoopGeneration(client, current, promotedBody, evidence,
          `Promoted with proxy=${proxyScore.value}, held_out=${heldOutScore.value}, gap=${gap.toFixed(4)}. Budget consumed: ${promotedCount + 1} of ${permittedPromotions}.`, [lockedApprovalSpec.snapshot], author);
        closedStatus = String(result.item.status);
        return { status: closedStatus };
      }),
      // One atomic item mutation is the only step: a failed apply has nothing to restore.
      compensate: async () => {},
    }],
  });
  return { status: closedStatus, gap, promotedCount, permittedPromotions, ...(evidenceDigest === undefined ? {} : { evidenceDigest }) };
}

/** One executed generation's persisted record within a loop report. */
export interface RlLoopGenerationReport {
  /** Root of the inputs sealed by this generation's promotion decision. */
  readonly decision_evidence?: string;
  /** One-based generation number. */
  readonly generation: number;
  /** The generation's collection Run item id. */
  readonly run: string;
  /** The generation's Generation item id. */
  readonly item: string;
  /** Whether this generation's candidate was promoted. */
  readonly promoted: boolean;
  /** Certified author of the committed promotion, including peer promotions. */
  readonly promoted_by?: string;
  /** The candidate's sampled held-out mean reward. */
  readonly held_out_mean: number;
  /** The candidate's content-addressed checkpoint identity. */
  readonly candidate_checkpoint: string;
  /** The refusal that terminated the loop here; null when promoted. */
  readonly refusal_reason: string | null;
}

/** The bounded terminal report of one executed recursive loop. */
export interface RlLoopReport {
  /** Content-free discovery omissions, including foreign package records. */
  readonly skipped_records?: ReturnType<typeof skippedTrackerRecords>;
  /** Optional local process jobs with settled resource and durable completion evidence. */
  readonly process_jobs?: readonly ProcessJob<TrainerPolicy>[];
  /** The exact condition that terminated the loop. */
  readonly stop_reason: "generation_limit" | "budget_exhausted" | "unchanged_checkpoint" | "gap_rejected" | "evaluation_rejected" | "promotion_refused" | "checkpoint_limit_exceeded" | "wall_limit_exceeded" | "process_failed" | "process_cancelled" | "process_invalidated";
  /** The registered environment item id every run and generation references. */
  readonly environment: string;
  /** The seed generation item id the loop parented every candidate to. */
  readonly seed_generation: string;
  /** Every executed generation, in order, promoted or refused. */
  readonly generations: readonly RlLoopGenerationReport[];
  /** Number of promotions the loop recorded. */
  readonly promoted: number;
  /** Samples actually collected before termination. */
  readonly samples_consumed: number;
  /** The loop's total sample budget. */
  readonly budget: number;
  /** The last accepted checkpoint identity: the seed's when nothing promoted. */
  readonly final_checkpoint: string;
  /** The refusal that terminated the loop; null when the generation limit was reached. */
  readonly refusal_reason: string | null;
  /** Generations this invocation verified as already persisted rather than executed. */
  readonly resumed_generations: number;
}

/** One bounded recursive loop execution request. */
export interface RlLoopRequest {
  /** Loop id prefix; child items are named `<id>-seed`, `<id>-g<n>-collect` and `<id>-g<n>`. */
  readonly id: string;
  /** The parsed loop configuration document (see {@link parseLoopProgramme}). */
  readonly config: JsonValue;
  /** The approval Decision item id stating the permitted promotion count. */
  readonly approval: string;
  /** Optional cancellation signal; aborting stops at the next phase boundary. */
  readonly signal?: AbortSignal;
  /** Explicit operator recovery of an ambiguous lease; matching live holders still refuse. */
  readonly forceTakeover?: boolean;
  /** Inject OS birth-time reads for controller identity failure drills. @internal */
  readonly processIdentityIO?: LoopProcessIdentityIO;
  /** Trusted SDK launcher argv; never sourced from PM text or exposed as a CLI command flag. */
  readonly processTrainerArgv?: readonly string[];
  /** Observe request, received receipt and committed PM event boundaries for interruption drills. */
  readonly onDecision?: (stage: "request" | "response" | "commit", metric: string, step: number) => void | Promise<void>;
  /** Observe completed phase boundaries for telemetry and interruption drills. */
  readonly onPhase?: (phase: "collect" | "train" | "evaluate" | "promote", generation: number) => void | Promise<void>;
}

/** One generation's reconstructed persisted phase, as `pm rl loop status` reports it. */
export interface RlLoopGenerationStatus {
  /** One-based generation number. */
  readonly generation: number;
  /** The generation's collection Run item id, or null before the run was created. */
  readonly run: string | null;
  /** The generation's Generation item id, or null before the candidate was registered. */
  readonly item: string | null;
  /** The generation's persisted phase on the planned-to-terminal path. */
  readonly phase: "collecting" | "collected" | "promoted" | "refused" | "promotion_pending";
  /** Certified author when the authoritative generation is promoted. */
  readonly promoted_by?: string;
  /** Whether this generation's candidate was promoted. */
  readonly promoted: boolean;
  /** The candidate's sampled held-out mean, or null before evaluation evidence existed. */
  readonly held_out_mean: number | null;
  /** The candidate's content-addressed checkpoint identity, or null before registration. */
  readonly candidate_checkpoint: string | null;
  /** The refusal that terminated the loop at this generation; null otherwise. */
  readonly refusal_reason: string | null;
}

/** The read-only reconstruction `pm rl loop status` returns for one loop. */
export interface RlLoopStatusReport {
  /** Retained local process lifecycle and resource outcomes, including failed jobs. */
  readonly process_jobs?: readonly ProcessJob<TrainerPolicy>[];
  /** The loop id prefix the report was reconstructed for. */
  readonly id: string;
  /** The trainer adapter the persisted programme executes. */
  readonly trainer: "bandit" | "systemone" | "lm";
  /** Content identity of the whole persisted programme. */
  readonly programme: string;
  /** The registered environment item id every run and generation references. */
  readonly environment: string;
  /** The seed generation item id every candidate is parented to. */
  readonly seed_generation: string;
  /** Every persisted generation in order, including the partially collected one. */
  readonly generations: readonly RlLoopGenerationStatus[];
  /** Number of promotions the loop has recorded. */
  readonly promoted: number;
  /** Decision or collection samples the loop has already spent. */
  readonly samples_consumed: number;
  /** The loop's total sample budget. */
  readonly budget: number;
  /** The last accepted checkpoint identity: the seed's when nothing promoted. */
  readonly final_checkpoint: string;
  /** The exact terminal condition already reached, or null while the loop can continue. */
  readonly stop_reason: RlLoopReport["stop_reason"] | null;
  /** The refusal that terminated the loop; null while it can continue. */
  readonly refusal_reason: string | null;
  /** The next generation a controller would execute, or null when terminal. */
  readonly next_generation: number | null;
}

/** The controller lease acquired around one whole loop execution. */
interface ControllerLease {
  /** Attributable writer used by guarded item transactions. */
  readonly author: string;
  /** Releases the workspace lock; safe to call exactly once. */
  readonly release: () => Promise<void>;
  /** Serialize effects with takeover and reject a displaced controller. */
  readonly guard: <T>(operation: () => Promise<T>, cleanup?: boolean) => Promise<T>;
  /** The seed item id whose claim records durable controller ownership. */
  readonly seedId: string;
  /** The verified birth time captured before acquiring this controller's locks. */
  readonly processStartTime: string;
}

/** Controller lease lifetime, renewed while holding the SDK phase mutex. */
export const LOOP_LEASE_TTL_SECONDS = 60;

/** Exit status a cancelled loop reports, matching the conventional signal exit status. */
export const LOOP_CANCELLED_EXIT_CODE = 130;

/** Derive the workspace lock id of one loop's controller lease. */
export function loopLeaseLockId(id: string): string {
  return `pm-rl-loop-${canonicalIdentifier(id)}`;
}

/** Read a lease; missing is null, while unreadable or malformed records remain ambiguous. */
async function readLeaseRecord(pmRoot: string, lockId: string): Promise<Record<string, unknown> | null> {
  const file = statePath(pmRoot, "locks", `${canonicalIdentifier(lockId)}.lock`);
  try {
    const parsed: unknown = parseBoundedJson(await readFile(file, "utf8"));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed as Record<string, unknown>;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? null : {};
  }
}

/** Injectable operating-system reads for portable process identity probes. @internal */
export interface LoopProcessIdentityIO {
  /** Read a system process-information file. */
  readonly read: (path: string) => string;
  /** Execute a system identity command without a shell. */
  readonly exec: (file: string, args: string[]) => string;
}

/** Native identity probes; failures are handled conservatively by the caller. @internal */
export const loopProcessIdentityIO: LoopProcessIdentityIO = {
  read: (path) => readFileSync(path, "utf8"),
  exec: (file, args) => execFileSync(file, args, { encoding: "utf8", env: { ...process.env, LC_ALL: "C", TZ: "UTC" }, stdio: ["ignore", "pipe", "ignore"] }),
};

/** Read process birth time: Linux boot epoch plus field 22 ticks, or portable OS tooling. @internal */
export function loopProcessStartTime(pid: number, platform: NodeJS.Platform = process.platform, io: LoopProcessIdentityIO = loopProcessIdentityIO): string | null {
  try {
    if (platform === "linux") {
      const stat = io.read(`/proc/${pid}/stat`);
      const ticks = Number(stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/u)[19]);
      const boot = Number(/^btime (\d+)$/mu.exec(io.read("/proc/stat"))?.[1]);
      const hz = Number(io.exec("getconf", ["CLK_TCK"]).trim());
      if (!Number.isSafeInteger(ticks) || ticks < 0 || !Number.isSafeInteger(boot) || boot <= 0 || !Number.isSafeInteger(hz) || hz <= 0) return null;
      return new Date((boot + ticks / hz) * 1000).toISOString();
    }
    const start = platform === "win32"
      ? io.exec("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().ToString('o')`]).trim()
      : io.exec("ps", ["-p", String(pid), "-o", "lstart="]).trim();
    return start.length > 0 ? start : null;
  } catch {
    return null;
  }
}

/** Classify a holder without permitting PID reuse, remote hosts or denied probes to imply life. */
function leaseHolderState(record: Record<string, unknown>, io: LoopProcessIdentityIO | undefined): "alive" | "dead" | "ambiguous" | "unverifiable" {
  const sameHost = record["hostname"] === hostname();
  if (typeof record["hostname"] === "string" && !sameHost) return "ambiguous";
  const pid = record["pid"];
  if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 0) return "ambiguous";
  try {
    process.kill(pid, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return sameHost ? "dead" : "ambiguous";
    // EPERM alone proves neither identity nor death; still try the birth-time probe.
  }
  const start = loopProcessStartTime(pid, process.platform, io);
  if (!sameHost || start === null || typeof record["process_start_time"] !== "string") return "unverifiable";
  return record["process_start_time"] === start ? "alive" : "dead";
}

/** Publish the SDK token and verified holder identity together without exposing partial JSON. */
async function publishControllerIdentity(lockPath: string, processStartTime: string, renew = false): Promise<void> {
  const acquired = parseBoundedJson(await readFile(checkedStateFile(lockPath), "utf8")) as Record<string, unknown>;
  const temporary = statePath(dirname(lockPath), `${basename(lockPath)}.${randomUUID()}.tmp`);
  let created = false;
  try {
    await writeFile(temporary, `${encodeBoundedJson({ ...acquired, ...(renew ? { created_at: new Date().toISOString() } : {}), hostname: hostname(), process_start_time: processStartTime }, MAX_JSON_BYTES - 1)}\n`, { encoding: "utf8", flag: "wx" });
    created = true;
    await rename(checkedStateFile(temporary), checkedStateFile(lockPath));
  } finally {
    if (created) await unlink(checkedStateFile(temporary)).catch(() => undefined);
  }
}

/** Read a valid SDK lease expiry without accepting malformed timestamps or durations. */
function controllerExpiry(record: Record<string, unknown>): number {
  const created = typeof record["created_at"] === "string" ? Date.parse(record["created_at"]) : NaN;
  const ttl = record["ttl_seconds"];
  return typeof ttl === "number" && Number.isFinite(ttl) && ttl > 0 ? created + ttl * 1000 : NaN;
}

/** Expire a demonstrably dead SDK phase mutex through its open inode, never overwriting a successor. */
async function expireDeadControllerMutex(root: string, id: string, io: LoopProcessIdentityIO | undefined): Promise<void> {
  const record = await readLeaseRecord(root, id);
  if (record === null) return;
  const prefix = `pm-rl-phase:${hashJson(hostname())}:`;
  // The SDK writes owner with its initial exclusive create. This identity
  // survives a kill before the richer atomic identity publication follows.
  const owner = record["owner"];
  const identity = record["hostname"] === undefined && typeof owner === "string" && owner.startsWith(prefix)
    ? { ...record, hostname: hostname(), process_start_time: Buffer.from(owner.slice(prefix.length).split(":")[0], "base64url").toString("utf8") }
    : record;
  if (leaseHolderState(identity, io) !== "dead") return;
  await expireControllerRecord(root, id, record);
}

/** Expire only the observed inode/token; the SDK removes stale locks under its native cleanup lease. */
async function expireControllerRecord(root: string, id: string, record: Record<string, unknown>): Promise<void> {
  if (typeof record["token"] !== "string") return;
  const handle = await open(statePath(root, "locks", `${operationIdentifier(id)}.lock`), fsConstants.O_RDWR | fsConstants.O_NOFOLLOW).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  });
  if (handle === null) return;
  try {
    const current = parseBoundedJson(await handle.readFile("utf8")) as Record<string, unknown>;
    if (current["token"] !== record["token"]) return;
    const expired = `${encodeBoundedJson({ ...current, created_at: "1970-01-01T00:00:00.000Z" }, MAX_JSON_BYTES - 1)}\n`;
    await handle.write(expired, 0, "utf8");
    await handle.truncate(Buffer.byteLength(expired));
  } finally {
    await handle.close();
  }
}

/** Recover only demonstrably dead process-owned SDK transaction locks, then publish the new writer's birth identity. */
export async function commitProcessTransaction(options: CommitWorkspaceTransactionOptions): Promise<void> {
  options = { ...options, transactionId: canonicalIdentifier(options.transactionId), steps: options.steps.map((step) => ({ ...step, id: canonicalIdentifier(step.id) })) };
  await expireDeadControllerMutex(options.pmRoot, "sdk-workspace-transaction", undefined);
  const start = loopProcessStartTime(process.pid);
  if (start === null) fail("Cannot establish process transaction identity.", "process_identity_unavailable");
  // The SDK creates the writer lock with the transaction author as its owner before "prepared". A phase identity
  // there lets expireDeadControllerMutex prove a holder killed in that window dead instead of blocking for the TTL.
  const author = `pm-rl-phase:${hashJson(hostname())}:${Buffer.from(start).toString("base64url")}:${options.author}`;
  await commitStateTransaction({ ...options, author, lockTtlSeconds: 1_000_000_000, onTransition: async (context) => {
    if (context.transition === "prepared") await publishControllerIdentity(statePath(options.pmRoot, "locks", "sdk-workspace-transaction.lock"), start);
    await options.onTransition?.(context);
  } });
}

/** Serialize standalone SDK adapter execution on the same owner-verified mutex used by controller phases. */
export async function withProcessJobFence<T>(coordinates: WorkspaceCoordinates, id: string, execute: () => Promise<T>, waitMs?: number): Promise<T> {
  id = canonicalIdentifier(id); statePath(coordinates.pmRoot);
  const start = loopProcessStartTime(process.pid);
  if (start === null) fail("Cannot establish trainer owner identity.", "process_identity_unavailable");
  const release = await controllerMutex(coordinates.pmRoot, id, coordinates.author, start, undefined, waitMs);
  try { return await execute(); } finally { await release(); }
}

/** Acquire the SDK phase mutex; only proven dead holders are expired for SDK cleanup. */
async function controllerMutex(root: string, id: string, author: string, start: string, io: LoopProcessIdentityIO | undefined, waitMs = 5000): Promise<() => Promise<void>> {
  id = canonicalIdentifier(id);
  await expireDeadControllerMutex(root, id, io);
  const owner = `pm-rl-phase:${hashJson(hostname())}:${Buffer.from(start).toString("base64url")}:${author}`;
  const release = await acquireStateLock(root, id, 1_000_000_000, owner, false, false, waitMs);
  try {
    await publishControllerIdentity(statePath(root, "locks", `${id}.lock`), start);
  } catch (error) {
    await release();
    throw error;
  }
  return release;
}

/** Locate ancestor Git metadata without launching Git, respecting standalone discovery ceilings. */
function controllerGitMarker(start: string, ceiling: string): string | null {
  const ceilings = ceiling.split(delimiter).filter(Boolean).map((path) => resolve(path));
  let directory = resolve(start);
  for (;;) {
    const marker = statePath(directory, ".git");
    if (existsSync(marker)) return marker;
    const parent = dirname(directory);
    if (parent === directory || ceilings.includes(parent)) return null;
    directory = parent;
  }
}

/** Detect worktree ancestry without launching Git, respecting explicit standalone discovery ceilings. @internal */
export function controllerHasGitAncestor(start: string, ceiling = process.env["GIT_CEILING_DIRECTORIES"] ?? ""): boolean {
  return controllerGitMarker(start, ceiling) !== null;
}

/** Resolve shared authority from Git's on-disk pointers even when its executable is unavailable. @internal */
export function controllerAuthorityRoot(pmRoot: string, ceiling = process.env["GIT_CEILING_DIRECTORIES"] ?? ""): string {
  const marker = controllerGitMarker(dirname(pmRoot), ceiling);
  if (marker === null) return pmRoot;
  try {
    let metadata = marker;
    if (statSync(marker).isFile()) {
      const pointer = /^gitdir: (.+)\r?\n?$/.exec(readFileSync(marker, "utf8"));
      if (pointer === null) throw new Error("invalid gitdir pointer");
      metadata = resolve(dirname(marker), pointer[1].trim());
    } else if (!existsSync(statePath(marker, "HEAD")) && !existsSync(statePath(marker, "objects")) && !existsSync(statePath(marker, "commondir"))) {
      // An empty marker is not a Git repository; standalone trackers remain usable.
      return pmRoot;
    }
    const commonFile = statePath(metadata, "commondir");
    const common = existsSync(commonFile) ? resolve(metadata, readFileSync(commonFile, "utf8").trim()) : metadata;
    if (!statSync(statePath(metadata, "HEAD")).isFile() || !statSync(statePath(common, "objects")).isDirectory()) throw new Error("incomplete Git metadata");
    return statePath(realpathSync(common), "pm-rl-controllers");
  } catch {
    fail("Cannot resolve shared controller authority from Git metadata; restore the repository metadata before retrying.", "loop_git_metadata_unavailable", EXIT_CODE.CONFLICT);
  }
}

/**
 * Acquire one loop's controller lease: the pm SDK workspace lock plus a claim.
 *
 * Single launch under contention is the contract: the workspace transaction
 * mutex (`acquireLock`, the same primitive every pm mutation serializes on)
 * fails the second controller fast, and the owner-bound claim on the loop's
 * seed item records durable, merge-safe ownership in append-only history.
 * A lock record whose same-host holder identity is demonstrably dead is
 * an abandoned lease, not a live controller: it is removed and the
 * acquisition retried once, so a crashed controller never blocks the resume
 * its own persisted state was designed for. No lock file is invented; this
 * removes the pm CLI's own lock record only after verifying its holder is
 * gone, exactly the takeover `pm claim --force` performs for claims.
 *
 * @param client - Client bound to the target workspace.
 * @param coordinates - Workspace root and author for the lease and the claim.
 * @param request - Loop identity, approval and explicit operator recovery choice.
 * @param seedId - The seed generation item id the claim is recorded on.
 * @param recovery - Supported outer command and existing audit item for a meta lease, including before its first receipt.
 * @returns The lease, which the caller must release exactly once.
 * @throws An expected `loop_controller_active` refusal when a live controller holds the lease.
 */
async function acquireControllerLease(client: PmClient, coordinates: WorkspaceCoordinates, request: RlLoopRequest, seedId: string, recovery?: { readonly command: string; readonly auditItem: string }): Promise<ControllerLease> {
  const id = canonicalIdentifier(request.id);
  // Git worktrees share the repository metadata, so the SDK's lease and
  // launch journal are shared even when the tracked PM roots diverge.
  const authorityRoot = controllerAuthorityRoot(coordinates.pmRoot);
  const lockId = loopLeaseLockId(id);
  const lockPath = statePath(authorityRoot, "locks", `${lockId}.lock`);
  const refusal = `Lease ${relative(coordinates.pmRoot, lockPath)}; operator recovery: ${recovery?.command ?? `pm rl loop resume ${id} --approval ${request.approval} --force-takeover`}.`;
  const ownStart = loopProcessStartTime(process.pid, process.platform, request.processIdentityIO);
  if (ownStart === null) {
    fail(`Loop ${id} cannot acquire a lease without a verifiable process start time. Restore OS process-start tooling or access before retrying; --force-takeover cannot bypass unavailable controller identity. ${refusal}`, "loop_identity_unavailable", EXIT_CODE.CONFLICT);
  }
  // All controller acquisitions participate in this SDK mutex. A recovery
  // cannot unlink a successor's lease between observation and acquisition.
  const releaseRecovery = await controllerMutex(authorityRoot, `${lockId}-recovery`, coordinates.author, ownStart, request.processIdentityIO, 0).catch(async (error: unknown) => {
    if (!isPmCliExpectedError(error) || error.exitCode !== EXIT_CODE.CONFLICT) throw error;
    const holder = await readLeaseRecord(authorityRoot, lockId) ?? await readLeaseRecord(authorityRoot, `${lockId}-recovery`);
    const phaseLock = relative(coordinates.pmRoot, statePath(authorityRoot, "locks", `${lockId}-recovery.lock`));
    // --force-takeover cannot clear this phase mutex, so the refusal names the manual recovery instead.
    fail(`Loop ${id} lease recovery is contended (holder ${String(holder?.["owner"])}, lease expiry ${holder === null || !Number.isFinite(controllerExpiry(holder)) ? "unknown" : new Date(controllerExpiry(holder)).toISOString()}). A controller holds the phase mutex ${phaseLock}; if its holder cannot be verified, stop that process and remove ${phaseLock} before retrying. --force-takeover does not clear the phase mutex.`, "loop_controller_active", EXIT_CODE.CONFLICT);
  });
  let release: () => Promise<void>;
  let token: unknown;
  try {
    const record = await readLeaseRecord(authorityRoot, lockId);
    if (record !== null) {
      const state = leaseHolderState(record, request.processIdentityIO);
      if ((!Number.isFinite(controllerExpiry(record)) || controllerExpiry(record) > Date.now())
        && (state === "alive" || state === "unverifiable" || (state === "ambiguous" && request.forceTakeover !== true))) {
        const expiry = Number.isFinite(controllerExpiry(record)) ? new Date(controllerExpiry(record)).toISOString() : "unknown";
        // Each holder state gets the recovery that actually works for it; only an ambiguous holder can be force-taken over.
        const recovery = state === "alive"
          ? `A live, verified controller holds lease ${relative(coordinates.pmRoot, lockPath)}; wait for its expiry (${expiry}), after which an ordinary resume takes over and fences it.`
          : state === "unverifiable"
            ? `The holder of lease ${relative(coordinates.pmRoot, lockPath)} has a live PID whose identity cannot be verified, so it cannot be force-taken over; stop or exclude the holder and restore identity probing before retrying.`
            : `The holder's identity is ambiguous. ${refusal}`;
        fail(`Loop ${id} controller holder is ${state} (holder ${String(record["owner"])}, PID ${String(record["pid"])}, lease expiry ${expiry}). ${recovery}`, "loop_controller_active", EXIT_CODE.CONFLICT);
      }
      if (request.forceTakeover === true) {
        // Host and owner digests identify the previous holder without publishing machine identity.
        await identifierClient(client).update(recovery?.auditItem ?? seedId, { comment: [`Loop ${id} forced lease takeover by ${coordinates.author}: ${JSON.stringify({
          previous_holder: { pid: typeof record["pid"] === "number" ? record["pid"] : null, process_start_time_digest: hashJson(String(record["process_start_time"])),
            hostname_digest: hashJson(String(record["hostname"])), owner_digest: hashJson(String(record["owner"])) },
          lock: relative(coordinates.pmRoot, lockPath),
        })}`] });
      }
      await expireControllerRecord(authorityRoot, lockId, record);
    }
    try {
      release = await acquireStateLock(authorityRoot, lockId, LOOP_LEASE_TTL_SECONDS, coordinates.author, false, false);
    } catch (error) {
      if (!isPmCliExpectedError(error) || error.exitCode !== EXIT_CODE.CONFLICT) throw error;
      fail(`Loop ${id} is already being executed by another controller. ${refusal}`, "loop_controller_active", EXIT_CODE.CONFLICT);
    }
    try {
      await publishControllerIdentity(lockPath, ownStart);
      token = (await readLeaseRecord(authorityRoot, lockId))?.["token"];
    } catch (error) {
      await release();
      throw error;
    }
  } finally {
    await releaseRecovery();
  }
  let activePhases = 0;
  let heartbeatFailure: PmCliExpectedError | undefined;
  /** Fence every effect and completion receipt against controller takeover. */
  const guard = async <T>(operation: () => Promise<T>, cleanup = false): Promise<T> => {
    if (!cleanup && heartbeatFailure !== undefined) throw heartbeatFailure;
    const observed = await readLeaseRecord(authorityRoot, lockId);
    // A missing or empty captured token can never fence an effect, even if the observed record is equally empty.
    if (observed === null || typeof token !== "string" || token.length === 0 || observed["token"] !== token) fail(`Loop ${id} controller lease was replaced; this controller cannot advance.`, "loop_lease_lost", EXIT_CODE.CONFLICT);
    activePhases += 1;
    let unlock: (() => Promise<void>) | undefined;
    try {
      unlock = await controllerMutex(authorityRoot, `${lockId}-recovery`, coordinates.author, ownStart, request.processIdentityIO);
      const current = await readLeaseRecord(authorityRoot, lockId);
      if (current === null || current["token"] !== token) {
        fail(`Loop ${id} controller lease was replaced; this controller cannot advance.`, "loop_lease_lost", EXIT_CODE.CONFLICT);
      }
      // The phase mutex prevents takeover throughout an effect and its receipt.
      // Renewal at entry and exit also covers long CPU phases without timer races.
      await publishControllerIdentity(lockPath, ownStart, true);
      const result = await operation();
      await publishControllerIdentity(lockPath, ownStart, true);
      return result;
    } finally {
      activePhases -= 1;
      await unlock?.();
    }
  };
  try {
    await guard(async () => {
      if (authorityRoot !== coordinates.pmRoot) {
        const authority = new PmClient({ pmRoot: authorityRoot, cwd: dirname(coordinates.pmRoot), author: coordinates.author, noExtensions: true });
        const releaseInitialization = await acquireStateLock(authorityRoot, "pm-rl-controller-init", 30, coordinates.author, false, false, 5000);
        try {
          await identifierClient(authority).init("rl-controller", { defaults: true, agentGuidance: "skip", author: "pm-rl-controller" });
        } finally {
          await releaseInitialization();
        }
        const launchId = loopLeaseLockId(id);
        const owner = hashJson(realpathSync(resolve(coordinates.pmRoot)));
        const previous = await identifierClient(authority).get(launchId).catch((error: unknown) => isItemNotFound(error) ? null : Promise.reject(error));
        if (previous === null) {
          await identifierClient(authority).create({ id: launchId, type: "Decision", title: `Loop ${id} launch authority`, body: owner });
        } else if (String(previous.item.body) !== owner) {
          const comments = await readLoopComments(client, seedId).catch((error: unknown) => isItemNotFound(error) ? [] : Promise.reject(error));
          if (!comments.some((comment) => comment.text.startsWith(`Loop ${id} terminal report:`))) {
            fail(`Loop ${id} launch authority item ${launchId} belongs to another worktree. Merge its persisted artifacts and terminal report before continuing here; after stopping all controllers and verifying those artifacts, from this tracker directory reassign authority with: pm --pm-path "${relative(coordinates.pmRoot, authorityRoot)}" update ${launchId} --body ${owner}. ${refusal}`, "loop_launch_elsewhere", EXIT_CODE.CONFLICT);
          }
        }
      }
    });
  } catch (error) {
    await release();
    throw error;
  }
  const heartbeats = new Set<Promise<void>>();
  /** Retain the first observed background failure for the controller's awaited cleanup path. */
  const heartbeatFailed = (error: unknown): void => {
    heartbeatFailure ??= isPmCliExpectedError(error) ? error : createPmCliExpectedError("Controller heartbeat failed; resume from durable state after restoring tracker access.", { exitCode: EXIT_CODE.CONFLICT, context: { code: "loop_callback_failed", required: "Restore tracker access and resume with the canonical loop id." } });
  };
  const timer = setInterval(controllerCallback("heartbeat", heartbeatFailed, async () => {
    if (activePhases === 0) {
      const pending = guard(async () => undefined).catch(heartbeatFailed); heartbeats.add(pending);
      try { await pending; } finally { heartbeats.delete(pending); }
    }
  }), LOOP_LEASE_TTL_SECONDS * 1000 / 3);
  timer.unref();
  return { release: async () => {
    clearInterval(timer); await Promise.allSettled([...heartbeats]);
    try {
      const failure = heartbeatFailure;
      if (failure !== undefined) {
        try { await guard(() => appendCommentOnce(client, recovery?.auditItem ?? seedId, `Loop ${id} terminal callback failure: ${String(failure.context.code)}; resume after restoring tracker access.`), true); }
        catch { /* Preserve the first failure when audit storage is unavailable or a peer owns the lease. */ }
      }
    } finally { await release(); }
    if (heartbeatFailure !== undefined) throw heartbeatFailure;
  }, guard, seedId, processStartTime: ownStart, author: coordinates.author };
}

/**
 * Execute one bounded recursive collect-train-evaluate-promote loop against a real tracker.
 *
 * Every generation is persisted before its verdict: a collection Run item
 * carries the batch's real per-sample metric events in merge-safe notes, and
 * a candidate Generation item carries the derived training configuration and
 * full provenance. Promotion goes through the existing transactional,
 * contamination- and budget-checked flow; a refusal — statistical,
 * structural, or from an exhausted approved promotion budget — is recorded
 * as a comment on the candidate's item, so history, not a process exit code,
 * is the audit trail. The loop never advances past its own bounds:
 * generation count, total collected samples, and the strictly-better held-out
 * gate all terminate it with a distinct recorded reason, and the next
 * generation's configuration is derived deterministically from the previous
 * evaluation results.
 *
 * The controller is durable: the whole invocation holds one controller lease,
 * and execution is a resume walk. Every phase is idempotent over persisted
 * state — completed generations are verified against their replayed receipts,
 * a partially collected batch is completed by appending only its missing
 * suffix, a registered candidate is promoted at most once through the
 * transactional gate, and terminal reports and refusal comments are appended
 * only when their exact text is not already in history. A crash at ANY phase
 * therefore never double-counts the budget, never re-promotes, and never
 * loses an artifact; re-running the same loop id completes it. A cancellation
 * signal stops at the next phase boundary and leaves the same consistent
 * state for the resume.
 *
 * @param client - Client bound to the target workspace.
 * @param coordinates - Workspace root and author for the transaction journal.
 * @param request - The loop id, configuration, approval, and optional signal.
 * @returns The bounded terminal report of the executed loop.
 * @throws An expected `loop_cancelled` error when the request's signal aborted.
 */
export async function runRlLoop(client: PmClient, coordinates: WorkspaceCoordinates, rawRequest: RlLoopRequest): Promise<RlLoopReport> {
  const request = await canonicalProgrammeRequest(client, rawRequest);
  let programme: LoopProgramme;
  try {
    let configuration = request.config;
    const supplied = jsonObject(configuration, "Loop configuration");
    if (supplied["trainer"] === "lm" && supplied["frozen_base"] === undefined) {
      const seed = await readCompleteLoopItem(client, `${request.id}-seed`).catch((error: unknown) => isItemNotFound(error) ? null : Promise.reject(error));
      if (seed !== null) {
        const persisted = jsonObject(storedLoopConfiguration(seed), "Persisted loop configuration");
        // Adopt the persisted base only when the supplied programme has the same base shape; a changed shape
        // under this loop id is a configuration conflict that registration reports, not checkpoint corruption.
        // A missing task means the documented default, exactly as parseLmLoopConfig reads it.
        const normalized: Record<string, JsonValue> = { ...supplied, task: supplied["task"] ?? "rotate" };
        const sameShape = ["task", "alphabet", "string_length", "model"].every((key) => canonicalJson(normalized[key]!) === canonicalJson(persisted[key]!));
        if (persisted["frozen_base"] !== undefined && sameShape) configuration = { ...supplied, frozen_base: persisted["frozen_base"] } as JsonValue;
      }
    }
    programme = parseLoopProgramme(configuration);
  } catch (error) {
    if (isPmCliExpectedError(error) && String(error.context.code).startsWith("lm_")) {
      const writeFailure = await appendRefusalAuditComment(client, request.approval, `Loop ${request.id} programme refused (${String(error.context.code)}): ${error.message}`);
      if (writeFailure !== undefined) attachAuditCommentError(error, writeFailure);
    }
    throw error;
  }
  // Fail fast on the approval before any collection is charged: a loop that
  // cannot promote must refuse before it spends budget, not after.
  await readApprovalSpec(client, request.approval);
  const controller = await prepareLoopController(client, coordinates, programme, request);
  let report: RlLoopReport;
  try {
    report = await executeLoopProgramme(client, coordinates, programme, request, controller);
  } catch (error) {
    if (isPmCliExpectedError(error) && /^(?:already_promoted|already_refused|lost_claim|stale_revision|loop_write_conflict|loop_lease_lost|compare_and_set_refused|generation_terminal)$/.test(String(error.context.code))) {
      // A fenced controller cannot write a terminal report, but it can report the peer's certified state.
      try { Object.assign(error.context, { authoritative_report: await rlLoopStatus(client, request.id, coordinates.pmRoot) }); }
      catch (readError) { Object.assign(error.context, { authoritative_read_error: isPmCliExpectedError(readError) ? String(readError.context.code) : "unavailable" }); }
    }
    let auditWriteFailure: string | undefined;
    if (isPmCliExpectedError(error) && String(error.context.code).startsWith("lm_")) {
      auditWriteFailure = await controller.lease.guard(() => appendRefusalAuditComment(client, controller.seedId, `Loop ${request.id} execution refused (${String(error.context.code)}): ${error.message}`)).catch((cause: unknown) => String(cause));
      if (auditWriteFailure !== undefined) attachAuditCommentError(error, auditWriteFailure);
    }
    if (request.signal?.aborted === true) {
      const cancelledFit = isPmCliExpectedError(error) && error.context.code === "process_cancelled";
      const cancellationText = cancelledFit ? `Loop ${request.id} external fit cancelled; artifacts retained and reservation settled. A new programme identity is required for another fit.`
        : `Loop ${request.id} cancellation recorded at a durable step boundary; resume continues unfinished steps.`;
      const failure = await controller.lease.guard(() => appendCommentOnce(client, controller.seedId, cancellationText)).then(() => undefined, (cause: unknown) => String(cause));
      failLoopCancelled(request.id, auditWriteFailure ?? failure, cancelledFit);
    }
    throw error;
  } finally {
    await releaseControllerLease(client, controller);
  }
  return report;
}

/**
 * The context of an expected loop error that also records a failed refusal-
 * comment write. The SDK error context is structurally open for additional
 * secret-free diagnostic fields, so this widening adds one without casting.
 */
export type RefusalAuditContext = PmCliExpectedError["context"] & { audit_comment_error?: string };

/**
 * Append the refusal audit comment without ever replacing the refusal itself.
 *
 * The comment is the loop's audit trail, but its write can fail — for example
 * when the tracker is briefly unwritable. A failure is returned as a
 * diagnostic string instead of being thrown, so the caller can attach it to
 * the original expected error and keep throwing that error unchanged.
 *
 * @param client - Client bound to the target workspace.
 * @param id - Item that should carry the refusal comment.
 * @param text - The exact refusal comment to append.
 * @returns The write failure description, or undefined when the comment was persisted.
 */
async function appendRefusalAuditComment(client: PmClient, id: string, text: string): Promise<string | undefined> {
  try {
    await identifierClient(client).comments(id, { add: text, ifAbsent: true });
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/** Attach a failed refusal-comment write to the expected error it must never replace. */
function attachAuditCommentError(error: PmCliExpectedError, writeFailure: string): void {
  const context: RefusalAuditContext = error.context;
  context.audit_comment_error = writeFailure;
}

/** Throw the mid-phase cancellation refusal, retaining a failed refusal-comment write. */
function failLoopCancelled(id: string, auditWriteFailure: string | undefined, cancelledFit = false): never {
  const cancellation = createPmCliExpectedError(
    cancelledFit ? `Loop ${id} external fit was cancelled; retained artifacts and settled resources require a new programme identity for another fit.`
      : `Loop ${id} was cancelled mid-phase; the persisted state is consistent and pm rl loop resume ${id} completes it.`,
    { exitCode: LOOP_CANCELLED_EXIT_CODE, context: { code: "loop_cancelled" } },
  );
  if (auditWriteFailure !== undefined) attachAuditCommentError(cancellation, auditWriteFailure);
  throw cancellation;
}

/** Take the controller lease before registering the environment and seed for execution. */
async function prepareLoopController(client: PmClient, coordinates: WorkspaceCoordinates, programme: LoopProgramme, request: RlLoopRequest): Promise<LoopPrepared> {
  const lease = await acquireControllerLease(client, coordinates, request, `${request.id}-seed`);
  try {
    return await lease.guard(async () => {
      await ensurePersistentTypes(client);
      const environmentSpec = programme.trainer === "bandit"
        ? loopEnvironmentSpec(programme.config)
        : programme.trainer === "systemone"
          ? systemOneEnvironmentSpec(programme.config)
          : lmEnvironmentSpec(programme.config);
      const environment = await registerEnvironmentSpecValue(client, environmentSpec);
      const environmentId = String(environment.id);
      let seedConfig = programme.trainer === "bandit"
        ? seedTrainingConfig(programme.config)
        : programme.trainer === "systemone"
          ? systemOneSeedTrainingConfig(programme.config)
          : lmSeedTrainingConfig(programme.config);
      const seedCheckpoint = programme.trainer === "bandit"
        ? banditCheckpoint(programme.config.initialWeight)
        : programme.trainer === "systemone"
          ? programme.config.initial
          : programme.config.initial;
      if (programme.trainer === "lm") {
        await persistLmCheckpoint(coordinates.pmRoot, programme.config.initial, programme.config);
      }
      const previousSeed = await readCompleteLoopItem(client, `${request.id}-seed`)
        .catch((error: unknown) => isItemNotFound(error) ? null : Promise.reject(error));
      if (previousSeed !== null) {
        const spec = extractGenerationSpec(String(previousSeed.item.body), "Loop seed");
        const stored = jsonObject(spec.training_config, "Loop seed configuration");
        if (stored["programme"] === programme.config.digest) seedConfig = spec.training_config as JsonValue;
      }
      const seedRegistration = await registerGenerationCore(client, {
        id: `${request.id}-seed`,
        baseCheckpoint: seedCheckpoint.digest,
        parent: null,
        policy: seedCheckpoint.digest,
        collectionRuns: [],
        environment: undefined,
        config: seedConfig,
      });
      // Item ids are normalized by the tracker (an id prefix may be prepended), so
      // every later reference — run creation, parent edges, comments, closes, and
      // the report — uses the id each create actually returned, never a guessed
      // shape. A parent edge written from the requested text would name nothing
      // and silently leave every generation a lineage head.
      const seedId = String(seedRegistration.id);
      // Registration is content-addressed and idempotent: re-running one loop id
      // continues its persisted programme, while a different configuration under
      // the same id fails here as an identity collision rather than quietly
      // forking the lineage.
      await identifierClient(client).claim(seedId, { force: true, message: `pm-rl loop controller lease for ${request.id}: ${JSON.stringify({ hostname_digest: hashJson(hostname()), pid: process.pid, process_start_time: lease.processStartTime })}` });
      return {
        programme,
        seedId,
        environmentId,
        seedCheckpoint,
        lease: { ...lease, seedId },
      };
    });
  } catch (error) {
    await lease.release();
    throw error;
  }
}

/** Release the controller lease: the seed claim first, then the workspace lock. */
async function releaseControllerLease(client: PmClient, prepared: LoopPrepared): Promise<void> {
  await prepared.lease.guard(() => identifierClient(client).release(prepared.lease.seedId), true).catch(() => undefined);
  await prepared.lease.release();
}

/** Everything the execution walk needs that the request alone does not carry. */
interface LoopPrepared {
  /** The validated trainer programme. */
  readonly programme: LoopProgramme;
  /** The seed generation item id every candidate is parented to. */
  readonly seedId: string;
  /** The registered environment item id every run references. */
  readonly environmentId: string;
  /** The seed's checkpoint: generation one's collecting policy. */
  readonly seedCheckpoint: BanditCheckpoint | SystemOneCheckpoint | LmCheckpoint;
  /** The controller lease held around this execution. */
  readonly lease: ControllerLease;
}

/** The walk's verdict for one generation's persisted state. */
type GenerationInspection =
  | { readonly kind: "complete"; readonly report: RlLoopGenerationReport; readonly advance: GenerationAdvance }
  | { readonly kind: "refused"; readonly receipt: BanditGeneration | SystemOneGeneration | LmGeneration; readonly report: RlLoopGenerationReport; readonly stopReason: RlLoopReport["stop_reason"]; readonly refusalReason: string }
  | { readonly kind: "budget_stop" }
  | { readonly kind: "pending"; readonly pending: GenerationPending };

/** How a verified persisted generation advances the in-memory chain. */
interface GenerationAdvance {
  /** The promoted candidate checkpoint. */
  readonly checkpoint: BanditCheckpoint | SystemOneCheckpoint | LmCheckpoint;
  /** The generation item id the next candidate parents to. */
  readonly parent: string;
  /** The successor's derived step configuration. */
  readonly step: LoopStepConfig;
  /** Samples this generation's completed collection charged. */
  readonly cost: number;
}

/** One generation the walk found incomplete, to be finished by this invocation. */
interface GenerationPending {
  /** One-based generation number. */
  readonly generation: number;
  /** Verified receipt of a candidate already registered before this invocation. */
  readonly receipt?: BanditGeneration | SystemOneGeneration | LmGeneration;
  /** The generation's collection Run item id, or null before the run was created. */
  readonly run: string | null;
  /** The generation's Generation item id when a registered candidate still awaits promotion. */
  readonly item: string | null;
  /** The recomputed bandit receipt, when the trainer is the built-in bandit. */
  readonly banditReceipt: BanditGeneration | null;
  /** The collected decisions already persisted for a decision-model generation. */
  readonly collection: readonly SystemOneObservation[];
  /** The held-out decisions already persisted for a decision-model generation. */
  readonly heldOut: readonly SystemOneObservation[];
  /** The collected completions already persisted for a language-model generation. */
  readonly lmObservations: readonly LmObservation[];
  /** The run's persisted metric events, in order, for missing-suffix completion. */
  readonly events: readonly MetricEvent[];
}

/** The mutable chain state the walk and the execution advance together. */
interface LoopChain {
  /** The current promoted checkpoint collecting the next generation. */
  current: BanditCheckpoint | SystemOneCheckpoint | LmCheckpoint;
  /** The generation item id the next candidate parents to. */
  parent: string;
  /** The next generation's derived step configuration. */
  step: LoopStepConfig;
  /** Samples charged by completed collections so far. */
  consumed: number;
  /** Executed or verified generations, in order. */
  reports: RlLoopGenerationReport[];
  /** Promotions recorded so far. */
  promotedCount: number;
  /** Generations this invocation verified as already persisted. */
  resumed: number;
}

/** The terminal condition the walk or the execution ended the loop with. */
interface LoopTerminal {
  /** The exact stop reason recorded on the seed. */
  readonly stopReason: RlLoopReport["stop_reason"];
  /** The refusal reason; null for the generation limit. */
  readonly refusalReason: string | null;
}

/** Fail with the stable cancellation refusal when the request's signal has aborted. */
function failIfLoopCancelled(signal: AbortSignal | undefined, id: string, generation: number, phase: string): void {
  if (signal?.aborted === true) {
    fail(`Loop ${id} was cancelled before generation ${generation} ${phase}; the persisted state is consistent and pm rl loop resume ${id} completes it.`, "loop_cancelled", LOOP_CANCELLED_EXIT_CODE);
  }
}

/** Bind a generation step to its programme, source checkpoint and derived configuration. */
function loopStepInput(programme: LoopProgramme, chain: LoopChain, generation: number): JsonValue {
  return { programme: programme.config.digest, generation, source: chain.current.digest, step: { ...chain.step } };
}

/** Read an immutable completed PM step receipt, refusing changed inputs or damaged payloads. */
async function readLoopStep(client: PmClient, id: string, phase: string, input: JsonValue, loaded?: GetResult | null): Promise<JsonValue | null> {
  const item = loaded === undefined ? await readCompleteLoopItem(client, `${id}-step-${phase}`).catch((error: unknown) => isItemNotFound(error) ? null : Promise.reject(error)) : loaded;
  if (item === null) return null;
  const decoded = decodeTrackerRecord(client, item.item, { type: "Decision", format: "pm-rl/loop-step/1" });
  if (decoded === null) fail("Loop step receipt is malformed or foreign; see skipped records.", "loop_step_drift", EXIT_CODE.CONFLICT);
  const record = decoded as Record<string, JsonValue>;
  if (item.item.type !== "Decision" || record["format"] !== "pm-rl/loop-step/1" || record["key"] !== `${id}-step-${phase}` || record["input"] !== hashJson(input)
    || (record["state"] !== "running" && record["state"] !== "complete")) {
    fail("Loop step receipt disagrees with its generation and programme.", "loop_step_drift", EXIT_CODE.CONFLICT);
  }
  if (record["state"] === "running") { await verifyCompletedDecisionReceipt(client, item.item.id, record, true); return null; }
  const result = record["result"];
  if (!completedDecisionReceipt(record)) throw createPmCliExpectedError(`Loop step receipt ${item.item.id} is damaged; restore its complete original payload before retrying.`, { exitCode: EXIT_CODE.CONFLICT, context: { code: "loop_step_drift", item_id: item.item.id } });
  await verifyCompletedDecisionReceipt(client, item.item.id, record);
  if (record["decision_evidence"] !== undefined) await verifyDecisionSnapshots(client, parseEvaluationEvidence(record["decision_evidence"]));
  return result!;
}

/** Execute only an unfinished generation-step key and commit its result under the controller fence. */
async function durableLoopStep(client: PmClient, lease: ControllerLease, id: string, phase: string, input: JsonValue, execute: () => Promise<JsonValue>, cards = false): Promise<{ value: JsonValue; executed: boolean }> {
  return lease.guard(async () => {
    const previous = await readLoopStep(client, id, phase, input);
    if (previous !== null) return { value: previous, executed: false };
    const key = `${id}-step-${phase}`;
    const existing = await readCompleteLoopItem(client, key).catch((error: unknown) => isItemNotFound(error) ? null : Promise.reject(error));
    const running = { format: "pm-rl/loop-step/1", key, input: hashJson(input), state: "running" };
    // Outer phase cards must fit before the first receipt/history write.
    const intent = { id: key, type: "Decision" as const, title: `Loop step ${phase} for ${id}`, tags: "rl-loop-step", body: encodeBoundedJson(running, MAX_TRACKER_RECORD_BYTES) };
    const item = existing ?? (cards || phase === "promote" ? null : await identifierClient(client).create(intent));
    const before = item === null ? null : existing ?? await readCompleteLoopItem(client, String(item.item.id));
    const winner = await readLoopStep(client, id, phase, input, before);
    if (winner !== null) return { value: winner, executed: false };
    const captured = await captureDecisionInputs(client, execute, true);
    const value = captured.value;
    const decision = captured.inputs.length === 0 ? undefined : await sealDecisionEvidence(client, hashJson(input), captured.inputs);
    const body = encodeBoundedJson({ ...running, state: "complete", result: value, digest: hashJson(value), ...(decision === undefined ? {} : { decision_evidence: decision }) }, MAX_TRACKER_RECORD_BYTES);
    if (cards) await validatePolicyCardWrite(client, { ...intent, body }, true);
    if (item === null) await identifierClient(client).create({ ...intent, body });
    else {
      await mutateLoopItem(client, before!, "Complete durable loop receipt", (document) => { document.body = body; return ["body"]; }, [], lease.author);
    }
    return { value, executed: true };
  });
}

/** Durable step executor shared by inner and outer controllers. */
export type RlDurableStep = (key: string, input: JsonValue, execute: () => Promise<JsonValue>) => Promise<JsonValue>;

/** Reuse the inner lease and fenced receipts with the real approval, supported recovery command and audited operator override. */
export async function withRlController<T>(client: PmClient, coordinates: WorkspaceCoordinates, rawRequest: Pick<RlLoopRequest, "id" | "approval" | "forceTakeover"> & { readonly recoveryCommand: string }, signal: AbortSignal, execute: (step: RlDurableStep) => Promise<T>): Promise<T> {
  const request = await canonicalProgrammeRequest(client, rawRequest);
  const { id } = request;
  const lease = await acquireControllerLease(client, coordinates, { ...request, config: null, signal }, `${id}-step-programme`, { command: request.recoveryCommand, auditItem: request.approval });
  try {
    return await execute(async (key, input, operation) => {
      key = canonicalIdentifier(key);
      signal.throwIfAborted();
      const stored = await durableLoopStep(client, lease, id, key, input, async () => await encodeCheckpointArtifacts(coordinates.pmRoot, `step:${id}:${key}`, await operation(), async (value) => {
        const receipt = { format: "pm-rl/loop-step/1", key: `${id}-step-${key}`, input: hashJson(input), state: "complete", result: value, digest: hashJson(value as JsonValue) };
        await validatePolicyCardWrite(client, { id: receipt.key, type: "Decision", body: encodeBoundedJson(receipt, MAX_TRACKER_RECORD_BYTES) }, true);
      }) as JsonValue, true);
      await recordRecursivePolicyCards(client, `${id}-step-${key}`);
      return decodeCheckpointArtifacts(coordinates.pmRoot, stored.value) as JsonValue;
    });
  } finally {
    await lease.release();
  }
}

/** Read one run's decoded metric events in order, without mutating anything. */
async function readRunMetricEvents(client: PmClient, runId: string): Promise<readonly MetricEvent[]> {
  return readSeries((await readCompleteNotes(client, runId)).map((note) => note.text)).events;
}

/** Read complete loop outcome comments; omitted history cannot establish a terminal verdict. */
async function readLoopComments(client: PmClient, id: string): Promise<LogNote[]> {
  const result = await identifierClient(client).comments(id, { outputBudget: "unbounded", outputLimit: "unbounded" });
  if ("output_budget_exceeded" in result) fail("Loop comment history was omitted.", "loop_history_incomplete", EXIT_CODE.CONFLICT);
  return result.comments;
}

/** Append one comment only when its exact text is not already in the item's history. @internal */
export async function appendCommentOnce(client: PmClient, id: string, text: string): Promise<void> {
  const comments = await readLoopComments(client, id);
  if (comments.some((comment) => comment.text === text)) return;
  await identifierClient(client).comments(id, { add: text, ifAbsent: true });
}

/** Read complete process outcomes belonging to this programme instance without exposing executable paths. */
async function loopProcessJobs(client: PmClient, id: string, programme: LoopProgramme): Promise<readonly ProcessJob<TrainerPolicy>[]> {
  if (programme.trainer === "systemone" || programme.config.process === undefined) return [];
  const jobs = (await listProcessJobs(client)).filter((job) => jsonObject(job.binding, "Process binding")["programme_id"] === id);
  return jobs.sort((left, right) => Number(jsonObject(left.binding, "Process binding")["generation"]) - Number(jsonObject(right.binding, "Process binding")["generation"]));
}

/** Render the terminal report comment text, deterministic across reruns. */
function terminalReportText(id: string, report: RlLoopReport): string {
  const { resumed_generations, ...deterministic } = report;
  return `Loop ${id} terminal report:\n${JSON.stringify(deterministic)}`;
}

/** The per-generation sample cost one programme's collection phase charges. */
function generationCost(programme: LoopProgramme): number {
  return programme.trainer === "systemone"
    ? programme.config.samplesPerGeneration + programme.config.evaluation.length
    : programme.config.samplesPerGeneration;
}

/** Read one generation's persisted Run and Generation items, either of which may be absent. */
async function findGenerationItems(client: PmClient, id: string, generation: number): Promise<{ run: GetResult | null; item: GetResult | null }> {
  const run = await readCompleteLoopItem(client, `${id}-g${generation}-collect`).then((result) => result, (error: unknown) => isItemNotFound(error) ? null : Promise.reject(error));
  const item = await readCompleteLoopItem(client, `${id}-g${generation}`).then((result) => result, (error: unknown) => isItemNotFound(error) ? null : Promise.reject(error));
  if (run === null && item !== null) fail(`Loop ${id} generation ${generation} has a candidate without its collection run.`, "loop_generation_drift", EXIT_CODE.CONFLICT);
  return { run, item };
}

/** Verify a promoted generation's recorded approval matches the approval governing this execution. */
async function verifyLoopApproval(client: PmClient, governing: string, recorded: string | null, id: string, generation: number): Promise<void> {
  if (governing.length > 0 && recorded !== null && (await readApprovalSpec(client, recorded)).id !== (await readApprovalSpec(client, governing)).id) {
    fail(`Loop ${id} generation ${generation} was promoted under approval ${recorded}, not the requested ${governing}; the promotion budget governing this loop cannot be switched mid-lineage.`, "loop_approval_mismatch", EXIT_CODE.CONFLICT);
  }
}

/** Inspect one bandit generation's persisted state against its deterministic replay. */
async function inspectBanditGeneration(client: PmClient, programme: LoopProgramme & { readonly trainer: "bandit" }, request: RlLoopRequest, chain: LoopChain, generation: number, pmRoot?: string): Promise<GenerationInspection> {
  const config = programme.config;
  const input = loopStepInput(programme, chain, generation);
  const recorded = await readLoopStep(client, `${request.id}-g${generation}`, "train", input);
  let terminalProcess = false;
  // Bandit training is deterministic: a recorded receipt must equal its replay, so tampered verdicts cannot enter recovery.
  let receipt = runLoopGeneration(config, chain.step, generation, chain.current as BanditCheckpoint, config.process === undefined ? undefined : chain.current as BanditCheckpoint);
  if (config.process !== undefined) {
    if (pmRoot === undefined) fail("Process replay requires its tracker artifact root.", "process_artifact_root_required");
    const processInput = banditProcessInput(config, chain.step, generation, receipt, request.id);
    const expectedJob = processJobId(processInput, request.processTrainerArgv, programme.config.process);
    const related = (await loopProcessJobs(client, request.id, programme)).filter((job) => Number(jsonObject(job.binding, "Process binding")["generation"]) === generation);
    if (related.length > 1 || (related.length === 1 && related[0].id !== expectedJob && request.approval.length > 0)) fail("Trainer launcher identity changed; use the original trusted launcher or a new programme id.", "process_job_drift", EXIT_CODE.CONFLICT);
    const job = related.length === 1 ? related[0] : await readProcessJob(client, expectedJob);
    if (job !== null) {
      await verifyProcessJobBudget(client, job);
      terminalProcess = ["failed", "cancelled", "invalidated"].includes(job.state) && job.completion !== null;
      const candidate = verifiedProcessPolicy(job, pmRoot, processInput, true);
      if (candidate !== null) receipt = runLoopGeneration(config, chain.step, generation, chain.current as BanditCheckpoint, candidate);
    }
  }
  if (recorded !== null && hashJson(recorded) !== hashJson(receipt as unknown as JsonValue)) {
    fail("Bandit training receipt disagrees with its deterministic replay.", "loop_step_drift", EXIT_CODE.CONFLICT);
  }
  const { run, item } = await findGenerationItems(client, request.id, generation);
  if (run !== null) await verifyLoopRun(client, programme, chain, generation, run, receipt);
  // The collection Run is created inside the collect step, so a completed collect receipt without it is lost evidence.
  if (run === null && await readLoopStep(client, `${request.id}-g${generation}`, "collect", input) !== null) {
    fail(`Loop ${request.id} generation ${generation} has a completed collection receipt but no collection Run.`, "loop_generation_drift", EXIT_CODE.CONFLICT);
  }
  if (item !== null) {
    const events = await readRunMetricEvents(client, String(run!.item.id));
    const expected = collectionMetricEvents(receipt);
    verifyEventPrefix(expected, events, request.id, generation);
    if (events.length !== expected.length) {
      fail(`Loop ${request.id} generation ${generation} registered a candidate whose collection evidence is incomplete; the persisted lineage is inconsistent.`, "loop_generation_drift", EXIT_CODE.CONFLICT);
    }
    const spec = extractGenerationSpec(String(item.item.body), `Generation ${item.item.id}`);
    const stored = parseStoredLoopGeneration(spec.training_config as JsonValue, `Loop ${request.id} generation ${generation} training configuration`);
    if (config.process !== undefined && recorded === null) fail("Process candidate has no durable trainer receipt.", "process_receipt_required");
    const verified = recorded === null ? verifyStoredLoopGeneration(config, chain.step, generation, chain.current as BanditCheckpoint, stored) : receipt;
    if (recorded !== null && canonicalJson(spec.training_config) !== canonicalJson(generationTrainingConfig(config, chain.step, generation, verified))) {
      fail("Bandit candidate disagrees with its durable training receipt.", "loop_step_drift", EXIT_CODE.CONFLICT);
    }
    const verdict = await inspectCandidateVerdict(client, programme, request, chain, generation, String(run!.item.id), item, verified,
      { generation, run: String(run!.item.id), item: String(item.item.id), receipt: verified, banditReceipt: verified, collection: [], heldOut: [], lmObservations: [], events });
    if (terminalProcess && verdict.kind !== "refused") fail("A terminal process candidate cannot advance.", "process_job_terminal", EXIT_CODE.CONFLICT);
    return verdict;
  }
  if (terminalProcess) fail("A terminal process candidate cannot advance.", "process_job_terminal", EXIT_CODE.CONFLICT);
  if (run !== null) {
    // A crash between the run's creation and the candidate's registration: the
    // batch is completed from its persisted prefix, never re-collected.
    const events = await readRunMetricEvents(client, String(run.item.id));
    const expected = collectionMetricEvents(receipt);
    verifyEventPrefix(expected, events, request.id, generation);
    return { kind: "pending", pending: { generation, run: String(run.item.id), item: null, banditReceipt: receipt,
      collection: [], heldOut: [], lmObservations: [], events } };
  }
  if (chain.consumed + generationCost(programme) > config.budget) {
    return { kind: "budget_stop" };
  }
  return { kind: "pending", pending: { generation, run: null, item: null, banditReceipt: receipt, collection: [], heldOut: [], lmObservations: [], events: [] } };
}

/**
 * Inspect one language-model generation's persisted state against its replay.
 *
 * Completed step receipts bind the collection, fit and evaluation to the
 * programme and source checkpoint. Their payload digests and the materialized
 * checkpoint are verified without repeating numerical work. Legacy generation
 * records without step receipts retain deterministic replay verification.
 *
 * @param client - Client bound to the target workspace.
 * @param programme - The validated language-model programme.
 * @param request - The loop execution request carrying the loop id.
 * @param chain - The walk's mutable chain state.
 * @param generation - The one-based generation number to inspect.
 * @returns The generation's persisted-state verdict.
 */
async function inspectLmGeneration(pmRoot: string, client: PmClient, programme: LoopProgramme & { readonly trainer: "lm" }, request: RlLoopRequest, chain: LoopChain, generation: number): Promise<GenerationInspection> {
  const config = programme.config;
  const source = chain.current as LmCheckpoint;
  const input = loopStepInput(programme, chain, generation);
  const collectionStep = await readLoopStep(client, `${request.id}-g${generation}`, "collect", input);
  const { run, item, events } = await verifiedGenerationEvidence(client, programme, request, chain, generation);
  // A completed collect receipt names its evidence even when the Run is gone, so a deleted Run is drift, not "unfinished".
  const expected = collectionStep !== null ? collectionReceipt(collectionStep).events
    : run === null ? [] : lmCollectionEvents(lmCollectBatch(config, generation, source));
  verifyEventPrefix(expected, events, request.id, generation);
  if (collectionStep !== null && events.length !== expected.length) fail("Completed LM collection evidence is missing.", "loop_generation_drift", EXIT_CODE.CONFLICT);
  const observations = events.map((event, index) => parseLmCollectionEvent(event, config, `Loop ${request.id} generation ${generation} collection event ${index}`));
  if (item !== null) {
    const spec = extractGenerationSpec(String(item.item.body), `Generation ${item.item.id}`);
    const stored = parseStoredLmGeneration(spec.training_config as JsonValue, config, `Loop ${request.id} generation ${generation} training configuration`);
    if (observations.length !== config.samplesPerGeneration) {
      fail(`Loop ${request.id} generation ${generation} registered a candidate whose collection evidence is incomplete; the persisted lineage is inconsistent.`, "loop_generation_drift", EXIT_CODE.CONFLICT);
    }
    await verifyLmCheckpointArtifact(pmRoot, source, config);
    if (config.process !== undefined) {
      const externalInput = lmProcessInput(config, chain.step, generation, source, observations, request.id);
      const job = await readProcessJob(client, processJobId(externalInput, request.processTrainerArgv, config.process));
      verifyLmProcessJob(job, pmRoot, externalInput, { digest: stored.candidateCheckpoint });
      await verifyProcessJobBudget(client, job!);
    }
    const trainingStep = await readLoopStep(client, `${request.id}-g${generation}`, "train", input);
    const evaluationStep = await readLoopStep(client, `${request.id}-g${generation}`, "evaluate", input);
    const verified = trainingStep === null || evaluationStep === null ? verifyStoredLmGeneration(config, chain.step, source, stored, observations)
      : restoreLmGeneration(evaluationStep, config, chain.step, restoreLmTraining(trainingStep, config, generation, source, observations));
    if (evaluationStep !== null && canonicalJson(spec.training_config) !== canonicalJson(evaluationStep)) {
      fail("LM candidate disagrees with its durable evaluation receipt.", "loop_step_drift", EXIT_CODE.CONFLICT);
    }
    if (verified.stopReason !== "checkpoint_limit_exceeded") await verifyLmCheckpointArtifact(pmRoot, verified.candidate, config);
    return inspectCandidateVerdict(client, programme, request, chain, generation, String(run!.item.id), item, verified,
      { generation, run: String(run!.item.id), item: String(item.item.id), receipt: verified, banditReceipt: null, collection: [], heldOut: [], lmObservations: observations, events });
  }
  if (chain.consumed + generationCost(programme) > config.budget) {
    return { kind: "budget_stop" };
  }
  return { kind: "pending", pending: { generation, run: run === null ? null : String(run.item.id), item: null, banditReceipt: null, collection: [], heldOut: [], lmObservations: observations, events } };
}

/** Inspect one decision-model generation's persisted state against its persisted evidence. */
async function inspectSystemOneGeneration(client: PmClient, programme: LoopProgramme & { readonly trainer: "systemone" }, request: RlLoopRequest, chain: LoopChain, generation: number): Promise<GenerationInspection> {
  const config = programme.config;
  const { run, item, events } = await verifiedGenerationEvidence(client, programme, request, chain, generation);
  const collected = await readLoopStep(client, `${request.id}-g${generation}`, "collect", loopStepInput(programme, chain, generation));
  if (collected !== null) {
    const expected = collectionReceipt(collected).events;
    verifyEventPrefix(expected, events, request.id, generation);
    if (events.length !== expected.length) fail("Completed decision collection evidence is missing.", "loop_generation_drift", EXIT_CODE.CONFLICT);
  }
  const collection = events.filter((event) => event.metric === SYSTEMONE_COLLECTION_METRIC)
    .map((event, index) => parseSystemOneDecisionEvent(event, SYSTEMONE_COLLECTION_METRIC, config.questions, `Loop ${request.id} generation ${generation} collection event ${index}`));
  const heldOut = events.filter((event) => event.metric === SYSTEMONE_HELD_OUT_METRIC)
    .map((event, index) => parseSystemOneDecisionEvent(event, SYSTEMONE_HELD_OUT_METRIC, config.questions, `Loop ${request.id} generation ${generation} held-out event ${index}`));
  if (collection.length > config.samplesPerGeneration || heldOut.length > config.evaluation.length) {
    fail(`Loop ${request.id} generation ${generation} persists more decision evidence than its programme collects; the recorded batch does not match the programme.`, "loop_generation_drift", EXIT_CODE.CONFLICT);
  }
  const namespace = config.endpoint.receiptProtocol === undefined || run === null ? null : await systemOneReceiptNamespace(client, String(run.item.id), false);
  if (config.endpoint.receiptProtocol !== undefined && namespace === null && events.length > 0) fail("Decision receipt namespace is missing.", "loop_generation_drift", EXIT_CODE.CONFLICT);
  verifyDecisionPrefix(config, chain.current as SystemOneCheckpoint, generation, events, collection, heldOut, namespace);
  if (item !== null) {
    const spec = extractGenerationSpec(String(item.item.body), `Generation ${item.item.id}`);
    const stored = parseStoredSystemOneGeneration(spec.training_config as JsonValue, config.questions, `Loop ${request.id} generation ${generation} training configuration`);
    if (collection.length !== config.samplesPerGeneration || heldOut.length !== config.evaluation.length) {
      fail(`Loop ${request.id} generation ${generation} registered a candidate whose decision evidence is incomplete; the persisted lineage is inconsistent.`, "loop_generation_drift", EXIT_CODE.CONFLICT);
    }
    if (stored.generation !== generation || stored.usageTokens !== events.reduce((total, event) => total + Number(event.tags!["tokens"]), 0)) {
      fail("Generation index or token accounting disagrees with its persisted decisions.", "loop_generation_drift", EXIT_CODE.CONFLICT);
    }
    const recorded = await readLoopStep(client, `${request.id}-g${generation}`, "train", loopStepInput(programme, chain, generation));
    // Recompute from the persisted decisions; a recorded receipt (verdict and stop reason included) must match exactly.
    const verified = verifyStoredSystemOneGeneration(config, chain.step, chain.current as SystemOneCheckpoint, stored, collection, heldOut);
    if (recorded !== null && hashJson(recorded) !== hashJson(verified as unknown as JsonValue)) {
      fail("Decision-model candidate disagrees with its durable training receipt.", "loop_step_drift", EXIT_CODE.CONFLICT);
    }
    return inspectCandidateVerdict(client, programme, request, chain, generation, String(run!.item.id), item, verified,
      { generation, run: String(run!.item.id), item: String(item.item.id), receipt: verified, banditReceipt: null, collection, heldOut, lmObservations: [], events });
  }
  if (run !== null) {
    // A crash mid-collection leaves a partial batch by design: every decision
    // query is one atomic note, so the persisted prefix is exactly the work
    // already spent and the resume appends only the missing queries. A CLOSED
    // run with an incomplete batch, though, is drift: the controller closes a
    // run only after its complete evidence is persisted.
    if (String(run.item.status) !== "in_progress" && collection.length + heldOut.length < config.samplesPerGeneration + config.evaluation.length) {
      fail(`Loop ${request.id} generation ${generation} closed its collection run with an incomplete decision batch.`, "loop_generation_drift", EXIT_CODE.CONFLICT);
    }
  }
  if (chain.consumed + generationCost(programme) > config.budget) {
    return { kind: "budget_stop" };
  }
  return { kind: "pending", pending: { generation, run: run === null ? null : String(run.item.id), item: null, banditReceipt: null, collection, heldOut, lmObservations: [], events } };
}

/** Refuse non-prefix, foreign-example or rewritten decision evidence before appending queries. */
function verifyDecisionPrefix(config: SystemOneLoopConfig, source: SystemOneCheckpoint, generation: number, events: readonly MetricEvent[], collection: readonly SystemOneObservation[], heldOut: readonly SystemOneObservation[], namespace: string | null): void {
  if (events.length !== collection.length + heldOut.length || (heldOut.length > 0 && collection.length !== config.samplesPerGeneration)) {
    fail("Decision evidence is not a contiguous collection then held-out prefix.", "loop_generation_drift", EXIT_CODE.CONFLICT);
  }
  const decisionIds = new Set<string>();
  // readSeries orders events by step across metrics, so each phase's prefix
  // is validated independently rather than assuming append order survives.
  for (const [observations, metric, collecting] of [[collection, SYSTEMONE_COLLECTION_METRIC, true], [heldOut, SYSTEMONE_HELD_OUT_METRIC, false]] as const) {
    const phaseEvents = events.filter((event) => event.metric === metric);
    for (const [step, observation] of observations.entries()) {
      const event = phaseEvents[step];
      const example = collecting ? config.training[step % config.training.length] : config.evaluation[step];
      if (event.step !== step || observation.example !== example.id || !Number.isSafeInteger(Number(event.tags!["tokens"])) || Number(event.tags!["tokens"]) < 0) {
        fail("Decision evidence has a foreign example, index or token count.", "loop_generation_drift", EXIT_CODE.CONFLICT);
      }
      if (namespace !== null) {
        verifySystemOneReceiptEvent(event, systemOneDecisionRequestId(config, source, namespace, metric, step));
        const decisionId = event.tags!["decision_id"];
        if (decisionIds.has(decisionId)) fail("A physical decision receipt was applied more than once.", "loop_generation_drift", EXIT_CODE.CONFLICT);
        decisionIds.add(decisionId);
      }
      const reward = collecting ? sampleSystemOneActions(observation, example, config.questions, source, systemOneSampleSeed(config.seed, generation, step)).reward
        : heldOutEvidenceReward(observation.answers, example, config.questions);
      if (observation.reward !== reward) fail("Decision evidence does not replay the collecting policy's reward.", "loop_generation_drift", EXIT_CODE.CONFLICT);
    }
  }
}

/** Read a generation's collection Run and candidate, verify the Run's policy, and return its metric events. */
async function verifiedGenerationEvidence(client: PmClient, programme: LoopProgramme, request: RlLoopRequest, chain: LoopChain, generation: number): Promise<{ run: GetResult | null; item: GetResult | null; events: readonly MetricEvent[] }> {
  const { run, item } = await findGenerationItems(client, request.id, generation);
  if (run !== null) await verifyLoopRun(client, programme, chain, generation, run, null);
  return { run, item, events: run === null ? [] : await readRunMetricEvents(client, String(run.item.id)) };
}

/** Verify a resumed run; bandit callers supply their already verified receipt, other trainers supply null. */
async function verifyLoopRun(client: PmClient, programme: LoopProgramme, chain: LoopChain, generation: number, run: GetResult, receipt: BanditGeneration | null): Promise<void> {
  const config = programme.trainer === "bandit"
    ? banditCollectionConfig(programme.config, chain.step, generation, receipt!)
    : programme.trainer === "systemone"
      ? systemOneRunConfig(programme.config, chain.step, generation, chain.current as SystemOneCheckpoint)
      : lmRunConfig(programme.config, chain.step, generation, chain.current as LmCheckpoint);
  const environment = programme.trainer === "bandit"
    ? loopEnvironmentSpec(programme.config)
    : programme.trainer === "systemone"
      ? systemOneEnvironmentSpec(programme.config)
      : lmEnvironmentSpec(programme.config);
  const storedEnvironment = await verifyEnvironmentIdentity(client, String(normalizeRunEnvironment(run.item.environment)), "loop");
  const fences = [...jsonSpecFences(String(run.item.body))];
  if (run.item.component !== chain.current.digest
    || run.item.affected_version !== hashJson(environment) || hashJson(storedEnvironment.spec) !== hashJson(environment)
    || fences.length !== 2 || canonicalJson(parseBoundedJson(fences[1]) as JsonValue) !== canonicalJson(config)) {
    fail("The persisted collection run does not match its programme, policy and environment.", "loop_generation_drift", EXIT_CODE.CONFLICT);
  }
}

/** Interpret the durable promotion outcome after either trainer verifies its receipt. */
async function inspectCandidateVerdict(client: PmClient, programme: LoopProgramme, request: RlLoopRequest, chain: LoopChain, generation: number, runId: string, item: GetResult, verified: BanditGeneration | SystemOneGeneration | LmGeneration, pending: GenerationPending): Promise<GenerationInspection> {
  const spec = extractGenerationSpec(String(item.item.body), `Generation ${item.item.id}`);
  if (item.item.affected_version !== hashJson(generationProvenance(spec)) || spec.parent !== chain.parent
    || spec.base_checkpoint !== verified.source.digest || spec.policy !== verified.candidate.digest
    || spec.collection_runs.length !== 1 || spec.collection_runs[0] !== runId || (spec.promoted && !verified.promoted)) {
    fail("The persisted generation does not match its replayed lineage.", "loop_generation_drift", EXIT_CODE.CONFLICT);
  }
  await verifyRetainedGenerationEvidence(client, String(item.item.id)).catch((error: unknown) => {
    if (isPmCliExpectedError(error) && String(error.context.code).startsWith("card_")) fail("The persisted generation evidence changed since certification.", "loop_generation_drift", EXIT_CODE.CONFLICT);
    throw error;
  });
  const report: RlLoopGenerationReport = { generation, run: runId, item: String(item.item.id), promoted: spec.promoted,
    ...(spec.evaluation_evidence === undefined ? {} : { decision_evidence: spec.evaluation_evidence.digest }),
    ...(spec.promoted ? { promoted_by: await promotionAuthor(client, item.item.id) } : {}),
    held_out_mean: verified.candidateHeldOutMean, candidate_checkpoint: verified.candidate.digest, refusal_reason: null };
  if (spec.promoted) {
    await verifyLoopApproval(client, request.approval, spec.approval, request.id, generation);
    return { kind: "complete", report, advance: { checkpoint: verified.candidate, parent: String(item.item.id),
      step: deriveNextStepConfig(programme.config, chain.step, verified.candidateHeldOutMean - verified.incumbentHeldOutMean), cost: generationCost(programme) } };
  }
  const prefix = `Loop ${request.id} generation ${generation} promotion refused: `;
  const prior = (await readLoopComments(client, String(item.item.id))).find((comment) => comment.text.startsWith(prefix));
  if (prior !== undefined) {
    const refusalReason = prior.text.slice(prefix.length);
    return { kind: "refused", receipt: verified, report: { ...report, refusal_reason: refusalReason }, stopReason: "promotion_refused", refusalReason };
  }
  const evaluation = spec.policy_evaluation as Record<string, JsonValue> | undefined;
  if (verified.promoted && evaluation?.["decision"] === "refuse") {
    const refusalReason = `Policy evaluation refused (reason digest ${String(evaluation["reason_digest"])}).`;
    return { kind: "refused", receipt: verified, report: { ...report, refusal_reason: refusalReason }, stopReason: "promotion_refused", refusalReason };
  }
  if (verified.promoted) return { kind: "pending", pending };
  const refusalReason = sealedRefusalReason(spec, verified.refusalReason)!;
  return { kind: "refused", receipt: verified, report: { ...report, refusal_reason: refusalReason }, stopReason: verified.stopReason!, refusalReason };
}

/** Verify a persisted event prefix against the replayed expected events. */
function verifyEventPrefix(expected: readonly MetricEvent[], persisted: readonly MetricEvent[], id: string, generation: number): void {
  if (persisted.length > expected.length) {
    fail(`Loop ${id} generation ${generation} persists more collection events than its programme collects.`, "loop_generation_drift", EXIT_CODE.CONFLICT);
  }
  for (const [index, event] of persisted.entries()) {
    if (canonicalJson(event as unknown as JsonValue) !== canonicalJson(expected[index] as unknown as JsonValue)) {
      fail(`Loop ${id} generation ${generation} persisted collection event ${index} does not match its deterministic replay; the recorded evidence must reproduce before the chain can advance.`, "loop_generation_drift", EXIT_CODE.CONFLICT);
    }
  }
}

/** The schedule bounds every trainer shares, served by one derivation. */
function loopSchedule(programme: LoopProgramme): { readonly maxGenerations: number; readonly budget: number; readonly learningRate: number; readonly evaluationSamples: number; readonly confidence: number; readonly digest: string } {
  const config = programme.config;
  return { maxGenerations: config.maxGenerations, budget: config.budget, learningRate: config.learningRate,
    evaluationSamples: config.evaluationSamples, confidence: config.confidence, digest: config.digest };
}

/** Render the deterministic terminal reason for an exhausted logical sample budget. */
function exhaustedLoopBudget(budget: number, consumed: number): LoopTerminal {
  return { stopReason: "budget_exhausted", refusalReason: `sample budget ${budget} exhausted after ${consumed} collected sample(s)` };
}

/** Dispatch persisted-state inspection to the selected trainer. */
async function inspectLoopGeneration(client: PmClient, programme: LoopProgramme, request: RlLoopRequest, chain: LoopChain, generation: number, pmRoot?: string): Promise<GenerationInspection> {
  if (programme.trainer === "bandit") return inspectBanditGeneration(client, programme, request, chain, generation, pmRoot);
  if (programme.trainer === "systemone") return inspectSystemOneGeneration(client, programme, request, chain, generation);
  if (pmRoot === undefined) fail("LM status requires the tracker root to verify checkpoint artifacts.", "lm_missing_artifact_root");
  return inspectLmGeneration(pmRoot, client, programme, request, chain, generation);
}

/** Finish the close half of a committed promotion without applying or charging promotion again. @internal */
export async function reconcileLoopPromotion(client: PmClient, lease: Pick<ControllerLease, "author" | "guard">, itemId: string): Promise<void> {
  await lease.guard(() => withPromotionEvidence(client, async () => {
    const item = await getTypedItem(client, itemId, "Generation");
    const spec = extractGenerationSpec(String(item.item.body), "Promoted loop generation");
    if (!spec.promoted) fail("Promotion recovery no longer agrees with current generation evidence.", "loop_step_drift", EXIT_CODE.CONFLICT);
    requirePromotionEvidence(spec, item.item.id);
    await enforceEvaluationPlan(client, item.item.id, spec.held_out_score!);
    const config = await identifierClient(client).config("project", "get", "id_prefix");
    const registry = resolveRuntimeStatusRegistry((await readSettings(dirname(config.settings_path))).schema);
    if (registry.terminal_done_statuses.has(String(item.item.status))) {
      await recoverManualPromotion(client, item, spec.approval!, spec.proxy_score!, spec.held_out_score!, spec.promotion_evidence!);
      return;
    }
    await exportPolicyCard(client, itemId);
    await completeLoopGeneration(client, item, String(item.item.body), spec.promotion_evidence!, "Recovered the promotion close boundary; the approved promotion count and scores are unchanged.", [], lease.author);
    await recoverManualPromotion(client, item, spec.approval!, spec.proxy_score!, spec.held_out_score!, spec.promotion_evidence!);
  }));
}

/** Preserve the sealed evaluator's reason when a peer won the rejection transition. */
function sealedRefusalReason(spec: GenerationSpec, fallback: string | null): string | null {
  const evaluation = spec.policy_evaluation as Record<string, JsonValue> | undefined;
  return evaluation?.["decision"] === "refuse" && evaluation["reason_digest"] !== hashJson(fallback)
    ? `Policy evaluation refused (reason digest ${String(evaluation["reason_digest"])}).` : fallback;
}

/** Only established policy/permission verdicts may permanently stop promotion; IO and coordinator errors propagate. */
function terminalPromotionRefusal(error: PmCliExpectedError): boolean {
  const code = String(error.context.code);
  return ["contamination_refused", "lineage_cycle", "provenance_unreadable", "budget_exceeded", "budget_undecidable", "wrong_item_type", "approval_missing_spec", "card_missing_provenance", "card_invalid", "card_drift", "eval_plan_invalid", "eval_plan_drift", "eval_plan_late", "eval_plan_missing", "eval_plan_evidence", "eval_plan_stopping", "eval_plan_refused", "shadow_invalid", "shadow_consent", "shadow_budget", "shadow_drift", "shadow_missing", "shadow_incomplete", "shadow_failed"].includes(code);
}

/** Read the author of the first certified promoted version, independent of later annotations. */
async function promotionAuthor(client: PmClient, id: string): Promise<string> {
  const history = await identifierClient(client).run("history", { id, options: { compact: true, verify: true, outputLimit: "unbounded", outputBudget: "unbounded" } }) as HistoryResult;
  if (!history.verification?.ok || history.limit !== null || history.compact_history?.length !== history.count) fail("Promotion history is incomplete.", "loop_history_incomplete", EXIT_CODE.CONFLICT);
  for (const row of history.compact_history) {
    const item = await readCompleteLoopItem(client, id, String(row.version ?? row.index));
    if (extractGenerationSpec(String(item.item.body), "Promotion attribution").promoted) return row.author;
  }
  fail("Promotion has no certified committed author.", "loop_step_drift", EXIT_CODE.CONFLICT);
}

/** Seal an actual rejection; peer terminal states and CAS refusals are authoritative. @internal */
export async function recordRefusedPolicyCard(client: PmClient, id: string, reason: string | null, author = "pm-rl"): Promise<"promoted" | "refused"> {
  // Rejection and checkpoint publication are transitions of the same candidate.
  // Acquire their shared protocol lease before reading any decision state;
  // ordinary SDK writers still face the native revision/CAS guards below.
  return await withEvaluationLease(client, id, [], () => withPromotionEvidence(client, () => sealPolicyRejection(client, id, reason, author)));
}
/** Hold all decision inputs through the rejection write, with the same SDK revision guard as promotion. */
async function sealPolicyRejection(client: PmClient, id: string, reason: string | null, author: string): Promise<"promoted" | "refused"> {
  const current = await readCompleteLoopItem(client, id);
  const existing = extractGenerationSpec(String(current.item.body), "Rejected generation");
  if (existing.promoted) { await recordPolicyCard(client, id); return "promoted"; }
  // An existing refusal belongs to its evaluator; never replace its reason with a local transition error.
  if ((existing.policy_evaluation as Record<string, JsonValue> | undefined)?.["decision"] !== "refuse") {
    const body = await validateRefusedPolicyCard(client, id, { decision: "refuse", reason_digest: hashJson(reason) });
    try { await mutateLoopItem(client, current, "Seal policy rejection", (document) => { document.body = body; return ["body"]; }, [], author); }
    catch (error) {
      const fresh = extractGenerationSpec(String((await readCompleteLoopItem(client, id)).item.body), "Concurrent outcome");
      if (fresh.promoted) { await recordPolicyCard(client, id); return "promoted"; }
      if ((fresh.policy_evaluation as Record<string, JsonValue> | undefined)?.["decision"] !== "refuse") throw error;
    }
  }
  await recordPolicyCard(client, id);
  return "refused";
}

/** Walk the persisted generations, then execute and verify until the loop terminates. */
async function executeLoopProgramme(client: PmClient, coordinates: WorkspaceCoordinates, programme: LoopProgramme, request: RlLoopRequest, prepared: LoopPrepared): Promise<RlLoopReport> {
  const schedule = loopSchedule(programme);
  const chain: LoopChain = {
    current: prepared.seedCheckpoint,
    parent: prepared.seedId,
    step: { learningRate: schedule.learningRate, evaluationSamples: schedule.evaluationSamples },
    consumed: 0,
    reports: [],
    promotedCount: 0,
    resumed: 0,
  };
  let terminal: LoopTerminal | null = null;
  for (let generation = 1; generation <= schedule.maxGenerations && terminal === null; generation += 1) {
    const inspection = await inspectLoopGeneration(client, programme, request, chain, generation, coordinates.pmRoot);
    if (inspection.kind === "budget_stop") {
      terminal = exhaustedLoopBudget(schedule.budget, chain.consumed);
      break;
    }
    if (inspection.kind === "complete") {
      await reconcileLoopPromotion(client, prepared.lease, inspection.report.item);
      if (programme.trainer === "bandit" && programme.config.process !== undefined) {
        const receipt = runLoopGeneration(programme.config, chain.step, generation, chain.current as BanditCheckpoint, inspection.advance.checkpoint as BanditCheckpoint);
        await finishProcessGeneration(client, coordinates, prepared.lease, programme.config, chain, generation, receipt, "promoted", "promotion_verified", request);
      }
      if (programme.trainer === "lm" && programme.config.process !== undefined) {
        const job = (await loopProcessJobs(client, request.id, programme)).find((entry) => jsonObject(entry.binding, "Process binding")["generation"] === generation)!;
        await prepared.lease.guard(() => transitionProcessJob(client, coordinates, job, "promoted", "promotion_verified"));
      }
      await durableLoopStep(client, prepared.lease, `${request.id}-g${generation}`, "promote",
        { input: loopStepInput(programme, chain, generation), approval: request.approval }, async () => ({ item: inspection.report.item }));
      chain.reports.push(inspection.report);
      chain.promotedCount += 1;
      chain.consumed += inspection.advance.cost;
      chain.current = inspection.advance.checkpoint;
      chain.parent = inspection.advance.parent;
      chain.step = inspection.advance.step;
      chain.resumed += 1;
      continue;
    }
    if (inspection.kind === "refused") {

      // The original run recorded the refusal as the candidate's history; a
      // crash between the registration and that comment still gets it, exactly
      // once, because the append is idempotent by text.
      const actual = await prepared.lease.guard(() => recordRefusedPolicyCard(client, inspection.report.item, inspection.refusalReason, coordinates.author));
      if (actual === "promoted") { generation -= 1; continue; }
      chain.reports.push(inspection.report);
      chain.consumed += generationCost(programme);
      if (inspection.stopReason !== "promotion_refused") await prepared.lease.guard(() => appendCommentOnce(client, inspection.report.item!, `Loop ${request.id} generation ${generation} refused: ${inspection.refusalReason}`));
      await finishProcessGeneration(client, coordinates, prepared.lease, programme.trainer !== "systemone" ? programme.config : null, chain, generation, inspection.receipt as BanditGeneration | LmGeneration, inspection.stopReason === "promotion_refused" ? "invalidated" : "failed", inspection.refusalReason, request);
      if (advanceRejectedProposal(programme, chain, inspection.refusalReason, inspection.stopReason)) { chain.resumed += 1; continue; }
      terminal = { stopReason: inspection.stopReason, refusalReason: inspection.refusalReason };
      break;
    }
    const executed = await executePendingGeneration(client, coordinates, programme, request, prepared, chain, inspection.pending);
    if (executed.terminal !== null) {
      terminal = executed.terminal;
      break;
    }
  }
  if (terminal === null) terminal = { stopReason: "generation_limit", refusalReason: null };
  const processJobs = await loopProcessJobs(client, request.id, programme);
  await discoverPolicyCards(client);
  const report: RlLoopReport = {
    ...(skippedTrackerRecords(client).length === 0 ? {} : { skipped_records: skippedTrackerRecords(client) }),
    ...(processJobs.length === 0 ? {} : { process_jobs: processJobs }),
    stop_reason: terminal.stopReason,
    environment: prepared.environmentId,
    seed_generation: prepared.seedId,
    generations: chain.reports,
    promoted: chain.promotedCount,
    samples_consumed: chain.consumed,
    budget: schedule.budget,
    final_checkpoint: chain.current.digest,
    refusal_reason: terminal.refusalReason,
    resumed_generations: chain.resumed,
  };
  await prepared.lease.guard(() => appendCommentOnce(client, prepared.seedId, terminalReportText(request.id, report)));
  return report;
}

/** The outcome of finishing one pending generation. */
interface GenerationOutcome {
  /** The terminal condition this generation ended the loop with, or null to continue. */
  readonly terminal: LoopTerminal | null;
}

/** Execute one pending generation: complete its collection, register, and promote or refuse. */
async function executePendingGeneration(client: PmClient, coordinates: WorkspaceCoordinates, programme: LoopProgramme, request: RlLoopRequest, prepared: LoopPrepared, chain: LoopChain, pending: GenerationPending): Promise<GenerationOutcome> {
  const generation = pending.generation;
  const signal = request.signal;
  failIfLoopCancelled(signal, request.id, generation, "collection");
  const input = loopStepInput(programme, chain, generation);
  const stepId = `${request.id}-g${generation}`;
  let runId = pending.run;
  if (pending.item === null) {
    const collected = await durableLoopStep(client, prepared.lease, stepId, "collect", input, async () => {
      let collectingRun = pending.run;
      if (collectingRun === null) {
        const runRegistration = await startRunCore(client, {
          id: `${request.id}-g${generation}-collect`, environmentId: prepared.environmentId, algorithm: chain.current.digest,
          config: programme.trainer === "bandit" ? banditCollectionConfig(programme.config, chain.step, generation, pending.banditReceipt!)
            : programme.trainer === "systemone" ? systemOneRunConfig(programme.config, chain.step, generation, chain.current as SystemOneCheckpoint)
              : lmRunConfig(programme.config, chain.step, generation, chain.current as LmCheckpoint), receipt: null,
        });
        collectingRun = String(runRegistration.id);
      }
      await collectGenerationBatch(client, programme, request, chain, pending, collectingRun);
      const run = await getTypedItem(client, collectingRun, "Run");
      if (String(run.item.status) === "in_progress") {
        await identifierClient(client).close(collectingRun, "collection complete", { message: "Finish RL run", resolution: "collection complete",
          expectedResult: "The run reaches a terminal state without rewriting its metric history.", actualResult: `Collected the generation ${generation} batch for loop ${request.id}.` });
      }
      return { run: collectingRun, events: await readRunMetricEvents(client, collectingRun) as unknown as JsonValue };
    });
    runId = collectionReceipt(collected.value).run;
    if (collected.executed) await request.onPhase?.("collect", generation);
  }
  chain.consumed += generationCost(programme);
  failIfLoopCancelled(signal, request.id, generation, "training");
  let receipt: BanditGeneration | SystemOneGeneration | LmGeneration;
  let trainExecuted = false;
  let evaluationExecuted = false;
  if (pending.receipt !== undefined) {
    receipt = pending.receipt;
  } else if (programme.trainer === "bandit" && programme.config.process !== undefined) {
    const processInput = banditProcessInput(programme.config, chain.step, generation, pending.banditReceipt!, request.id);
    const trained = await durableLoopStep(client, prepared.lease, stepId, "train", input, async () => {
      const job = await executeProcessTrainer(client, coordinates, processInput, request.approval, programme.config.process!, request.signal, request.processTrainerArgv);
      return runLoopGeneration(programme.config, chain.step, generation, chain.current as BanditCheckpoint, job.completion!.policy) as unknown as JsonValue;
    });
    const job = (await readProcessJob(client, processJobId(processInput, request.processTrainerArgv, programme.config.process)))!;
    const candidate = verifiedProcessPolicy(job, coordinates.pmRoot, processInput)!;
    receipt = runLoopGeneration(programme.config, chain.step, generation, chain.current as BanditCheckpoint, candidate);
    if (hashJson(trained.value) !== hashJson(receipt as unknown as JsonValue)) fail("Process training receipt drifted.", "loop_step_drift", EXIT_CODE.CONFLICT);
    trainExecuted = trained.executed;
    const evaluated = await durableLoopStep(client, prepared.lease, stepId, "evaluate", input, async () => trained.value);
    evaluationExecuted = evaluated.executed;
    await finishProcessGeneration(client, coordinates, prepared.lease, programme.config, chain, generation, receipt as BanditGeneration, "evaluated", "held_out_evaluated", request);
  } else if (programme.trainer === "lm") {
    const observations = (await readRunMetricEvents(client, runId!)).map((event, index) => parseLmCollectionEvent(event, programme.config, `Loop collection event ${index}`));
    if (observations.length !== programme.config.samplesPerGeneration) fail("LM collection evidence is incomplete.", "loop_generation_drift", EXIT_CODE.CONFLICT);
    const externalInput = programme.config.process === undefined ? null : lmProcessInput(programme.config, chain.step, generation, chain.current as LmCheckpoint, observations, request.id);
    const trained = await durableLoopStep(client, prepared.lease, stepId, "train", input, async () => {
      if (externalInput === null) return lmTrainingJson(trainLmStep(programme.config, chain.step, generation, chain.current as LmCheckpoint, observations, null));
      const job = await executeProcessTrainer(client, coordinates, externalInput, request.approval, programme.config.process!, request.signal);
      return lmTrainingJson(processLmTraining(externalInput, job.completion!));
    });
    if (externalInput !== null) {
      const job = (await readProcessJob(client, processJobId(externalInput, undefined, programme.config.process)))!;
      verifyLmProcessJob(job, coordinates.pmRoot, externalInput, { digest: String(jsonObject(trained.value, "LM fit")["candidate_checkpoint"]), training: trained.value });
    }
    const training = restoreLmTraining(trained.value, programme.config, generation, chain.current as LmCheckpoint, observations);
    if (serializeLmCheckpoint(training.candidate, programme.config).bytes <= programme.config.limits.maxCheckpointBytes) {
      await prepared.lease.guard(() => persistLmCheckpoint(coordinates.pmRoot, training.candidate, programme.config));
    }
    if (trained.executed) await request.onPhase?.("train", generation);
    failIfLoopCancelled(signal, request.id, generation, "evaluation");
    const evaluated = await durableLoopStep(client, prepared.lease, stepId, "evaluate", input, async () =>
      lmGenerationTrainingConfig(programme.config, chain.step, evaluateLmStep(programme.config, chain.step, training, null)));
    receipt = restoreLmGeneration(evaluated.value, programme.config, chain.step, training);
    await finishProcessGeneration(client, coordinates, prepared.lease, programme.config, chain, generation, receipt, "evaluated", "held_out_evaluated", request);
    evaluationExecuted = evaluated.executed;
  } else {
    if (programme.trainer === "systemone" && programme.config.endpoint.receiptProtocol !== undefined
      && await systemOneReceiptNamespace(client, runId!, false) === null) {
      fail("Decision receipt namespace is missing.", "loop_generation_drift", EXIT_CODE.CONFLICT);
    }
    const trained = await durableLoopStep(client, prepared.lease, stepId, "train", input, async () =>
      await completeGenerationEvidence(client, programme, request, chain, pending, runId!) as unknown as JsonValue);
    // A previously recorded train receipt is evidence only if it equals the replay from persisted collection evidence.
    const evidence = trained.executed ? trained.value : await completeGenerationEvidence(client, programme, request, chain, pending, runId!) as unknown as JsonValue;
    if (hashJson(trained.value) !== hashJson(evidence)) {
      fail("Recorded training receipt disagrees with its replay from persisted evidence.", "loop_step_drift", EXIT_CODE.CONFLICT);
    }
    receipt = evidence as unknown as BanditGeneration | SystemOneGeneration;
    trainExecuted = trained.executed;
    failIfLoopCancelled(signal, request.id, generation, "evaluation");
    const evaluated = await durableLoopStep(client, prepared.lease, stepId, "evaluate", input, async () => trained.value);
    evaluationExecuted = evaluated.executed;
  }
  // Train and evaluate are recorded on the candidate generation: the derived
  // configuration, both checkpoints, and the evaluation numbers the next
  // generation's configuration is derived from.
  if (programme.trainer === "lm" && receipt.stopReason !== "checkpoint_limit_exceeded") {
    await prepared.lease.guard(() => persistLmCheckpoint(coordinates.pmRoot, (receipt as LmGeneration).candidate, programme.config));
  }
  const generationRegistration = pending.item !== null ? { id: pending.item } : await prepared.lease.guard(() => registerGenerationCore(client, {
    id: `${request.id}-g${generation}`,
    baseCheckpoint: receipt.source.digest,
    parent: chain.parent,
    // The recorded policy is the checkpoint this generation's successor
    // collection runs must match: the candidate it produced. The generation's
    // OWN runs were checked against its parent's policy at this same boundary.
    policy: receipt.candidate.digest,
    collectionRuns: [runId!],
    environment: prepared.environmentId,
    config: programme.trainer === "bandit"
      ? generationTrainingConfig(programme.config, chain.step, generation, receipt as BanditGeneration)
      : programme.trainer === "systemone"
        ? systemOneGenerationTrainingConfig(programme.config, chain.step, receipt as SystemOneGeneration)
        : lmGenerationTrainingConfig(programme.config, chain.step, receipt as LmGeneration),
    evaluation: { decision: receipt.promoted ? "promote" : "refuse", reason_digest: hashJson(receipt.refusalReason) },
  }));
  const generationId = String(generationRegistration.id);
  if (trainExecuted) await request.onPhase?.("train", generation);
  if (evaluationExecuted) await request.onPhase?.("evaluate", generation);
  if (!receipt.promoted) {
    // The gate refused the candidate: record the refusal in the candidate's
    // history and stop. A refused candidate never becomes a collector.
    let refusalReason = receipt.refusalReason;
    await prepared.lease.guard(async () => {
      await recordRefusedPolicyCard(client, generationId, receipt.refusalReason, coordinates.author);
      const fresh = extractGenerationSpec(String((await readCompleteLoopItem(client, generationId)).item.body), "Sealed refusal");
      refusalReason = sealedRefusalReason(fresh, receipt.refusalReason);
      await appendCommentOnce(client, generationId, `Loop ${request.id} generation ${generation} refused: ${refusalReason}`);
    });
    chain.reports.push({ generation, run: runId!, item: generationId, promoted: false,
      held_out_mean: receipt.candidateHeldOutMean, candidate_checkpoint: receipt.candidate.digest, refusal_reason: refusalReason });
    await finishProcessGeneration(client, coordinates, prepared.lease, programme.trainer !== "systemone" ? programme.config : null, chain, generation, receipt as BanditGeneration | LmGeneration, "failed", refusalReason!, request);
    if (advanceRejectedProposal(programme, chain, refusalReason!, receipt.stopReason!)) return { terminal: null };
    return { terminal: { stopReason: receipt.stopReason!, refusalReason: refusalReason! } };
  }
  // Promote through the existing transactional, budget-checked flow. An
  // expected refusal here — an exhausted approval, a contamination verdict —
  // terminates the loop with the refusal recorded, not retried.
  const schedule = loopSchedule(programme);
  const scores = programme.trainer === "bandit"
    ? loopPromotionScores(programme.config, chain.step, generation, receipt as BanditGeneration)
    : programme.trainer === "systemone"
      ? systemOnePromotionScores(programme.config, chain.step, receipt as SystemOneGeneration)
      : lmPromotionScores(programme.config, chain.step, receipt as LmGeneration);
  failIfLoopCancelled(signal, request.id, generation, "promotion");
  let promotionExecuted: boolean;
  // Only a refusal raised by the promotion decision itself is terminal. Lease
  // fencing, controller-mutex waits and step-receipt drift come from the guard
  // around it and must propagate so a resume can retry them.
  let promotionError: unknown;
  try {
    const promotion = await durableLoopStep(client, prepared.lease, stepId, "promote", { input, approval: request.approval }, async () => {
      try {
        await promoteGenerationCore(client, coordinates, generationId, request.approval,
          parseScoreRecord(scores.proxy_score, "proxy_score"), parseScoreRecord(scores.held_out_score, "held_out_score"),
          `loop ${request.id} generation ${generation}: held-out mean improved from ${receipt.incumbentHeldOutMean.toFixed(4)} to ${receipt.candidateHeldOutMean.toFixed(4)} over ${chain.step.evaluationSamples} episodes at confidence ${schedule.confidence}`);
      } catch (error) {
        rethrowOperationalRead(error);
        promotionError = error;
        throw error;
      }
      await recordPolicyCard(client, generationId);
      return { item: generationId };
    });
    promotionExecuted = promotion.executed;
  } catch (error) {
    const authoritative = await readCompleteLoopItem(client, generationId);
    const actual = extractGenerationSpec(String(authoritative.item.body), "Authoritative promotion outcome");
    if (isPmCliExpectedError(error)) {
      const decision = (actual.policy_evaluation as Record<string, JsonValue> | undefined)?.["decision"];
      Object.assign(error.context, { authoritative_candidate: {
        id: authoritative.item.id, promoted: actual.promoted,
        evaluation: decision === "promote" ? "promote" : decision === "refuse" ? "refuse" : null,
        revision: authoritative.item.updated_at,
      } });
    }
    if (actual.promoted) {
      // Replay verifies the peer's provenance and approval before counting it. No local rejection is written.
      await inspectCandidateVerdict(client, programme, request, chain, generation, runId!, authoritative, receipt, pending);
      promotionExecuted = true;
    } else if ((actual.policy_evaluation as Record<string, JsonValue> | undefined)?.["decision"] === "refuse") {
      const verified = await inspectCandidateVerdict(client, programme, request, chain, generation, runId!, authoritative, receipt, pending) as Extract<GenerationInspection, { kind: "refused" }>;
      chain.reports.push(verified.report);
      return { terminal: { stopReason: verified.stopReason, refusalReason: verified.refusalReason } };
    } else {
      if (error !== promotionError || !isPmCliExpectedError(error) || !terminalPromotionRefusal(error)) throw error;
      const outcome = await prepared.lease.guard(() => recordRefusedPolicyCard(client, generationId, error.message, coordinates.author));
      if (outcome === "promoted") promotionExecuted = true;
      else {
        const fresh = extractGenerationSpec(String((await readCompleteLoopItem(client, generationId)).item.body), "Sealed evaluation outcome");
        const reason = sealedRefusalReason(fresh, error.message)!;
        const message = `Loop ${request.id} generation ${generation} promotion refused: ${reason}`;
        await prepared.lease.guard(() => appendCommentOnce(client, generationId, message));
        chain.reports.push({ generation, run: runId!, item: generationId, promoted: false,
          held_out_mean: receipt.candidateHeldOutMean, candidate_checkpoint: receipt.candidate.digest, refusal_reason: reason });
        await finishProcessGeneration(client, coordinates, prepared.lease, programme.trainer !== "systemone" ? programme.config : null, chain, generation, receipt as BanditGeneration | LmGeneration, "invalidated", reason, request);
        return { terminal: { stopReason: "promotion_refused", refusalReason: reason } };
      }
    }
  }
  if (!promotionExecuted) {
    const authoritative = await readCompleteLoopItem(client, generationId);
    const verified = await inspectCandidateVerdict(client, programme, request, chain, generation, runId!, authoritative, receipt, pending);
    if (verified.kind !== "complete") fail("Completed loop promotion disagrees with an unpromoted generation", "loop_step_drift", EXIT_CODE.CONFLICT);
  }
  await recordPolicyCard(client, generationId);
  await finishProcessGeneration(client, coordinates, prepared.lease, programme.trainer !== "systemone" ? programme.config : null, chain, generation, receipt as BanditGeneration | LmGeneration, "promoted", "promotion_verified", request);
  await request.onPhase?.("promote", generation);
  failIfLoopCancelled(signal, request.id, generation, "successor collection");
  chain.reports.push({ generation, run: runId!, item: generationId, promoted: true, promoted_by: await promotionAuthor(client, generationId),
    held_out_mean: receipt.candidateHeldOutMean, candidate_checkpoint: receipt.candidate.digest, refusal_reason: null });
  chain.promotedCount += 1;
  chain.current = receipt.candidate;
  chain.parent = generationId;
  chain.step = deriveNextStepConfig(programme.config, chain.step, receipt.candidateHeldOutMean - receipt.incumbentHeldOutMean);
  return { terminal: null };
}

/** A separately sealed exploration mode retries item refusals with a smaller step, never a refused collector. */
function advanceRejectedProposal(programme: LoopProgramme, chain: LoopChain, refusalReason: string, reason: RlLoopReport["stop_reason"]): boolean {
  if (programme.trainer !== "bandit" || !programme.config.retryRejected || reason !== "evaluation_rejected" || !refusalReason.startsWith("item_")) return false;
  chain.step = deriveNextStepConfig(programme.config, chain.step, -programme.config.minimumImprovement);
  return true;
}

/** Advance the process lifecycle alongside the existing held-out and promotion gates. */
async function finishProcessGeneration(client: PmClient, coordinates: WorkspaceCoordinates, lease: ControllerLease, config: LoopConfig | LmLoopConfig | null, chain: LoopChain, generation: number, receipt: BanditGeneration | LmGeneration, state: ProcessJobState, outcome: string, request: RlLoopRequest): Promise<void> {
  if (config?.process === undefined) return;
  const input = "baseDigest" in config ? lmProcessInput(config, chain.step, generation, (receipt as LmGeneration).source, (receipt as LmGeneration).observations, request.id)
    : banditProcessInput(config, chain.step, generation, receipt as BanditGeneration, request.id);
  await lease.guard(async () => {
    const job = (await readProcessJob(client, processJobId(input, request.processTrainerArgv, config.process)))!;
    await verifyProcessJobBudget(client, job);
    await transitionProcessJob(client, coordinates, job, state, outcome);
  });
}

/** Read or establish a run's immutable request namespace before spending remote inference; the controller lease serializes creation. */
async function systemOneReceiptNamespace(client: PmClient, runId: string, create: boolean): Promise<string | null> {
  const prefix = "SystemOne receipt namespace: ";
  const entries = (await readLoopComments(client, runId)).map((comment) => comment.text).filter((text) => text.startsWith(prefix));
  if (entries.length > 1 || (entries.length === 1 && !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(entries[0].slice(prefix.length)))) {
    fail("Decision receipt namespace is ambiguous or malformed.", "loop_generation_drift", EXIT_CODE.CONFLICT);
  }
  if (entries.length === 1) return entries[0].slice(prefix.length);
  if (!create) return null;
  const namespace = randomUUID();
  await identifierClient(client).update(runId, { comment: [prefix + namespace] });
  return namespace;
}

/** Complete one generation's collection batch, appending only its missing suffix. */
async function collectGenerationBatch(client: PmClient, programme: LoopProgramme, request: RlLoopRequest, chain: LoopChain, pending: GenerationPending, runId: string): Promise<void> {
  if (programme.trainer !== "systemone") {
    const expected = programme.trainer === "bandit"
      ? collectionMetricEvents(pending.banditReceipt!)
      : lmCollectionEvents(lmCollectBatch(programme.config, pending.generation, chain.current as LmCheckpoint));
    verifyEventPrefix(expected, pending.events, request.id, pending.generation);
    const missing = expected.slice(pending.events.length);
    if (missing.length > 0) await appendRunMetrics(client, runId, missing);
    return;
  }
  const config = programme.config;
  const source = chain.current as SystemOneCheckpoint;
  const namespace = config.endpoint.receiptProtocol === undefined ? null : await systemOneReceiptNamespace(client, runId, true);
  for (const [metric, completed, count] of [[SYSTEMONE_COLLECTION_METRIC, pending.collection.length, config.samplesPerGeneration],
    [SYSTEMONE_HELD_OUT_METRIC, pending.heldOut.length, config.evaluation.length]] as const) {
    for (let step = completed; step < count; step += 1) {
      failIfLoopCancelled(request.signal, request.id, pending.generation, `${metric} query ${step}`);
      const collecting = metric === SYSTEMONE_COLLECTION_METRIC;
      const example = collecting ? config.training[step % config.training.length] : config.evaluation[step];
      const requestId = namespace === null ? undefined : systemOneDecisionRequestId(config, source, namespace, metric, step);
      await request.onDecision?.("request", metric, step);
      const decision = await requestSystemOneDecision(config.endpoint, systemOneState(example), config.questions, request.signal, requestId);
      await request.onDecision?.("response", metric, step);
      const reward = collecting
        ? sampleSystemOneActions({ example: example.id, answers: decision.answers, reward: 0 }, example, config.questions, source, systemOneSampleSeed(config.seed, pending.generation, step)).reward
        : heldOutEvidenceReward(decision.answers, example, config.questions);
      await appendRunMetrics(client, runId, [systemOneDecisionEvent(metric, step, { example: example.id, answers: decision.answers, reward }, decision.usage)]);
      await request.onDecision?.("commit", metric, step);
    }
  }
}

/** The policy-independent correctness a held-out evidence event records: the frozen model's own confidence in the true answer. */
function heldOutEvidenceReward(answers: Readonly<Record<string, Readonly<Record<string, number>>>>, example: SystemOneExample, questions: readonly SystemOneChoiceSpec[]): number {
  let total = 0;
  for (const question of questions) {
    total += Math.max(0, answers[question.name][example.labels[question.name]]);
  }
  return total / questions.length;
}

/** Re-read one generation's complete evidence and render its receipt. */
async function completeGenerationEvidence(client: PmClient, programme: Exclude<LoopProgramme, { readonly trainer: "lm" }>, request: RlLoopRequest, chain: LoopChain, pending: GenerationPending, runId: string): Promise<BanditGeneration | SystemOneGeneration> {
  if (programme.trainer === "bandit") {
    return pending.banditReceipt!;
  }
  const config = programme.config;
  const events = await readRunMetricEvents(client, runId);
  const collection = events.filter((event) => event.metric === SYSTEMONE_COLLECTION_METRIC)
    .map((event, index) => parseSystemOneDecisionEvent(event, SYSTEMONE_COLLECTION_METRIC, config.questions, `Loop ${request.id} generation ${pending.generation} collection event ${index}`));
  const heldOut = events.filter((event) => event.metric === SYSTEMONE_HELD_OUT_METRIC)
    .map((event, index) => parseSystemOneDecisionEvent(event, SYSTEMONE_HELD_OUT_METRIC, config.questions, `Loop ${request.id} generation ${pending.generation} held-out event ${index}`));
  if (collection.length !== config.samplesPerGeneration || heldOut.length !== config.evaluation.length) {
    fail(`Loop ${request.id} generation ${pending.generation} did not persist its complete decision evidence.`, "loop_generation_drift", EXIT_CODE.CONFLICT);
  }
  const namespace = config.endpoint.receiptProtocol === undefined ? null : await systemOneReceiptNamespace(client, runId, false);
  if (config.endpoint.receiptProtocol !== undefined && namespace === null) fail("Decision receipt namespace is missing.", "loop_generation_drift", EXIT_CODE.CONFLICT);
  verifyDecisionPrefix(config, chain.current as SystemOneCheckpoint, pending.generation, events, collection, heldOut, namespace);
  const usageTokens = events.reduce((total, event) => total + Number(event.tags!["tokens"]), 0);
  return executeSystemOneStep(config, chain.step, pending.generation, chain.current as SystemOneCheckpoint, collection, heldOut, usageTokens);
}

/**
 * Reconstruct one loop's persisted state without mutating anything.
 *
 * The typed SDK surface of `pm rl loop status`: the seed's stored programme
 * is re-parsed, every persisted generation is verified against its replay
 * exactly as a resume would, and the report names the phase each generation
 * reached so an operator can see where an interrupted loop stands.
 *
 * @param client - Client bound to the target workspace.
 * @param id - The loop id prefix whose persisted programme is reconstructed.
 * @param pmRoot - Tracker root for verifying LM checkpoint artifact bytes.
 * @returns The read-only status report.
 * @throws An expected NOT_FOUND error when the loop's seed generation does not exist.
 */
export async function rlLoopStatus(client: PmClient, id: string, pmRoot?: string): Promise<RlLoopStatusReport> {
  id = await canonicalProgrammeId(client, id);
  const seed = await getTypedItem(client, `${id}-seed`, "Generation");
  const configuration = storedLoopConfiguration(seed);
  const programme = parseLoopProgramme(configuration as JsonValue);
  const processJobs = await loopProcessJobs(client, id, programme);
  const budget = programme.config.budget;
  const trainer = programme.trainer;
  const schedule = loopSchedule(programme);
  const seedCheckpoint = trainer === "bandit" ? banditCheckpoint(programme.config.initialWeight) : programme.config.initial;
  // Status never mutates: the environment is looked up by its content-derived
  // id, not registered, so a status read cannot repair or create anything.
  const environmentSpec = trainer === "bandit"
    ? loopEnvironmentSpec(programme.config)
    : trainer === "systemone"
      ? systemOneEnvironmentSpec(programme.config)
      : lmEnvironmentSpec(programme.config);
  const environment = await getTypedItem(client, `env-${idSegment(environmentSpec.name)}-${idSegment(environmentSpec.version)}-${hashJson(environmentSpec).slice(0, 12)}`, "Environment");
  const chain: LoopChain = { current: seedCheckpoint, parent: String(seed.item.id),
    step: { learningRate: schedule.learningRate, evaluationSamples: schedule.evaluationSamples },
    consumed: 0, reports: [], promotedCount: 0, resumed: 0 };
  const generations: RlLoopGenerationStatus[] = [];
  const request: RlLoopRequest = { id, config: configuration as JsonValue, approval: "" };
  let terminal: LoopTerminal | null = null;
  let nextGeneration: number | null = null;
  for (let generation = 1; generation <= schedule.maxGenerations && terminal === null; generation += 1) {
    const inspection = await inspectLoopGeneration(client, programme, request, chain, generation, pmRoot);
    if (inspection.kind === "budget_stop") {
      terminal = exhaustedLoopBudget(budget, chain.consumed);
      break;
    }
    if (inspection.kind === "refused") {
      generations.push(statusOf(inspection.report, "refused"));
      chain.consumed += generationCost(programme);
      if (advanceRejectedProposal(programme, chain, inspection.refusalReason, inspection.stopReason)) { chain.resumed += 1; continue; }
      terminal = { stopReason: inspection.stopReason, refusalReason: inspection.refusalReason };
      break;
    }
    if (inspection.kind === "complete") {
      generations.push(statusOf(inspection.report, "promoted"));
      chain.consumed += inspection.advance.cost;
      chain.promotedCount += 1;
      chain.current = inspection.advance.checkpoint;
      chain.parent = inspection.advance.parent;
      chain.step = inspection.advance.step;
      continue;
    }
    const pending = inspection.pending;
    // A registered candidate that never reached its promotion is further along
    // than one still collecting: the phase names exactly where the loop stands.
    const phase: RlLoopGenerationStatus["phase"] = pending.item !== null
      ? "promotion_pending"
      : pendingEvidenceComplete(programme, pending)
        ? "collected"
        : "collecting";
    generations.push({ generation, run: pending.run, item: pending.item, phase, promoted: false,
      held_out_mean: null, candidate_checkpoint: null, refusal_reason: null });
    chain.consumed += programme.trainer === "systemone" ? pending.collection.length + pending.heldOut.length : pending.events.length;
    nextGeneration = generation;
    break;
  }
  // A verdict generation inspection established (gap, evaluation or promotion refusal) is the stop reason; a failed
  // or invalidated job's generic state never overrides it, and such a job without a verdict is refused above
  // (process_job_terminal). Only a cancellation stops a loop without any generation verdict.
  const established = terminal;
  if (terminal === null && nextGeneration === null) terminal = { stopReason: "generation_limit", refusalReason: null };
  const cancelledJob = processJobs.find((job) => job.state === "cancelled");
  if (cancelledJob !== undefined && established === null) terminal = { stopReason: "process_cancelled", refusalReason: cancelledJob.outcome };
  return {
    ...(processJobs.length === 0 ? {} : { process_jobs: processJobs }),
    id,
    trainer,
    programme: schedule.digest,
    environment: String(environment.item.id),
    seed_generation: String(seed.item.id),
    generations,
    promoted: chain.promotedCount,
    samples_consumed: chain.consumed,
    budget,
    final_checkpoint: chain.current.digest,
    stop_reason: terminal === null ? null : terminal.stopReason,
    refusal_reason: terminal === null ? null : terminal.refusalReason,
    next_generation: terminal === null ? nextGeneration : null,
  };
}

/** Whether one pending generation's persisted evidence is already complete. */
function pendingEvidenceComplete(programme: LoopProgramme, pending: GenerationPending): boolean {
  if (programme.trainer === "systemone") {
    return pending.collection.length >= programme.config.samplesPerGeneration
      && pending.heldOut.length >= programme.config.evaluation.length;
  }
  return pending.events.length >= programme.config.samplesPerGeneration;
}

/** Render one verified generation report as a status row. */
function statusOf(report: RlLoopGenerationReport, phase: RlLoopGenerationStatus["phase"]): RlLoopGenerationStatus {
  return { generation: report.generation, run: report.run, item: report.item, phase,
    promoted: report.promoted, ...(report.promoted_by === undefined ? {} : { promoted_by: report.promoted_by }), held_out_mean: report.held_out_mean,
    candidate_checkpoint: report.candidate_checkpoint, refusal_reason: report.refusal_reason };
}

/**
 * Resume one interrupted loop from its persisted programme.
 *
 * The typed SDK surface of `pm rl loop resume`: the configuration is read
 * from the seed generation's stored programme — not re-supplied by the
 * caller — so the resumed execution provably continues the same content
 * identity, and the controller takes over the seed's claim explicitly, the
 * documented recovery action for a lease a crashed controller left behind.
 *
 * @param client - Client bound to the target workspace.
 * @param coordinates - Workspace root and author for the transaction journal.
 * @param request - The loop id, approval, optional cancellation signal and audited forceTakeover choice.
 * @returns The bounded terminal report of the resumed loop.
 * @throws An expected NOT_FOUND error when the loop's seed generation does not exist.
 */
export async function resumeRlLoop(client: PmClient, coordinates: WorkspaceCoordinates, rawRequest: Omit<RlLoopRequest, "config">): Promise<RlLoopReport> {
  const request = await canonicalProgrammeRequest(client, rawRequest);
  const seed = await getTypedItem(client, `${request.id}-seed`, "Generation");
  const configuration = storedLoopConfiguration(seed);
  return runRlLoop(client, coordinates, { ...request, config: configuration as JsonValue });
}

/** Recover a programme embedded in a durable loop seed. */
function storedLoopConfiguration(seed: GetResult): JsonValue {
  const spec = extractGenerationSpec(String(seed.item.body), `Generation ${seed.item.id}`);
  const configuration = jsonObject(spec.training_config, "Loop seed training configuration")["configuration"];
  if (configuration === undefined) fail("The seed stores no loop configuration.", "loop_invalid_training_config");
  return configuration as JsonValue;
}

/** Render compact process-loop outcomes by default; JSON retains complete receipts and resource evidence. */
function loopCommandDetails(context: CommandHandlerContext, report: RlLoopReport | RlLoopStatusReport): Record<string, unknown> {
  if (context.global.json === true || report.process_jobs === undefined) return { ...report };
  return { stop_reason: report.stop_reason, promoted: report.promoted, samples_consumed: report.samples_consumed,
    final_checkpoint: report.final_checkpoint, jobs: report.process_jobs.map((job) => ({ id: job.id, state: job.state, settled: job.settled })) };
}

/** Execute one bounded recursive loop through the public command surface. */
async function runLoop(context: CommandHandlerContext): Promise<RlCommandResult> {
  const id = requiredArgument(context, "a loop id");
  const path = stringOption(context, "file")!;
  const approval = stringOption(context, "approval")!;
  const config = readJsonFile(path, "Loop configuration");
  const cancellation = installCancellationSignals();
  let report: RlLoopReport;
  try {
    report = await runRlLoop(clientFor(context), { pmRoot: context.pm_root, author: authorFor(context) }, { id, config, approval, signal: cancellation.controller.signal });
  } finally {
    removeCancellationSignals(cancellation.handlers);
  }
  return { action: "rl-loop-run", id, details: loopCommandDetails(context, report) };
}

/** Resolve a required corpus directory without leaking missing or invalid filesystem coordinates. */
function corpusDirectory(path: string, kind: "source" | "output_parent"): string {
  try {
    const directory = realpathSync(statePath(path));
    if (!statSync(directory).isDirectory()) fail("Corpus directory is missing or invalid.", `corpus_${kind}_missing`);
    return directory;
  } catch (error: unknown) {
    if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code!)) fail("Corpus directory is missing or invalid.", `corpus_${kind}_missing`);
    throw error;
  }
}

/** Snapshot a selected tracker read-only and publish one exclusive programme file for durable run/resume. */
async function buildCorpusCommand(context: CommandHandlerContext): Promise<RlCommandResult> {
  const output = resolve(stringOption(context, "output")!);
  try {
    if (lstatSync(output, { throwIfNoEntry: false }) !== undefined) fail("Corpus output already exists; choose a new path.", "corpus_output_exists", EXIT_CODE.CONFLICT);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOTDIR") fail("Corpus directory is missing or invalid.", "corpus_output_parent_missing");
    throw error;
  }
  const source = corpusDirectory(resolve(stringOption(context, "from_tracker")!), "source");
  /** Revalidate both the caller's alias and the canonical parent at publication time. */
  const destination = (path: string): string => {
    const parent = corpusDirectory(dirname(path), "output_parent");
    if (`${parent}${sep}`.startsWith(join(source, sep))) fail("Corpus output must be outside the source tracker.", "corpus_output_inside_source", EXIT_CODE.CONFLICT);
    return statePath(parent, basename(path));
  };
  const target = destination(output);
  const bounds = readJsonFile(stringOption(context, "file")!, "Corpus bounds");
  const client = new PmClient({ pmRoot: source, noExtensions: true });
  const corpus = (bounds as Record<string, JsonValue> | null)?.objective === "intake-issue-balanced-v1"
    ? await buildIntakeLoopCorpus(client, bounds, (id) => readFileSync(statePath(source, "history", `${id}.jsonl`), "utf8"))
    : await buildTrackerLoopCorpus(client, bounds);
  destination(output);
  destination(target);
  try {
    await writeFile(target, `${encodeBoundedJson(corpus.programme, MAX_JSON_BYTES - 1, 2)}\n`, { flag: "wx" });
  } catch (error: unknown) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EEXIST") fail("Corpus output already exists; choose a new path.", "corpus_output_exists", EXIT_CODE.CONFLICT);
    if (code === "ENOENT" || code === "ENOTDIR") fail("Corpus directory is missing or invalid.", "corpus_output_parent_missing");
    throw error;
  }
  return { action: "rl-corpus-build", details: { snapshot: corpus.snapshot, training_items: corpus.training_items,
    held_out_items: corpus.held_out_items, ...("held_out_closed" in corpus ? { held_out_closed: corpus.held_out_closed } : { held_out_positive: corpus.held_out_positive }) } };
}

/** Build a commit-pinned public tracker dataset through the installed command contract. */
async function buildDatasetCommand(context: CommandHandlerContext): Promise<RlCommandResult> {
  const first = stringOption(context, "from_trackers")!;
  const directories = [first, ...context.args];
  const dataset = buildTrackerDataset(directories, stringOption(context, "output")!, Number(stringOption(context, "seed", false) ?? "42"), { task: stringOption(context, "task", false) as "history-prefix" | "terminal-disposition" | undefined });
  return { action: "rl-dataset-build", details: { ...dataset } };
}

/** Execute or resume recipe search with the same cancellation boundaries as the inner loop. */
async function runMetaCommand(context: CommandHandlerContext): Promise<RlCommandResult> {
  const id = requiredArgument(context, "a meta-loop id");
  const cancellation = installCancellationSignals();
  let report: MetaReport;
  try {
    report = await runRlMeta(clientFor(context), { pmRoot: context.pm_root, author: authorFor(context) }, {
      id, config: parseMetaConfig(readJsonFile(stringOption(context, "file")!, "Meta configuration")),
      dataset: stringOption(context, "dataset")!, approval: stringOption(context, "approval")!,
      proposer: (stringOption(context, "proposer", false) ?? "seeded") as "seeded" | "decision-model", signal: cancellation.controller.signal,
      forceTakeover: (context.options["force_takeover"] ?? context.options["forceTakeover"]) === true,
    });
  } finally {
    removeCancellationSignals(cancellation.handlers);
  }
  return { action: "rl-meta-run", id, details: { ...report } };
}

/** Build frozen chronological tasks from verified public tracker snapshots. */
async function buildImproverCommand(context: CommandHandlerContext): Promise<RlCommandResult> {
  const manifest = buildImproverDataset([stringOption(context, "from_trackers")!, ...context.args], stringOption(context, "output")!);
  return { action: "rl-improver-build", details: { ...manifest } };
}

/** Execute the two-level improver through the installed CLI with durable cancellation and takeover boundaries. */
async function runImproverCommand(context: CommandHandlerContext): Promise<RlCommandResult> {
  const id = requiredArgument(context, "an improver programme id");
  const cancellation = installCancellationSignals();
  try {
    const report = await runRecursiveImprover(clientFor(context), { pmRoot: context.pm_root, author: authorFor(context) }, {
      id, config: parseImproverConfig(readJsonFile(stringOption(context, "file")!, "Improver programme") as unknown as ImproverConfig),
      dataset: stringOption(context, "dataset")!, approval: stringOption(context, "approval")!, signal: cancellation.controller.signal,
      forceTakeover: (context.options["force_takeover"] ?? context.options["forceTakeover"]) === true,
    });
    return { action: "rl-improver-run", id, details: { ...report } };
  } finally { removeCancellationSignals(cancellation.handlers); }
}

/** Resume one interrupted loop through the public command surface. */
async function resumeLoopCommand(context: CommandHandlerContext): Promise<RlCommandResult> {
  const id = requiredArgument(context, "a loop id");
  const approval = stringOption(context, "approval")!;
  const cancellation = installCancellationSignals();
  let report: RlLoopReport;
  try {
    report = await resumeRlLoop(clientFor(context), { pmRoot: context.pm_root, author: authorFor(context) }, { id, approval, signal: cancellation.controller.signal,
      forceTakeover: (context.options["force_takeover"] ?? context.options["forceTakeover"]) === true });
  } finally {
    removeCancellationSignals(cancellation.handlers);
  }
  return { action: "rl-loop-resume", id, details: loopCommandDetails(context, report) };
}

/** Show one loop's persisted state without mutating anything. */
async function showLoopStatus(context: CommandHandlerContext): Promise<RlCommandResult> {
  const id = requiredArgument(context, "a loop id");
  const report = await rlLoopStatus(clientFor(context), id, context.pm_root);
  return { action: "rl-loop-status", id, details: loopCommandDetails(context, report) };
}

/** Wire SIGINT and SIGTERM into one abort controller so cancellation stops at a phase boundary. */
function installCancellationSignals(): { controller: AbortController; handlers: Array<[NodeJS.Signals, () => void]> } {
  const controller = new AbortController();
  const handlers: Array<[NodeJS.Signals, () => void]> = [];
  for (const name of ["SIGINT", "SIGTERM"] as const) {
    const handler = controllerCallback("signal", (error) => { controller.abort(error); }, () => { controller.abort(); });
    handlers.push([name, handler]);
    process.once(name, handler);
  }
  return { controller, handlers };
}

/** Remove the cancellation signal handlers a command installed. */
function removeCancellationSignals(handlers: ReadonlyArray<readonly [NodeJS.Signals, () => void]>): void {
  for (const [name, handler] of handlers) process.removeListener(name, handler);
}

/** Show one generation and its lineage details. */
async function showGeneration(context: CommandHandlerContext): Promise<RlCommandResult> {
  const id = requiredArgument(context, "a generation id");
  const result = await getTypedItem(clientFor(context), id, "Generation");
  const spec = extractGenerationSpec(String(result.item.body), `Generation ${id}`);
  return {
    action: "rl-generation-show",
    id: String(result.item.id),
    details: {
      seed: spec.seed,
      promoted: spec.promoted,
      parent: spec.parent,
      base_checkpoint: spec.base_checkpoint,
      policy: spec.policy,
      collection_runs: spec.collection_runs,
      environment: spec.environment_version,
      reward_spec_version: spec.reward_spec_version,
      approval: spec.approval,
      proxy_score: spec.proxy_score,
      held_out_score: spec.held_out_score,
      gap: spec.gap,
      promotion_evidence: spec.promotion_evidence,
      ...(spec.evaluation_plan === undefined ? {} : { evaluation_plan: spec.evaluation_plan }),
      ...(spec.evaluation_evidence === undefined ? {} : { evaluation_evidence: spec.evaluation_evidence }),
    },
  };
}

/** Render the generation chain from seed to head(s) with promotion evidence. */
async function renderLineageCommand(context: CommandHandlerContext): Promise<RlCommandResult> {
  const headInput = context.args.find((arg) => !arg.startsWith("-"));
  const formatRaw = stringOption(context, "format", false) ?? "table";
  if (formatRaw !== "table" && formatRaw !== "json") {
    fail(`pm rl lineage --format must be "table" or "json", got "${formatRaw}".`, "invalid_format");
  }
  const gapWindowRaw = stringOption(context, "gap_window", false);
  const gapWindow = gapWindowRaw === undefined ? DEFAULT_GAP_WINDOW : parseGapWindow(gapWindowRaw);
  const client = clientFor(context);
  await ensurePersistentTypes(client);
  let heads: string[];
  if (headInput !== undefined) {
    const requestedHead = operationIdentifier(headInput);
    // Resolved before the tolerant walk. Tolerance exists for an unreadable
    // ANCESTOR; the head the caller named is the request itself, so a missing
    // or wrong-typed head must report that, not an empty ancestry.
    await getTypedItem(client, requestedHead, "Generation");
    heads = [requestedHead];
  } else {
    heads = await findGenerationHeads(client);
  }
  const ancestries: LineageAncestry[] = [];
  // Cache the environment check keyed by environment id so an environment shared
  // across several generations — and across several heads in one view — is
  // fetched and hashed once rather than once per generation per head.
  const envReasonCache = new Map<string, string | null>();
  for (const head of heads) {
    const ancestry = await buildAncestry(client, head, false);
    const seedToHead = [...ancestry].reverse();
    const ownInvalidated = new Map<string, string>();
    for (const entry of seedToHead) {
      let reason = envReasonCache.get(entry.spec.environment_version);
      if (reason === undefined) {
        reason = await environmentInvalidationReason(client, entry.spec.environment_version);
        envReasonCache.set(entry.spec.environment_version, reason);
      }
      if (reason !== null) ownInvalidated.set(entry.id, reason);
    }
    ancestries.push(buildLineageAncestry(seedToHead, ownInvalidated, gapWindow));
  }
  const view: LineageView = { ancestries };
  if (formatRaw === "json") {
    return { action: "rl-lineage", details: { format: "json", view } };
  }
  return { action: "rl-lineage", details: { format: "table", output: renderLineageTable(view), view } };
}

/** The run-body heading under which `rl run start` stores a determinism receipt. */
const RECEIPT_HEADING = "Determinism receipt:";

/**
 * Return the JSON fence text following a body heading, or null when absent.
 *
 * @param body - The item body to search.
 * @param heading - The exact heading text that precedes the fence.
 * @returns The fence's JSON text, or null when the heading or fence is absent.
 */
function fencedSection(body: string, heading: string): string | null {
  // Anchored to a line start: a caller-supplied run configuration can embed the
  // heading's text inside a JSON string value, and an unanchored search would
  // find that impostor first and return the wrong fence.
  const start = body.indexOf(`\n${heading}`);
  if (start < 0) return null;
  return jsonSpecFences(body.slice(start)).next().value ?? null;
}

/** Parsed provenance sections of a Run body written by `rl run start`. */
interface RunBodySections {
  /** The exact environment specification snapshot the run started under. */
  readonly environmentSpec: EnvironmentSpec;
  /** The immutable run configuration the run started with. */
  readonly config: JsonValue;
}

/**
 * Read the environment snapshot and run configuration fences from a Run body.
 *
 * `rl run start` writes both sections as headed JSON fences. A Run whose body
 * lacks either section was not written by pm-rl, and a comparison that
 * silently treated its configuration as empty would report a fabricated
 * config delta — an invented explanation for a real metric difference. Both
 * halves are therefore required and refused when absent or unparseable, naming
 * the run and the missing section.
 *
 * @param body - The Run item body text.
 * @param id - The Run item id, used in refusal messages.
 * @returns The parsed environment specification and run configuration.
 * @throws When either section is missing, or the configuration is not one
 *   parseable JSON object.
 */
function runBodySections(body: string, id: string): RunBodySections {
  const section = (heading: string): string | null => fencedSection(body, heading);
  const environmentJson = section("Environment snapshot:");
  if (environmentJson === null) {
    fail(`Run ${id} has no readable environment snapshot section, so its recorded environment version cannot be compared. Restart the run with pm rl run start to record one.`, "run_body_unreadable", EXIT_CODE.CONFLICT);
  }
  const configJson = section("Run configuration:");
  if (configJson === null) {
    fail(`Run ${id} has no readable run configuration section, so its hyperparameters cannot be compared. Restart the run with pm rl run start to record one.`, "run_body_unreadable", EXIT_CODE.CONFLICT);
  }
  let configParsed: unknown;
  try {
    configParsed = parseBoundedJson(configJson);
  } catch {
    fail(`Run ${id} stores a run configuration that is not valid JSON.`, "run_body_unreadable", EXIT_CODE.CONFLICT);
  }
  return {
    environmentSpec: parseEnvironmentSpec(environmentJson, `Run ${id} environment snapshot`),
    config: jsonObject(configParsed, `Run ${id} run configuration`),
  };
}

/**
 * List every result transitively invalidated by changing one root version.
 *
 * The query is a genuine reachability question over the dependency edges pm
 * already stores — Run→Environment, EvalResult→Run and Benchmark, Transfer→both
 * environments — read once from the inventory and walked directionally toward
 * the items that depend on the root. The walk stays in pm-rl because the
 * host's blast-radius query registers the `related` kind `--dep` records as an
 * undirected relationship: it would cross a Transfer's second environment into
 * another version's runs and report results whose provenance does not derive
 * from the changed version at all. Each invalidated result carries the exact
 * dependency path that reaches it, because "this eval is stale" and "this eval
 * is stale because its run used the environment you just changed" are
 * different statements to an operator deciding what to re-run. `--json` is the
 * host-owned global flag, read from `context.global`.
 */
async function invalidateResults(context: CommandHandlerContext): Promise<RlCommandResult> {
  const id = requiredArgument(context, "an environment or benchmark id");
  const client = clientFor(context);
  await ensurePersistentTypes(client);
  const root = await identifierClient(client).get(id, { depth: "deep" });
  const rootId = String(root.item.id);
  const rootType = String(root.item.type);
  if (rootType !== "Environment" && rootType !== "Benchmark") {
    fail(`pm rl invalidate starts from an environment or benchmark version (${INVALIDATION_ROOT_TYPES.join(", ")}). ${rootId} is ${rootType}, and changing it invalidates no tracked RL result.`, "wrong_invalidation_root", EXIT_CODE.CONFLICT);
  }
  const inventory = await identifierClient(client).list({ status: "all", noTruncate: true, fields: "id,type,dependencies" });
  const items: ItemDependencyEdge[] = [];
  for (const item of inventory.items) {
    // A listed item the SDK types without an id carries no identity to walk
    // from, so it contributes no edge rather than failing the whole view. The
    // projected `dependencies` column is typed `unknown` by the SDK's field
    // projection, so the stored entries are narrowed to the ids the walk reads.
    if (item.id === undefined) continue;
    const dependencies = item.dependencies as readonly { readonly id: string }[] | null | undefined;
    items.push({ id: item.id, type: String(item.type), targets: (dependencies ?? []).map((dependency) => dependency.id.trim()) });
  }
  const invalidated = transitiveInvalidation(rootId, items);
  const details: Record<string, unknown> = {
    root: rootId,
    root_type: rootType,
    result_types: [...INVALIDATED_RESULT_TYPES],
    count: invalidated.length,
    invalidated,
  };
  if (context.global.json === true) {
    return { action: "rl-invalidate", id: rootId, details: { format: "json", ...details } };
  }
  return { action: "rl-invalidate", id: rootId, details: { format: "table", output: renderInvalidateReport(rootId, rootType, invalidated), ...details } };
}

/**
 * Diff two runs' metrics over their common step range with the config delta.
 *
 * Comparability is refused, not warned about, in two cases: when either run
 * records no environment the comparison is undecidable, and when the runs
 * recorded different environment versions the metric diff would launder the
 * version change into an apparent improvement. Both refusals name both runs
 * and both environments explicitly, mirroring the package's other fail-closed
 * gates. `--json` is the host-owned global flag, read from `context.global`.
 */
async function compareRuns(context: CommandHandlerContext): Promise<RlCommandResult> {
  const positional = context.args.filter((argument) => !argument.startsWith("-")).map((argument) => argument.trim());
  if (positional.length < 2 || positional.some((argument) => argument.length === 0)) {
    fail("pm rl compare requires two run ids: the baseline run and the candidate run.", "missing_argument");
  }
  const [baselineId, candidateId] = positional;
  const client = clientFor(context);
  await ensurePersistentTypes(client);
  const baseline = await getTypedItem(client, baselineId, "Run");
  const candidate = await getTypedItem(client, candidateId, "Run");
  const baselineEnvironment = normalizeRunEnvironment(baseline.item.environment);
  const candidateEnvironment = normalizeRunEnvironment(candidate.item.environment);
  if (typeof baselineEnvironment !== "string" || baselineEnvironment.length === 0 || typeof candidateEnvironment !== "string" || candidateEnvironment.length === 0) {
    fail(`pm rl compare refuses to compare runs whose environment version is not recorded: ${baselineId} records ${String(baselineEnvironment)} and ${candidateId} records ${String(candidateEnvironment)}. Comparability is undecidable without the environment each run measured under; restart both runs with pm rl run start.`, "run_environment_unrecorded", EXIT_CODE.CONFLICT);
  }
  if (baselineEnvironment !== candidateEnvironment) {
    fail(`pm rl compare refuses to compare runs from different environment versions: ${baselineId} ran under ${baselineEnvironment} and ${candidateId} ran under ${candidateEnvironment}. A metric difference across environment versions launders the version change into an apparent improvement; compare runs within one environment version instead.`, "environment_version_mismatch", EXIT_CODE.CONFLICT);
  }
  const readRun = async (item: GetResult): Promise<RunCompareInput> => {
    const runId = String(item.item.id);
    const sections = runBodySections(String(item.item.body), runId);
    const component = item.item.component;
    return {
      id: runId,
      algorithm: typeof component === "string" ? component : "",
      environment: normalizeRunEnvironment(item.item.environment) as string,
      events: readSeries((await readCompleteNotes(client, runId)).map((note) => note.text)).events,
      environmentSpec: sections.environmentSpec,
      config: sections.config,
    };
  };
  const view = buildCompareView(await readRun(baseline), await readRun(candidate));
  if (context.global.json === true) {
    return { action: "rl-compare", details: { format: "json", ...view } };
  }
  return { action: "rl-compare", details: { format: "table", output: renderCompareReport(view), ...view } };
}

/**
 * Refuse to plan over a live item or a deleted identity whose history stream
 * still reserves the id.
 *
 * pm-cli 2026.9.5 keeps a deleted item's history file, so creating the same id
 * fails with item_identity_reserved. Checking get then history before any writes
 * keeps that host error from leaking after sibling arms have already been minted.
 *
 * @param client - Client bound to the target workspace.
 * @param id - Requested item id, resolved by the host the same way create is.
 * @param type - Live item type expected when the id still exists.
 * @param existsCode - Typed code when a live item occupies the id.
 * @param reservedCode - Typed code when only the history stream remains.
 * @param existsMessage - Operator-facing refusal for the live case.
 * @param reservedMessage - Operator-facing refusal for the reserved case.
 */
async function refuseTakenPlanIdentity(
  client: PmClient,
  id: string,
  type: "Sweep" | "Run",
  existsCode: string,
  reservedCode: string,
  existsMessage: string,
  reservedMessage: string,
): Promise<void> {
  try {
    await getTypedItem(client, id, type);
    fail(existsMessage, existsCode, EXIT_CODE.CONFLICT);
  } catch (error) {
    if (!isItemNotFound(error)) throw error;
  }
  try {
    await identifierClient(client).run("history", { id });
    fail(reservedMessage, reservedCode, EXIT_CODE.CONFLICT);
  } catch (error) {
    if (!isItemNotFound(error)) throw error;
  }
}

/**
 * Remove the arm runs an interrupted sweep plan already wrote.
 *
 * A partial sweep leaves orphaned child runs that later reads would treat as
 * real arms, so every arm written before the failure is deleted. Deleting does
 * not free those identities: the host keeps the history stream, and a retry must
 * plan a new sweep id rather than remint the same arms. A removal that itself
 * fails is refused with both causes named — the removal failure first, then the
 * original create failure — because silent orphans are precisely what the
 * cleanup exists to prevent.
 *
 * @param client - Client bound to the target workspace.
 * @param arms - The resolved ids of the arms written so far.
 * @param cause - The original failure that interrupted the plan, named in the
 *   refusal when a removal itself fails.
 * @returns When every arm was removed; the caller then rethrows its own cause.
 * @throws {sweep_cleanup_failed} When any removal fails, naming both causes.
 */
export async function removePlannedArms(client: PmClient, arms: ReadonlyArray<{ id: string }>, cause: unknown): Promise<void> {
  for (const arm of arms) {
    try {
      await identifierClient(client).delete(arm.id, { force: true });
    } catch (removeError) {
      fail(
        `${String(removeError)} — and removing the partially planned arm ${arm.id} also failed while recovering from ${String(cause)}, so the sweep has orphaned arms that must be deleted before it can be re-planned.`,
        "sweep_cleanup_failed",
        EXIT_CODE.CONFLICT,
      );
    }
  }
}

/**
 * Expand a declared search space into one child Run per arm.
 *
 * Arms are ordinary Runs — same environment snapshot and configuration body a
 * hand-started run gets, plus the arm's expanded hyperparameters as the run
 * configuration — so two agents can advance two arms on two branches and merge.
 * The Sweep item stores the space, the rule, and the planned arm list; nothing
 * about the plan is inferred later from naming conventions.
 */
async function planSweep(context: CommandHandlerContext): Promise<RlCommandResult> {
  const requestedId = requiredArgument(context, "a sweep id");
  const path = stringOption(context, "file")!;
  const environmentId = stringOption(context, "environment")!;
  const algorithm = stringOption(context, "algorithm")!;
  const spaceRaw = readJsonFile(path, "Search space");
  if (spaceRaw === null || typeof spaceRaw !== "object" || Array.isArray(spaceRaw)) {
    fail(`Search space ${path} must contain one JSON object with search_space and selection_rule.`, "invalid_search_space_file");
  }
  const spaceRecord = spaceRaw as Record<string, JsonValue>;
  const spaceRawSpace = spaceRecord["search_space"];
  if (spaceRawSpace === null || typeof spaceRawSpace !== "object" || Array.isArray(spaceRawSpace)) {
    fail(`Search space file ${path} requires a search_space object of hyperparameter to candidate values.`, "invalid_search_space");
  }
  const ruleRaw = spaceRecord["selection_rule"];
  if (typeof ruleRaw !== "string") {
    fail(`Search space file ${path} requires a string selection_rule ("none" or max_final:<metric> / min_final:<metric>).`, "invalid_selection_rule");
  }
  // Validated BEFORE anything is written: an unplanable rule must not leave a
  // half-registered sweep or partial arms behind.
  const selectionRule = parseSelectionRule(ruleRaw);
  const client = clientFor(context);
  await ensurePersistentTypes(client);
  const verifiedEnvironment = await verifyEnvironmentIdentity(client, environmentId, "sweep arms");
  const configs = expandSearchSpace(spaceRawSpace as Record<string, JsonValue[]>);
  if (configs.length === 0) {
    fail(`Search space file ${path} declares no dimensions, so there is no arm to plan.`, "invalid_search_space");
  }
  const specHash = hashJson(verifiedEnvironment.spec);
  // Every id the plan will write is checked before any create runs — the sweep
  // item itself AND every arm, live or reserved by history — so a re-plan
  // refuses without leaving a partially expanded sweep behind. Checking history
  // after a 404 is load-bearing: a deleted sweep still owns its stream, and
  // creating arms first would mint a fresh set of identities only to fail on
  // the reserved sweep id and then reserve those arms during cleanup.
  await refuseTakenPlanIdentity(
    client,
    requestedId,
    "Sweep",
    "sweep_exists",
    "sweep_reserved",
    `Sweep ${requestedId} already exists. Plan a new sweep id instead of re-arming an existing sweep.`,
    `Sweep ${requestedId} is reserved by an existing history stream. Plan a new sweep id instead of reminting a deleted sweep.`,
  );
  const armIds = configs.map((_, index) => `${requestedId}-arm-${index + 1}`);
  for (const armId of armIds) {
    await refuseTakenPlanIdentity(
      client,
      armId,
      "Run",
      "sweep_arm_exists",
      "sweep_arm_reserved",
      `Arm run ${armId} already exists; sweep ${requestedId} is already planned. Plan a new sweep id instead.`,
      `Arm run ${armId} is reserved by an existing history stream; sweep ${requestedId} cannot be re-planned under this id. Plan a new sweep id instead.`,
    );
  }
  const arms: Array<{ id: string; config: JsonValue }> = [];
  try {
    for (const [index, config] of configs.entries()) {
      const armId = armIds[index]!;
      const result = await identifierClient(client).create({
        id: armId,
        title: armId,
        type: "Run",
        status: "in_progress",
        acceptanceCriteria: `Sweep arm ${index + 1} retains its exact environment and hyperparameter identities; its metrics are history appends independent of every other arm.`,
        estimatedMinutes: "1",
        body: `# ${armId}\n\nAlgorithm: ${algorithm}\n\nEnvironment snapshot:\n\n\`\`\`json\n${encodeBoundedJson(verifiedEnvironment.spec, undefined, 2)}\n\`\`\`\n\nRun configuration:\n\n\`\`\`json\n${encodeBoundedJson(config, undefined, 2)}\n\`\`\``,
        dep: [verifiedEnvironment.id],
        environment: verifiedEnvironment.id,
        affectedVersion: specHash,
        component: algorithm,
        fixedVersion: hashJson(config),
        message: `Plan RL sweep arm ${index + 1}`,
      });
      // Report the RESOLVED id: the host scopes created ids under its alias.
      arms.push({ id: String(result.item.id), config });
    }
  } catch (error) {
    // A mid-plan failure must not leave orphaned arm runs that later reads would
    // treat as real children. Remove everything this invocation wrote, then let
    // the original cause surface.
    await removePlannedArms(client, arms, error);
    throw error;
  }
  const spec: SweepSpec = {
    search_space: spaceRawSpace as Record<string, JsonValue[]>,
    selection_rule: selectionRule,
    algorithm,
    environment_id: verifiedEnvironment.id,
    environment_spec_hash: specHash,
    arms,
  };
  const sweepHash = hashJson(spec as unknown as JsonValue);
  // The sweep create sits under the same cleanup contract as the arms: if it
  // fails AFTER the arms exist, a retry under the same id would hit the arm
  // pre-check and could never complete. Remove the arms this invocation wrote,
  // then let the original cause surface.
  let sweepResult;
  try {
    sweepResult = await identifierClient(client).create({
      id: requestedId,
      title: requestedId,
      type: "Sweep",
      status: "open",
      acceptanceCriteria: "The sweep retains its declared space, selection rule, and planned arms; its children are independent runs.",
      estimatedMinutes: "1",
      body: `# ${requestedId}\n\n\`\`\`json\n${encodeBoundedJson(spec, undefined, 2)}\n\`\`\``,
      dep: [verifiedEnvironment.id],
      affectedVersion: sweepHash,
      fixedVersion: algorithm,
      component: verifiedEnvironment.id,
      message: "Plan RL sweep",
    });
  } catch (error) {
    await removePlannedArms(client, arms, error);
    throw error;
  }
  return {
    action: "rl-sweep-plan",
    id: String(sweepResult.item.id),
    created: true,
    details: {
      arms: arms.map((arm) => arm.id),
      selection_rule: selectionRule.kind === "none" ? "none" : `${selectionRule.kind}:${selectionRule.metric}`,
      environment_id: verifiedEnvironment.id,
      spec_hash: sweepHash,
    },
  };
}

/**
 * Report per-arm progress and the selection rule's current verdict.
 *
 * Progress is read live from each child run's metric history. The winner is
 * named only when the stored rule supports one AND at least one arm has measured
 * the selection metric; otherwise status states exactly why no verdict exists.
 */
async function showSweepStatus(context: CommandHandlerContext): Promise<RlCommandResult> {
  const id = requiredArgument(context, "a sweep id");
  const client = clientFor(context);
  await ensurePersistentTypes(client);
  const sweep = await getTypedItem(client, id, "Sweep");
  const resolvedId = String(sweep.item.id);
  let specText: string | null;
  try {
    specText = storedJson(String(sweep.item.body), resolvedId, "sweep_missing_spec");
  } catch {
    fail(`Sweep ${resolvedId} has no readable specification fence and cannot report status.`, "sweep_unreadable", EXIT_CODE.CONFLICT);
  }
  const spec = parseSweepSpec(specText, `Sweep ${resolvedId} specification`);
  const selectionMetric = spec.selection_rule.kind === "none" ? null : spec.selection_rule.metric;
  const arms = [];
  for (const arm of spec.arms) {
    const run = await getTypedItem(client, arm.id, "Run");
    const series = readSeries((await readCompleteNotes(client, arm.id)).map((note) => note.text));
    // Latest value per step of the selection metric; the final value is the one
    // at the highest measured step.
    const stepsByMetric = new Map<number, number>();
    for (const event of series.events) {
      if (selectionMetric !== null && event.metric === selectionMetric) {
        stepsByMetric.set(event.step, event.value);
      }
    }
    const finalStep = series.events.reduce((max, event) => Math.max(max, event.step), -1);
    const finalEntry = [...stepsByMetric.entries()].sort(([left], [right]) => left - right).at(-1);
    arms.push({
      id: arm.id,
      config: arm.config,
      status: String(run.item.status),
      metric_events: series.events.length,
      last_step: finalStep < 0 ? null : finalStep,
      final_value: finalEntry === undefined ? null : finalEntry[1],
    });
  }
  const view = { sweep: resolvedId, ...buildSweepStatus(spec.selection_rule, arms) };
  if (context.global.json === true) {
    return { action: "rl-sweep-status", id: resolvedId, details: { format: "json", ...view } };
  }
  return { action: "rl-sweep-status", id: resolvedId, details: { format: "table", output: renderSweepStatus(view), ...view } };
}

/**
 * Record one sim-to-real transfer measurement.
 *
 * The transfer depends on BOTH environment versions and the checkpoint through
 * typed edges, so an edit to either side invalidates it through `pm rl
 * invalidate` with no new machinery. Both environments are re-verified against
 * their content identities at write time — a measurement backed by a mutated
 * specification is refused rather than recorded.
 */
async function recordTransfer(context: CommandHandlerContext): Promise<RlCommandResult> {
  const requestedId = identifier(requiredArgument(context, "a transfer id"));
  const sourceId = stringOption(context, "source")!;
  const targetId = stringOption(context, "target")!;
  const checkpoint = identifier(stringOption(context, "checkpoint")!, "artifact");
  const runId = stringOption(context, "run")!;
  const metricsPath = stringOption(context, "metrics")!;
  const client = clientFor(context);
  await ensurePersistentTypes(client);
  // Verified before the metrics are even parsed so a broken environment is the
  // first refusal reported.
  const source = await verifyEnvironmentIdentity(client, sourceId, "transfers");
  const target = await verifyEnvironmentIdentity(client, targetId, "transfers");
  // Compared on RESOLVED identities, not raw flags: pm resolves aliases, so two
  // different inputs can name one environment, and measuring an environment
  // against itself would record a gap that is zero by construction.
  if (source.id === target.id) {
    fail(`pm rl transfer record requires two DIFFERENT environments; ${source.id} cannot be both the simulator and the deployment side of a gap.`, "degenerate_transfer", EXIT_CODE.CONFLICT);
  }
  const run = await getTypedItem(client, runId, "Run");
  const resolvedRunId = String(run.item.id);
  const gaps = parseTransferMetrics(readTextFile(metricsPath, "Transfer metrics"), `Transfer metrics ${metricsPath}`);
  const spec: TransferSpec = {
    source_environment_id: source.id,
    target_environment_id: target.id,
    checkpoint,
    run_id: resolvedRunId,
    gaps,
  };
  const result = await identifierClient(client).create({
    id: requestedId,
    title: `Sim-to-real gap at ${checkpoint.slice(0, 16)}`,
    type: "Transfer",
    status: "open",
    acceptanceCriteria: "The transfer traces to both exact environment versions, its source run, and its checkpoint, with every measured metric finite and named.",
    estimatedMinutes: "1",
    body: `# ${requestedId}\n\n\`\`\`json\n${encodeBoundedJson(spec, undefined, 2)}\n\`\`\``,
    dep: [
      `id=${source.id},kind=related,source_kind=${TRANSFER_SOURCE_ENVIRONMENT}`,
      `id=${target.id},kind=related,source_kind=${TRANSFER_TARGET_ENVIRONMENT}`,
      `id=${resolvedRunId},kind=discovered_from,source_kind=${TRANSFER_RUN}`,
    ],
    environment: source.id,
    affectedVersion: hashJson(spec as unknown as JsonValue),
    fixedVersion: checkpoint,
    component: target.id,
    message: "Record sim-to-real transfer measurement",
  });
  return {
    action: "rl-transfer-record",
    id: String(result.item.id),
    created: true,
    details: {
      source_environment_id: source.id,
      target_environment_id: target.id,
      run_id: resolvedRunId,
      checkpoint,
      metrics: gaps.map((gap) => gap.metric),
    },
  };
}

/**
 * Report the per-metric gap series across one run's transfers.
 *
 * Transfers are ordered by recording time (item id breaking ties within one
 * instant). A transfer whose source or target environment no longer resolves to
 * its content identity is reported as STALE with the reason, excluded from every
 * series — a gap whose provenance went stale must not be plotted beside fresh
 * ones, where it would quietly manufacture or flatten a trend.
 */
async function showTransferGap(context: CommandHandlerContext): Promise<RlCommandResult> {
  const id = requiredArgument(context, "a run id");
  const client = clientFor(context);
  await ensurePersistentTypes(client);
  const run = await getTypedItem(client, id, "Run");
  const resolvedRunId = String(run.item.id);
  const entries: Array<{ id: string; created_at: string; spec: TransferSpec; stale_reason: string | null }> = [];
  const stalenessCache = new Map<string, string | null>();
  for (const item of (await identifierClient(client).list({ type: "Transfer", status: "all", noTruncate: true, fields: "id,body,created_at" })).items) {
    // A listed item without an id carries no identity to plot or name.
    if (item.id === undefined) continue;
    let specText: string;
    try {
      specText = storedJson(String(item.body), `Transfer ${item.id}`, "transfer_missing_spec");
    } catch {
      fail(`Transfer ${item.id} has no readable specification fence and cannot enter the gap series.`, "transfer_unreadable", EXIT_CODE.CONFLICT);
    }
    const spec = parseTransferSpec(specText, `Transfer ${item.id} specification`);
    if (spec.run_id !== resolvedRunId) continue;
    // Either side going stale breaks the whole measurement: half of a gap is
    // not half a data point. Reasons are cached per environment id because a
    // run's transfers normally share one source and one target.
    for (const envId of [spec.source_environment_id, spec.target_environment_id]) {
      if (!stalenessCache.has(envId)) {
        stalenessCache.set(envId, await environmentInvalidationReason(client, envId));
      }
    }
    const staleReason = stalenessCache.get(spec.source_environment_id) ?? stalenessCache.get(spec.target_environment_id) ?? null;
    entries.push({ id: String(item.id), created_at: String(item.created_at), spec, stale_reason: staleReason });
  }
  const report = buildTransferGapReport(entries);
  if (context.global.json === true) {
    return { action: "rl-transfer-gap", id: resolvedRunId, details: { format: "json", ...report } };
  }
  return { action: "rl-transfer-gap", id: resolvedRunId, details: { format: "table", output: renderTransferGapReport(resolvedRunId, report), ...report } };
}

/** Commands authored separately so activation and tests share one exact contract. */
export const RL_COMMANDS = [
  defineCommand({ name: "rl policy-card export", description: "Export a minimized policy explanation with replayable evidence digests.", arguments: [{ name: "subject", required: true, description: "Generation or completed recursive-step id." }], flags: [{ long: "--selection", value_name: "index", value_type: "string", description: "Zero-based proposed candidate index for a proposal phase." }], run: async (context) => {
    const selection = stringOption(context, "selection", false);
    return { action: "rl-policy-card-export", details: { ...await exportPolicyCard(clientFor(context), requiredArgument(context, "a policy subject"), selection === undefined ? null : Number(selection)) } };
  } }),
  defineCommand({ name: "rl policy-card replay", description: "Verify every cited historical result and reconstruct a portable explanation.", flags: [{ long: "--file", value_name: "path", value_type: "string", required: true, description: "Unwrapped policy card JSON." }], run: async (context) => {
    const result = await replayPolicyCard(clientFor(context), readJsonFile(stringOption(context, "file")!, "Policy card"));
    return { action: "rl-policy-card-replay", details: { digest: result.card.digest, results: result.results } };
  } }),
  defineCommand({ name: "rl policy-card adopt", description: "Check current policy suitability; normal backend consent and promotion gates remain required.", flags: [{ long: "--file", value_name: "path", value_type: "string", required: true, description: "Unwrapped policy card JSON." }], run: async (context) => ({ action: "rl-policy-card-adopt", details: { digest: (await adoptPolicyCard(clientFor(context), readJsonFile(stringOption(context, "file")!, "Policy card"))).digest, suitable: true } }) }),
  defineCommand({ name: "rl corpus build", description: "Seal a read-only tracker snapshot into a Git-independent recursive status-recognition programme.", flags: [
    { long: "--from-tracker", value_name: "directory", value_type: "string", required: true, description: "Explicitly selected local tracker root; never modified." },
    { long: "--file", value_name: "path", value_type: "string", required: true, description: "Bounded loop JSON without environment, training or evaluation fields." },
    { long: "--output", value_name: "path", value_type: "string", required: true, description: "New sealed programme JSON; existing files refuse overwrite." },
  ], run: buildCorpusCommand }),
  defineCommand({ name: "rl checkpoint show", description: "Verify and load a checkpoint from its SHA-256 artifact digest and promotion ledger.", arguments: [{ name: "digest", required: true, description: "SHA-256 artifact digest." }], run: async (context) => ({ action: "rl-checkpoint-show", details: inspectCheckpointArtifact(context.pm_root, requiredArgument(context, "an artifact digest", "digest")) }) }),
  defineCommand({ name: "rl checkpoint gc", description: "Collect checkpoint blobs unreachable from the promotion/audit ledger.", run: async (context) => ({ action: "rl-checkpoint-gc", details: await collectCheckpointArtifacts(context.pm_root) }) }),
  defineCommand({ name: "rl improver build", description: "Freeze chronological balanced public tracker tasks for recursive proposal-policy evaluation.", arguments: [{ name: "directories", variadic: true, description: "Additional tracker directories." }], flags: [
    { long: "--from-trackers", value_name: "directory", value_type: "string", required: true, description: "First copied public tracker directory." },
    { long: "--output", value_name: "directory", value_type: "string", required: true, description: "New dataset directory." },
  ], run: buildImproverCommand }),
  defineCommand({ name: "rl improver run", description: "Resume learner proposals and ledger-driven improver promotion under an existing resource Decision.", arguments: [{ name: "id", required: true, description: "Stable improver programme id." }], flags: [
    { long: "--file", value_name: "path", value_type: "string", required: true, description: "Bounded improver programme JSON." },
    { long: "--dataset", value_name: "directory", value_type: "string", required: true, description: "Frozen improver dataset." },
    { long: "--approval", value_name: "decision", value_type: "string", required: true, description: "Existing CPU resource allowance Decision." },
    { long: "--force-takeover", description: "Audit recovery of an ambiguous controller holder." },
  ], run: runImproverCommand }),
  defineCommand({ name: "rl dataset build", description: "Build a public MIT tracker-history dataset with repository-isolated train, meta-validation and final-test splits.", arguments: [{ name: "directories", variadic: true, description: "Additional tracker directories." }], flags: [
    { long: "--from-trackers", value_name: "directory", value_type: "string", required: true, description: "First tracker directory; append additional directories as arguments." },
    { long: "--task", value_name: "kind", value_type: "string", description: "terminal-disposition (default) or history-prefix time-to-close with training-only calibration." },
    { long: "--output", value_name: "directory", value_type: "string", required: true, description: "New dataset output directory." },
    { long: "--seed", value_name: "number", value_type: "string", description: "Repository split seed, default 42." },
  ], run: buildDatasetCommand }),
  defineCommand({ name: "rl meta run", description: "Execute or resume bounded recipe search under one existing approval Decision.", arguments: [{ name: "id", required: true, description: "Stable meta programme id." }], flags: [
    { long: "--file", value_name: "path", value_type: "string", required: true, description: "Bounded meta programme JSON." },
    { long: "--dataset", value_name: "directory", value_type: "string", required: true, description: "Sealed dataset directory." },
    { long: "--approval", value_name: "decision", value_type: "string", required: true, description: "Pre-approved shared resource and recipe budget Decision." },
    { long: "--proposer", value_name: "kind", value_type: "string", description: "seeded (default) or decision-model with local tev1:4b and seeded fallback." },
    { long: "--force-takeover", description: "Audit recovery of an ambiguous outer lease; verified live or unverifiable holders still block." },
  ], run: runMetaCommand }),
  defineCommand({ name: "rl env register", description: "Register an immutable, content-addressed environment JSON specification.", flags: [{ long: "--file", value_name: "path", value_type: "string", required: true, description: "Environment JSON file." }], run: registerEnvironment }),
  defineCommand({ name: "rl env list", description: "List registered RL environment versions without their large bodies.", run: listEnvironments }),
  defineCommand({ name: "rl env show", description: "Show one registered environment and its specification identity.", arguments: [{ name: "id", required: true, description: "Environment item id." }], run: showEnvironment }),
  defineCommand({ name: "rl benchmark register", description: "Register an immutable benchmark suite and typed contamination edges.", flags: [
    { long: "--file", value_name: "path", value_type: "string", required: true, description: "Benchmark JSON file." },
    { long: "--contaminated-by", value_name: "environment-ids", value_type: "string", description: "Comma-separated environment versions whose training data overlaps the suite." },
  ], run: registerBenchmark }),
  defineCommand({ name: "rl shadow register", description: "Reserve consented online observation and both-arm budgets before candidate collection.", flags: [
    { long: "--file", value_name: "path", value_type: "string", required: true, description: "JSON with deployment and predeclared plan." },
  ], run: async (context) => {
    const value = jsonObject(readJsonFile(stringOption(context, "file")!, "Shadow deployment"), "Shadow deployment");
    const report = await registerShadowDeployment(clientFor(context), value.deployment, value.plan);
    return { action: "rl-shadow-register", id: report.id, details: { ...report } };
  } }),
  defineCommand({ name: "rl shadow observe", description: "Record one active and candidate decision; a failed candidate never replaces the active action.", arguments: [{ name: "candidate", required: true, description: "Candidate generation id." }], flags: [
    { long: "--file", value_name: "path", value_type: "string", required: true, description: "One consented input and bounded observed rewards JSON." },
  ], run: async (context) => {
    const client = clientFor(context); const item = await getTypedItem(client, requiredArgument(context, "a candidate id"), "Generation");
    const report = await observeShadow(client, String(item.item.id), readJsonFile(stringOption(context, "file")!, "Shadow input"));
    return { action: "rl-shadow-observe", id: report.id, details: { ...report } };
  } }),
  defineCommand({ name: "rl shadow compare", description: "Seal the validated shadow outcome comparison required by existing generation promotion.", arguments: [{ name: "candidate", required: true, description: "Candidate generation id." }], run: async (context) => {
    const client = clientFor(context); const item = await getTypedItem(client, requiredArgument(context, "a candidate id"), "Generation");
    const report = await compareShadow(client, String(item.item.id));
    return { action: "rl-shadow-compare", id: report.receipt, details: { ...report } };
  } }),
  defineCommand({ name: "rl eval plan register", description: "Predeclare a fixed cohort and correlation units before candidate collection.", flags: [
    { long: "--file", value_name: "path", value_type: "string", required: true, description: "Evaluation plan JSON." },
  ], run: async (context) => {
    const registered = await registerEvaluationPlan(clientFor(context), readJsonFile(stringOption(context, "file")!, "Evaluation plan"));
    return { action: "rl-eval-plan-register", id: registered.id, details: { comparison: registered.comparison, observations: registered.plan.stopping.observations, independent_units: registered.plan.stopping.independent_units, protected_cohorts: registered.plan.protected_cohorts?.length ?? 0 } };
  } }),
  defineCommand({ name: "rl eval plan show", description: "Show compact predeclared comparison identity and declared stopping sizes.", arguments: [{ name: "candidate", required: true, description: "Reserved candidate generation id." }], run: async (context) => {
    const client = clientFor(context);
    const prefix = String((await identifierClient(client).config("project", "get", "id_prefix")).nested_setting!.value);
    const registered = await readEvaluationPlan(client, canonicalizeIdentifier(requiredArgument(context, "a candidate id"), prefix));
    if (registered === null) fail("No predeclared plan. Register one before creating a fresh candidate.", "eval_plan_missing", EXIT_CODE.CONFLICT);
    return { action: "rl-eval-plan-show", id: registered.id, details: { comparison: registered.comparison, candidate: registered.plan.candidate, incumbent: registered.plan.incumbent, stopping: registered.plan.stopping, protected_cohorts: registered.plan.protected_cohorts?.length ?? 0 } };
  } }),
  defineCommand({ name: "rl eval plan advance", description: "Seal or resume the next reviewed sequential boundary from cumulative paired observations.", arguments: [{ name: "candidate", required: true, description: "Reserved candidate generation id." }], flags: [
    { long: "--file", value_name: "path", value_type: "string", required: true, description: "Cumulative paired observation array JSON." },
  ], run: async (context) => {
    const client = clientFor(context); const item = await getTypedItem(client, requiredArgument(context, "a candidate id"), "Generation");
    const report = await recordSequentialEvaluation(client, String(item.item.id), readJsonFile(stringOption(context, "file")!, "Sequential observations"));
    return { action: "rl-eval-plan-advance", id: report.plan, details: { ...report } };
  } }),
  defineCommand({ name: "rl eval plan resume", description: "Read and revalidate the latest sequential checkpoint without adding observations.", arguments: [{ name: "candidate", required: true, description: "Reserved candidate generation id." }], run: async (context) => {
    const client = clientFor(context); const item = await getTypedItem(client, requiredArgument(context, "a candidate id"), "Generation");
    const report = await readSequentialEvaluation(client, String(item.item.id));
    if (report === null) fail("No owned sequential checkpoint. Advance the first declared look or use a fresh candidate if a foreign checkpoint was skipped.", "eval_plan_missing", EXIT_CODE.CONFLICT);
    return { action: "rl-eval-plan-resume", id: report.plan, details: { ...report } };
  } }),
  defineCommand({ name: "rl eval plan evaluate", description: "Seal one paired evaluation and enforce aggregate improvement plus protected cohort guardrails.", arguments: [{ name: "candidate", required: true, description: "Reserved candidate generation id." }], flags: [
    { long: "--file", value_name: "path", value_type: "string", required: true, description: "Paired observation array JSON." },
  ], run: async (context) => {
    const client = clientFor(context); const id = requiredArgument(context, "a candidate id");
    const item = await getTypedItem(client, id, "Generation");
    const report = await recordPlanEvaluation(client, String(item.item.id), readJsonFile(stringOption(context, "file")!, "Paired observations"));
    return { action: "rl-eval-plan-evaluate", id: report.plan, details: { ...report } };
  } }),
  defineCommand({ name: "rl eval record", description: "Record one immutable checkpoint verdict linked to its source run and benchmark.", flags: [
    { long: "--run", value_name: "id", value_type: "string", required: true, description: "Source Run item id." },
    { long: "--benchmark", value_name: "id", value_type: "string", required: true, description: "Benchmark item id." },
    { long: "--checkpoint", value_name: "hash", value_type: "string", required: true, description: "Content-addressed checkpoint identity." },
    { long: "--score", value_name: "number", value_type: "string", required: true, description: "Finite scalar score." },
    { long: "--passed", value_name: "true|false", value_type: "string", required: true, description: "Pass-criteria verdict." },
  ], run: recordEvalResult }),
  defineCommand({ name: "rl leaderboard", description: "Rank one benchmark's fully traced results, refusing mixed environments or contamination.", arguments: [{ name: "benchmark", required: true, description: "Benchmark item id." }], run: showLeaderboard }),
  defineCommand({ name: "rl run start", description: "Start an attributable run linked to one exact environment version.", arguments: [{ name: "id", required: true, description: "Run item id." }], flags: [
    { long: "--environment", value_name: "id", value_type: "string", required: true, description: "Environment item id." },
    { long: "--algorithm", value_name: "name", value_type: "string", required: true, description: "Training algorithm." },
    { long: "--config-file", value_name: "path", value_type: "string", description: "Optional JSON configuration." },
    { long: "--receipt-file", value_name: "path", value_type: "string", description: "Optional determinism receipt JSON to record at start so `rl run verify` can re-derive it later." },
  ], run: startRun }),
  defineCommand({ name: "rl run log", description: "Append NDJSON metric events from --file or stdin to merge-safe run notes.", arguments: [{ name: "id", required: true, description: "Run item id." }], flags: [{ long: "--file", value_name: "path", value_type: "string", description: "NDJSON file; omit to read stdin." }], run: logRun }),
  defineCommand({ name: "rl run verify", description: "Re-derive a run's determinism receipt and report the difference, without mutating anything.", arguments: [{ name: "id", required: true, description: "Run item id." }], flags: [
    { long: "--receipt-file", value_name: "path", value_type: "string", required: true, description: "Freshly derived determinism receipt JSON." },
  ], run: verifyRun }),
  defineCommand({ name: "rl run show", description: "Read and order a run's metric series from append-only notes.", arguments: [{ name: "id", required: true, description: "Run item id." }], run: showRun }),
  defineCommand({ name: "rl run finish", description: "Finish a run without rewriting its metric history.", arguments: [{ name: "id", required: true, description: "Run item id." }], flags: [{ long: "--reason", value_name: "text", value_type: "string", required: true, description: "Why the run ended." }], run: finishRun }),
  defineCommand({ name: "rl generation register", description: "Register a policy generation (seed or candidate) with content-addressed provenance.", arguments: [{ name: "id", required: true, description: "Generation item id." }], flags: [
    { long: "--base-checkpoint", value_name: "hash", value_type: "string", required: true, description: "Content-addressed base checkpoint identity." },
    { long: "--parent", value_name: "id", value_type: "string", description: "Parent generation id; omit for the seed generation." },
    { long: "--policy", value_name: "hash", value_type: "string", description: "Content-addressed policy that collected the training data; required for a non-seed, optional for a seed (an empty seed policy skips the run-policy check for its candidates)." },
    { long: "--collection-runs", value_name: "ids", value_type: "string", description: "Comma-separated collection run ids (required for non-seed)." },
    { long: "--environment", value_name: "id", value_type: "string", description: "Environment item id used by the collection runs (required for non-seed)." },
    { long: "--config-file", value_name: "path", value_type: "string", description: "Optional JSON training configuration." },
  ], run: registerGeneration }),
  defineCommand({ name: "rl generation promote", description: "Promote a candidate generation after contamination and budget checks pass.", arguments: [{ name: "id", required: true, description: "Generation item id." }], flags: [
    { long: "--approval", value_name: "id", value_type: "string", required: true, description: "Approval Decision item id stating the permitted promotion count." },
    { long: "--scores", value_name: "path", value_type: "string", required: true, description: "JSON file with proxy_score and held_out_score records." },
    { long: "--evidence", value_name: "text", value_type: "string", required: true, description: "Human-readable promotion evidence." },
  ], run: promoteGeneration }),
  defineCommand({ name: "rl generation show", description: "Show one generation and its lineage details.", arguments: [{ name: "id", required: true, description: "Generation item id." }], run: showGeneration }),
  defineCommand({ name: "rl loop run", description: "Execute one bounded recursive collect-train-evaluate-promote loop, resuming any interrupted execution of the same idempotent programme.", arguments: [{ name: "id", required: true, description: "Loop id prefix; child items are named <id>-seed, <id>-g<n>-collect and <id>-g<n>." }], flags: [
    { long: "--file", value_name: "path", value_type: "string", required: true, description: "Loop configuration JSON: trainer, datasets, environment identity, and hard bounds." },
    { long: "--approval", value_name: "id", value_type: "string", required: true, description: "Approval Decision item id stating the permitted promotion count." },
  ], run: runLoop }),
  defineCommand({ name: "rl loop resume", description: "Resume one interrupted loop from its persisted seed programme, taking over a lease a crashed controller left behind.", arguments: [{ name: "id", required: true, description: "Loop id prefix whose seed generation stores the programme." }], flags: [
    { long: "--approval", value_name: "id", value_type: "string", required: true, description: "Approval Decision item id governing the loop's remaining promotions." },
    { long: "--force-takeover", description: "Audit an operator takeover of an ambiguous or stale lease; matching live holders still block." },
  ], run: resumeLoopCommand }),
  defineCommand({ name: "rl loop status", description: "Reconstruct one loop's persisted generations, budget and terminal reason without mutating anything.", arguments: [{ name: "id", required: true, description: "Loop id prefix whose persisted programme is reconstructed." }], run: showLoopStatus }),
  defineCommand({ name: "rl lineage", description: "Render the generation chain from seed to head(s) with promotion evidence and invalidation state.", arguments: [{ name: "head", required: false, description: "Head generation id; omit to enumerate every head." }], flags: [
    { long: "--format", value_name: "table|json", value_type: "string", description: "Output format; defaults to table." },
    { long: "--gap-window", value_name: "n", value_type: "string", description: "Number of consecutive gaps for the widening check (at least 2); defaults to 3." },
  ], run: renderLineageCommand }),
  defineCommand({ name: "rl invalidate", description: "List every Run, EvalResult and Transfer transitively invalidated by changing one environment or benchmark version, with the dependency path that reaches each.", arguments: [{ name: "id", required: true, description: "Environment or Benchmark item id whose change invalidates downstream results." }], run: invalidateResults }),
  defineCommand({ name: "rl episode env register", description: "Register an immutable gate-simulator environment pinning the repository commit, mandatory gates, and verdict extraction.", flags: [{ long: "--file", value_name: "path", value_type: "string", required: true, description: "Gate environment JSON file." }], run: registerGateEnvironment }),
  defineCommand({ name: "rl episode record", description: "Record one sandbox episode against the fleet's mandatory gates with its candidate-tree identity, verdict, and pull-request link.", flags: [
    { long: "--environment", value_name: "id", value_type: "string", required: true, description: "Gate environment item id." },
    { long: "--base-commit", value_name: "sha", value_type: "string", required: true, description: "Base commit the candidate diffed against." },
    { long: "--candidate-tree", value_name: "tree-id", value_type: "string", description: "Git tree id of the judged candidate tree." },
    { long: "--patch-file", value_name: "path", value_type: "string", description: "Patch producing the judged candidate; stored by content hash." },
    { long: "--gates-results", value_name: "path", value_type: "string", required: true, description: "JSON file of per-gate exit codes." },
    { long: "--pull-request", value_name: "link", value_type: "string", required: true, description: "Stable link to the corresponding pull request." },
  ], run: recordEpisode }),
  defineCommand({ name: "rl episode replay", description: "Replay one episode against its re-resolved candidate artifact and fresh gate results; refuses any verdict that no longer reproduces.", arguments: [{ name: "episode", required: true, description: "GateEpisode item id." }], flags: [
    { long: "--candidate-tree", value_name: "tree-id", value_type: "string", description: "Git tree id replay resolves and compares to the recorded one." },
    { long: "--patch-file", value_name: "path", value_type: "string", description: "Patch whose content hash is compared to the recorded one." },
    { long: "--gates-results", value_name: "path", value_type: "string", required: true, description: "Fresh JSON file of per-gate exit codes." },
  ], run: replayEpisode }),
  defineCommand({ name: "rl outcome record", description: "Record the real-side merge outcome for one pull request.", flags: [
    { long: "--pull-request", value_name: "link", value_type: "string", required: true, description: "Stable link matching the paired episode's pull request exactly." },
    { long: "--merged", value_name: "true|false", value_type: "string", required: true, description: "Whether the pull request merged." },
  ], run: recordOutcome }),
  defineCommand({ name: "rl transfer record", description: "Record one measured per-metric sim-to-real gap for one checkpoint, linked to both environment versions and its run.", arguments: [{ name: "id", required: true, description: "Transfer item id." }], flags: [
    { long: "--source", value_name: "id", value_type: "string", required: true, description: "Simulator-side Environment item id." },
    { long: "--target", value_name: "id", value_type: "string", required: true, description: "Deployment-side Environment item id." },
    { long: "--checkpoint", value_name: "hash", value_type: "string", required: true, description: "Content-addressed checkpoint identity measured." },
    { long: "--run", value_name: "id", value_type: "string", required: true, description: "Source Run item id whose checkpoint series this joins." },
    { long: "--metrics", value_name: "path", value_type: "string", required: true, description: "JSON file of per-metric gaps." },
  ], run: recordTransfer }),
  defineCommand({ name: "rl transfer gap", description: "Report the per-metric gap series across a run's checkpoints in order; superseded-environment transfers are reported stale, not plotted.", arguments: [{ name: "run", required: true, description: "Run item id whose transfers to report." }], run: showTransferGap }),
  defineCommand({ name: "rl sweep plan", description: "Expand a declared search space into one child Run per arm with the arm's hyperparameters recorded.", arguments: [{ name: "id", required: true, description: "Sweep item id." }], flags: [
    { long: "--file", value_name: "path", value_type: "string", required: true, description: "JSON with search_space and selection_rule." },
    { long: "--environment", value_name: "id", value_type: "string", required: true, description: "Environment item id every arm trains under." },
    { long: "--algorithm", value_name: "name", value_type: "string", required: true, description: "Training algorithm every arm runs." },
  ], run: planSweep }),
  defineCommand({ name: "rl sweep status", description: "Report per-arm progress and the selection rule's current verdict across arms, never inventing a winner the rule does not support.", arguments: [{ name: "id", required: true, description: "Sweep item id." }], run: showSweepStatus }),
  defineCommand({ name: "rl simreal gap", description: "Report the sim-to-real gap over the paired cohort of episodes and outcomes, denominators stated, unpaired sides as coverage.", run: simRealGap }),
  defineCommand({ name: "rl compare", description: "Diff two runs' metrics over their common step range with the hyperparameter, environment-version and reward-spec delta; refuses runs from different environment versions.", arguments: [
    { name: "baseline", required: true, description: "Baseline run item id." },
    { name: "candidate", required: true, description: "Candidate run item id." },
  ], run: compareRuns }),
] as const;

/** Install pm-rl's typed schema and command surface into the active host. */
function activate(api: ExtensionApi): void {
  api.registerItemTypes([...RL_ITEM_TYPES]);
  api.hooks.beforeMutation(guardReferencedEnvironmentMutation);
  for (const command of RL_COMMANDS) api.registerCommand(command);
}

export default defineExtension({
  name: "pm-rl",
  version: "2026.10.28",
  activate,
});
