import { identifier, identifierClient, operationIdentifier, schemaIdentity, type ValidationMode } from "./state-boundary.ts";
import { evaluateSequentialBoundary, parseSequentialStopping, readSequentialEvaluation, reviewSequentialPlan, withEvaluationLease, type SequentialStopping, type SequentialBoundary } from "./sequential-evaluation.ts";
import { parseBoundedJson } from "./tracker-record.ts";
/** Predeclared paired policy comparisons with fixed cohorts and equal-weight correlation units. */
import type { GetResult, PmClient } from "@unbrained/pm-cli/sdk/core";
import { listMutationEvents } from "@unbrained/pm-cli/sdk";
import { dirname } from "node:path";
import { createPmCliExpectedError, EXIT_CODE, isPmCliExpectedError } from "@unbrained/pm-cli/sdk/runtime";
import { extractGenerationSpec, generationProvenance, hashJson, readCompleteLoopItem, captureDecisionInputs, verifyTerminalEvaluationReceipt, verifyDecisionEvidence, type JsonValue } from "./index.ts";
import { decidePromotion, type PromotionCriterion, type PromotionDecision } from "./promotion.ts";
import { enforceShadowComparison } from "./shadow.ts";
import { rethrowOperationalRead } from "./refuse.ts";
import { canonicalizeEvaluationContext, canonicalizeGenerationSpec, canonicalizeIdentifier, type GenerationSpec, type ScoreRecord, type EvaluationEvidence } from "./lineage.ts";
import { readSeries } from "./series.ts";

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
  readonly stopping: { readonly kind: "fixed"; readonly observations: number; readonly independent_units: number } | SequentialStopping;
}
/** Paired bounded outcomes, one per declared member; sample counts are never accepted from the caller. */
export interface EvaluationObservation { readonly id: string; readonly candidate: number; readonly incumbent: number }
/** Compact agent output; full cohorts and raw observations remain in creation-verified tracker records. */
export interface EvaluationPlanReport {
  /** Root of the exact SDK input graph; present on sequential SDK results, never inferred from caller scores. */
  readonly evidence_digest?: string;
  readonly plan: string;
  readonly comparison: string;
  readonly observations: number;
  readonly independent_units: number;
  readonly candidate_mean: number;
  readonly incumbent_mean: number;
  /** Confidence bounds, uncertainty, margin and effect threshold use rewards normalized to [0, 1]. */
  readonly verdict: PromotionDecision;
  readonly remedy: string | null;
  /** Present only for a predeclared sequential protocol; bounds use normalized paired improvement. */
  readonly sequential?: SequentialBoundary;
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
export function refuse(code: EvaluationPlanRefusal, itemId?: string): never {
  const remedy = code === "eval_plan_late" ? "Seal required reviews and a new plan before collection; for sequential plans create all collection Runs, then a fresh candidate, then ordered looks. Do not reuse evidence created before its source." : code === "eval_plan_stopping" ? "Use advance/resume for a sequential plan, evaluate for a fixed plan, and supply only the next declared complete unit prefix. A changed protocol requires a new plan and fresh candidate." : code === "eval_plan_evidence" ? "Check bounded paired rewards and the Decision reviewing the exact comparison hash. Changed sealed evidence requires a new plan and fresh candidate." : "Seal the design and any required review before registering a new plan, then create a fresh candidate and collection; retain the exact declared cohort, provenance and reviewed stopping protocol.";
  throw createPmCliExpectedError(`Evaluation plan refused (${code}).${itemId === undefined ? "" : ` Record ${itemId}.`} ${remedy}`, { exitCode: EXIT_CODE.CONFLICT, context: { code, required: remedy, ...(itemId === undefined ? {} : { item_id: itemId }) } });
}

/** Strict bounded schema shared by stored promotion receipts and evaluator-produced graphs. */
export function parseEvaluationEvidence(value: unknown): EvaluationEvidence {
  const row = object(value, ["format", "comparison", "inputs", "digest"]);
  if (row.format !== "pm-rl/evaluation-evidence/1" || typeof row.comparison !== "string" || !/^[a-f0-9]{64}$/.test(row.comparison) || !Array.isArray(row.inputs) || row.inputs.length === 0 || row.inputs.length > 10_000) refuse("eval_plan_evidence");
  const inputs = Array.from(row.inputs, (input) => {
    const ref = object(input, input !== null && typeof input === "object" && Object.hasOwn(input, "at") ? ["id", "digest", "at"] : ["id", "digest"]);
    if (typeof ref.id !== "string" || operationIdentifier(ref.id) !== ref.id || typeof ref.digest !== "string" || !/^[a-f0-9]{64}$/.test(ref.digest)) refuse("eval_plan_evidence");
    if (ref.at !== undefined && (typeof ref.at !== "string" || !/^[1-9][0-9]*$/.test(ref.at) || !Number.isSafeInteger(Number(ref.at)))) refuse("eval_plan_evidence");
    return { id: ref.id, digest: ref.digest, ...(ref.at === undefined ? {} : { at: ref.at as string }) };
  });
  if (new Set(inputs.map((input) => input.id)).size !== inputs.length) refuse("eval_plan_evidence");
  const body = { format: "pm-rl/evaluation-evidence/1" as const, comparison: row.comparison, inputs };
  if (row.digest !== hashJson(body as unknown as JsonValue)) refuse("eval_plan_evidence");
  return { ...body, digest: row.digest as string };
}
/** Hash decision-bearing content, excluding annotations and mutable promotion bookkeeping. */
export function evaluationInputDigest(item: GetResult["item"], comparison?: string): string {
  const spec = item.type === "Generation" ? extractGenerationSpec(String(item.body), "Evaluation input") : null;
  const generation = spec === null ? String(item.body) : { provenance: generationProvenance(spec), ...(spec.evaluation_evidence !== undefined && spec.evaluation_evidence.comparison !== comparison ? { upstream_evidence: spec.evaluation_evidence } : {}) };
  return hashJson({ id: item.id, type: String(item.type), body: generation as unknown as JsonValue, version: String(item.affected_version), created_at: String(item.created_at),
    ...(item.type === "Run" ? { environment: item.environment ?? null, policy: item.component ?? null, metrics: readSeries((item.notes ?? []).map((note) => note.text)).events as unknown as JsonValue } : {}) });
}
/** Seal precisely the records read by this execution, including history-only collection sources. */
export function evaluationEvidence(comparison: string, inputs: readonly GetResult["item"][], versions?: ReadonlyMap<string, string>): EvaluationEvidence {
  const body = { format: "pm-rl/evaluation-evidence/1" as const, comparison, inputs: inputs.map((item) => ({ id: item.id, digest: evaluationInputDigest(item, comparison), ...(versions === undefined ? {} : { at: versions.get(item.id)! }) })).sort((a, b) => a.id.localeCompare(b.id)) };
  return parseEvaluationEvidence({ ...body, digest: hashJson(body as unknown as JsonValue) });
}
/** Reject unknown keys so no apparent design choice disappears from comparison identity. */
function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(value, key))) refuse("eval_plan_invalid");
  return value as Record<string, unknown>;
}
/** Normalize bounded labels and identities before hashing and comparing them. */
function label(value: unknown, kind?: "item" | "cohort" | "context", mode: ValidationMode = "read"): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > 1024) refuse("eval_plan_invalid");
  return kind === undefined ? value.trim() : schemaIdentity(value, kind, mode);
}
/** Validate the complete design once, including dense bounded cohorts and a declared stopping protocol. */
export function parseEvaluationPlan(value: unknown, mode: ValidationMode = "read"): EvaluationPlan {
  const shadowKeys = value !== null && typeof value === "object" && Object.hasOwn(value, "shadow") ? ["shadow"] : [];
  const p = object(value, [...shadowKeys, "format", "candidate", "incumbent", "incumbent_version", "population", "selection", "correlation_unit", "members", "objective", "objective_version", "evaluation_context", "direction", "reward_bounds", "criterion", "stopping"]);
  if (p.format !== "pm-rl/evaluation-plan/1" || (p.direction !== "maximize" && p.direction !== "minimize")) refuse("eval_plan_invalid");
  const candidate = label(p.candidate, "item", mode); const incumbent = label(p.incumbent, "item", mode);
  if (candidate === incumbent) refuse("eval_plan_invalid");
  if (!Array.isArray(p.members) || p.members.length === 0 || p.members.length > 10_000) refuse("eval_plan_invalid");
  const members = Array.from(p.members, (value): EvaluationMember => { const m = object(value, ["id", "unit"]); return { id: label(m.id, "cohort", mode), unit: label(m.unit, "cohort", mode) }; }).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const units = new Set(members.map((m) => m.unit));
  if (new Set(members.map((m) => m.id)).size !== members.length) refuse("eval_plan_invalid");
  const sequential = p.stopping !== null && typeof p.stopping === "object" && "kind" in p.stopping && p.stopping.kind === "sequential";
  if (sequential && shadowKeys.length > 0) refuse("eval_plan_invalid");
  const stopping = sequential ? parseSequentialStopping(p.stopping, members) : object(p.stopping, ["kind", "observations", "independent_units"]);
  if ((!sequential && stopping.kind !== "fixed") || stopping.observations !== members.length || stopping.independent_units !== units.size) refuse("eval_plan_invalid");
  const c = object(p.criterion, ["confidence", "minSamples", "effectThreshold"]);
  if (typeof c.confidence !== "number" || !Number.isFinite(c.confidence) || c.confidence <= 0 || c.confidence >= 1 || typeof c.minSamples !== "number" || !Number.isSafeInteger(c.minSamples) || c.minSamples < 1 || typeof c.effectThreshold !== "number" || !Number.isFinite(c.effectThreshold) || c.effectThreshold < 0) refuse("eval_plan_invalid");
  const b = p.reward_bounds;
  if (!Array.isArray(b) || b.length !== 2 || Array.from(b).some((v) => typeof v !== "number" || !Number.isFinite(v)) || b[0] >= b[1] || !Number.isFinite(b[1] - b[0])) refuse("eval_plan_invalid");
  const normalized: EvaluationPlan = { ...(shadowKeys.length === 0 ? {} : { shadow: label(p.shadow) }), format: "pm-rl/evaluation-plan/1", candidate, incumbent, incumbent_version: label(p.incumbent_version), population: label(p.population), selection: label(p.selection), correlation_unit: label(p.correlation_unit), members,
    objective: label(p.objective), objective_version: label(p.objective_version), evaluation_context: label(p.evaluation_context, "context", mode), direction: p.direction as EvaluationPlan["direction"],
    reward_bounds: [b[0] as number, b[1] as number], criterion: { confidence: c.confidence, minSamples: c.minSamples, effectThreshold: c.effectThreshold },
    stopping: sequential ? stopping as SequentialStopping : { kind: "fixed", observations: members.length, independent_units: units.size } };
  if (sequential && Buffer.byteLength(JSON.stringify(normalized)) > 1_048_576) refuse("eval_plan_invalid");
  return normalized;
}
/** A stable candidate reservation prevents changing the plan for the same generation. */
export function evaluationPlanId(candidate: string, mode: ValidationMode = "read"): string { return `${label(candidate, "item", mode)}-evaluation-plan`; }
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
export async function verifyCreatedRecord(client: PmClient, item: GetResult["item"]): Promise<void> {
  const original = await createdItem(client, item.id);
  if ((["id", "type", "body", "created_at", "affected_version"] as const).some((field) => original[field] !== item[field])) refuse("eval_plan_drift", item.id);
}
/** Complete current sequential lifecycle; every cumulative look seals every candidate collection Run. @internal */
export function evaluationLifecycleArtifacts(registered: RegisteredEvaluationPlan, runs: readonly string[], looks: number): { id: string; stage: number }[] {
  if (registered.plan.stopping.kind !== "sequential") refuse("eval_plan_stopping");
  return [{ id: registered.plan.stopping.review, stage: 0 }, { id: registered.id, stage: 1 }, ...runs.map((id) => ({ id, stage: 2 })), { id: registered.plan.candidate, stage: 3 }, ...Array.from({ length: looks }, (_, index) => ({ id: `${registered.id}-look-${index + 1}`, stage: index + 4 }))];
}
/** Compare durable snapshot timestamps, mutation timestamps and SDK history positions together. @internal */
export function validateEvaluationTimeline(entries: readonly { stage: number; values: readonly number[] }[]): void {
  let prior = [-Infinity, -Infinity, -Infinity];
  for (const stage of [...new Set(entries.map((entry) => entry.stage))].sort((left, right) => left - right)) {
    const next = [...prior];
    for (const entry of entries.filter((value) => value.stage === stage)) {
      // Collection Runs are exchangeable sources, but ALL must precede the candidate and every look.
      if (!entry.values.every((value, index) => Number.isFinite(value) && value > prior[index])) refuse("eval_plan_late");
      for (let index = 0; index < entry.values.length; index += 1) next[index] = Math.max(next[index], entry.values[index]);
    }
    prior = next;
  }
}
/** One validator expands sequential dependencies itself, so callers cannot omit source Runs. @internal */
export async function validateEvaluationOrder(client: PmClient, input: readonly { id: string; stage: number }[] | { registered: RegisteredEvaluationPlan; looks: number }, pageSize = 1000): Promise<void> {
  let artifacts: readonly { id: string; stage: number }[];
  if ("registered" in input) {
    const candidate = await readCompleteLoopItem(client, input.registered.plan.candidate);
    const prefix = String((await identifierClient(client).config("project", "get", "id_prefix")).nested_setting!.value);
    const spec = canonicalizeGenerationSpec(extractGenerationSpec(String(candidate.item.body), "Sequential collection provenance"), prefix);
    artifacts = evaluationLifecycleArtifacts(input.registered, spec.collection_runs, input.looks);
  } else artifacts = input;
  const entries = await Promise.all(artifacts.map(async ({ id, stage }) => ({ id: operationIdentifier(id), stage, item: await createdItem(client, id) })));
  const config = await identifierClient(client).config("project", "get", "id_prefix");
  const events: Awaited<ReturnType<typeof listMutationEvents>>["events"] = [];
  let cursor: string | undefined; let page: Awaited<ReturnType<typeof listMutationEvents>>;
  do {
    page = await listMutationEvents({ pmRoot: dirname(config.settings_path), item: entries.map((entry) => entry.item.id), type: "create", since: cursor, limit: pageSize });
    events.push(...page.events); cursor = page.next_cursor;
  } while (page.has_more);
  const positions = new Map(events.map((event, index) => [event.item_id, index]));
  const times = new Map(events.filter((event) => event.version === 1).map((event) => [event.item_id, event.ts]));
  validateEvaluationTimeline(entries.map((entry) => ({ stage: entry.stage, values: [Date.parse(String(entry.item.created_at)), Date.parse(String(times.get(entry.item.id))), Number(positions.get(entry.item.id))] })));
}
/** Verify the full stored Plan and its provenance, rather than trusting its derived id. */
export async function readEvaluationPlan(client: PmClient, candidate: string): Promise<RegisteredEvaluationPlan | null> {
  operationIdentifier(candidate);
  const prefix = String((await identifierClient(client).config("project", "get", "id_prefix")).nested_setting!.value);
  candidate = canonicalizeIdentifier(candidate, prefix);
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
  if (plan.stopping.kind === "sequential") await reviewSequentialPlan(client, plan, String(item.created_at));
  return { id, comparison, plan, incumbent_version: incumbentVersion, created_at: String(item.created_at) };
}
/** Resolve native plan references through the SDK before computing the comparison a Decision reviews. */
export async function resolveEvaluationPlan(client: PmClient, value: unknown, mode: ValidationMode = "read"): Promise<EvaluationPlan> {
  const parsed = parseEvaluationPlan(value, mode);
  const prefix = String((await identifierClient(client).config("project", "get", "id_prefix")).nested_setting!.value);
  return { ...parsed, candidate: canonicalizeIdentifier(parsed.candidate, prefix), incumbent: canonicalizeIdentifier(parsed.incumbent, prefix), stopping: parsed.stopping.kind === "fixed" ? parsed.stopping : { ...parsed.stopping, review: canonicalizeIdentifier(parsed.stopping.review, prefix) } };
}
/** Register before candidate creation; repeat identical declarations safely, refusing edited designs. */
export async function registerEvaluationPlan(client: PmClient, value: unknown): Promise<RegisteredEvaluationPlan> {
  const plan = await resolveEvaluationPlan(client, value);
  if (plan.stopping.kind === "sequential") return withEvaluationLease(client, plan.candidate, [plan.candidate, plan.incumbent, plan.stopping.review], () => registerParsedPlan(client, plan, value));
  return registerParsedPlan(client, plan, value);
}
/** Create a previously validated reservation; sequential callers hold all provenance locks. */
async function registerParsedPlan(client: PmClient, plan: EvaluationPlan, input: unknown): Promise<RegisteredEvaluationPlan> {
  if (plan.stopping.kind === "sequential") await reviewSequentialPlan(client, plan);
  const prefix = label((await identifierClient(client).config("project", "get", "id_prefix")).nested_setting!.value);
  if (canonicalizeIdentifier(plan.candidate, prefix) !== plan.candidate) refuse("eval_plan_invalid");
  const existing = await readEvaluationPlan(client, plan.candidate);
  if (existing !== null) { if (existing.comparison !== evaluationComparison(plan)) refuse("eval_plan_drift"); return existing; }
  parseEvaluationPlan(input, "write"); // A retry of an existing declaration is a read, not a new write.
  if (await optionalItem(client, plan.candidate) !== null) refuse("eval_plan_late");
  const incumbent = await optionalItem(client, plan.incumbent);
  if (incumbent === null || incumbent.type !== "Generation" || incumbent.id !== plan.incumbent || typeof incumbent.affected_version !== "string" || incumbent.affected_version.length === 0) refuse("eval_plan_missing");
  const comparison = evaluationComparison(plan); const version = incumbent.affected_version;
  if (version !== plan.incumbent_version) refuse("eval_plan_drift");
  if (hashJson(generationProvenance(extractGenerationSpec(String(incumbent.body), "Incumbent generation"))) !== version) refuse("eval_plan_drift");
  const id = evaluationPlanId(plan.candidate);
  try {
    await identifierClient(client).create({ id, title: "Predeclared paired policy evaluation", type: "Plan", body: JSON.stringify({ plan, incumbent_version: version }),
      affectedVersion: hashJson({ comparison, incumbent_version: version }), message: "Predeclare fixed cohort evaluation plan" });
  } catch (error) {
    const winner = await readEvaluationPlan(client, plan.candidate);
    if (winner === null || winner.comparison !== comparison || winner.incumbent_version !== version) throw error;
  }
  return (await readEvaluationPlan(client, plan.candidate))!;
}
/** Canonical observation order makes floating-point aggregation and evidence retries reproducible. */
export function normalizedObservations(input: readonly unknown[], mode: ValidationMode = "read"): EvaluationObservation[] {
  return Array.from(input, (value): EvaluationObservation => {
    const row = object(value, ["id", "candidate", "incumbent"]);
    if ([row.candidate, row.incumbent].some((score) => typeof score !== "number" || !Number.isFinite(score))) refuse("eval_plan_evidence");
    return { id: label(row.id, "cohort", mode), candidate: row.candidate as number, incumbent: row.incumbent as number };
  }).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}
