import { encodeBoundedJson, parseBoundedJson, type JsonEncodingRefusal } from "./tracker-record.ts";
/** Predeclared paired policy comparisons with fixed cohorts and equal-weight correlation units. */
import type { GetResult, PmClient } from "@unbrained/pm-cli/sdk/core";
import { acquireLockLease, createPmCliExpectedError, EXIT_CODE, isPmCliExpectedError, readSettings } from "@unbrained/pm-cli/sdk/runtime";
import { dirname } from "node:path";
import { createVerifiedItem, extractGenerationSpec, generationProvenance, hashJson, readCompleteLoopItem, type JsonValue } from "./index.ts";
import { decidePromotion, type PromotionCriterion, type PromotionDecision } from "./promotion.ts";
import { enforceShadowComparison } from "./shadow.ts";
import { rethrowOperationalRead } from "./refuse.ts";
import { canonicalizeIdentifier, type GenerationSpec, type ScoreRecord } from "./lineage.ts";

/** Stable refusals available to SDK consumers and CLI agents. */
export type EvaluationPlanRefusal = "eval_plan_invalid" | "eval_plan_drift" | "eval_plan_late" | "eval_plan_missing" | "eval_plan_evidence" | "eval_plan_stopping" | "eval_plan_refused" | CohortRefusal | JsonEncodingRefusal;
/** A protected slice uses only predeclared member identities, never outcome-derived labels. */
export interface ProtectedCohort {
  readonly id: string;
  readonly members: readonly string[];
  readonly min_units: number;
  /** Inclusive maximum empirical regression in the plan's original reward units. */
  readonly max_regression: number;
}
/** Machine-readable evidence failures; a new design always needs a fresh candidate. */
export type CohortRefusal = "eval_cohort_samples" | "eval_cohort_regression";
/** Bounded summary; positive improvement is better in either optimization direction. */
export interface CohortReport {
  readonly id: string;
  readonly observations: number;
  readonly independent_units: number;
  readonly min_units: number;
  readonly improvement: number;
  readonly max_regression: number;
  readonly code: CohortRefusal | null;
}
/** A member can contribute only to its frozen correlation unit, regardless of repeated measurements. */
export interface EvaluationMember { readonly id: string; readonly unit: string }
/** All statistical and cohort choices are frozen before the candidate and its collection runs exist. */
export interface EvaluationPlan {
  readonly format: "pm-rl/evaluation-plan/1";
  /** Content identity of the consented online observation manifest, when deployed in shadow. */
  readonly shadow?: string;
  /** Optional for legacy plans; when supplied, every cohort must pass alongside the aggregate gate. */
  readonly protected_cohorts?: readonly ProtectedCohort[];
  readonly candidate: string;
  readonly incumbent: string;
  readonly incumbent_version: string;
  readonly population: string;
  readonly selection: string;
  readonly correlation_unit: string;
  readonly members: readonly EvaluationMember[];
  readonly objective: string;
  readonly objective_version: string;
  readonly evaluation_context: string;
  readonly direction: "maximize" | "minimize";
  readonly reward_bounds: readonly [number, number];
  readonly criterion: PromotionCriterion;
  readonly stopping: { readonly kind: "fixed"; readonly observations: number; readonly independent_units: number };
}
/** Paired bounded outcomes, one per declared member; sample counts are never accepted from the caller. */
export interface EvaluationObservation { readonly id: string; readonly candidate: number; readonly incumbent: number }
/** Compact agent output; full cohorts and raw observations remain in creation-verified tracker records. */
export interface EvaluationPlanReport {
  readonly plan: string;
  readonly comparison: string;
  readonly observations: number;
  readonly independent_units: number;
  readonly candidate_mean: number;
  readonly incumbent_mean: number;
  /** Confidence bounds, uncertainty, margin and effect threshold use rewards normalized to [0, 1]. */
  readonly verdict: PromotionDecision;
  /** Original statistical verdict, retained when a protected cohort refuses admission. */
  readonly aggregate_verdict?: PromotionDecision;
  readonly cohorts?: readonly CohortReport[];
  readonly remedy: string | null;
}
/** Persisted predeclaration pins the incumbent's original provenance as well as the entire plan. */
export interface RegisteredEvaluationPlan {
  readonly id: string;
  readonly comparison: string;
  readonly plan: EvaluationPlan;
  readonly incumbent_version: string;
  readonly created_at: string;
}

