import { identifierClient, DECISION_INPUT_FIELDS, operationIdentifier } from "./state-boundary.ts";
import { decodeTrackerRecord, parseBoundedJson } from "./tracker-record.ts";
/** Minimized explanations of learned-policy suitability, backed by SDK-certified history. */
import type { GetResult, PmClient } from "@unbrained/pm-cli/sdk/core";
import { createPmCliExpectedError, EXIT_CODE, isPmCliExpectedError } from "@unbrained/pm-cli/sdk/runtime";
import { canonicalJson, createOrReadIdentical, hashJson, extractGenerationSpec, generationProvenance, readCompleteLoopItem, firstDecisionSnapshot, verifyDecisionEvidence, verifyCompletedDecisionReceipt, verifyTerminalEvaluationReceipt, type JsonValue } from "./index.ts";
import { canonicalizeIdentifier, canonicalizeGenerationSpec, type GenerationSpec, type EvaluationEvidence } from "./lineage.ts";
import { readSeries } from "./series.ts";
import { optionalItem, enforceEvaluationPlan, readEvaluationDecision, parseEvaluationEvidence, evaluationInputDigest } from "./evaluation-plan.ts";
import { rethrowOperationalRead, rethrowProvenanceRead } from "./refuse.ts";

/** Stable agent-facing refusal reasons; messages and context include a concrete remedy. */
export type PolicyCardRefusal = "card_missing_provenance" | "card_invalid" | "card_drift" | "card_limit" | "card_not_adoptable";
/** A historical result locator; the digest covers domain content, never titles, authors or raw notes. */
export interface PolicyCardEvidence { readonly id: string; readonly at: string; readonly digest: string }
/** Portable explanation only: it confers no execution, mutation or promotion authority. */
export interface PolicyCard {
  readonly format: "pm-rl/policy-card/1";
  /** Exact graph returned by the decision reader; absent on released legacy cards. */
  readonly decision_evidence?: EvaluationEvidence;
  readonly subject: string;
  readonly selection: number | null;
  readonly policy_digest: string | null;
  readonly proposal_digest: string;
  readonly evaluation: Readonly<Record<string, number | string>>;
  readonly outcome: "seed" | "candidate" | "promoted" | "refused" | "recorded";
  readonly training_scope: { readonly digest: string; readonly collection_runs: number; readonly environment: string; readonly reward: string };
  readonly allowed_actions: readonly ["inspect", "evaluate"];
  readonly known_regressions: readonly ("reward_regression" | "promotion_refused" | "evaluation_incomplete")[];
  readonly resource_limits: Readonly<Record<string, number>>;
  readonly evidence: readonly PolicyCardEvidence[];
  readonly digest: string;
}
/** Maximum exported bytes and direct citations; large trackers remain behind evidence digests. */
export const POLICY_CARD_MAX_BYTES = 4096;
const MAX_EVIDENCE = 32;
const PROSPECTIVE_AT = String(Number.MAX_SAFE_INTEGER);
/** Only projection fields are needed to validate a not-yet-persisted source. */
type CardItem = Pick<GetResult["item"], "id" | "type" | "body" | "affected_version" | "component" | "environment" | "notes" | "created_at" | "tags">;
const SNAPSHOT_FIELDS = DECISION_INPUT_FIELDS;
const LIMIT_KEYS = ["samples", "evaluation_samples", "fit_steps", "training_steps", "wall_ms", "storage_bytes", "compute_units", "tokens", "active_calls", "candidate_calls", "generations", "candidates", "updates", "timeout_ms", "optimizer_updates", "max_optimizer_updates", "fits", "budget"];

