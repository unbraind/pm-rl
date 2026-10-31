/** Budgeted, deterministic retraining sensitivity; evidence never grants promotion authority. */
import type { PmClient, GetResult } from "@unbrained/pm-cli/sdk/core";
import type { HistoryResult } from "@unbrained/pm-cli/sdk/query";
import { createPmCliExpectedError, normalizeItemId, EXIT_CODE } from "@unbrained/pm-cli/sdk/runtime";
import { banditCheckpoint, banditItemRewards, executeBanditStep, validatedBanditDatasets, type BanditCheckpoint, type BanditExample } from "./bandit.ts";
import { canonicalJson, orderedHistoryEntries, createOrReadIdentical, hashJson, readCompleteLoopItem, type JsonValue } from "./index.ts";
import { encodeBoundedJson, MAX_TRACKER_RECORD_BYTES, parseBoundedJson } from "./tracker-record.ts";
import { parseLoopConfig } from "./loop.ts";

/** Actionable refusals are stable across the CLI and SDK. */
export type TrainingInfluenceRefusal = "influence_invalid" | "influence_overlap" | "influence_drift" | "influence_foreign" | "influence_output_exists" | "influence_output_unavailable";
/** One intervention changes only declared training members' collection multiplicity. */
export interface TrainingSlice { readonly id: string; readonly members: readonly string[]; readonly weight: number }
/** A frozen held-out evaluation, independent of the training slice definitions. */
export interface InfluenceEvaluation { readonly id: string; readonly members: readonly string[] }
/** Strict input schema: weights are integer multiplicities, zero means omission. */
export interface TrainingInfluenceRequest {
  readonly format: "pm-rl/training-influence/1";
  readonly learner: { readonly seed: number; readonly initial_weight: number; readonly samples: number; readonly fit_steps: number; readonly learning_rate: number };
  readonly training: readonly BanditExample[];
  readonly held_out: readonly BanditExample[];
  readonly slices: readonly TrainingSlice[];
  readonly evaluations: readonly InfluenceEvaluation[];
  /** Per invocation, including the baseline. No shared or implied remaining allowance. */
  readonly budget: { readonly fits: number; readonly samples: number; readonly updates: number };
}
/** Exact fitted checkpoint and collection identity retained for independent replay. */
export interface InfluenceFit { readonly checkpoint: BanditCheckpoint; readonly collection: string; readonly training: string; readonly scores: readonly number[] }
/** Measured movement on each declared evaluation, ordered by declaration rather than effect. */
export interface InfluenceComparison { readonly slice: string; readonly weight: number; readonly fit: InfluenceFit; readonly delta: readonly number[] }
/** Partial evidence has explicit omissions and never contains a ranking. */
export interface TrainingInfluenceReport {
  readonly format: "pm-rl/training-influence-report/1";
  readonly request: string;
  readonly training: string;
  readonly held_out: string;
  readonly source: BanditCheckpoint;
  readonly interpretation: "association";
  readonly ranking: null;
  readonly complete: boolean;
  readonly baseline: InfluenceFit | null;
  readonly comparisons: readonly InfluenceComparison[];
  readonly omitted: readonly { readonly slice: string; readonly reason: "fit_budget" | "sample_budget" | "update_budget" }[];
  readonly evaluations: readonly string[];
  readonly spent: { readonly fits: number; readonly samples: number; readonly updates: number };
  readonly digest: string;
}
/** Compact replayable evidence for the next proposal; no raw examples or checkpoint parameters. */
export interface TrainingInfluenceEvidence {
  readonly format: "pm-rl/training-influence-evidence/1";
  readonly id: string;
  readonly at: string;
  readonly report: string;
  readonly training: string;
  readonly held_out: string;
  readonly complete: boolean;
  readonly interpretation: "association";
  readonly ranking: null;
  readonly evaluations: readonly string[];
  readonly measured: readonly { readonly slice: string; readonly checkpoint: string; readonly delta: readonly number[] }[];
  readonly omitted: number;
}