/** Throw an actionable typed refusal without copying tracker content into diagnostics. */
function refuse(code: EvaluationPlanRefusal): never {
  throw createPmCliExpectedError(`Evaluation plan refused (${code}). Register a new plan with a fresh candidate before collection; supply the exact declared cohort and one fixed-stop paired evaluation.`, { exitCode: EXIT_CODE.CONFLICT, context: { code } });
}
/** Reject unknown keys so no apparent design choice disappears from comparison identity. */
function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(value, key))) refuse("eval_plan_invalid");
  return value as Record<string, unknown>;
}
/** Normalize bounded labels and identities before hashing and comparing them. */
function label(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > 1024) refuse("eval_plan_invalid");
  return value.trim();
}
/** Reject sparse arrays at the same boundary as unknown keys and nonfinite numbers. */
function dense(value: unknown, minimum: number, maximum: number): value is unknown[] {
  return Array.isArray(value) && value.length >= minimum && value.length <= maximum && Array.from({ length: value.length }, (_, i) => Object.hasOwn(value, i)).every(Boolean);
}
/** Validate and canonicalize cohort declarations with the plan's single schema. */
function protectedCohorts(value: unknown, members: readonly EvaluationMember[], bounds: readonly [number, number]): ProtectedCohort[] {
  if (!dense(value, 1, 32)) refuse("eval_plan_invalid");
  const declared = new Set(members.map((member) => member.id));
  const cohorts = value.map((entry): ProtectedCohort => {
    const c = object(entry, ["id", "members", "min_units", "max_regression"]);
    if (!dense(c.members, 1, 10_000) || typeof c.min_units !== "number" || !Number.isSafeInteger(c.min_units) || c.min_units < 1 || c.min_units > 10_000 || !validRegression(c.max_regression, bounds)) refuse("eval_plan_invalid");
    const ids = c.members.map(label).sort(); const id = label(c.id);
    if (id.length > 128 || new Set(ids).size !== ids.length || ids.some((member) => !declared.has(member))) refuse("eval_plan_invalid");
    return { id, members: ids, min_units: c.min_units, max_regression: c.max_regression };
  }).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  if (new Set(cohorts.map((cohort) => cohort.id)).size !== cohorts.length) refuse("eval_plan_invalid");
  return cohorts;
}
/** Validate the entire fixed design; adaptive stopping needs a different future plan format. */
export function parseEvaluationPlan(value: unknown): EvaluationPlan {
  const shadowKeys = value !== null && typeof value === "object" && Object.hasOwn(value, "shadow") ? ["shadow"] : [];
  const cohortKeys = value !== null && typeof value === "object" && Object.hasOwn(value, "protected_cohorts") ? ["protected_cohorts"] : [];
  const p = object(value, [...shadowKeys, ...cohortKeys, "format", "candidate", "incumbent", "incumbent_version", "population", "selection", "correlation_unit", "members", "objective", "objective_version", "evaluation_context", "direction", "reward_bounds", "criterion", "stopping"]);
  if (p.format !== "pm-rl/evaluation-plan/1" || (p.direction !== "maximize" && p.direction !== "minimize")) refuse("eval_plan_invalid");
  const candidate = label(p.candidate); const incumbent = label(p.incumbent);
  if (candidate === incumbent) refuse("eval_plan_invalid");
  if (!dense(p.members, 1, 10_000)) refuse("eval_plan_invalid");
  const members = p.members.map((value): EvaluationMember => { const m = object(value, ["id", "unit"]); return { id: label(m.id), unit: label(m.unit) }; }).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const units = new Set(members.map((m) => m.unit));
  if (new Set(members.map((m) => m.id)).size !== members.length) refuse("eval_plan_invalid");
  const stopping = object(p.stopping, ["kind", "observations", "independent_units"]);
  if (stopping.kind !== "fixed" || stopping.observations !== members.length || stopping.independent_units !== units.size) refuse("eval_plan_invalid");
  const c = object(p.criterion, ["confidence", "minSamples", "effectThreshold"]);
  if (typeof c.confidence !== "number" || !Number.isFinite(c.confidence) || c.confidence <= 0 || c.confidence >= 1 || typeof c.minSamples !== "number" || !Number.isSafeInteger(c.minSamples) || c.minSamples < 1 || typeof c.effectThreshold !== "number" || !Number.isFinite(c.effectThreshold) || c.effectThreshold < 0) refuse("eval_plan_invalid");
  const b = p.reward_bounds;
  if (!dense(b, 2, 2) || b.some((v) => typeof v !== "number" || !Number.isFinite(v)) || (b[0] as number) >= (b[1] as number) || !Number.isFinite((b[1] as number) - (b[0] as number))) refuse("eval_plan_invalid");
  const plan: EvaluationPlan = { ...(shadowKeys.length === 0 ? {} : { shadow: label(p.shadow) }), ...(cohortKeys.length === 0 ? {} : { protected_cohorts: protectedCohorts(p.protected_cohorts, members, b as [number, number]) }), format: "pm-rl/evaluation-plan/1", candidate, incumbent, incumbent_version: label(p.incumbent_version), population: label(p.population), selection: label(p.selection), correlation_unit: label(p.correlation_unit), members,
    objective: label(p.objective), objective_version: label(p.objective_version), evaluation_context: label(p.evaluation_context), direction: p.direction as EvaluationPlan["direction"],
    reward_bounds: [b[0] as number, b[1] as number], criterion: { confidence: c.confidence, minSamples: c.minSamples, effectThreshold: c.effectThreshold },
    stopping: { kind: "fixed", observations: members.length, independent_units: units.size } };
  evaluationPlanBody(plan);
  return plan;
}
/** Preflight the actual persisted wrapper, including duplicated incumbent identity and cohort expansion. */
function evaluationPlanBody(plan: EvaluationPlan): string { return encodeBoundedJson({ plan, incumbent_version: plan.incumbent_version }); }
/** Preview and persistence use the same complete evidence-envelope encoding contract. */
function evaluationResultBody(comparison: string, observations: readonly EvaluationObservation[]): string { return encodeBoundedJson({ comparison, observations }); }
/** A stable candidate reservation prevents changing the plan for the same generation. */
export function evaluationPlanId(candidate: string): string { return `${label(candidate)}-evaluation-plan`; }
/** Every plan choice contributes to comparison identity; member order does not. */
export function evaluationComparison(value: unknown): string { return hashJson(parseEvaluationPlan(value) as unknown as JsonValue); }
/** Return only a certified absence; malformed, denied and incomplete reads propagate. */
export async function optionalItem(client: PmClient, id: string, at?: string): Promise<GetResult["item"] | null> {
  try { return (await readCompleteLoopItem(client, id, at)).item; }
  catch (error) { if (isPmCliExpectedError(error) && error.exitCode === EXIT_CODE.NOT_FOUND) return null; throw error; }
}
/** Decode package-owned JSON without leaking raw malformed content through parser errors. */
function storedJson(body: unknown): unknown {
  try { return parseBoundedJson(String(body)); } catch { return refuse("eval_plan_drift"); }
}
/** Read the SDK's verified creation snapshot or refuse unavailable original history. */
async function createdItem(client: PmClient, id: string): Promise<GetResult["item"]> {
  try { return (await readCompleteLoopItem(client, id, "1")).item; }
  catch (error) { rethrowOperationalRead(error); refuse("eval_plan_drift"); }
}
/** Bind sealed fields to the SDK's verified first history version, allowing unrelated annotations. */
async function verifyCreatedRecord(client: PmClient, item: GetResult["item"]): Promise<void> {
  const original = await createdItem(client, item.id);
  if ((["id", "type", "body", "created_at", "affected_version"] as const).some((field) => original[field] !== item[field])) refuse("eval_plan_drift");
}
/** Verify the full stored Plan and its provenance, rather than trusting its derived id. */
export async function readEvaluationPlan(client: PmClient, candidate: string): Promise<RegisteredEvaluationPlan | null> {
  candidate = label(candidate);
  const id = evaluationPlanId(candidate); const item = await optionalItem(client, id);
  if (item === null) {
    if (await optionalItem(client, id, "1") !== null) refuse("eval_plan_missing");
    return null;
  }
  const record = object(storedJson(item.body), ["plan", "incumbent_version"]);
  const plan = parseEvaluationPlan(record.plan); const incumbentVersion = label(record.incumbent_version);
  const comparison = evaluationComparison(plan);
  if (item.type !== "Plan" || item.id !== id || plan.candidate !== candidate || plan.incumbent_version !== incumbentVersion || item.affected_version !== hashJson({ comparison, incumbent_version: incumbentVersion })) refuse("eval_plan_drift");
  await verifyCreatedRecord(client, item);
  return { id, comparison, plan, incumbent_version: incumbentVersion, created_at: String(item.created_at) };
}
/** Register before candidate creation; repeat identical declarations safely, refusing edited designs. */
export async function registerEvaluationPlan(client: PmClient, value: unknown): Promise<RegisteredEvaluationPlan> {
  const plan = parseEvaluationPlan(value);
  return withPlanLease(client, plan.candidate, () => registerParsedPlan(client, plan));
}
/** Re-read the reservation under the package lease; immutable native creates arbitrate foreign writers. */
async function registerParsedPlan(client: PmClient, plan: EvaluationPlan): Promise<RegisteredEvaluationPlan> {
  const prefix = label((await client.config("project", "get", "id_prefix")).nested_setting!.value);
  if (canonicalizeIdentifier(plan.candidate, prefix) !== plan.candidate) refuse("eval_plan_invalid");
  const existing = await readEvaluationPlan(client, plan.candidate);
  if (existing !== null) { if (existing.comparison !== evaluationComparison(plan)) refuse("eval_plan_drift"); return existing; }
  if (await optionalItem(client, plan.candidate) !== null) refuse("eval_plan_late");
  const incumbent = await optionalItem(client, plan.incumbent);
  if (incumbent === null || incumbent.type !== "Generation" || incumbent.id !== plan.incumbent || typeof incumbent.affected_version !== "string" || incumbent.affected_version.length === 0) refuse("eval_plan_missing");
  const comparison = evaluationComparison(plan); const version = incumbent.affected_version;
  if (version !== plan.incumbent_version) refuse("eval_plan_drift");
  if (hashJson(generationProvenance(extractGenerationSpec(String(incumbent.body), "Incumbent generation"))) !== version) refuse("eval_plan_drift");
  const id = evaluationPlanId(plan.candidate);
  try {
    await createVerifiedItem(client, { id, title: "Predeclared paired policy evaluation", type: "Plan", body: evaluationPlanBody(plan),
      unset: ["parent", "sprint", "release", "blocked-by"], clearDeps: true, affectedVersion: hashJson({ comparison, incumbent_version: version }), message: "Predeclare fixed cohort evaluation plan" });
  } catch (error) {
    const winner = await readEvaluationPlan(client, plan.candidate);
    if (winner === null || winner.comparison !== comparison || winner.incumbent_version !== version) throw error;
  }
  return (await readEvaluationPlan(client, plan.candidate))!;
}
/** Serialize package reservation/evidence writers with SDK ownership fencing, releasing last. */
async function withPlanLease<T>(client: PmClient, candidate: string, execute: () => Promise<T>): Promise<T> {
  const config = await client.config("project", "get", "id_prefix"); const root = dirname(config.settings_path);
  const settings = await readSettings(root);
  const lease = await acquireLockLease(root, `rl-eval-${hashJson(label(candidate))}`, settings.locks.ttl_seconds, "pm-rl-evaluation", false, false, 30_000, { maxWaitMs: 30_000 });
  try { return await lease.fence(execute); } finally { await lease.release(); }
}
/** Canonical observation order makes floating-point aggregation and evidence retries reproducible. */
function normalizedObservations(input: readonly unknown[]): EvaluationObservation[] {
  return input.map((value): EvaluationObservation => {
    const row = object(value, ["id", "candidate", "incumbent"]);
    if ([row.candidate, row.incumbent].some((score) => typeof score !== "number" || !Number.isFinite(score))) refuse("eval_plan_evidence");
    return { id: label(row.id), candidate: row.candidate as number, incumbent: row.incumbent as number };
  }).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}
