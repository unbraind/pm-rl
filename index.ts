/**
 * @module pm-rl
 *
 * Registers the first production pm-rl slab: immutable, content-addressed
 * environment specifications and run metric streams stored as repeatable pm
 * notes. Notes are append-only history mutations and merge as a set across
 * concurrent branches, unlike a scalar item body.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import {
  defineCommand,
  defineExtension,
  defineItemType,
  type CommandHandlerContext,
  type ExtensionApi,
} from "@unbrained/pm-cli/sdk/authoring";
import { PmClient, type GetResult } from "@unbrained/pm-cli/sdk/core";
import { createPmCliExpectedError, EXIT_CODE, isPmCliExpectedError } from "@unbrained/pm-cli/sdk/runtime";

import { encodeEventSegments, parseNdjsonStream, readSeries } from "./series.ts";

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
] as const;

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
 * Installed commands receive the host-injected client. The public testing
 * harness in pm-cli 2026.8.1 omits `context.sdk` (upstream #853), so the fallback
 * constructs the same public host client rather than replacing it with a double.
 */
function clientFor(context: CommandHandlerContext): PmClient {
  if (context.sdk !== undefined) return context.sdk.client;
  const author = typeof context.global.author === "string" && context.global.author.trim().length > 0
    ? context.global.author.trim()
    : "pm-rl";
  return PmClient.forActiveExtensionHost({ pmRoot: context.pm_root, author });
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
async function getTypedItem(client: PmClient, id: string, type: "Environment" | "Run"): Promise<GetResult> {
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
  const environment = await getTypedItem(client, environmentId, "Environment");
  const specHash = environment.item.affected_version;
  if (typeof specHash !== "string" || specHash.length === 0) {
    fail(`Environment ${environmentId} has no specification affected_version and cannot support attributable runs.`, "environment_missing_hash", EXIT_CODE.CONFLICT);
  }
  const fenced = /```json\n([\s\S]+?)\n```/.exec(String(environment.item.body));
  if (fenced?.[1] === undefined) {
    fail(`Environment ${environmentId} has no JSON specification fence.`, "environment_missing_spec", EXIT_CODE.CONFLICT);
  }
  const storedSpec = parseEnvironmentSpec(fenced[1], `Environment ${environmentId} specification`);
  const observedHash = hashJson(storedSpec);
  if (observedHash !== specHash || !String(environment.item.id).endsWith(specHash.slice(0, 12))) {
    fail(`Environment ${environmentId} no longer matches its content-addressed identity. Register the changed specification as a new version.`, "environment_was_mutated", EXIT_CODE.CONFLICT);
  }
  const configHash = hashJson(config);
  const result = await client.create({
    id: requestedId,
    title: requestedId,
    type: "Run",
    status: "in_progress",
    acceptanceCriteria: "The run retains its exact environment and configuration identities, metric input is complete, and finish records the terminal outcome.",
    estimatedMinutes: "1",
    body: `# ${requestedId}\n\nAlgorithm: ${algorithm}\n\nEnvironment snapshot:\n\n\`\`\`json\n${JSON.stringify(storedSpec, null, 2)}\n\`\`\`\n\nRun configuration:\n\n\`\`\`json\n${JSON.stringify(config, null, 2)}\n\`\`\``,
    dep: [environmentId],
    environment: String(environment.item.id),
    affectedVersion: specHash,
    component: algorithm,
    fixedVersion: configHash,
    message: "Start attributable RL run",
  });
  return { action: "rl-run-start", id: result.item.id, created: true, details: { environment_id: environment.item.id, spec_hash: specHash, config_hash: configHash } };
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
