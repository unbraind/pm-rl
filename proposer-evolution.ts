/** Bounded algorithm evolution layered on authoritative process, recipe, evaluation and controller APIs. */
import assert from "node:assert/strict";
import { readdirSync, statSync } from "node:fs";
import type { PmClient } from "@unbrained/pm-cli/sdk/core";
import { isPmCliExpectedError } from "@unbrained/pm-cli/sdk/runtime";
import { hashJson, readCompleteLoopItem, withRlController, type JsonValue, type RlDurableStep } from "./index.ts";
import { programmeRequest, canonicalIdentifier, statePath } from "./state-boundary.ts";
import { expectedFail } from "./refuse.ts";
import { parseProposerProgram, parseProposalInvocation, parseProposalInstruction, initialProposer, mutateProposer, ProposerRefusal, type ProposerProgram, type ProposalCounts, type ProposalExecution, type ProposalInvocation, type ProposalInstruction } from "./proposer-program.ts";
import { executeProcessTrainer, verifyCompletedProcessJob, readProcessJob, approvedResources, processJobsForApproval, RESOURCE_KEYS, type ProcessInput, type ProcessCoordinates, type ProcessAdapter, type Resources } from "./process.ts";
import { proposerWorkerArgv } from "./proposer-worker.ts";
import { initialImprover, type LearnerConfig } from "./improver.ts";
import { recipeArtifact, INITIAL_RECIPE } from "./recipe.ts";
import { readImproverDataset, readImproverTasks, IMPROVER_ROLES, type ImproverDataset } from "./improver-data.ts";
import { openImproverEnvironment, IMPROVER_CRITERION, IMPROVER_ADAPTER, IMPROVER_MAX_ATTEMPTS } from "./improver-environment.ts";
import { parseEvaluationPlan, evaluatePlan, type EvaluationPlan, type EvaluationPlanReport } from "./evaluation-plan.ts";
import { requireCheckpointStorage } from "./checkpoint-artifacts.ts";
import { reserveSearchCapacity } from "./meta.ts";
import { TRANSFER_DESIGN, loadTransferCorpus, verifyTransferCorpus, transferMembers, transferPower, archiveTransferCorpus, replayTransferCorpus, recordTransferEvaluation, replayTransferEvaluation, parseTransferDesign, recordTransferPlan, readTransferPlan, type TransferReport, type TransferCorpus } from "./proposer-transfer.ts";

/** Same bounded allowance for every proposal interpreter; logical optimizer and inference use are both zero. */
export const PROPOSER_ALLOWANCE = { training_steps: 0, wall_ms: 30_000, storage_bytes: 16_384, compute_units: 30_000, tokens: 0 } as const;
/** Search limits are immutable, including statistical budgets and post-promotion audit costs. */
export interface ProposerEvolutionConfig { readonly initial: ProposerProgram; readonly generations: number; readonly candidates: number; readonly updates: number; readonly seed: number; readonly timeout_ms: number; readonly transfer?: { readonly effect: number; readonly alpha: number; readonly power: number } }
/** Aggregate search evidence excludes raw task rows; full process receipts remain independently readable. */
export interface ProposerSearch { readonly execution: ProposalExecution; readonly scores: readonly { id: string; mean: number }[]; readonly counts: readonly ProposalCounts[]; readonly jobs: readonly string[]; readonly optimizer_updates: number }
/** Every rejected or restored artifact remains in append-only controller receipts. */
export interface ProposerGeneration { readonly generation: number; readonly before: string; readonly candidate: ProposerProgram; readonly retained: string; readonly promoted: boolean; readonly behavior_changed: boolean; readonly comparison: EvaluationPlanReport; readonly transfer: { readonly digest: string; readonly report: TransferReport } }
/** Agent-sized result, with stable identities pointing to durable programme and process evidence. */
export interface ProposerEvolutionReport { readonly format: "pm-rl/proposer-evolution/1"; readonly initial: string; readonly retained: ProposerProgram; readonly generations: readonly ProposerGeneration[]; readonly rollback: boolean; readonly audit: EvaluationPlanReport; readonly transfer: { readonly digest: string; readonly report: TransferReport }; readonly budget: { readonly fits: number; readonly optimizer_updates: number; readonly max_optimizer_updates: number; readonly inference_tokens: 0; readonly proposal_processes: number } }
/** Explicit operator coordinates and optional interruption probe; no executable callback enters a candidate. */
export interface ProposerEvolutionRequest { readonly id: string; readonly config: ProposerEvolutionConfig; readonly dataset: string; readonly approval: string; readonly signal?: AbortSignal; readonly forceTakeover?: boolean; readonly onStep?: (key: string) => void | Promise<void> }

