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
import { commitWorkspaceTransaction } from "@unbrained/pm-cli/sdk";
import { PmClient, type GetResult } from "@unbrained/pm-cli/sdk/core";
import { createPmCliExpectedError, EXIT_CODE, isPmCliExpectedError } from "@unbrained/pm-cli/sdk/runtime";

import { encodeEventSegments, parseNdjsonStream, readSeries } from "./series.ts";

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
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    fail(`${source} is not valid JSON.`, "invalid_environment_json");
  }
  const record = jsonObject(parsed, source);
  for (const key of ["name", "version"] as const) {
    if (typeof record[key] !== "string" || record[key].trim().length === 0) {
      fail(`${source} requires a non-empty string ${key}.`, `invalid_environment_${key}`);
    }
  }
  for (const key of ["task_suite", "reward_specification"] as const) {
    if (!(key in record)) fail(`${source} requires ${key}.`, `missing_environment_${key}`);
  }
  return record as EnvironmentSpec;
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
async function getTypedItem(client: PmClient, id: string, type: "Environment" | "Run" | "Generation"): Promise<GetResult> {
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

/** Register one immutable environment spec, idempotently by content identity. */
async function registerEnvironment(context: CommandHandlerContext): Promise<RlCommandResult> {
  const path = stringOption(context, "file")!;
  const spec = parseEnvironmentSpec(readTextFile(path, "Environment file"), `Environment file ${path}`);
  const specHash = hashJson(spec);
  const requestedId = `env-${idSegment(spec.name)}-${idSegment(spec.version)}-${specHash.slice(0, 12)}`;
  const client = clientFor(context);
  await ensurePersistentTypes(client);
  try {
    const existing = await getTypedItem(client, requestedId, "Environment");
    if (existing.item.affected_version !== specHash) {
      fail(`Environment id ${requestedId} already exists with a different specification hash.`, "environment_identity_collision", EXIT_CODE.CONFLICT);
    }
    return { action: "rl-env-register", id: String(existing.item.id), created: false, details: { spec_hash: specHash } };
  } catch (error) {
    if (!isItemNotFound(error)) throw error;
  }
  const result = await client.create({
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
  });
  return { action: "rl-env-register", id: result.item.id, created: true, details: { spec_hash: specHash } };
}

/** Start one run linked to an exact environment and immutable configuration. */
async function startRun(context: CommandHandlerContext): Promise<RlCommandResult> {
  const requestedId = requiredArgument(context, "a run id");
  const environmentId = stringOption(context, "environment")!;
  const algorithm = stringOption(context, "algorithm")!;
  const configPath = stringOption(context, "config_file", false);
  const config = configPath === undefined ? {} : readJsonFile(configPath, "Run configuration");
  const client = clientFor(context);
  await ensurePersistentTypes(client);
  const verifiedEnvironment = await verifyEnvironmentIdentity(client, environmentId, "runs");
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
    body: `# ${requestedId}\n\nAlgorithm: ${algorithm}\n\nEnvironment snapshot:\n\n\`\`\`json\n${JSON.stringify(storedSpec, null, 2)}\n\`\`\`\n\nRun configuration:\n\n\`\`\`json\n${JSON.stringify(config, null, 2)}\n\`\`\``,
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
  const notes = await client.notes(id);
  const series = readSeries(notes.notes.map((note) => note.text));
  return { action: "rl-run-show", id: String(run.item.id), details: { status: run.item.status, environment_id: run.item.environment, events: series.events, comments: series.comments } };
}

/** Close a run while preserving its final metric history. */
async function finishRun(context: CommandHandlerContext): Promise<RlCommandResult> {
  const id = requiredArgument(context, "a run id");
  const reason = stringOption(context, "reason")!;
  const client = clientFor(context);
  await getTypedItem(client, id, "Run");
  const notes = await client.notes(id);
  const series = readSeries(notes.notes.map((note) => note.text));
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
  const environment = await getTypedItem(client, environmentId, "Environment");
  const specHash = environment.item.affected_version;
  if (typeof specHash !== "string" || specHash.length === 0) {
    fail(`Environment ${environmentId} has no specification affected_version and cannot support attributable ${dependents}.`, "environment_missing_hash", EXIT_CODE.CONFLICT);
  }
  const fenced = JSON_SPEC_FENCE.exec(String(environment.item.body));
  if (fenced?.[1] === undefined) {
    fail(`Environment ${environmentId} has no JSON specification fence.`, "environment_missing_spec", EXIT_CODE.CONFLICT);
  }
  const storedSpec = parseEnvironmentSpec(fenced[1], `Environment ${environmentId} specification`);
  if (hashJson(storedSpec) !== specHash || !String(environment.item.id).endsWith(specHash.slice(0, 12))) {
    fail(`Environment ${environmentId} no longer matches its content-addressed identity. Register the changed specification as a new version.`, "environment_was_mutated", EXIT_CODE.CONFLICT);
  }
  return { id: String(environment.item.id), spec: storedSpec };
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
    const item = await getTypedItem(client, currentId, "Generation");
    const spec = extractGenerationSpec(String(item.item.body), `Generation ${currentId}`);
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
      const environmentRaw = run.item.environment;
      const environment = typeof environmentRaw === "string" ? environmentRaw.trim() : environmentRaw;
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
    for (const runId of collectionRuns) {
      const run = await getTypedItem(client, runId, "Run");
      if (parentSpec.policy.length > 0 && String(run.item.component) !== parentSpec.policy) {
        fail(`Collection run ${runId} references policy ${String(run.item.component)}, not the parent generation's policy ${parentSpec.policy}.`, "run_policy_mismatch", EXIT_CODE.CONFLICT);
      }
    }
    const envInput = stringOption(context, "environment")!;
    const envResult = await verifyEnvironmentForGeneration(client, envInput);
    environmentId = envResult.id;
    rewardSpecVersion = envResult.rewardSpecHash;
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
  const approvalSpec = await readApprovalSpec();
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
  let permittedPromotions = approvalSpec.permitted_promotions;
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
    heads = [headInput.trim()];
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

/** Commands authored separately so activation and tests share one exact contract. */
export const RL_COMMANDS = [
  defineCommand({ name: "rl env register", description: "Register an immutable, content-addressed environment JSON specification.", flags: [{ long: "--file", value_name: "path", value_type: "string", required: true, description: "Environment JSON file." }], run: registerEnvironment }),
  defineCommand({ name: "rl env list", description: "List registered RL environment versions without their large bodies.", run: listEnvironments }),
  defineCommand({ name: "rl env show", description: "Show one registered environment and its specification identity.", arguments: [{ name: "id", required: true, description: "Environment item id." }], run: showEnvironment }),
  defineCommand({ name: "rl run start", description: "Start an attributable run linked to one exact environment version.", arguments: [{ name: "id", required: true, description: "Run item id." }], flags: [
    { long: "--environment", value_name: "id", value_type: "string", required: true, description: "Environment item id." },
    { long: "--algorithm", value_name: "name", value_type: "string", required: true, description: "Training algorithm." },
    { long: "--config-file", value_name: "path", value_type: "string", description: "Optional JSON configuration." },
  ], run: startRun }),
  defineCommand({ name: "rl run log", description: "Append NDJSON metric events from --file or stdin to merge-safe run notes.", arguments: [{ name: "id", required: true, description: "Run item id." }], flags: [{ long: "--file", value_name: "path", value_type: "string", description: "NDJSON file; omit to read stdin." }], run: logRun }),
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
