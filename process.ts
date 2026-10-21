/** Durable argv-only trainer execution, staged receipts and approved resource reservations. */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";
import type { WorkspaceTransactionStep, WorkspaceTransactionTransitionContext } from "@unbrained/pm-cli/sdk";
import type { PmClient } from "@unbrained/pm-cli/sdk/core";
import { EXIT_CODE, isPmCliExpectedError, certifyCompleteListResult } from "@unbrained/pm-cli/sdk/runtime";
import { banditCheckpoint, MAX_BANDIT_FIT_STEPS, type BanditCheckpoint, type BanditExample, type BanditObservation } from "./bandit.ts";
import { canonicalJson, commitProcessTransaction, loopProcessStartTime, withProcessJobFence, readCompleteLoopItem, type JsonValue } from "./index.ts";
import { expectedFail } from "./refuse.ts";
import { validateLmProcessCheckpoint, type LmProcessPayload } from "./process-lm.ts";
import { validatePrefixCompletion, type PrefixPayload } from "./prefix.ts";
import { launchComposeTrainer, stopComposeTrainer } from "./compose.ts";
import { encodeCheckpointArtifacts, readCheckpointArtifact, type CheckpointArtifact } from "./checkpoint-artifacts.ts";

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
  readonly format: "pm-rl/process-completion/1";
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
export function processStaging(root: string, id: string): string {
  return join(root, "runtime", "pm-rl", "jobs", id);
}
/** Read a complete real item and reject omitted output or damaged job bodies. */
export function readProcessJob<P extends TrainerPolicy>(client: PmClient, id: string, root: string): Promise<ProcessJob<P> | null>;
export function readProcessJob(client: PmClient, id: string): Promise<ProcessJob<TrainerPolicy> | null>;
/** Read metadata without a root, or hydrate a typed checkpoint using explicit tracker coordinates. */
export async function readProcessJob(client: PmClient, id: string, root?: string): Promise<ProcessJob<TrainerPolicy> | null> {
  const item = await readCompleteLoopItem(client, id).catch((error: unknown) => {
    if (isPmCliExpectedError(error) && error.exitCode === EXIT_CODE.NOT_FOUND) return null;
    throw error;
  });
  if (item === null) return null;
  const job = JSON.parse(String(item.item.body)) as ProcessJob<TrainerPolicy>;
  if (item.item.type !== "Task" || job.format !== "pm-rl/process-job/1" || job.id !== id || !["planned", "running", "materialized", "evaluated", "promoted", "failed", "cancelled", "invalidated"].includes(job.state)) expectedFail("Job identity or state drifted.", "process_job_drift");
  parseResources(job.allowance); parseResources(job.charge);
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
  const spec = JSON.parse(fence[1]) as Record<string, unknown>;
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
 * Returns the job's own id (item ids carry the tracker prefix, job ids do not), or null for any other body.
 */
export function processJobBodyId(body: string): string | null {
  if (!body.includes("pm-rl/process-job/1")) return null;
  try {
    const parsed = Object(JSON.parse(body)) as { format?: unknown; id?: unknown };
    return parsed.format === "pm-rl/process-job/1" && typeof parsed.id === "string" ? parsed.id : null;
  } catch { return null; }
}

/**
 * Every process job in the tracker, read once through a body-inclusive certified listing.
 *
 * A job body counts only on the item that is that job (item ids carry the tracker prefix), so a job body
 * copied into another item neither double-charges a reservation nor names a job that does not exist.
 */
export async function listProcessJobs(client: PmClient): Promise<ProcessJob<TrainerPolicy>[]> {
  const listed = certifyCompleteListResult(await client.listAllComplete({ includeBody: true }));
  const jobs: ProcessJob<TrainerPolicy>[] = [];
  for (const item of listed.items) {
    const jobId = processJobBodyId(String(item.body));
    if (jobId === null || (!item.id.endsWith(`-${jobId}`) && item.id !== jobId)) continue;
    // Bound to its own existing item, so the job is present.
    jobs.push((await readProcessJob(client, jobId))!);
  }
  return jobs;
}

/** Reserve once under the workspace writer lock, counting every held or settled job on this approval. */
export async function reserveProcessJob(client: PmClient, coordinates: ProcessCoordinates, id: string, input: TrainerInput, approval: string, allowance: Resources): Promise<ProcessJob<TrainerPolicy>> {
  const step: WorkspaceTransactionStep = {
    id: "reserve",
    async inspect() { return { state: await readProcessJob(client, id) === null ? "pending" : "applied" }; },
    async apply() {
      const approved = await approvedResources(client, approval);
      const charges = (await listProcessJobs(client)).filter((job) => job.approval === approved.id).map((job) => job.charge);
      for (const key of RESOURCE_KEYS) {
        const total = charges.reduce((sum, charge) => sum + charge[key], allowance[key]);
        if (!Number.isSafeInteger(total) || total > approved.budget[key]) expectedFail(`Approved ${key} budget exhausted.`, "process_budget_exhausted");
      }
      const job: ProcessJob<TrainerPolicy> = { format: "pm-rl/process-job/1", id, input: processDigest(input), binding: input.identity, approval: approved.id, budget_digest: approved.digest,
        state: "planned", allowance, charge: allowance, settled: false, completion: null, outcome: "reserved" };
      await client.create({ id, type: "Task", title: `Process trainer ${id.slice(-12)}`, body: JSON.stringify(job) });
    },
    async compensate() { const job = (await readProcessJob(client, id))!; await client.update(id, { body: JSON.stringify({ ...job, state: "failed", settled: true, charge: zeroResources(), outcome: "reservation_compensated" }) }); },
  };
  await commitProcessTransaction({ ...coordinates, transactionId: `${id}-reserve`, steps: [step] });
  const job = (await readProcessJob(client, id))!;
  const approved = await approvedResources(client, approval);
  if (job.input !== processDigest(input) || job.approval !== approved.id || processDigest(job.allowance) !== processDigest(allowance)) expectedFail("Reservation replay inputs changed.", "process_job_drift");
  await verifyProcessJobBudget(client, job);
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
  if (completion?.artifact !== undefined) {
    const policy = readCheckpointArtifact(coordinates.pmRoot, completion.artifact);
    await encodeCheckpointArtifacts(coordinates.pmRoot, `job:${job.id}:${state}`, policy);
  }
  await commitProcessTransaction({ ...coordinates, transactionId: `${job.id}-${state}`, steps: [{ id: "outcome",
    async inspect() { const current = (await readProcessJob(client, job.id))!; return { state: processDigest(current) === processDigest(storedProcessJob(target)) ? "applied" : "pending" }; },
    async apply() { await client.update(job.id, { body: JSON.stringify(storedProcessJob(target)) }); },
    async compensate() { await client.update(job.id, { body: JSON.stringify(storedProcessJob(job)) }); },
  }] });
  return (await readProcessJob<P>(client, job.id, coordinates.pmRoot))!;
}
/** Measure all retained flat staging files, rejecting links and directories rather than following them. */
export function stagingBytes(directory: string): number {
  let bytes = 0;
  for (const name of readdirSync(directory)) {
    const stat = lstatSync(join(directory, name));
    if (!stat.isFile()) expectedFail("Staging contains an unsupported file or symbolic link.", "process_checkpoint_invalid");
    bytes += stat.size;
  }
  return bytes;
}
/** Validate the staged completion against immutable input, readable bytes and every resource dimension. */
export function validateProcessCompletion<P extends TrainerPolicy>(directory: string, id: string, input: ProcessInput<P>, allowance: Resources, artifactRoot = directory): ProcessCompletion<P> {
  if (!existsSync(join(directory, "completion.json"))) expectedFail("Trainer supplied no completion receipt.", "process_receipt_required");
  const bytes = stagingBytes(directory);
  if (bytes > allowance.storage_bytes || lstatSync(join(directory, "completion.json")).size > 65_536) expectedFail("Trainer exceeded staging storage allowance.", "process_limit_exceeded");
  if (input.prefix !== undefined && lstatSync(join(directory, "completion.json")).size > 4096) expectedFail("Prefix staging receipt exceeds 4096 bytes.", "process_receipt_invalid");
  const value = JSON.parse(readFileSync(join(directory, "completion.json"), "utf8")) as ProcessCompletion<P>;
  if (value.format !== "pm-rl/process-completion/1" || value.job !== id || value.checkpoint !== "checkpoint.json"
    || processDigest(value.training_config) !== processDigest(input.training_config) || value.source_policy !== input.source.digest
    || processDigest(value.lineage) !== processDigest(input.lineage)) expectedFail("Completion lineage or configuration drifted.", "process_receipt_invalid");
  if (lstatSync(join(directory, value.checkpoint)).size > (input.lm?.config.limits.maxCheckpointBytes ?? 4096)) expectedFail("Checkpoint exceeds its schema bound.", "process_checkpoint_invalid");
  let content = readFileSync(join(directory, value.checkpoint));
  if (value.artifact !== undefined) {
    if (input.prefix === undefined || processDigest(JSON.parse(content.toString("utf8"))) !== processDigest(value.artifact) || value.policy.digest !== value.artifact.policy || value.digest !== value.artifact.digest) expectedFail("Checkpoint reference differs from its completion.", "process_checkpoint_invalid");
    content = Buffer.from(JSON.stringify(readCheckpointArtifact(artifactRoot, value.artifact)));
  } else if (input.prefix !== undefined) expectedFail("Prefix checkpoint requires an artifact reference.", "process_checkpoint_invalid");
  const digest = `sha256:${createHash("sha256").update(content).digest("hex")}`;
  if (digest !== value.digest) expectedFail("Checkpoint content digest or parameters are invalid.", "process_checkpoint_invalid");
  if (input.lm !== undefined) validateLmProcessCheckpoint(content, value, input);
  else if (input.prefix !== undefined) validatePrefixCompletion(content, { policy: JSON.parse(content.toString("utf8")) as P }, input);
  else {
    const policy = JSON.parse(content.toString("utf8")) as BanditCheckpoint;
    if (processDigest(policy) !== processDigest(value.policy) || !Number.isFinite(policy.weight) || Math.abs(policy.weight) > 20 || policy.digest !== banditCheckpoint(policy.weight).digest) expectedFail("Checkpoint content digest or parameters are invalid.", "process_checkpoint_invalid");
  }
  const usage = parseResources(value.usage);
  if (usage.training_steps !== input.training_config.steps || usage.storage_bytes !== content.length) expectedFail("Completion lacks measured training or checkpoint use.", "process_receipt_invalid");
  for (const key of RESOURCE_KEYS) if (usage[key] > allowance[key]) expectedFail(`Trainer exceeded reserved ${key}.`, "process_limit_exceeded");
  if (lstatSync(join(directory, "runner.json")).size > 4096) expectedFail("Trainer identity metadata exceeds its schema bound.", "process_receipt_invalid");
  const runner = JSON.parse(readFileSync(join(directory, "runner.json"), "utf8")) as { started_at: number };
  if (!Number.isSafeInteger(runner.started_at) || runner.started_at <= 0 || runner.started_at > lstatSync(join(directory, "completion.json")).mtimeMs + 1) expectedFail("Trainer wall identity is invalid.", "process_receipt_invalid");
  const wall = Math.max(usage.wall_ms, Math.ceil(lstatSync(join(directory, "completion.json")).mtimeMs - runner.started_at));
  if (wall > allowance.wall_ms) expectedFail("Trainer exceeded observed wall allowance.", "process_limit_exceeded");
  const totalBytes = bytes + (value.artifact?.bytes ?? 0);
  if (totalBytes > allowance.storage_bytes) expectedFail("Checkpoint artifact exceeded the approved storage allowance.", "process_limit_exceeded");
  return { ...value, ...(value.artifact === undefined ? {} : { policy: readCheckpointArtifact(artifactRoot, value.artifact) as P }), usage: { ...usage, wall_ms: wall, storage_bytes: totalBytes } };
}
/** Refuse terminal job reuse and verify receipts before they may supply a collection policy. */
export function verifiedProcessPolicy<P extends TrainerPolicy>(job: ProcessJob<TrainerPolicy>, root: string, input: ProcessInput<P>, inspectTerminal = false): P | null {
  if (job.input !== processDigest(input)) expectedFail("Job input identity drifted.", "process_job_drift");
  if (!inspectTerminal && ["failed", "cancelled", "invalidated"].includes(job.state)) expectedFail(`Process job is ${job.state}: ${job.outcome}.`, "process_job_terminal");
  if (job.completion === null) return null;
  const staged = validateProcessCompletion(processStaging(root, job.id), job.id, input, job.allowance, root);
  if (processDigest(storedProcessJob({ ...job, completion: staged })) !== processDigest(storedProcessJob(job))) expectedFail("Committed completion differs from staging.", "process_job_drift");
  return staged.policy;
}
/** Kill only an exact, locally verified child birth identity; PID reuse never grants stop authority. */
export function stopTrainer(pid: number, start: string): void {
  if (loopProcessStartTime(pid) === start) process.kill(pid, "SIGKILL");
}
/** Launch a real child with bounded NDJSON, wall/storage polling and owner-checked cancellation. */
export async function launchTrainer(directory: string, id: string, input: TrainerInput, allowance: Resources, argv: readonly string[], signal?: AbortSignal): Promise<void> {
  const startedAt = Date.now();
  const started = performance.now();
  const child = spawn(argv[0], argv.slice(1), { cwd: directory, shell: false, stdio: ["pipe", "pipe", "pipe"] });
  let failure: unknown;
  let complete = false;
  let pending = "";
  const decoder = new StringDecoder("utf8");
  let outputBytes = 0;
  let measured = zeroResources();
  let identity: string | null = null;
  /** Preserve the first refusal while stopping only this child's verified identity. */
  const refuse = (error: unknown): void => { failure ??= error; if (identity !== null) stopTrainer(child.pid!, identity); };
  /** Enforce observed wall/storage and monotonic adapter reports while the child is alive. */
  const poll = (): void => {
    try {
      if (signal?.aborted === true) expectedFail("Trainer cancelled; retained artifacts and settled reservation.", "process_cancelled");
      if (performance.now() - started > allowance.wall_ms || stagingBytes(directory) > allowance.storage_bytes) expectedFail("Trainer exceeded wall or staging allowance.", "process_limit_exceeded");
    } catch (error) { refuse(error); }
  };
  const closed = new Promise<void>((resolve) => {
    child.once("error", (error) => { failure ??= error; });
    child.once("close", (code) => { pending += decoder.end(); if (code !== 0) failure ??= new Error("Trainer exited unsuccessfully."); resolve(); });
  });
  child.stdout.on("data", (chunk: Buffer) => {
    try {
      outputBytes += chunk.length;
      if (outputBytes > 65_536) expectedFail("Trainer channel exceeded 65536 bytes.", "process_channel_invalid");
      pending += decoder.write(chunk);
      let newline: number;
      while ((newline = pending.indexOf("\n")) >= 0) {
        const line = pending.slice(0, newline); pending = pending.slice(newline + 1);
        writeFileSync(join(directory, "events.ndjson"), `${line}\n`, { flag: "a" });
        const event = JSON.parse(line) as { type: string; job: string; usage: Resources; receipt: ProcessCompletion };
        if (complete || event.job !== id || !["progress", "complete"].includes(event.type)) expectedFail("Invalid trainer event sequence.", "process_channel_invalid");
        if (event.type === "complete") { complete = true; const finalUsage = parseResources(event.receipt.usage); for (const key of RESOURCE_KEYS) if (finalUsage[key] < measured[key]) expectedFail("Completion regressed measured use.", "process_limit_exceeded"); if (stagingBytes(directory) > allowance.storage_bytes || lstatSync(join(directory, "completion.json")).size > 65_536) expectedFail("Completion channel exceeded its schema bound.", "process_channel_invalid"); const disk = JSON.parse(readFileSync(join(directory, "completion.json"), "utf8")) as unknown; if (processDigest(event.receipt) !== processDigest(disk)) expectedFail("Stream completion differs from durable receipt.", "process_receipt_invalid"); }
        else {
          const usage = parseResources(event.usage);
          for (const key of RESOURCE_KEYS) if (usage[key] < measured[key] || usage[key] > allowance[key]) expectedFail(`Progress exceeded or regressed ${key}.`, "process_limit_exceeded");
          measured = usage;
        }
      }
      poll();
    } catch (error) { refuse(error); }
  });
  child.stderr.on("data", (chunk: Buffer) => {
    outputBytes += chunk.length;
    if (outputBytes > 65_536) { refuse(new Error("Trainer diagnostics exceeded channel allowance.")); return; }
    appendDiagnostics(join(directory, "stderr.log"), chunk, refuse);
  });
  await once(child, "spawn");
  identity = loopProcessStartTime(child.pid!);
  if (identity === null) { child.kill("SIGKILL"); await closed; expectedFail("Cannot establish trainer process identity.", "process_identity_unavailable"); }
  const timer = setInterval(poll, 25);
  signal?.addEventListener("abort", poll);
  child.stdin.on("error", () => undefined);
  try {
    writeFileSync(join(directory, "runner.json"), JSON.stringify({ pid: child.pid, start: identity, started_at: startedAt }), { flag: "wx" });
    child.stdin.end(JSON.stringify({ job: id, input, ...(input.prefix === undefined ? {} : { artifactRoot: resolve(directory, "../../../..") }) }));
    poll();
    await closed;
  } catch (error) {
    refuse(error);
    await closed;
    throw error;
  } finally { clearInterval(timer); signal?.removeEventListener("abort", poll); }
  if (failure !== undefined) throw failure;
  if (!complete || pending.length > 0) expectedFail("Trainer exited without a complete NDJSON receipt.", "process_receipt_required");
}
/** Append trainer diagnostics; a failed append becomes a refusal on the stop-and-settle path instead of an escaped throw. */
export function appendDiagnostics(file: string, chunk: Buffer, refuse: (error: unknown) => void): void {
  try { writeFileSync(file, chunk, { flag: "a" }); } catch (error) { refuse(error); }
}
/** Settle failure against reserved use and every trustworthy report, retaining observed excess consumption. */
function failedProcessCharge(directory: string, allowance: Resources): Resources {
  let charge = { ...allowance };
  const files = ["completion.json", "events.ndjson"];
  for (const name of files) {
    if (!existsSync(join(directory, name)) || !lstatSync(join(directory, name)).isFile() || lstatSync(join(directory, name)).size > 65_536) continue;
    for (const line of readFileSync(join(directory, name), "utf8").split("\n").filter((line) => line.length > 0)) {
      try {
        const value = JSON.parse(line) as { usage?: Resources; receipt?: { usage: Resources } };
        const usage = parseResources(value.usage ?? value.receipt!.usage);
        charge = Object.fromEntries(RESOURCE_KEYS.map((key) => [key, Math.max(charge[key], usage[key])])) as Resources;
      } catch { /* Unreadable reports retain the conservative reserved charge. */ }
    }
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
  const id = processJobId(input, argv, adapter);
  return withProcessJobFence(coordinates, id, async () => await executeReservedProcessJob(client, coordinates, input, approval, adapter, id, signal, argv) as ProcessJob<P>);
}

/** Execute inside the verified owner fence; this function never re-launches a previously running job. */
async function executeReservedProcessJob(client: PmClient, coordinates: ProcessCoordinates, input: TrainerInput, approval: string, adapter: ProcessAdapter, id: string, signal: AbortSignal | undefined, argv: readonly string[]): Promise<ProcessJob<TrainerPolicy>> {
  let job = await reserveProcessJob(client, coordinates, id, input, approval, adapter.allowance);
  const policy = verifiedProcessPolicy(job, coordinates.pmRoot, input);
  if (policy !== null) return transitionProcessJob(client, coordinates, job, job.state, job.outcome);
  const directory = processStaging(coordinates.pmRoot, id);
  const diagnostics: { cleanup?: ProcessJob["cleanup"] } = {};
  /** Attach bounded cleanup evidence to the same durable settlement, without exposing the staging path. */
  const cleanupFailed = (error: unknown): void => { diagnostics.cleanup = { code: "cleanup_failed", error: String(error).replaceAll(directory, "<staging>").slice(0, 4096) }; };
  try {
    mkdirSync(directory, { recursive: true });
    if (job.state === "planned") {
      job = await transitionProcessJob(client, coordinates, job, "running", "launched");
      if (adapter.kind !== "process-bandit") await launchComposeTrainer(directory, id, input, job.allowance, adapter.image, cleanupFailed, signal, adapter.kind === "compose-lm" ? adapter : undefined);
      else await launchTrainer(directory, id, input, job.allowance, argv, signal);
    } else {
      if (adapter.kind !== "process-bandit") {
        try { await stopComposeTrainer(directory, id, adapter.image, "recovery", adapter.kind === "compose-lm" ? adapter : undefined); }
        catch (error) { cleanupFailed(error); }
      }
      else if (existsSync(join(directory, "runner.json"))) {
        const runner = JSON.parse(readFileSync(join(directory, "runner.json"), "utf8")) as { pid: number; start: string };
        stopTrainer(runner.pid, runner.start);
      }
    }
    const completion = validateProcessCompletion(directory, id, input, job.allowance, coordinates.pmRoot);
    return await transitionProcessJob(client, coordinates, { ...job, ...diagnostics }, "materialized", "receipt_validated", completion, completion.usage);
  } catch (error) {
    const state = signal?.aborted === true ? "cancelled" : "failed";
    const charge = job.state === "planned" ? zeroResources() : failedProcessCharge(directory, job.allowance);
    await transitionProcessJob(client, coordinates, { ...job, ...diagnostics }, state, isPmCliExpectedError(error) ? String(error.context.code) : "trainer_failure", null, charge);
    throw error;
  }
}
