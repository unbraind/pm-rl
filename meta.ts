/** Durable recipe search over sealed tracker compartments, using the existing trainer and promotion gate. */
import assert from "node:assert/strict";
import type { PmClient } from "@unbrained/pm-cli/sdk/core";
import { certifyCompleteListResult, EXIT_CODE, isPmCliExpectedError } from "@unbrained/pm-cli/sdk/runtime";
import { hashJson, commitProcessTransaction, readCompleteLoopItem, withRlController, type JsonValue, type RlDurableStep } from "./index.ts";
import { openTrackerEnvironment } from "./tracker-environment.ts";
import { parseProcessAdapter, type ProcessAdapter, type ProcessCoordinates } from "./process.ts";
import { decidePromotion, hoeffdingEpsilon, parsePromotionCriterion, type PromotionCriterion, type PromotionEvidence, type PromotionDecision } from "./promotion.ts";
import { parseRecipe, seededRecipes, RECIPE_BOUNDS, type Recipe } from "./recipe.ts";
import { requestSystemOneDecision, calibratedProbabilities } from "./systemone.ts";

/** Immutable programme limits; recipes cannot tune evaluation criteria or approval identity. */
export interface MetaConfig {
  readonly initial_recipe: Recipe;
  readonly seed: number;
  readonly meta_generations: number;
  readonly candidates: number;
  readonly timeout_ms: number;
  readonly criterion: PromotionCriterion;
  readonly maximum_gap: number;
  readonly evaluation_samples: number;
  readonly adapter: ProcessAdapter;
}
/** A fitted policy is interpreted with the temperature of the recipe that produced it. */
export interface RecipePolicy { readonly recipe: Recipe; readonly weight: number; readonly checkpoint: string }
/** Exact-match evidence counts distinct examples, rather than repeated pseudo-replications. */
export interface TrackerScore { readonly mean: number; readonly samples: number; readonly context: string }
/** Aggregate held-out diagnostics expose neither examples nor prediction vectors to search. */
export interface TrackerDiagnostics {
  readonly majority_class: { readonly label: "completed" | "cancelled"; readonly correct: number; readonly samples: number; readonly mean: number };
  readonly predictions: { readonly distinct_labels: number; readonly counts: Readonly<Record<"completed" | "cancelled", number>> };
  readonly disagreements: readonly { readonly recipe: string; readonly differing: number; readonly samples: number; readonly rate: number }[];
}
/** Each comparison retains the actual gate, observed gain and conservative lower confidence bound. */
export interface MetaComparison {
  readonly candidate: RecipePolicy;
  readonly incumbent: string;
  readonly score: TrackerScore;
  readonly gain: number;
  readonly gain_lower_bound: number;
  readonly verdict: PromotionDecision;
}
/** A sealed evaluation augments the gate evidence with descriptive baselines and diversity. */
export interface EvaluatedRecipe extends MetaComparison { readonly diagnostics: TrackerDiagnostics }
/** Final reports expose selection evidence and only then the untouched final-test comparison. */
export interface MetaReport {
  readonly initial: RecipePolicy;
  readonly incumbent: RecipePolicy;
  readonly generations: readonly { readonly generation: number; readonly proposer: string; readonly candidates: readonly EvaluatedRecipe[]; readonly promoted: string | null }[];
  readonly final_test: { readonly before: TrackerScore; readonly after: TrackerScore; readonly diagnostics: TrackerDiagnostics };
  readonly dataset: string;
}
/** Public command request; filesystem coordinates never enter recipe or programme identities. */
export interface MetaRequest {
  readonly id: string;
  readonly config: MetaConfig;
  readonly dataset: string;
  readonly approval: string;
  readonly proposer: "seeded" | "decision-model";
  readonly signal?: AbortSignal;
  /** Loopback endpoint override for real HTTP acceptance fixtures. @internal */
  readonly decisionEndpoint?: string;
  /** Observe committed boundaries for real cancellation and crash drills. @internal */
  readonly onStep?: (key: string) => void | Promise<void>;
}