/** A modest declaration keeps actual training bounded to two recursive generations. */
export function proposerEvolutionConfiguration(): ProposerEvolutionConfig { return { initial: initialProposer(), generations: 2, candidates: 2, updates: 64, seed: 42, timeout_ms: 1_140_000, transfer: { effect: 0.10, alpha: 0.05, power: 0.80 } }; }
/** Validate the complete configuration before any controller lease or resource reservation. */
export function parseProposerEvolutionConfig(value: unknown): ProposerEvolutionConfig {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new ProposerRefusal();
  const row = value as ProposerEvolutionConfig;
  if (!["candidates,generations,initial,seed,timeout_ms,updates", "candidates,generations,initial,seed,timeout_ms,transfer,updates"].includes(Object.keys(row).sort().join())) throw new ProposerRefusal();
  for (const [key, maximum] of [["generations", 4], ["candidates", 8], ["updates", 512], ["seed", 0xffff_ffff], ["timeout_ms", 1_200_000]] as const) {
    if (!Number.isSafeInteger(row[key]) || row[key] < (key === "seed" ? 0 : 1) || row[key] > maximum) throw new ProposerRefusal();
  }
  if (row.transfer !== undefined) {
    if (row.transfer === null || typeof row.transfer !== "object" || Array.isArray(row.transfer)) throw new ProposerRefusal();
    try {
      assert.equal(Object.keys(row.transfer).sort().join(), "alpha,effect,power", "transfer_design");
      transferPower(0, parseTransferDesign({ ...row.transfer, margin: IMPROVER_CRITERION.effectThreshold, looks: row.generations + 1, targets: TRANSFER_DESIGN.targets }));
    } catch { throw new ProposerRefusal(); }
  }
  const initial = parseProposerProgram(row.initial);
  if (initial.generation + row.generations > 100) throw new ProposerRefusal();
  return { ...row, initial };
}
/** The single preflight path projects only a safe identity and development counts into the process envelope. */
export function proposerProcessInput(identity: string, value: ProposalInvocation): ProcessInput<ProposalExecution> {
  const invocation = parseProposalInvocation(value);
  return { identity: { programme_id: canonicalIdentifier(identity) }, source: { digest: invocation.program.digest, instructions: [] }, training: [], observations: [], training_config: { steps: 0, learning_rate: 0 }, lineage: { development: hashJson(invocation.counts as unknown as JsonValue) }, proposal: invocation };
}
/** Interpret one capability packet in a reserved process with empty ambient credentials. */
export async function executeProposer(client: PmClient, coordinates: ProcessCoordinates, approval: string, identity: string, value: ProposalInvocation, signal?: AbortSignal): Promise<ProposalExecution> {
  const input = proposerProcessInput(identity, value);
  const adapter: ProcessAdapter = { kind: "process-bandit", allowance: PROPOSER_ALLOWANCE };
  try {
    const job = await executeProcessTrainer(client, coordinates, input, approval, adapter, signal, proposerWorkerArgv("."));
    return job.completion!.policy;
  } catch (error) {
    if (isPmCliExpectedError(error)) throw error;
    expectedFail("Proposal process storage or execution is unavailable. Restore tracker and staging access, inspect retained job receipts, then resume recoverable work or use a fresh programme for terminal jobs.", "process_callback_failed");
  }
}
/** Convert typed instructions through the existing recipe validator, preserving every optimizer bound. */
export function proposalLearner(instruction: ProposalInstruction): LearnerConfig {
  instruction = parseProposalInstruction(instruction);
  const arm = initialImprover().arms[instruction.arm].config;
  const recipe = recipeArtifact({ ...INITIAL_RECIPE.knobs, learning_rate: arm.learning_rate, prefix: { ...arm.prefix, ngram_order: instruction.order } });
  return { features: instruction.feature === "inherit" ? arm.features : instruction.feature, learning_rate: recipe.knobs.learning_rate, prefix: recipe.knobs.prefix! };
}
/** Freeze independent tracker units and protected target cohorts before either contender is evaluated. */
export function proposerEvaluationPlan(id: string, incumbent: ProposerProgram, members: readonly { id: string; repo: string; target: string }[], context: string, comparisons: number): EvaluationPlan {
  return parseEvaluationPlan({ format: "pm-rl/evaluation-plan/1", candidate: `${id}-candidate`, incumbent: `${id}-retained`, incumbent_version: incumbent.digest, population: context, selection: "all-declared-tasks", correlation_unit: "tracker", members: members.map((row) => ({ id: row.id, unit: row.repo })), objective: "promoted_tracker_score", objective_version: "1", evaluation_context: context, direction: "maximize", reward_bounds: [0, 1],
    criterion: { ...IMPROVER_CRITERION, confidence: 1 - 0.05 / comparisons }, stopping: { kind: "fixed", observations: members.length, independent_units: new Set(members.map((row) => row.repo)).size },
    protected_cohorts: [...new Set(members.map((row) => row.target))].map((target) => ({ id: target, members: members.filter((row) => row.target === target).map((row) => row.id), min_units: 10, max_regression: 0 })) });
}
/** Persist only a reference to the frozen corpus and exact reconstructed plan; accept historical inline plans on resume.
 * @internal
 */
