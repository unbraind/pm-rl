/** Bounded online observation of declarative policies, without candidate execution authority. */
import type { GetResult, PmClient } from "@unbrained/pm-cli/sdk/core";
import { createPmCliExpectedError, EXIT_CODE, isPmCliExpectedError } from "@unbrained/pm-cli/sdk/runtime";
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
function refuse(code: ShadowRefusal, receipt = "shadow-deployment", field = "manifest"): never {
  throw createPmCliExpectedError(`Shadow observation refused (${code}); receipt ${receipt}, field ${field}. Supply explicit Decision consent for the exact deployment digest, both-arm budgets and inputs; use a fresh candidate and plan after drift or failure. Complete and compare all observations before promotion.`, { exitCode: EXIT_CODE.CONFLICT, context: { code, item_id: receipt, field } });
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
/** Attach an exact receipt location to structural parser refusals without disclosing record values. */
function located<T>(receipt: string, field: string, parse: () => T): T {
  try { return parse(); }
  catch (error) { refuse(isPmCliExpectedError(error) && error.context.code === "shadow_budget" ? "shadow_budget" : "shadow_drift", receipt, field); }
}
/** Verify sealed package records against SDK-certified creation history. */
async function sealed(client: PmClient, id: string): Promise<GetResult["item"] | null> {
  const item = await optional(client, id); const original = await optional(client, id, "1");
  if (item === null && original === null) return null;
  if (item === null || original === null) refuse("shadow_drift", id, "history");
  if (item.type !== "Decision") refuse("shadow_drift", id, "type");
  for (const field of ["type", "body", "affected_version", "created_at"] as const) {
    if (item[field] !== original[field]) refuse("shadow_drift", id, field);
  }
  return item;
}
/** Decode only package JSON and suppress raw parser diagnostics. */
function json(body: unknown, receipt: string): unknown { try { return JSON.parse(String(body)); } catch { return refuse("shadow_drift", receipt, "body"); } }
/** Content-addressed writes are retry-safe under the SDK's mutation lock. */
async function seal(client: PmClient, id: string, value: JsonValue): Promise<void> {
  const body = canonicalJson(value); const digest = hashJson(value);
  const old = await sealed(client, id);
  if (old !== null) { if (old.body !== body || old.affected_version !== digest) refuse("shadow_drift", id, "body"); return; }
  try { await client.create({ id, type: "Decision", title: "Bounded shadow observation receipt", body, affectedVersion: digest }); }
  catch (error) { const winner = await sealed(client, id); if (winner === null) throw error; if (winner.body !== body || winner.affected_version !== digest) refuse("shadow_drift", id, "body"); }
}
/** Consent is a pre-existing Decision whose entire immutable body approves one deployment digest. */
async function consent(client: PmClient, deployment: ShadowDeployment): Promise<void> {
  const item = await sealed(client, deployment.consent);
  if (item === null || item.body !== JSON.stringify({ format: "pm-rl/shadow-consent/1", deployment: hashJson(deployment as unknown as JsonValue) })) refuse("shadow_consent", deployment.consent, "body");
}
/** Enumerate all observation slots through the SDK's certified inventory, including unexpected extra charges. */
async function observationIds(client: PmClient, id: string): Promise<string[]> {
  return (await client.listAllComplete({ includeBody: false })).items.map((item) => String(item.id))
    .filter((key) => key.startsWith(`${id}-`) && key !== `${id}-comparison`).sort();
}
/** One manifest contract governs registration, reload, resume and actual charged calls. */
async function validateDeployment(client: PmClient, deployment: ShadowDeployment, plan: EvaluationPlan, id: string, receipts: readonly string[]): Promise<void> {
  await consent(client, deployment);
  if (plan.candidate !== deployment.generation) refuse("shadow_consent", id, "generation");
  if (plan.incumbent !== deployment.incumbent) refuse("shadow_consent", id, "incumbent");
  const members = plan.members.map((member) => member.id);
  if (members.length === 0 || hashJson(Object.keys(deployment.inputs).sort()) !== hashJson(members)) refuse("shadow_consent", id, "inputs");
  for (const arm of ["active_calls", "candidate_calls"] as const) {
    if (deployment.budget[arm] < members.length) refuse("shadow_budget", id, `budget.${arm}`);
    if (receipts.length > deployment.budget[arm]) refuse("shadow_budget", id, `charged.${arm}`);
  }
  const allowed = new Set(members.map((member) => `${id}-${hashJson(member)}`));
  for (const receipt of receipts) if (!allowed.has(receipt)) refuse("shadow_consent", receipt, "id");
}
/** Register online observation before candidate collection through the existing evaluation plan reservation. */
export async function registerShadowDeployment(client: PmClient, value: unknown, input: unknown): Promise<{ id: string; comparison: string; reserved_calls: number }> {
  const deployment = parseShadowDeployment(value); const plan = parseEvaluationPlan(input);
  const id = `${plan.candidate}-evaluation-plan-shadow`;
  await validateDeployment(client, deployment, plan, id, await observationIds(client, id));
  const digest = hashJson(deployment as unknown as JsonValue);
  const registered = await registerEvaluationPlan(client, { ...plan, shadow: digest });
  await seal(client, id, deployment as unknown as JsonValue);
  return { id, comparison: registered.comparison, reserved_calls: plan.members.length * 2 };
}
/** Read and revalidate the exact sealed online manifest and its actual observation inventory. */
async function deploymentFor(client: PmClient, candidate: string): Promise<{ deployment: ShadowDeployment; plan: EvaluationPlan; id: string; policyInputs: ReadonlyMap<string, string> }> {
  const registered = await readEvaluationPlan(client, candidate);
  if (registered === null || registered.plan.shadow === undefined) refuse("shadow_missing");
  const id = `${registered.id}-shadow`; const item = await sealed(client, id);
  if (item === null) refuse("shadow_missing", id, "manifest");
  const deployment = located(id, "manifest", () => parseShadowDeployment(json(item.body, id)));
  if (hashJson(deployment as unknown as JsonValue) !== registered.plan.shadow) refuse("shadow_drift", id, "comparison");
  if (item.affected_version !== registered.plan.shadow) refuse("shadow_drift", id, "affected_version");
  const receipts = await observationIds(client, id);
  await validateDeployment(client, deployment, registered.plan, id, receipts);
  return { deployment, plan: registered.plan, id, policyInputs: new Map(Object.keys(deployment.active).map((input) => [shadowInputDigest(input), input])) };
}
/** Bind the inert artifact to provenance already verified by the existing evaluation gate. */
async function policyBinding(client: PmClient, generation: string, policy: ShadowPolicy, receipt: string): Promise<void> {
  const item = await readCompleteLoopItem(client, generation);
  const spec = extractGenerationSpec(String(item.item.body), "Shadow generation");
  if (record(spec.training_config).shadow_policy !== hashJson(policy as JsonValue)) refuse("shadow_drift", receipt, "training_config.shadow_policy");
}
/** Validate a selected arm reward independently of caller-provided aggregates. */
function reward(value: unknown, plan: EvaluationPlan, receipt: string, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < plan.reward_bounds[0] || value > plan.reward_bounds[1]) refuse("shadow_drift", receipt, field);
  return value;
}
/** Compare named fields without copying their potentially sensitive values into diagnostics. */
function sameFields(value: Record<string, unknown>, expected: Record<string, unknown>, receipt: string): void {
  for (const [field, wanted] of Object.entries(expected)) {
    if (value[field] !== wanted) refuse("shadow_drift", receipt, field);
  }
}
/** Canonically commit only observed arm outcomes, preserving unusual action names as own properties. */
function selectedRewards(active: string, activeReward: number, candidate: string | null, candidateReward: number | null): Record<string, number> {
  return Object.fromEntries([[active, activeReward], ...(candidate !== null && candidateReward !== null ? [[candidate, candidateReward]] : [])]);
}
/** One semantic receipt validator is used before persistence, on retries and whenever evidence is loaded. */
function validateObservation(value: unknown, deployment: ShadowDeployment, plan: EvaluationPlan, receipt: string, policyInputs: ReadonlyMap<string, string>): ShadowObservation {
  const row = located(receipt, "fields", () => { const row = record(value); keys(row, ["id", "input_digest", "outcome_digest", "active_action", "candidate_action", "active_reward", "candidate_reward", "disagreement", "failure"]); return row; });
  if (typeof row.id !== "string" || !Object.hasOwn(deployment.inputs, row.id) || !plan.members.some((member) => member.id === row.id)) refuse("shadow_consent", receipt, "id");
  if (receipt !== `${plan.candidate}-evaluation-plan-shadow-${hashJson(row.id)}`) refuse("shadow_drift", receipt, "id");
  if (row.input_digest !== deployment.inputs[row.id]) refuse("shadow_consent", receipt, "input_digest");
  const input = policyInputs.get(String(row.input_digest));
  if (input === undefined) refuse("shadow_drift", receipt, "active_action");
  const activeAction = deployment.active[input]; const candidateAction = Object.hasOwn(deployment.candidate, input) ? deployment.candidate[input] : null;
  sameFields(row, { active_action: activeAction, candidate_action: candidateAction }, receipt);
  const activeReward = reward(row.active_reward, plan, receipt, "active_reward");
  const candidateReward = row.candidate_reward === null ? null : reward(row.candidate_reward, plan, receipt, "candidate_reward");
  if (candidateAction === activeAction && candidateReward !== activeReward) refuse("shadow_drift", receipt, "candidate_reward");
  if (candidateAction === null && candidateReward !== null) refuse("shadow_drift", receipt, "candidate_reward");
  const failure = candidateAction === null ? "candidate_missing_action" : candidateReward === null ? "candidate_missing_outcome" : null;
  sameFields(row, { disagreement: candidateAction !== null && candidateAction !== activeAction, failure }, receipt);
  sameFields(row, { outcome_digest: hashJson(selectedRewards(activeAction, activeReward, candidateAction, candidateReward)) }, receipt);
  return { id: row.id, input_digest: String(row.input_digest), outcome_digest: String(row.outcome_digest), active_action: activeAction, candidate_action: candidateAction,
    active_reward: activeReward, candidate_reward: candidateReward, disagreement: candidateAction !== null && candidateAction !== activeAction, failure };
}
/** Read one immutable observation through the same validator used by the live observer. */
async function readObservation(client: PmClient, receipt: string, deployment: ShadowDeployment, plan: EvaluationPlan, policyInputs: ReadonlyMap<string, string>): Promise<ShadowObservation | null> {
  const item = await sealed(client, receipt); if (item === null) return null;
  const row = validateObservation(json(item.body, receipt), deployment, plan, receipt, policyInputs);
  if (item.affected_version !== hashJson(row as unknown as JsonValue)) refuse("shadow_drift", receipt, "affected_version");
  return row;
}
/** Observe once per consented input. Missing candidate actions are data, never active-action failures. */
export async function observeShadow(client: PmClient, candidate: string, value: unknown): Promise<ShadowObservation> {
  const { deployment, plan, id, policyInputs } = await deploymentFor(client, candidate);
  const row = record(value); keys(row, ["id", "input", "rewards"]);
  const member = label(row.id); const input = label(row.input); const inputDigest = shadowInputDigest(input); const receipt = `${id}-${hashJson(member)}`;
  if (!Object.hasOwn(deployment.inputs, member) || deployment.inputs[member] !== inputDigest) refuse("shadow_consent", receipt, "input_digest");
  await policyBinding(client, plan.incumbent, deployment.active, id); await policyBinding(client, candidate, deployment.candidate, id);
  const rewards = record(row.rewards); const [lo, hi] = plan.reward_bounds;
  if (Object.values(rewards).some((reward) => typeof reward !== "number" || !Number.isFinite(reward) || reward < lo || reward > hi)) refuse("shadow_invalid", receipt, "rewards");
  const activeAction = Object.hasOwn(deployment.active, input) ? deployment.active[input] : null;
  if (activeAction === null || !Object.hasOwn(rewards, activeAction)) refuse("shadow_invalid", receipt, "active_action");
  const candidateAction = Object.hasOwn(deployment.candidate, input) ? deployment.candidate[input] : null;
  const failure = candidateAction === null ? "candidate_missing_action" : Object.hasOwn(rewards, candidateAction) ? null : "candidate_missing_outcome";
  const selected = selectedRewards(activeAction, rewards[activeAction] as number, candidateAction, failure === null ? rewards[candidateAction!] as number : null);
  const observation = validateObservation({ id: member, input_digest: inputDigest, outcome_digest: hashJson(selected), active_action: activeAction, candidate_action: candidateAction,
    active_reward: rewards[activeAction], candidate_reward: failure === null ? rewards[candidateAction!] : null,
    disagreement: candidateAction !== null && candidateAction !== activeAction, failure }, deployment, plan, receipt, policyInputs);
  const existing = await readObservation(client, receipt, deployment, plan, policyInputs);
  if (existing !== null) sameFields(existing as unknown as Record<string, unknown>, observation as unknown as Record<string, unknown>, receipt);
  await seal(client, receipt, observation as unknown as JsonValue);
  return observation;
}
/** Recompute all observations from pinned artifacts; never trust mutable aggregate counts or verdicts. */
async function shadowComparison(client: PmClient, candidate: string): Promise<{ report: ShadowReport; pairs: EvaluationObservation[] }> {
  const { deployment, plan, id, policyInputs } = await deploymentFor(client, candidate);
  await policyBinding(client, plan.incumbent, deployment.active, id); await policyBinding(client, candidate, deployment.candidate, id);
  const observations: ShadowObservation[] = [];
  for (const member of plan.members) {
    const receipt = `${id}-${hashJson(member.id)}`;
    const row = await readObservation(client, receipt, deployment, plan, policyInputs);
    if (row === null) refuse("shadow_incomplete", receipt, "id");
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
  if (receipt === null) refuse("shadow_missing", `${candidate}-evaluation-plan-shadow-comparison`, "comparison");
  const { report } = await shadowComparison(client, candidate);
  const recorded = located(report.receipt, "fields", () => record(json(receipt.body, report.receipt)));
  const charged = located(report.receipt, "charged", () => record(recorded.charged));
  for (const field of ["active_calls", "candidate_calls"] as const) if (charged[field] !== report.charged[field]) refuse("shadow_budget", report.receipt, `charged.${field}`);
  if (receipt.body !== canonicalJson(report as unknown as JsonValue)) refuse("shadow_drift", report.receipt, "comparison");
  if (receipt.affected_version !== hashJson(report as unknown as JsonValue)) refuse("shadow_drift", report.receipt, "affected_version");
  if (report.candidate_failures !== 0) refuse("shadow_failed", report.receipt, "candidate_failures");
}