/** Parse all hard bounds before acquiring a controller or reading a dataset compartment. */
export function parseMetaConfig(value: unknown): MetaConfig {
  const config = value as MetaConfig;
  const initial = parseRecipe(config.initial_recipe);
  for (const [key, max] of [["seed", 0xffff_ffff], ["meta_generations", 10], ["candidates", 8], ["timeout_ms", 900_000], ["evaluation_samples", 100_000]] as const) {
    const minimum = key === "seed" ? 0 : 1;
    assert.ok(Number.isInteger(config[key]) && config[key] >= minimum && config[key] <= max, `meta_bound: ${key}`);
  }
  const criterion = parsePromotionCriterion(config.criterion);
  assert.ok(criterion.effectThreshold > 0 && Number.isFinite(config.maximum_gap) && config.maximum_gap >= 0 && config.maximum_gap <= 1, "meta_criterion");
  const adapter = parseProcessAdapter(config.adapter);
  assert.equal(adapter.kind, "process-bandit", "meta_packaged_process_required");
  return { ...config, initial_recipe: initial, criterion, adapter };
}

/** Read the pre-existing Decision, binding both promotion and resource allowances to its complete body. */
async function metaApproval(client: PmClient, id: string): Promise<{ id: string; digest: string; limits: Record<string, number> }> {
  const item = await readCompleteLoopItem(client, id);
  assert.equal(item.item.type, "Decision", "meta_approval_required");
  const fence = /```json\n([\s\S]+?)\n```/.exec(String(item.item.body));
  assert.ok(fence !== null, "meta_approval_spec");
  const spec = JSON.parse(fence[1]) as { meta_budget: Record<string, number> };
  assert.ok(spec.meta_budget !== null && typeof spec.meta_budget === "object", "meta_budget_required");
  for (const key of ["training_samples", "proposal_calls", "recipe_promotions"]) {
    assert.ok(Number.isSafeInteger(spec.meta_budget[key]) && spec.meta_budget[key] >= 0, "meta_budget_bound");
  }
  return { id: String(item.item.id), digest: hashJson(spec as unknown as JsonValue), limits: spec.meta_budget };
}

/** Parse reservation envelopes independent of JSON spacing; unrelated text cannot charge or conceal an allowance. */
export function metaReservation(body: string): { id: string; approval: string; charge: Record<string, number> } | null {
  if (!body.includes("pm-rl/meta-reservation/1")) return null;
  try {
    const record = JSON.parse(body) as { format: string; id: string; approval: string; charge: Record<string, number> };
    return record.format === "pm-rl/meta-reservation/1" ? record : null;
  } catch { return null; }
}

/** Read only the SDK-canonical receipt identity; unreadable evidence never becomes an absent reservation or intent. */
async function readMetaReceipt(client: PmClient, key: string) {
  try { return await readCompleteLoopItem(client, key); }
  catch (error: unknown) {
    if (isPmCliExpectedError(error) && error.exitCode === EXIT_CODE.NOT_FOUND) return null;
    throw error;
  }
}

