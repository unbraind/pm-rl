import { canonicalIdentifier, canonicalProgrammeId, statePath, storedStateComponent, identifierClient, checkedStateFile, identifier, operationIdentifier } from "./state-boundary.ts";
import { decodeTrackerRecord, hasTrackerIdentity, parseBoundedJson, encodeBoundedJson, MAX_TRACKER_RECORD_BYTES } from "./tracker-record.ts";
/** Durable argv-only trainer execution, staged receipts and approved resource reservations. */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";
import type { WorkspaceTransactionStep, WorkspaceTransactionTransitionContext } from "@unbrained/pm-cli/sdk";
import type { PmClient } from "@unbrained/pm-cli/sdk/core";
import { EXIT_CODE, createPmCliExpectedError, isPmCliExpectedError, certifyCompleteListResult, normalizeItemId } from "@unbrained/pm-cli/sdk/runtime";
import { banditCheckpoint, MAX_BANDIT_FIT_STEPS, type BanditCheckpoint, type BanditExample, type BanditObservation } from "./bandit.ts";
import { canonicalJson, commitProcessTransaction, loopProcessStartTime, withProcessJobFence, withValidatedMutation, readCompleteLoopItem, type JsonValue } from "./index.ts";
import { expectedFail } from "./refuse.ts";
import { validateLmProcessCheckpoint, type LmProcessPayload } from "./process-lm.ts";
import { validatePrefixCompletion, type PrefixPayload } from "./prefix.ts";
import { launchComposeTrainer, stopComposeTrainer } from "./compose.ts";
import { encodeCheckpointArtifacts, readCheckpointArtifact, type CheckpointArtifact } from "./checkpoint-artifacts.ts";
import { retryOwnedStop, waitForOwnedClose } from "./owned-stop.ts";

