import { programmeRequest } from "./state-boundary.ts";
/** Two durable recursion levels: learner promotion, then ledger-trained proposer promotion on disjoint trackers. */
import assert from "node:assert/strict";
import type { PmClient } from "@unbrained/pm-cli/sdk/core";
import { hashJson, readCompleteLoopItem, withRlController, type JsonValue } from "./index.ts";
import { readImproverDataset, type IMPROVER_ROLES, type ImproverDataset } from "./improver-data.ts";
import { initialImprover, parseImprover, proposeLearners, updateImprover, type ImproverPolicy, type ProposalOutcome } from "./improver.ts";
import { compareImprovers, openImproverEnvironment, IMPROVER_CRITERION, IMPROVER_MAX_ATTEMPTS, type ImproverLearner, type LearnerTrial } from "./improver-environment.ts";
import { hoeffdingEpsilon } from "./promotion.ts";
import type { ProcessCoordinates } from "./process.ts";

/** Fixed logical optimizer budget per proposal; the absolute deadline survives process death. */
export interface ImproverConfig { readonly initial: ImproverPolicy; readonly seed: number; readonly generations: number; readonly candidates: number; readonly updates: number; readonly timeout_ms: number }
/** Per-task aggregate results contain no examples or prediction vectors. */
export interface ImproverScore { readonly task: string; readonly repo: string; readonly target: string; readonly mean: number; readonly majority: number; readonly retained_baseline: number; readonly samples: number }
/** Simultaneous score bounds use trackers as units, averaging their two related tasks first. */
export interface ImproverSummary { readonly mean: number; readonly interval: readonly [number, number]; readonly trackers: number; readonly items: number; readonly majority: number; readonly retained: number }
/** Search returns full fit evidence for durable ledger attribution, plus the retained successor per task. */
export interface ImproverSearch { readonly learners: readonly ImproverLearner[]; readonly trials: readonly { readonly task: string; readonly outcome: Omit<ProposalOutcome, "role"> & { readonly role: typeof IMPROVER_ROLES[number] }; readonly trial: LearnerTrial }[]; readonly scores: readonly ImproverScore[] }
/** Every generation retains both proposal-policy artifacts and its equal-budget outer comparison. */
export interface ImproverGeneration {
  readonly generation: number;
  readonly policy: string;
  readonly candidate: ImproverPolicy;
  readonly development: ImproverSearch;
  readonly meta: { readonly before: ImproverSearch; readonly after: ImproverSearch; readonly baseline: ImproverSummary; readonly candidate: ImproverSummary } & ReturnType<typeof compareImprovers>;
  readonly promoted: boolean;
  readonly retained: string;
  readonly any_candidate_beats_train_majority: boolean;
}
/** Audit results are opened once all improver selection steps are committed. */
export interface ImproverReport {
  readonly format: "pm-rl/recursive-improver-report/1";
  readonly dataset: string;
  readonly initial: ImproverPolicy;
  readonly retained: ImproverPolicy;
  readonly generations: readonly ImproverGeneration[];
  readonly audit: { readonly before: ImproverSearch; readonly after: ImproverSearch };
  readonly budget: { readonly fits: number; readonly updates_per_fit: number; readonly optimizer_updates: number; readonly max_process_jobs: number; readonly max_optimizer_updates: number };
}
/** Only the trusted evaluator receives a dataset coordinate; policy functions receive typed artifacts and development outcomes. */
export interface ImproverRequest { readonly id: string; readonly config: ImproverConfig; readonly dataset: string; readonly approval: string; readonly signal?: AbortSignal; readonly forceTakeover?: boolean; readonly onStep?: (key: string) => void | Promise<void> }

/** Default search is bounded to three generations with two equally budgeted candidates each. */
export function improverConfiguration(): ImproverConfig { return { initial: initialImprover(), seed: 42, generations: 3, candidates: 2, updates: 256, timeout_ms: 1_140_000 }; }

/** Refuse expanded compute, unknown knobs or tunable gate criteria before acquiring a controller. */
export function parseImproverConfig(config: ImproverConfig): ImproverConfig {
  assert.deepEqual(Object.keys(config).sort(), ["initial", "seed", "generations", "candidates", "updates", "timeout_ms"].sort(), "improver_programme_fields");
  parseImprover(config.initial);
  for (const [key, min, max] of [["seed", 0, 0xffff_ffff], ["generations", 1, 10], ["candidates", 1, config.initial.arms.length], ["updates", 1, 512], ["timeout_ms", 1, 1_200_000]] as const) assert.ok(Number.isSafeInteger(config[key]) && config[key] >= min && config[key] <= max, `improver_programme_bound: ${key}`);
  return config;
}

