/**
 * @module pm-rl
 *
 * Registers the first production pm-rl slab: immutable, content-addressed
 * environment specifications and run metric streams stored as repeatable pm
 * notes. Notes are append-only history mutations and merge as a set across
 * concurrent branches, unlike a scalar item body.
 */

import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

import {
  defineCommand,
  defineExtension,
  defineItemType,
  type CommandHandlerContext,
  type ExtensionApi,
} from "@unbrained/pm-cli/sdk/authoring";
import { commitWorkspaceTransaction, type LogNote } from "@unbrained/pm-cli/sdk";
import { PmClient, type GetResult } from "@unbrained/pm-cli/sdk/core";
import { createPmCliExpectedError, EXIT_CODE, isPmCliExpectedError } from "@unbrained/pm-cli/sdk/runtime";

import { encodeEventSegments, parseNdjsonStream, readSeries } from "./series.ts";

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
  type GenerationSpec,
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

/**
 * The fenced JSON block regex shared by every pm-rl spec reader.
 *
 * A module-level const keeps one shape for the ```` ```json ```` envelope every
 * item body stores its specification in, so a change to the fence contract
 * touches one place. It has no `g` flag: a shared global regex carries
 * `lastIndex` state across calls and would silently skip matches.
 */
const JSON_SPEC_FENCE = /```json\n([\s\S]+?)\n```/;

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

/** Dependency provenance marker for a transfer's simulator-side environment. */
const TRANSFER_SOURCE_ENVIRONMENT = "pm-rl:transfer:source";

/** Dependency provenance marker for a transfer's deployment-side environment. */
const TRANSFER_TARGET_ENVIRONMENT = "pm-rl:transfer:target";

