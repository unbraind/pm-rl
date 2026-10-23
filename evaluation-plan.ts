/** Predeclared paired policy comparisons with fixed cohorts and equal-weight correlation units. */
import type { GetResult, PmClient } from "@unbrained/pm-cli/sdk/core";
import { createPmCliExpectedError, EXIT_CODE, isPmCliExpectedError, normalizeItemId } from "@unbrained/pm-cli/sdk/runtime";
import { extractGenerationSpec, generationProvenance, hashJson, readCompleteLoopItem, type JsonValue } from "./index.ts";
import { decidePromotion, type PromotionCriterion, type PromotionDecision } from "./promotion.ts";
import { enforceShadowComparison } from "./shadow.ts";
import { rethrowOperationalRead } from "./refuse.ts";
import type { GenerationSpec, ScoreRecord } from "./lineage.ts";

/** Stable refusals available to SDK consumers and CLI agents. */
export type EvaluationPlanRefusal = "eval_plan_invalid" | "eval_plan_drift" | "eval_plan_late" | "eval_plan_missing" | "eval_plan_evidence" | "eval_plan_stopping" | "eval_plan_refused";
/** A member can contribute only to its frozen correlation unit, regardless of repeated measurements. */
export interface EvaluationMember { readonly id: string; readonly unit: string }
/** All statistical and cohort choices are frozen before the candidate and its collection runs exist. */
export interface EvaluationPlan {
  readonly format: "pm-rl/evaluation-plan/1";
  /** Content identity of the consented online observation manifest, when deployed in shadow. */
  readonly shadow?: string;
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
/** Validate the entire fixed design; adaptive stopping needs a different future plan format. */
export function parseEvaluationPlan(value: unknown): EvaluationPlan {
  const shadowKeys = value !== null && typeof value === "object" && Object.hasOwn(value, "shadow") ? ["shadow"] : [];
  const p = object(value, [...shadowKeys, "format", "candidate", "incumbent", "incumbent_version", "population", "selection", "correlation_unit", "members", "objective", "objective_version", "evaluation_context", "direction", "reward_bounds", "criterion", "stopping"]);
  if (p.format !== "pm-rl/evaluation-plan/1" || (p.direction !== "maximize" && p.direction !== "minimize")) refuse("eval_plan_invalid");
  const candidate = label(p.candidate); const incumbent = label(p.incumbent);
  if (candidate === incumbent) refuse("eval_plan_invalid");
  if (!Array.isArray(p.members) || p.members.length === 0 || p.members.length > 10_000) refuse("eval_plan_invalid");
  const members = p.members.map((value): EvaluationMember => { const m = object(value, ["id", "unit"]); return { id: label(m.id), unit: label(m.unit) }; }).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const units = new Set(members.map((m) => m.unit));
  if (new Set(members.map((m) => m.id)).size !== members.length) refuse("eval_plan_invalid");
  const stopping = object(p.stopping, ["kind", "observations", "independent_units"]);
  if (stopping.kind !== "fixed" || stopping.observations !== members.length || stopping.independent_units !== units.size) refuse("eval_plan_invalid");
  const c = object(p.criterion, ["confidence", "minSamples", "effectThreshold"]);
  if (typeof c.confidence !== "number" || !Number.isFinite(c.confidence) || c.confidence <= 0 || c.confidence >= 1 || typeof c.minSamples !== "number" || !Number.isSafeInteger(c.minSamples) || c.minSamples < 1 || typeof c.effectThreshold !== "number" || !Number.isFinite(c.effectThreshold) || c.effectThreshold < 0) refuse("eval_plan_invalid");
  const b = p.reward_bounds;
  if (!Array.isArray(b) || b.length !== 2 || b.some((v) => typeof v !== "number" || !Number.isFinite(v)) || b[0] >= b[1] || !Number.isFinite(b[1] - b[0])) refuse("eval_plan_invalid");
  return { ...(shadowKeys.length === 0 ? {} : { shadow: label(p.shadow) }), format: "pm-rl/evaluation-plan/1", candidate, incumbent, incumbent_version: label(p.incumbent_version), population: label(p.population), selection: label(p.selection), correlation_unit: label(p.correlation_unit), members,
    objective: label(p.objective), objective_version: label(p.objective_version), evaluation_context: label(p.evaluation_context), direction: p.direction as EvaluationPlan["direction"],
    reward_bounds: [b[0] as number, b[1] as number], criterion: { confidence: c.confidence, minSamples: c.minSamples, effectThreshold: c.effectThreshold },
    stopping: { kind: "fixed", observations: members.length, independent_units: units.size } };
}
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
  try { return JSON.parse(String(body)); } catch { return refuse("eval_plan_drift"); }
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
  const prefix = label((await client.config("project", "get", "id_prefix")).nested_setting!.value);
  if (normalizeItemId(plan.candidate, prefix) !== plan.candidate) refuse("eval_plan_invalid");
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
    await client.create({ id, title: "Predeclared paired policy evaluation", type: "Plan", body: JSON.stringify({ plan, incumbent_version: version }),
      affectedVersion: hashJson({ comparison, incumbent_version: version }), message: "Predeclare fixed cohort evaluation plan" });
  } catch (error) {
    const winner = await readEvaluationPlan(client, plan.candidate);
    if (winner === null || winner.comparison !== comparison || winner.incumbent_version !== version) throw error;
  }
  return (await readEvaluationPlan(client, plan.candidate))!;
}
/** Canonical observation order makes floating-point aggregation and evidence retries reproducible. */
function normalizedObservations(input: readonly unknown[]): EvaluationObservation[] {
  return input.map((value): EvaluationObservation => {
    const row = object(value, ["id", "candidate", "incumbent"]);
    if ([row.candidate, row.incumbent].some((score) => typeof score !== "number" || !Number.isFinite(score))) refuse("eval_plan_evidence");
    return { id: label(row.id), candidate: row.candidate as number, incumbent: row.incumbent as number };
  }).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}