/** Predeclare the maximum fits for development, both meta contenders and both final audit contenders. */
export function improverBudget(manifest: ImproverDataset, config: ImproverConfig): ImproverReport["budget"] {
  const fits = config.candidates * (config.generations * (manifest.splits.development.tasks + 2 * manifest.splits.meta.tasks) + 2 * manifest.splits.audit.tasks);
  return { fits, updates_per_fit: config.updates, optimizer_updates: fits * config.updates, max_process_jobs: fits * IMPROVER_MAX_ATTEMPTS, max_optimizer_updates: fits * IMPROVER_MAX_ATTEMPTS * config.updates };
}

/** Bound score estimates at tracker level; item totals are descriptive, never substituted as the meta sample count. */
export function summarizeImproverScores(scores: readonly ImproverScore[], confidence = 0.95): ImproverSummary {
  assert.ok(scores.length > 0, "improver_summary_empty");
  const repos = [...new Set(scores.map((score) => score.repo))];
  /** Average tasks within a tracker before averaging independent tracker units. */
  const average = (key: "mean" | "majority" | "retained_baseline"): number => repos.reduce((total, repo) => {
    const tasks = scores.filter((score) => score.repo === repo);
    return total + tasks.reduce((sum, score) => sum + score[key], 0) / tasks.length;
  }, 0) / repos.length;
  const mean = average("mean"); const epsilon = hoeffdingEpsilon(repos.length, 1, 1 - confidence);
  return { mean, interval: [Math.max(0, mean - epsilon), Math.min(1, mean + epsilon)], trackers: repos.length,
    items: scores.reduce((sum, score) => sum + score.samples, 0), majority: average("majority"), retained: average("retained_baseline") };
}

/** Only the unchanged gate may adopt an updated proposal policy; null or insufficient evidence retains its parent. */
export function selectImprover(policy: ImproverPolicy, candidate: ImproverPolicy, comparison: ReturnType<typeof compareImprovers>): { policy: ImproverPolicy; promoted: boolean } {
  const promoted = comparison.verdict.decision === "promote";
  return { policy: promoted ? candidate : policy, promoted };
}

