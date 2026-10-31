import { acquireStateLease, identifier, identifierClient, operationIdentifier, schemaIdentity, type ValidationMode } from "./state-boundary.ts";
import { evaluateSequentialBoundary, parseSequentialStopping, readSequentialEvaluation, reviewSequentialPlan, withEvaluationLease, type SequentialStopping, type SequentialBoundary } from "./sequential-evaluation.ts";
import { encodeBoundedJson, parseBoundedJson, type JsonEncodingRefusal } from "./tracker-record.ts";
/** Predeclared paired policy comparisons with fixed cohorts and equal-weight correlation units. */
import type { GetResult, PmClient } from "@unbrained/pm-cli/sdk/core";
import { listMutationEvents } from "@unbrained/pm-cli/sdk";
import { dirname } from "node:path";
import { createPmCliExpectedError, EXIT_CODE, isPmCliExpectedError, readSettings } from "@unbrained/pm-cli/sdk/runtime";
import { createVerifiedItem, extractGenerationSpec, generationProvenance, hashJson, readCompleteLoopItem, captureDecisionInputs, verifyTerminalEvaluationReceipt, verifyDecisionEvidence, type JsonValue } from "./index.ts";
import { decidePromotion, type PromotionCriterion, type PromotionDecision } from "./promotion.ts";
import { enforceShadowComparison, shadowEvidenceIds } from "./shadow.ts";
import { rethrowOperationalRead } from "./refuse.ts";
import { canonicalizeEvaluationContext, canonicalizeGenerationSpec, canonicalizeIdentifier, type GenerationSpec, type ScoreRecord, type EvaluationEvidence } from "./lineage.ts";
import { readSeries } from "./series.ts";

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
  /** Optional predeclared empirical protections; available on fixed-sample plans. */
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
  /** Aggregate result before any protected cohort refusal. */
  readonly aggregate_verdict?: PromotionDecision;
  readonly cohorts?: readonly CohortReport[];
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
  if ((row.format !== "pm-rl/evaluation-evidence/1" && row.format !== "pm-rl/evaluation-evidence/2") || typeof row.comparison !== "string" || !/^[a-f0-9]{64}$/.test(row.comparison) || !Array.isArray(row.inputs) || row.inputs.length === 0 || row.inputs.length > 10_000) refuse("eval_plan_evidence");
  const inputs = Array.from(row.inputs, (input) => {
    const ref = object(input, input !== null && typeof input === "object" && Object.hasOwn(input, "at") ? ["id", "digest", "at"] : ["id", "digest"]);
    if (typeof ref.id !== "string" || operationIdentifier(ref.id) !== ref.id || typeof ref.digest !== "string" || !/^[a-f0-9]{64}$/.test(ref.digest)) refuse("eval_plan_evidence");
    if (row.format === "pm-rl/evaluation-evidence/2" && ref.at === undefined) refuse("eval_plan_evidence");
    if (ref.at !== undefined && (typeof ref.at !== "string" || !/^[1-9][0-9]*$/.test(ref.at) || !Number.isSafeInteger(Number(ref.at)))) refuse("eval_plan_evidence");
    return { id: ref.id, digest: ref.digest, ...(ref.at === undefined ? {} : { at: ref.at as string }) };
  });
  if (new Set(inputs.map((input) => input.id)).size !== inputs.length) refuse("eval_plan_evidence");
  const body = { format: row.format as EvaluationEvidence["format"], comparison: row.comparison, inputs };
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
/** Fingerprint an immutable SDK snapshot without projecting mutable records under a later comparison. */
export function decisionSnapshotDigest(item: Pick<GetResult["item"], "id" | "type" | "body" | "affected_version" | "created_at" | "component" | "environment" | "notes">): string {
  return hashJson({ id: item.id, type: String(item.type), body: String(item.body), version: String(item.affected_version), created_at: String(item.created_at),
    ...(item.type === "Run" ? { environment: item.environment ?? null, policy: item.component ?? null, metrics: readSeries((item.notes ?? []).map((note) => note.text)).events as unknown as JsonValue } : {}) });
}
/** Seal precisely the records read by this execution, including history-only collection sources. */
export function evaluationEvidence(comparison: string, inputs: readonly GetResult["item"][], versions?: ReadonlyMap<string, string>): EvaluationEvidence {
  const body = { format: "pm-rl/evaluation-evidence/1" as const, comparison, inputs: inputs.map((item) => ({ id: item.id, digest: evaluationInputDigest(item, comparison), ...(versions === undefined ? {} : { at: versions.get(item.id)! }) })).sort((a, b) => Buffer.compare(Buffer.from(a.id), Buffer.from(b.id))) };
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
    const ids = c.members.map((member) => label(member)).sort(); const id = label(c.id);
    if (id.length > 128 || new Set(ids).size !== ids.length || ids.some((member) => !declared.has(member))) refuse("eval_plan_invalid");
    return { id, members: ids, min_units: c.min_units, max_regression: c.max_regression };
  }).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  if (new Set(cohorts.map((cohort) => cohort.id)).size !== cohorts.length) refuse("eval_plan_invalid");
  return cohorts;
}
/** Validate the complete design once, including dense bounded cohorts and a declared stopping protocol. */
export function parseEvaluationPlan(value: unknown, mode: ValidationMode = "read"): EvaluationPlan {
  const shadowKeys = value !== null && typeof value === "object" && Object.hasOwn(value, "shadow") ? ["shadow"] : [];
  const cohortKeys = value !== null && typeof value === "object" && Object.hasOwn(value, "protected_cohorts") ? ["protected_cohorts"] : [];
  const p = object(value, [...shadowKeys, ...cohortKeys, "format", "candidate", "incumbent", "incumbent_version", "population", "selection", "correlation_unit", "members", "objective", "objective_version", "evaluation_context", "direction", "reward_bounds", "criterion", "stopping"]);
  if (p.format !== "pm-rl/evaluation-plan/1" || (p.direction !== "maximize" && p.direction !== "minimize")) refuse("eval_plan_invalid");
  const candidate = label(p.candidate, "item", mode); const incumbent = label(p.incumbent, "item", mode);
  if (candidate === incumbent) refuse("eval_plan_invalid");
  if (!dense(p.members, 1, 10_000)) refuse("eval_plan_invalid");
  const members = Array.from(p.members, (value): EvaluationMember => { const m = object(value, ["id", "unit"]); return { id: label(m.id, "cohort", mode), unit: label(m.unit, "cohort", mode) }; }).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const units = new Set(members.map((m) => m.unit));
  if (new Set(members.map((m) => m.id)).size !== members.length) refuse("eval_plan_invalid");
  const sequential = p.stopping !== null && typeof p.stopping === "object" && "kind" in p.stopping && p.stopping.kind === "sequential";
  if (sequential && shadowKeys.length > 0) refuse("eval_plan_invalid");
  if (sequential && cohortKeys.length > 0) throw createPmCliExpectedError("Protected cohort guards require a fixed-sample plan. Register a fresh fixed plan for these cohorts, or a separate reviewed sequential plan without protected cohorts.", { exitCode: EXIT_CODE.CONFLICT, context: { code: "eval_plan_stopping", required: "Use fixed-sample protected cohorts or a separately reviewed sequential protocol with a fresh candidate." } });
  const stopping = sequential ? parseSequentialStopping(p.stopping, members) : object(p.stopping, ["kind", "observations", "independent_units"]);
  if ((!sequential && stopping.kind !== "fixed") || stopping.observations !== members.length || stopping.independent_units !== units.size) refuse("eval_plan_invalid");
  const c = object(p.criterion, ["confidence", "minSamples", "effectThreshold"]);
  if (typeof c.confidence !== "number" || !Number.isFinite(c.confidence) || c.confidence <= 0 || c.confidence >= 1 || typeof c.minSamples !== "number" || !Number.isSafeInteger(c.minSamples) || c.minSamples < 1 || typeof c.effectThreshold !== "number" || !Number.isFinite(c.effectThreshold) || c.effectThreshold < 0) refuse("eval_plan_invalid");
  const b = p.reward_bounds;
  if (!Array.isArray(b) || b.length !== 2 || Array.from(b).some((v) => typeof v !== "number" || !Number.isFinite(v)) || b[0] >= b[1] || !Number.isFinite(b[1] - b[0])) refuse("eval_plan_invalid");
  const normalized: EvaluationPlan = { ...(shadowKeys.length === 0 ? {} : { shadow: label(p.shadow) }), ...(cohortKeys.length === 0 ? {} : { protected_cohorts: protectedCohorts(p.protected_cohorts, members, b as [number, number]) }), format: "pm-rl/evaluation-plan/1", candidate, incumbent, incumbent_version: label(p.incumbent_version), population: label(p.population), selection: label(p.selection), correlation_unit: label(p.correlation_unit), members,
    objective: label(p.objective), objective_version: label(p.objective_version), evaluation_context: label(p.evaluation_context, "context", mode), direction: p.direction as EvaluationPlan["direction"],
    reward_bounds: [b[0] as number, b[1] as number], criterion: { confidence: c.confidence, minSamples: c.minSamples, effectThreshold: c.effectThreshold },
    stopping: sequential ? stopping as SequentialStopping : { kind: "fixed", observations: members.length, independent_units: units.size } };
  if (sequential && Buffer.byteLength(JSON.stringify(normalized)) > 1_048_576) refuse("eval_plan_invalid");
  evaluationPlanBody(normalized);
  return normalized;
}
/** Preflight the actual persisted wrapper, including duplicated incumbent identity and cohort expansion. */
function evaluationPlanBody(plan: EvaluationPlan): string { return encodeBoundedJson({ plan, incumbent_version: plan.incumbent_version }); }
/** Preview and persistence use the same complete evidence-envelope encoding contract. */
function evaluationResultBody(comparison: string, observations: readonly EvaluationObservation[]): string { return encodeBoundedJson({ comparison, observations }); }
/** A stable candidate reservation prevents changing the plan for the same generation. */
export function evaluationPlanId(candidate: string, mode: ValidationMode = "read"): string { return `${label(candidate, "item", mode)}-evaluation-plan`; }
/** Share the complete future decision-slot schedule with actual readers and writers. @internal */
export function evaluationOutcomeIds(plan: EvaluationPlan, id = evaluationPlanId(plan.candidate)): string[] {
  return [...(plan.stopping.kind === "sequential" ? evaluationLookIds(id, plan.stopping.looks.length) : [`${id}-result`]), ...(plan.shadow === undefined ? [] : shadowEvidenceIds(plan, `${id}-shadow`))];
}
/** Keep lifecycle expansion and the declared checkpoint schedule on the same coordinates. */
function evaluationLookIds(id: string, count: number): string[] { return Array.from({ length: count }, (_, index) => `${id}-look-${index + 1}`); }
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
  return [{ id: registered.plan.stopping.review, stage: 0 }, { id: registered.id, stage: 1 }, ...runs.map((id) => ({ id, stage: 2 })), { id: registered.plan.candidate, stage: 3 }, ...evaluationLookIds(registered.id, looks).map((id, index) => ({ id, stage: index + 4 }))];
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
export async function validateEvaluationOrder(client: PmClient, input: readonly { id: string; stage: number }[] | { registered: RegisteredEvaluationPlan; looks: number }, pageSize = 1000, prospective?: GetResult["item"]): Promise<void> {
  let artifacts: readonly { id: string; stage: number }[];
  if ("registered" in input) {
    const candidate = prospective === undefined ? await readCompleteLoopItem(client, input.registered.plan.candidate) : { item: prospective };
    const prefix = String((await identifierClient(client).config("project", "get", "id_prefix")).nested_setting!.value);
    const spec = canonicalizeGenerationSpec(extractGenerationSpec(String(candidate.item.body), "Sequential collection provenance"), prefix);
    artifacts = evaluationLifecycleArtifacts(input.registered, spec.collection_runs, input.looks);
  } else artifacts = input;
  const entries = await Promise.all(artifacts.map(async ({ id, stage }) => ({ id: operationIdentifier(id), stage, item: prospective?.id === id ? prospective : await createdItem(client, id) })));
  const config = await identifierClient(client).config("project", "get", "id_prefix");
  const events: Awaited<ReturnType<typeof listMutationEvents>>["events"] = [];
  let cursor: string | undefined; let page: Awaited<ReturnType<typeof listMutationEvents>>;
  do {
    page = await listMutationEvents({ pmRoot: dirname(config.settings_path), item: entries.map((entry) => entry.item.id), type: "create", since: cursor, limit: pageSize });
    events.push(...page.events); cursor = page.next_cursor;
  } while (page.has_more);
  const positions = new Map(events.map((event, index) => [event.item_id, index]));
  const times = new Map(events.filter((event) => event.version === 1).map((event) => [event.item_id, event.ts]));
  // A new candidate would append after every existing event. Project that last
  // coordinate without creating an item, history stream or reserved identity.
  if (prospective !== undefined) { positions.set(prospective.id, events.length); times.set(prospective.id, String(prospective.created_at)); }
  validateEvaluationTimeline(entries.map((entry) => ({ stage: entry.stage, values: [Date.parse(String(entry.item.created_at)), Date.parse(String(times.get(entry.item.id))), Number(positions.get(entry.item.id))] })));
}
/** Verify the full stored Plan and its provenance, rather than trusting its derived id. */
export async function readEvaluationPlan(client: PmClient, candidate: string): Promise<RegisteredEvaluationPlan | null> {
  operationIdentifier(candidate);
  const prefix = String((await identifierClient(client).config("project", "get", "id_prefix")).nested_setting!.value);
  candidate = canonicalizeIdentifier(candidate, prefix);
  const id = evaluationPlanId(candidate); const item = await optionalItem(client, id);
  if (item === null) {
    if (await optionalItem(client, id, "1") !== null) refuse("eval_plan_missing", id);
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
  return withPlanLease(client, plan.candidate, () => registerParsedPlan(client, plan, value));
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
  operationIdentifier(candidate);
  const config = await identifierClient(client).config("project", "get", "id_prefix"); const root = dirname(config.settings_path);
  const settings = await readSettings(root);
  const lease = await acquireStateLease(root, `rl-eval-${hashJson(canonicalizeIdentifier(candidate, String(config.nested_setting!.value)))}`, settings.locks.ttl_seconds, "pm-rl-evaluation", false, false, 30_000, { maxWaitMs: 30_000 });
  try { return await lease.fence(execute); } finally { await lease.release(); }
}
/** Canonical observation order makes floating-point aggregation and evidence retries reproducible. */
export function normalizedObservations(input: readonly unknown[], mode: ValidationMode = "read"): EvaluationObservation[] {
  return Array.from(input, (value): EvaluationObservation => {
    const row = object(value, ["id", "candidate", "incumbent"]);
    if ([row.candidate, row.incumbent].some((score) => typeof score !== "number" || !Number.isFinite(score))) refuse("eval_plan_evidence");
    return { id: label(row.id, "cohort", mode), candidate: row.candidate as number, incumbent: row.incumbent as number };
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
/** Recompute paired equal-unit means, counting a correlated cohort once in the bound. */
export function evaluatePlan(value: unknown, input: unknown): EvaluationPlanReport {
  const plan = parseEvaluationPlan(value);
  if (!dense(input, 1, plan.stopping.observations) || (plan.stopping.kind === "fixed" && input.length !== plan.stopping.observations)) refuse("eval_plan_stopping");
  const [lo, hi] = plan.reward_bounds; const range = hi - lo;
  const declared = new Map(plan.members.map((member) => [member.id, member.unit])); const seen = new Set<string>();
  const groups = new Map<string, { candidate: number; incumbent: number; n: number }>();
  const rows = normalizedObservations(input); const comparison = evaluationComparison(plan);
  evaluationResultBody(comparison, rows);
  for (const row of rows) {
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
  const aggregate = decidePromotion({ candidate: { ...shared, generation: plan.candidate, mean: candidateMean }, incumbent: { ...shared, generation: plan.incumbent, mean: incumbentMean }, criterion, expectedGeneration: plan.candidate, contaminationPath: null });
  // Reconstruct from the nearer endpoint so rounding the range cannot overflow a finite upper bound.
  const candidateReward = candidateMean <= 0.5 ? lo + candidateMean * range : hi - (1 - candidateMean) * range;
  const incumbentReward = incumbentMean <= 0.5 ? lo + incumbentMean * range : hi - (1 - incumbentMean) * range;
  const cohorts = plan.protected_cohorts === undefined ? undefined : evaluateCohorts(plan, rows);
  const failure = cohorts?.find((cohort) => cohort.code !== null);
  const verdict: PromotionDecision = failure === undefined ? aggregate : { decision: "refuse", code: failure.code!, reason: "A protected cohort failed its predeclared evidence minimum or nonregression limit." };
  const boundary = plan.stopping.kind === "sequential" ? evaluateSequentialBoundary(plan, groups.size, candidateMean, incumbentMean) : null;
  return validateEvaluationReport(plan, { ...(boundary === null ? {} : { sequential: boundary.sequential }), plan: evaluationPlanId(plan.candidate), comparison: evaluationComparison(plan), observations: input.length, independent_units: groups.size, candidate_mean: candidateReward, incumbent_mean: incumbentReward, verdict: boundary?.verdict ?? verdict, ...(cohorts === undefined ? {} : { aggregate_verdict: aggregate, cohorts }), remedy: boundary?.sequential.state === "continue" ? "Collect only the next declared complete unit prefix, then advance this sealed plan." : (boundary?.verdict ?? verdict).decision === "promote" ? null : "Register a new plan and fresh candidate before collecting a different cohort or making another evaluation look." });
}
/** Refuse nonfinite or out-of-domain emitted numbers before returning a successful report. @internal */
export function validateEvaluationReport(...args: [plan: EvaluationPlan, report: EvaluationPlanReport] | [report: EvaluationPlanReport, bounds: readonly [number, number]]): EvaluationPlanReport {
  /** Walk the complete constructed result, including future nested numeric fields. */
  function numeric(value: unknown): void {
    if (typeof value === "number" && !Number.isFinite(value)) refuse("eval_plan_evidence");
    if (value !== null && typeof value === "object") for (const field of Object.values(value)) numeric(field);
  }
  const projected = Array.isArray(args[1]);
  const plan = projected ? null : args[0] as EvaluationPlan;
  const report = (projected ? args[0] : args[1]) as EvaluationPlanReport;
  const bounds = projected ? args[1] as readonly [number, number] : plan!.reward_bounds;
  const [lo, hi] = bounds;
  numeric(report);
  if (report.evidence_digest !== undefined && (typeof report.evidence_digest !== "string" || !/^[a-f0-9]{64}$/.test(report.evidence_digest))) refuse("eval_plan_evidence");
  for (const value of [report.candidate_mean, report.incumbent_mean]) if (value < lo || value > hi) refuse("eval_plan_evidence");
  for (const [count, max] of [[report.observations, plan?.stopping.observations ?? 10_000], [report.independent_units, Math.min(plan?.stopping.independent_units ?? report.observations, report.observations)]]) if (!Number.isSafeInteger(count) || count < 1 || count > max) refuse("eval_plan_evidence");
  if (report.sequential !== undefined) {
    const b = report.sequential;
    if (b.lower < -1 || b.upper > 1 || b.lower > b.upper || b.error_bound <= 0 || b.error_bound > 1 || !Number.isSafeInteger(b.look) || b.look < 1 || b.look > 64) refuse("eval_plan_evidence");
  }
  if ((report.cohorts !== undefined && !dense(report.cohorts, 1, 32)) || report.cohorts?.some((cohort) => Math.abs(cohort.improvement) > hi - lo || !validRegression(cohort.max_regression, bounds) || !validCount(cohort.observations) || !validCount(cohort.min_units) || !validCount(cohort.independent_units, cohort.observations))) refuse("eval_plan_evidence");
  return report;
}
/** Require predeclaration before all collection runs and unchanged incumbent provenance. */
async function verifyTiming(client: PmClient, registered: RegisteredEvaluationPlan, spec: GenerationSpec, prospective?: GetResult["item"]): Promise<void> {
  const prefix = String((await identifierClient(client).config("project", "get", "id_prefix")).nested_setting!.value);
  spec = canonicalizeGenerationSpec(spec, prefix);
  if (spec.parent !== registered.plan.incumbent) refuse("eval_plan_drift");
  const incumbent = await optionalItem(client, spec.parent);
  if (incumbent === null || incumbent.type !== "Generation" || incumbent.affected_version !== registered.incumbent_version || hashJson(generationProvenance(extractGenerationSpec(String(incumbent.body), "Incumbent generation"))) !== registered.incumbent_version) refuse("eval_plan_drift");
  await validateEvaluationOrder(client, registered.plan.stopping.kind === "sequential" ? { registered, looks: 0 } : [{ id: registered.id, stage: 1 }, ...spec.collection_runs.map((id) => ({ id, stage: 2 })), { id: registered.plan.candidate, stage: 2 }], 1000, prospective);
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
  operationIdentifier(candidate);
  if (!Array.isArray(input) || input.length > 10_000) refuse("eval_plan_stopping");
  const rows = normalizedObservations(input);
  return withPlanLease(client, candidate, async () => {
    const registered = await readEvaluationPlan(client, candidate); if (registered === null) refuse("eval_plan_missing");
    if (registered.plan.stopping.kind !== "fixed") refuse("eval_plan_stopping");
    const id = registered.plan.candidate;
    const source = extractGenerationSpec(String((await readCompleteLoopItem(client, id)).item.body), "Fixed evaluation sources");
    const target = `${registered.id}-result`;
    const dependencies = [id, registered.id, registered.plan.incumbent, ...source.collection_runs];
    if (await optionalItem(client, target) !== null) dependencies.push(target);
    return withEvaluationLease(client, `${id}-fixed-sources`, dependencies, () => recordLeasedEvaluation(client, id, rows));
  });
}
/** Derive a fixed result solely from the current snapshot after its source leases are held. */
async function recordLeasedEvaluation(client: PmClient, candidate: string, input: unknown): Promise<EvaluationPlanReport> {
  const registered = await readEvaluationPlan(client, candidate); if (registered === null) refuse("eval_plan_missing");
  if (registered.plan.stopping.kind === "sequential") refuse("eval_plan_stopping");
  candidate = registered.plan.candidate;
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
    const current = extractGenerationSpec(String((await readCompleteLoopItem(client, candidate)).item.body), "Locked fixed candidate");
    if (current.evaluation_evidence !== undefined && (current.promoted || (current.policy_evaluation as Record<string, JsonValue> | undefined)?.decision === "refuse")) refuse("eval_plan_stopping", candidate);
    try { await createVerifiedItem(client, { id, type: "Decision", title: "Fixed-stop paired evaluation result", body, unset: ["parent", "sprint", "release", "blocked-by"], clearDeps: true, affectedVersion: hashJson(storedJson(body) as JsonValue), message: "Seal predeclared evaluation evidence" }); }
    catch (error) {
      const winner = await optionalItem(client, id);
      if (winner === null || winner.type !== "Decision" || winner.body !== body || winner.affected_version !== hashJson(storedJson(body) as JsonValue)) throw error;
      await verifyCreatedRecord(client, winner);
    }
  }
  return report;
}
/** Read the same validated decision for enforcement and summaries, returning its actual SDK inputs. */
export async function readEvaluationDecision(client: PmClient, candidate: string, pending = false, prospective?: GetResult["item"]): Promise<{ registered: RegisteredEvaluationPlan | null; report: EvaluationPlanReport | null; evidence: EvaluationEvidence | null }> {
  let projected: GetResult["item"] | undefined;
  const captured = await captureDecisionInputs(client, async () => {
    const registered = await readEvaluationPlan(client, candidate);
    if (registered === null) {
      const item = await optionalItem(client, candidate);
      if (item !== null && item.type === "Generation") {
        const spec = extractGenerationSpec(String(item.body), "Candidate generation");
        if (spec.evaluation_plan !== undefined || spec.evaluation_evidence !== undefined) refuse("eval_plan_missing", evaluationPlanId(item.id));
      }
      if (!pending) await enforceShadowComparison(client, candidate, null);
      return { registered, report: null };
    }
    const resolved = registered.plan.candidate;
    if (pending && await optionalItem(client, resolved) === null) {
      if (registered.plan.stopping.kind === "sequential") await reviewSequentialPlan(client, registered.plan);
      if (prospective !== undefined) {
        const spec = extractGenerationSpec(String(prospective.body), "Prospective candidate generation");
        if (prospective.id !== resolved || prospective.type !== "Generation" || spec.evaluation_plan !== registered.comparison || prospective.affected_version !== hashJson(generationProvenance(spec))) refuse("eval_plan_drift", resolved);
        projected = prospective;
        await verifyTiming(client, registered, spec, projected);
        // No result, look or shadow observation can legitimately predate a new
        // candidate. Read both current and birth state; deleted seals still own
        // their history stream. These absent slots are fenced through creation.
        for (const id of evaluationOutcomeIds(registered.plan, registered.id)) {
          if (await optionalItem(client, id) !== null || await optionalItem(client, id, "1") !== null) refuse("eval_plan_late", id);
        }
      }
      return { registered, report: null };
    }
    await verifiedCandidate(client, resolved, registered);
    if (pending && registered.plan.shadow !== undefined && await optionalItem(client, `${registered.id}-shadow-comparison`) === null) return { registered, report: null };
    await enforceShadowComparison(client, resolved, registered.plan);
    if (registered.plan.stopping.kind === "sequential") {
      const latest = await readSequentialEvaluation(client, resolved);
      if (latest !== null && "status" in latest) refuse("eval_plan_missing", latest.skipped[0]?.id);
      return { registered, report: latest };
    }
    const result = await optionalItem(client, evaluationOutcomeIds(registered.plan, registered.id)[0]);
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
  const inputs = projected === undefined ? captured.inputs : [...captured.inputs, projected];
  const evidence = captured.value.registered === null ? null : evaluationEvidence(captured.value.registered.comparison, inputs);
  const canonicalCandidate = captured.value.registered?.plan.candidate ?? candidate;
  const candidateItem = inputs.find((item) => item.id === canonicalCandidate && item.type === "Generation");
  if (projected === undefined && candidateItem !== undefined && captured.value.registered !== null) await verifyTerminalEvaluationReceipt(client, candidateItem);
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
  if (report.verdict.decision !== "promote") refuse(report.verdict.code === "eval_cohort_samples" || report.verdict.code === "eval_cohort_regression" ? report.verdict.code : "eval_plan_refused");
}
