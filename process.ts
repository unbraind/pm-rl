/** Durable argv-only trainer execution, staged receipts and approved resource reservations. */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";
import type { WorkspaceTransactionStep, WorkspaceTransactionTransitionContext } from "@unbrained/pm-cli/sdk";
import type { PmClient } from "@unbrained/pm-cli/sdk/core";
import { EXIT_CODE, isPmCliExpectedError, certifyCompleteListResult } from "@unbrained/pm-cli/sdk/runtime";
import { banditCheckpoint, type BanditCheckpoint, type BanditExample, type BanditObservation } from "./bandit.ts";
import { canonicalJson, commitProcessTransaction, loopProcessStartTime, withProcessJobFence, readCompleteLoopItem, type JsonValue } from "./index.ts";
import { expectedFail } from "./refuse.ts";

/** Independently accounted resource dimensions; all values are nonnegative safe integers. */
export const RESOURCE_KEYS = ["training_steps", "wall_ms", "storage_bytes", "compute_units", "tokens"] as const;
/** A bounded allowance or measured resource vector; compute units are CPU milliseconds in the reference trainer. */
export type Resources = Readonly<Record<(typeof RESOURCE_KEYS)[number], number>>;
/** Programme-selected packaged trainer; commands are never read from tracker item text. */
export interface ProcessAdapter {
  /** Versioned adapter selector; only the packaged bandit trainer is CLI-selectable. */
  readonly kind: "process-bandit";
  /** Maximum allowance atomically reserved before launching this generation. */
  readonly allowance: Resources;
}
/** Domain lifecycle, independent of the tracker item's planning status. */
export type ProcessJobState = "planned" | "running" | "materialized" | "evaluated" | "promoted" | "failed" | "cancelled" | "invalidated";
/** Immutable inputs delivered on stdin; held-out examples are deliberately absent. */
export interface ProcessInput {
  /** Programme, generation, source and dataset identities, environment, reward, collection and fit configuration. */
  readonly identity: JsonValue;
  /** The collecting policy's actual parameters. */
  readonly source: BanditCheckpoint;
  /** Collection dataset only. */
  readonly training: readonly BanditExample[];
  /** Actual source-policy samples; reward values are the training signal. */
  readonly observations: readonly BanditObservation[];
  /** One bounded REINFORCE update configuration. */
  readonly training_config: { readonly learning_rate: number; readonly steps: 1 };
  /** Source and dataset digests bind the receipt to this collected batch. */
  readonly lineage: JsonValue;
}
/** Required durable completion evidence; successful process exit alone is never sufficient. */
export interface ProcessCompletion {
  /** Versioned stream and disk schema. */
  readonly format: "pm-rl/process-completion/1";
  /** Content-bound job identity. */
  readonly job: string;
  /** Only this job's flat staging checkpoint is eligible. */
  readonly checkpoint: "checkpoint.json";
  /** SHA-256 over the exact readable checkpoint bytes. */
  readonly digest: string;
  /** Actual parameters whose policy identity must match the checkpoint content. */
  readonly policy: BanditCheckpoint;
  /** Immutable fit configuration, source policy and dataset lineage. */
  readonly training_config: ProcessInput["training_config"];
  /** Digest of the policy that collected the training batch. */
  readonly source_policy: string;
  /** Training, held-out identity and collection digest; no held-out data. */
  readonly lineage: JsonValue;
  /** Adapter-measured steps, elapsed milliseconds, checkpoint bytes, CPU milliseconds and tokens. */
  readonly usage: Resources;
}
/** One reservation and job outcome, committed together as a real Task body. */
export interface ProcessJob {
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
  readonly completion: ProcessCompletion | null;
  /** Recorded terminal outcome or phase description. */
  readonly outcome: string;
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
  if (record["kind"] !== "process-bandit" || Object.keys(record).some((key) => key !== "kind" && key !== "allowance")) expectedFail("Select the packaged process-bandit adapter.", "process_invalid_adapter");
  const allowance = parseResources(record["allowance"]);
  if (allowance.training_steps !== 1 || allowance.wall_ms < 1 || allowance.wall_ms > 3_600_000 || allowance.storage_bytes < 1 || allowance.storage_bytes > 1_073_741_824) expectedFail("Process training requires one step, bounded wall time and staging bytes.", "process_invalid_allowance");
  return { kind: "process-bandit", allowance };
}
/** Resolve the packaged reference script for either source execution or the compiled package. */
export function referenceTrainerArgv(moduleUrl = import.meta.url): readonly string[] {
  const suffix = moduleUrl.endsWith(".ts") ? "ts" : "js";
  return [process.execPath, fileURLToPath(new URL(`./process-bandit.${suffix}`, moduleUrl))];
}
/** Derive replay identity including the trusted executable selection without persisting its paths. */
export function processJobId(input: ProcessInput, argv: readonly string[] = referenceTrainerArgv()): string {
  return `process-${processDigest({ input, launcher: processDigest(argv) }).slice(7)}`;
}
/** Resolve this job's retained evidence directory under the tracker. */
export function processStaging(root: string, id: string): string {
  return join(root, "runtime", "pm-rl", "jobs", id);
}
/** Read a complete real item and reject omitted output or damaged job bodies. */
export async function readProcessJob(client: PmClient, id: string): Promise<ProcessJob | null> {
  const item = await readCompleteLoopItem(client, id).catch((error: unknown) => {
    if (isPmCliExpectedError(error) && error.exitCode === EXIT_CODE.NOT_FOUND) return null;
    throw error;
  });
  if (item === null) return null;
  const job = JSON.parse(String(item.item.body)) as ProcessJob;
  if (item.item.type !== "Task" || job.format !== "pm-rl/process-job/1" || job.id !== id || !["planned", "running", "materialized", "evaluated", "promoted", "failed", "cancelled", "invalidated"].includes(job.state)) expectedFail("Job identity or state drifted.", "process_job_drift");
  parseResources(job.allowance); parseResources(job.charge);
  if (typeof job.settled !== "boolean" || (!job.settled && processDigest(job.charge) !== processDigest(job.allowance))
    || (job.completion !== null && processDigest(job.charge) !== processDigest(job.completion.usage))) expectedFail("Reservation accounting drifted.", "process_job_drift");
  return job;
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
export async function verifyProcessJobBudget(client: PmClient, job: ProcessJob): Promise<void> {
  const approved = await approvedResources(client, job.approval);
  if (job.budget_digest !== approved.digest) expectedFail("Approved budget identity changed.", "process_budget_drift");
}

/** Reserve once under the workspace writer lock, counting every held or settled job on this approval. */
export async function reserveProcessJob(client: PmClient, coordinates: ProcessCoordinates, id: string, input: ProcessInput, approval: string, allowance: Resources): Promise<ProcessJob> {
  const step: WorkspaceTransactionStep = {
    id: "reserve",
    async inspect() { return { state: await readProcessJob(client, id) === null ? "pending" : "applied" }; },
    async apply() {
      const approved = await approvedResources(client, approval);
      const listed = certifyCompleteListResult(await client.listAllComplete({ includeBody: true }));
      const charges: Resources[] = [];
      for (const item of listed.items) {
        const body = String(item.body);
        if (!body.includes('"format":"pm-rl/process-job/1"')) continue;
        const parsed = JSON.parse(body) as ProcessJob;
        const job = await readProcessJob(client, parsed.id);
        if (job!.approval === approved.id) charges.push(job!.charge);
      }
      for (const key of RESOURCE_KEYS) {
        const total = charges.reduce((sum, charge) => sum + charge[key], allowance[key]);
        if (!Number.isSafeInteger(total) || total > approved.budget[key]) expectedFail(`Approved ${key} budget exhausted.`, "process_budget_exhausted");
      }
      const job: ProcessJob = { format: "pm-rl/process-job/1", id, input: processDigest(input), binding: input.identity, approval: approved.id, budget_digest: approved.digest,
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
export async function transitionProcessJob(client: PmClient, coordinates: ProcessCoordinates, job: ProcessJob, state: ProcessJobState, outcome: string, completion = job.completion, charge = job.charge): Promise<ProcessJob> {
  if (job.state !== state && !JOB_TRANSITIONS[job.state].includes(state)) expectedFail("Illegal process job transition.", "process_job_drift");
  const target = job.state === state ? job : { ...job, state, outcome, completion, charge, settled: state !== "running" && state !== "planned" };
  await commitProcessTransaction({ ...coordinates, transactionId: `${job.id}-${state}`, steps: [{ id: "outcome",
    async inspect() { const current = (await readProcessJob(client, job.id))!; return { state: processDigest(current) === processDigest(target) ? "applied" : "pending" }; },
    async apply() { await client.update(job.id, { body: JSON.stringify(target) }); },
    async compensate() { await client.update(job.id, { body: JSON.stringify(job) }); },
  }] });
  return (await readProcessJob(client, job.id))!;
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
export function validateProcessCompletion(directory: string, id: string, input: ProcessInput, allowance: Resources): ProcessCompletion {
  if (!existsSync(join(directory, "completion.json"))) expectedFail("Trainer supplied no completion receipt.", "process_receipt_required");
  const bytes = stagingBytes(directory);
  if (bytes > allowance.storage_bytes || lstatSync(join(directory, "completion.json")).size > 65_536) expectedFail("Trainer exceeded staging storage allowance.", "process_limit_exceeded");
  const value = JSON.parse(readFileSync(join(directory, "completion.json"), "utf8")) as ProcessCompletion;
  if (value.format !== "pm-rl/process-completion/1" || value.job !== id || value.checkpoint !== "checkpoint.json"
    || processDigest(value.training_config) !== processDigest(input.training_config) || value.source_policy !== input.source.digest
    || processDigest(value.lineage) !== processDigest(input.lineage)) expectedFail("Completion lineage or configuration drifted.", "process_receipt_invalid");
  if (lstatSync(join(directory, value.checkpoint)).size > 4096) expectedFail("Bandit checkpoint exceeds its schema bound.", "process_checkpoint_invalid");
  const content = readFileSync(join(directory, value.checkpoint));
  const digest = `sha256:${createHash("sha256").update(content).digest("hex")}`;
  const policy = JSON.parse(content.toString("utf8")) as BanditCheckpoint;
  if (digest !== value.digest || processDigest(policy) !== processDigest(value.policy) || !Number.isFinite(policy.weight) || Math.abs(policy.weight) > 20 || policy.digest !== banditCheckpoint(policy.weight).digest) expectedFail("Checkpoint content digest or parameters are invalid.", "process_checkpoint_invalid");
  const usage = parseResources(value.usage);
  if (usage.training_steps !== input.training_config.steps || usage.storage_bytes !== content.length) expectedFail("Completion lacks measured training or checkpoint use.", "process_receipt_invalid");
  for (const key of RESOURCE_KEYS) if (usage[key] > allowance[key]) expectedFail(`Trainer exceeded reserved ${key}.`, "process_limit_exceeded");
  if (lstatSync(join(directory, "runner.json")).size > 4096) expectedFail("Trainer identity metadata exceeds its schema bound.", "process_receipt_invalid");
  const runner = JSON.parse(readFileSync(join(directory, "runner.json"), "utf8")) as { started_at: number };
  if (!Number.isSafeInteger(runner.started_at) || runner.started_at <= 0 || runner.started_at > lstatSync(join(directory, "completion.json")).mtimeMs + 1) expectedFail("Trainer wall identity is invalid.", "process_receipt_invalid");
  const wall = Math.max(usage.wall_ms, Math.ceil(lstatSync(join(directory, "completion.json")).mtimeMs - runner.started_at));
  if (wall > allowance.wall_ms) expectedFail("Trainer exceeded observed wall allowance.", "process_limit_exceeded");
  return { ...value, usage: { ...usage, wall_ms: wall, storage_bytes: bytes } };
}
/** Refuse terminal job reuse and verify receipts before they may supply a collection policy. */
export function verifiedProcessPolicy(job: ProcessJob, root: string, input: ProcessInput, inspectTerminal = false): BanditCheckpoint | null {
  if (job.input !== processDigest(input)) expectedFail("Job input identity drifted.", "process_job_drift");
  if (!inspectTerminal && ["failed", "cancelled", "invalidated"].includes(job.state)) expectedFail(`Process job is ${job.state}: ${job.outcome}.`, "process_job_terminal");
  if (job.completion === null) return null;
  const staged = validateProcessCompletion(processStaging(root, job.id), job.id, input, job.allowance);
  if (processDigest(staged) !== processDigest(job.completion)) expectedFail("Committed completion differs from staging.", "process_job_drift");
  return staged.policy;
}
/** Kill only an exact, locally verified child birth identity; PID reuse never grants stop authority. */
export function stopTrainer(pid: number, start: string): void {
  if (loopProcessStartTime(pid) === start) process.kill(pid, "SIGKILL");
}
/** Launch a real child with bounded NDJSON, wall/storage polling and owner-checked cancellation. */
export async function launchTrainer(directory: string, id: string, input: ProcessInput, allowance: Resources, argv: readonly string[], signal?: AbortSignal): Promise<void> {
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
  child.stderr.on("data", (chunk: Buffer) => { outputBytes += chunk.length; if (outputBytes <= 65_536) writeFileSync(join(directory, "stderr.log"), chunk, { flag: "a" }); else refuse(new Error("Trainer diagnostics exceeded channel allowance.")); });
  await once(child, "spawn");
  identity = loopProcessStartTime(child.pid!);
  if (identity === null) { child.kill("SIGKILL"); await closed; expectedFail("Cannot establish trainer process identity.", "process_identity_unavailable"); }
  writeFileSync(join(directory, "runner.json"), JSON.stringify({ pid: child.pid, start: identity, started_at: startedAt }), { flag: "wx" });
  const timer = setInterval(poll, 25);
  signal?.addEventListener("abort", poll);
  child.stdin.on("error", () => undefined);
  child.stdin.end(JSON.stringify({ job: id, input }));
  poll();
  try { await closed; } finally { clearInterval(timer); signal?.removeEventListener("abort", poll); }
  if (failure !== undefined) throw failure;
  if (!complete || pending.length > 0) expectedFail("Trainer exited without a complete NDJSON receipt.", "process_receipt_required");
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
export async function executeProcessTrainer(client: PmClient, coordinates: ProcessCoordinates, input: ProcessInput, approval: string, adapter: ProcessAdapter, signal?: AbortSignal, argv: readonly string[] = referenceTrainerArgv()): Promise<ProcessJob> {
  const id = processJobId(input, argv);
  return withProcessJobFence(coordinates, id, () => executeReservedProcessJob(client, coordinates, input, approval, adapter, id, signal, argv));
}

/** Execute inside the verified owner fence; this function never re-launches a previously running job. */
async function executeReservedProcessJob(client: PmClient, coordinates: ProcessCoordinates, input: ProcessInput, approval: string, adapter: ProcessAdapter, id: string, signal: AbortSignal | undefined, argv: readonly string[]): Promise<ProcessJob> {
  let job = await reserveProcessJob(client, coordinates, id, input, approval, adapter.allowance);
  const policy = verifiedProcessPolicy(job, coordinates.pmRoot, input);
  if (policy !== null) return transitionProcessJob(client, coordinates, job, job.state, job.outcome);
  const directory = processStaging(coordinates.pmRoot, id);
  try {
    mkdirSync(directory, { recursive: true });
    if (job.state === "planned") {
      job = await transitionProcessJob(client, coordinates, job, "running", "launched");
      await launchTrainer(directory, id, input, job.allowance, argv, signal);
    } else {
      if (existsSync(join(directory, "runner.json"))) {
        const runner = JSON.parse(readFileSync(join(directory, "runner.json"), "utf8")) as { pid: number; start: string };
        stopTrainer(runner.pid, runner.start);
      }
    }
    const completion = validateProcessCompletion(directory, id, input, job.allowance);
    return await transitionProcessJob(client, coordinates, job, "materialized", "receipt_validated", completion, completion.usage);
  } catch (error) {
    const state = signal?.aborted === true ? "cancelled" : "failed";
    const charge = job.state === "planned" ? zeroResources() : failedProcessCharge(directory, job.allowance);
    await transitionProcessJob(client, coordinates, job, state, isPmCliExpectedError(error) ? String(error.context.code) : "trainer_failure", null, charge);
    throw error;
  }
}