/** Recompute paired equal-unit means, counting a correlated cohort once in the bound. */
export function evaluatePlan(value: unknown, input: unknown): EvaluationPlanReport {
  const plan = parseEvaluationPlan(value);
  if (!Array.isArray(input) || input.length > plan.stopping.observations || (plan.stopping.kind === "fixed" && input.length !== plan.stopping.observations)) refuse("eval_plan_stopping");
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
  if (plan.stopping.kind === "sequential") {
    const n = groups.size;
    const expected = new Set(plan.stopping.unit_order.slice(0, n));
    if (!plan.stopping.looks.includes(n) || plan.members.some((member) => expected.has(member.unit) !== seen.has(member.id))) refuse("eval_plan_stopping");
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
  const boundary = plan.stopping.kind === "sequential" ? evaluateSequentialBoundary(plan, groups.size, candidateMean, incumbentMean) : null;
  return validateEvaluationReport(plan, { ...(boundary === null ? {} : { sequential: boundary.sequential }), plan: evaluationPlanId(plan.candidate), comparison: evaluationComparison(plan), observations: input.length, independent_units: groups.size, candidate_mean: candidateReward, incumbent_mean: incumbentReward, verdict: boundary?.verdict ?? verdict, remedy: boundary?.sequential.state === "continue" ? "Collect only the next declared complete unit prefix, then advance this sealed plan." : (boundary?.verdict ?? verdict).decision === "promote" ? null : "Register a new plan and fresh candidate before collecting a different cohort or making another evaluation look." });
}
/** Refuse nonfinite or out-of-domain emitted numbers before returning a successful report. @internal */
export function validateEvaluationReport(plan: EvaluationPlan, report: EvaluationPlanReport): EvaluationPlanReport {
  /** Walk the complete constructed result, including future nested numeric fields. */
  function numeric(value: unknown): void {
    if (typeof value === "number" && !Number.isFinite(value)) refuse("eval_plan_evidence");
    if (value !== null && typeof value === "object") for (const field of Object.values(value)) numeric(field);
  }
  numeric(report);
  if (report.evidence_digest !== undefined && (typeof report.evidence_digest !== "string" || !/^[a-f0-9]{64}$/.test(report.evidence_digest))) refuse("eval_plan_evidence");
  for (const value of [report.candidate_mean, report.incumbent_mean]) if (value < plan.reward_bounds[0] || value > plan.reward_bounds[1]) refuse("eval_plan_evidence");
  for (const [count, max] of [[report.observations, plan.stopping.observations], [report.independent_units, plan.stopping.independent_units]]) if (!Number.isSafeInteger(count) || count < 1 || count > max) refuse("eval_plan_evidence");
  if (report.sequential !== undefined) {
    const b = report.sequential;
    if (b.lower < -1 || b.upper > 1 || b.lower > b.upper || b.error_bound <= 0 || b.error_bound > 1 || !Number.isSafeInteger(b.look) || b.look < 1 || b.look > 64) refuse("eval_plan_evidence");
  }
  return report;
}
/** Require predeclaration before all collection runs and unchanged incumbent provenance. */
async function verifyTiming(client: PmClient, registered: RegisteredEvaluationPlan, spec: GenerationSpec): Promise<void> {
  const prefix = String((await identifierClient(client).config("project", "get", "id_prefix")).nested_setting!.value);
  spec = canonicalizeGenerationSpec(spec, prefix);
  if (spec.parent !== registered.plan.incumbent) refuse("eval_plan_drift");
  const incumbent = await optionalItem(client, spec.parent);
  if (incumbent === null || incumbent.type !== "Generation" || incumbent.affected_version !== registered.incumbent_version || hashJson(generationProvenance(extractGenerationSpec(String(incumbent.body), "Incumbent generation"))) !== registered.incumbent_version) refuse("eval_plan_drift");
  await validateEvaluationOrder(client, registered.plan.stopping.kind === "sequential" ? { registered, looks: 0 } : [{ id: registered.id, stage: 1 }, ...spec.collection_runs.map((id) => ({ id, stage: 2 })), { id: registered.plan.candidate, stage: 2 }]);
}
/** Read the live candidate so SDK callers cannot forge provenance or predeclaration times. */
export async function verifiedCandidate(client: PmClient, candidate: string, registered: RegisteredEvaluationPlan): Promise<void> {
  const item = await readCompleteLoopItem(client, candidate);
  if (item.item.type !== "Generation" || item.item.id !== candidate) refuse("eval_plan_drift");
  const spec = extractGenerationSpec(String(item.item.body), "Candidate generation");
  if ((spec.evaluation_plan !== undefined && spec.evaluation_plan !== registered.comparison) || item.item.affected_version !== hashJson(generationProvenance(spec))) refuse("eval_plan_drift");
  const original = await createdItem(client, candidate);
  const unchanged = (["id", "type", "created_at", "affected_version"] as const).map((field) => original[field] === item.item[field]);
  unchanged.push(hashJson(generationProvenance(extractGenerationSpec(String(original.body), "Original candidate generation"))) === item.item.affected_version);
  if (unchanged.includes(false)) refuse("eval_plan_drift");
  await verifyTiming(client, registered, spec);
}
/** Seal exactly one evaluation, including refusals; a second look requires a fresh plan/candidate. */
export async function recordPlanEvaluation(client: PmClient, candidate: string, input: unknown): Promise<EvaluationPlanReport> {
  const registered = await readEvaluationPlan(client, candidate); if (registered === null) refuse("eval_plan_missing");
  if (registered.plan.stopping.kind === "sequential") refuse("eval_plan_stopping");
  candidate = registered.plan.candidate;
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
    try { await identifierClient(client).create({ id, type: "Decision", title: "Fixed-stop paired evaluation result", body, affectedVersion: hashJson(storedJson(body) as JsonValue), message: "Seal predeclared evaluation evidence" }); }
    catch (error) {
      const winner = await optionalItem(client, id);
      if (winner === null || winner.type !== "Decision" || winner.body !== body || winner.affected_version !== hashJson(storedJson(body) as JsonValue)) throw error;
      await verifyCreatedRecord(client, winner);
    }
  }
  return report;
}
/** Read the same validated decision for enforcement and summaries, returning its actual SDK inputs. */
export async function readEvaluationDecision(client: PmClient, candidate: string, pending = false): Promise<{ registered: RegisteredEvaluationPlan | null; report: EvaluationPlanReport | null; evidence: EvaluationEvidence | null }> {
  const captured = await captureDecisionInputs(client, async () => {
    const registered = await readEvaluationPlan(client, candidate);
    if (registered === null) {
      if (!pending) {
        const item = await optionalItem(client, candidate);
        if (item !== null && item.type === "Generation" && extractGenerationSpec(String(item.body), "Candidate generation").evaluation_plan !== undefined) refuse("eval_plan_missing", item.id);
        await enforceShadowComparison(client, candidate, null);
      }
      return { registered, report: null };
    }
    const resolved = registered.plan.candidate;
    if (pending && await optionalItem(client, resolved) === null) {
      if (registered.plan.stopping.kind === "sequential") await reviewSequentialPlan(client, registered.plan);
      return { registered, report: null };
    }
    await verifiedCandidate(client, resolved, registered);
    if (pending && registered.plan.shadow !== undefined && await optionalItem(client, `${registered.id}-shadow-comparison`) === null) return { registered, report: null };
    await enforceShadowComparison(client, resolved, registered.plan);
    if (registered.plan.stopping.kind === "sequential") {
      const latest = await readSequentialEvaluation(client, resolved);
      if (latest !== null && "status" in latest) refuse("eval_plan_evidence", latest.skipped[0]?.id);
      return { registered, report: latest };
    }
    const result = await optionalItem(client, `${registered.id}-result`);
    if (result === null) return { registered, report: null };
    const raw = object(storedJson(result.body), ["comparison", "observations"]);
    if (result.type !== "Decision" || raw.comparison !== registered.comparison || result.affected_version !== hashJson(raw as JsonValue)) refuse("eval_plan_drift", result.id);
    await verifyCreatedRecord(client, result);
    await validateEvaluationOrder(client, [{ id: registered.id, stage: 1 }, { id: result.id, stage: 3 }]);
    return { registered, report: evaluatePlan(registered.plan, raw.observations) };
  });
  for (const item of captured.inputs) {
    if (item.type !== "Generation" || item.id === captured.value.registered?.plan.candidate) continue;
    const upstream = extractGenerationSpec(String(item.body), "Upstream evidence").evaluation_evidence;
    if (upstream !== undefined) await verifyDecisionEvidence(client, upstream);
  }
  const evidence = captured.value.registered === null ? null : evaluationEvidence(captured.value.registered.comparison, captured.inputs);
  const canonicalCandidate = captured.value.registered?.plan.candidate ?? candidate;
  const candidateItem = captured.inputs.find((item) => item.id === canonicalCandidate && item.type === "Generation");
  if (candidateItem !== undefined && captured.value.registered !== null) await verifyTerminalEvaluationReceipt(client, candidateItem);
  const retained = candidateItem === undefined ? undefined : extractGenerationSpec(String(candidateItem.body), "Promotion evidence").evaluation_evidence;
  if (retained !== undefined && evidence?.digest !== retained.digest) {
    const expected = new Map(retained.inputs.map((input) => [input.id, input.digest]));
    const changed = evidence?.inputs.find((input) => expected.get(input.id) !== input.digest)?.id ?? retained.inputs.find((input) => !evidence?.inputs.some((current) => current.id === input.id))?.id;
    refuse("eval_plan_drift", changed ?? canonicalCandidate);
  }
  return { ...captured.value, evidence };
}
/** Gate CLI, controller and recovery promotions through the same read-derived evidence graph. */
export async function enforceEvaluationPlan(client: PmClient, candidate: string, score: ScoreRecord): Promise<void> {
  await enforceEvaluationDecision(client, candidate, score);
}
/** The promotion writer consumes the exact inputs returned by its scoring gate. @internal */
export async function enforceEvaluationDecision(client: PmClient, candidate: string, score: ScoreRecord): Promise<EvaluationEvidence | undefined> {
  const decision = await readEvaluationDecision(client, candidate);
  if (decision.registered === null) return undefined;
  if (decision.report === null) refuse("eval_plan_missing", decision.registered.id);
  const prefix = label((await identifierClient(client).config("project", "get", "id_prefix")).nested_setting!.value);
  verifyEvaluationScore(decision.registered, decision.report, score, prefix);
  return decision.evidence!;
}
/** Keep promotion score bindings identical for fixed and sequential evidence. */
function verifyEvaluationScore(registered: RegisteredEvaluationPlan, report: EvaluationPlanReport, score: ScoreRecord, prefix: string): void {
  if (score.objective !== registered.plan.objective || score.objective_version !== registered.plan.objective_version || canonicalizeEvaluationContext(score.evaluation_context, prefix) !== canonicalizeEvaluationContext(registered.plan.evaluation_context, prefix) || score.direction !== registered.plan.direction || score.seed_set !== registered.comparison || score.scale !== registered.plan.reward_bounds[1] - registered.plan.reward_bounds[0] || score.value !== report.candidate_mean) refuse("eval_plan_evidence");
  if (report.verdict.decision !== "promote") refuse("eval_plan_refused");
}