/** Atomically hold worst-case search allowances once; interrupted programmes retain their reservation. */
async function reserveMeta(client: PmClient, coordinates: ProcessCoordinates, request: MetaRequest, binding: string): Promise<void> {
  const { config } = request;
  const charge = { training_samples: (1 + config.meta_generations * config.candidates) * RECIPE_BOUNDS.steps[1] * RECIPE_BOUNDS.batch[1],
    proposal_calls: request.proposer === "decision-model" ? 2 * config.meta_generations : 0, recipe_promotions: config.meta_generations };
  const key = `${request.id}-reservation`;
  await commitProcessTransaction({ ...coordinates, transactionId: `${key}-reserve`, steps: [{ id: "reserve",
    async inspect() {
      const previous = await readMetaReceipt(client, key);
      if (previous === null) return { state: "pending" };
      assert.equal(previous.item.type, "Decision", "meta_reservation_drift");
      const record = JSON.parse(String(previous.item.body)) as { format: string; id: string; binding: string; approval: string; charge: JsonValue };
      assert.equal(record.binding, binding, "meta_reservation_drift");
      assert.equal(record.format, "pm-rl/meta-reservation/1", "meta_reservation_drift");
      assert.equal(record.id, key, "meta_reservation_drift");
      assert.equal(record.approval, (await metaApproval(client, request.approval)).id, "meta_reservation_drift");
      assert.equal(hashJson(record.charge), hashJson(charge), "meta_reservation_drift");
      return { state: "applied" };
    },
    async apply() {
      const approval = await metaApproval(client, request.approval);
      const items = certifyCompleteListResult(await client.listAllComplete({ includeBody: false }));
      const charges: Record<string, number>[] = [];
      for (const item of items.items.filter((entry) => entry.type === "Decision" && entry.id.endsWith("-reservation"))) {
        const record = metaReservation(String((await readCompleteLoopItem(client, item.id)).item.body));
        if (record === null) continue;
        const identity = record.id.toLowerCase();
        if ((item.id === identity || item.id.endsWith(`-${identity}`)) && record.approval === approval.id) {
          for (const key of ["training_samples", "proposal_calls", "recipe_promotions"]) {
            assert.ok(Number.isSafeInteger(record.charge[key]) && record.charge[key] >= 0, "meta_reservation_charge");
          }
          charges.push(record.charge);
        }
      }
      for (const key of ["training_samples", "proposal_calls", "recipe_promotions"] as const) {
        const total = charges.reduce((sum, entry) => sum + entry[key], charge[key]);
        assert.ok(Number.isSafeInteger(total) && total <= approval.limits[key], `meta_budget_exhausted: ${key}`);
      }
      await client.create({ id: key, type: "Decision", title: "Reserved bounded recipe search", body: JSON.stringify({ format: "pm-rl/meta-reservation/1", id: key, binding, approval: approval.id, charge }) });
    },
    // Conservative reservations survive transaction recovery and are never refunded by search itself.
    async compensate() {},
  }] });
}

/** Numerical task helpers are shared with the sealed evaluator, without granting search a data reader. */
export { recipeExamples, scoreTrackerPolicy } from "./tracker-environment.ts";

/** Apply the unchanged fail-closed statistical gate to recipe selection, never to proxy reward. */
export function compareRecipes(candidate: RecipePolicy, incumbent: RecipePolicy, score: TrackerScore, baseline: TrackerScore, criterion: PromotionCriterion): MetaComparison {
  /** Convert sealed exact-match measurements into the existing bounded-evidence contract. */
  const evidence = (policy: RecipePolicy, value: TrackerScore): PromotionEvidence => ({ generation: policy.recipe.digest,
    objective: "terminal_disposition_exact_match", objective_version: "1", evaluation_context: value.context,
    direction: "maximize", mean: value.mean, samples: value.samples, rewardBounds: [0, 1] });
  const verdict = decidePromotion({ candidate: evidence(candidate, score), incumbent: evidence(incumbent, baseline), criterion,
    contaminationPath: null, expectedGeneration: candidate.recipe.digest });
  const gain = score.mean - baseline.mean;
  const alpha = 1 - criterion.confidence;
  return { candidate, incumbent: incumbent.recipe.digest, score, gain,
    gain_lower_bound: gain - hoeffdingEpsilon(score.samples, 1, alpha) - hoeffdingEpsilon(baseline.samples, 1, alpha), verdict };
}

/** Select only a gate-approved recipe, preferring the largest conservative improvement and retaining an unchallenged incumbent. */
export function recipeSuccessor(incumbent: RecipePolicy, candidates: readonly MetaComparison[]): { successor: RecipePolicy; promoted: string | null } {
  const eligible = candidates.filter((candidate) => candidate.verdict.decision === "promote").sort((a, b) => b.gain_lower_bound - a.gain_lower_bound);
  return { successor: eligible.length === 0 ? incumbent : eligible[0].candidate, promoted: eligible.length === 0 ? null : eligible[0].candidate.recipe.digest };
}