export async function persistProposerEvaluationPlan(step: RlDurableStep, key: string, input: JsonValue, plan: EvaluationPlan, corpus: string): Promise<EvaluationPlan> {
  const comparison = hashJson(plan as unknown as JsonValue);
  const reference = { format: "pm-rl/proposer-evaluation-plan-reference/1", corpus, comparison };
  const stored = await step(key, input, async () => reference);
  if (hashJson(stored) !== hashJson(reference) && hashJson(stored) !== comparison) expectedFail("Stored proposer evaluation plan differs from its frozen corpus or declaration. Restore the original evidence before resuming.", "proposer_drift");
  return plan;
}
/** A metadata-only artifact cannot promote, even if a caller supplies favorable statistical evidence. */
export function selectProposer(parent: ProposerProgram, candidate: ProposerProgram, before: ProposalExecution, after: ProposalExecution, comparison: EvaluationPlanReport): { retained: ProposerProgram; promoted: boolean; behavior_changed: boolean } {
  parseProposerProgram(parent); parseProposerProgram(candidate);
  if (candidate.parent !== parent.digest || candidate.generation !== parent.generation + 1) throw new ProposerRefusal();
  const behavior_changed = hashJson(parent.code as unknown as JsonValue) !== hashJson(candidate.code as unknown as JsonValue) && before.digest !== after.digest;
  const promoted = behavior_changed && comparison.verdict.decision === "promote";
  return { retained: promoted ? candidate : parent, promoted, behavior_changed };
}
/** Keep the prior executable address across refusals; a successful next generation alone advances lineage. */
export function advanceProposer(lineage: readonly [ProposerProgram, ProposerProgram], selected: ProposerProgram): readonly [ProposerProgram, ProposerProgram] {
  return selected.digest === lineage[1].digest ? lineage : [lineage[1], selected];
}
/** Failed audit or empirical regression restores the exact prior artifact, leaving generation evidence intact. */
export function auditProposer(lineage: readonly [ProposerProgram, ProposerProgram], audit: EvaluationPlanReport): { retained: ProposerProgram; rollback: boolean } {
  const rollback = lineage[1].digest !== lineage[0].digest && audit.verdict.decision !== "promote";
  return { retained: rollback ? lineage[0] : lineage[1], rollback };
}
/** Recoverable lost fits count against the contender; unequal actual optimizer work cannot win a comparison. */
export function compareProposerSearch(plan: EvaluationPlan, before: ProposerSearch, after: ProposerSearch): EvaluationPlanReport {
  const report = evaluatePlan(plan, after.scores.map((score, index) => ({ id: score.id, candidate: score.mean, incumbent: before.scores[index].mean })));
  return before.optimizer_updates === after.optimizer_updates ? report : { ...report, verdict: { decision: "refuse", code: "proposer_budget", reason: "Contenders consumed unequal optimizer updates including recovery attempts." }, remedy: "Retain the prior program; use a fresh predeclared equal-budget comparison." };
}
/** Count recovered work only from a currently readable, supported process identity. */
export function proposerFitUpdates(job: Awaited<ReturnType<typeof readProcessJob>>, updates: number): number {
  const attempt = (job?.binding as { recovery_attempt?: number } | undefined)?.recovery_attempt;
  if (attempt !== 0 && attempt !== 1) expectedFail("Fit recovery accounting is invalid. Inspect the retained process receipts before retrying.", "proposer_budget");
  return (attempt + 1) * updates;
}
/** Classify sealed dataset verification and IO failures without replacing existing typed refusals. */
function proposerDatasetRead<T>(read: () => T): T {
  try { return read(); }
  catch (error) {
    if (isPmCliExpectedError(error)) throw error;
    expectedFail("Proposer dataset could not be read or verified. Restore the original sealed dataset and read access, or use a fresh programme identity.", "proposer_dataset_invalid");
  }
}
/** Reuse verified projections while manifest, role and shard identities remain stable; any change rechecks the full corpus.
 * @internal
 */
