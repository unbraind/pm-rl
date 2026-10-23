/** Bounded online observation of declarative policies, without candidate execution authority. */
import type { GetResult, PmClient } from "@unbrained/pm-cli/sdk/core";
import { createPmCliExpectedError, EXIT_CODE } from "@unbrained/pm-cli/sdk/runtime";
import { canonicalJson, hashJson, extractGenerationSpec, readCompleteLoopItem, type JsonValue } from "./index.ts";
import { optionalItem as optional, parseEvaluationPlan, readEvaluationPlan, registerEvaluationPlan, recordPlanEvaluation, evaluatePlan, type EvaluationObservation, type EvaluationPlan, type EvaluationPlanReport } from "./evaluation-plan.ts";

/** A total active decision table; an absent candidate entry is an isolated candidate failure. */
export type ShadowPolicy = Readonly<Record<string, string>>;
/** Explicit consent pins every minimized input, both policy artifacts and the entire resource allowance. */
export interface ShadowDeployment {
  readonly format: "pm-rl/shadow/1";
  readonly consent: string;
  readonly generation: string;
  readonly incumbent: string;
  readonly active: ShadowPolicy;
  readonly candidate: ShadowPolicy;
  readonly inputs: Readonly<Record<string, string>>;
  readonly budget: { readonly active_calls: number; readonly candidate_calls: number };
}
/** One consented input and observed rewards for the available decisions, never commands to execute. */
export interface ShadowInput { readonly id: string; readonly input: string; readonly rewards: Readonly<Record<string, number>> }
/** Candidate diagnostics cannot substitute for the active action. */
export interface ShadowObservation {
  readonly id: string;
  readonly input_digest: string;
  readonly outcome_digest: string;
  readonly active_action: string;
  readonly candidate_action: string | null;
  readonly active_reward: number;
  readonly candidate_reward: number | null;
  readonly disagreement: boolean;
  readonly failure: "candidate_missing_action" | "candidate_missing_outcome" | null;
}
/** Compact receipt; raw outcomes stay in independently verified per-input tracker records. */
export interface ShadowReport {
  readonly receipt: string;
  readonly comparison: string;
  readonly observations: number;
  readonly disagreements: number;
  readonly candidate_failures: number;
  readonly charged: { readonly active_calls: number; readonly candidate_calls: number };
  readonly outcome: EvaluationPlanReport | null;
  readonly remedy: string | null;
}
/** Machine-readable refusal with a recovery action and no private input content. */
export type ShadowRefusal = "shadow_invalid" | "shadow_consent" | "shadow_budget" | "shadow_drift" | "shadow_missing" | "shadow_incomplete" | "shadow_failed";
/** Emit consistent typed refusals for CLI and SDK callers. */
function refuse(code: ShadowRefusal): never {
  throw createPmCliExpectedError(`Shadow observation refused (${code}). Supply explicit Decision consent for the exact deployment digest, both-arm budgets and inputs; use a fresh candidate and plan after drift or failure. Complete and compare all observations before promotion.`, { exitCode: EXIT_CODE.CONFLICT, context: { code } });
}
/** Validate structured records without executing caller-owned policy code. */
function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) refuse("shadow_invalid");
  return value as Record<string, unknown>;
}
/** Bound labels to keep policy evaluation and receipt sizes predictable. */
function label(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 1024) refuse("shadow_invalid");
  return value;
}
/** Reject ignored configuration keys rather than implying unsupported behaviour. */
function keys(value: Record<string, unknown>, expected: readonly string[]): void {
  if (Object.keys(value).length !== expected.length || expected.some((key) => !Object.hasOwn(value, key))) refuse("shadow_invalid");
}
/** Normalize inert lookup artifacts and reject unbounded or executable configurations. */
function table(value: unknown): ShadowPolicy {
  const entries = Object.entries(record(value));
  if (entries.length > 10_000) refuse("shadow_invalid");
  return Object.fromEntries(entries.map(([key, action]) => [label(key), label(action)]));
}
/** Parse the sole supported policy interpreter and two explicit per-arm allowances. */
export function parseShadowDeployment(value: unknown): ShadowDeployment {
  const p = record(value); keys(p, ["format", "consent", "generation", "incumbent", "active", "candidate", "inputs", "budget"]);
  if (p.format !== "pm-rl/shadow/1") refuse("shadow_invalid");
  const budget = record(p.budget); keys(budget, ["active_calls", "candidate_calls"]);
  if ([budget.active_calls, budget.candidate_calls].some((n) => typeof n !== "number" || !Number.isSafeInteger(n) || n < 0 || n > 10_000)) refuse("shadow_budget");
  const inputs = table(p.inputs);
  if (Object.values(inputs).some((digest) => !/^[a-f0-9]{64}$/.test(digest))) refuse("shadow_invalid");
  return { format: "pm-rl/shadow/1", consent: label(p.consent), generation: label(p.generation), incumbent: label(p.incumbent), active: table(p.active), candidate: table(p.candidate), inputs,
    budget: { active_calls: budget.active_calls as number, candidate_calls: budget.candidate_calls as number } };
}
/** Stable input identity allows consent without retaining source tracker content. */
export function shadowInputDigest(input: string): string { return hashJson(label(input)); }
/** Verify sealed package records against SDK-certified creation history. */
async function sealed(client: PmClient, id: string): Promise<GetResult["item"] | null> {
  const item = await optional(client, id); const original = await optional(client, id, "1");
  if (item === null && original === null) return null;
  if (item === null || original === null || item.type !== "Decision" || ["body", "affected_version", "created_at"].some((key) => item[key] !== original[key])) refuse("shadow_drift");
  return item;
}
/** Decode only package JSON and suppress raw parser diagnostics. */
function json(body: unknown): unknown { try { return JSON.parse(String(body)); } catch { return refuse("shadow_drift"); } }
/** Content-addressed writes are retry-safe under the SDK's mutation lock. */
async function seal(client: PmClient, id: string, value: JsonValue): Promise<void> {
  const body = canonicalJson(value); const digest = hashJson(value);
  const old = await sealed(client, id);
  if (old !== null) { if (old.body !== body || old.affected_version !== digest) refuse("shadow_drift"); return; }
  try { await client.create({ id, type: "Decision", title: "Bounded shadow observation receipt", body, affectedVersion: digest }); }
  catch (error) { const winner = await sealed(client, id); if (winner === null || winner.body !== body || winner.affected_version !== digest) throw error; }
}
/** Consent is a pre-existing Decision whose entire immutable body approves one deployment digest. */
async function consent(client: PmClient, deployment: ShadowDeployment): Promise<void> {
  const item = await sealed(client, deployment.consent);
  if (item === null || item.body !== JSON.stringify({ format: "pm-rl/shadow-consent/1", deployment: hashJson(deployment as unknown as JsonValue) })) refuse("shadow_consent");
}
/** Register online observation before candidate collection through the existing evaluation plan reservation. */
export async function registerShadowDeployment(client: PmClient, value: unknown, input: unknown): Promise<{ id: string; comparison: string; reserved_calls: number }> {
  const deployment = parseShadowDeployment(value); const plan = parseEvaluationPlan(input);
  await consent(client, deployment);
  if (plan.candidate !== deployment.generation || plan.incumbent !== deployment.incumbent) refuse("shadow_consent");
  const ids = Object.keys(deployment.inputs).sort();
  if (hashJson(ids) !== hashJson(plan.members.map((m) => m.id)) || ids.length === 0) refuse("shadow_consent");
  if (deployment.budget.active_calls < ids.length || deployment.budget.candidate_calls < ids.length) refuse("shadow_budget");
  const digest = hashJson(deployment as unknown as JsonValue);
  const registered = await registerEvaluationPlan(client, { ...plan, shadow: digest });
  const id = `${registered.id}-shadow`;
  await seal(client, id, deployment as unknown as JsonValue);
  return { id, comparison: registered.comparison, reserved_calls: ids.length * 2 };
}
/** Read the exact sealed online manifest pinned by the original evaluation plan. */
async function deploymentFor(client: PmClient, candidate: string): Promise<{ deployment: ShadowDeployment; plan: EvaluationPlan; id: string }> {
  const registered = await readEvaluationPlan(client, candidate);
  if (registered === null || registered.plan.shadow === undefined) refuse("shadow_missing");
  const id = `${registered.id}-shadow`; const item = await sealed(client, id);
  if (item === null) refuse("shadow_missing");
  const deployment = parseShadowDeployment(json(item.body));
  if (hashJson(deployment as unknown as JsonValue) !== registered.plan.shadow || item.affected_version !== registered.plan.shadow) refuse("shadow_drift");
  await consent(client, deployment);
  return { deployment, plan: registered.plan, id };
}
/** Bind the inert artifact to provenance already verified by the existing evaluation gate. */
async function policyBinding(client: PmClient, generation: string, policy: ShadowPolicy): Promise<void> {
  const item = await readCompleteLoopItem(client, generation);
  const spec = extractGenerationSpec(String(item.item.body), "Shadow generation");
  if (record(spec.training_config).shadow_policy !== hashJson(policy as JsonValue)) refuse("shadow_drift");
}
/** Observe once per consented input. Missing candidate actions are data, never active-action failures. */
export async function observeShadow(client: PmClient, candidate: string, value: unknown): Promise<ShadowObservation> {
  const { deployment, plan, id } = await deploymentFor(client, candidate);
  const row = record(value); keys(row, ["id", "input", "rewards"]);
  const member = label(row.id); const input = label(row.input); const inputDigest = shadowInputDigest(input);
  if (!Object.hasOwn(deployment.inputs, member) || deployment.inputs[member] !== inputDigest) refuse("shadow_consent");
  await policyBinding(client, plan.incumbent, deployment.active); await policyBinding(client, candidate, deployment.candidate);
  const rewards = record(row.rewards); const [lo, hi] = plan.reward_bounds;
  if (Object.values(rewards).some((reward) => typeof reward !== "number" || !Number.isFinite(reward) || reward < lo || reward > hi)) refuse("shadow_invalid");
  const activeAction = Object.hasOwn(deployment.active, input) ? deployment.active[input] : null;
  if (activeAction === null || !Object.hasOwn(rewards, activeAction)) refuse("shadow_invalid");
  const candidateAction = Object.hasOwn(deployment.candidate, input) ? deployment.candidate[input] : null;
  const failure = candidateAction === null ? "candidate_missing_action" : Object.hasOwn(rewards, candidateAction) ? null : "candidate_missing_outcome";
  const observation: ShadowObservation = { id: member, input_digest: inputDigest, outcome_digest: hashJson(rewards as JsonValue), active_action: activeAction, candidate_action: candidateAction,
    active_reward: rewards[activeAction] as number, candidate_reward: failure === null ? rewards[candidateAction!] as number : null,
    disagreement: candidateAction !== null && candidateAction !== activeAction, failure };
  await seal(client, `${id}-${hashJson(member)}`, observation as unknown as JsonValue);
  return observation;
}
/** Recompute all observations from pinned artifacts; never trust mutable aggregate counts or verdicts. */
async function shadowComparison(client: PmClient, candidate: string): Promise<{ report: ShadowReport; pairs: EvaluationObservation[] }> {
  const { deployment, plan, id } = await deploymentFor(client, candidate);
  await policyBinding(client, plan.incumbent, deployment.active); await policyBinding(client, candidate, deployment.candidate);
  const observations: ShadowObservation[] = [];
  for (const member of plan.members) {
    const item = await sealed(client, `${id}-${hashJson(member.id)}`);
    if (item === null) refuse("shadow_incomplete");
    const row = json(item.body) as ShadowObservation;
    if (row.id !== member.id || row.input_digest !== deployment.inputs[member.id] || item.affected_version !== hashJson(row as unknown as JsonValue)) refuse("shadow_drift");
    observations.push(row);
  }
  const failures = observations.filter((row) => row.failure !== null).length;
  const pairs = observations.map((row) => ({ id: row.id, candidate: row.candidate_reward!, incumbent: row.active_reward }));
  const outcome = failures === 0 ? evaluatePlan(plan, pairs) : null;
  const report: ShadowReport = { receipt: `${id}-comparison`, comparison: hashJson(deployment as unknown as JsonValue), observations: observations.length,
    disagreements: observations.filter((row) => row.disagreement).length, candidate_failures: failures,
    charged: { active_calls: observations.length, candidate_calls: observations.length }, outcome,
    remedy: failures === 0 ? outcome!.remedy : "Keep the active policy; fix the candidate and register a fresh consented plan." };
  return { report, pairs };
}
/** Seal one online comparison using the existing immutable paired-outcome recorder. */
export async function compareShadow(client: PmClient, candidate: string): Promise<ShadowReport> {
  const { report, pairs } = await shadowComparison(client, candidate);
  if (report.outcome !== null) await recordPlanEvaluation(client, candidate, pairs);
  await seal(client, report.receipt, report as unknown as JsonValue);
  return report;
}
/** Recognize the explicit online-policy provenance marker without restricting offline trainer config formats. */
function onlineBound(value: JsonValue): boolean {
  return value !== null && typeof value === "object" && !Array.isArray(value) && Object.hasOwn(value, "shadow_policy");
}
/** The existing promotion transaction requires online comparisons throughout an online-bound lineage. */
export async function enforceShadowComparison(client: PmClient, candidate: string, plan: EvaluationPlan | null): Promise<void> {
  if (plan === null || plan.shadow === undefined) {
    const item = await optional(client, candidate);
    if (item === null || item.type !== "Generation") return;
    const spec = extractGenerationSpec(String(item.body), "Candidate generation");
    if (onlineBound(spec.training_config)) refuse("shadow_missing");
    if (spec.parent !== null) {
      const parent = await readCompleteLoopItem(client, spec.parent);
      if (onlineBound(extractGenerationSpec(String(parent.item.body), "Incumbent generation").training_config)) refuse("shadow_missing");
    }
    return;
  }
  const receipt = await sealed(client, `${candidate}-evaluation-plan-shadow-comparison`);
  if (receipt === null) refuse("shadow_missing");
  const { report } = await shadowComparison(client, candidate);
  if (receipt.body !== canonicalJson(report as unknown as JsonValue) || receipt.affected_version !== hashJson(report as unknown as JsonValue)) refuse("shadow_drift");
  if (report.candidate_failures !== 0) refuse("shadow_failed");
}