/** Independently accounted resource dimensions; all values are nonnegative safe integers. */
export const RESOURCE_KEYS = ["training_steps", "wall_ms", "storage_bytes", "compute_units", "tokens"] as const;
/** A bounded allowance or measured resource vector; compute units are CPU milliseconds in the reference trainer. */
export type Resources = Readonly<Record<(typeof RESOURCE_KEYS)[number], number>>;
/** Programme-selected packaged trainer; commands are never read from tracker item text. */
export type ProcessAdapter = {
  /** Versioned adapter selector; only the packaged bandit trainer is CLI-selectable. */
  readonly kind: "process-bandit";
  /** Maximum allowance atomically reserved before launching this generation. */
  readonly allowance: Resources;
} | {
  /** Container execution of the identical staged bandit protocol. */
  readonly kind: "compose-bandit";
  /** Locally built immutable image ID; execution never pulls images. */
  readonly image: string;
  /** Maximum allowance atomically reserved before this generation launches. */
  readonly allowance: Resources;
} | {
  /** Bounded causal LM using the same external execution contract. */
  readonly kind: "compose-lm";
  /** Locally built immutable trainer image. */
  readonly image: string;
  /** Kernel-enforced memory ceiling in bytes. */
  readonly memory_bytes: number;
  /** Kernel-enforced CPU scheduling ceiling. */
  readonly cpus: number;
  /** Maximum resources reserved before launch. */
  readonly allowance: Resources;
};
/** Common policy identity used by the shared execution machinery. */
export type TrainerPolicy = BanditCheckpoint | { readonly digest: string };
/** Bandit, prefix or LM request accepted by the shared execution machinery. */
export type TrainerInput = ProcessInput<TrainerPolicy>;
/** Domain lifecycle, independent of the tracker item's planning status. */
export type ProcessJobState = "planned" | "running" | "materialized" | "evaluated" | "promoted" | "failed" | "cancelled" | "invalidated";
/** Immutable inputs delivered on stdin; held-out examples are deliberately absent. */
export interface ProcessInput<P extends { readonly digest: string } = BanditCheckpoint> {
  /** Programme, generation, source and dataset identities, environment, reward, collection and fit configuration. */
  readonly identity: JsonValue;
  /** The collecting policy's actual parameters. */
  readonly source: P;
  /** Collection dataset only. */
  readonly training: readonly (P extends BanditCheckpoint ? BanditExample : never)[];
  /** Actual source-policy samples; reward values are the training signal. */
  readonly observations: readonly (P extends BanditCheckpoint ? BanditObservation : never)[];
  /** One bounded fit configuration, interpreted by the selected packaged trainer. */
  readonly training_config: { readonly learning_rate: number; readonly steps: number };
  /** Source and dataset digests bind the receipt to this collected batch. */
  readonly lineage: JsonValue;
  /** Training-only LM payload; held-out examples never cross this boundary. */
  readonly lm?: LmProcessPayload;
  /** Bounded training-only history observables; absent from legacy adapters. */
  readonly prefix?: PrefixPayload;
}
/** Required durable completion evidence; successful process exit alone is never sufficient. */
export interface ProcessCompletion<P extends { readonly digest: string } = BanditCheckpoint> {
  /** Versioned stream and disk schema. */
  readonly format: "pm-rl/process-completion/1" | "pm-rl/process-completion/2";
  /** Content-bound job identity. */
  readonly job: string;
  /** Only this job's flat staging checkpoint is eligible. */
  readonly checkpoint: "checkpoint.json";
  /** SHA-256 over the exact readable checkpoint bytes. */
  readonly digest: string;
  /** Actual parameters whose policy identity must match the checkpoint content. */
  readonly policy: P;
  /** Prefix parameters live in a verified content-addressed blob; disk receipts contain only identity metadata. */
  readonly artifact?: CheckpointArtifact;
  /** Immutable fit configuration, source policy and dataset lineage. */
  readonly training_config: ProcessInput["training_config"];
  /** Digest of the policy that collected the training batch. */
  readonly source_policy: string;
  /** Training, held-out identity and collection digest; no held-out data. */
  readonly lineage: JsonValue;
  /** Adapter-measured steps, elapsed milliseconds, checkpoint bytes, CPU milliseconds and tokens. */
  readonly usage: Resources;
  /** LM fit evidence with tensors and losses, independently of held-out evaluation. */
  readonly training?: JsonValue;
  /** Measured peak resident memory in bytes for the LM trainer. */
  readonly peak_memory_bytes?: number;
}
/** One reservation and job outcome, committed together as a real Task body. */
export interface ProcessJob<P extends { readonly digest: string } = BanditCheckpoint> {
  /** Distinguishes execution Tasks from unrelated workspace work. */
  readonly format: "pm-rl/process-job/1";
  /** Stable requested tracker key derived from the immutable inputs and trusted launcher identity. */
  readonly id: string;
  /** Immutable inputs' content identity. */
  readonly input: string;
  /** Explicit programme and generation binding for status and audit reconstruction. */
  readonly binding: JsonValue;
  /** Original approved budget Decision; replay cannot switch approvals. */
  readonly approval: string;
  /** Digest of the exact approval specification at reservation time. */
  readonly budget_digest: string;
  /** Current execution state. */
  readonly state: ProcessJobState;
  /** Per-job upper bound, held in full until settlement. */
  readonly allowance: Resources;
  /** Held or settled charge against the original budget. */
  readonly charge: Resources;
  /** Whether unused allowance has been released. */
  readonly settled: boolean;
  /** Staging receipt adopted after validation, or null before materialization. */
  readonly completion: ProcessCompletion<P> | null;
  /** Recorded terminal outcome or phase description. */
  readonly outcome: string;
  /** Cleanup diagnostics retained independently of the trainer outcome and validated completion. */
  readonly cleanup?: { readonly code: "cleanup_failed"; readonly error: string };
}
/** Workspace coordinates for the SDK transaction journal. */
export interface ProcessCoordinates {
  /** Observe real transaction boundaries for crash and compensation drills. */
  readonly onTransition?: (context: WorkspaceTransactionTransitionContext) => void | Promise<void>;
  /** Tracker root owning staging and reservations. */
  readonly pmRoot: string;
  /** Attributable transaction author. */
  readonly author: string;
}
/** Hash canonical JSON without retaining commands, hostnames or absolute paths in tracker records. */
export function processDigest(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalJson(value as JsonValue)).digest("hex")}`;
}
/** Validate a complete integer vector at the protocol and approval boundaries. */
export function parseResources(value: unknown): Resources {
  if (value === null || typeof value !== "object" || Array.isArray(value)) expectedFail("A complete resource vector is required.", "process_invalid_resources");
  const record = value as Record<string, unknown>;
  for (const key of RESOURCE_KEYS) {
    if (!Number.isSafeInteger(record[key]) || Number(record[key]) < 0) expectedFail(`Invalid resource dimension ${key}.`, "process_invalid_resources");
  }
  return Object.fromEntries(RESOURCE_KEYS.map((key) => [key, record[key]])) as Resources;
}
/** Validate an explicitly bounded CLI adapter; no arbitrary command field is accepted. */
export function parseProcessAdapter(value: unknown): ProcessAdapter {
  if (value === null || typeof value !== "object" || Array.isArray(value)) expectedFail("Invalid process adapter.", "process_invalid_adapter");
  const record = value as Record<string, unknown>;
  const lm = record["kind"] === "compose-lm";
  const compose = record["kind"] === "compose-bandit" || lm;
  if ((!compose && record["kind"] !== "process-bandit") || Object.keys(record).some((key) => key !== "kind" && key !== "allowance" && !(compose && key === "image") && !(lm && ["memory_bytes", "cpus"].includes(key)))) expectedFail("Select process-bandit or compose-bandit.", "process_invalid_adapter");
  if (compose && (typeof record["image"] !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(record["image"]))) expectedFail("Compose requires a local immutable image ID.", "process_invalid_adapter");
  const allowance = parseResources(record["allowance"]);
  if (allowance.training_steps < 1 || allowance.training_steps > (lm ? 10_000 : MAX_BANDIT_FIT_STEPS) || allowance.wall_ms < 1 || allowance.wall_ms > 3_600_000 || allowance.storage_bytes < 1 || allowance.storage_bytes > 1_073_741_824) expectedFail("Process training requires bounded optimizer steps, wall time and staging bytes.", "process_invalid_allowance");
  if (lm) {
    if (!Number.isSafeInteger(record["memory_bytes"]) || Number(record["memory_bytes"]) < 16_777_216 || Number(record["memory_bytes"]) > 1_073_741_824
      || typeof record["cpus"] !== "number" || record["cpus"] < 0.1 || record["cpus"] > 4 || !Number.isFinite(record["cpus"])) expectedFail("LM requires bounded memory and CPU ceilings.", "process_invalid_allowance");
    return { kind: "compose-lm", image: record["image"] as string, memory_bytes: Number(record["memory_bytes"]), cpus: record["cpus"], allowance };
  }
  return compose ? { kind: "compose-bandit", image: record["image"] as string, allowance } : { kind: "process-bandit", allowance };
}
/** Resolve the packaged reference script for either source execution or the compiled package. */
export function referenceTrainerArgv(moduleUrl = import.meta.url): readonly string[] {
  const suffix = moduleUrl.endsWith(".ts") ? "ts" : "js";
  return [process.execPath, fileURLToPath(new URL(`./process-bandit.${suffix}`, moduleUrl))];
}
/** Derive replay identity including the trusted executable selection without persisting its paths. */
export function processJobId(input: TrainerInput, argv: readonly string[] = referenceTrainerArgv(), adapter?: ProcessAdapter): string {
  const launcher = adapter?.kind === "compose-lm" ? ["pm-rl/compose-lm/1", adapter] : adapter?.kind === "compose-bandit" ? ["pm-rl/compose-bandit/1", adapter.image] : argv;
  return `process-${processDigest({ input, launcher: processDigest(launcher) }).slice(7)}`;
}
/** Resolve this job's retained evidence directory under the tracker. */
export function processStaging(root: string, id: string, stored = false): string {
  const retained = statePath(root, "runtime", "pm-rl", "jobs", storedStateComponent(id));
  if (stored || existsSync(retained)) return retained;
  return statePath(root, "runtime", "pm-rl", "jobs", canonicalIdentifier(id));
}
/** Stable job coordinates and protocol markers distinguish process records before body parsing. */
const PROCESS_RECORD = { type: "Task", tag: "rl-process-job", format: "pm-rl/process-job/1" };
/** Match only canonical package coordinates, excluding copies with an extra prefix. */
function processNamespace(prefix: string): (id: string) => boolean {
  return (id) => { const match = /(?:^|-)(process-[a-f0-9]{64})$/.exec(id); return match !== null && normalizeItemId(match[1], prefix) === id; };
}
/** Certify the immutable namespace declaration before treating malformed current data as owned capacity. */
async function knownProcessRecord(client: PmClient, id: string, prefix: string): Promise<boolean> {
  const original = (await readCompleteLoopItem(client, id, "1")).item;
  return original.type === "Task" && hasTrackerIdentity(original, PROCESS_RECORD.format, (key) => normalizeItemId(key, prefix));
}

/** Read a complete real item and reject omitted output or damaged job bodies. */
export function readProcessJob<P extends TrainerPolicy>(client: PmClient, id: string, root: string): Promise<ProcessJob<P> | null>;
export function readProcessJob(client: PmClient, id: string): Promise<ProcessJob<TrainerPolicy> | null>;
/** Read metadata without a root, or hydrate a typed checkpoint using explicit tracker coordinates. */
export async function readProcessJob(client: PmClient, id: string, root?: string): Promise<ProcessJob<TrainerPolicy> | null> {
  id = operationIdentifier(id);
  const item = await readCompleteLoopItem(client, id).catch((error: unknown) => {
    if (isPmCliExpectedError(error) && error.exitCode === EXIT_CODE.NOT_FOUND) return null;
    throw error;
  });
  if (item === null) return null;
  const prefix = String((await identifierClient(client).config("project", "get", "id_prefix")).nested_setting!.value);
  const namespace = processNamespace(prefix);
  const legacy = hasTrackerIdentity(item.item, PROCESS_RECORD.format, (key) => normalizeItemId(key, prefix));
  let decoded = decodeTrackerRecord(client, item.item, { ...PROCESS_RECORD, namespace, legacy, valid: (row) => typeof row.id === "string" && normalizeItemId(operationIdentifier(row.id), prefix) === item.item.id });
  if (decoded === null) {
    if (!namespace(item.item.id) || !await knownProcessRecord(client, item.item.id, prefix)) return null;
    // A legacy tag edit cannot hide owned capacity; foreign originals remain skipped.
    decoded = decodeTrackerRecord(client, item.item, { ...PROCESS_RECORD, namespace, legacy: true, valid: (row) => typeof row.id === "string" && normalizeItemId(operationIdentifier(row.id), prefix) === item.item.id });
    if (decoded === null) expectedFail("Owned job envelope drifted.", "process_job_drift");
  }
  const job = decoded as unknown as ProcessJob<TrainerPolicy>;
  if (!["planned", "running", "materialized", "evaluated", "promoted", "failed", "cancelled", "invalidated"].includes(job.state)) expectedFail("Job identity or state drifted.", "process_job_drift");
  parseResources(job.allowance); parseResources(job.charge);
  if (job.completion !== null) {
    if (typeof job.completion !== "object" || Array.isArray(job.completion)) expectedFail("Job completion envelope drifted.", "process_job_drift");
    parseResources(job.completion.usage);
  }
  if (typeof job.settled !== "boolean" || (!job.settled && processDigest(job.charge) !== processDigest(job.allowance))
    || (job.completion !== null && processDigest(job.charge) !== processDigest(job.completion.usage))) expectedFail("Reservation accounting drifted.", "process_job_drift");
  if (root !== undefined && job.completion?.artifact !== undefined) return { ...job, completion: { ...job.completion, policy: readCheckpointArtifact(root, job.completion.artifact) as TrainerPolicy } };
  return job;
}
/** Strip hydrated prefix parameters before writing tracker bodies or comparing durable receipts. */
function storedProcessJob<P extends TrainerPolicy>(job: ProcessJob<P>): ProcessJob<TrainerPolicy> {
  if (job.completion?.artifact === undefined) return job;
  return { ...job, completion: { ...job.completion, policy: { digest: job.completion.policy.digest } } };
}
/** Read the existing approved specification without creating or enlarging a Decision. */
async function approvedResources(client: PmClient, approval: string): Promise<{ budget: Resources; digest: string; id: string }> {
  const item = await readCompleteLoopItem(client, approval);
  const fence = /```json\n([\s\S]+?)\n```/u.exec(String(item.item.body));
  if (item.item.type !== "Decision" || fence === null) expectedFail("An existing approved resource Decision is required.", "process_budget_invalid");
  const spec = parseBoundedJson(fence[1]) as Record<string, unknown>;
  return { budget: parseResources(spec["resource_budget"]), digest: processDigest(spec), id: String(item.item.id) };
}
/** Refuse a changed budget identity before adopting, evaluating or promoting a job. */
export async function verifyProcessJobBudget(client: PmClient, job: ProcessJob<TrainerPolicy>): Promise<void> {
  const approved = await approvedResources(client, job.approval);
  if (job.budget_digest !== approved.digest) expectedFail("Approved budget identity changed.", "process_budget_drift");
}

/**
 * Identify a stored process job by its parsed format, independent of JSON spacing or key order.
 *
 * Stored records preserve their literal id by default; stored=false validates a new declaration and unrelated bodies return null.
 */
export function processJobBodyId(body: string, stored = true): string | null {
  const row = decodeTrackerRecord(null, { type: "Task", body }, { type: "Task", format: "pm-rl/process-job/1", valid: (value) => { if (stored) operationIdentifier(value.id); else value.id = canonicalIdentifier(identifier(value.id)); return true; } });
  return row === null ? null : String(row.id);

}

/**
 * Enumerate certified job coordinates, then resolve authoritative records before charging capacity.
 *
 * Package namespace, tags and protocol markers exclude foreign records. Known-owned malformed originals
 * remain integrity refusals; foreign replacements cannot enter the returned job list as null payloads.
 */
export async function listProcessJobs(client: PmClient): Promise<ProcessJob<TrainerPolicy>[]> {
  const listed = certifyCompleteListResult(await identifierClient(client).listAllComplete({ includeBody: true }));
  const jobs: ProcessJob<TrainerPolicy>[] = [];
  const prefix = String((await identifierClient(client).config("project", "get", "id_prefix")).nested_setting!.value);
  const namespace = processNamespace(prefix);
  for (const item of listed.items) {
    const coordinate = /(?:^|-)(process-[a-f0-9]{64})$/.exec(item.id);
    if (coordinate === null || !namespace(item.id)) {
      if (item.tags?.includes("rl-process-job") || /(?:^|-)process-/.test(item.id)) decodeTrackerRecord(client, item, { ...PROCESS_RECORD, namespace });
      continue;
    }
    const current = await readProcessJob(client, coordinate[1]);
    if (current !== null) jobs.push(current);
  }
  return jobs;
}

/** Reserve once under the workspace writer lock, counting every held or settled job on this approval. */
export async function reserveProcessJob(client: PmClient, coordinates: ProcessCoordinates, rawId: string, input: TrainerInput, approval: string, allowance: Resources): Promise<ProcessJob<TrainerPolicy>> {
  const id = await canonicalProgrammeId(client, rawId);
  parseResources(allowance); encodeBoundedJson(input);
  /** Validate both new capacity and existing immutable replay inputs before creating a transaction. */
  async function validateReservation(): Promise<void> {
    const approved = await approvedResources(client, approval);
    const existing = await readProcessJob(client, id);
    if (existing !== null) {
      if (existing.input !== processDigest(input) || existing.approval !== approved.id || processDigest(existing.allowance) !== processDigest(allowance)) expectedFail("Reservation replay inputs changed.", "process_job_drift");
      await verifyProcessJobBudget(client, existing);
      return;
    }
    const charges = (await listProcessJobs(client)).filter((job) => job.approval === approved.id).map((job) => job.charge);
    for (const key of RESOURCE_KEYS) {
      const total = charges.reduce((sum, charge) => sum + charge[key], allowance[key]);
      if (!Number.isSafeInteger(total) || total > approved.budget[key]) expectedFail(`Approved ${key} budget exhausted.`, "process_budget_exhausted");
    }
  }
  const step: WorkspaceTransactionStep = {
    id: "reserve",
    async inspect() { return { state: await readProcessJob(client, id) === null ? "pending" : "applied" }; },
    async apply() {
      await validateReservation();
      const approved = await approvedResources(client, approval);
      const job: ProcessJob<TrainerPolicy> = { format: "pm-rl/process-job/1", id, input: processDigest(input), binding: input.identity, approval: approved.id, budget_digest: approved.digest,
        state: "planned", allowance, charge: allowance, settled: false, completion: null, outcome: "reserved" };
      await identifierClient(client).create({ id, type: "Task", tags: "rl-process-job", title: `Process trainer ${id.slice(-12)}`, body: encodeBoundedJson(job, MAX_TRACKER_RECORD_BYTES) });
    },
    async compensate() { const job = (await readProcessJob(client, id))!; await identifierClient(client).update(id, { body: encodeBoundedJson({ ...job, state: "failed", settled: true, charge: zeroResources(), outcome: "reservation_compensated" }, MAX_TRACKER_RECORD_BYTES) }); },
  };
  await withValidatedMutation(client, id, validateReservation, () => commitProcessTransaction({ ...coordinates, transactionId: `${id}-reserve`, steps: [step] }));
  const job = (await readProcessJob(client, id))!;
  return job;
}
/** Construct the explicitly released allowance after a compensated reservation. */
function zeroResources(): Resources { return { training_steps: 0, wall_ms: 0, storage_bytes: 0, compute_units: 0, tokens: 0 }; }
/** Allowed forward transitions; terminal artifacts are retained and promoted jobs may be invalidated. */
const JOB_TRANSITIONS: Readonly<Record<ProcessJobState, readonly ProcessJobState[]>> = {
  planned: ["running", "failed", "cancelled"], running: ["materialized", "failed", "cancelled"], materialized: ["evaluated", "failed", "cancelled", "invalidated"],
  evaluated: ["promoted", "failed", "cancelled", "invalidated"], promoted: ["invalidated"], failed: [], cancelled: [], invalidated: [],
};
/** Commit one job transition and its receipt/accounting together, with append-only compensation. */
export async function transitionProcessJob<P extends TrainerPolicy>(client: PmClient, coordinates: ProcessCoordinates, job: ProcessJob<P>, state: ProcessJobState, outcome: string, completion = job.completion, charge = job.charge): Promise<ProcessJob<P>> {
  if (job.state !== state && !JOB_TRANSITIONS[job.state].includes(state)) expectedFail("Illegal process job transition.", "process_job_drift");
  const target = job.state === state ? job : { ...job, state, outcome, completion, charge, settled: state !== "running" && state !== "planned" };
  parseResources(target.allowance); parseResources(target.charge);
  if (target.completion !== null) parseResources(target.completion.usage);
  if ((!target.settled && processDigest(target.charge) !== processDigest(target.allowance)) || (target.completion !== null && processDigest(target.charge) !== processDigest(target.completion.usage))) expectedFail("Reservation accounting drifted.", "process_job_drift");
  const body = encodeBoundedJson(storedProcessJob(target), MAX_TRACKER_RECORD_BYTES);
  const compensationBody = encodeBoundedJson(storedProcessJob(job), MAX_TRACKER_RECORD_BYTES);
  await withValidatedMutation(client, job.id, async () => {
    const current = (await readProcessJob(client, job.id))!;
    if (processDigest(current) !== processDigest(storedProcessJob(job)) && processDigest(current) !== processDigest(storedProcessJob(target))) expectedFail("Process job changed before transition.", "process_job_drift");
    if (completion?.artifact !== undefined) readCheckpointArtifact(coordinates.pmRoot, completion.artifact);
  }, async () => {
  if (completion?.artifact !== undefined) {
    const policy = readCheckpointArtifact(coordinates.pmRoot, completion.artifact);
    await encodeCheckpointArtifacts(coordinates.pmRoot, `job:${job.id}:${state}`, policy);
  }
  await commitProcessTransaction({ ...coordinates, transactionId: `${job.id}-${state}`, steps: [{ id: "outcome",
    async inspect() { const current = (await readProcessJob(client, job.id))!; return { state: processDigest(current) === processDigest(storedProcessJob(target)) ? "applied" : "pending" }; },
    async apply() { await identifierClient(client).update(job.id, { body }); },
    async compensate() { await identifierClient(client).update(job.id, { body: compensationBody }); },
  }] });
  });
  return (await readProcessJob<P>(client, job.id, coordinates.pmRoot))!;
}
/** Measure retained flat staging files, skipping vanished entries and rejecting links or directories. */
export function stagingBytes(directory: string, callback?: string): number {
  let bytes = 0;
  const operation = <T,>(site: string, execute: () => T): T => callback === undefined ? execute() : callbackOperation(`${callback}.staging.${site}`, execute);
  for (const name of operation("list", () => readdirSync(directory))) {
    const stat = operation("stat", () => lstatSync(operation("path", () => statePath(directory, name)), { throwIfNoEntry: false }));
    if (stat === undefined) continue;
    if (!stat.isFile()) expectedFail("Staging contains an unsupported file or symbolic link.", "process_checkpoint_invalid");
    bytes += stat.size;
  }
  return bytes;
}
/** Preserve SDK-recorded accounting across the fractional and integer-millisecond filesystem clocks used by supported historical writers. */
function recordedWallTime(file: string, started: number, declared: number, measured: number, recorded: number | undefined): number {
  if (recorded === undefined || recorded === measured) return measured;
  const ns = lstatSync(file, { bigint: true }).mtimeNs;
  const ms = Number(ns / 1_000_000_000n) * 1000 + Number(ns % 1_000_000_000n) / 1_000_000;
  const fine = Math.max(declared, Math.ceil(ms - started));
  const coarse = Math.max(declared, Math.floor(ms) - started);
  if (recorded !== fine && recorded !== coarse) expectedFail("Recorded wall accounting differs from both supported filesystem clocks. Restore the recorded completion and original staging files before retrying.", "process_job_drift");
  return recorded;
}
/** Validate the staged completion against immutable input, readable bytes and every resource dimension. */
export function validateProcessCompletion<P extends TrainerPolicy>(directory: string, id: string, input: ProcessInput<P>, allowance: Resources, artifactRoot = directory, recordedWallMs?: number): ProcessCompletion<P> {
  id = operationIdentifier(id);
  if (recordedWallMs !== undefined) parseResources({ ...zeroResources(), wall_ms: recordedWallMs });
  if (!existsSync(statePath(directory, "completion.json"))) expectedFail("Trainer supplied no completion receipt.", "process_receipt_required");
  const bytes = stagingBytes(directory);
  if (bytes > allowance.storage_bytes || lstatSync(statePath(directory, "completion.json")).size > 65_536) expectedFail("Trainer exceeded staging storage allowance.", "process_limit_exceeded");
  if (input.prefix !== undefined && lstatSync(statePath(directory, "completion.json")).size > 4096) expectedFail("Prefix staging receipt exceeds 4096 bytes.", "process_receipt_invalid");
  const saved = parseBoundedJson(readFileSync(statePath(directory, "completion.json"), "utf8")) as ProcessCompletion<P>;
  operationIdentifier(saved.job);
  const value = saved.format === "pm-rl/process-completion/2" ? { ...saved, job: operationIdentifier(saved.job) } : saved;
  if (!["pm-rl/process-completion/1", "pm-rl/process-completion/2"].includes(value.format) || operationIdentifier(value.job) !== id || value.checkpoint !== "checkpoint.json"
    || processDigest(value.training_config) !== processDigest(input.training_config) || value.source_policy !== input.source.digest
    || processDigest(value.lineage) !== processDigest(input.lineage)) expectedFail("Completion lineage or configuration drifted.", "process_receipt_invalid");
  if (lstatSync(statePath(directory, value.checkpoint)).size > (input.lm?.config.limits.maxCheckpointBytes ?? 4096)) expectedFail("Checkpoint exceeds its schema bound.", "process_checkpoint_invalid");
  let content = readFileSync(statePath(directory, value.checkpoint));
  if (value.artifact !== undefined) {
    if (input.prefix === undefined || processDigest(parseBoundedJson(content.toString("utf8"))) !== processDigest(value.artifact) || value.policy.digest !== value.artifact.policy || value.digest !== value.artifact.digest) expectedFail("Checkpoint reference differs from its completion.", "process_checkpoint_invalid");
    content = Buffer.from(JSON.stringify(readCheckpointArtifact(artifactRoot, value.artifact)));
  } else if (input.prefix !== undefined) expectedFail("Prefix checkpoint requires an artifact reference.", "process_checkpoint_invalid");
  const digest = `sha256:${createHash("sha256").update(content).digest("hex")}`;
  if (digest !== value.digest) expectedFail("Checkpoint content digest or parameters are invalid.", "process_checkpoint_invalid");
  if (input.lm !== undefined) validateLmProcessCheckpoint(content, value, input);
  else if (input.prefix !== undefined) validatePrefixCompletion(content, { policy: parseBoundedJson(content.toString("utf8")) as P }, input);
  else {
    const policy = parseBoundedJson(content.toString("utf8")) as BanditCheckpoint;
    try {
      if (processDigest(policy) !== processDigest(value.policy) || !Number.isFinite(policy.weight) || Math.abs(policy.weight) > 20 || policy.digest !== banditCheckpoint(policy.weight, policy.coefficients).digest) throw new Error("bandit_checkpoint");
    } catch { expectedFail("Checkpoint content digest or parameters are invalid.", "process_checkpoint_invalid"); }
  }
  const usage = parseResources(value.usage);
  if (usage.training_steps !== input.training_config.steps || usage.storage_bytes !== content.length) expectedFail("Completion lacks measured training or checkpoint use.", "process_receipt_invalid");
  for (const key of RESOURCE_KEYS) if (usage[key] > allowance[key]) expectedFail(`Trainer exceeded reserved ${key}.`, "process_limit_exceeded");
  if (lstatSync(statePath(directory, "runner.json")).size > 4096) expectedFail("Trainer identity metadata exceeds its schema bound.", "process_receipt_invalid");
  const runner = parseBoundedJson(readFileSync(statePath(directory, "runner.json"), "utf8")) as { started_at: number };
  if (!Number.isSafeInteger(runner.started_at) || runner.started_at <= 0 || runner.started_at > lstatSync(statePath(directory, "completion.json")).mtimeMs + 1) expectedFail("Trainer wall identity is invalid.", "process_receipt_invalid");
  const wall = recordedWallTime(statePath(directory, "completion.json"), runner.started_at, usage.wall_ms, Math.max(usage.wall_ms, Math.ceil(lstatSync(statePath(directory, "completion.json")).mtimeMs - runner.started_at)), recordedWallMs);
  if (!Number.isSafeInteger(wall) || wall > allowance.wall_ms) expectedFail("Trainer exceeded observed wall allowance.", "process_limit_exceeded");
  const totalBytes = bytes + (value.artifact?.bytes ?? 0);
  if (totalBytes > allowance.storage_bytes) expectedFail("Checkpoint artifact exceeded the approved storage allowance.", "process_limit_exceeded");
  return { ...value, ...(value.artifact === undefined ? {} : { policy: readCheckpointArtifact(artifactRoot, value.artifact) as P }), usage: { ...usage, wall_ms: wall, storage_bytes: totalBytes } };
}
/** Refuse terminal job reuse and verify receipts before they may supply a collection policy. */
export function verifiedProcessPolicy<P extends TrainerPolicy>(job: ProcessJob<TrainerPolicy>, root: string, input: ProcessInput<P>, inspectTerminal = false): P | null {
  if (job.input !== processDigest(input)) expectedFail("Job input identity drifted.", "process_job_drift");
  if (!inspectTerminal && ["failed", "cancelled", "invalidated"].includes(job.state)) expectedFail(`Process job is ${job.state}: ${job.outcome}.`, "process_job_terminal");
  if (job.completion === null) return null;
  const staged = validateProcessCompletion(processStaging(root, job.id, true), job.id, input, job.allowance, root, job.completion.usage.wall_ms);
  if (processDigest(storedProcessJob({ ...job, completion: staged })) !== processDigest(storedProcessJob(job))) expectedFail("Committed completion differs from staging.", "process_job_drift");
  return staged.policy;
}
/** Kill only an exact, locally verified child birth identity; PID reuse never grants stop authority. */
export async function stopTrainer(pid: number, start: string): Promise<void> {
  if (!Number.isSafeInteger(pid) || pid < 1 || pid > 2_147_483_647 || typeof start !== "string" || start.length === 0 || start.length > 512) expectedFail("Use the retained positive PID and exact native birth identity for recovery.", "process_job_drift");
  const stopped = await retryOwnedStop(() => {
    if (loopProcessStartTime(pid) !== start) return true;
    process.kill(pid, "SIGKILL");
    return loopProcessStartTime(pid) !== start;
  });
  if (!stopped) expectedFail("Owned trainer stop failed after six bounded attempts; inspect the retained runner identity and stop that exact process before retrying.", "process_stop_failed");
}
/** Observe operation boundaries in real callback execution; tests may inject one failure without replacing SDK behavior. @internal */
export const controllerCallbackIO: { before: (site: string) => void } = { before: () => undefined };
/** Run one callback operation under the owning callback's error boundary. @internal */
export function callbackOperation<T>(site: string, operation: () => T): T { controllerCallbackIO.before(site); return operation(); }
/** Observe synchronous and asynchronous callback errors without throwing from event dispatch. @internal */
export function controllerCallback<A extends unknown[]>(name: string, failure: (error: unknown) => void, operation: (...args: A) => void | Promise<void>): (...args: A) => void {
  /** Failure sinks record the error before cleanup; dispatch must survive even a faulty sink. */
  const report = (error: unknown): void => { try { failure(error); } catch { /* Never throw from event dispatch or a promise rejection handler. */ } };
  return (...args) => {
    try { controllerCallbackIO.before(`callback.${name}`); void Promise.resolve(operation(...args)).catch(report); }
    catch (error) { report(error); }
  };
}
/** Launch a real child with one stop/reap path for every setup, event, timer and stream failure. */
export async function launchTrainer(directory: string, id: string, input: TrainerInput, allowance: Resources, argv: readonly string[], signal?: AbortSignal, artifactRoot = directory): Promise<void> {
  operationIdentifier(id);
  const request = encodeBoundedJson({ job: id, input, ...(input.prefix === undefined ? {} : { artifactRoot: statePath(artifactRoot) }) });
  const startedAt = Date.now();
  const started = performance.now();
  const child = spawn(argv[0], argv.slice(1), { cwd: directory, shell: false, stdio: ["pipe", "pipe", "pipe"] });
  let failure: unknown;
  let failed = false;
  let complete = false;
  let pending = "";
  let reaped = false;
  let stopping = false;
  let stopExhausted = false;
  let stopTask: Promise<void> | undefined;
  let identity: string | null = null;
  let timer: ReturnType<typeof setInterval> | undefined;
  const decoder = new StringDecoder("utf8");
  let outputBytes = 0;
  let measured = zeroResources();
  /** Detach only this child's handles after a bounded cleanup failure; retain its runner identity for recovery. */
  const detach = (): void => {
    for (const stream of [child.stdin, child.stdout, child.stderr]) {
      try { stream.removeAllListeners("data"); stream.destroy(); } catch { /* Other handles must still be detached. */ }
    }
    try { child.unref(); } catch { /* Terminal failure still settles and releases the owning lease. */ }
  };
  /** Never claim reaping when stop authority could not be exercised; settle conservatively instead. */
  const exhausted = (): void => {
    stopExhausted = true; failed = true;
    failure = createPmCliExpectedError("Owned trainer could not be stopped or reaped after bounded retries; its reservation is conservatively settled and runner identity retained.", { exitCode: EXIT_CODE.CONFLICT, context: { code: "process_stop_failed", required: "Stop the exact retained runner identity and verify it is gone before starting a fresh programme." } });
    close(); detach();
  };
  /** Preserve the first failure; the live ChildProcess handle owns stop authority before identity publication too. */
  const refuse = (error: unknown): void => {
    if (!failed) { failure = error; failed = true; }
    if (stopping || stopExhausted || reaped) return;
    stopping = true;
    stopTask = (async () => {
      try {
        let attempt = 0;
        const stopped = await retryOwnedStop(() => {
          if (reaped || child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return true;
          attempt += 1;
          return callbackOperation("failure.kill", () => attempt === 2 ? process.kill(child.pid!, "SIGKILL") : child.kill("SIGKILL"));
        });
        if (!stopped) {
          if (identity !== null) await stopTrainer(child.pid!, identity);
          else if (!await retryOwnedStop(() => callbackOperation("failure.fallback-kill", () => child.kill("SIGKILL")))) { exhausted(); return; }
        }
        if (!await waitForOwnedClose(closed)) {
          if (child.exitCode !== null || child.signalCode !== null) detach();
          if (!await waitForOwnedClose(closed)) exhausted();
        }
      } catch { exhausted(); }
      finally { stopping = false; }
    })();
    void stopTask.catch(refuse);
  };
  /** The watchdog and abort handler share the same observed failure path. */
  const watchdog = (): void => {
    if (signal?.aborted === true) expectedFail("Trainer cancelled; retained artifacts and settled reservation.", "process_cancelled");
    if (performance.now() - started > allowance.wall_ms || callbackOperation("poll.staging", () => stagingBytes(directory, "poll")) > allowance.storage_bytes) expectedFail("Trainer exceeded wall or staging allowance.", "process_limit_exceeded");
  };
  const poll = controllerCallback("poll", refuse, watchdog);
  const timerPoll = controllerCallback("timer", refuse, watchdog);
  const abortPoll = controllerCallback("abort", refuse, watchdog);
  let close!: () => void;
  const closed = new Promise<void>((resolve) => { close = resolve; });
  child.on("error", controllerCallback("error", refuse, (error: Error) => { refuse(error); }));
  // Reaping acknowledgement is unconditional, including an injected failure in the close callback itself.
  child.once("close", controllerCallback("close", (error) => { reaped = true; refuse(error); close(); }, (code: number | null) => {
    reaped = true; pending += decoder.end();
    if (code !== 0) refuse(createPmCliExpectedError("Trainer exited unsuccessfully; retained artifacts and settled reservation. Inspect the trainer diagnostics before retrying.", { exitCode: EXIT_CODE.CONFLICT, context: { code: "trainer_failure", required: "Inspect retained trainer diagnostics and the approved recovery allowance before retrying." } }));
    close();
  }));
  child.stdout.on("data", controllerCallback("stdout", refuse, (chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > 65_536) expectedFail("Trainer channel exceeded 65536 bytes.", "process_channel_invalid");
      pending += decoder.write(chunk);
      let newline: number;
      while ((newline = pending.indexOf("\n")) >= 0) {
        const line = pending.slice(0, newline); pending = pending.slice(newline + 1);
        callbackOperation("stdout.write", () => writeFileSync(callbackOperation("stdout.path", () => statePath(directory, "events.ndjson")), `${line}\n`, { flag: "a" }));
        const event = parseBoundedJson(line) as { type: string; job: string; usage: Resources; receipt: ProcessCompletion };
        if (complete || operationIdentifier(event.job) !== operationIdentifier(id) || !["progress", "complete"].includes(event.type)) expectedFail("Invalid trainer event sequence.", "process_channel_invalid");
        if (event.type === "complete") { complete = true; const finalUsage = parseResources(event.receipt.usage); for (const key of RESOURCE_KEYS) if (finalUsage[key] < measured[key]) expectedFail("Completion regressed measured use.", "process_limit_exceeded"); if (callbackOperation("stdout.staging", () => stagingBytes(directory, "stdout")) > allowance.storage_bytes || callbackOperation("stdout.stat", () => lstatSync(callbackOperation("stdout.completion-path", () => statePath(directory, "completion.json")))).size > 65_536) expectedFail("Completion channel exceeded its schema bound.", "process_channel_invalid"); const disk = parseBoundedJson(callbackOperation("stdout.read", () => readFileSync(callbackOperation("stdout.read-path", () => statePath(directory, "completion.json")), "utf8"))) as unknown; if (processDigest(event.receipt) !== processDigest(disk)) expectedFail("Stream completion differs from durable receipt.", "process_receipt_invalid"); }
        else {
          const usage = parseResources(event.usage);
          for (const key of RESOURCE_KEYS) if (usage[key] < measured[key] || usage[key] > allowance[key]) expectedFail(`Progress exceeded or regressed ${key}.`, "process_limit_exceeded");
          measured = usage;
        }
      }

    poll();
  }));
  child.stderr.on("data", controllerCallback("stderr", refuse, (chunk: Buffer) => {
    outputBytes += chunk.length;
    if (outputBytes > 65_536) throw new Error("Trainer diagnostics exceeded channel allowance.");
    callbackOperation("stderr.write", () => writeFileSync(callbackOperation("stderr.path", () => statePath(directory, "stderr.log")), chunk, { flag: "a" }));
  }));
  child.stdin.on("error", controllerCallback("stdin", refuse, (error: Error) => { refuse(error); }));
  try {
    await once(child, "spawn");
    identity = loopProcessStartTime(child.pid!);
    if (identity === null) expectedFail("Cannot establish trainer process identity.", "process_identity_unavailable");
    timer = setInterval(timerPoll, 25);
    signal?.addEventListener("abort", abortPoll);
    writeFileSync(statePath(directory, "runner.json"), encodeBoundedJson({ pid: child.pid, start: identity, started_at: startedAt }), { flag: "wx" });
    child.stdin.end(request);
    poll();
    await closed;
    if (failed) throw failure;
    if (!complete || pending.length > 0) expectedFail("Trainer exited without a complete NDJSON receipt.", "process_receipt_required");
  } catch (error) {
    refuse(error);
    await closed;
    if (isPmCliExpectedError(failure)) throw failure;
    throw createPmCliExpectedError(`Trainer failed (${failure instanceof Error ? failure.message : String(failure)}); child reaped and reservation settlement required.`, { exitCode: EXIT_CODE.CONFLICT, context: { code: "process_callback_failed", required: "Restore staging access and use a fresh programme for another fit." } });
  } finally { await stopTask; clearInterval(timer); signal?.removeEventListener("abort", abortPoll); }
}
/** Append trainer diagnostics; a failed append becomes a refusal on the stop-and-settle path instead of an escaped throw. */
export function appendDiagnostics(file: string, chunk: Buffer, refuse: (error: unknown) => void): void {
  try { writeFileSync(checkedStateFile(file), chunk, { flag: "a" }); } catch (error) { refuse(error); }
}
/** Settle failure against reserved use and every trustworthy report, retaining observed excess consumption. */
function failedProcessCharge(directory: string, allowance: Resources): Resources {
  let charge = { ...allowance };
  const files = ["completion.json", "events.ndjson"];
  for (const name of files) {
    try {
      const file = statePath(directory, name);
      if (!existsSync(file) || !lstatSync(file).isFile() || lstatSync(file).size > 65_536) continue;
      for (const line of readFileSync(file, "utf8").split("\n").filter((line) => line.length > 0)) {
        try {
          const value = parseBoundedJson(line) as { usage?: Resources; receipt?: { usage: Resources } };
          const usage = parseResources(value.usage ?? value.receipt!.usage);
          charge = Object.fromEntries(RESOURCE_KEYS.map((key) => [key, Math.max(charge[key], usage[key])])) as Resources;
        } catch { /* Unreadable reports retain the conservative reserved charge. */ }
      }
    } catch { /* Filesystem failures cannot bypass terminal reservation settlement. */ }
  }
  try { charge.storage_bytes = Math.max(charge.storage_bytes, stagingBytes(directory)); }
  catch { /* Unsupported staging remains in place and retains its reserved charge. */ }
  return charge;
}

/** Recover staged work or execute exactly one reserved phase; failures settle conservatively and retain evidence. */
export async function executeProcessTrainer<P extends TrainerPolicy>(client: PmClient, coordinates: ProcessCoordinates, input: ProcessInput<P>, approval: string, adapter: ProcessAdapter, signal?: AbortSignal, argv: readonly string[] = referenceTrainerArgv()): Promise<ProcessJob<P>> {
  if (input.training_config.steps !== adapter.allowance.training_steps) expectedFail("Optimizer steps differ from the declared reservation.", "process_invalid_adapter");
  if (input.prefix !== undefined && (input.lm !== undefined || adapter.kind !== "process-bandit")) expectedFail("Prefix fits require the packaged process adapter.", "process_invalid_adapter");
  if ((input.lm !== undefined) !== (adapter.kind === "compose-lm") || (input.lm !== undefined && adapter.kind === "compose-lm" && input.lm.memory_bytes !== adapter.memory_bytes)) expectedFail("Trainer payload differs from the declared adapter limits.", "process_invalid_adapter");
  encodeBoundedJson(input);
  const id = processJobId(input, argv, adapter);
  encodeBoundedJson({ job: id, input, ...(input.prefix === undefined ? {} : { artifactRoot: resolve(processStaging(coordinates.pmRoot, id), "../../../..") }) });
  return withProcessJobFence(coordinates, id, async () => await executeReservedProcessJob(client, coordinates, input, approval, adapter, id, signal, argv) as ProcessJob<P>);
}

/** Execute inside the verified owner fence; this function never re-launches a previously running job. */
async function executeReservedProcessJob(client: PmClient, coordinates: ProcessCoordinates, input: TrainerInput, approval: string, adapter: ProcessAdapter, id: string, signal: AbortSignal | undefined, argv: readonly string[]): Promise<ProcessJob<TrainerPolicy>> {
  let job = await reserveProcessJob(client, coordinates, id, input, approval, adapter.allowance);
  const policy = verifiedProcessPolicy(job, coordinates.pmRoot, input);
  if (policy !== null) return transitionProcessJob(client, coordinates, job, job.state, job.outcome);
  let directory = coordinates.pmRoot;
  const diagnostics: { cleanup?: ProcessJob["cleanup"] } = {};
  /** Attach bounded cleanup evidence to the same durable settlement, without exposing the staging path. */
  const cleanupFailed = (error: unknown): void => { diagnostics.cleanup = { code: "cleanup_failed", error: String(error).replaceAll(directory, "<staging>").slice(0, 4096) }; };
  try {
    directory = processStaging(coordinates.pmRoot, job.id, true);
    mkdirSync(directory, { recursive: true });
    if (job.state === "planned") {
      job = await transitionProcessJob(client, coordinates, job, "running", "launched");
      if (adapter.kind !== "process-bandit") await launchComposeTrainer(directory, id, input, job.allowance, adapter.image, cleanupFailed, signal, adapter.kind === "compose-lm" ? adapter : undefined);
      else await launchTrainer(directory, job.id, input, job.allowance, argv, signal, coordinates.pmRoot);
    } else {
      if (adapter.kind !== "process-bandit") {
        try { await stopComposeTrainer(directory, id, adapter.image, "recovery", adapter.kind === "compose-lm" ? adapter : undefined); }
        catch (error) { cleanupFailed(error); }
      }
      else if (existsSync(statePath(directory, "runner.json"))) {
        const runner = parseBoundedJson(readFileSync(statePath(directory, "runner.json"), "utf8")) as { pid: number; start: string };
        await stopTrainer(runner.pid, runner.start);
      }
    }
    const completion = validateProcessCompletion(directory, id, input, job.allowance, coordinates.pmRoot);
    return await transitionProcessJob(client, coordinates, { ...job, ...diagnostics }, "materialized", "receipt_validated", completion, completion.usage);
  } catch (error) {
    if (isPmCliExpectedError(error) && error.context.code === "process_stop_failed") cleanupFailed(error);
    const state = signal?.aborted === true ? "cancelled" : "failed";
    const charge = job.state === "planned" ? zeroResources() : failedProcessCharge(directory, job.allowance);
    await transitionProcessJob(client, coordinates, { ...job, ...diagnostics }, state, isPmCliExpectedError(error) ? String(error.context.code) : "trainer_failure", null, charge);
    throw error;
  }
}