/** Refuse without echoing untrusted training content, with one concrete recovery path. */
function refuse(code: TrainingInfluenceRefusal): never {
  throw createPmCliExpectedError(`Training influence refused (${code}). Use a corrected request for a fresh report, or restore the original record through the SDK while retaining its history. Supply disjoint bounded datasets with declared slices, evaluations and per-invocation budgets.`, { exitCode: EXIT_CODE.CONFLICT, context: { code } });
}
/** Assert a schema predicate at the single untrusted boundary. */
function requireShape(ok: boolean): void { if (!ok) refuse("influence_invalid"); }
/** Require an exact object shape; extension fields cannot silently change experiment semantics. */
function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  requireShape(value !== null && typeof value === "object" && !Array.isArray(value));
  const row = value as Record<string, unknown>;
  requireShape(Object.keys(row).length === keys.length && keys.every((key) => Object.hasOwn(row, key)));
  return row;
}
/** Dense arrays are checked before mapping so holes cannot bypass admission. */
function array(value: unknown, maximum: number, minimum = 1): unknown[] {
  requireShape(Array.isArray(value) && value.length >= minimum && value.length <= maximum);
  const rows = value as unknown[];
  for (let i = 0; i < rows.length; i += 1) requireShape(Object.hasOwn(rows, i));
  return rows;
}
/** Identifiers are deliberately bounded and already canonical; no hidden identity normalization. */
function name(value: unknown): string { requireShape(typeof value === "string" && /^[a-z0-9][a-z0-9-]{0,127}$/.test(value)); return value as string; }
/** Report and checkpoint identities are content digests, never arbitrary output values. */
function digestIdentity(value: unknown): string { requireShape(typeof value === "string" && /^(?:sha256:)?[a-f0-9]{64}$/.test(value)); return value as string; }
/** All counts are safe integers and all scalar inputs are finite in their documented domains. */
function number(value: unknown, minimum: number, maximum: number, integer = true): number {
  requireShape(typeof value === "number" && Number.isFinite(value) && value >= minimum && value <= maximum && (!integer || Number.isSafeInteger(value)));
  return value as number;
}
/** The same example producer is used for validation, execution, import and replay. */
function examples(value: unknown): BanditExample[] {
  return array(value, 2048).map((entry) => {
    const hasFeatures = entry !== null && typeof entry === "object" && Object.hasOwn(entry, "features");
    const row = object(entry, ["id", "feature", "rewards", ...(hasFeatures ? ["features"] : [])]);
    const rewards = array(row.rewards, 2, 2).map((reward) => number(reward, 0, 1, false));
    return { id: name(row.id), feature: number(row.feature, -1, 1, false), rewards: [rewards[0], rewards[1]],
      ...(hasFeatures ? { features: array(row.features, 64).map((feature) => number(feature, -1, 1, false)) } : {}) };
  });
}
/** Resolve declared membership once, before any fitting or persistent side effect. */
function members(value: unknown, available: ReadonlySet<string>): string[] {
  const result = array(value, 2048).map(name);
  requireShape(new Set(result).size === result.length && result.every((id) => available.has(id)));
  return result;
}
/** Preserve dataset error categories consistently for every influence entry point. */
function influenceDatasets(training: readonly BanditExample[], evaluation: readonly BanditExample[]) {
  try { return validatedBanditDatasets({ training, evaluation }); }
  catch (error) { return refuse(error instanceof Error && error.message.startsWith("bandit_overlap:") ? "influence_overlap" : "influence_invalid"); }
}
/** Parse the only request schema, including finite domains, dense arrays and input-content isolation. */
export function parseTrainingInfluence(value: unknown): TrainingInfluenceRequest {
  const row = object(value, ["format", "learner", "training", "held_out", "slices", "evaluations", "budget"]);
  requireShape(row.format === "pm-rl/training-influence/1");
  const learner = object(row.learner, ["seed", "initial_weight", "samples", "fit_steps", "learning_rate"]);
  const training = examples(row.training); const heldOut = examples(row.held_out);
  const datasets = influenceDatasets(training, heldOut);
  const inputIdentity = (example: BanditExample): string => canonicalJson({ feature: example.feature, ...(example.features === undefined ? {} : { features: [...example.features] }) });
  const heldInputs = new Set(heldOut.map(inputIdentity));
  if (training.some((example) => heldInputs.has(inputIdentity(example)))) refuse("influence_overlap");
  const trainingIds = new Set(training.map((example) => example.id)); const heldIds = new Set(heldOut.map((example) => example.id));
  const slices = array(row.slices, 16).map((entry): TrainingSlice => {
    const slice = object(entry, ["id", "members", "weight"]);
    return { id: name(slice.id), members: members(slice.members, trainingIds), weight: number(slice.weight, 0, 4) };
  });
  requireShape(new Set(slices.map((slice) => slice.id)).size === slices.length && slices.every((slice) => slice.weight !== 1 && (slice.weight !== 0 || slice.members.length < training.length)));
  const evaluations = array(row.evaluations, 8).map((entry): InfluenceEvaluation => {
    const evaluation = object(entry, ["id", "members"]);
    return { id: name(evaluation.id), members: members(evaluation.members, heldIds) };
  });
  requireShape(new Set(evaluations.map((evaluation) => evaluation.id)).size === evaluations.length);
  const budget = object(row.budget, ["fits", "samples", "updates"]);
  const request: TrainingInfluenceRequest = { format: "pm-rl/training-influence/1", learner: { seed: number(learner.seed, 0, 0xffff_ffff), initial_weight: number(learner.initial_weight, -20, 20, false), samples: number(learner.samples, 1, 10_000), fit_steps: number(learner.fit_steps, 1, 256), learning_rate: number(learner.learning_rate, 0.01, 1, false) },
    training: datasets.training, held_out: datasets.evaluation, slices, evaluations, budget: { fits: number(budget.fits, 0, 17), samples: number(budget.samples, 0, 100_000), updates: number(budget.updates, 0, 4352) } };
  requireShape(request.learner.samples * request.learner.fit_steps * Math.min(request.budget.fits, 17) <= 1_000_000);
  // The producer's own JSON wire representation canonicalizes signed zero, exactly as native persistence does.
  return parseBoundedJson(encodeBoundedJson(request, MAX_TRACKER_RECORD_BYTES / 2)) as TrainingInfluenceRequest;
}
/** A fixed seeded learner uses the existing bandit kernel; held-out examples are evaluator-only. */
function fit(request: TrainingInfluenceRequest, training: readonly BanditExample[], source: BanditCheckpoint): InfluenceFit {
  const trainingDigest = hashJson(training as unknown as JsonValue);
  const step = executeBanditStep({ training, evaluation: request.held_out, trainingDigest, evaluationDigest: hashJson(request.held_out as unknown as JsonValue), source, generation: 1, seed: request.learner.seed, randomState: request.learner.seed, samples: request.learner.samples, fitSteps: request.learner.fit_steps, learningRate: request.learner.learning_rate,
    minimumImprovement: 1, maximumGap: 1, evaluationSamples: 1, confidence: 0.95, minSamples: 1 });
  const values = banditItemRewards(step.candidate, request.held_out);
  const rewards = new Map(request.held_out.map((example, index) => [example.id, values[index]]));
  const scores = request.evaluations.map((evaluation) => evaluation.members.reduce((sum, id) => sum + rewards.get(id)!, 0) / evaluation.members.length);
  requireShape(scores.every((score) => Number.isFinite(score) && score >= 0 && score <= 1));
  return { checkpoint: step.candidate, collection: step.collectionDigest, training: trainingDigest, scores };
}
/** Execute in declaration order, including baseline cost, retaining honest partial evidence at exhaustion. */
export function measureTrainingInfluence(value: unknown): TrainingInfluenceReport {
  const request = parseTrainingInfluence(value);
  const datasets = influenceDatasets(request.training, request.held_out);
  const source = banditCheckpoint(request.learner.initial_weight);
  const spent = { fits: 0, samples: 0, updates: 0 };
  /** Exact integer budget comparisons include every baseline and intervention fit. */
  const shortage = (): TrainingInfluenceReport["omitted"][number]["reason"] | null => spent.fits + 1 > request.budget.fits ? "fit_budget" : spent.samples + request.learner.samples > request.budget.samples ? "sample_budget" : spent.updates + request.learner.fit_steps > request.budget.updates ? "update_budget" : null;
  /** Reserve local work before executing the synchronous kernel. */
  const chargedFit = (training: readonly BanditExample[]): InfluenceFit => {
    spent.fits += 1; spent.samples += request.learner.samples; spent.updates += request.learner.fit_steps;
    return fit(request, training, source);
  };
  const baseline = shortage() === null ? chargedFit(request.training) : null;
  const comparisons: InfluenceComparison[] = []; const omitted: TrainingInfluenceReport["omitted"][number][] = [];
  for (const slice of request.slices) {
    const reason = shortage();
    if (reason !== null) { omitted.push({ slice: slice.id, reason }); continue; }
    const selected = new Set(slice.members);
    const training = request.training.flatMap((example) => Array.from({ length: selected.has(example.id) ? slice.weight : 1 }, () => example));
    const result = chargedFit(training);
    const delta = result.scores.map((score, index) => score - baseline!.scores[index]);
    requireShape(delta.every((score) => Number.isFinite(score) && score >= -1 && score <= 1));
    comparisons.push({ slice: slice.id, weight: slice.weight, fit: result, delta });
  }
  const report = { format: "pm-rl/training-influence-report/1" as const, request: hashJson(request as unknown as JsonValue), training: datasets.trainingDigest, held_out: datasets.evaluationDigest, source, interpretation: "association" as const, ranking: null, complete: omitted.length === 0, baseline, comparisons, omitted, evaluations: request.evaluations.map((evaluation) => evaluation.id), spent };
  return { ...report, digest: hashJson(report as unknown as JsonValue) };
}
/** Producer equality is the report validator; no separately normalized or weaker imported representation. */
export function replayTrainingInfluence(request: unknown, report: unknown): TrainingInfluenceReport {
  const expected = measureTrainingInfluence(request);
  if (canonicalJson(parseBoundedJson(encodeBoundedJson(report, MAX_TRACKER_RECORD_BYTES)) as JsonValue) !== canonicalJson(expected as unknown as JsonValue)) refuse("influence_drift");
  return expected;
}
/** Compact output keeps exact checkpoints behind the native report identity; arrays never imply rank. */
export function summarizeTrainingInfluence(report: TrainingInfluenceReport) {
  requireShape(typeof report.complete === "boolean" && report.interpretation === "association" && report.ranking === null);
  return { digest: digestIdentity(report.digest), complete: report.complete, interpretation: "association", ranking: null, baseline: report.baseline === null ? null : digestIdentity(report.baseline.checkpoint.digest), evaluations: array(report.evaluations, 8).map(name),
    comparisons: array(report.comparisons, 16, 0).map((entry) => { const comparison = entry as InfluenceComparison; return { slice: name(comparison.slice), weight: number(comparison.weight, 0, 4), checkpoint: digestIdentity(comparison.fit.checkpoint.digest), delta: array(comparison.delta, 8).map((value) => number(value, -1, 1, false)) }; }),
    omitted: array(report.omitted, 16, 0).map((entry) => { const row = object(entry, ["slice", "reason"]); requireShape(typeof row.reason === "string" && ["fit_budget", "sample_budget", "update_budget"].includes(row.reason)); return { slice: name(row.slice), reason: row.reason as string }; }),
    spent: { fits: number(report.spent.fits, 0, 17), samples: number(report.spent.samples, 0, 100_000), updates: number(report.spent.updates, 0, 4352) } };
}
/** One ownership contract governs producer read-back and historical consumers. */
function ownedRecord(item: GetResult["item"]): void {
  if (item.type !== "Decision" || !item.tags?.includes("rl-training-influence")) refuse("influence_foreign");
}
/** Compare both encodings through the same JSON value representation; cosmetic transport changes are safe. */
function matchingRecord(item: GetResult["item"], body: string, digest: string): true {
  ownedRecord(item);
  let matches = false;
  try { matches = canonicalJson(parseBoundedJson(String(item.body)) as JsonValue) === canonicalJson(parseBoundedJson(body) as JsonValue); } catch { refuse("influence_foreign"); }
  if (!matches || item.affected_version !== digest) refuse("influence_foreign");
  return true;
}
/** Persist one immutable result. Native SDK create arbitrates peers; no workspace-lock isolation claim. */
export async function recordTrainingInfluence(client: PmClient, value: unknown): Promise<{ id: string; created: boolean; report: TrainingInfluenceReport }> {
  const request = parseTrainingInfluence(value); const report = measureTrainingInfluence(request);
  const id = `training-influence-${report.digest}`;
  const body = encodeBoundedJson({ format: "pm-rl/training-influence-record/1", id, request, report }, MAX_TRACKER_RECORD_BYTES);
  const result = await createOrReadIdentical(client, { id, type: "Decision", title: "Measured training-slice associations", body, affectedVersion: report.digest, tags: "rl-training-influence",
    unset: ["parent", "goal", "objective", "sprint", "release", "assignee", "reviewer", "blocked_by"], clearDeps: true }, "influence_foreign", (item) => matchingRecord(item, body, report.digest));
  const fresh = await readCompleteLoopItem(client, result.item.id);
  matchingRecord(fresh.item, body, report.digest);
  return { id: String(result.item.id), created: result.created, report };
}
/** Read one native revision and certify its history before replay; foreign data is never overwritten. */
export async function readTrainingInfluence(client: PmClient, id: string, at?: string): Promise<{ id: string; at: string; report: TrainingInfluenceReport }> {
  const history = await client.run("history", { id, options: { compact: true, verify: true, outputLimit: "unbounded", outputBudget: "unbounded" } }) as HistoryResult;
  const latest = orderedHistoryEntries(history, "influence_drift").at(-1)!;
  const coordinate = at ?? String(latest.version ?? latest.index);
  const result = await readCompleteLoopItem(client, id, coordinate);
  const item = result.item;
  ownedRecord(item);
  let decoded: unknown;
  try { decoded = parseBoundedJson(String(item.body)); } catch { return refuse("influence_foreign"); }
  const row = object(decoded, ["format", "id", "request", "report"]);
  const report = replayTrainingInfluence(row.request, row.report);
  const prefix = String((await client.config("project", "get", "id_prefix")).nested_setting!.value);
  if (row.format !== "pm-rl/training-influence-record/1" || row.id !== `training-influence-${report.digest}` || item.id !== normalizeItemId(`training-influence-${report.digest}`, prefix) || item.affected_version !== report.digest) refuse("influence_foreign");
  // Historical replay does not establish the current native envelope. Latest reads must certify both.
  if (at === undefined) matchingRecord((await readCompleteLoopItem(client, id)).item, String(item.body), report.digest);
  return { id: item.id, at: coordinate, report };
}
/** Reuse the same compact projection in proposal production and validation. */
function evidence(id: string, at: string, report: TrainingInfluenceReport): TrainingInfluenceEvidence {
  return { format: "pm-rl/training-influence-evidence/1", id, at, report: report.digest, training: report.training, held_out: report.held_out, complete: report.complete, interpretation: "association", ranking: null, evaluations: report.evaluations,
    measured: report.comparisons.map((comparison) => ({ slice: comparison.slice, checkpoint: comparison.fit.checkpoint.digest, delta: comparison.delta })), omitted: report.omitted.length };
}
/** Bind measured associations to a new proposal's datasets, preserving every normal controller gate. */
export async function attachTrainingInfluence(client: PmClient, programme: JsonValue, id: string): Promise<JsonValue> {
  requireShape(programme !== null && typeof programme === "object" && !Array.isArray(programme));
  const row = programme as Record<string, JsonValue>;
  const retained = await readTrainingInfluence(client, id);
  const result: JsonValue = { ...row, influence_evidence: evidence(retained.id, retained.at, retained.report) as unknown as JsonValue };
  await verifyTrainingInfluenceProposal(client, result);
  parseLoopConfig(result);
  return result;
}
/** Resolve evidence from its certified historical revision, so later edits cannot silently rebind a proposal. */
export async function verifyTrainingInfluenceProposal(client: PmClient, programme: JsonValue): Promise<void> {
  requireShape(programme !== null && typeof programme === "object" && !Array.isArray(programme));
  const row = programme as Record<string, JsonValue>;
  if (row.influence_evidence === undefined) return;
  const supplied = row.influence_evidence as unknown as TrainingInfluenceEvidence;
  requireShape(supplied !== null && typeof supplied === "object" && typeof supplied.id === "string" && typeof supplied.at === "string" && /^[1-9][0-9]*$/.test(supplied.at));
  const retained = await readTrainingInfluence(client, supplied.id, supplied.at);
  if (canonicalJson(supplied as unknown as JsonValue) !== canonicalJson(evidence(retained.id, retained.at, retained.report) as unknown as JsonValue)) refuse("influence_drift");
  const datasets = influenceDatasets(row.training as unknown as BanditExample[], row.evaluation as unknown as BanditExample[]);
  if (datasets.trainingDigest !== retained.report.training || datasets.evaluationDigest !== retained.report.held_out || row.trainer !== undefined && row.trainer !== "bandit") refuse("influence_overlap");
}