export function proposerCorpusReader(directory: string): () => TransferCorpus {
  let cached: { signature: string; corpus: TransferCorpus } | undefined;
  /** Nanosecond ctime also detects same-size edits whose caller restores the prior mtime. */
  const signature = (): string => ["improver-dataset.json", ...IMPROVER_ROLES.map((role) => `${role}.json`), ...readdirSync(directory).filter((name) => /^(development|meta|audit)-[a-f0-9]{64}\.json$/.test(name)).sort()].map((name) => {
    const info = statSync(statePath(directory, name), { bigint: true });
    return `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`;
  }).join("|");
  return () => proposerDatasetRead(() => {
    const before = signature();
    if (cached?.signature === before) return cached.corpus;
    const corpus = loadTransferCorpus(directory);
    assert.equal(signature(), before, "proposer_dataset_changed_during_read");
    cached = { signature: before, corpus }; return corpus;
  });
}
/** Translate approval and retained-capacity verification failures while preserving typed SDK conflicts. */
async function proposerApprovalRead<T>(read: () => Promise<T>): Promise<T> {
  try { return await read(); }
  catch (error) {
    if (isPmCliExpectedError(error)) throw error;
    expectedFail("Proposer approval or retained capacity could not be read or verified. Inspect retained reservations and restore the original approved Decision and capacity receipts, or obtain a valid Decision for a fresh programme.", "proposer_approval");
  }
}
/** Preflight all compartments once to establish bounds and disjoint tracker/item identities before effects. */
function evolutionDataset(directory: string): ImproverDataset {
  const manifest = proposerDatasetRead(() => readImproverDataset(directory)); const seen = new Map<string, string>();
  for (const role of IMPROVER_ROLES) {
    const tasks = proposerDatasetRead(() => readImproverTasks(directory, manifest, role));
    if (tasks.length > 10_000) expectedFail("At most 10000 tasks per compartment are supported. Seal a smaller disjoint corpus before retrying.", "proposer_cohort_limit");
    for (const task of tasks) for (const row of [...task.train, ...task.evaluation]) {
      const prior = seen.get(row.id);
      if (prior !== undefined && prior !== role) expectedFail("An item occurs across compartments. Rebuild disjoint development, meta and audit datasets.", "proposer_contamination");
      seen.set(row.id, role);
    }
  }
  return manifest;
}
/** The execution and preflight paths share deterministic learner slot identities. */
function proposerFitIdentity(id: string, key: string, index: number, slot: number): string {
  return `${id}-j${hashJson(`${key}-t${index}-c${slot}`).slice(0, 12)}`;
}
/** Replace retained slots' planned allowances with their actual charges, leaving unrelated jobs fully charged. */
async function proposerProcessBudget(client: PmClient, approval: string, id: string, config: ProposerEvolutionConfig, manifest: ImproverDataset, worst: Resources): Promise<Resources> {
  const slots = new Map<string, Resources>();
  const searches: { key: string; role: typeof IMPROVER_ROLES[number] }[] = [...Array.from({ length: config.generations }, (_, index) => [
    { key: `g${index + 1}-d`, role: "development" as const },
    { key: `g${index + 1}-b`, role: "meta" as const },
    { key: `g${index + 1}-a`, role: "meta" as const },
  ]).flat(), { key: "audit-b", role: "audit" }, { key: "audit-a", role: "audit" }];
  for (const { key, role } of searches) {
    slots.set(`${id}-${key}`, PROPOSER_ALLOWANCE);
    for (let index = 0; index < manifest.splits[role].tasks; index++) for (let slot = 0; slot < config.candidates; slot++) {
      const identity = proposerFitIdentity(id, key, index, slot);
      for (let attempt = 0; attempt < IMPROVER_MAX_ATTEMPTS; attempt++) slots.set(`${identity}:${attempt}`, IMPROVER_ADAPTER.allowance);
    }
  }
  const totals = Object.fromEntries(RESOURCE_KEYS.map((key) => [key, BigInt(worst[key])])) as Record<typeof RESOURCE_KEYS[number], bigint>;
  for (const job of await processJobsForApproval(client, approval)) {
    const binding = Object(job.binding) as { programme_id?: string; proposal?: { programme_id?: string; dataset?: string }; recovery_attempt?: number };
    const slot = binding.proposal?.dataset === manifest.digest ? `${binding.proposal.programme_id}:${binding.recovery_attempt}` : binding.programme_id;
    const allowance = slot === undefined ? undefined : slots.get(slot);
    const retained = allowance !== undefined && RESOURCE_KEYS.every((key) => job.allowance[key] === allowance[key]);
    for (const key of RESOURCE_KEYS) totals[key] += BigInt(job.charge[key]) - BigInt(retained ? allowance[key] : 0);
    // Each declared slot receives credit at most once, even if another retained job claims the same binding.
    if (retained) slots.delete(slot!);
  }
  return Object.fromEntries(RESOURCE_KEYS.map((key) => [key, Number(totals[key])])) as unknown as Resources;
}
/** Run equal-cost contenders with append-only receipts, SDK revision fencing and a final audit rollback. */
export async function runProposerEvolution(client: PmClient, coordinates: ProcessCoordinates, raw: ProposerEvolutionRequest): Promise<ProposerEvolutionReport> {
  const config = parseProposerEvolutionConfig(raw.config); requireCheckpointStorage();
  if (config.transfer === undefined) expectedFail("transfer_plan_required: Declare transfer.effect, transfer.alpha and transfer.power in a new programme before starting a run.", "transfer_plan_required");
  const design = parseTransferDesign({ ...config.transfer, margin: IMPROVER_CRITERION.effectThreshold, looks: config.generations + 1, targets: TRANSFER_DESIGN.targets });
  const request = await programmeRequest(client, raw); const manifest = evolutionDataset(request.dataset);
  const currentCorpus = proposerCorpusReader(request.dataset); const transferCorpus = currentCorpus();
  for (let look = 1; look <= config.generations; look += 1) {
    if (transferMembers(transferCorpus, "meta", config.generations + 1, look).length === 0) expectedFail(`transfer_underpowered: Meta look ${look} has no tracker. Seal a corpus with at least ${config.generations} meta trackers before starting.`, "transfer_underpowered");
  }
  const approval = await proposerApprovalRead(() => readCompleteLoopItem(client, request.approval));
  if (approval.item.type !== "Decision") expectedFail("Approve the complete resource budget in a Decision before starting.", "proposer_approval");
  const fits = config.candidates * (config.generations * (manifest.splits.development.tasks + 2 * manifest.splits.meta.tasks) + 2 * manifest.splits.audit.tasks);
  // Validate the same plan schema before reservation; later retained digests have the same bounded shape.
  for (let look = 1; look <= config.generations; look += 1) proposerEvaluationPlan(`${request.id}-g${look}`, config.initial, transferMembers(transferCorpus, "meta", config.generations + 1, look), manifest.splits.meta.digest, fits + config.generations + 1);
  proposerEvaluationPlan(`${request.id}-audit`, config.initial, transferCorpus.tasks.audit, manifest.splits.audit.digest, fits + config.generations + 1);
  const budget = { fits, optimizer_updates: fits * config.updates, max_optimizer_updates: fits * config.updates * 2, inference_tokens: 0 as const, proposal_processes: config.generations * 3 + 2 };
  const binding = hashJson({ config: config as unknown as JsonValue, dataset: manifest.digest, approval: approval.item.body as string });
  const capacity = { training_samples: budget.max_optimizer_updates, proposal_calls: budget.proposal_processes, recipe_promotions: config.generations };
  await proposerApprovalRead(() => reserveSearchCapacity(client, coordinates, request, binding, capacity, fits + config.generations, false, true));
  const approved = await proposerApprovalRead(() => approvedResources(client, request.approval));
  const worst = Object.fromEntries(RESOURCE_KEYS.map((key) => [key, fits * IMPROVER_MAX_ATTEMPTS * IMPROVER_ADAPTER.allowance[key] + budget.proposal_processes * PROPOSER_ALLOWANCE[key]])) as unknown as Resources;
  const total = await proposerApprovalRead(() => proposerProcessBudget(client, approved.id, request.id, config, manifest, worst));
  for (const key of RESOURCE_KEYS) {
    if (!Number.isSafeInteger(total[key]) || total[key] > approved.budget[key]) expectedFail(`Approved ${key} budget cannot cover the worst-case proposer run. Obtain capacity before starting.`, "process_budget_exhausted");
  }
  const signal = request.signal ?? AbortSignal.timeout(config.timeout_ms);
  const criterion = { ...IMPROVER_CRITERION, confidence: 1 - 0.05 / (fits + config.generations + 1) };
  const environment = openImproverEnvironment(client, coordinates, request.dataset, manifest, request.approval, config.updates, config.seed, criterion);
  return withRlController(client, coordinates, { ...request, recoveryCommand: `pm rl proposer run ${request.id} --file <config.json> --dataset <dataset> --approval ${request.approval} --force-takeover` }, signal, async (durable) => {
    /** Every resumed phase rechecks current approval and sealed data, while the core revalidates all recorded SDK revisions. */
    const step = async <T>(key: string, input: unknown, operation: () => Promise<T>, verify?: (value: T) => Promise<void>): Promise<T> => {
      /** Revalidation inside the durable callback joins approval/reservation reads to its sealed SDK evidence graph. */
      const validate = async (): Promise<void> => {
        if ((await proposerApprovalRead(() => readCompleteLoopItem(client, request.approval))).item.body !== approval.item.body || currentCorpus().manifest.digest !== manifest.digest) expectedFail("Approval or dataset changed. Restore the original declaration or use a new programme identity.", "proposer_drift");
        if (key !== "programme") await proposerApprovalRead(() => reserveSearchCapacity(client, coordinates, request, binding, capacity, fits + config.generations, true));
      };
      await validate();
      const result = await durable(key, { binding, input: input as JsonValue }, async () => { await validate(); deadline.throwIfAborted(); const value = await operation(); await validate(); return value as unknown as JsonValue; });
      await verify?.(result as unknown as T);
      await request.onStep?.(key); return result as unknown as T;
    };
    let deadline = signal;
    const declared = await step("programme", budget, async () => { await proposerApprovalRead(() => reserveSearchCapacity(client, coordinates, request, binding, capacity, fits + config.generations)); return { expires: Date.now() + config.timeout_ms, budget }; });
    deadline = AbortSignal.any([signal, AbortSignal.timeout(Math.max(0, declared.expires - Date.now()))]);
    const planReceipt = await step("transfer-plan", { corpus: manifest.digest, design }, async () => ({ digest: await recordTransferPlan(client, manifest.digest, design) }), async (receipt) => {
      const plan = await readTransferPlan(client, receipt.digest);
      assert.equal(hashJson(plan as unknown as JsonValue), hashJson({ format: "pm-rl/proposer-transfer-plan/2", corpus: manifest.digest, design } as unknown as JsonValue), "transfer_plan_drift");
    });
    const corpusReceipt = await step("transfer-corpus", { corpus: manifest.digest, plan: planReceipt.digest }, async () => ({ digest: await archiveTransferCorpus(client, transferCorpus) }), async (receipt) => {
      const restored = await replayTransferCorpus(client, receipt.digest);
      verifyTransferCorpus(restored, manifest.digest);
    });
    const corpusAddress = corpusReceipt.digest;
    /** Both fresh selection and replay consume the same digest-addressed native transfer evidence. */
    const transfer = async (role: "meta" | "audit", before: ProposerSearch, after: ProposerSearch, key: string, look = 1) => {
      const incumbent = new Map(before.scores.map((score) => [score.id, score.mean]));
      const pairs = after.scores.map((score) => ({ id: score.id, candidate: score.mean, incumbent: incumbent.get(score.id)! }));
      return step(key, { corpusAddress, pairs, plan: planReceipt.digest, look }, () => recordTransferEvaluation(client, corpusAddress, role, pairs, planReceipt.digest, look), async (receipt) => {
        const report = await replayTransferEvaluation(client, receipt.digest);
        assert.equal(hashJson(report as unknown as JsonValue), hashJson(receipt.report as unknown as JsonValue), "transfer_report_drift");
      });
    };
    let counts: ProposalCounts[] = Array.from({ length: 8 }, (_, arm) => ({ arm, wins: 0, trials: 0 }));
    /** Each search receives identical proposal slots and optimizer updates, starting from the same constant learner. */
    const search = async (role: typeof IMPROVER_ROLES[number], program: ProposerProgram, key: string, look = 1): Promise<ProposerSearch> => {
      const invocation: ProposalInvocation = { program, counts, role: "development", seed: config.seed, count: config.candidates };
      const execution = await step(`${key}-propose`, invocation, () => executeProposer(client, coordinates, request.approval, `${request.id}-${key}`, invocation, deadline), async (cached) => {
        const job = await verifyCompletedProcessJob(client, coordinates.pmRoot, proposerProcessInput(`${request.id}-${key}`, invocation), request.approval, { kind: "process-bandit", allowance: PROPOSER_ALLOWANCE }, proposerWorkerArgv("."));
        if (hashJson(cached as unknown as JsonValue) !== hashJson(job.completion!.policy as unknown as JsonValue)) expectedFail("Cached proposal differs from its verified process completion. Restore original controller and process evidence before resuming.", "process_job_drift");
      });
      const scores: { id: string; mean: number }[] = []; const jobs: string[] = []; const observations = counts.map((row) => ({ ...row })); let optimizerUpdates = 0;
      const selected = role === "development" ? null : new Set(transferMembers(transferCorpus, role, config.generations + 1, look).map((task) => task.id));
      const tasks = proposerDatasetRead(() => environment.tasks(role)).map((task, index) => ({ task, index })).filter(({ task }) => selected === null || selected.has(task.id));
      for (const { index, task } of tasks) {
        const learners: (Awaited<ReturnType<typeof environment.fit>>["retained"] | null)[] = [null]; let mean = 0;
        for (const [slot, instruction] of execution.instructions.entries()) {
          const learnerConfig = proposalLearner(instruction); const name = `${key}-t${index}-c${slot}`; const learner = learners.at(-1)!;
          const trial = await step(name, { config: learnerConfig, curriculum: instruction.curriculum, prior: learner }, () => environment.fit(role, index, learnerConfig, proposerFitIdentity(request.id, key, index, slot), learner, deadline, instruction.curriculum), async (cached) => {
            await environment.fit(role, index, learnerConfig, proposerFitIdentity(request.id, key, index, slot), learner, deadline, instruction.curriculum, cached);
          });
          learners.push(trial.retained); mean = trial.retained_mean; jobs.push(trial.job);
          const job = await readProcessJob(client, trial.job);
          optimizerUpdates += proposerFitUpdates(job, config.updates);
          if (role === "development") { observations[instruction.arm].trials += 1; observations[instruction.arm].wins += Number(trial.promoted); }
        }
        scores.push({ id: task.id, mean });
      }
      return { execution, scores, counts: observations, jobs, optimizer_updates: optimizerUpdates };
    };
    const generations: ProposerGeneration[] = []; let lineage: readonly [ProposerProgram, ProposerProgram] = [config.initial, config.initial];
    for (let generation = 1; generation <= config.generations; generation += 1) {
      const retained = lineage[1];
      const key = `g${generation}`;
      const plan = await persistProposerEvaluationPlan(step, `${key}-plan`, retained.digest, proposerEvaluationPlan(`${request.id}-${key}`, retained, transferMembers(transferCorpus, "meta", config.generations + 1, generation), manifest.splits.meta.digest, fits + config.generations + 1), corpusAddress);
      const development = await search("development", retained, `${key}-d`); counts = [...development.counts];
      const candidate = await step(`${key}-mutation`, { retained, counts }, async () => mutateProposer({ program: retained, counts, role: "development", seed: config.seed, count: config.candidates }));
      const before = await search("meta", retained, `${key}-b`, generation); const after = await search("meta", candidate, `${key}-a`, generation);
      const measured = await transfer("meta", before, after, `${key}-transfer`, generation);
      const comparison = requireProposerTransfer(compareProposerSearch(plan, before, after), measured.report);
      const selection = selectProposer(retained, candidate, before.execution, after.execution, comparison);
      const row = await step(`${key}-selection`, { candidate, comparison, before: before.execution, after: after.execution }, async () => ({ generation, before: retained.digest, candidate, retained: selection.retained.digest, promoted: selection.promoted, behavior_changed: selection.behavior_changed, comparison, transfer: measured }));
      lineage = advanceProposer(lineage, selection.retained);
      generations.push(row);
    }
    const [parent, retained] = lineage;
    const plan = await persistProposerEvaluationPlan(step, "audit-plan", { retained, parent } as unknown as JsonValue, proposerEvaluationPlan(`${request.id}-audit`, parent, proposerDatasetRead(() => environment.tasks("audit")), manifest.splits.audit.digest, fits + config.generations + 1), corpusAddress);
    const before = await search("audit", parent, "audit-b"); const after = await search("audit", retained, "audit-a");
    const measured = await transfer("audit", before, after, "audit-transfer");
    const audit = requireProposerTransfer(compareProposerSearch(plan, before, after), measured.report);
    return step("complete", { retained: retained.digest, audit }, async () => ({ format: "pm-rl/proposer-evolution/1", initial: config.initial.digest, ...auditProposer(lineage, audit), generations, audit, transfer: measured, budget } as ProposerEvolutionReport));
  });
}

/** Transfer qualification is an additional necessary condition; it never relaxes the original gate. */
export function requireProposerTransfer(comparison: EvaluationPlanReport, transfer: TransferReport): EvaluationPlanReport {
  return transfer.passed || comparison.verdict.decision === "refuse" ? comparison : { ...comparison, verdict: { decision: "refuse", code: transfer.reason, reason: "The predeclared tracker transfer comparison failed its power or improvement requirement." }, remedy: "Retain the prior proposer; collect a new independently powered public tracker corpus without tuning the gate." };
}