/** Optionally let the local calibrated decision adapter rank a seeded pool; unavailable models preserve seeded search. @internal */
export async function proposeRecipes(request: Pick<MetaRequest, "config" | "proposer" | "decisionEndpoint">, incumbent: Recipe, generation: number, signal: AbortSignal): Promise<{ recipes: Recipe[]; proposer: string }> {
  const pool = seededRecipes(incumbent, request.config.seed, generation, request.config.candidates);
  if (request.proposer === "seeded") return { recipes: pool, proposer: "seeded" };
  const baseURL = request.decisionEndpoint ?? "http://127.0.0.1:11434";
  assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(new URL(baseURL).hostname), "meta_local_proposer_required");
  try {
    const response = await fetch(`${baseURL}/api/tags`, { signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]) });
    const tags = await response.json() as { models: { name: string; remote_host?: string; remote_model?: string }[] };
    assert.ok(response.ok && tags.models.some((model) => model.name === "tev1:4b" && model.remote_host === undefined && model.remote_model === undefined), "meta_model_unavailable");
    const ranked = [...pool, ...seededRecipes(incumbent, request.config.seed ^ 0x85ebca6b, generation, request.config.candidates)];
    const criteria = Object.fromEntries(ranked.map((recipe) => [recipe.digest, JSON.stringify(recipe.knobs)]));
    const result = await requestSystemOneDecision({ baseURL, model: "tev1:4b", timeoutMs: 5000 }, JSON.stringify({ incumbent: incumbent.knobs, generation }),
      [{ name: "recipe", instructions: "Rank these bounded training recipes for terminal disposition prediction. No evaluation data is available.", criteria }], signal);
    const probabilities = calibratedProbabilities(result.answers.recipe, 0, Object.fromEntries(ranked.map((recipe) => [recipe.digest, 0])));
    ranked.sort((a, b) => probabilities[b.digest] - probabilities[a.digest] || a.digest.localeCompare(b.digest));
    return { recipes: ranked.slice(0, request.config.candidates), proposer: "decision-model" };
  } catch {
    signal.throwIfAborted();
    return { recipes: pool, proposer: "seeded:model-unavailable" };
  }
}

/** Persist a single inference intent; an unresolved attempt resumes with seeded recipes instead of spending twice. @internal */
export async function durableRecipeProposals(client: PmClient, id: string, request: Pick<MetaRequest, "config" | "proposer" | "decisionEndpoint">, incumbent: Recipe, generation: number, signal: AbortSignal): Promise<{ recipes: Recipe[]; proposer: string }> {
  if (request.proposer === "seeded") return proposeRecipes(request, incumbent, generation, signal);
  const key = `${id}-m${generation}-proposal-attempt`;
  const binding = hashJson({ config: request.config as unknown as JsonValue, incumbent: incumbent.digest, generation, endpoint: request.decisionEndpoint ?? "http://127.0.0.1:11434" });
  const previous = await readMetaReceipt(client, key);
  if (previous !== null) {
    assert.equal(previous.item.type, "Decision", "meta_proposal_drift");
    const record = JSON.parse(String(previous.item.body)) as { id: string; binding: string; state: string; result: { recipes: Recipe[]; proposer: string }; digest: string };
    assert.equal(record.id, key, "meta_proposal_drift");
    assert.equal(record.binding, binding, "meta_proposal_drift");
    if (record.state === "complete") {
      assert.equal(hashJson(record.result as unknown as JsonValue), record.digest, "meta_proposal_receipt");
      for (const recipe of record.result.recipes) parseRecipe(recipe);
      return record.result;
    }
    assert.equal(record.state, "intent", "meta_proposal_state");
    return { recipes: seededRecipes(incumbent, request.config.seed, generation, request.config.candidates), proposer: "seeded:unresolved-model-attempt" };
  }
  await client.create({ id: key, type: "Decision", title: "Bounded local recipe inference intent", body: JSON.stringify({ id: key, binding, state: "intent" }) });
  const result = await proposeRecipes(request, incumbent, generation, signal);
  await client.update(key, { body: JSON.stringify({ id: key, binding, state: "complete", result, digest: hashJson(result as unknown as JsonValue) }) });
  return result;
}

