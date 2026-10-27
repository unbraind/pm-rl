import { canonicalizeIdentifier } from "./lineage.ts";
import { identifier, identifierClient, operationIdentifier } from "./state-boundary.ts";
/** Reviewed finite-look sequential tests and immutable, resumable evidence checkpoints. */
import { dirname } from "node:path";
import type { PmClient } from "@unbrained/pm-cli/sdk/core";
import { hashJson, withProcessJobFence, extractGenerationSpec, readCompleteLoopItem, captureDecisionInputs, type JsonValue } from "./index.ts";
import { evaluatePlan, evaluationComparison, normalizedObservations, optionalItem, readEvaluationPlan, refuse, verifiedCandidate, verifyCreatedRecord, validateEvaluationOrder, evaluationPlanId, type EvaluationMember, type EvaluationPlan, type EvaluationPlanReport, type RegisteredEvaluationPlan, evaluationEvidence } from "./evaluation-plan.ts";
import type { PromotionDecision } from "./promotion.ts";
import { parseBoundedJson, decodeTrackerRecord, skippedTrackerRecords, type SkippedTrackerRecord } from "./tracker-record.ts";

/** A frozen order and equally allocated two-sided error budget; no data-dependent looks. */
export interface SequentialStopping {
  readonly kind: "sequential";
  readonly method: "hoeffding-alpha-spending/1";
  readonly observations: number;
  readonly independent_units: number;
  readonly unit_order: readonly string[];
  readonly looks: readonly number[];
  /** Decision containing the exact comparison hash, recorded before plan registration. */
  readonly review: string;
}
/** Simultaneous confidence bounds on normalized paired improvement, clipped to [-1, 1]. */
export interface SequentialBoundary {
  readonly state: "continue" | "sufficient" | "futile" | "exhausted";
  readonly look: number;
  readonly error_bound: number;
  readonly lower: number;
  readonly upper: number;
}
/** Foreign records are skipped explicitly and never adopted or overwritten. */
export interface SequentialEvaluationSkip {
  readonly status: "skipped";
  readonly plan: string;
  readonly skipped: readonly SkippedTrackerRecord[];
  readonly remedy: string;
}
/** Compact write result; an immutable checkpoint supplies all resume state. */
export type SequentialEvaluationResult = EvaluationPlanReport | SequentialEvaluationSkip;
const FORMAT = "pm-rl/sequential-checkpoint/1";
const TAG = "pm-rl:sequential-checkpoint";

