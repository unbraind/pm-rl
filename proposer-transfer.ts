/** Tracker-disjoint, power-qualified paired transfer evidence stored entirely in native PM records. */
import assert from "node:assert/strict";
import type { PmClient } from "@unbrained/pm-cli/sdk/core";
import { EXIT_CODE, isPmCliExpectedError, createPmCliExpectedError } from "@unbrained/pm-cli/sdk/runtime";
import { createVerifiedItem, readCompleteLoopItem } from "./index.ts";
import { hashJson, type JsonValue } from "./json-identity.ts";
import { IMPROVER_ROLES, readImproverDataset, readImproverTasks, validateImproverTasks, type ImproverDataset, type ImproverTask } from "./improver-data.ts";
import { assertJsonEncoding, encodeBoundedJson, parseBoundedJson, MAX_TRACKER_RECORD_BYTES } from "./tracker-record.ts";
import { excludedTrackerName } from "./dataset.ts";

/** Historical version-one receipt design; new plans carry explicit operator declarations. */
export const TRANSFER_DESIGN = Object.freeze({ effect: 0.10, margin: 0.01, alpha: 0.05, power: 0.80, targets: Object.freeze(["issue-type", "time-to-close"] as const) } as const);
/** Shared role and paired-observation ceiling used by execution preflight and native verification. @internal */
export const TRANSFER_MAX_TASKS = 10_000;
/** Correctable operator fields; never include supplied values or advise editing sealed native evidence. @internal */
export const TRANSFER_DECLARATION_REMEDY = "Correct effect, margin, alpha, power, looks and targets in the prospective transfer declaration: 0.01 <= margin < effect <= 1, 0 < alpha <= 0.05, 0.80 <= power < 1, integer looks from 1 to 64, and targets issue-type then time-to-close.";
/** Prospective operator choices, sealed before any contender is scored. */
export interface TransferDesign { readonly effect: number; readonly margin: number; readonly alpha: number; readonly power: number; readonly looks: number; readonly targets: typeof TRANSFER_DESIGN.targets }
/** Validate the full declaration with no outcome-derived or implicit statistical parameters. */
export function parseTransferDesign(value: unknown): TransferDesign {
  transferInputShape(transferObject(value), "transfer_design");
  const row = value as unknown as TransferDesign;
  transferInputShape(Object.keys(row).sort().join() === "alpha,effect,looks,margin,power,targets", "transfer_design");
  transferInputShape([row.effect, row.margin, row.alpha, row.power].every(Number.isFinite) && row.margin >= 0.01 && row.effect > row.margin && row.effect <= 1 && row.alpha > 0 && row.alpha <= TRANSFER_DESIGN.alpha && row.power >= TRANSFER_DESIGN.power && row.power < 1, "transfer_design");
  transferInputShape(Number.isSafeInteger(row.looks) && row.looks >= 1 && row.looks <= 64, "transfer_design");
  transferInputShape(Array.isArray(row.targets) && row.targets.length === TRANSFER_DESIGN.targets.length && (row.targets as readonly unknown[]).every((target, index) => target === TRANSFER_DESIGN.targets[index]), "transfer_design");
  return { ...row, targets: [...TRANSFER_DESIGN.targets] };
}
/** Projected examples are sealed along with their original manifest, not reconstructed from moving source heads. */
export interface TransferCorpus { readonly manifest: ImproverDataset; readonly tasks: Readonly<Record<typeof IMPROVER_ROLES[number], readonly ImproverTask[]>> }
/** Paired outcomes refer to exactly the declared task identities. */
export interface TransferPair { readonly id: string; readonly candidate: number; readonly incumbent: number }
/** Power is a distribution-free lower bound at the predeclared alternative, not retrospective observed power. */
export interface TransferPower { readonly minimum_trackers: number; readonly trackers: number; readonly power_lower_bound: number; readonly powered: boolean; readonly radius: number }
/** Simultaneous intervals and power use equal-weight independent tracker means within each target. */
export interface TransferTaskReport extends TransferPower { readonly target: string; readonly effect: number; readonly interval: readonly [number, number] }
/** A refusal remains useful evidence and survives replay through its native PM digest. */
export interface TransferReport { readonly format: "pm-rl/proposer-transfer-report/1" | "pm-rl/proposer-transfer-report/2"; readonly corpus: string; readonly role: "meta" | "audit"; readonly comparisons: number; readonly look: number; readonly design: typeof TRANSFER_DESIGN | TransferDesign; readonly tasks: readonly TransferTaskReport[]; readonly passed: boolean; readonly reason: "transfer_underpowered" | "transfer_no_improvement" | "transfer_passed" }
/** Native manifest references bounded task records by their exact content digests. */
interface CorpusRecord { readonly format: "pm-rl/proposer-transfer-corpus/1"; readonly manifest: ImproverDataset; readonly tasks: readonly { readonly role: typeof IMPROVER_ROLES[number]; readonly digest: string }[] }
/** The replay envelope retains pairs as evaluator context, without a metric side file. */
interface EvaluationRecord { readonly format: "pm-rl/proposer-transfer-evaluation/1"; readonly corpus: string; readonly role: "meta" | "audit"; readonly comparisons: number; readonly look: number; readonly pairs: readonly TransferPair[]; readonly report: TransferReport }

