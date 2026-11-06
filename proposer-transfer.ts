/** Tracker-disjoint, power-qualified paired transfer evidence stored entirely in native PM records. */
import assert from "node:assert/strict";
import type { PmClient } from "@unbrained/pm-cli/sdk/core";
import { EXIT_CODE, isPmCliExpectedError } from "@unbrained/pm-cli/sdk/runtime";
import { createVerifiedItem, readCompleteLoopItem } from "./index.ts";
import { hashJson, type JsonValue } from "./json-identity.ts";
import { IMPROVER_ROLES, readImproverDataset, readImproverTasks, validateImproverTasks, type ImproverDataset, type ImproverTask } from "./improver-data.ts";
import { encodeBoundedJson, parseBoundedJson, MAX_TRACKER_RECORD_BYTES } from "./tracker-record.ts";

/** Frozen design assumptions; a proposer cannot change the effect, error budget or desired power. */
export const TRANSFER_DESIGN = { effect: 0.10, margin: 0.01, alpha: 0.05, power: 0.80, targets: ["issue-type", "time-to-close"] } as const;
/** Projected examples are sealed along with their original manifest, not reconstructed from moving source heads. */
export interface TransferCorpus { readonly manifest: ImproverDataset; readonly tasks: Readonly<Record<typeof IMPROVER_ROLES[number], readonly ImproverTask[]>> }
/** Paired outcomes refer to exactly the declared task identities. */
export interface TransferPair { readonly id: string; readonly candidate: number; readonly incumbent: number }
/** Power is a distribution-free lower bound at the predeclared alternative, not retrospective observed power. */
export interface TransferPower { readonly minimum_trackers: number; readonly trackers: number; readonly power_lower_bound: number; readonly powered: boolean; readonly radius: number }
/** Simultaneous intervals and power use equal-weight independent tracker means within each target. */
export interface TransferTaskReport extends TransferPower { readonly target: string; readonly effect: number; readonly interval: readonly [number, number] }
/** A refusal remains useful evidence and survives replay through its native PM digest. */
export interface TransferReport { readonly format: "pm-rl/proposer-transfer-report/1"; readonly corpus: string; readonly role: "meta" | "audit"; readonly comparisons: number; readonly look: number; readonly design: typeof TRANSFER_DESIGN; readonly tasks: readonly TransferTaskReport[]; readonly passed: boolean; readonly reason: "transfer_underpowered" | "transfer_no_improvement" | "transfer_passed" }
/** Native manifest references bounded task records by their exact content digests. */
interface CorpusRecord { readonly format: "pm-rl/proposer-transfer-corpus/1"; readonly manifest: ImproverDataset; readonly tasks: readonly { readonly role: typeof IMPROVER_ROLES[number]; readonly digest: string }[] }
/** The replay envelope retains pairs as evaluator context, without a metric side file. */
interface EvaluationRecord { readonly format: "pm-rl/proposer-transfer-evaluation/1"; readonly corpus: string; readonly role: "meta" | "audit"; readonly comparisons: number; readonly look: number; readonly pairs: readonly TransferPair[]; readonly report: TransferReport }