/** Search and promote recipes with one shared approval; completion receipts adopt inner jobs after interruption. */
export async function runRlMeta(client: PmClient, coordinates: ProcessCoordinates, request: MetaRequest): Promise<MetaReport> {
  assert.ok(/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(request.id) && request.id.length <= 20, "meta_programme_id");
  const config = parseMetaConfig(request.config);
  assert.ok(request.proposer === "seeded" || request.proposer === "decision-model", "meta_proposer");
  const signal = request.signal === undefined ? AbortSignal.timeout(config.timeout_ms) : AbortSignal.any([request.signal, AbortSignal.timeout(config.timeout_ms)]);
  const environment = openTrackerEnvironment(client, coordinates, request.dataset, config, request.approval);
  const proposalRequest = { config, proposer: request.proposer, decisionEndpoint: request.decisionEndpoint };
  const approval = await metaApproval(client, request.approval);
  const input = { format: "pm-rl/meta-programme/1", id: request.id, config: config as unknown as JsonValue, dataset: environment.digest, approval_id: approval.id, approval: approval.digest,
    proposer: request.proposer, endpoint: request.decisionEndpoint ?? "http://127.0.0.1:11434" };
  const binding = hashJson(input);
  return withRlController(client, coordinates, request.id, signal, async (durable) => {
    /** Verify approval identity at every boundary, and notify observers only after the receipt is durable. */
    const step: RlDurableStep = async (key, value, execute) => {
      assert.equal((await metaApproval(client, request.approval)).digest, approval.digest, "meta_budget_drift");
      const result = await durable(key, { binding, value }, execute);
      await request.onStep?.(key);
      return result;
    };
    await step("programme", input, async () => { await reserveMeta(client, coordinates, request, binding); return input; });
    const initial = await step("initial", { recipe: config.initial_recipe.digest }, async () =>
      await environment.fit(config.initial_recipe, `${request.id}-initial`, signal) as unknown as JsonValue) as unknown as RecipePolicy;
    const incumbents = [initial];
    const generations: MetaReport["generations"][number][] = [];
    for (let generation = 1; generation <= config.meta_generations; generation += 1) {
      const incumbent = incumbents.at(-1)!;
      const proposals = await step(`m${generation}-proposals`, { incumbent: incumbent.recipe.digest }, async () =>
        await durableRecipeProposals(client, request.id, proposalRequest, incumbent.recipe, generation, signal) as unknown as JsonValue) as unknown as Awaited<ReturnType<typeof proposeRecipes>>;
      const candidates: EvaluatedRecipe[] = [];
      for (const [index, recipe] of proposals.recipes.entries()) {
        const policy = await step(`m${generation}-c${index}`, { recipe: recipe.digest }, async () =>
          await environment.fit(recipe, `${request.id}-m${generation}-c${index}`, signal) as unknown as JsonValue) as unknown as RecipePolicy;
        const comparison = await step(`m${generation}-score${index}`, { candidate: policy.checkpoint, incumbent: incumbent.recipe.digest }, async () => {
          const { score, baseline, diagnostics } = environment.selection(policy, incumbent, [...generations.flatMap((previous) => previous.candidates), ...candidates].map((previous) => previous.candidate));
          // Allocate family-wise error across all planned comparisons; search cannot relax the declared gate.
          const criterion = { ...config.criterion, confidence: 1 - (1 - config.criterion.confidence) / (config.meta_generations * config.candidates) };
          return { ...compareRecipes(policy, incumbent, score, baseline, criterion), diagnostics } as unknown as JsonValue;
        }) as unknown as EvaluatedRecipe;
        candidates.push(comparison);
      }
      const promoted = await step(`m${generation}-promote`, { incumbent: incumbent.recipe.digest, candidates: candidates as unknown as JsonValue }, async () => {
        return recipeSuccessor(incumbent, candidates) as unknown as JsonValue;
      }) as unknown as { successor: RecipePolicy; promoted: string | null };
      incumbents.push(promoted.successor);
      generations.push({ generation, proposer: proposals.proposer, candidates, promoted: promoted.promoted });
    }
    const incumbent = incumbents.at(-1)!;
    const final = await step("final-test", { before: initial.checkpoint, after: incumbent.checkpoint, recipe: incumbent.recipe.digest }, async () => {
      return environment.finalTest(initial, incumbent) as unknown as JsonValue;
    }) as unknown as MetaReport["final_test"];
    const report: MetaReport = { initial, incumbent, generations, final_test: final, dataset: environment.digest };
    await step("complete", { report: report as unknown as JsonValue }, async () => {
      await client.update(`${request.id}-step-programme`, { comment: [`Loop ${request.id} terminal report: bounded recipe search complete.`] });
      return { report: report as unknown as JsonValue };
    });
    return report;
  });
}