/** A shard retains typed data rather than opaque external files or oversized root arrays. */
type ArchiveEntry = { readonly kind: "source"; readonly source: ImproverDataset["sources"][number] } | { readonly kind: "omission"; readonly omission: ImproverDataset["omitted"][number] } | { readonly kind: "task"; readonly role: typeof IMPROVER_ROLES[number]; readonly task: ImproverTask };
/** The position is itself hashed, so even semantically equivalent shard reordering refuses. */
interface CorpusShard { readonly format: "pm-rl/proposer-transfer-shard/2"; readonly index: number; readonly entries: readonly ArchiveEntry[] }
/** Large source lists and task references live in shards; the root only pins their order and counts. */
interface CorpusRoot { readonly format: "pm-rl/proposer-transfer-corpus/2"; readonly manifest: Omit<ImproverDataset, "sources" | "omitted">; readonly shards: readonly string[]; readonly entry_count: number }
/** Both planning and publication use these exact byte-checked envelopes. */
export interface TransferArchive { readonly root: CorpusRoot; readonly shards: readonly CorpusShard[] }
/** A plan binds explicit power choices to the corpus before paired observations exist. */
export interface TransferPlan { readonly format: "pm-rl/proposer-transfer-plan/2"; readonly corpus: string; readonly design: TransferDesign }
/** Version two evaluations cite a native plan instead of silently inheriting library constants. */
interface PlannedEvaluation { readonly format: "pm-rl/proposer-transfer-evaluation/2"; readonly corpus: string; readonly plan: string; readonly role: "meta" | "audit"; readonly look: number; readonly pairs: readonly TransferPair[]; readonly report: TransferReport }
/** Large paired observations use indexed native shards pinned by a small evaluation root. */
interface PairShard { readonly format: "pm-rl/proposer-transfer-pairs/2"; readonly index: number; readonly pairs: readonly TransferPair[] }
/** Keep the exact same statistical report while removing the single-record pair capacity limit. */
type ShardedEvaluation = Omit<PlannedEvaluation, "format" | "pairs"> & { readonly format: "pm-rl/proposer-transfer-evaluation/3"; readonly pair_count: number; readonly shards: readonly string[] };