/** Canonical source comparison prevents case or Unicode aliases from crossing tracker compartments. */
function tracker(value: string): string { return value.normalize("NFKC").trim().toLowerCase(); }
/** Check corpus identity and isolation before creating any native record or consuming any score. */
export function verifyTransferCorpus(corpus: TransferCorpus, expected = corpus.manifest.digest): void {
  const { digest, ...manifest } = corpus.manifest;
  assert.equal(digest, expected, "transfer_corpus_digest");
  assert.equal(hashJson(manifest as unknown as JsonValue), digest, "transfer_corpus_digest");
  assert.equal(manifest.format, "pm-rl/improver-dataset/1", "transfer_corpus_format");
  const seen = new Map<string, ImproverDataset["sources"][number]>(); const items = new Map<string, string>();
  for (const source of manifest.sources) {
    const name = tracker(source.repo);
    assert.ok(!seen.has(name), "transfer_tracker_leak"); seen.set(name, source);
    assert.ok(!["pm-observer", "pm-web-hosted", "pm-web", "pm-gpt", "pm-cli"].includes(name.split("/").at(-1)!), "transfer_private_source");
    assert.ok(IMPROVER_ROLES.includes(source.role) && /^[a-f0-9]{40}$/.test(source.commit), "transfer_source");
  }
  for (const role of IMPROVER_ROLES) {
    const tasks = corpus.tasks[role];
    validateImproverTasks(tasks, manifest as ImproverDataset, role);
    assert.equal(hashJson(tasks as unknown as JsonValue), manifest.splits[role].digest, "transfer_split_digest");
    assert.equal(tasks.length, manifest.splits[role].tasks, "transfer_split_count");
    assert.ok(tasks.length > 0 && tasks.length <= 10_000 && new Set(tasks.map((task) => task.id)).size === tasks.length, "transfer_tasks");
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
export function transferPower(trackers: number, comparisons: number): TransferPower {
  assert.ok(Number.isSafeInteger(trackers) && trackers >= 0 && Number.isSafeInteger(comparisons) && comparisons >= 1 && comparisons <= 5, "transfer_counts");
  const { alpha, power, effect, margin, targets } = TRANSFER_DESIGN;
  const log = Math.log(2 * targets.length * comparisons / alpha);
  const minimum_trackers = Math.ceil(2 * (Math.sqrt(log) + Math.sqrt(Math.log(1 / (1 - power)))) ** 2 / (effect - margin) ** 2);
  const radius = trackers === 0 ? 2 : Math.sqrt(2 * log / trackers);
  const slack = effect - margin - radius;
  const power_lower_bound = slack <= 0 ? 0 : 1 - Math.exp(-trackers * slack * slack / 2);
  return { minimum_trackers, trackers, power_lower_bound, powered: trackers >= minimum_trackers, radius };
}
/** Give each adaptive generation fresh meta trackers, frozen by source identity before any score is read. */
export function transferMembers(corpus: TransferCorpus, role: "meta" | "audit", comparisons: number, look = 1): readonly ImproverTask[] {
  transferPower(0, comparisons);
  assert.ok(Number.isSafeInteger(look) && look >= 1 && look <= Math.max(1, comparisons - 1), "transfer_look");
  if (role === "audit") return corpus.tasks.audit;
  const trackers = [...new Set(corpus.tasks.meta.map((task) => tracker(task.repo)))].sort((a, b) => hashJson({ tracker: a, seed: corpus.manifest.seed }).localeCompare(hashJson({ tracker: b, seed: corpus.manifest.seed })));
  const selected = new Set(trackers.filter((_name, index) => index % Math.max(1, comparisons - 1) === look - 1));
  return corpus.tasks.meta.filter((task) => selected.has(tracker(task.repo)));
}
/** Refuse undeclared, missing, duplicate or out-of-range pairs, then evaluate the same frozen design on replay. */
export function evaluateTransfer(corpus: TransferCorpus, role: "meta" | "audit", pairs: readonly TransferPair[], comparisons: number, look = 1): TransferReport {
  verifyTransferCorpus(corpus);
  assert.ok(role === "meta" || role === "audit", "transfer_role");
  const tasks = transferMembers(corpus, role, comparisons, look); const scores = new Map(pairs.map((pair) => [pair.id, pair]));
  assert.ok(scores.size === pairs.length && tasks.length === pairs.length && tasks.every((task) => scores.has(task.id)), "transfer_pairs");
  assert.ok(pairs.every((pair) => [pair.candidate, pair.incumbent].every((value) => Number.isFinite(value) && value >= 0 && value <= 1)), "transfer_score");
  const reports = TRANSFER_DESIGN.targets.map((target): TransferTaskReport => {
    const groups = new Map<string, number[]>();
    for (const task of tasks.filter((task) => task.target === target)) {
      const score = scores.get(task.id)!; const name = tracker(task.repo); const values = groups.get(name) ?? [];
      values.push(score.candidate - score.incumbent); groups.set(name, values);
    }
    const values = [...groups.values()].map((group) => group.reduce((sum, value) => sum + value, 0) / group.length);
    const effect = values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
    const power = transferPower(values.length, comparisons);
    return { target, effect, interval: [Math.max(-1, effect - power.radius), Math.min(1, effect + power.radius)], ...power };
  });
  const powered = reports.every((report) => report.powered);
  const passed = powered && reports.every((report) => report.interval[0] >= TRANSFER_DESIGN.margin);
  return { format: "pm-rl/proposer-transfer-report/1", corpus: corpus.manifest.digest, role, comparisons, look, design: TRANSFER_DESIGN, tasks: reports, passed, reason: !powered ? "transfer_underpowered" : passed ? "transfer_passed" : "transfer_no_improvement" };
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
/** Seal each projected task as a bounded native Decision, with a digest-addressed manifest linking all roles. */
export async function archiveTransferCorpus(client: PmClient, corpus: TransferCorpus): Promise<string> {
  verifyTransferCorpus(corpus);
  const packets = IMPROVER_ROLES.flatMap((role) => corpus.tasks[role].map((task) => ({ format: "pm-rl/proposer-transfer-task/1", role, task })));
  const record: CorpusRecord = { format: "pm-rl/proposer-transfer-corpus/1", manifest: corpus.manifest, tasks: packets.map((packet) => ({ role: packet.role, digest: hashJson(packet as unknown as JsonValue) })) };
  // All producer bounds are checked before the first SDK mutation.
  for (const value of [...packets, record]) encodeBoundedJson(value, MAX_TRACKER_RECORD_BYTES);
  for (const packet of packets) await writeRecord(client, packet);
  return writeRecord(client, record);
}
/** Reconstruct frozen projections from PM alone; no source checkout, dataset file or Git is needed. */
export async function replayTransferCorpus(client: PmClient, digest: string): Promise<TransferCorpus> {
  const record = await readRecord(client, digest) as unknown as CorpusRecord;
  assert.equal(record.format, "pm-rl/proposer-transfer-corpus/1", "transfer_record_format");
  const tasks: Record<typeof IMPROVER_ROLES[number], ImproverTask[]> = { development: [], meta: [], audit: [] };
  for (const reference of record.tasks) {
    const packet = await readRecord(client, reference.digest) as unknown as { format: string; role: typeof IMPROVER_ROLES[number]; task: ImproverTask };
    assert.ok(packet.format === "pm-rl/proposer-transfer-task/1" && packet.role === reference.role && IMPROVER_ROLES.includes(packet.role), "transfer_record_format");
    tasks[packet.role].push(packet.task);
  }
  const corpus = { manifest: record.manifest, tasks }; verifyTransferCorpus(corpus); return corpus;
}
/** Store the complete paired measurement and derived report in append-only SDK history before selection. */
export async function recordTransferEvaluation(client: PmClient, digest: string, role: "meta" | "audit", pairs: readonly TransferPair[], comparisons: number, look = 1): Promise<{ digest: string; report: TransferReport }> {
  const corpus = await replayTransferCorpus(client, digest); const report = evaluateTransfer(corpus, role, pairs, comparisons, look);
  const record: EvaluationRecord = { format: "pm-rl/proposer-transfer-evaluation/1", corpus: digest, role, comparisons, look, pairs, report };
  return { digest: await writeRecord(client, record), report };
}
/** Replay a measured decision from one address and compare the recomputed report with the native receipt. */
export async function replayTransferEvaluation(client: PmClient, digest: string): Promise<TransferReport> {
  const record = await readRecord(client, digest) as unknown as EvaluationRecord;
  assert.equal(record.format, "pm-rl/proposer-transfer-evaluation/1", "transfer_record_format");
  const corpus = await replayTransferCorpus(client, record.corpus);
  const report = evaluateTransfer(corpus, record.role, record.pairs, record.comparisons, record.look);
  assert.equal(hashJson(report as unknown as JsonValue), hashJson(record.report as unknown as JsonValue), "transfer_report_drift"); return report;
}