/** Resume verified phase receipts and process jobs; immutable inputs and the original deadline fence unfinished work. */
export async function runRecursiveImprover(client: PmClient, coordinates: ProcessCoordinates, rawRequest: ImproverRequest): Promise<ImproverReport> {
  const request = await programmeRequest(client, rawRequest);
  assert.ok(/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(request.id) && request.id.length <= 12, "improver_programme_id");
  const config = parseImproverConfig(request.config);
  const manifest = readImproverDataset(request.dataset);
  const approval = await readCompleteLoopItem(client, request.approval);
  assert.equal(approval.item.type, "Decision", "improver_approval_required");
  const approvalBody = String(approval.item.body);
  const binding = hashJson({ receipts: "pm-rl/improver-receipts/4", config: config as unknown as JsonValue, dataset: manifest.digest, approval: String(approval.item.id), approval_body: approvalBody });
  const signal = request.signal ?? AbortSignal.timeout(config.timeout_ms);
  const budget = improverBudget(manifest, config);
  // Allocate the declared error budget across every planned inner fit and outer comparison.
  const innerCriterion = { ...IMPROVER_CRITERION, confidence: 1 - (1 - IMPROVER_CRITERION.confidence) / (budget.fits + config.generations) };
  const environment = openImproverEnvironment(client, coordinates, request.dataset, manifest, request.approval, config.updates, config.seed, innerCriterion);
  return withRlController(client, coordinates, { id: request.id, approval: request.approval, forceTakeover: request.forceTakeover,
    recoveryCommand: `pm rl improver run ${request.id} --file <programme.json> --dataset <dataset-directory> --approval ${request.approval} --force-takeover` }, signal, async (durable) => {
    let deadline: AbortSignal = signal;
    /** Bind every phase to immutable inputs and check the original approval and deadline before unfinished work. */
    const step = async <T>(key: string, input: JsonValue, execute: () => Promise<T>): Promise<T> => {
      assert.equal(String((await readCompleteLoopItem(client, request.approval)).item.body), approvalBody, "improver_approval_drift");
      const value = await durable(key, { binding, input }, async () => { deadline.throwIfAborted(); return await execute() as unknown as JsonValue; });
      await request.onStep?.(key);
      return value as unknown as T;
    };
    const programme = await step("programme", { binding, budget }, async () => ({ expires: Date.now() + config.timeout_ms, policy: config.initial }));
    deadline = AbortSignal.any([signal, AbortSignal.timeout(Math.max(0, programme.expires - Date.now()))]);
    /** Each contender gets exactly K reserved independent fits per task, starting from the same constant learner. */
    const search = async (role: typeof IMPROVER_ROLES[number], policy: ImproverPolicy, generation: number, tag: string, prior: readonly ImproverLearner[] = []): Promise<ImproverSearch> => {
      const scores: ImproverScore[] = []; const learners: ImproverLearner[] = []; const trials: ImproverSearch["trials"][number][] = [];
      for (const [index, task] of environment.tasks(role).entries()) {
        const proposals = await step(`${tag}-t${index}-proposals`, { policy: policy.digest, task: task.id }, async () => ({ configs: proposeLearners(policy, config.seed, generation, task.id, config.candidates) }));
        const incumbents: (ImproverLearner | null)[] = [prior[index] ?? null];
        let last: LearnerTrial | null = null;
        for (const [candidate, learner] of proposals.configs.entries()) {
          const incumbent = incumbents.at(-1)!;
          const key = `${tag}-t${index}-c${candidate}`;
          const trial: LearnerTrial = await step(key, { policy: policy.digest, config: learner as unknown as JsonValue, incumbent: incumbent?.checkpoint.digest ?? null }, async () => {
            return environment.fit(role, index, learner, `${request.id}-j${hashJson(key).slice(0, 12)}`, incumbent, deadline);
          });
          incumbents.push(trial.retained); last = trial;
          trials.push({ task: task.id, outcome: { id: key, role, policy: policy.digest, config: learner, promoted: trial.promoted, gain: trial.gain }, trial });
        }
        learners.push(incumbents.at(-1)!);
        scores.push({ task: task.id, repo: task.repo, target: task.target, mean: last!.retained_mean, majority: last!.majority, retained_baseline: 0.5, samples: last!.samples });
      }
      return { scores, learners, trials };
    };
    const policies = [programme.policy]; let learners: readonly ImproverLearner[] = [];
    const ledger: ProposalOutcome[] = []; const generations: ImproverGeneration[] = [];
    for (let generation = 1; generation <= config.generations; generation += 1) {
      const policy = policies.at(-1)!;
      const development = await search("development", policy, generation, `g${generation}-d`, learners);
      learners = development.learners;
      ledger.push(...development.trials.map(({ outcome }) => { assert.equal(outcome.role, "development", "improver_update_role"); return { ...outcome, role: "development" as const }; }));
      const candidate = await step(`g${generation}-update`, { policy: policy.digest, ledger: ledger as unknown as JsonValue }, async () => updateImprover(policy, ledger, programme.policy));
      const before = await search("meta", policy, generation, `g${generation}-mb`);
      const after = await search("meta", candidate, generation, `g${generation}-ma`);
      const baseline = summarizeImproverScores(before.scores); const candidateSummary = summarizeImproverScores(after.scores);
      const comparison = await step(`g${generation}-promotion`, { policy: policy.digest, candidate: candidate.digest, before: before.scores as unknown as JsonValue, after: after.scores as unknown as JsonValue }, async () => {
        const criterion = { ...IMPROVER_CRITERION, confidence: 1 - (1 - IMPROVER_CRITERION.confidence) / (budget.fits + config.generations) };
        return compareImprovers(candidate.digest, policy.digest, candidateSummary.mean, baseline.mean, baseline.trackers, manifest.splits.meta.digest, criterion);
      });
      const selection = selectImprover(policy, candidate, comparison);
      const row: ImproverGeneration = { generation, policy: policy.digest, candidate, development, meta: { before, after, baseline, candidate: candidateSummary, ...comparison }, promoted: selection.promoted, retained: selection.policy.digest,
        any_candidate_beats_train_majority: [...development.trials, ...before.trials, ...after.trials].some(({ trial }) => trial.diagnostics.beats_train_majority) };
      await step(`g${generation}-generation`, { retained: row.retained }, async () => row);
      generations.push(row);
      policies.push(selection.policy);
    }
    const policy = policies.at(-1)!;
    const before = await search("audit", programme.policy, config.generations + 1, "audit-b");
    const after = await search("audit", policy, config.generations + 1, "audit-a");
    const report: ImproverReport = { format: "pm-rl/recursive-improver-report/1", dataset: manifest.digest, initial: programme.policy, retained: policy, generations, audit: { before, after }, budget };
    return step("complete", { retained: policy.digest }, async () => report);
  });
}