/** Reduced exact rational arithmetic for decimal JSON rewards and count-derived means. */
interface Rational { readonly n: bigint; readonly d: bigint }
/** Reduce fractions after every operation to bound denominators for unequal unit sizes. */
function rational(n: bigint, d: bigint): Rational {
  let a = n < 0n ? -n : n; let b = d;
  while (b !== 0n) { const remainder = a % b; a = b; b = remainder; }
  return { n: n / a, d: d / a };
}
/** Interpret the finite number's canonical decimal spelling, including scientific notation. */
function exact(value: number): Rational {
  const [mantissa, exponent = "0"] = String(value).split("e");
  const parts = mantissa.split("."); const digits = parts.join(""); const scale = (parts[1]?.length ?? 0) - Number(exponent);
  return scale < 0 ? rational(BigInt(digits) * 10n ** BigInt(-scale), 1n) : rational(BigInt(digits), 10n ** BigInt(scale));
}
/** Add signed fractions without rounding before an inclusive threshold comparison. */
function add(a: Rational, b: Rational): Rational { return rational(a.n * b.d + b.n * a.d, a.d * b.d); }
/** One exact domain rule serves declaration validation and emitted cohort reports. */
function validRegression(value: unknown, bounds: readonly [number, number]): value is number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return false;
  const limit = exact(value); const lo = exact(bounds[0]); const hi = exact(bounds[1]);
  const width = add(hi, { n: -lo.n, d: lo.d });
  return limit.n * width.d <= width.n * limit.d;
}
/** Count fields share the input schema's positive bounded integer domain. */
function validCount(value: number, maximum = 10_000): boolean { return Number.isSafeInteger(value) && value >= 1 && value <= maximum; }
/** Compute equal-unit empirical guards; repeated members never inflate evidence minimums. */
function evaluateCohorts(plan: EvaluationPlan, rows: readonly EvaluationObservation[]): CohortReport[] {
  const observations = new Map(rows.map((row) => [row.id, row])); const members = new Map(plan.members.map((member) => [member.id, member.unit]));
  const [lo, hi] = plan.reward_bounds; const range = hi - lo; const direction = plan.direction === "maximize" ? 1 : -1;
  return plan.protected_cohorts!.map((cohort) => {
    const units = new Map<string, { sum: Rational; count: number; display: number }>();
    for (const id of cohort.members) {
      const row = observations.get(id)!; const unit = members.get(id)!;
      const group = units.get(unit) ?? { sum: { n: 0n, d: 1n }, count: 0, display: 0 };
      const candidate = exact(row.candidate); const incumbent = exact(row.incumbent);
      const difference = add(candidate, { n: -incumbent.n, d: incumbent.d });
      group.sum = add(group.sum, difference); group.count += 1;
      const display = (row.candidate - lo) / range - (row.incumbent - lo) / range;
      group.display += (display - group.display) / group.count; units.set(unit, group);
    }
    let sum: Rational = { n: 0n, d: 1n }; let display = 0; let count = 0;
    for (const unit of units.values()) {
      sum = add(sum, rational(unit.sum.n, unit.sum.d * BigInt(unit.count)));
      count += 1; display += (unit.display - display) / count;
    }
    const mean = rational(sum.n * BigInt(direction), sum.d * BigInt(count)); const limit = exact(cohort.max_regression);
    const code = count < cohort.min_units ? "eval_cohort_samples" : mean.n * limit.d < -limit.n * mean.d ? "eval_cohort_regression" : null;
    const improvement = Math.max(-1, Math.min(1, display * direction)) * range;
    return { id: cohort.id, observations: cohort.members.length, independent_units: count, min_units: cohort.min_units, improvement, max_regression: cohort.max_regression, code };
  });
}
/** Validate every emitted numeric leaf and the documented reward/count domains before returning success. @internal */
export function validateEvaluationReport(report: EvaluationPlanReport, bounds: readonly [number, number]): EvaluationPlanReport {
  /** Traverse the producer's bounded report, including nested statistical verdicts. */
  function finite(value: unknown): boolean {
    if (typeof value === "number") return Number.isFinite(value);
    if (value === null || typeof value !== "object") return true;
    return Object.values(value).every(finite);
  }
  const [lo, hi] = bounds; const range = hi - lo;
  if ((report.cohorts !== undefined && !dense(report.cohorts, 1, 32)) || !finite(report) || ![report.candidate_mean, report.incumbent_mean].every((value) => value >= lo && value <= hi) || !validCount(report.observations) || !validCount(report.independent_units, report.observations) || report.cohorts?.some((cohort) => Math.abs(cohort.improvement) > range || !validRegression(cohort.max_regression, bounds) || !validCount(cohort.observations) || !validCount(cohort.min_units) || !validCount(cohort.independent_units, cohort.observations))) refuse("eval_plan_evidence");
  return report;
}
/** Recompute paired equal-unit means, counting a correlated cohort once in the bound. */
export function evaluatePlan(value: unknown, input: unknown): EvaluationPlanReport {
  const plan = parseEvaluationPlan(value);
  if (!dense(input, plan.stopping.observations, plan.stopping.observations)) refuse("eval_plan_stopping");
  const [lo, hi] = plan.reward_bounds; const range = hi - lo;
  const declared = new Map(plan.members.map((member) => [member.id, member.unit])); const seen = new Set<string>();
  const groups = new Map<string, { candidate: number; incumbent: number; n: number }>();
  const rows = normalizedObservations(input);
  const comparison = evaluationComparison(plan);
  evaluationResultBody(comparison, rows);
  for (const row of rows) {
    const id = row.id; const unit = declared.get(id);
    if (unit === undefined || seen.has(id) || [row.candidate, row.incumbent].some((score) => score < plan.reward_bounds[0] || score > plan.reward_bounds[1])) refuse("eval_plan_evidence");
    seen.add(id); const group = groups.get(unit) ?? { candidate: 0, incumbent: 0, n: 0 };
    // Remove the common offset before averaging; narrow ranges near huge rewards lose raw increments.
    group.n += 1; group.candidate += (((row.candidate - lo) / range) - group.candidate) / group.n; group.incumbent += (((row.incumbent - lo) / range) - group.incumbent) / group.n; groups.set(unit, group);
  }
  const means = [...groups.values()];
  const candidateMean = means.reduce((mean, group, index) => mean + (group.candidate - mean) / (index + 1), 0);
  const incumbentMean = means.reduce((mean, group, index) => mean + (group.incumbent - mean) / (index + 1), 0);
  const shared = { objective: plan.objective, objective_version: plan.objective_version, evaluation_context: plan.evaluation_context, direction: plan.direction, rewardBounds: [0, 1] as const, samples: groups.size };
  const criterion = { ...plan.criterion, effectThreshold: plan.criterion.effectThreshold / range };
  const aggregate = decidePromotion({ candidate: { ...shared, generation: plan.candidate, mean: candidateMean }, incumbent: { ...shared, generation: plan.incumbent, mean: incumbentMean }, criterion, expectedGeneration: plan.candidate, contaminationPath: null });
  const cohorts = plan.protected_cohorts === undefined ? undefined : evaluateCohorts(plan, rows);
  const failure = cohorts?.find((cohort) => cohort.code !== null);
  const verdict: PromotionDecision = failure === undefined ? aggregate : { decision: "refuse", code: failure.code!, reason: "A protected cohort failed its predeclared evidence minimum or nonregression limit." };
  // Reconstruct from the nearer endpoint so rounding the range cannot overflow a finite upper bound.
  const candidateReward = candidateMean <= 0.5 ? lo + candidateMean * range : hi - (1 - candidateMean) * range;
  const incumbentReward = incumbentMean <= 0.5 ? lo + incumbentMean * range : hi - (1 - incumbentMean) * range;
  return validateEvaluationReport({ plan: evaluationPlanId(plan.candidate), comparison, observations: input.length, independent_units: groups.size, candidate_mean: candidateReward, incumbent_mean: incumbentReward, verdict, ...(cohorts === undefined ? {} : { aggregate_verdict: aggregate, cohorts }), remedy: verdict.decision === "promote" ? null : "Register a new plan and fresh candidate before collecting a different cohort or making another evaluation look." }, plan.reward_bounds);
}
/** Require predeclaration before all collection runs and unchanged incumbent provenance. */
async function verifyTiming(client: PmClient, registered: RegisteredEvaluationPlan, spec: GenerationSpec, createdAt: unknown): Promise<void> {
  if (spec.parent !== registered.plan.incumbent) refuse("eval_plan_drift");
  const incumbent = await optionalItem(client, spec.parent);
  if (incumbent === null || incumbent.type !== "Generation" || incumbent.affected_version !== registered.incumbent_version || hashJson(generationProvenance(extractGenerationSpec(String(incumbent.body), "Incumbent generation"))) !== registered.incumbent_version) refuse("eval_plan_drift");
  for (const timestamp of [createdAt, ...(await Promise.all(spec.collection_runs.map(async (id) => (await createdItem(client, id)).created_at)))]) {
    if (!(Date.parse(registered.created_at) < Date.parse(String(timestamp)))) refuse("eval_plan_late");
  }
}
/** Read the live candidate so SDK callers cannot forge provenance or predeclaration times. */
async function verifiedCandidate(client: PmClient, candidate: string, registered: RegisteredEvaluationPlan): Promise<void> {
  const item = await readCompleteLoopItem(client, candidate);
  if (item.item.type !== "Generation" || item.item.id !== candidate) refuse("eval_plan_drift");
  const spec = extractGenerationSpec(String(item.item.body), "Candidate generation");
  if ((spec.evaluation_plan !== undefined && spec.evaluation_plan !== registered.comparison) || item.item.affected_version !== hashJson(generationProvenance(spec))) refuse("eval_plan_drift");
  const original = await createdItem(client, candidate);
  const unchanged = (["id", "type", "created_at", "affected_version"] as const).map((field) => original[field] === item.item[field]);
  unchanged.push(hashJson(generationProvenance(extractGenerationSpec(String(original.body), "Original candidate generation"))) === item.item.affected_version);
  if (unchanged.includes(false)) refuse("eval_plan_drift");
  await verifyTiming(client, registered, spec, original.created_at);
}
/** Seal exactly one evaluation, including refusals; a second look requires a fresh plan/candidate. */
export async function recordPlanEvaluation(client: PmClient, candidate: string, input: unknown): Promise<EvaluationPlanReport> {
  candidate = label(candidate);
  return withPlanLease(client, candidate, () => recordLeasedEvaluation(client, candidate, input));
}
/** Revalidate current creation revisions and read the current result before deciding an identical retry. */
async function recordLeasedEvaluation(client: PmClient, candidate: string, input: unknown): Promise<EvaluationPlanReport> {
  const registered = await readEvaluationPlan(client, candidate); if (registered === null) refuse("eval_plan_missing");
  await verifiedCandidate(client, candidate, registered);
  const report = evaluatePlan(registered.plan, input);
  const rows = normalizedObservations(input as unknown[]);
  const body = evaluationResultBody(registered.comparison, rows);
  const id = `${registered.id}-result`;
  const existing = await optionalItem(client, id);
  if (existing !== null) {
    await verifyCreatedRecord(client, existing);
    if (existing.type !== "Decision" || existing.body !== body || existing.affected_version !== hashJson(storedJson(body) as JsonValue)) refuse("eval_plan_drift");
  } else {
    try { await createVerifiedItem(client, { id, type: "Decision", title: "Fixed-stop paired evaluation result", body, unset: ["parent", "sprint", "release", "blocked-by"], clearDeps: true, affectedVersion: hashJson(storedJson(body) as JsonValue), message: "Seal predeclared evaluation evidence" }); }
    catch (error) {
      const winner = await optionalItem(client, id);
      if (winner === null || winner.type !== "Decision" || winner.body !== body || winner.affected_version !== hashJson(storedJson(body) as JsonValue)) throw error;
      await verifyCreatedRecord(client, winner);
    }
  }
  return report;
}
/** Gate both CLI and controller promotions inside their authoritative writer lock. Legacy candidates have no reservation. */
export async function enforceEvaluationPlan(client: PmClient, candidate: string, score: ScoreRecord): Promise<void> {
  candidate = label(candidate);
  const registered = await readEvaluationPlan(client, candidate);
  if (registered === null) {
    const item = await optionalItem(client, candidate);
    if (item !== null && item.type === "Generation" && extractGenerationSpec(String(item.body), "Candidate generation").evaluation_plan !== undefined) refuse("eval_plan_missing");
    await enforceShadowComparison(client, candidate, null);
    return;
  }
  await verifiedCandidate(client, candidate, registered);
  await enforceShadowComparison(client, candidate, registered.plan);
  const result = await optionalItem(client, `${registered.id}-result`); if (result === null) refuse("eval_plan_missing");
  const raw = object(storedJson(result.body), ["comparison", "observations"]);
  if (result.type !== "Decision" || raw.comparison !== registered.comparison || result.affected_version !== hashJson(raw as JsonValue)) refuse("eval_plan_drift");
  await verifyCreatedRecord(client, result);
  const report = evaluatePlan(registered.plan, raw.observations);
  const prefix = label((await client.config("project", "get", "id_prefix")).nested_setting!.value);
  if (score.objective !== registered.plan.objective || score.objective_version !== registered.plan.objective_version || canonicalizeIdentifier(score.evaluation_context, prefix) !== canonicalizeIdentifier(registered.plan.evaluation_context, prefix) || score.direction !== registered.plan.direction || score.seed_set !== registered.comparison || score.scale !== registered.plan.reward_bounds[1] - registered.plan.reward_bounds[0] || score.value !== report.candidate_mean) refuse("eval_plan_evidence");
  if (report.verdict.decision !== "promote") refuse(report.verdict.code === "eval_cohort_samples" || report.verdict.code === "eval_cohort_regression" ? report.verdict.code : "eval_plan_refused");
}