/** Strict shape validation is shared by SDK and CLI at their single plan boundary. */
export function parseSequentialStopping(value: unknown, members: readonly EvaluationMember[]): SequentialStopping {
  const p = value as Record<string, unknown>;
  const keys = ["kind", "method", "observations", "independent_units", "unit_order", "looks", "review"];
  if (Object.keys(p).length !== keys.length || keys.some((key) => !Object.hasOwn(p, key)) || p.method !== "hoeffding-alpha-spending/1") refuse("eval_plan_invalid");
  if (members.reduce((bytes, member) => bytes + Buffer.byteLength(JSON.stringify(member.id)) + 96, 512) > 1_048_576) refuse("eval_plan_invalid");
  const units = new Set(members.map((m) => m.unit));
  if (!Array.isArray(p.unit_order) || p.unit_order.length !== units.size || Array.from(p.unit_order).some((unit) => typeof unit !== "string" || !units.has(unit)) || new Set(p.unit_order).size !== units.size) refuse("eval_plan_invalid");
  if (!Array.isArray(p.looks) || p.looks.length === 0 || p.looks.length > 64) refuse("eval_plan_invalid");
  const looks = Array.from(p.looks);
  if (looks.some((n, index) => typeof n !== "number" || !Number.isSafeInteger(n) || n < 1 || n > units.size || (index > 0 && n <= looks[index - 1])) || looks[looks.length - 1] !== units.size) refuse("eval_plan_invalid");
  if (typeof p.review !== "string" || p.review.length > 1024 || p.review.trim().length === 0 || p.review !== p.review.trim()) refuse("eval_plan_invalid");
  return { kind: "sequential", method: "hoeffding-alpha-spending/1", observations: p.observations as number, independent_units: p.independent_units as number, unit_order: [...p.unit_order] as string[], looks: looks as number[], review: identifier(p.review) };
}
/** Compute a simultaneous paired Hoeffding interval by spending alpha/K at each frozen look. */
export function evaluateSequentialBoundary(plan: EvaluationPlan, n: number, candidate: number, incumbent: number): { sequential: SequentialBoundary; verdict: PromotionDecision } {
  if (plan.stopping.kind !== "sequential") refuse("eval_plan_stopping");
  const rule = plan.stopping;
  const error = 1 - plan.criterion.confidence;
  const epsilon = Math.sqrt(2 * Math.log(2 * rule.looks.length / error) / n);
  const improvement = plan.direction === "maximize" ? candidate - incumbent : incumbent - candidate;
  const threshold = plan.criterion.effectThreshold / (plan.reward_bounds[1] - plan.reward_bounds[0]);
  // Unattainable effect thresholds forbid efficacy; only the finite interval is emitted.
  const lower = Math.max(-1, improvement - epsilon); const upper = Math.min(1, improvement + epsilon);
  const powered = n >= plan.criterion.minSamples;
  const state = powered && lower > threshold ? "sufficient" : powered && upper < threshold ? "futile" : n === rule.independent_units ? "exhausted" : "continue";
  const sequential: SequentialBoundary = { state, look: rule.looks.indexOf(n) + 1, error_bound: error, lower, upper };
  const verdict: PromotionDecision = state === "sufficient" ? { decision: "promote", reason: "Declared sequential efficacy boundary crossed; promotion still requires existing approval and contamination gates.", margin: lower - threshold, candidateBound: lower, incumbentBound: 0, candidateEpsilon: epsilon, incumbentEpsilon: 0 }
    : { decision: "refuse", code: `sequential_${state}`, reason: `Sequential evaluation is ${state}; only a sufficient boundary permits the existing promotion gate.` };
  return { sequential, verdict };
}
/** Require an attributable review of this complete design, rather than a free-form approval label. */
export async function reviewSequentialPlan(client: PmClient, plan: EvaluationPlan, declaredAt?: string): Promise<void> {
  if (plan.stopping.kind !== "sequential") refuse("eval_plan_stopping");
  const review = await optionalItem(client, plan.stopping.review);
  if (review === null || review.type !== "Decision" || review.id !== plan.stopping.review) refuse("eval_plan_evidence");
  let raw: unknown;
  try { raw = parseBoundedJson(String(review.body)); } catch { refuse("eval_plan_evidence"); }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw) || Object.keys(raw).length !== 2 || !("format" in raw) || !("comparison" in raw) || raw.format !== "pm-rl/sequential-review/1" || raw.comparison !== evaluationComparison(plan)) refuse("eval_plan_evidence");
  await verifyCreatedRecord(client, review);
  // A valid seal establishes identity, not temporal precedence. In particular, SDK
  // creation of a correctly hashed Plan must not bypass the pre-collection review.
  if (declaredAt !== undefined) await validateEvaluationOrder(client, [{ id: review.id, stage: 0 }, { id: evaluationPlanId(plan.candidate), stage: 1 }]);
}
/** Serialize protocol writers with the SDK token-owned lease and lock ordinary SDK provenance writers too. */
export async function withEvaluationLease<T>(client: PmClient, candidate: string, dependencies: readonly string[], execute: () => Promise<T>): Promise<T> {
  operationIdentifier(candidate, "item", "write"); dependencies.forEach((id) => operationIdentifier(id, "item", "write"));
  const config = await identifierClient(client).config("project", "get", "id_prefix");
  const root = dirname(config.settings_path);
  const prefix = identifier(config.nested_setting!.value);
  const ids = [`rl-eval-${hashJson(canonicalizeIdentifier(candidate, prefix)).slice(0, 32)}`, ...[...new Set(dependencies.map((id) => canonicalizeIdentifier(id, prefix)))].sort()];
  /** Reuse the package's SDK fence so killed owners recover with verified process identity. */
  async function locked(index: number): Promise<T> {
    if (index === ids.length) return execute();
    return withProcessJobFence({ pmRoot: root, author: "pm-rl-sequential" }, ids[index], () => locked(index + 1));
  }
  return locked(0);
}
/** Read all checkpoint slots, rejecting gaps, edits, changed prefixes and evidence after a terminal stop. */
async function checkpointChain(client: PmClient, registered: RegisteredEvaluationPlan, rule: SequentialStopping): Promise<{ reports: EvaluationPlanReport[]; rows: readonly unknown[][]; hashes: string[]; skipped: readonly SkippedTrackerRecord[] }> {
  const reports: EvaluationPlanReport[] = []; const rows: unknown[][] = []; const hashes: string[] = [];
  for (let index = 0; index < rule.looks.length; index += 1) {
    const id = `${registered.id}-look-${index + 1}`; const item = await optionalItem(client, id);
    if (item === null) { if (await optionalItem(client, id, "1") !== null) refuse("eval_plan_missing"); continue; }
    const raw = decodeTrackerRecord(client, item, { type: "Decision", tag: TAG, format: FORMAT });
    if (raw === null) return { reports, rows, hashes, skipped: skippedTrackerRecords(client).filter((record) => record.id === id) };
    await verifyCreatedRecord(client, item);
    if (Object.keys(raw).length !== 4 || raw.comparison !== registered.comparison || raw.previous !== (hashes[index - 1] ?? null) || !Array.isArray(raw.observations) || index !== reports.length || (index > 0 && reports[index - 1].sequential!.state !== "continue") || item.affected_version !== hashJson(raw as JsonValue)) refuse("eval_plan_drift");
    const report = evaluatePlan(registered.plan, raw.observations);
    if (report.sequential!.look !== index + 1) refuse("eval_plan_drift");
    if (index > 0) verifyPrefix(rows[index - 1], raw.observations);
    reports.push(report); rows.push(raw.observations); hashes.push(String(item.affected_version));
  }
  await validateEvaluationOrder(client, { registered, looks: reports.length });
  return { reports, rows, hashes, skipped: [] };
}
/** A cumulative retry must preserve every already sealed outcome exactly, independent of input row order. */
function verifyPrefix(previous: readonly unknown[], next: readonly unknown[]): void {
  const current = new Map(normalizedObservations(next).map((row) => [row.id, row]));
  for (const row of normalizedObservations(previous)) if (JSON.stringify(current.get(row.id)) !== JSON.stringify(row)) refuse("eval_plan_drift");
}
/** Revalidate live provenance and complete immutable evidence on every status read and promotion attempt. */
export async function readSequentialEvaluation(client: PmClient, candidate: string): Promise<SequentialEvaluationResult | null> {
  return withSequentialEvidence(client, () => readSequentialDecision(client, candidate));
}
/** Attach only a compact root; the typed decision reader exposes the complete certified input graph. */
async function withSequentialEvidence<T extends SequentialEvaluationResult | null>(client: PmClient, execute: () => Promise<T>): Promise<T> {
  const { value, inputs } = await captureDecisionInputs(client, execute);
  return value === null || "status" in value ? value : { ...value, evidence_digest: evaluationEvidence(value.comparison, inputs).digest };
}
/** Recompute the complete live chain before emitting either statistics or an evidence root. */
async function readSequentialDecision(client: PmClient, candidate: string): Promise<SequentialEvaluationResult | null> {
  const registered = await readEvaluationPlan(client, candidate); if (registered === null) refuse("eval_plan_missing");
  if (registered.plan.stopping.kind !== "sequential") refuse("eval_plan_stopping");
  candidate = registered.plan.candidate;
  await verifiedCandidate(client, candidate, registered);
  await reviewSequentialPlan(client, registered.plan);
  const chain = await checkpointChain(client, registered, registered.plan.stopping);
  return chain.skipped.length > 0 ? { status: "skipped", plan: registered.id, skipped: chain.skipped, remedy: "Leave foreign evidence intact and register a fresh candidate." } : chain.reports.at(-1) ?? null;
}
/** Append exactly the next frozen look; retry old cumulative snapshots without recounting or rolling state back. */
export async function recordSequentialEvaluation(client: PmClient, rawCandidate: string, input: unknown): Promise<SequentialEvaluationResult> {
  return withSequentialEvidence(client, () => recordSequentialDecision(client, rawCandidate, input));
}
/** Keep publication and retries inside the same read-derived evidence boundary. */
async function recordSequentialDecision(client: PmClient, rawCandidate: string, input: unknown): Promise<SequentialEvaluationResult> {
  identifier(rawCandidate);
  if (!Array.isArray(input) || input.length > 10_000) refuse("eval_plan_stopping");
  const rows = normalizedObservations(input, "write");
  return withEvaluationLease(client, rawCandidate, [], async () => {
    const registered = await readEvaluationPlan(client, rawCandidate); if (registered === null) refuse("eval_plan_missing");
    const candidate = registered.plan.candidate;
    const rule = registered.plan.stopping; if (rule.kind !== "sequential") refuse("eval_plan_stopping");
    if (rows.length > rule.observations) refuse("eval_plan_stopping");
    const requested = evaluatePlan(registered.plan, rows);
    const predecessors = Array.from({ length: requested.sequential!.look - 1 }, (_, index) => `${registered.id}-look-${index + 1}`);
    const source = await readCompleteLoopItem(client, candidate);
    const spec = extractGenerationSpec(String(source.item.body), "Sequential candidate");
    return withEvaluationLease(client, `${candidate}-sources`, [registered.id, candidate, rule.review, registered.plan.incumbent, ...spec.collection_runs, ...predecessors], async () => {
      // Sealed reads either return the original reservation or refuse missing/edited history.
      const current = (await readEvaluationPlan(client, candidate))!;
      await verifiedCandidate(client, candidate, current); await reviewSequentialPlan(client, current.plan);
      const chain = await checkpointChain(client, current, rule);
      if (chain.skipped.length > 0) return { status: "skipped", plan: current.id, skipped: chain.skipped, remedy: "A foreign record occupies a reserved checkpoint. Leave it intact and register a new plan with a fresh candidate." };
      const report = requested;
      const index = report.sequential!.look - 1;
      if (index < chain.reports.length) { verifyPrefix(rows, chain.rows[index]); return chain.reports.at(-1)!; }
      if ((spec.policy_evaluation as Record<string, JsonValue> | undefined)?.["decision"] === "refuse") refuse("eval_plan_stopping", candidate);
      if (index !== chain.reports.length || (index > 0 && chain.reports[index - 1].sequential!.state !== "continue")) refuse("eval_plan_stopping");
      if (index > 0) verifyPrefix(chain.rows[index - 1], rows);
      const raw = { format: FORMAT, comparison: current.comparison, previous: chain.hashes[index - 1] ?? null, observations: rows };
      const id = `${current.id}-look-${index + 1}`; const body = JSON.stringify(raw); const version = hashJson(raw as unknown as JsonValue);
      try { await identifierClient(client).create({ id, type: "Decision", title: "Sealed sequential evaluation checkpoint", body, affectedVersion: version, tags: TAG, message: "Seal the next predeclared sequential look" }); }
      catch (error) { if (await optionalItem(client, id) === null) throw error; }
      const saved = await checkpointChain(client, current, rule);
      if (saved.skipped.length > 0) return { status: "skipped", plan: current.id, skipped: saved.skipped, remedy: "Leave foreign evidence intact and register a fresh candidate." };
      verifyPrefix(rows, saved.rows[index]);
      return saved.reports.at(-1)!;
    });
  });
}
