/** Causal evaluation birth witnesses, persisted atomically with their native SDK artifacts. */
import { randomUUID } from "node:crypto";
import type { GetResult, PmClient } from "@unbrained/pm-cli/sdk/core";
import { createVerifiedItem, extractGenerationSpec, generationProvenance, hashJson, readCompleteLoopItem, type JsonValue } from "./index.ts";
import { evaluationComparison, evaluationPlanId, evaluationOutcomeIds, optionalItem, refuse, resolveEvaluationPlan, verifyCreatedRecord, type EvaluationPlan } from "./evaluation-plan.ts";
import { withEvaluationLease, type SequentialStopping } from "./sequential-evaluation.ts";
import { encodeBoundedJson, parseBoundedJson } from "./tracker-record.ts";

const PREFIX = "pm-rl/evaluation-birth/1 ";
/** Include causal witnesses in decision seals while preserving every legacy digest byte. @internal */
export function evaluationBirthIdentity(item: GetResult["item"]): { lifecycle?: string[] } {
  const lifecycle = (item.notes ?? []).map((note) => note.text).filter((text) => text.startsWith(PREFIX));
  return lifecycle.length === 0 ? {} : { lifecycle };
}
/** A lifecycle stage is a partial order: collection Runs share one exchangeable stage. */
export interface EvaluationArtifact { readonly id: string; readonly stage: number }
/** Immutable causal identity; timestamps are content, never ordering coordinates. */
interface BirthWitness {
  readonly comparison: string;
  readonly stage: number;
  readonly nonce: string;
  readonly request: string;
  readonly predecessors: readonly { readonly id: string; readonly digest: string }[];
}
/** Read only the original witness, rejecting removed, duplicated or rewritten live witnesses. */
async function witnessedBirth(client: PmClient, id: string): Promise<{ item: GetResult["item"]; current: GetResult["item"]; witness: BirthWitness }> {
  const item = (await readCompleteLoopItem(client, id, "1", "id,type,body,affected_version,fixed_version,created_at,component,environment,notes")).item;
  const current = (await readCompleteLoopItem(client, id, undefined, "id,type,body,affected_version,fixed_version,created_at,component,environment,notes")).item;
  const notes = (row: GetResult["item"]): string[] => evaluationBirthIdentity(row).lifecycle ?? [];
  const birth = notes(item);
  if (birth.length !== 1 || JSON.stringify(notes(current)) !== JSON.stringify(birth)) refuse("eval_plan_evidence", id);
  let raw: unknown;
  try { raw = parseBoundedJson(birth[0].slice(PREFIX.length)); } catch { refuse("eval_plan_evidence", id); }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) refuse("eval_plan_evidence", id);
  const witness = raw as BirthWitness;
  if (Object.keys(raw).sort().join(",") !== "comparison,nonce,predecessors,request,stage" || !/^[a-f0-9]{64}$/.test(witness.comparison) || !/^[a-f0-9]{64}$/.test(witness.request) || typeof witness.nonce !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(witness.nonce) || !Number.isSafeInteger(witness.stage) || witness.stage < 0 || !Array.isArray(witness.predecessors)) refuse("eval_plan_evidence", id);
  return { item, current, witness };
}
/** Hash the sealed native birth fields, including the unpredictable witness nonce. */
function birthDigest(item: GetResult["item"]): string { return hashJson(item as unknown as JsonValue); }
/** One comparison order is used by both the producer and the validator. */
function references(entries: readonly { id: string; stage: number; item: GetResult["item"] }[], stage: number, digests = new Map<GetResult["item"], string>()): { id: string; digest: string }[] {
  return entries.filter((entry) => entry.stage < stage).map(({ id, item }) => {
    let digest = digests.get(item);
    if (digest === undefined) { digest = birthDigest(item); digests.set(item, digest); }
    return { id, digest };
  }).sort((a, b) => a.id < b.id ? -1 : 1);
}
/** Read and validate each native birth once, retaining the per-operation digest cache. */
async function validatedEntries(client: PmClient, plan: EvaluationPlan, artifacts: readonly EvaluationArtifact[], prospective?: GetResult["item"]) {
  const entries: (EvaluationArtifact & Awaited<ReturnType<typeof witnessedBirth>>)[] = [];
  // Drain each SDK read before refusing; no pending SDK operation may outlive validation.
  for (const entry of artifacts) if (entry.id !== prospective?.id) entries.push({ ...entry, ...await witnessedBirth(client, entry.id) });
  const comparison = evaluationComparison(plan);
  const digests = new Map<GetResult["item"], string>();
  for (const entry of entries) {
    if (entry.witness.comparison !== comparison || entry.witness.stage !== entry.stage || JSON.stringify(entry.witness.predecessors) !== JSON.stringify(references(entries, entry.stage, digests))) refuse("eval_plan_late", entry.id);
  }
  return { entries, digests };
}
/** Validate complete causal ancestry without consulting dates or cross-stream event presentation order. @internal */
export async function validateCausalEvaluationOrder(client: PmClient, plan: EvaluationPlan, artifacts: readonly EvaluationArtifact[], prospective?: GetResult["item"]): Promise<void> {
  await validatedEntries(client, plan, artifacts, prospective);
}
/** Verify an existing birth without creating it; Generation bodies compare provenance and policy cards verify promotion. @internal */
export async function verifyCausalEvaluationRetry(client: PmClient, plan: EvaluationPlan, options: Parameters<PmClient["create"]>[0] & { id: string }, artifacts: readonly EvaluationArtifact[]): Promise<void> {
  const { entries } = await validatedEntries(client, plan, artifacts);
  const birth = entries.find(entry => entry.id === options.id) ?? await witnessedBirth(client, options.id);
  verifyRetryBirth(options, birth);
}
/** Compare retry intent and current native state against the already validated birth. */
function verifyRetryBirth(options: Parameters<PmClient["create"]>[0] & { id: string }, birth: Awaited<ReturnType<typeof witnessedBirth>>): void {
  const bodyIdentity = (item: GetResult["item"]): string => item.type === "Generation" ? hashJson(generationProvenance(extractGenerationSpec(String(item.body), "Causal candidate retry"))) : String(item.body);
  if (birth.witness.request !== hashJson(options as unknown as JsonValue) || (["id", "type", "affected_version", "fixed_version", "component", "environment", "created_at"] as const).some(field => birth.item[field] !== birth.current[field]) || bodyIdentity(birth.item) !== bodyIdentity(birth.current)) refuse("eval_plan_drift", options.id);
}
/** Create a witnessed artifact in one SDK mutation; an uncertain acknowledgement retries the same birth. @internal */
export async function createCausalEvaluationArtifact(client: PmClient, plan: EvaluationPlan, options: Parameters<PmClient["create"]>[0] & { id: string }, artifacts: readonly EvaluationArtifact[]): Promise<Awaited<ReturnType<PmClient["create"]>>> {
  const target = artifacts.find((entry) => entry.id === options.id);
  if (target === undefined) refuse("eval_plan_invalid");
  const predecessors = artifacts.filter((entry) => entry.stage < target.stage);
  const existing = await optionalItem(client, options.id);
  if (existing !== null) {
    await verifyCausalEvaluationRetry(client, plan, options, [...predecessors, target]);
    return { item: existing as Awaited<ReturnType<PmClient["create"]>>["item"], changed_fields: [], warnings: [] };
  }
  const { entries, digests } = await validatedEntries(client, plan, predecessors);
  const request = hashJson(options as unknown as JsonValue);
  const witness: BirthWitness = { comparison: evaluationComparison(plan), stage: target.stage, nonce: randomUUID(), request, predecessors: references(entries, target.stage, digests) };
  return createVerifiedItem(client, { ...options, note: [...(options.note ?? []), `${PREFIX}${encodeBoundedJson(witness)}`] });
}
/** Approve the exact causal sequential design before its Plan exists; approval grants no promotion budget. */
export async function approveEvaluationPlan(client: PmClient, value: unknown): Promise<{ id: string; comparison: string }> {
  const plan = await resolveEvaluationPlan(client, value, "write");
  if (plan.ordering !== "causal/1") refuse("eval_plan_stopping");
  const id = (plan.stopping as SequentialStopping).review;
  return withEvaluationLease(client, plan.candidate, [], async () => {
    if (await optionalItem(client, id) === null) {
      for (const future of [evaluationPlanId(plan.candidate), plan.candidate, ...evaluationOutcomeIds(plan)]) if (await optionalItem(client, future) !== null || await optionalItem(client, future, "1") !== null) refuse("eval_plan_late", future);
    }
    const comparison = evaluationComparison(plan);
    const result = await createCausalEvaluationArtifact(client, plan, { id, type: "Decision", title: "Reviewed causal evaluation design", body: encodeBoundedJson({ format: "pm-rl/sequential-review/1", comparison }) }, [{ id, stage: 0 }]);
    await verifyCreatedRecord(client, (await readCompleteLoopItem(client, result.item.id)).item);
    return { id: result.item.id, comparison };
  });
}