/** Refuse without echoing potentially private source values. */
function refuse(code: PolicyCardRefusal, itemId?: string): never {
  const remedy = "Restore complete original provenance and cited history; export a fresh card after evaluation, with explicit resource limits. Keep the incumbent until its normal promotion gates pass." + (code === "card_limit" ? " Cards allow at most 32 direct citations and 4096 bytes; declare a fresh smaller evaluation before collection rather than truncating evidence." : "");
  throw createPmCliExpectedError(`Policy card refused (${code}).${itemId === undefined ? "" : ` Record ${itemId}.`} ${remedy}`, { exitCode: EXIT_CODE.CONFLICT, context: { code, ...(itemId === undefined ? {} : { item_id: itemId }) } });
}
/** Narrow package-owned JSON; malformed evidence never becomes an empty valid record. */
function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) refuse("card_invalid");
  return value as Record<string, unknown>;
}
/** Bound copied identities to tracker identifiers; evidence locators come only from certified history. */
function identity(value: unknown): string {
  try { if (typeof value === "string" && operationIdentifier(value) === value) return value; }
  catch { return refuse("card_invalid"); }
  return refuse("card_invalid");
}
/** Verify the original provenance seal before any canonical identity projection or prospective write. */
function verifiedGenerationSpec(item: CardItem): GenerationSpec {
  const original = extractGenerationSpec(String(item.body), "Card provenance");
  if (item.affected_version !== hashJson(generationProvenance(original))) refuse("card_drift", item.id);
  return original;
}
/** Domain identity excludes presentation and bookkeeping metadata. */
function domain(item: CardItem, prefix: string): JsonValue {
  const generation = item.type === "Generation" ? extractGenerationSpec(String(item.body), "Card content") : null;
  const canonical = generation === null ? null : canonicalizeGenerationSpec(generation, prefix);
  const body = canonical === null ? String(item.body) : canonical as unknown as JsonValue;
  return { id: item.id, type: String(item.type), body, version: canonical === null ? String(item.affected_version) : hashJson(generationProvenance(canonical)),
    ...(item.type === "Run" ? { policy: String(item.component), environment: item.environment ? canonicalizeIdentifier(String(item.environment), prefix) : String(item.environment), metrics: readSeries((item.notes ?? []).map((note) => note.text)).events as unknown as JsonValue } : {}) };
}
/** Read certified content at its first matching immutable version, independent of later tracker activity. */
async function snapshot(client: PmClient, id: string, at?: string): Promise<{ item: GetResult["item"]; citation: PolicyCardEvidence }> {
  id = operationIdentifier(id);
  try {
    const prefix = String((await identifierClient(client).config("project", "get", "id_prefix").catch(rethrowProvenanceRead)).nested_setting!.value);
    id = canonicalizeIdentifier(id, prefix);
    const current = (await readCompleteLoopItem(client, id, at, SNAPSHOT_FIELDS)).item;
    // Validate the requested current/history seal before searching for an equivalent canonical version.
    if (current.type === "Generation") verifiedGenerationSpec(current);
    const digest = hashJson(domain(current, prefix));
    if (at !== undefined) return { item: current, citation: { id: identity(current.id), at, digest } };
    const match = await firstDecisionSnapshot(client, id, (item) => hashJson(domain(item, prefix)) === digest, SNAPSHOT_FIELDS);
    return { item: match.item, citation: { id: identity(match.item.id), at: match.at, digest } };
  } catch (error) {
    if (isPmCliExpectedError(error) && error.context.code === "card_drift") throw error;
    rethrowOperationalRead(error);
    return refuse("card_missing_provenance", id);
  }
}
/** Collect only named numeric allowances; examples, parameters and arbitrary strings are never copied. */
function limits(value: unknown, result: Record<string, number> = {}): Record<string, number> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return result;
  for (const [key, child] of Object.entries(value)) {
    if (LIMIT_KEYS.includes(key) && typeof child === "number" && Number.isSafeInteger(child) && child >= 0) result[key] = Math.max(result[key] ?? 0, child);
    if (["budget", "allowance", "resource_budget", "config", "adapter"].includes(key)) limits(child, result);
  }
  return Object.fromEntries(Object.entries(result).sort(([a], [b]) => a.localeCompare(b)));
}
/** Parse only supported generation or completed durable-step sources. */
function source(item: CardItem, prefix: string): { value: Record<string, unknown>; outcome: PolicyCard["outcome"]; dependencies: string[]; scope: PolicyCard["training_scope"]; regressions: PolicyCard["known_regressions"] } {
  if (item.type === "Generation") {
    const original = verifiedGenerationSpec(item);
    const spec = canonicalizeGenerationSpec(original, prefix);
    const config = spec.training_config !== null && typeof spec.training_config === "object" && !Array.isArray(spec.training_config) ? spec.training_config as Record<string, unknown> : {};
    const judged = spec.policy_evaluation === undefined ? {} : object(spec.policy_evaluation);
    const regression = typeof config.candidate_held_out_mean === "number" && typeof config.incumbent_held_out_mean === "number" &&
      (spec.held_out_score?.direction === "minimize" ? config.candidate_held_out_mean > config.incumbent_held_out_mean : config.candidate_held_out_mean < config.incumbent_held_out_mean);
    return { value: { ...config, policy_card_evaluation: judged }, outcome: spec.seed ? "seed" : spec.promoted ? "promoted" : regression || judged.decision === "refuse" ? "refused" : "candidate",
      dependencies: [...(spec.parent === null ? [] : [spec.parent]), ...spec.collection_runs, ...(spec.environment_version ? [spec.environment_version] : []), ...(spec.approval === null ? [] : [spec.approval]), ...(spec.evaluation_plan === undefined ? [] : [`${item.id}-evaluation-plan`])],
      scope: { digest: hashJson(spec.training_config), collection_runs: spec.collection_runs.length, environment: hashJson(spec.environment_version), reward: hashJson(spec.reward_spec_version) },
      regressions: regression ? ["reward_regression"] : judged.decision === "refuse" ? ["promotion_refused"] : spec.promoted || judged.decision === "promote" ? [] : ["evaluation_incomplete"] };
  }
  if (item.type !== "Decision") return refuse(String(item.body).trim() === "" ? "card_invalid" : "card_missing_provenance");
  if (String(item.body).trimStart().startsWith("{") && !String(item.body).includes('"pm-rl/loop-step/1"')) return refuse("card_missing_provenance");
  const row = decodeTrackerRecord(null, item, { type: "Decision", format: "pm-rl/loop-step/1" });
  if (row === null) return refuse("card_invalid", item.id);
  if (row.state !== "complete" || typeof row.input !== "string" || !/^[a-f0-9]{64}$/.test(row.input) || row.result === null || typeof row.result !== "object" || row.digest !== hashJson(row.result as JsonValue)) refuse("card_missing_provenance");
  const result = object(row.result);
  const receiptInputs = row.decision_evidence === undefined ? [] : parseEvaluationEvidence(row.decision_evidence).inputs.map((input) => input.id);
  const verdict = result.promoted === true || result.promoted !== null && typeof result.promoted === "string" ? "promoted" : result.promoted === false ? "refused" : "recorded";
  return { value: result, outcome: verdict, dependencies: receiptInputs, scope: { digest: hashJson(row.input as JsonValue), collection_runs: 0, environment: hashJson(null), reward: hashJson(null) }, regressions: verdict === "refused" ? ["promotion_refused"] : ["evaluation_incomplete"] };
}
/** Select one proposed recipe/configuration; no policy parameters are copied into a card. */
function proposal(item: CardItem, selection: number | null, prefix: string): unknown {
  const parsed = source(item, prefix);
  if (selection === null) return parsed.value;
  const proposals = parsed.value.configs ?? parsed.value.recipes;
  if (!Number.isSafeInteger(selection) || selection < 0 || !Array.isArray(proposals) || selection >= proposals.length) refuse("card_invalid");
  return proposals[selection];
}
/** Retain bounded numeric diagnostics and the gate's fixed decision vocabulary, never its free text. */
function evaluation(value: unknown): Record<string, number | string> {
  const result: Record<string, number | string> = {};
  if (value === null || typeof value !== "object" || Array.isArray(value)) return result;
  for (const [key, child] of Object.entries(value)) {
    if (["gain", "gain_lower_bound", "margin", "uncertainty", "candidate_held_out_mean", "incumbent_held_out_mean", "candidate_mean", "incumbent_mean", "samples", "independent_units"].includes(key) && typeof child === "number" && Number.isFinite(child)) result[key] = child;
    if (key === "reason_digest" && typeof child === "string" && /^[a-f0-9]{64}$/.test(child)) result.reason_digest = child;
    if (key === "decision" && (child === "promote" || child === "refuse")) result.decision = child;
    if (["meta", "verdict", "trial", "outcome", "policy_card_evaluation"].includes(key)) Object.assign(result, evaluation(child));
  }
  return result;
}
/** Locate a declared content-addressed policy, excluding evaluation diagnostics and proposal-only recipe hashes. */
function artifactIdentity(value: unknown, configuration: unknown = null): JsonValue | null {
  if (typeof value === "string") return /^sha256:[a-f0-9]{64}$/.test(value) ? { artifact: value, configuration: configuration as JsonValue } : null;
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const config = row.recipe ?? row.config ?? row.training_config ?? configuration;
  for (const key of ["checkpoint", "candidate", "successor", "policy", "retained", "incumbent", "digest"]) {
    const found = artifactIdentity(row[key], config);
    if (found !== null) return found;
  }
  return null;
}
/** Assemble the same whitelist for export and replay, rejecting oversized cards instead of truncating citations. */
function assemble(subject: string, item: CardItem, evidence: readonly PolicyCardEvidence[], extraLimits: Readonly<Record<string, number>>, selection: number | null, prefix: string, decisionGraph?: EvaluationEvidence): PolicyCard {
  const parsed = source(item, prefix);
  const selected = proposal(item, selection, prefix);
  const policy = item.type === "Generation" ? extractGenerationSpec(String(item.body), "Policy identity") : null;
  const policyIdentity = policy === null ? selection === null ? artifactIdentity(selected) : null
    : [policy.base_checkpoint, policy.policy].filter(Boolean).every((reference) => /^sha256:[a-f0-9]{64}$/.test(reference)) ? { checkpoint: policy.base_checkpoint, policy: policy.policy, configuration: policy.training_config } : null;
  const body = { ...(decisionGraph === undefined ? {} : { decision_evidence: decisionGraph }), format: "pm-rl/policy-card/1" as const, subject, selection, policy_digest: policyIdentity === null ? null : hashJson(policyIdentity), proposal_digest: hashJson(selected as JsonValue), evaluation: evaluation(parsed.value), outcome: parsed.outcome, training_scope: parsed.scope, allowed_actions: ["inspect", "evaluate"] as const,
    known_regressions: parsed.regressions, resource_limits: { ...limits(parsed.value), ...extraLimits }, evidence };
  const card = { ...body, digest: hashJson(body as unknown as JsonValue) };
  if (Buffer.byteLength(canonicalJson(card as unknown as JsonValue)) > POLICY_CARD_MAX_BYTES) refuse("card_limit");
  return card;
}
/** Verify retained explanations and their live evidence at every canonical ancestor through the seed. */
async function verifyCardAncestry(client: PmClient, leaf: string): Promise<void> {
  const visited = new Set<string>();
  let current: string | null = leaf;
  while (current !== null) {
    const fresh = await exportPolicyCard(client, current);
    if (visited.has(fresh.subject)) refuse("card_missing_provenance");
    visited.add(fresh.subject);
    if (fresh.policy_digest === null) refuse("card_missing_provenance");
    const retained = await snapshot(client, `policy-card-${fresh.digest}`);
    if (retained.item.type !== "Decision" || retained.item.affected_version !== fresh.digest || retained.item.body !== canonicalJson(fresh as unknown as JsonValue)) refuse("card_drift");
    await replayPolicyCard(client, parseBoundedJson(String(retained.item.body)));
    const generation = (await snapshot(client, fresh.subject)).item;
    const spec = extractGenerationSpec(String(generation.body), "Policy ancestry");
    if (!spec.seed) {
      if (!spec.promoted) refuse("card_missing_provenance");
      await enforceEvaluationPlan(client, fresh.subject, spec.held_out_score!);
    }
    current = spec.parent;
  }
}
/** Extract numeric limits from JSON or a package JSON fence, never free text. */
function bodyLimits(item: CardItem): Record<string, number> {
  try { return limits(parseBoundedJson(String(item.body).replace(/^[\s\S]*?```json\n([\s\S]*?)\n```[\s\S]*$/, "$1"))); }
  catch { return {}; }
}
/** Plans and comparison receipts do not declare allowances; only the pinned shadow deployment does. */
function evidenceLimits(subject: string, item: CardItem): Record<string, number> {
  const plan = `${subject}-evaluation-plan`;
  return [plan, `${plan}-result`, `${plan}-shadow-comparison`].includes(item.id) ? {} : bodyLimits(item);
}
/** Export an explanation without modifying any tracker. Missing referenced records fail closed. */
export async function exportPolicyCard(client: PmClient, subject: string, selection: number | null = null): Promise<PolicyCard> {
  return exportSnapshotCard(client, await snapshot(client, subject), selection);
}
/** Validate the complete prospective outcome before promotion consumes budget or changes history. */
export async function validatePromotedPolicyCard(client: PmClient, subject: string, body: string): Promise<void> {
  const primary = await snapshot(client, subject);
  // Outcome fields change fixed-width evidence digests and bounded version coordinates.
  // Assemble with the new body so approval citations, limits and verdict size are included.
  await exportSnapshotCard(client, { ...primary, citation: { ...primary.citation, at: PROSPECTIVE_AT }, item: { ...primary.item, body } }, null);
}
/** Validate a sealed rejection outcome before changing the generation body or any history. @internal */
export async function validateRefusedPolicyCard(client: PmClient, subject: string, verdict: JsonValue): Promise<string> {
  const primary = await snapshot(client, subject);
  const spec = extractGenerationSpec(String(primary.item.body), "Rejected generation");
  const decision = await readEvaluationDecision(client, subject, true);
  const body = `\`\`\`json\n${JSON.stringify({ ...spec, ...(decision.evidence === null ? {} : { evaluation_evidence: decision.evidence }), policy_evaluation: verdict })}\n\`\`\``;
  await exportSnapshotCard(client, { ...primary, citation: { ...primary.citation, at: PROSPECTIVE_AT }, item: { ...primary.item, body } }, null);
  return body;
}
/** Share the bounded projection between certified exports and pre-commit outcome validation. */
async function exportSnapshotCard(client: PmClient, primary: { item: CardItem; citation: PolicyCardEvidence }, selection: number | null): Promise<PolicyCard> {
  const { evidence, resource, prefix, decisionGraph } = await generationEvidence(client, primary.citation.id, primary);
  return assemble(primary.citation.id, primary.item, evidence, resource, selection, prefix, decisionGraph);
}
/** Define the complete generation evidence set once for card identity and loop resume: citations, Runs and decoded metric notes. @internal */
export async function generationEvidence(client: PmClient, subject: string, selected?: { item: CardItem; citation: PolicyCardEvidence }): Promise<{ primary: CardItem; evidence: PolicyCardEvidence[]; entries: CardItem[]; resource: Record<string, number>; prefix: string; decisionGraph?: EvaluationEvidence }> {
  const prefix = String((await identifierClient(client).config("project", "get", "id_prefix")).nested_setting!.value);
  subject = canonicalizeIdentifier(subject, prefix);
  const primary = selected ?? await snapshot(client, subject);
  const parsed = source(primary.item, prefix);
  if (new Set(parsed.dependencies).size >= MAX_EVIDENCE) refuse("card_limit");
  const evidence = [primary.citation]; const entries: CardItem[] = []; const resource: Record<string, number> = {};
  const plan = primary.item.type === "Generation" && !extractGenerationSpec(String(primary.item.body), "Decision discovery").seed ? await optionalItem(client, `${subject}-evaluation-plan`) : null;
  const decision = await cardDecisionInputs(client, primary.item, plan, primary.citation.at === PROSPECTIVE_AT);
  const dependencies = [...parsed.dependencies, ...decision.ids].filter((id) => id !== primary.item.id || parsed.dependencies.includes(id));
  if (dependencies.includes(primary.item.id)) refuse("card_missing_provenance");
  if (new Set(dependencies).size >= MAX_EVIDENCE) refuse("card_limit");
  for (const id of [...new Set(dependencies)].sort()) {
    const entry = await snapshot(client, id); evidence.push(entry.citation); entries.push(entry.item);
  }
  for (const item of entries) {
    if (item.type !== "Generation") continue;
    const upstream = extractGenerationSpec(String(item.body), "Cited decision evidence").evaluation_evidence;
    if (upstream !== undefined) await verifyDecisionEvidence(client, upstream);
  }
  verifyDecisionBindings(primary.item, entries, decision.graph);
  await verifyEvidenceBindings(client, primary.item, entries, decision);
  for (const entry of entries) Object.assign(resource, evidenceLimits(subject, entry));
  return { primary: primary.item, evidence, entries, resource, prefix, decisionGraph: decision.graph };
}
/** Reuse actual evaluator reads; legacy explanatory records without a versioned plan remain inspectable. */
async function cardDecisionInputs(client: PmClient, item: CardItem, plan: GetResult["item"] | CardItem | null, prospective = false): Promise<{ ids: string[]; graph?: EvaluationEvidence }> {
  if (item.type === "Decision") {
    const raw = object(parseBoundedJson(String(item.body)));
    await verifyCompletedDecisionReceipt(client, item.id, raw, prospective);
    if (raw.decision_evidence === undefined) return { ids: [] };
    const evidence = parseEvaluationEvidence(raw.decision_evidence);
    await verifyDecisionEvidence(client, evidence);
    if (evidence.comparison !== raw.input) refuse("card_drift", item.id);
    return { ids: evidence.inputs.map((input) => input.id), graph: evidence };
  }
  const spec = extractGenerationSpec(String(item.body), "Card decision inputs");
  const retained = spec.evaluation_evidence;
  const versioned = plan === null ? null : decodeTrackerRecord(spec.evaluation_plan === undefined ? client : null, plan, { type: "Plan", maxBytes: 16_777_216, valid: (row) => row.plan !== null && typeof row.plan === "object" && !Array.isArray(row.plan) && (row.plan as Record<string, unknown>).format === "pm-rl/evaluation-plan/1" });
  if (retained !== undefined || versioned !== null) {
    try {
      const decision = await readEvaluationDecision(client, item.id, true);
      if (retained !== undefined && retained.digest !== decision.evidence?.digest) refuse("card_drift", item.id);
      return { ids: decision.evidence!.inputs.map((input) => input.id).filter((id) => id !== item.id), graph: decision.evidence! };
    } catch (error) {
      rethrowOperationalRead(error);
      refuse("card_drift", isPmCliExpectedError(error) ? String(error.context.item_id ?? item.id) : item.id);
    }
  }
  if (spec.evaluation_plan === undefined) return { ids: [] };
  if (!prospective && plan !== null) await verifyTerminalEvaluationReceipt(client, item);
  const ids: string[] = [];
  if (plan !== null) for (const suffix of ["-result", "-shadow", "-shadow-comparison"]) {
    const found = await optionalItem(client, `${plan.id}${suffix}`); if (found !== null) ids.push(found.id);
  }
  return { ids };
}
/** Every embedded graph input must match the exact SDK snapshot cited by this card. */
function verifyDecisionBindings(primary: CardItem, entries: readonly CardItem[], graph?: EvaluationEvidence): void {
  if (graph === undefined) return;
  const sources = new Map([primary, ...entries].map((item) => [item.id, item]));
  for (const input of graph.inputs) {
    const item = sources.get(input.id);
    if (item === undefined || evaluationInputDigest(item, graph.comparison) !== input.digest) refuse("card_drift", input.id);
  }
}
/** Match complete fixed record fields before a foreign shape can reach evidence replay. */
function fields(row: Record<string, unknown>, expected: string): boolean { return Object.keys(row).sort().join(",") === expected; }
/** Recognize a bounded content digest without coercing foreign values. */
function digestShape(value: unknown): boolean { return typeof value === "string" && /^[a-f0-9]{64}$/.test(value); }
/** Validate the complete portable envelope; semantic evidence drift remains a separate provenance refusal. */
function cardShape(row: Record<string, unknown>): boolean {
  if (!fields(row, `${row.decision_evidence === undefined ? "" : "decision_evidence,"}allowed_actions,digest,evaluation,evidence,format,known_regressions,outcome,policy_digest,proposal_digest,resource_limits,selection,subject,training_scope`.split(",").sort().join(",")) || encodedSize(row) > POLICY_CARD_MAX_BYTES) return false;
  if (row.decision_evidence !== undefined) parseEvaluationEvidence(row.decision_evidence);
  identity(row.subject);
  if (row.selection !== null && (!Number.isSafeInteger(row.selection) || Number(row.selection) < 0 || Number(row.selection) >= MAX_EVIDENCE)) return false;
  if (!digestShape(row.digest) || !digestShape(row.proposal_digest) || row.policy_digest !== null && !digestShape(row.policy_digest)) return false;
  if (!["seed", "candidate", "promoted", "refused", "recorded"].includes(String(row.outcome))) return false;
  if (!Array.isArray(row.allowed_actions) || row.allowed_actions.join(",") !== "inspect,evaluate" || !Array.isArray(row.known_regressions)
    || row.known_regressions.some((entry) => !["reward_regression", "promotion_refused", "evaluation_incomplete"].includes(String(entry)))) return false;
  const scope = object(row.training_scope);
  if (!fields(scope, "collection_runs,digest,environment,reward") || !digestShape(scope.digest) || !digestShape(scope.environment) || !digestShape(scope.reward)
    || !Number.isSafeInteger(scope.collection_runs) || Number(scope.collection_runs) < 0) return false;
  for (const [key, value] of Object.entries(object(row.resource_limits))) if (!LIMIT_KEYS.includes(key) || !Number.isSafeInteger(value) || Number(value) < 0) return false;
  for (const [key, value] of Object.entries(object(row.evaluation))) {
    if (key === "decision") { if (value !== "promote" && value !== "refuse") return false; }
    else if (key === "reason_digest") { if (!digestShape(value)) return false; }
    else if (!["gain", "gain_lower_bound", "margin", "uncertainty", "candidate_held_out_mean", "incumbent_held_out_mean", "candidate_mean", "incumbent_mean", "samples", "independent_units"].includes(key) || typeof value !== "number" || !Number.isFinite(value)) return false;
  }
  if (!Array.isArray(row.evidence) || row.evidence.length === 0 || row.evidence.length > MAX_EVIDENCE) return false;
  for (const citation of row.evidence) {
    const ref = object(citation); identity(ref.id);
    if (!fields(ref, "at,digest,id") || typeof ref.at !== "string" || !/^[1-9][0-9]*$/.test(ref.at) || !digestShape(ref.digest)) return false;
  }
  return true;
}
/** Discover supported cards using type, tag and version before parsing unrelated tracker bodies. */
export async function discoverPolicyCards(client: PmClient): Promise<PolicyCard[]> {
  const listed = await identifierClient(client).listAllComplete({ includeBody: true });
  const retained: PolicyCard[] = [];
  const prefix = String((await identifierClient(client).config("project", "get", "id_prefix")).nested_setting!.value);
  for (const item of listed.items) {
    if (!item.tags?.includes("rl-policy-card") && !/(?:^|-)policy-card-/.test(item.id)) continue;
    const record = decodeTrackerRecord(client, item, { type: "Decision", tag: "rl-policy-card", format: "pm-rl/policy-card/1", valid: (row) => {
      if (!cardShape(row)) return false;
      const { digest, ...body } = row;
      return item.id === canonicalizeIdentifier(`policy-card-${digest}`, prefix) && item.affected_version === digest && hashJson(body as JsonValue) === digest;
    } });
    if (record !== null) retained.push(record as unknown as PolicyCard);
  }
  return retained;
}
/** Compare the same evidence with the last retained outcome before a resumed generation advances. @internal */
export async function verifyRetainedGenerationEvidence(client: PmClient, subject: string): Promise<void> {
  const fresh = await generationEvidence(client, subject);
  subject = canonicalizeIdentifier(subject, fresh.prefix);
  const retained = (await discoverPolicyCards(client)).filter((card) => card.subject === subject);
  if (retained.length === 0) return;
  for (const card of retained) await replayPolicyCard(client, card);
  const outcome = source(fresh.primary, fresh.prefix).outcome;
  const terminal = retained.some((card) => card.outcome === "promoted" || card.outcome === "refused");
  if (terminal && ["candidate", "seed"].includes(outcome)) throw createPmCliExpectedError("A retained terminal promotion cannot be replayed as an unfinished step.", { exitCode: EXIT_CODE.CONFLICT, context: { code: "loop_step_drift" } });
  const exact = retained.find((card) => canonicalJson(card.evidence as unknown as JsonValue) === canonicalJson(fresh.evidence as unknown as JsonValue));
  // An interrupted promotion may only have its pre-promotion card; verify every shared citation before repairing publication.
  const previous = exact ?? retained.find((card) => card.outcome === "candidate") ?? retained[retained.length - 1];
  const historical = exact === undefined ? await snapshot(client, subject, previous.evidence[0].at) : null;
  const transition = historical !== null && previous.outcome === "candidate" && ["promoted", "refused"].includes(source(fresh.primary, fresh.prefix).outcome)
    && !terminal
    && hashJson(generationProvenance(canonicalizeGenerationSpec(extractGenerationSpec(String(historical.item.body), "Retained candidate"), fresh.prefix))) === hashJson(generationProvenance(canonicalizeGenerationSpec(extractGenerationSpec(String(fresh.primary.body), "Current outcome"), fresh.prefix)));
  const current = new Map(fresh.evidence.map((entry) => [entry.id, entry.digest]));
  if ((exact === undefined && !transition) || previous.evidence.some((entry, index) => (exact !== undefined || index > 0) && current.get(entry.id) !== entry.digest)) {
    throw createPmCliExpectedError("Generation evidence changed since its retained policy card; restore the certified evidence before resuming.", { exitCode: EXIT_CODE.CONFLICT, context: { code: "loop_generation_drift" } });
  }
}
/** Require a closed citation graph rooted in the certified subject, never caller-added allowances. */
async function verifyEvidenceBindings(client: PmClient, item: CardItem, entries: readonly CardItem[], decision?: { ids: string[]; graph?: EvaluationEvidence }): Promise<void> {
  const ids = entries.map((entry) => entry.id);
  const prefix = String((await identifierClient(client).config("project", "get", "id_prefix")).nested_setting!.value);
  const required = [...source(item, prefix).dependencies, ...(decision?.ids ?? [])].filter((id) => id !== item.id);
  if (required.some((id) => !ids.includes(id))) refuse("card_missing_provenance");
  const plan = `${item.id}-evaluation-plan`;
  const allowed = new Set([...required, ...(required.includes(plan) ? ["-result", "-shadow", "-shadow-comparison"].map((suffix) => `${plan}${suffix}`) : [])]);
  if (ids.some((id) => !allowed.has(id))) refuse("card_invalid");
  const planItem = entries.find((entry) => entry.id === plan);
  if (planItem !== undefined && decision?.graph === undefined) {
    // Versioned plans were validated by the actual decision reader; legacy explanatory records retain their historical contract.
    const spec = canonicalizeGenerationSpec(extractGenerationSpec(String(item.body), "Card lineage"), prefix);
    const reservation = evidenceBody(planItem); const declared = object(reservation.plan);
    if (Object.keys(reservation).sort().join(",") !== "incumbent_version,plan" || planItem.type !== "Plan" || canonicalizeIdentifier(String(declared.candidate), prefix) !== item.id || canonicalizeIdentifier(String(declared.incumbent), prefix) !== spec.parent || declared.incumbent_version !== reservation.incumbent_version || hashJson(declared as JsonValue) !== spec.evaluation_plan || planItem.affected_version !== hashJson({ comparison: spec.evaluation_plan, incumbent_version: reservation.incumbent_version } as JsonValue)) refuse("card_drift");
    for (const entry of entries.filter((entry) => ["-result", "-shadow", "-shadow-comparison"].some((suffix) => entry.id === `${plan}${suffix}`))) {
      const body = evidenceBody(entry);
      if (entry.type !== "Decision") refuse("card_drift");
      if (entry.id === `${plan}-shadow`) {
        if (canonicalizeIdentifier(String(body.generation), prefix) !== item.id || hashJson(body as JsonValue) !== declared.shadow || entry.affected_version !== declared.shadow) refuse("card_drift");
      } else {
        const comparison = entry.id === `${plan}-result` ? spec.evaluation_plan : declared.shadow;
        if (typeof comparison !== "string" || body.comparison !== comparison) refuse("card_drift");
      }
    }
  }
}
/** Decode structured lineage bindings without exposing arbitrary evidence text. */
function evidenceBody(item: CardItem): Record<string, unknown> {
  try { return object(parseBoundedJson(String(item.body))); }
  catch { return refuse("card_drift", item.id); }
}
/** Validate every bounded projection before creating a source or changing its history. @internal */
export async function validatePolicyCardWrite(client: PmClient, options: Parameters<PmClient["create"]>[0] & { id: string }, recursive = false): Promise<void> {
  const prefix = String((await identifierClient(client).config("project", "get", "id_prefix")).nested_setting!.value);
  const item: CardItem = { id: identity(canonicalizeIdentifier(options.id, prefix)), type: options.type!, body: options.body ?? "", affected_version: options.affectedVersion ?? "", component: options.component ?? "", environment: options.environment ?? "" };
  const primary = { item, citation: { id: item.id, at: PROSPECTIVE_AT, digest: hashJson(domain(item, prefix)) } };
  await exportSnapshotCard(client, primary, null);
  if (recursive) {
    const value = source(item, prefix).value;
    const proposals = value.configs ?? value.recipes;
    if (Array.isArray(proposals)) {
      if (proposals.length > MAX_EVIDENCE) refuse("card_limit");
      for (let index = 0; index < proposals.length; index += 1) await exportSnapshotCard(client, primary, index);
    }
  }
}
/** Reject non-JSON SDK input with the same typed contract as malformed CLI JSON. */
function encodedSize(value: Record<string, unknown>): number {
  try { return Buffer.byteLength(JSON.stringify(value)); }
  catch { return refuse("card_invalid"); }
}
/** Replay every citation at its exact historical coordinate, recomputing the minimized explanation. */
export async function replayPolicyCard(client: PmClient, value: unknown): Promise<{ card: PolicyCard; results: readonly PolicyCardEvidence[] }> {
  const candidate = object(value);
  if (encodedSize(candidate) > POLICY_CARD_MAX_BYTES) refuse("card_limit");
  const supplied = candidate.decision_evidence === undefined ? undefined : parseEvaluationEvidence(candidate.decision_evidence);
  const prefix = String((await identifierClient(client).config("project", "get", "id_prefix")).nested_setting!.value);
  const subject = canonicalizeIdentifier(identity(candidate.subject), prefix);
  const selection = candidate.selection;
  if (selection !== null && typeof selection !== "number") refuse("card_invalid");
  if (!Array.isArray(candidate.evidence) || candidate.evidence.length === 0) refuse("card_missing_provenance");
  if (candidate.evidence.length > MAX_EVIDENCE) refuse("card_limit");
  const results: PolicyCardEvidence[] = []; const items: GetResult["item"][] = []; const resource: Record<string, number> = {};
  for (const value of candidate.evidence) {
    const ref = object(value);
    if (typeof ref.at !== "string") refuse("card_invalid");
    const entry = await snapshot(client, identity(ref.id), ref.at);
    if (entry.citation.digest !== ref.digest) refuse("card_drift");
    results.push(entry.citation); items.push(entry.item);
  }
  if (results[0].id !== subject || new Set(results.map((row) => row.id)).size !== results.length) refuse("card_invalid");
  const storedGraph = items[0].type === "Generation" ? extractGenerationSpec(String(items[0].body), "Replayed receipt").evaluation_evidence : object(parseBoundedJson(String(items[0].body))).decision_evidence;
  const planItem = items.slice(1).find((item) => item.id === `${subject}-evaluation-plan`);
  const declared = planItem === undefined ? null : evidenceBody(planItem).plan;
  const sequential = declared !== null && typeof declared === "object" && (declared as Record<string, unknown>).stopping !== null && typeof (declared as Record<string, unknown>).stopping === "object" && ((declared as Record<string, unknown>).stopping as Record<string, unknown>).kind === "sequential";
  if (supplied === undefined && (storedGraph !== undefined || sequential)) refuse("card_drift", subject);
  if (candidate.decision_evidence !== undefined && items[0].type === "Decision" && (await snapshot(client, subject)).citation.digest !== results[0].digest) refuse("card_drift", subject);
  const decision = candidate.decision_evidence === undefined ? undefined : await cardDecisionInputs(client, items[0], items.slice(1).find((item) => item.id === `${subject}-evaluation-plan`) ?? null);
  if (decision !== undefined && canonicalJson(decision.graph as unknown as JsonValue) !== canonicalJson(supplied as unknown as JsonValue)) refuse("card_drift", subject);
  for (const item of items.slice(1)) {
    if (item.type !== "Generation") continue;
    const upstream = extractGenerationSpec(String(item.body), "Replayed upstream evidence").evaluation_evidence;
    if (upstream !== undefined) await verifyDecisionEvidence(client, upstream);
  }
  verifyDecisionBindings(items[0], items.slice(1), decision?.graph);
  await verifyEvidenceBindings(client, items[0], items.slice(1), decision);
  for (const item of items.slice(1)) Object.assign(resource, evidenceLimits(subject, item));
  const card = assemble(subject, items[0], [results[0], ...results.slice(1).sort((left, right) => left.id.localeCompare(right.id))], resource, selection, prefix, decision?.graph);
  if (canonicalJson(candidate as JsonValue) !== canonicalJson(card as unknown as JsonValue)) refuse("card_drift");
  return { card, results };
}
/** Check suitability against current provenance; normal backend consent and promotion gates still apply. */
export async function adoptPolicyCard(client: PmClient, value: unknown): Promise<PolicyCard> {
  const { card } = await replayPolicyCard(client, value);
  const fresh = await exportPolicyCard(client, card.subject, card.selection);
  if (fresh.digest !== card.digest) refuse("card_drift");
  const item = (await readCompleteLoopItem(client, card.subject)).item;
  if (item.type === "Generation") {
    const spec = extractGenerationSpec(String(item.body), "Policy adoption");
    if (spec.held_out_score === null || spec.proxy_score === null || spec.parent === null || spec.collection_runs.length === 0 || !spec.environment_version || !spec.reward_spec_version) refuse("card_missing_provenance");
    await enforceEvaluationPlan(client, card.subject, spec.held_out_score);
  }
  if (card.outcome !== "promoted" || card.known_regressions.length > 0 || item.type !== "Generation" || Object.keys(card.resource_limits).length === 0) refuse("card_not_adoptable");
  await verifyCardAncestry(client, card.subject);
  return card;
}
/** Retain immutable outcome cards with the candidate; retries verify the winner rather than overwriting it. */
export async function recordPolicyCard(client: PmClient, subject: string, selection: number | null = null): Promise<PolicyCard> {
  const card = await exportPolicyCard(client, subject, selection);
  await persistPolicyCard(client, card);
  return card;
}
/** Publish an already validated projection without re-reading a changing source. */
async function persistPolicyCard(client: PmClient, card: PolicyCard): Promise<void> {
  const id = `policy-card-${card.digest}`; const subject = card.subject;
  const body = canonicalJson(card as unknown as JsonValue);
  await createOrReadIdentical(client, { id, type: "Decision", title: "Portable policy explanation", tags: "rl-policy-card", body, affectedVersion: card.digest, dep: [subject] }, "card_drift", (item) => {
    if (item.body !== body || item.affected_version !== card.digest) refuse("card_drift");
    return true;
  });
}
/** Publish a separate explanation for each proposed candidate as well as the shared phase outcome. */
export async function recordRecursivePolicyCards(client: PmClient, subject: string): Promise<void> {
  const prefix = String((await identifierClient(client).config("project", "get", "id_prefix")).nested_setting!.value);
  const item = (await readCompleteLoopItem(client, subject)).item;
  const value = source(item, prefix).value;
  const proposals = value.configs ?? value.recipes;
  if (Array.isArray(proposals) && proposals.length > MAX_EVIDENCE) refuse("card_limit");
  const cards = [await exportPolicyCard(client, subject)];
  if (Array.isArray(proposals)) for (let index = 0; index < proposals.length; index += 1) cards.push(await exportPolicyCard(client, subject, index));
  // Validate all known publication collisions before the first batch write.
  for (const card of cards) {
    const existing = await optionalItem(client, `policy-card-${card.digest}`);
    if (existing !== null && (existing.type !== "Decision" || existing.body !== canonicalJson(card as unknown as JsonValue) || existing.affected_version !== card.digest)) refuse("card_drift");
  }
  for (const card of cards) await persistPolicyCard(client, card);
}