/** Canonical source comparison prevents case or Unicode aliases from crossing tracker compartments. */
function tracker(value: string): string { return value.normalize("NFKC").trim().toLowerCase(); }
/** Native JSON must expose a record before a replay reads any of its properties. */
function transferObject(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
/** Malformed persisted context is an actionable SDK refusal, with no payload or machine coordinates in the message. */
function transferShape(condition: unknown, code: string): asserts condition {
  if (!condition) throw createPmCliExpectedError(`Malformed sealed transfer context (${code}). Restore the original native records or use a fresh evaluation identity.`, { exitCode: EXIT_CODE.USAGE, context: { code } });
}
/** Producer-authored correction text shared by all public transfer input boundaries. */
const TRANSFER_INPUT_REMEDIES = new Map([
  ["transfer_design", TRANSFER_DECLARATION_REMEDY],
  ["transfer_design_capacity", "Correct the declared effect and margin so the required tracker count is a safe integer. " + TRANSFER_DECLARATION_REMEDY],
  ["transfer_counts", "Correct tracker counts and comparisons: use a nonnegative safe integer tracker count and an integer comparison count from 1 to 64."],
  ["transfer_look", "Correct look: use an integer within the declared fresh meta looks or the final audit coordinate."],
  ["transfer_role", "Correct role: select meta or audit for transfer evaluation."],
  ["transfer_pairs", "Correct pairs: supply each declared task exactly once, with valid task ids and at most 10000 paired observations."],
  ["transfer_score", "Correct candidate and incumbent scores: supply finite numbers between 0 and 1."],
  ["transfer_corpus_shape", "Correct the supplied corpus manifest, role task arrays and chronological row fields before archiving or evaluating."],
  ["transfer_plan_corpus", "Correct the supplied plan and corpus references so they name the same sealed corpus."],
]);
/** Input refusals identify the fields to correct while preserving stable machine codes. */
function transferInputShape(condition: unknown, code: "transfer_design" | "transfer_design_capacity" | "transfer_counts" | "transfer_look" | "transfer_role" | "transfer_pairs" | "transfer_score" | "transfer_corpus_shape" | "transfer_plan_corpus"): asserts condition {
  if (!condition) throw createPmCliExpectedError(`Invalid transfer input (${code}). ${TRANSFER_INPUT_REMEDIES.get(code)!}`, { exitCode: EXIT_CODE.USAGE, context: { code } });
}
/** A stored value's validation failure belongs to native recovery; unrelated IO and foreign failures retain their identity. @internal */
export function nativeTransferValue<T>(read: () => T): T {
  try { return read(); }
  catch (error) {
    if (isPmCliExpectedError(error) && TRANSFER_INPUT_REMEDIES.has(String(error.context.code))) transferShape(false, String(error.context.code));
    throw error;
  }
}
/** Match the existing task-count contract before mapping or spreading decoded paired observations. */
function transferPairsShape(pairs: unknown, check: (condition: unknown, code: "transfer_pairs") => void = transferInputShape): asserts pairs is readonly TransferPair[] {
  check(Array.isArray(pairs) && pairs.length <= TRANSFER_MAX_TASKS && pairs.every((pair: unknown) => transferObject(pair) && typeof pair.id === "string"), "transfer_pairs");
}
/** Share structural checks between input verification and native reconstruction, before semantic validation. */
function transferCorpusShape(corpus: TransferCorpus): void {
  transferInputShape(transferObject(corpus) && transferObject(corpus.manifest) && transferObject(corpus.tasks), "transfer_corpus_shape");
  const manifest = corpus.manifest;
  transferInputShape(typeof manifest.digest === "string" && typeof manifest.format === "string" && Number.isSafeInteger(manifest.seed) && Array.isArray(manifest.sources) && Array.isArray(manifest.omitted) && transferObject(manifest.splits), "transfer_corpus_shape");
  transferInputShape(manifest.sources.every((source) => transferObject(source) && typeof source.repo === "string" && typeof source.commit === "string" && typeof source.role === "string") && manifest.omitted.every((row) => transferObject(row) && typeof row.repo === "string" && typeof row.target === "string"), "transfer_corpus_shape");
  for (const role of IMPROVER_ROLES) {
    transferInputShape(transferObject(manifest.splits[role]) && typeof manifest.splits[role].digest === "string" && Number.isSafeInteger(manifest.splits[role].tasks) && Array.isArray(corpus.tasks[role]), "transfer_corpus_shape");
    for (const task of corpus.tasks[role]) {
      transferInputShape(transferObject(task) && [task.id, task.repo, task.commit, task.target].every((value) => typeof value === "string") && typeof task.cutoff === "number" && Array.isArray(task.train) && Array.isArray(task.evaluation), "transfer_corpus_shape");
      for (const row of [...task.train, ...task.evaluation]) {
        transferInputShape(transferObject(row) && typeof row.id === "string" && transferObject(row.prefix), "transfer_corpus_shape");
        const prefix = row.prefix;
        transferInputShape(Array.isArray(prefix.events) && Array.isArray(prefix.fields) && Array.isArray(prefix.words) && [...prefix.events, ...prefix.fields].every((value) => typeof value === "string"), "transfer_corpus_shape");
      }
    }
  }
}
/** Check corpus identity and isolation before creating any native record or consuming any score. */
export function verifyTransferCorpus(corpus: TransferCorpus, expected?: string): void {
  transferCorpusShape(corpus);
  const { digest, ...manifest } = corpus.manifest;
  assert.equal(digest, expected === undefined ? digest : expected, "transfer_corpus_digest");
  assert.equal(hashJson(manifest as unknown as JsonValue), digest, "transfer_corpus_digest");
  assert.equal(manifest.format, "pm-rl/improver-dataset/1", "transfer_corpus_format");
  const seen = new Map<string, ImproverDataset["sources"][number]>(); const items = new Map<string, string>();
  for (const source of manifest.sources) {
    const name = tracker(source.repo);
    assert.ok(!seen.has(name), "transfer_tracker_leak"); seen.set(name, source);
    assert.ok(!excludedTrackerName(name.split("/").at(-1)!), "transfer_private_source");
    assert.ok(IMPROVER_ROLES.includes(source.role) && /^[a-f0-9]{40}$/.test(source.commit), "transfer_source");
  }
  for (const role of IMPROVER_ROLES) {
    const tasks = corpus.tasks[role];
    validateImproverTasks(tasks, manifest as ImproverDataset, role);
    assert.equal(hashJson(tasks as unknown as JsonValue), manifest.splits[role].digest, "transfer_split_digest");
    assert.equal(tasks.length, manifest.splits[role].tasks, "transfer_split_count");
    assert.ok(tasks.length > 0 && tasks.length <= TRANSFER_MAX_TASKS && new Set(tasks.map((task) => task.id)).size === tasks.length, "transfer_tasks");
    for (const task of tasks) {
      const source = seen.get(tracker(task.repo));
      assert.ok(source !== undefined && source.role === role && source.commit === task.commit, "transfer_tracker_leak");
      assert.ok(TRANSFER_DESIGN.targets.includes(task.target), "transfer_target");
      for (const row of [...task.train, ...task.evaluation]) {
        const previous = items.get(row.id);
        // An item may have both targets, but it cannot belong to two tracker compartments.
        assert.ok(previous === undefined || previous === `${role}:${tracker(task.repo)}`, "transfer_item_leak");
        items.set(row.id, `${role}:${tracker(task.repo)}`);
      }
    }
  }
}
/** Open and verify the released chronological projection once before archiving it in PM. */
export function loadTransferCorpus(directory: string): TransferCorpus {
  const manifest = readImproverDataset(directory);
  const tasks = Object.fromEntries(IMPROVER_ROLES.map((role) => [role, readImproverTasks(directory, manifest, role)])) as unknown as TransferCorpus["tasks"];
  const corpus = { manifest, tasks }; verifyTransferCorpus(corpus); return corpus;
}
/** Hoeffding on paired differences in [-1,1], Bonferroni across both tasks and all declared looks. */
export function transferPower(trackers: number, declaration: TransferDesign): TransferPower {
  const { alpha, power, effect, margin, targets, looks } = parseTransferDesign(declaration);
  transferInputShape(Number.isSafeInteger(trackers) && trackers >= 0, "transfer_counts");
  const log = Math.log(2 * targets.length * looks / alpha);
  const minimum_trackers = Math.ceil(2 * (Math.sqrt(log) + Math.sqrt(Math.log(1 / (1 - power)))) ** 2 / (effect - margin) ** 2);
  transferInputShape(Number.isSafeInteger(minimum_trackers), "transfer_design_capacity");
  const radius = trackers === 0 ? 2 : Math.sqrt(2 * log / trackers);
  const slack = effect - margin - radius;
  const power_lower_bound = slack <= 0 ? 0 : 1 - Math.exp(-trackers * slack * slack / 2);
  return { minimum_trackers, trackers, power_lower_bound, powered: trackers >= minimum_trackers, radius };
}
/** Give each adaptive generation fresh meta trackers, frozen by source identity before any score is read. */
export function transferMembers(corpus: TransferCorpus, role: "meta" | "audit", comparisons: number, look = 1): readonly ImproverTask[] {
  transferInputShape(Number.isSafeInteger(comparisons) && comparisons >= 1 && comparisons <= 64, "transfer_counts");
  transferInputShape(Number.isSafeInteger(look) && look >= 1 && look <= Math.max(1, comparisons - 1), "transfer_look");
  if (role === "audit") return corpus.tasks.audit;
  const trackers = [...new Set(corpus.tasks.meta.map((task) => tracker(task.repo)))].sort((a, b) => hashJson({ tracker: a, seed: corpus.manifest.seed }).localeCompare(hashJson({ tracker: b, seed: corpus.manifest.seed })));
  const selected = new Set(trackers.filter((_name, index) => index % Math.max(1, comparisons - 1) === look - 1));
  return corpus.tasks.meta.filter((task) => selected.has(tracker(task.repo)));
}
/** Refuse undeclared, missing, duplicate or out-of-range pairs, then evaluate the same frozen design on replay. */
export function evaluateTransfer(corpus: TransferCorpus, role: "meta" | "audit", pairs: readonly TransferPair[], declaration: TransferDesign, look = 1): TransferReport {
  const design = parseTransferDesign(declaration); const comparisons = design.looks;
  verifyTransferCorpus(corpus);
  transferInputShape(role === "meta" || role === "audit", "transfer_role");
  transferPairsShape(pairs);
  const tasks = transferMembers(corpus, role, comparisons, look); const scores = new Map(pairs.map((pair) => [pair.id, pair]));
  transferInputShape(scores.size === pairs.length && tasks.length === pairs.length && tasks.every((task) => scores.has(task.id)), "transfer_pairs");
  transferInputShape(pairs.every((pair) => [pair.candidate, pair.incumbent].every((value) => Number.isFinite(value) && value >= 0 && value <= 1)), "transfer_score");
  const reports = design.targets.map((target): TransferTaskReport => {
    const groups = new Map<string, number[]>();
    for (const task of tasks.filter((task) => task.target === target)) {
      const score = scores.get(task.id)!; const name = tracker(task.repo); const values = groups.get(name) ?? [];
      values.push(score.candidate - score.incumbent); groups.set(name, values);
    }
    const values = [...groups.values()].map((group) => group.reduce((sum, value) => sum + value, 0) / group.length);
    const effect = values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
    const power = transferPower(values.length, design);
    return { target, effect, interval: [Math.max(-1, effect - power.radius), Math.min(1, effect + power.radius)], ...power };
  });
  const powered = reports.every((report) => report.powered);
  const passed = powered && reports.every((report) => report.interval[0] >= design.margin);
  return { format: "pm-rl/proposer-transfer-report/2", corpus: corpus.manifest.digest, role, comparisons, look, design, tasks: reports, passed, reason: !powered ? "transfer_underpowered" : passed ? "transfer_passed" : "transfer_no_improvement" };
}
/** Content addresses have no filesystem coordinates and remain valid without Git. */
function recordId(digest: string): string { assert.match(digest, /^[a-f0-9]{64}$/, "transfer_digest"); return `transfer-${digest}`; }
/** Read native current and birth state; edits cannot silently replace an immutable replay envelope. */
async function readRecord(client: PmClient, digest: string): Promise<JsonValue> {
  const id = recordId(digest);
  const current = (await readCompleteLoopItem(client, id)).item;
  const birth = (await readCompleteLoopItem(client, id, "1")).item;
  assert.ok(current.type === "Decision" && current.affected_version === digest && current.component === "proposer-transfer" && current.body === birth.body && current.affected_version === birth.affected_version && current.type === birth.type && current.component === birth.component, "transfer_record_drift");
  const value = parseBoundedJson(String(current.body));
  transferShape(transferObject(value) && typeof value.format === "string", "transfer_record_format");
  if (/\/[23]$/.test(String((value as Record<string, JsonValue>)["format"]))) assertJsonEncoding(String(current.body), MAX_TRACKER_RECORD_BYTES);
  assert.equal(hashJson(value as JsonValue), digest, "transfer_record_digest"); return value as JsonValue;
}
/** Idempotently append through the SDK; a conflicting existing address refuses instead of overwriting. */
async function writeRecord(client: PmClient, value: unknown): Promise<string> {
  const body = encodeBoundedJson(value, MAX_TRACKER_RECORD_BYTES); const digest = hashJson(value as JsonValue); const id = recordId(digest);
  try { await readCompleteLoopItem(client, id); }
  catch (error) {
    if (!isPmCliExpectedError(error) || error.exitCode !== EXIT_CODE.NOT_FOUND) throw error;
    await createVerifiedItem(client, { id, type: "Decision", title: "Sealed proposer transfer context", body, affectedVersion: digest, component: "proposer-transfer" });
  }
  await readRecord(client, digest); return digest;
}
/** Pack source metadata and each task role separately, with bounded envelopes and canonical order. */
export function planTransferArchive(corpus: TransferCorpus): TransferArchive {
  verifyTransferCorpus(corpus);
  const groups: ArchiveEntry[][] = [corpus.manifest.sources.map((source) => ({ kind: "source", source })), corpus.manifest.omitted.map((omission) => ({ kind: "omission", omission })), ...IMPROVER_ROLES.map((role) => corpus.tasks[role].map((task): ArchiveEntry => ({ kind: "task", role, task })))];
  const shards: CorpusShard[] = []; let entries: ArchiveEntry[] = []; let bytes = 0;
  /** Finalize the same bounded packet later written by the SDK, including wrapper overhead. */
  const flush = (): void => {
    if (entries.length === 0) return;
    const shard: CorpusShard = { format: "pm-rl/proposer-transfer-shard/2", index: shards.length, entries };
    encodeBoundedJson(shard, MAX_TRACKER_RECORD_BYTES); shards.push(shard); entries = []; bytes = 0;
  };
  for (const group of groups) {
    for (const entry of group) {
      const size = Buffer.byteLength(encodeBoundedJson(entry, MAX_TRACKER_RECORD_BYTES));
      if (entries.length > 0 && bytes + size > 262_144) flush();
      entries.push(entry); bytes += size;
    }
    flush();
  }
  const { sources: _sources, omitted: _omitted, ...manifest } = corpus.manifest;
  const root: CorpusRoot = { format: "pm-rl/proposer-transfer-corpus/2", manifest, shards: shards.map((shard) => hashJson(shard as unknown as JsonValue)), entry_count: groups.reduce((sum, group) => sum + group.length, 0) };
  encodeBoundedJson(root, MAX_TRACKER_RECORD_BYTES);
  return { root, shards };
}
/** Publish a small root only after all content-addressed shards have passed the shared byte preflight. */
export async function archiveTransferCorpus(client: PmClient, corpus: TransferCorpus): Promise<string> {
  const plan = planTransferArchive(corpus);
  for (const shard of plan.shards) await writeRecord(client, shard);
  return writeRecord(client, plan.root);
}
/** Reconstruct frozen projections from PM alone, retaining compatibility with version-one roots. */
export async function replayTransferCorpus(client: PmClient, digest: string): Promise<TransferCorpus> {
  const record = await readRecord(client, digest) as unknown as CorpusRecord | CorpusRoot;
  const tasks: Record<typeof IMPROVER_ROLES[number], ImproverTask[]> = { development: [], meta: [], audit: [] };
  if (record.format === "pm-rl/proposer-transfer-corpus/1") {
    transferShape(Array.isArray(record.tasks), "transfer_record_format");
    for (const reference of record.tasks as CorpusRecord["tasks"]) {
      transferShape(transferObject(reference) && IMPROVER_ROLES.includes(reference.role) && typeof reference.digest === "string" && /^[a-f0-9]{64}$/.test(reference.digest), "transfer_record_format");
      const packet = await readRecord(client, reference.digest) as unknown as { format: string; role: typeof IMPROVER_ROLES[number]; task: ImproverTask };
      transferShape(packet.format === "pm-rl/proposer-transfer-task/1" && packet.role === reference.role && IMPROVER_ROLES.includes(packet.role), "transfer_record_format");
      tasks[packet.role].push(packet.task);
    }
    const corpus = { manifest: record.manifest, tasks }; nativeTransferValue(() => verifyTransferCorpus(corpus)); return corpus;
  }
  transferShape(record.format === "pm-rl/proposer-transfer-corpus/2", "transfer_record_format");
  transferShape(Number.isSafeInteger(record.entry_count) && record.entry_count > 0, "transfer_shard_count");
  transferShape(Array.isArray(record.shards) && record.shards.length > 0 && new Set(record.shards).size === record.shards.length && record.shards.every((address) => typeof address === "string" && /^[a-f0-9]{64}$/.test(address)), "transfer_shard_order");
  const sources: ImproverDataset["sources"][number][] = []; const omitted: ImproverDataset["omitted"][number][] = []; let count = 0;
  for (const [index, address] of record.shards.entries()) {
    const shard = await readRecord(client, address) as unknown as CorpusShard;
    transferShape(shard.format === "pm-rl/proposer-transfer-shard/2", "transfer_record_format");
    transferShape(Number.isSafeInteger(shard.index) && shard.index === index, "transfer_shard_order");
    transferShape(Array.isArray(shard.entries) && shard.entries.length > 0, "transfer_shard_empty");
    for (const entry of shard.entries as readonly ArchiveEntry[]) {
      transferShape(transferObject(entry) && ["source", "omission", "task"].includes(entry.kind), "transfer_shard_entry");
      count++;
      if (entry.kind === "source") sources.push(entry.source);
      else if (entry.kind === "omission") omitted.push(entry.omission);
      else {
        transferShape(entry.kind === "task" && IMPROVER_ROLES.includes(entry.role), "transfer_record_format");
        tasks[entry.role].push(entry.task);
      }
    }
  }
  transferShape(count === record.entry_count, "transfer_shard_count");
  const corpus = { manifest: { ...record.manifest, sources, omitted }, tasks }; nativeTransferValue(() => verifyTransferCorpus(corpus)); return corpus;
}
/** Seal the prospective design in native history; evaluators must cite this address. */
export async function recordTransferPlan(client: PmClient, corpus: string, declaration: TransferDesign): Promise<string> {
  recordId(corpus); const design = parseTransferDesign(declaration); transferPower(0, design);
  return writeRecord(client, { format: "pm-rl/proposer-transfer-plan/2", corpus, design });
}
/** Read the birth-checked statistical contract independently of mutable operator files. */
export async function readTransferPlan(client: PmClient, digest: string): Promise<TransferPlan> {
  const record = await readRecord(client, digest) as unknown as TransferPlan;
  transferShape(record.format === "pm-rl/proposer-transfer-plan/2", "transfer_record_format");
  transferShape(typeof record.corpus === "string" && /^[a-f0-9]{64}$/.test(record.corpus), "transfer_plan_corpus");
  return nativeTransferValue(() => { transferPower(0, parseTransferDesign(record.design)); return record; });
}
/** Store the complete paired measurement and derived report in append-only SDK history before selection. */
export async function recordTransferEvaluation(client: PmClient, digest: string, role: "meta" | "audit", pairs: readonly TransferPair[], planDigest: string, look = 1): Promise<{ digest: string; report: TransferReport }> {
  const plan = await readTransferPlan(client, planDigest); const corpus = await replayTransferCorpus(client, digest);
  transferInputShape(plan.corpus === corpus.manifest.digest, "transfer_plan_corpus");
  const report = evaluateTransfer(corpus, role, pairs, plan.design, look);
  const record: PlannedEvaluation = { format: "pm-rl/proposer-transfer-evaluation/2", corpus: digest, plan: planDigest, role, look, pairs, report };
  if (Buffer.byteLength(JSON.stringify(record)) <= MAX_TRACKER_RECORD_BYTES) return { digest: await writeRecord(client, record), report };
  const shards: PairShard[] = []; let pending: TransferPair[] = []; let bytes = 0;
  /** Preflight every complete packet before publishing the first paired observation. */
  const flush = (): void => {
    const shard: PairShard = { format: "pm-rl/proposer-transfer-pairs/2", index: shards.length, pairs: pending };
    encodeBoundedJson(shard, MAX_TRACKER_RECORD_BYTES); shards.push(shard); pending = []; bytes = 0;
  };
  for (const pair of pairs) {
    const size = Buffer.byteLength(encodeBoundedJson(pair, MAX_TRACKER_RECORD_BYTES));
    if (pending.length > 0 && bytes + size > 262_144) flush();
    pending.push(pair); bytes += size;
  }
  flush();
  const { pairs: _pairs, format: _format, ...envelope } = record;
  const root: ShardedEvaluation = { ...envelope, format: "pm-rl/proposer-transfer-evaluation/3", pair_count: pairs.length, shards: shards.map((shard) => hashJson(shard as unknown as JsonValue)) };
  encodeBoundedJson(root, MAX_TRACKER_RECORD_BYTES);
  for (const shard of shards) await writeRecord(client, shard);
  return { digest: await writeRecord(client, root), report };
}
/** Replay old receipts with their historical design and new receipts with their exact sealed plan. */
export async function replayTransferEvaluation(client: PmClient, digest: string): Promise<TransferReport> {
  const record = await readRecord(client, digest) as unknown as EvaluationRecord | PlannedEvaluation | ShardedEvaluation;
  transferShape(["pm-rl/proposer-transfer-evaluation/1", "pm-rl/proposer-transfer-evaluation/2", "pm-rl/proposer-transfer-evaluation/3"].includes(record.format) && typeof record.corpus === "string" && /^[a-f0-9]{64}$/.test(record.corpus), "transfer_record_format");
  transferShape(record.role === "meta" || record.role === "audit", "transfer_role");
  transferShape(Number.isSafeInteger(record.look) && record.look >= 1 && record.look <= 64, "transfer_look");
  transferShape(transferObject(record.report), "transfer_report_drift");
  const corpus = await replayTransferCorpus(client, record.corpus);
  let report: TransferReport;
  if (record.format === "pm-rl/proposer-transfer-evaluation/1") {
    transferShape(Number.isSafeInteger(record.comparisons) && record.comparisons >= 1 && record.comparisons <= 64, "transfer_counts");
    const computed = nativeTransferValue(() => evaluateTransfer(corpus, record.role, record.pairs, { ...TRANSFER_DESIGN, looks: record.comparisons }, record.look));
    report = { ...computed, format: "pm-rl/proposer-transfer-report/1", design: TRANSFER_DESIGN };
  } else {
    transferShape(typeof record.plan === "string" && /^[a-f0-9]{64}$/.test(record.plan), "transfer_plan_corpus");
    const plan = await readTransferPlan(client, record.plan);
    transferShape(plan.corpus === corpus.manifest.digest, "transfer_plan_corpus");
    const pairs: TransferPair[] = [];
    if (record.format === "pm-rl/proposer-transfer-evaluation/2") { transferPairsShape(record.pairs, transferShape); pairs.push(...record.pairs); }
    else {
      transferShape(Number.isSafeInteger(record.pair_count) && record.pair_count > 0 && record.pair_count <= TRANSFER_MAX_TASKS && Array.isArray(record.shards) && record.shards.length > 0 && record.shards.length <= record.pair_count && new Set(record.shards).size === record.shards.length && record.shards.every((address) => typeof address === "string" && /^[a-f0-9]{64}$/.test(address)), "transfer_pair_shards");
      for (const [index, address] of record.shards.entries()) {
        const shard = await readRecord(client, address) as unknown as PairShard;
        transferShape(shard.format === "pm-rl/proposer-transfer-pairs/2" && shard.index === index && Array.isArray(shard.pairs) && shard.pairs.length > 0, "transfer_pair_shard");
        transferPairsShape(shard.pairs, transferShape);
        transferShape(pairs.length + shard.pairs.length <= record.pair_count, "transfer_pair_count");
        pairs.push(...shard.pairs);
      }
      transferShape(pairs.length === record.pair_count, "transfer_pair_count");
    }
    report = nativeTransferValue(() => evaluateTransfer(corpus, record.role, pairs, plan.design, record.look));
  }
  transferShape(hashJson(report as unknown as JsonValue) === hashJson(record.report as unknown as JsonValue), "transfer_report_drift"); return report;
}
