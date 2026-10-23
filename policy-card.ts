/** Minimized explanations of learned-policy suitability, backed by SDK-certified history. */
import type { GetResult, PmClient } from "@unbrained/pm-cli/sdk/core";
import { createPmCliExpectedError, EXIT_CODE, normalizeItemId } from "@unbrained/pm-cli/sdk/runtime";
import { canonicalJson, createOrReadIdentical, hashJson, extractGenerationSpec, generationProvenance, readCompleteLoopItem, type JsonValue } from "./index.ts";
import { optionalItem, enforceEvaluationPlan } from "./evaluation-plan.ts";

/** Stable agent-facing refusal reasons; messages and context include a concrete remedy. */
export type PolicyCardRefusal = "card_missing_provenance" | "card_invalid" | "card_drift" | "card_limit" | "card_not_adoptable";
/** A historical result locator; the digest covers domain content, never titles, authors or raw notes. */
export interface PolicyCardEvidence { readonly id: string; readonly at: string; readonly digest: string }
/** Portable explanation only: it confers no execution, mutation or promotion authority. */
export interface PolicyCard {
  readonly format: "pm-rl/policy-card/1";
  readonly subject: string;
  readonly selection: number | null;
  readonly policy_digest: string;
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
const SNAPSHOT_FIELDS = "id,type,body,affected_version,fixed_version,component,environment,parent,status,updated_at,notes";
const EVALUATION_NOTE = "pm-rl/policy-evaluation/1 ";
const LIMIT_KEYS = ["samples", "evaluation_samples", "fit_steps", "training_steps", "wall_ms", "storage_bytes", "compute_units", "tokens", "active_calls", "candidate_calls", "generations", "candidates", "updates", "timeout_ms", "optimizer_updates", "max_optimizer_updates", "fits", "budget"];

/** Refuse without echoing potentially private source values. */
function refuse(code: PolicyCardRefusal): never {
  const remedy = "Restore complete original provenance and cited history; export a fresh card after evaluation, with explicit resource limits. Keep the incumbent until its normal promotion gates pass.";
  throw createPmCliExpectedError(`Policy card refused (${code}). ${remedy}`, { exitCode: EXIT_CODE.CONFLICT, context: { code } });
}
/** Narrow package-owned JSON; malformed evidence never becomes an empty valid record. */
function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) refuse("card_invalid");
  return value as Record<string, unknown>;
}
/** Bound the only exported source strings to tracker identifiers and historical timestamps. */
function identity(value: unknown): string {
  if (typeof value !== "string" || !/^[a-z0-9][a-z0-9-]{0,255}$/i.test(value)) refuse("card_invalid");
  return value;
}
/** Domain identity excludes presentation and bookkeeping metadata. */
function domain(item: GetResult["item"]): JsonValue {
  return { type: String(item.type), body: String(item.body), version: String(item.affected_version), checkpoint: String(item.fixed_version), policy: String(item.component), environment: String(item.environment), parent: String(item.parent), status: String(item.status), evaluation: item.notes!.filter((note) => note.text.startsWith(EVALUATION_NOTE)).map((note) => note.text) };
}
/** Read exact evidence and verify that the current materialized record matches certified history. */
async function snapshot(client: PmClient, id: string, at?: string): Promise<{ item: GetResult["item"]; citation: PolicyCardEvidence }> {
  identity(id);
  try {
    const current = (await readCompleteLoopItem(client, id, at, SNAPSHOT_FIELDS)).item;
    const original = await readCompleteLoopItem(client, id, "1", SNAPSHOT_FIELDS);
    const timestamp = at ?? (hashJson(domain(current)) === hashJson(domain(original.item)) ? String(original.as_of_timestamp) : String(current.updated_at));
    const historical = (await readCompleteLoopItem(client, id, timestamp, SNAPSHOT_FIELDS)).item;
    if (hashJson(domain(current)) !== hashJson(domain(historical))) refuse("card_drift");
    return { item: historical, citation: { id: identity(historical.id), at: timestamp, digest: hashJson(domain(historical)) } };
  } catch { return refuse("card_missing_provenance"); }
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
function source(item: GetResult["item"]): { value: Record<string, unknown>; outcome: PolicyCard["outcome"]; dependencies: string[]; scope: PolicyCard["training_scope"]; regressions: PolicyCard["known_regressions"] } {
  if (item.type === "Generation") {
    const spec = extractGenerationSpec(String(item.body), "Policy card generation");
    if (item.affected_version !== hashJson(generationProvenance(spec))) refuse("card_drift");
    const config = spec.training_config !== null && typeof spec.training_config === "object" && !Array.isArray(spec.training_config) ? spec.training_config as Record<string, unknown> : {};
    const notes = (item.notes ?? []).filter((note) => note.text.startsWith(EVALUATION_NOTE));
    let judged: Record<string, unknown> = {};
    if (notes.length > 0) {
      try { judged = object(JSON.parse(notes.at(-1)!.text.slice(EVALUATION_NOTE.length))); }
      catch { return refuse("card_invalid"); }
    }
    const regression = typeof config.candidate_held_out_mean === "number" && typeof config.incumbent_held_out_mean === "number" && config.candidate_held_out_mean < config.incumbent_held_out_mean;
    return { value: { ...config, policy_card_evaluation: judged }, outcome: spec.seed ? "seed" : spec.promoted ? "promoted" : regression || judged.decision === "refuse" ? "refused" : "candidate",
      dependencies: [...(spec.parent === null ? [] : [spec.parent]), ...spec.collection_runs, ...(spec.environment_version ? [spec.environment_version] : []), ...(spec.approval === null ? [] : [spec.approval]), ...(spec.evaluation_plan === undefined ? [] : [`${item.id}-evaluation-plan`])],
      scope: { digest: hashJson(spec.training_config), collection_runs: spec.collection_runs.length, environment: hashJson(spec.environment_version), reward: hashJson(spec.reward_spec_version) },
      regressions: regression ? ["reward_regression"] : judged.decision === "refuse" ? ["promotion_refused"] : spec.promoted || judged.decision === "promote" ? [] : ["evaluation_incomplete"] };
  }
  let row: Record<string, unknown>;
  try { row = object(JSON.parse(String(item.body))); } catch { return refuse("card_invalid"); }
  if (item.type !== "Decision" || row.format !== "pm-rl/loop-step/1" || row.state !== "complete" || typeof row.input !== "string" || !/^[a-f0-9]{64}$/.test(row.input) || row.result === null || typeof row.result !== "object" || row.digest !== hashJson(row.result as JsonValue)) refuse("card_missing_provenance");
  const result = object(row.result);
  const verdict = result.promoted === true || result.promoted !== null && typeof result.promoted === "string" ? "promoted" : result.promoted === false ? "refused" : "recorded";
  return { value: result, outcome: verdict, dependencies: [], scope: { digest: hashJson(row.input as JsonValue), collection_runs: 0, environment: hashJson(null), reward: hashJson(null) }, regressions: verdict === "refused" ? ["promotion_refused"] : ["evaluation_incomplete"] };
}
/** Select one proposed recipe/configuration; no policy parameters are copied into a card. */
function proposal(item: GetResult["item"], selection: number | null): unknown {
  const parsed = source(item);
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
/** Assemble the same whitelist for export and replay, rejecting oversized cards instead of truncating citations. */
function assemble(subject: string, item: GetResult["item"], evidence: readonly PolicyCardEvidence[], extraLimits: Readonly<Record<string, number>>, selection: number | null): PolicyCard {
  const parsed = source(item);
  const body = { format: "pm-rl/policy-card/1" as const, subject, selection, policy_digest: hashJson(proposal(item, selection) as JsonValue), evaluation: evaluation(parsed.value), outcome: parsed.outcome, training_scope: parsed.scope, allowed_actions: ["inspect", "evaluate"] as const,
    known_regressions: parsed.regressions, resource_limits: { ...limits(parsed.value), ...extraLimits }, evidence };
  const card = { ...body, digest: hashJson(body as unknown as JsonValue) };
  if (Buffer.byteLength(canonicalJson(card as unknown as JsonValue)) > POLICY_CARD_MAX_BYTES) refuse("card_limit");
  return card;
}
/** Extract numeric limits from JSON or a package JSON fence, never free text. */
function bodyLimits(item: GetResult["item"]): Record<string, number> {
  try { return limits(JSON.parse(String(item.body).replace(/^[\s\S]*?```json\n([\s\S]*?)\n```[\s\S]*$/, "$1"))); }
  catch { return {}; }
}
/** Export an explanation without modifying any tracker. Missing referenced records fail closed. */
export async function exportPolicyCard(client: PmClient, subject: string, selection: number | null = null): Promise<PolicyCard> {
  const primary = await snapshot(client, subject); subject = primary.citation.id;
  const parsed = source(primary.item);
  const evidence = [primary.citation]; const resource: Record<string, number> = {};
  const plan = await optionalItem(client, `${subject}-evaluation-plan`);
  const dependencies = [...parsed.dependencies, ...(plan === null ? [] : [plan.id])];
  if (plan !== null) {
    for (const suffix of ["-result", "-shadow", "-shadow-comparison"]) {
      const found = await optionalItem(client, `${plan.id}${suffix}`);
      if (found !== null) dependencies.push(found.id);
    }
  }
  if (new Set(dependencies).size >= MAX_EVIDENCE) refuse("card_limit");
  for (const id of [...new Set(dependencies)].sort()) {
    const entry = await snapshot(client, id); evidence.push(entry.citation);
    // Resource declarations are explanatory bounds, not permission for another backend to spend them.
    Object.assign(resource, bodyLimits(entry.item));
  }
  return assemble(subject, primary.item, evidence, resource, selection);
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
  const subject = identity(candidate.subject);
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
    if (items.length > 1) {
      Object.assign(resource, bodyLimits(entry.item));
    }
  }
  if (results[0].id !== subject || new Set(results.map((row) => row.id)).size !== results.length) refuse("card_invalid");
  const parsed = source(items[0]);
  const prefix = String((await client.config("project", "get", "id_prefix")).nested_setting!.value);
  if (parsed.dependencies.some((id) => !results.some((row) => row.id === normalizeItemId(id, prefix)))) refuse("card_missing_provenance");
  const card = assemble(subject, items[0], results, resource, selection);
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
  return card;
}
/** Retain immutable outcome cards with the candidate; retries verify the winner rather than overwriting it. */
export async function recordPolicyCard(client: PmClient, subject: string, selection: number | null = null): Promise<PolicyCard> {
  const card = await exportPolicyCard(client, subject, selection); const id = `policy-card-${card.digest}`;
  const body = canonicalJson(card as unknown as JsonValue);
  await createOrReadIdentical(client, { id, type: "Decision", title: "Portable policy explanation", body, affectedVersion: card.digest, dep: [subject] }, "card_drift", (item) => {
    if (item.body !== body || item.affected_version !== card.digest) refuse("card_drift");
    return true;
  });
  return card;
}
/** Publish a separate explanation for each proposed candidate as well as the shared phase outcome. */
export async function recordRecursivePolicyCards(client: PmClient, subject: string): Promise<void> {
  const item = (await readCompleteLoopItem(client, subject)).item;
  const value = source(item).value;
  const proposals = value.configs ?? value.recipes;
  if (Array.isArray(proposals) && proposals.length > MAX_EVIDENCE) refuse("card_limit");
  await recordPolicyCard(client, subject);
  if (Array.isArray(proposals)) for (let index = 0; index < proposals.length; index += 1) await recordPolicyCard(client, subject, index);
}