/** Recompute paired equal-unit means, counting a correlated cohort once in the bound. */
export function evaluatePlan(value: unknown, input: unknown): EvaluationPlanReport {
  const plan = parseEvaluationPlan(value);
  if (!Array.isArray(input) || input.length !== plan.stopping.observations) refuse("eval_plan_stopping");
  const [lo, hi] = plan.reward_bounds; const range = hi - lo;
  const declared = new Map(plan.members.map((member) => [member.id, member.unit])); const seen = new Set<string>();
  const groups = new Map<string, { candidate: number; incumbent: number; n: number }>();
  for (const row of normalizedObservations(input)) {
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
  const verdict = decidePromotion({ candidate: { ...shared, generation: plan.candidate, mean: candidateMean }, incumbent: { ...shared, generation: plan.incumbent, mean: incumbentMean }, criterion, expectedGeneration: plan.candidate, contaminationPath: null });
  // Reconstruct from the nearer endpoint so rounding the range cannot overflow a finite upper bound.
  const candidateReward = candidateMean <= 0.5 ? lo + candidateMean * range : hi - (1 - candidateMean) * range;
  const incumbentReward = incumbentMean <= 0.5 ? lo + incumbentMean * range : hi - (1 - incumbentMean) * range;
  return { plan: evaluationPlanId(plan.candidate), comparison: evaluationComparison(plan), observations: input.length, independent_units: groups.size, candidate_mean: candidateReward, incumbent_mean: incumbentReward, verdict, remedy: verdict.decision === "promote" ? null : "Register a new plan and fresh candidate before collecting a different cohort or making another evaluation look." };
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
  const registered = await readEvaluationPlan(client, candidate); if (registered === null) refuse("eval_plan_missing");
  await verifiedCandidate(client, candidate, registered);
  const report = evaluatePlan(registered.plan, input);
  const rows = normalizedObservations(input as unknown[]);
  const body = JSON.stringify({ comparison: registered.comparison, observations: rows });
  const id = `${registered.id}-result`;
  const existing = await optionalItem(client, id);
  if (existing !== null) {
    await verifyCreatedRecord(client, existing);
    if (existing.type !== "Decision" || existing.body !== body || existing.affected_version !== hashJson(storedJson(body) as JsonValue)) refuse("eval_plan_drift");
  } else {
    try { await client.create({ id, type: "Decision", title: "Fixed-stop paired evaluation result", body, affectedVersion: hashJson(storedJson(body) as JsonValue), message: "Seal predeclared evaluation evidence" }); }
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
  if (score.objective !== registered.plan.objective || score.objective_version !== registered.plan.objective_version || score.evaluation_context !== registered.plan.evaluation_context || score.direction !== registered.plan.direction || score.seed_set !== registered.comparison || score.scale !== registered.plan.reward_bounds[1] - registered.plan.reward_bounds[0] || score.value !== report.candidate_mean) refuse("eval_plan_evidence");
  if (report.verdict.decision !== "promote") refuse("eval_plan_refused");
}