/** Dependency provenance marker connecting a transfer to its source run. */
const TRANSFER_RUN = "pm-rl:transfer:run";

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
function generationProvenance(spec: GenerationSpec): JsonValue {
  return {
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
  if (typeof value === "string" && value.trim().length > 0) return value.trim();
  if (required) fail(`pm rl requires --${key.replaceAll("_", "-")}.`, `missing_${key}`);
  return undefined;
}

/** Return the first positional argument or fail with actionable usage. */
function requiredArgument(context: CommandHandlerContext, label: string): string {
  const value = context.args.find((argument) => !argument.startsWith("-"));
  if (value === undefined || value.trim().length === 0) fail(`pm rl requires ${label}.`, "missing_argument");
  return value.trim();
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

/** Parse one JSON object while preserving a domain-specific machine error code. */
function parseJsonObject(text: string, source: string, code: string, exitCode: number = EXIT_CODE.USAGE): Record<string, JsonValue> {
  try {
    return jsonObject(JSON.parse(text), source);
  } catch (error) {
    if (isPmCliExpectedError(error)) throw error;
    fail(`${source} is not valid JSON.`, code, exitCode);
  }
}

/** Require non-empty string values for a domain specification's identity fields. */
function requireJsonStrings(record: Readonly<Record<string, JsonValue>>, keys: readonly string[], source: string, codePrefix: string, exitCode: number = EXIT_CODE.USAGE): void {
  for (const key of keys) {
    const value = record[key];
    if (typeof value !== "string" || value.trim().length === 0) {
      fail(`${source} requires a non-empty string ${key}.`, `${codePrefix}_${key}`, exitCode);
    }
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
export function parseBenchmarkSpec(text: string, source = "Benchmark file"): BenchmarkSpec {
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
    contaminated_environments: [...new Set(contaminatedEnvironments.map((id) => id.trim()))].sort(),
  };
}

/** Parse and validate one stored evaluation provenance record. */
export function parseEvalResultSpec(text: string, source = "EvalResult"): EvalResultSpec {
  const record = parseJsonObject(text, source, "invalid_eval_result_json", EXIT_CODE.CONFLICT);
  requireJsonStrings(record, ["checkpoint", "run_id", "benchmark_id", "environment_id", "environment_spec_hash", "reward_spec_hash"], source, "invalid_eval_result", EXIT_CODE.CONFLICT);
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

/** Validate that an existing item has the expected domain type. */
async function getTypedItem(client: PmClient, id: string, type: "Environment" | "Run" | "Generation" | "Benchmark" | "EvalResult" | "GateEpisode" | "MergeOutcome" | "Sweep" | "Transfer"): Promise<GetResult> {
  const result = await client.get(id, { depth: "deep" });
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
    await client.schemaAddType(itemType.name, {
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
    return JSON.parse(text) as JsonValue;
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
  const result = await client.notes(id, { outputBudget: "unbounded", outputLimit: "unbounded" });
  if ("output_budget_exceeded" in result) {
    fail(`Run ${id} note history was omitted despite an unbounded read request.`, "metric_history_incomplete", EXIT_CODE.CONFLICT);
  }
  return result.notes;
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
  try {
    const existing = await getTypedItem(client, requestedId, "Environment");
    if (existing.item.affected_version !== specHash) {
      fail(`Environment id ${requestedId} already exists with a different specification hash.`, "environment_identity_collision", EXIT_CODE.CONFLICT);
    }
    return { action, id: String(existing.item.id), created: false, details };
  } catch (error) {
    if (!isItemNotFound(error)) throw error;
  }
  const result = await client.create(create());
  return { action, id: String(result.item.id), created: true, details };
}

/** Register one immutable environment spec, idempotently by content identity. */
async function registerEnvironment(context: CommandHandlerContext): Promise<RlCommandResult> {
  const path = stringOption(context, "file")!;
  const spec = parseEnvironmentSpec(readTextFile(path, "Environment file"), `Environment file ${path}`);
  const specHash = hashJson(spec);
  const requestedId = `env-${idSegment(spec.name)}-${idSegment(spec.version)}-${specHash.slice(0, 12)}`;
  const client = clientFor(context);
  await ensurePersistentTypes(client);
  return registerImmutableEnvironment(client, requestedId, specHash, "rl-env-register", () => ({
    id: requestedId,
    title: `${spec.name} ${spec.version}`,
    type: "Environment",
    status: "open",
    acceptanceCriteria: "The complete specification is stored, its SHA-256 identity matches the item id, and changed behavior is registered as a new version.",
    estimatedMinutes: "1",
    body: `# ${spec.name} ${spec.version}\n\n\`\`\`json\n${JSON.stringify(spec, null, 2)}\n\`\`\``,
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
  const verifiedEnvironment = await verifyEnvironmentIdentity(client, environmentId, "runs");
  // A receipt that names an environment other than the one this run records
  // would be born already unverifiable; refuse it at the write, not at verify.
  if (receipt !== null && receipt.environment_version !== verifiedEnvironment.id) {
    fail(`Determinism receipt names environment "${receipt.environment_version}" but the run records ${verifiedEnvironment.id}. A receipt must pin the exact environment item id the run trains under.`, "receipt_environment_mismatch", EXIT_CODE.CONFLICT);
  }
  const storedSpec = verifiedEnvironment.spec;
  const specHash = hashJson(storedSpec);
  const configHash = hashJson(config);
  const result = await client.create({
    id: requestedId,
    title: requestedId,
    type: "Run",
    status: "in_progress",
    acceptanceCriteria: "The run retains its exact environment and configuration identities, metric input is complete, and finish records the terminal outcome.",
    estimatedMinutes: "1",
    body: `# ${requestedId}\n\nAlgorithm: ${algorithm}\n\nEnvironment snapshot:\n\n\`\`\`json\n${JSON.stringify(storedSpec, null, 2)}\n\`\`\`\n\nRun configuration:\n\n\`\`\`json\n${JSON.stringify(config, null, 2)}\n\`\`\`${receipt === null ? "" : `\n\n${RECEIPT_HEADING}\n\n\`\`\`json\n${JSON.stringify(receipt, null, 2)}\n\`\`\``}`,
    // Both edges name the RESOLVED id. `environmentId` is the raw --environment
    // input, which may be an alias; recording it on one edge and the resolved id
    // on the other would make a single create call describe two different
    // environments, and the dependency graph would then disagree with the typed
    // field the contamination walk reads.
    dep: [verifiedEnvironment.id],
    environment: verifiedEnvironment.id,
    affectedVersion: specHash,
    component: algorithm,
    fixedVersion: configHash,
    message: "Start attributable RL run",
  });
  return { action: "rl-run-start", id: result.item.id, created: true, details: { environment_id: verifiedEnvironment.id, spec_hash: specHash, config_hash: configHash } };
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

/** Append parsed measurements as bounded compressed segments through the typed SDK. */
async function logRun(context: CommandHandlerContext): Promise<RlCommandResult> {
  const id = requiredArgument(context, "a run id");
  const path = stringOption(context, "file", false);
  if (path === undefined && process.stdin.isTTY === true) {
    fail("pm rl run log requires --file or piped NDJSON on stdin.", "missing_metric_input");
  }
  let input: string;
  try {
    input = readFileSync(path ?? 0, "utf8");
  } catch (error) {
    fail(`Metric input could not be read: ${String(error)}`, "metric_input_failed");
  }
  const events = parseNdjsonStream(input);
  if (events.length === 0) fail("Metric input contains no events.", "empty_metric_stream");
  const client = clientFor(context);
  const run = await getTypedItem(client, id, "Run");
  if (run.item.status !== "in_progress") fail(`Run ${id} is ${String(run.item.status)}; only an in-progress run accepts metrics.`, "run_not_active", EXIT_CODE.CONFLICT);
  const notes = encodeEventSegments(events);
  await client.update(id, {
    note: notes,
    message: `Append ${events.length} RL metric event(s) in ${notes.length} bounded segment(s) atomically`,
  });
  return { action: "rl-run-log", id: String(run.item.id), details: { appended: events.length, segments: notes.length, stored_bytes: notes.reduce((total, note) => total + Buffer.byteLength(note), 0), first_step: events[0]!.step, last_step: events.at(-1)!.step } };
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
  const result = await client.close(id, reason, {
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
  const fenced = JSON_SPEC_FENCE.exec(body);
  if (fenced?.[1] === undefined) fail(`${source} has no JSON specification fence.`, code, EXIT_CODE.CONFLICT);
  return fenced[1];
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
  const supplied = parseBenchmarkSpec(readTextFile(path, "Benchmark file"), `Benchmark file ${path}`);
  const flagIds = (stringOption(context, "contaminated_by", false) ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter((id) => id.length > 0);
  const client = clientFor(context);
  await ensurePersistentTypes(client);
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
  const result = await client.create({
    id: requestedId,
    title: `${spec.name} ${spec.version}`,
    type: "Benchmark",
    status: "open",
    acceptanceCriteria: "The complete suite, scoring rule, pass criteria, direction, and contamination edges match its content identity.",
    estimatedMinutes: "1",
    body: `# ${spec.name} ${spec.version}\n\n\`\`\`json\n${JSON.stringify(spec, null, 2)}\n\`\`\``,
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
  const checkpoint = stringOption(context, "checkpoint")!;
  const score = Number(stringOption(context, "score")!);
  if (!Number.isFinite(score)) fail("pm rl eval record requires a finite --score.", "invalid_eval_result_score");
  const passedRaw = context.options.passed;
  const passed = typeof passedRaw === "boolean" ? passedRaw : passedRaw === "true" ? true : passedRaw === "false" ? false : undefined;
  if (passed === undefined) fail("pm rl eval record requires --passed true or --passed false.", "invalid_eval_result_passed");
  const client = clientFor(context);
  await ensurePersistentTypes(client);
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
  const result = await client.create({
    id: requestedId,
    title: `${benchmark.spec.name} ${benchmark.spec.version}: ${checkpoint}`,
    type: "EvalResult",
    status: "closed",
    closeReason: "Immutable evaluation verdict recorded",
    completedAt: new Date().toISOString(),
    acceptanceCriteria: "The verdict traces through typed graph edges to one source run, benchmark, environment, reward specification, and checkpoint.",
    estimatedMinutes: "1",
    body: `# Evaluation ${checkpoint}\n\n\`\`\`json\n${JSON.stringify(spec, null, 2)}\n\`\`\``,
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
  const inventory = await client.listAllComplete({ includeBody: true });
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
  const fenced = JSON_SPEC_FENCE.exec(String(environment.item.body));
  if (fenced?.[1] === undefined) {
    fail(`Environment ${environmentId} has no JSON specification fence.`, "environment_missing_spec", EXIT_CODE.CONFLICT);
  }
  return { id: String(environment.item.id), specHash, json: fenced[1]! };
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
    body: `# ${spec.name} ${spec.version} gates\n\n\`\`\`json\n${JSON.stringify(spec, null, 2)}\n\`\`\``,
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
  const result = await client.create({
    id: requestedId,
    title: `Gates ${verified.spec.name} ${verified.spec.version}: ${(candidateTree ?? patchHash!)!.slice(0, 16)}`,
    type: "GateEpisode",
    status: "closed",
    closeReason: "Immutable gate-simulator episode recorded",
    completedAt: new Date().toISOString(),
    acceptanceCriteria: "The episode traces to its exact candidate artifact, gate environment, gate results, extracted verdict, and pull request.",
    estimatedMinutes: "1",
    body: `# Episode ${requestedId}\n\n\`\`\`json\n${JSON.stringify(spec, null, 2)}\n\`\`\``,
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
  const result = await client.create({
    id: requestedId,
    title: `Merge outcome: ${pullRequest}`,
    type: "MergeOutcome",
    status: "closed",
    closeReason: "Immutable merge outcome recorded",
    completedAt: new Date().toISOString(),
    acceptanceCriteria: "The outcome names one pull request and whether it merged, content-addressed by both.",
    estimatedMinutes: "1",
    body: `# Outcome ${requestedId}\n\n\`\`\`json\n${JSON.stringify(spec, null, 2)}\n\`\`\``,
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
  for (const item of (await client.list({ type: "GateEpisode", status: "all", noTruncate: true, fields: "id,body" })).items) {
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
  for (const item of (await client.list({ type: "MergeOutcome", status: "all", noTruncate: true, fields: "id,body" })).items) {
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
function extractGenerationSpec(body: string, source: string): GenerationSpec {
  const fenced = JSON_SPEC_FENCE.exec(body);
  if (fenced?.[1] === undefined) {
    fail(`${source} has no JSON specification fence.`, "generation_missing_spec", EXIT_CODE.CONFLICT);
  }
  return parseGenerationSpec(fenced[1], source);
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
    const fenced = JSON_SPEC_FENCE.exec(String(environment.item.body));
    const envJson = fenced?.[1];
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

/** Normalize a Run's environment identity for strict-equality comparison.
 *
 * The pm SDK already trims typed item fields, so padding is not reachable for
 * a metadata field — a Run whose `.toon` literally stores `environment: "  e  "`
 * reads back trimmed. The trim is purely defensive: it pins the security gate
 * (contamination compare) against a future SDK change, and the dependency is
 * asserted by a dedicated test. Both `buildAncestry` and the register command's
 * run-environment check compare this field, so they must normalise it the same
 * way.
 *
 * @param value - The raw `run.item.environment` value.
 * @returns The trimmed string, or the original non-string value unchanged.
 */
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
  const ancestry: AncestryEntry[] = [];
  const visited = new Set<string>();
  let currentId: string | null = headId;
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
      spec = extractGenerationSpec(String(item.item.body), `Generation ${currentId}`);
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
        runEnvironments.set(runId, environment);
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
 * Count promoted generations that recorded a given approval item as their
 * authorization.
 *
 * This is only called on the promotion path, where the approved budget cannot be
 * established while any Generation is uncountable. A Generation whose body has
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
 * @returns The number of generations promoted under this approval.
 * @throws When any generation's specification cannot be read or parsed.
 */
async function countPromotedUnderApproval(client: PmClient, approvalId: string): Promise<number> {
  // Bodies come back with the listing. This runs inside the promotion's writer
  // lock, so a per-record `client.get` would make the critical section grow one
  // read per historical generation, and a large enough lineage would turn a
  // correct refusal into a lock-wait timeout for every concurrent promoter.
  const result = await client.list({ type: "Generation", status: "all", noTruncate: true, fields: "id,body" });
  let count = 0;
  for (const item of result.items) {
    // The SDK types a listed item's `id` as optional; a record without one
    // carries no identity to report, so it is skipped rather than counted.
    if (item.id === undefined) continue;
    const fenced = JSON_SPEC_FENCE.exec(String(item.body));
    const json = fenced?.[1];
    if (json === undefined) {
      fail(`Promotion refused: generation ${item.id} has no JSON specification fence, so the approved budget cannot be established.`, "budget_undecidable", EXIT_CODE.CONFLICT);
    }
    let spec: GenerationSpec;
    try {
      spec = parseGenerationSpec(json, `Generation ${item.id}`);
    } catch (error) {
      fail(`Promotion refused: generation ${item.id} has an unparseable specification (${String(error)}), so the approved budget cannot be established.`, "budget_undecidable", EXIT_CODE.CONFLICT);
    }
    if (spec.promoted && spec.approval === approvalId) count += 1;
  }
  return count;
}


/** Find generation item ids that are not a parent of any other generation. */
async function findGenerationHeads(client: PmClient): Promise<string[]> {
  const result = await client.list({ type: "Generation", status: "all", noTruncate: true, fields: "id,body" });
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
    if (typeof parent === "string" && parent.length > 0) parentIds.add(parent);
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
  const parentInput = stringOption(context, "parent", false);
  const configPath = stringOption(context, "config_file", false);
  const config = configPath === undefined ? {} : readJsonFile(configPath, "Generation configuration");
  const client = clientFor(context);
  await ensurePersistentTypes(client);
  // `stringOption` returns `value.trim()` and maps a blank to `undefined`, so
  // `parentInput` is already normalized and already non-empty when defined.
  // Re-trimming here would state a normalization this boundary does not
  // perform, which is worse than not restating it at all.
  const isSeed = parentInput === undefined;
  let policy = "";
  let collectionRuns: string[] = [];
  let environmentId = "";
  let rewardSpecVersion = "";
  let deps: string[] = [];
  if (isSeed) {
    // A seed may declare the policy that collected its data; without one the
    // recorded policy is empty and candidates parented to it skip the check.
    policy = stringOption(context, "policy", false) ?? "";
  } else {
    const parent = await getTypedItem(client, parentInput!, "Generation");
    const parentSpec = extractGenerationSpec(String(parent.item.body), `Parent generation ${parentInput}`);
    if (!parentSpec.promoted && !parentSpec.seed) {
      fail(`Parent generation ${parentInput} is not promoted. Only a promoted generation (or the seed) may parent a candidate.`, "parent_not_promoted", EXIT_CODE.CONFLICT);
    }
    policy = stringOption(context, "policy")!;
    const collectionRunsRaw = stringOption(context, "collection_runs")!;
    collectionRuns = collectionRunsRaw.split(",").map((run) => run.trim()).filter((run) => run.length > 0);
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
    const envInput = stringOption(context, "environment")!;
    const envResult = await verifyEnvironmentForGeneration(client, envInput);
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
  const spec: GenerationSpec = {
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
    body: `# ${requestedId}\n\n\`\`\`json\n${JSON.stringify(spec, null, 2)}\n\`\`\``,
    affectedVersion: specHash,
    fixedVersion: baseCheckpoint,
    component: policy.length > 0 ? policy : baseCheckpoint,
    message: isSeed ? "Register seed RL generation" : "Register candidate RL generation",
    ...(isSeed ? {} : { parent: parentInput, dep: deps, environment: environmentId }),
  };
  const result = await client.create(createOptions);
  return {
    action: "rl-generation-register",
    id: result.item.id,
    created: true,
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

/** Promote a candidate generation after contamination and budget checks pass. */
async function promoteGeneration(context: CommandHandlerContext): Promise<RlCommandResult> {
  const id = requiredArgument(context, "a generation id");
  // Already trimmed: `stringOption` returns `value.trim()`. The normalization
  // that matters for the budget is at the PARSE boundary, because a generation
  // body can be authored without ever passing through this flag.
  const approvalId = stringOption(context, "approval")!;
  const scoresPath = stringOption(context, "scores")!;
  const evidence = stringOption(context, "evidence")!;
  const client = clientFor(context);
  await ensurePersistentTypes(client);
  const generation = await getTypedItem(client, id, "Generation");
  const spec = extractGenerationSpec(String(generation.item.body), `Generation ${id}`);
  if (spec.promoted) {
    fail(`Generation ${id} is already promoted.`, "already_promoted", EXIT_CODE.CONFLICT);
  }
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
  const ancestry = await buildAncestry(client, id, true);
  const contamination = findContaminationPath(ancestry, heldOutScore.evaluation_context);
  if (contamination !== null) {
    fail(`Promotion refused: the evaluation set is reachable from the candidate's training data over provenance edges. Path: ${renderContaminationPath(contamination)}`, "contamination_refused", EXIT_CODE.CONFLICT);
  }
  const gap = directionAwareGap(proxyScore, heldOutScore);
  // Read and validated through one function so the pre-lock fast refusal and
  // the in-lock decision cannot drift apart. The budget the promotion is
  // checked against must come from a read taken INSIDE the lock: an approval
  // whose permitted count is lowered while this caller waits would otherwise be
  // compared against the capacity it had before, and the promotion would exceed
  // the approval that actually governs it.
  const readApprovalSpec = async (): Promise<ApprovalSpec> => {
    const approval = await client.get(approvalId, { depth: "deep" });
    if (String(approval.item.type) !== "Decision") {
      fail(`pm rl expected a Decision ${approvalId} as the approval item, not ${String(approval.item.type)}.`, "wrong_approval_type", EXIT_CODE.CONFLICT);
    }
    const approvalFenced = JSON_SPEC_FENCE.exec(String(approval.item.body));
    if (approvalFenced?.[1] === undefined) {
      fail(`Approval item ${approvalId} has no JSON specification fence.`, "approval_missing_spec", EXIT_CODE.CONFLICT);
    }
    return parseApprovalSpec(approvalFenced[1], `Approval ${approvalId}`);
  };
  // Called for its refusals, not its value: it rejects a non-Decision approval,
  // a missing JSON fence, and an unparseable spec BEFORE the writer lock is
  // taken, so an obviously invalid approval never queues behind a live promotion.
  // The value is deliberately discarded — every number the decision and the
  // receipt use is re-read inside the lock.
  await readApprovalSpec();
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
  const renderPromotedBody = (base: GenerationSpec): string => {
    const promotedSpec: GenerationSpec = {
      ...base,
      promoted: true,
      approval: approvalId,
      proxy_score: proxyScore,
      held_out_score: heldOutScore,
      gap,
      promotion_evidence: evidence,
    };
    return `# ${id}\n\n\`\`\`json\n${JSON.stringify(promotedSpec, null, 2)}\n\`\`\``;
  };
  // Seeded from the pre-lock read and REPLACED by the in-lock re-read below.
  // Restoring the pre-lock body would discard an edit another writer landed
  // between that read and the lock: this value is written back on a failed
  // close, so it must be the body that was current when the promoting write
  // overwrote it, not the one this caller happened to see first.
  let bodyBeforePromotion = String(generation.item.body);
  // Revert the promoting write. The coordinator compensates steps it has already
  // recorded as applied, and a single-step plan has none — verified empirically:
  // a step whose `apply` throws runs inspect, apply, then propagates, never
  // compensate. So `apply` invokes this itself on a failed close rather than
  // leaving a body that reads as promoted, which would consume budget the
  // generation never legitimately spent. It is also wired as the step's
  // `compensate` so a future multi-step plan reverts through the same path.
  const revertPromotingWrite = async (): Promise<void> => {
    await client.update(id, { body: bodyBeforePromotion, message: "Revert interrupted pm-rl promotion" });
  };
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
  await commitWorkspaceTransaction({
    pmRoot: context.pm_root,
    // Unique per invocation. The transaction is used here for MUTUAL EXCLUSION,
    // not for idempotent replay, and the two must not share a key: keying on the
    // generation makes concurrent callers promoting the SAME generation look
    // like replays of one committed transaction, so the journal skips `apply`
    // and every caller reports success for a promotion only one of them
    // performed. Correctness under concurrency comes from the re-check inside
    // the lock instead.
    transactionId: `pm-rl-generation-promote-${id}-${randomUUID()}`,
    author: authorFor(context),
    lockWaitMs: PROMOTION_LOCK_WAIT_MS,
    steps: [{
      id: "promote-generation",
      // The durable journal, not this inspection, is what makes a completed
      // promotion idempotent: replaying a recorded transactionId skips `apply`
      // regardless of what `inspect` reports (verified empirically). Reporting
      // a durable "applied" here would also be unreachable, because a generation
      // that already carries a promoted body is refused by the `already_promoted`
      // guard long before the transaction opens.
      inspect: async () => ({ state: "pending" }),
      apply: async () => {
        // Re-read inside the lock. The pre-lock `already_promoted` check runs on
        // a read every concurrent caller performs before any of them holds the
        // lock, so all of them pass it and would each promote the same
        // generation. Only a re-check inside the critical section makes "a
        // generation promotes at most once" true under concurrency.
        const current = await getTypedItem(client, id, "Generation");
        bodyBeforePromotion = String(current.item.body);
        const currentSpec = extractGenerationSpec(bodyBeforePromotion, `Generation ${id}`);
        if (currentSpec.promoted) {
          fail(`Generation ${id} is already promoted.`, "already_promoted", EXIT_CODE.CONFLICT);
        }
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
        const lockedContamination = findContaminationPath(lockedAncestry, heldOutScore.evaluation_context);
        if (lockedContamination !== null) {
          fail(`Promotion refused: the evaluation set is reachable from the candidate's training data over provenance edges. Path: ${renderContaminationPath(lockedContamination)}`, "contamination_refused", EXIT_CODE.CONFLICT);
        }
        // Re-read inside the lock for the same reason the count is: the budget
        // is a comparison between two values, and re-reading only one of them
        // leaves the comparison stale in the other direction.
        const lockedApprovalSpec = await readApprovalSpec();
        promotedCount = await countPromotedUnderApproval(client, approvalId);
        permittedPromotions = lockedApprovalSpec.permitted_promotions;
        if (promotedCount >= permittedPromotions) {
          fail(`Advancing past the approved promotion budget is refused. ${promotedCount} promotion(s) consumed; approval ${approvalId} permits ${permittedPromotions}. Extend approval item ${approvalId} to authorize more promotions.`, "budget_exceeded", EXIT_CODE.CONFLICT);
        }
        await client.update(id, {
          // Rendered from the IN-LOCK spec, so a peer edit to a field the
          // promotion decision did not consume survives this write.
          body: renderPromotedBody(currentSpec),
          message: `Promote generation: gap=${gap.toFixed(4)}, evidence=${evidence}`,
        });
        try {
          const result = await client.close(id, "promoted", {
            message: "Promote RL generation",
            resolution: evidence,
            expectedResult: "The generation reaches a promoted state with both scores and the direction-aware gap recorded.",
            actualResult: `Promoted with proxy=${proxyScore.value}, held_out=${heldOutScore.value}, gap=${gap.toFixed(4)}. Budget consumed: ${promotedCount + 1} of ${permittedPromotions}.`,
          });
          closedStatus = String(result.item.status);
        } catch (error) {
          // The close error is the one that explains what happened; a revert
          // failure must not replace it. If the revert ALSO fails the situation
          // is worse than either alone — the body still reads as promoted while
          // the item was never closed — so both are reported, with the original
          // cause first, rather than the second error hiding the first.
          try {
            await revertPromotingWrite();
          } catch (revertError) {
            fail(`${String(error)} — and the revert of the promoting write also failed (${String(revertError)}), so generation ${id} still reads as promoted while it was never closed. Its body must be restored before the approved budget can be counted correctly.`, "revert_failed_after_close_failure", EXIT_CODE.CONFLICT);
          }
          throw error;
        }
        return { status: closedStatus };
      },
      compensate: revertPromotingWrite,
    }],
  });
  return {
    action: "rl-generation-promote",
    id,
    details: {
      status: closedStatus,
      gap,
      proxy_score: proxyScore.value,
      held_out_score: heldOutScore.value,
      approval: approvalId,
      budget_consumed: promotedCount + 1,
      // The IN-LOCK value. `approvalSpec` is the pre-lock read, and reporting
      // it here would tell the caller a capacity that was already superseded by
      // the one the promotion was actually checked against and recorded in the
      // item. This was the site my own pre-lock audit missed: the value was
      // re-read for the DECISION and not for the RECEIPT.
      budget_permitted: permittedPromotions,
      evidence,
    },
  };
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
  if (headInput !== undefined && headInput.trim().length > 0) {
    const requestedHead = headInput.trim();
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
  return JSON_SPEC_FENCE.exec(body.slice(start))?.[1] ?? null;
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
    configParsed = JSON.parse(configJson);
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
  const root = await client.get(id, { depth: "deep" });
  const rootId = String(root.item.id);
  const rootType = String(root.item.type);
  if (rootType !== "Environment" && rootType !== "Benchmark") {
    fail(`pm rl invalidate starts from an environment or benchmark version (${INVALIDATION_ROOT_TYPES.join(", ")}). ${rootId} is ${rootType}, and changing it invalidates no tracked RL result.`, "wrong_invalidation_root", EXIT_CODE.CONFLICT);
  }
  const inventory = await client.list({ status: "all", noTruncate: true, fields: "id,type,dependencies" });
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
 * Remove the arm runs an interrupted sweep plan already wrote.
 *
 * A partial sweep leaves orphaned child runs that later reads would treat as
 * real arms, so every arm written before the failure is deleted. A removal that
 * itself fails is refused with both causes named — the removal failure first,
 * then the original create failure — because silent orphans are precisely what
 * the cleanup exists to prevent.
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
      await client.delete(arm.id, { force: true });
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
  // item itself AND every arm — so a re-plan refuses without leaving a partially
  // expanded sweep behind. A sweep whose arms are gone (or were never created)
  // would otherwise be re-armed under an owner that already exists.
  try {
    await getTypedItem(client, requestedId, "Sweep");
    fail(`Sweep ${requestedId} already exists. Plan a new sweep id instead of re-arming an existing sweep.`, "sweep_exists", EXIT_CODE.CONFLICT);
  } catch (error) {
    if (!isItemNotFound(error)) throw error;
  }
  const armIds = configs.map((_, index) => `${requestedId}-arm-${index + 1}`);
  for (const armId of armIds) {
    try {
      await getTypedItem(client, armId, "Run");
      fail(`Arm run ${armId} already exists; sweep ${requestedId} is already planned. Plan a new sweep id instead.`, "sweep_arm_exists", EXIT_CODE.CONFLICT);
    } catch (error) {
      if (!isItemNotFound(error)) throw error;
    }
  }
  const arms: Array<{ id: string; config: JsonValue }> = [];
  try {
    for (const [index, config] of configs.entries()) {
      const armId = armIds[index]!;
      const result = await client.create({
        id: armId,
        title: armId,
        type: "Run",
        status: "in_progress",
        acceptanceCriteria: `Sweep arm ${index + 1} retains its exact environment and hyperparameter identities; its metrics are history appends independent of every other arm.`,
        estimatedMinutes: "1",
        body: `# ${armId}\n\nAlgorithm: ${algorithm}\n\nEnvironment snapshot:\n\n\`\`\`json\n${JSON.stringify(verifiedEnvironment.spec, null, 2)}\n\`\`\`\n\nRun configuration:\n\n\`\`\`json\n${JSON.stringify(config, null, 2)}\n\`\`\``,
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
  try {
    await client.create({
      id: requestedId,
      title: requestedId,
      type: "Sweep",
      status: "open",
      acceptanceCriteria: "The sweep retains its declared space, selection rule, and planned arms; its children are independent runs.",
      estimatedMinutes: "1",
      body: `# ${requestedId}\n\n\`\`\`json\n${JSON.stringify(spec, null, 2)}\n\`\`\``,
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
    id: requestedId,
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
  const requestedId = requiredArgument(context, "a transfer id");
  const sourceId = stringOption(context, "source")!;
  const targetId = stringOption(context, "target")!;
  const checkpoint = stringOption(context, "checkpoint")!;
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
  const result = await client.create({
    id: requestedId,
    title: `Sim-to-real gap at ${checkpoint.slice(0, 16)}`,
    type: "Transfer",
    status: "open",
    acceptanceCriteria: "The transfer traces to both exact environment versions, its source run, and its checkpoint, with every measured metric finite and named.",
    estimatedMinutes: "1",
    body: `# ${requestedId}\n\n\`\`\`json\n${JSON.stringify(spec, null, 2)}\n\`\`\``,
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
  for (const item of (await client.list({ type: "Transfer", status: "all", noTruncate: true, fields: "id,body,created_at" })).items) {
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
  defineCommand({ name: "rl env register", description: "Register an immutable, content-addressed environment JSON specification.", flags: [{ long: "--file", value_name: "path", value_type: "string", required: true, description: "Environment JSON file." }], run: registerEnvironment }),
  defineCommand({ name: "rl env list", description: "List registered RL environment versions without their large bodies.", run: listEnvironments }),
  defineCommand({ name: "rl env show", description: "Show one registered environment and its specification identity.", arguments: [{ name: "id", required: true, description: "Environment item id." }], run: showEnvironment }),
  defineCommand({ name: "rl benchmark register", description: "Register an immutable benchmark suite and typed contamination edges.", flags: [
    { long: "--file", value_name: "path", value_type: "string", required: true, description: "Benchmark JSON file." },
    { long: "--contaminated-by", value_name: "environment-ids", value_type: "string", description: "Comma-separated environment versions whose training data overlaps the suite." },
  ], run: registerBenchmark }),
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
  for (const command of RL_COMMANDS) api.registerCommand(command);
}

export default defineExtension({
  name: "pm-rl",
  version: "2026.7.31",
  activate,
});
