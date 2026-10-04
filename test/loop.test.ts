/** The persisted recursive loop: pure bounds, derived successor configs, and end-to-end tracker runs. */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { PmClient } from "@unbrained/pm-cli/sdk/core";
import type { CommandHandlerContext } from "@unbrained/pm-cli/sdk/authoring";
import { init, EXIT_CODE, isPmCliExpectedError } from "@unbrained/pm-cli/sdk/runtime";
import { createExtensionTestHarness, type ExtensionTestHarness } from "@unbrained/pm-cli/sdk/testing";

import type { JsonValue } from "../index.ts";

import extension, {
  hashJson,
  runRlLoop,
  RL_ITEM_TYPES,
  type RlCommandResult,
  type RlLoopReport,
} from "../index.ts";

import { banditCheckpoint, type BanditGeneration } from "../bandit.ts";
import { parseGenerationSpec, parseScoreRecord } from "../lineage.ts";
import {
  collectionMetricEvents,
  deriveNextStepConfig,
  generationTrainingConfig,
  loopEnvironmentSpec,
  loopPromotionScores,
  MAX_LOOP_BUDGET,
  MAX_LOOP_EVALUATION_SAMPLES,
  MAX_LOOP_GENERATIONS,
  MIN_LOOP_LEARNING_RATE,
  parseLoopConfig,
  runLoopGeneration,
  seedTrainingConfig,
  stepSeed,
  type LoopConfig,
  type LoopStepConfig,
} from "../loop.ts";

const roots: string[] = [];

after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

/**
 * The built-in deterministic loop fixture: a two-action contextual bandit whose
 * training and held-out examples are disjoint and whose per-generation
 * held-out improvement clears the strictly-better promotion gate.
 */
const LOOP_CONFIG: JsonValue = {
  environment: { name: "Loop bandit", version: "1" },
  training: [
    { id: "train-positive", feature: 1, rewards: [0, 1] },
    { id: "train-negative", feature: -1, rewards: [1, 0] },
  ],
  evaluation: [
    { id: "eval-positive", feature: 0.8, rewards: [0, 1] },
    { id: "eval-negative", feature: -0.8, rewards: [1, 0] },
  ],
  initial_weight: 0,
  seed: 42,
  max_generations: 3,
  samples_per_generation: 256,
  budget: 768,
  learning_rate: 0.5,
  minimum_improvement: 0.01,
  maximum_gap: 0.2,
  evaluation_samples: 40000,
  confidence: 0.95,
  min_samples: 10,
};

/** Write one JSON document and return its path. */
function writeJson(root: string, name: string, value: unknown): string {
  const path = join(root, name);
  writeFileSync(path, JSON.stringify(value));
  return path;
}

/** Create a real initialized tracker, persist the public schema, and activate the extension. */
async function workspace(): Promise<{
  root: string;
  pmRoot: string;
  client: PmClient;
  harness: ExtensionTestHarness;
}> {
  const root = mkdtempSync(join(tmpdir(), "pm-rl-loop-test-"));
  roots.push(root);
  const initialized = await init("rl", { defaults: true, author: "pm-rl-test", agentGuidance: "skip" }, { cwd: root });
  const client = new PmClient({ pmRoot: initialized.path, author: "pm-rl-test" });
  for (const itemType of RL_ITEM_TYPES) {
    await client.schemaAddType(itemType.name, {
      folder: itemType.folder,
      alias: [...(itemType.aliases ?? [])],
      description: itemType.description,
      defaultStatus: itemType.default_status,
    });
  }
  const harness = await createExtensionTestHarness(extension, { name: "pm-rl", capabilities: ["commands", "hooks", "schema"] });
  assert.deepEqual(harness.activation.failed, []);
  return { root, pmRoot: initialized.path, client, harness };
}

/** Extract a successful structured command result. */
function resultOf(run: { result?: unknown; handled: boolean }): RlCommandResult {
  assert.equal(run.handled, true, JSON.stringify(run));
  return run.result as RlCommandResult;
}

/** Create the approval Decision that bounds a loop's promotions. */
async function createApproval(client: PmClient, id: string, permittedPromotions: number): Promise<string> {
  const approval = await client.create({
    id,
    title: id,
    type: "Decision",
    status: "open",
    body: `# ${id}\n\n\`\`\`json\n${JSON.stringify({ permitted_promotions: permittedPromotions })}\n\`\`\``,
  });
  return String(approval.item.id);
}

/** Run one loop through the public command and return its structured report. */
async function runLoopCommand(harness: ExtensionTestHarness, pmRoot: string, root: string, id: string, config: JsonValue, approval: string): Promise<RlLoopReport> {
  const file = writeJson(root, `${id}.json`, config);
  const run = resultOf(await harness.runCommand({ command: "rl loop run", pmRoot, args: [id], options: { file, approval } }));
  return run.details as unknown as RlLoopReport;
}

/** Extract the JSON fence from one stored generation body and parse it as a spec. */
function generationSpecOf(body: string): ReturnType<typeof parseGenerationSpec> {
  const fenced = /```json\n([\s\S]+?)\n```/.exec(body);
  assert.ok(fenced?.[1] !== undefined, "generation body has no JSON specification fence");
  return parseGenerationSpec(fenced[1], "generation body");
}

/** Replay the fixture loop purely in memory, returning each generation receipt and the step config that produced it. */
function replayLoop(config: LoopConfig): { receipts: BanditGeneration[]; steps: LoopStepConfig[] } {
  const receipts: BanditGeneration[] = [];
  const steps: LoopStepConfig[] = [];
  let step = { learningRate: config.learningRate, evaluationSamples: config.evaluationSamples };
  let current = banditCheckpoint(config.initialWeight);
  for (let generation = 1; generation <= config.maxGenerations; generation += 1) {
    steps.push(step);
    const receipt = runLoopGeneration(config, step, generation, current);
    receipts.push(receipt);
    current = receipt.candidate;
    step = deriveNextStepConfig(config, step, receipt.candidateHeldOutMean - receipt.incumbentHeldOutMean);
  }
  return { receipts, steps };
}

/** Hold real SDK creates until every caller has reached the same creation boundary. */
function synchronizeCreates(clients: readonly PmClient[], itemType: string): void {
  let release!: () => void;
  const ready = new Promise<void>((resolve) => { release = resolve; });
  let arrivals = 0;
  for (const client of clients) {
    const create = client.create.bind(client);
    client.create = async (options) => {
      if (options?.type === itemType) {
        arrivals += 1;
        if (arrivals === clients.length) release();
        await ready;
      }
      return create(options);
    };
  }
}

/** Insert a real competing SDK create immediately before the selected original create. */
function insertCompetingCreate(client: PmClient, target: (options: NonNullable<Parameters<PmClient["create"]>[0]>) => boolean, change: (options: NonNullable<Parameters<PmClient["create"]>[0]>) => NonNullable<Parameters<PmClient["create"]>[0]>): void {
  const create = client.create;
  client.create = async function (this: PmClient, options) {
    if (options !== undefined && target(options)) {
      client.create = create;
      await create.call(this, change(options));
    }
    return create.call(this, options);
  };
}

test("parseLoopConfig validates the complete bounded loop configuration", () => {
  const config = parseLoopConfig(LOOP_CONFIG);
  assert.equal(config.environmentName, "Loop bandit");
  assert.equal(config.environmentVersion, "1");
  assert.equal(config.maxGenerations, 3);
  assert.equal(config.samplesPerGeneration, 256);
  assert.equal(config.budget, 768);
  assert.equal(config.minimumImprovement, 0.01);
  assert.equal(config.training.length, 2);
  assert.equal(config.evaluation.length, 2);
  assert.match(config.trainingDigest, /^sha256:[a-f0-9]{64}$/);
  assert.match(config.evaluationDigest, /^sha256:[a-f0-9]{64}$/);
  assert.notEqual(config.trainingDigest, config.evaluationDigest);
  // The programme identity is content-addressed over the whole configuration.
  assert.equal(config.digest, parseLoopConfig(LOOP_CONFIG).digest);
  assert.notEqual(config.digest, parseLoopConfig({ ...LOOP_CONFIG, seed: 43 }).digest);
});

test("the seed retains the complete programme bounds for replay", () => {
  const config = parseLoopConfig(LOOP_CONFIG);
  const seed = seedTrainingConfig(config) as Record<string, JsonValue>;
  assert.equal(parseLoopConfig(seed.configuration).digest, config.digest);
});

test("parseLoopConfig refuses every missing, mistyped or out-of-bounds field", () => {
  const cases: Array<[Partial<Record<string, unknown>>, RegExp]> = [
    [{ environment: null }, /must contain one JSON object/],
    [{ environment: {} }, /requires a non-empty string name/],
    [{ environment: { name: "x" } }, /requires a non-empty string version/],
    [{ training: null }, /training must be an array/],
    [{ evaluation: "nope" }, /evaluation must be an array/],
    [{ initial_weight: null }, /requires a finite number initial_weight/],
    [{ initial_weight: 21 }, /initial_weight/],
    [{ initial_weight: -21 }, /initial_weight/],
    [{ seed: -1 }, /seed/],
    [{ seed: 2 ** 32 }, /seed/],
    [{ seed: 0.5 }, /seed/],
    [{ max_generations: 0 }, /max_generations/],
    [{ max_generations: MAX_LOOP_GENERATIONS + 1 }, /max_generations/],
    [{ max_generations: 1.5 }, /max_generations/],
    [{ samples_per_generation: 0 }, /samples_per_generation/],
    [{ samples_per_generation: 0.5 }, /samples_per_generation/],
    [{ budget: 128 }, /budget/],
    [{ budget: MAX_LOOP_BUDGET + 1 }, /budget/],
    [{ budget: 100.5 }, /budget/],
    [{ learning_rate: MIN_LOOP_LEARNING_RATE / 10 }, /learning_rate/],
    [{ learning_rate: 1.1 }, /learning_rate/],
    [{ minimum_improvement: 0 }, /minimum_improvement/],
    [{ minimum_improvement: -0.01 }, /minimum_improvement/],
    [{ maximum_gap: -0.1 }, /maximum_gap/],
    [{ evaluation_samples: 0 }, /evaluation_samples/],
    [{ evaluation_samples: MAX_LOOP_EVALUATION_SAMPLES + 1 }, /evaluation_samples/],
    [{ confidence: 0 }, /confidence/],
    [{ confidence: 1 }, /confidence/],
    [{ min_samples: 0 }, /min_samples/],
    [{ min_samples: 2.5 }, /min_samples/],
  ];
  for (const [change, pattern] of cases) {
    assert.throws(() => parseLoopConfig({ ...LOOP_CONFIG, ...change } as JsonValue), pattern, JSON.stringify(change));
  }
  // Non-object and dataset refusals carry their own codes.
  assert.throws(() => parseLoopConfig([1, 2] as unknown as JsonValue), /must contain one JSON object/);
  assert.throws(() => parseLoopConfig({ ...LOOP_CONFIG, training: [] }), /Loop configuration datasets are invalid/);
  const training = (LOOP_CONFIG as Record<string, unknown>)["training"];
  assert.throws(() => parseLoopConfig({ ...LOOP_CONFIG, evaluation: training } as JsonValue), /Loop configuration datasets are invalid/);
});

test("the built-in environment spec carries both disjoint datasets and the reward contract", () => {
  const spec = loopEnvironmentSpec(parseLoopConfig(LOOP_CONFIG));
  assert.equal(spec.name, "Loop bandit");
  assert.equal(spec.version, "1");
  const suite = spec.task_suite as { collection: unknown[]; held_out: unknown[] };
  assert.equal(suite.collection.length, 2);
  assert.equal(suite.held_out.length, 2);
  assert.equal(hashJson(spec as unknown as JsonValue), hashJson(loopEnvironmentSpec(parseLoopConfig(LOOP_CONFIG)) as unknown as JsonValue));
});

test("collection seeds are deterministic per generation and never collide with the base seed stream", () => {
  assert.equal(stepSeed(42, 1), (Math.imul(1, 0x9e3779b1) + 42 + 0x85ebca6b) >>> 0);
  assert.equal(stepSeed(42, 1), stepSeed(42, 1));
  assert.notEqual(stepSeed(42, 1), stepSeed(42, 2));
  assert.notEqual(stepSeed(42, 1), 42);
});

test("collection and held-out action streams differ and replay deterministically", () => {
  for (const generation of [1, 2, 3]) {
    const replays: BanditGeneration[][] = [];
    for (let replay = 0; replay < 2; replay += 1) {
      const receipts: BanditGeneration[] = [];
      for (let index = 0; index < 64; index += 1) {
        const seed = Math.imul(index, 0x9e3779b1) >>> 0;
        // Feature zero keeps both policies at weight zero; reward exposes the
        // sampled action, so all three streams have the same decision boundary.
        const config = parseLoopConfig({ ...LOOP_CONFIG, seed,
          training: [{ id: "collect", feature: 0, rewards: [0, 1] }],
          evaluation: [{ id: "held-out", feature: 0, rewards: [0, 1] }],
          samples_per_generation: 1, evaluation_samples: 1, min_samples: 1 });
        receipts.push(runLoopGeneration(config, { learningRate: config.learningRate, evaluationSamples: 1 }, generation, banditCheckpoint(0)));
      }
      replays.push(receipts);
    }
    assert.deepEqual(replays[0], replays[1]);
    const collection = replays[0].map((receipt) => receipt.observations[0].action);
    const incumbent = replays[0].map((receipt) => receipt.incumbentHeldOutMean);
    const candidate = replays[0].map((receipt) => receipt.candidateHeldOutMean);
    assert.notDeepEqual(collection, incumbent, "collection must not alias incumbent draws");
    assert.notDeepEqual(collection, candidate, "collection must not alias candidate draws");
    assert.notDeepEqual(incumbent, candidate, "held-out policies must not alias draws");
  }
});

test("evaluation results derive the next generation's training and evaluation configuration", () => {
  const config = parseLoopConfig(LOOP_CONFIG);
  const initial = { learningRate: config.learningRate, evaluationSamples: config.evaluationSamples };
  assert.deepEqual(initial, { learningRate: 0.5, evaluationSamples: 40000 });
  // Weak progress halves the learning rate, floored at the declared minimum;
  // the Hoeffding width at 40000 episodes is ~0.0068, so 0.011 already resolves.
  const weak = deriveNextStepConfig(config, initial, 0.011);
  assert.equal(weak.learningRate, 0.25);
  assert.equal(weak.evaluationSamples, 40000);
  // A small positive improvement the gate could not resolve doubles the next
  // evaluation budget, because more evidence is the only honest way to try.
  const unresolved = deriveNextStepConfig(config, initial, 0.003);
  assert.equal(unresolved.learningRate, 0.25);
  assert.equal(unresolved.evaluationSamples, 80000);
  // Strong progress keeps the learning rate and the sample count.
  const strong = deriveNextStepConfig(config, initial, 0.05);
  assert.equal(strong.learningRate, 0.5);
  assert.equal(strong.evaluationSamples, 40000);
  // A non-improvement never buys more evaluation episodes.
  const flat = deriveNextStepConfig(config, initial, 0);
  assert.equal(flat.learningRate, 0.25);
  assert.equal(flat.evaluationSamples, 40000);
  // The floor stops the schedule at the declared minimum learning rate.
  const bottom = deriveNextStepConfig(config, { learningRate: 0.01, evaluationSamples: 40000 }, 0);
  assert.equal(bottom.learningRate, MIN_LOOP_LEARNING_RATE);
  // The evaluation budget stops at the adapter's declared maximum.
  const capped = deriveNextStepConfig(config, { learningRate: 0.5, evaluationSamples: MAX_LOOP_EVALUATION_SAMPLES }, 0.0001);
  assert.equal(capped.evaluationSamples, MAX_LOOP_EVALUATION_SAMPLES);
});

test("runLoopGeneration replays the deterministic collect-train-evaluate step exactly", () => {
  const config = parseLoopConfig(LOOP_CONFIG);
  const { receipts } = replayLoop(config);
  assert.equal(receipts.length, 3);
  for (const receipt of receipts) {
    assert.equal(receipt.promoted, true);
    assert.equal(receipt.refusalReason, null);
    assert.ok(receipt.candidate.weight > receipt.source.weight);
    assert.ok(receipt.candidateHeldOutMean > receipt.incumbentHeldOutMean);
    assert.equal(receipt.observations.length, config.samplesPerGeneration);
  }
  assert.equal(receipts[1].source.digest, receipts[0].candidate.digest);
  assert.equal(receipts[2].source.digest, receipts[1].candidate.digest);
  // Deterministic: the same inputs replay the same receipts byte for byte.
  assert.deepEqual(replayLoop(config).receipts, receipts);
});

test("a regressing evaluation set refuses the first generation without any promotion", () => {
  const config = parseLoopConfig({ ...LOOP_CONFIG, evaluation: [{ id: "opposite", feature: 1, rewards: [1, 0] }] });
  const receipt = runLoopGeneration(config, { learningRate: config.learningRate, evaluationSamples: config.evaluationSamples }, 1, banditCheckpoint(config.initialWeight));
  assert.equal(receipt.promoted, false);
  assert.equal(receipt.stopReason, "evaluation_rejected");
  assert.match(receipt.refusalReason!, /statistically better/);
});

test("lucky sampled evaluation cannot promote a truly regressing policy", async () => {
  const { root, pmRoot, client, harness } = await workspace();
  const approval = await createApproval(client, "lucky-approval", 10);
  const raw = { ...LOOP_CONFIG, seed: 2, evaluation: [{ id: "reverse", feature: 1, rewards: [1, 0] }],
    maximum_gap: 1, evaluation_samples: 10, min_samples: 1, confidence: 0.001, minimum_improvement: 0.001 };
  const config = parseLoopConfig(raw);
  const receipt = runLoopGeneration(config, { learningRate: config.learningRate, evaluationSamples: config.evaluationSamples }, 1, banditCheckpoint(0));
  assert.equal(receipt.candidateHeldOutMean, 0.9);
  assert.equal(receipt.incumbentHeldOutMean, 0.4);
  assert.equal(receipt.evaluationScore, 0.46781798872397673);
  assert.ok(receipt.candidateHeldOutMean > receipt.incumbentHeldOutMean, "fixture must have lucky candidate samples");
  assert.ok(receipt.evaluationScore < receipt.baselineScore, "the actual policy must regress");
  const report = await runLoopCommand(harness, pmRoot, root, "lucky", raw, approval);
  assert.equal(report.promoted, 0);
  assert.equal(report.stop_reason, "evaluation_rejected");
  assert.equal(report.final_checkpoint, banditCheckpoint(0).digest);
});

test("collection observations become ordered, tagged, merge-safe metric events", () => {
  const config = parseLoopConfig(LOOP_CONFIG);
  const receipt = runLoopGeneration(config, { learningRate: config.learningRate, evaluationSamples: config.evaluationSamples }, 1, banditCheckpoint(config.initialWeight));
  const events = collectionMetricEvents(receipt);
  assert.equal(events.length, config.samplesPerGeneration);
  assert.deepEqual(events.map((event) => event.step), Array.from({ length: events.length }, (_value, index) => index));
  assert.ok(events.every((event) => event.metric === "collection_reward"));
  assert.ok(events.every((event) => event.value >= 0 && event.value <= 1));
  assert.ok(events.every((event) => typeof event.tags?.example === "string" && ["0", "1"].includes(event.tags.action)));
});

test("promotion scores, seed and generation training configs are validated by the real parsers", () => {
  const config = parseLoopConfig(LOOP_CONFIG);
  const step = { learningRate: config.learningRate, evaluationSamples: config.evaluationSamples };
  const receipt = runLoopGeneration(config, step, 1, banditCheckpoint(config.initialWeight));
  const scores = loopPromotionScores(config, step, 1, receipt);
  assert.equal(parseScoreRecord(scores.proxy_score, "proxy_score").value, receipt.trainingScore);
  const heldOut = parseScoreRecord(scores.held_out_score, "held_out_score");
  assert.equal(heldOut.value, receipt.candidateHeldOutMean);
  assert.equal(heldOut.evaluation_context, config.evaluationDigest);
  assert.equal(heldOut.direction, "maximize");
  const trainingConfig = generationTrainingConfig(config, step, 1, receipt) as Record<string, unknown>;
  assert.equal(trainingConfig.generation, 1);
  assert.equal(trainingConfig.learning_rate, 0.5);
  assert.equal(trainingConfig.candidate_checkpoint, receipt.candidate.digest);
  assert.equal(trainingConfig.collection_digest, receipt.collectionDigest);
  const seedConfig = seedTrainingConfig(config) as Record<string, unknown>;
  assert.equal(seedConfig.programme, config.digest);
  assert.equal(seedConfig.initial_weight, config.initialWeight);
});

test("pm rl loop run executes the bounded loop end to end and promotes every generation", async () => {
  const { root, pmRoot, client, harness } = await workspace();
  const approval = await createApproval(client, "loop-approval", 10);
  const report = await runLoopCommand(harness, pmRoot, root, "loop-a", LOOP_CONFIG, approval);
  assert.equal(report.stop_reason, "generation_limit");
  assert.equal(report.promoted, 3);
  assert.equal(report.samples_consumed, 768);
  assert.equal(report.budget, 768);
  assert.equal(report.refusal_reason, null);
  assert.match(report.seed_generation, /-loop-a-seed$/);
  assert.match(report.environment, /-env-loop-bandit-1-[0-9a-f]{12}$/);
  assert.equal(report.generations.length, 3);
  // The persisted chain matches the pure in-memory replay exactly.
  const config = parseLoopConfig(LOOP_CONFIG);
  const { receipts, steps } = replayLoop(config);
  for (const [index, generation] of report.generations.entries()) {
    assert.equal(generation.generation, index + 1);
    assert.equal(generation.promoted, true);
    assert.equal(generation.refusal_reason, null);
    assert.match(generation.item, new RegExp(`-loop-a-g${index + 1}$`));
    assert.match(generation.run, new RegExp(`-loop-a-g${index + 1}-collect$`));
    assert.equal(generation.candidate_checkpoint, receipts[index].candidate.digest);
    assert.equal(generation.held_out_mean, receipts[index].candidateHeldOutMean);
  }
  assert.equal(report.final_checkpoint, receipts[2].candidate.digest);
  for (const [index, generation] of report.generations.entries()) {
    const shown = resultOf(await harness.runCommand({ command: "rl run show", pmRoot, args: [generation.run] }));
    assert.equal((shown.details?.events as unknown[]).length, 256);
    const stored = await client.get(generation.item, { depth: "deep" });
    assert.equal(stored.item.status, "closed");
    const spec = generationSpecOf(String(stored.item.body));
    assert.equal(spec.promoted, true);
    assert.equal(spec.approval, approval);
    // The recorded policy is the promoted candidate: the checkpoint the next
    // generation's collection runs must match at this same boundary.
    assert.equal(spec.policy, receipts[index].candidate.digest);
    assert.equal(spec.base_checkpoint, receipts[index].source.digest);
    assert.deepEqual(spec.collection_runs, [generation.run]);
    assert.deepEqual(spec.training_config, generationTrainingConfig(config, steps[index], index + 1, receipts[index]));
    assert.equal(spec.held_out_score?.value, receipts[index].candidateHeldOutMean);
  }
  // The chain renders through the lineage view from seed to promoted head.
  const lineage = resultOf(await harness.runCommand({ command: "rl lineage", pmRoot, args: [report.generations[2]!.item], options: { format: "json" } }));
  const ancestry = (lineage.details?.view as { ancestries: Array<{ head: string; rows: unknown[] }> }).ancestries[0]!;
  assert.equal(ancestry.head, report.generations[2]!.item);
  assert.equal(ancestry.rows.length, 4);
});

test("the typed SDK function runs the loop without the CLI host", async () => {
  const root = mkdtempSync(join(tmpdir(), "pm-rl-loop-sdk-"));
  roots.push(root);
  const initialized = await init("rl", { defaults: true, author: "pm-rl-test", agentGuidance: "skip" }, { cwd: root });
  const client = new PmClient({ pmRoot: initialized.path, author: "pm-rl-test" });
  for (const itemType of RL_ITEM_TYPES) {
    await client.schemaAddType(itemType.name, {
      folder: itemType.folder,
      alias: [...(itemType.aliases ?? [])],
      description: itemType.description,
      defaultStatus: itemType.default_status,
    });
  }
  const approval = await client.create({
    id: "sdk-approval",
    title: "sdk-approval",
    type: "Decision",
    status: "open",
    body: `# sdk-approval\n\n\`\`\`json\n${JSON.stringify({ permitted_promotions: 3 })}\n\`\`\``,
  });
  const report = await runRlLoop(client, { pmRoot: initialized.path, author: "pm-rl-test" }, { id: "sdk-loop", config: LOOP_CONFIG, approval: String(approval.item.id) });
  assert.equal(report.stop_reason, "generation_limit");
  assert.equal(report.promoted, 3);
  const head = await client.get(report.generations[2]!.item, { depth: "deep" });
  assert.equal(head.item.status, "closed");
});

test("measured weak progress changes the successor's persisted learning rate", async () => {
  const { root, pmRoot, client, harness } = await workspace();
  const approval = await createApproval(client, "schedule-approval", 3);
  const report = await runLoopCommand(harness, pmRoot, root, "schedule", {
    ...LOOP_CONFIG, learning_rate: 1, minimum_improvement: 0.03,
  }, approval);
  assert.equal(report.generations[0].promoted, true);
  assert.equal(report.generations.length, 2);
  const first = generationSpecOf(String((await client.get(report.generations[0].item, { depth: "deep" })).item.body));
  const next = generationSpecOf(String((await client.get(report.generations[1].item, { depth: "deep" })).item.body));
  const firstConfig = first.training_config as Record<string, JsonValue>;
  const nextConfig = next.training_config as Record<string, JsonValue>;
  assert.equal(firstConfig.learning_rate, 1);
  assert.equal(nextConfig.learning_rate, 0.5);
  assert.equal(next.base_checkpoint, first.policy);
  assert.equal(report.final_checkpoint, first.policy);
});

test("an exhausted sample budget stops the loop before collecting past its bound", async () => {
  const { root, pmRoot, client, harness } = await workspace();
  const approval = await createApproval(client, "loop-approval", 10);
  const report = await runLoopCommand(harness, pmRoot, root, "loop-a", { ...LOOP_CONFIG, budget: 512 }, approval);
  assert.equal(report.stop_reason, "budget_exhausted");
  assert.equal(report.promoted, 2);
  assert.equal(report.samples_consumed, 512);
  assert.match(report.refusal_reason!, /sample budget 512 exhausted after 512/);
  assert.equal(report.generations.length, 2);
  const terminal = await client.comments(report.seed_generation);
  assert.ok(JSON.stringify(terminal).includes("budget_exhausted"), "the budget stop must survive in tracker history");
});

test("the generation bound is recorded even when more collection budget remains", async () => {
  const { root, pmRoot, client, harness } = await workspace();
  const approval = await createApproval(client, "bound-approval", 10);
  const report = await runLoopCommand(harness, pmRoot, root, "bounded", { ...LOOP_CONFIG, max_generations: 1 }, approval);
  assert.equal(report.generations.length, 1);
  assert.equal(report.samples_consumed, 256);
  assert.equal(report.stop_reason, "generation_limit");
  const terminal = await client.comments(report.seed_generation);
  assert.ok(JSON.stringify(terminal).includes("generation_limit"), "the generation stop must survive in tracker history");
});

test("a changed candidate with tied held-out reward is never promoted", async () => {
  const { root, pmRoot, client, harness } = await workspace();
  const approval = await createApproval(client, "tie-approval", 10);
  const config = { ...LOOP_CONFIG, evaluation: [{ id: "tie", feature: 1, rewards: [1, 1] }] };
  const report = await runLoopCommand(harness, pmRoot, root, "tied", config, approval);
  assert.equal(report.stop_reason, "evaluation_rejected");
  assert.equal(report.promoted, 0);
  assert.equal(report.final_checkpoint, banditCheckpoint(0).digest);
  assert.notEqual(report.generations[0].candidate_checkpoint, report.final_checkpoint);
  const candidate = await client.get(report.generations[0].item, { depth: "deep" });
  const spec = generationSpecOf(String(candidate.item.body));
  assert.equal(spec.promoted, false);
  assert.equal(candidate.item.status, "open");
  const measured = spec.training_config as Record<string, JsonValue>;
  assert.equal(measured.incumbent_held_out_mean, 1);
  assert.equal(measured.candidate_held_out_mean, 1);
});

test("two simultaneous loops share a newly registered environment without losing history", async () => {
  const { pmRoot, client } = await workspace();
  const approval = await createApproval(client, "shared-approval", 1);
  const ids = ["parallel-a", "parallel-b"];
  const clients = ids.map((author) => new PmClient({ pmRoot, author }));
  synchronizeCreates(clients, "Environment");
  const reports = await Promise.all(ids.map((id, index) =>
    runRlLoop(clients[index], { pmRoot, author: id }, {
      id, config: { ...LOOP_CONFIG, max_generations: 1 }, approval,
    })));
  assert.equal(reports[0].environment, reports[1].environment);
  assert.equal(reports.reduce((total, report) => total + report.promoted, 0), 1);
  assert.deepEqual(reports.map((report) => report.stop_reason).sort(), ["generation_limit", "promotion_refused"]);
  for (const report of reports) {
    const candidate = await client.get(report.generations[0].item, { depth: "deep" });
    assert.equal(generationSpecOf(String(candidate.item.body)).promoted, report.promoted === 1);
    const terminal = await client.comments(report.seed_generation);
    assert.ok(JSON.stringify(terminal).includes(report.stop_reason));
  }
});

test("loop creation accepts identical concurrent run and candidate winners", async () => {
  for (const target of ["-collect", "-g1"]) {
    const { pmRoot, client } = await workspace();
    const approval = await createApproval(client, "creation-approval", 1);
    insertCompetingCreate(client, (options) => String(options.id).endsWith(target), (options) => options);
    const report = await runRlLoop(client, { pmRoot, author: "pm-rl-test" }, {
      id: "creation-race", config: { ...LOOP_CONFIG, max_generations: 1 }, approval,
    });
    assert.equal(report.promoted, 1);
    for (const id of [report.environment, report.seed_generation, report.generations[0].run, report.generations[0].item]) {
      const history = readFileSync(join(pmRoot, "history", `${id}.jsonl`), "utf8");
      assert.equal(history.split("\n").filter((line) => line.includes('"op":"create"')).length, 1);
      await client.run("history", { id, verify: true, strictExit: true });
    }
  }
});

test("seed registration is idempotent while simultaneous execution of one loop id has one owner", async () => {
  const { pmRoot, client, harness } = await workspace();
  insertCompetingCreate(client, (options) => options.type === "Generation", (options) => options);
  const registered = resultOf(await harness.runCommand({ command: "rl generation register", pmRoot, args: ["shared-seed"], options: { baseCheckpoint: "checkpoint" }, sdk: { client } as NonNullable<CommandHandlerContext["sdk"]> }));
  assert.equal(registered.created, false);
  const approval = await createApproval(client, "single-owner-approval", 1);
  const clients = ["owner-a", "owner-b"].map((author) => new PmClient({ pmRoot, author }));
  synchronizeCreates(clients, "Environment");
  synchronizeCreates(clients, "Generation");
  const results = await Promise.allSettled(clients.map((caller) => runRlLoop(caller, { pmRoot, author: "pm-rl-test" }, {
    id: "single-owner", config: { ...LOOP_CONFIG, max_generations: 1 }, approval,
  })));
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  const loser = results.find((result) => result.status === "rejected");
  assert.ok(loser?.status === "rejected" && isPmCliExpectedError(loser.reason));
  assert.equal(loser.reason.context.code, "loop_already_started");
  const inventory = await client.listAllComplete({});
  assert.equal(inventory.items.filter((item) => item.type === "Run").length, 1);
});

test("loop creation refuses concurrent winners with different content using typed conflicts", async () => {
  for (const [target, code] of [
    ["Environment", "environment_identity_collision"],
    ["-seed", "generation_identity_collision"],
    ["-collect", "run_identity_collision"],
    ["-g1", "generation_identity_collision"],
  ]) {
    const { pmRoot, client } = await workspace();
    const approval = await createApproval(client, "collision-approval", 1);
    insertCompetingCreate(client, (options) => options.type === target || String(options.id).endsWith(target), (options) => ({
      ...options,
      // Preserve the claimed hash: acceptance must also verify the actual stored content.
      body: String(options.body).replace('"version": "1"', '"version": "foreign"').replace(/"policy": "[^"]+"/, '"policy": "foreign"').replace("Algorithm: ", "Algorithm: foreign-"),
    }));
    await assert.rejects(runRlLoop(client, { pmRoot, author: "pm-rl-test" }, {
      id: "collision-race", config: { ...LOOP_CONFIG, max_generations: 1 }, approval,
    }), (error: unknown) => isPmCliExpectedError(error) && error.exitCode === EXIT_CODE.CONFLICT && error.context.code === code);
  }
});

test("loop creation checks every recorded run and generation identity field", async () => {
  for (const [target, field] of [
    ["Environment", "affectedVersion"],
    ["-seed", "affectedVersion"],
    ["-collect", "affectedVersion"],
    ["-collect", "fixedVersion"],
    ["-collect", "component"],
    ["-collect", "environment"],
  ]) {
    const { pmRoot, client } = await workspace();
    const approval = await createApproval(client, "field-approval", 1);
    insertCompetingCreate(client, (options) => options.type === target || String(options.id).endsWith(target), (options) => ({ ...options, [field]: "foreign" }));
    await assert.rejects(runRlLoop(client, { pmRoot, author: "pm-rl-test" }, {
      id: "field-race", config: { ...LOOP_CONFIG, max_generations: 1 }, approval,
    }), (error: unknown) => isPmCliExpectedError(error) && error.exitCode === EXIT_CODE.CONFLICT && String(error.context.code).endsWith("identity_collision"));
  }
});

test("loop creation propagates real SDK failures unrelated to duplicate identities", async () => {
  const { pmRoot, client } = await workspace();
  const approval = await createApproval(client, "invalid-approval", 1);
  insertCompetingCreate(client, (options) => options.type === "Environment", (options) => ({ ...options, status: "not-a-status" }));
  await assert.rejects(runRlLoop(client, { pmRoot, author: "pm-rl-test" }, {
    id: "invalid-create", config: LOOP_CONFIG, approval,
  }), (error: unknown) => isPmCliExpectedError(error) && error.exitCode !== EXIT_CODE.CONFLICT);
});

test("loop creation propagates unrelated conflicts and duplicates for a different resolved id", async () => {
  for (const mode of ["strict", "other-id"]) {
    const { root, pmRoot, client } = await workspace();
    const approval = await createApproval(client, "unrelated-approval", 1);
    if (mode === "strict") {
      execFileSync(process.execPath, [join(process.cwd(), "node_modules/@unbrained/pm-cli/dist/cli.js"), "config", "project", "set", "governance_duplicate_detection_mode", "strict"], { cwd: root, env: { ...process.env, PM_PATH: pmRoot } });
    }
    const create = client.create.bind(client);
    client.create = async (options) => {
      assert.ok(options !== undefined);
      if (options.type === "Environment") {
        if (mode === "strict") {
          await create({ ...options, id: "similar-environment" });
          return create(options);
        }
        await create(options);
        const other = { ...options, id: "other-environment" };
        await create(other);
        return create(other);
      }
      return create(options);
    };
    await assert.rejects(runRlLoop(client, { pmRoot, author: "pm-rl-test" }, {
      id: "unrelated-create", config: LOOP_CONFIG, approval,
    }), (error: unknown) => isPmCliExpectedError(error) && error.exitCode === EXIT_CODE.CONFLICT
      && (mode === "strict" ? error.context.code === "likely_duplicate" : error.message === 'Item "rl-other-environment" already exists'));
  }
});

test("loop creation propagates real filesystem failures", async () => {
  const { pmRoot, client } = await workspace();
  const approval = await createApproval(client, "filesystem-approval", 1);
  const create = client.create.bind(client);
  const folder = join(pmRoot, "environments");
  const backup = join(pmRoot, "environments-backup");
  client.create = async (options) => {
    // A file in place of the item directory fails even with DAC override.
    // Keep the real SDK create and its filesystem error propagation intact.
    renameSync(folder, backup);
    writeFileSync(folder, "not a directory");
    try {
      return await create(options);
    } finally {
      rmSync(folder);
      renameSync(backup, folder);
    }
  };
  await assert.rejects(runRlLoop(client, { pmRoot, author: "pm-rl-test" }, {
    id: "filesystem-create", config: LOOP_CONFIG, approval,
  }), (error: unknown) => error instanceof Error && !isPmCliExpectedError(error)
    && "code" in error && error.code === "EEXIST");
});

test("an exhausted approval budget refuses the persisted promotion and records the refusal", async () => {
  const { root, pmRoot, client, harness } = await workspace();
  const approval = await createApproval(client, "loop-approval", 1);
  const report = await runLoopCommand(harness, pmRoot, root, "loop-a", LOOP_CONFIG, approval);
  assert.equal(report.stop_reason, "promotion_refused");
  assert.equal(report.promoted, 1);
  assert.equal(report.generations.length, 2);
  assert.equal(report.generations[1].promoted, false);
  assert.match(report.generations[1].refusal_reason!, /approved promotion budget/);
  // The refused candidate stays registered and open with the refusal in its history.
  const refused = await client.get(report.generations[1]!.item, { depth: "deep" });
  assert.equal(refused.item.status, "open");
  const comments = await client.comments(report.generations[1]!.item);
  assert.ok(JSON.stringify(comments).includes("approved promotion budget"));
  assert.equal(report.final_checkpoint, report.generations[0].candidate_checkpoint);
});

test("a regressing held-out evaluation rejects the candidate and records the refusal as history", async () => {
  const { root, pmRoot, client, harness } = await workspace();
  const approval = await createApproval(client, "loop-approval", 10);
  const config = { ...LOOP_CONFIG, evaluation: [{ id: "opposite", feature: 1, rewards: [1, 0] }] };
  const report = await runLoopCommand(harness, pmRoot, root, "loop-a", config, approval);
  assert.equal(report.stop_reason, "evaluation_rejected");
  assert.equal(report.promoted, 0);
  assert.equal(report.samples_consumed, 256);
  assert.equal(report.generations.length, 1);
  assert.equal(report.generations[0].promoted, false);
  assert.match(report.generations[0].refusal_reason!, /statistically better/);
  const comments = await client.comments(report.generations[0]!.item);
  assert.ok(JSON.stringify(comments).includes("statistically better"));
  // The refused generation's collection run still carries its real metrics.
  const shown = resultOf(await harness.runCommand({ command: "rl run show", pmRoot, args: [report.generations[0]!.run] }));
  assert.equal((shown.details?.events as unknown[]).length, 256);
  // The incumbent stays the seed: a refused candidate never becomes the collector.
  assert.equal(report.final_checkpoint, banditCheckpoint(0).digest);
});

test("an unchanged checkpoint and a widening proxy gap each stop the loop with their own reason", async () => {
  const { root, pmRoot, client, harness } = await workspace();
  const approval = await createApproval(client, "loop-approval", 10);
  const unchanged = await runLoopCommand(harness, pmRoot, root, "loop-a", { ...LOOP_CONFIG, training: [{ id: "zero", feature: 0, rewards: [0, 0] }] }, approval);
  assert.equal(unchanged.stop_reason, "unchanged_checkpoint");
  assert.equal(unchanged.promoted, 0);
  assert.match(unchanged.refusal_reason!, /unchanged/);
  const widened = await runLoopCommand(harness, pmRoot, root, "loop-b", { ...LOOP_CONFIG, maximum_gap: 0 }, approval);
  assert.equal(widened.stop_reason, "gap_rejected");
  assert.equal(widened.promoted, 0);
  assert.match(widened.refusal_reason!, /exceeds the maximum/);
});

test("the loop fails closed on missing arguments, unreadable or invalid configuration, and missing approval", async () => {
  const { root, pmRoot, client, harness } = await workspace();
  const approval = await createApproval(client, "loop-approval", 10);
  const file = writeJson(root, "loop.json", LOOP_CONFIG);
  await assert.rejects(harness.runCommand({ command: "rl loop run", pmRoot, options: { file, approval } }), /pm rl requires a loop id/);
  await assert.rejects(harness.runCommand({ command: "rl loop run", pmRoot, args: ["loop-a"], options: { approval } }), /requires --file/);
  await assert.rejects(harness.runCommand({ command: "rl loop run", pmRoot, args: ["loop-a"], options: { file } }), /requires --approval/);
  await assert.rejects(
    harness.runCommand({ command: "rl loop run", pmRoot, args: ["loop-a"], options: { file: join(root, "absent.json"), approval } }),
    /could not be read/,
  );
  const notJson = join(root, "bad.json");
  writeFileSync(notJson, "not-json");
  await assert.rejects(harness.runCommand({ command: "rl loop run", pmRoot, args: ["loop-a"], options: { file: notJson, approval } }), /not valid JSON/);
  await assert.rejects(
    harness.runCommand({ command: "rl loop run", pmRoot, args: ["loop-a"], options: { file: writeJson(root, "bounds.json", { ...LOOP_CONFIG, learning_rate: 2 }), approval } }),
    /learning_rate/,
  );
  // A missing approval fails before any item is created, so no budget or artifact leaks.
  await assert.rejects(
    harness.runCommand({ command: "rl loop run", pmRoot, args: ["loop-a"], options: { file, approval: "absent-approval" } }),
    /absent-approval/,
  );
  const generations = await client.list({ type: "Generation", status: "all", noTruncate: true });
  assert.equal(generations.items.length, 0);
  // A non-Decision approval is refused with the same fail-fast discipline.
  const feature = await client.create({ id: "not-an-approval", title: "not-an-approval", type: "Task", status: "open" });
  await assert.rejects(
    harness.runCommand({ command: "rl loop run", pmRoot, args: ["loop-a"], options: { file, approval: String(feature.item.id) } }),
    /expected a Decision/,
  );
});

test("rerunning one loop id is refused rather than silently extending the lineage", async () => {
  const { root, pmRoot, client, harness } = await workspace();
  const approval = await createApproval(client, "loop-approval", 10);
  const file = writeJson(root, "loop.json", LOOP_CONFIG);
  await harness.runCommand({ command: "rl loop run", pmRoot, args: ["loop-a"], options: { file, approval } });
  await assert.rejects(
    harness.runCommand({ command: "rl loop run", pmRoot, args: ["loop-a"], options: { file, approval } }),
    /loop-a-seed/,
  );
});

test("an invalid transaction identity propagates rather than being recorded as a gate refusal", async () => {
  const root = mkdtempSync(join(tmpdir(), "pm-rl-loop-infra-"));
  roots.push(root);
  const initialized = await init("rl", { defaults: true, author: "pm-rl-test", agentGuidance: "skip" }, { cwd: root });
  const client = new PmClient({ pmRoot: initialized.path, author: "pm-rl-test" });
  for (const itemType of RL_ITEM_TYPES) {
    await client.schemaAddType(itemType.name, {
      folder: itemType.folder,
      alias: [...(itemType.aliases ?? [])],
      description: itemType.description,
      defaultStatus: itemType.default_status,
    });
  }
  const approval = await client.create({
    id: "infra-approval",
    title: "infra-approval",
    type: "Decision",
    status: "open",
    body: `# infra-approval\n\n\`\`\`json\n${JSON.stringify({ permitted_promotions: 3 })}\n\`\`\``,
  });
  // The SDK rejects an empty transaction author with a TypeError. The real
  // coordinator validation must propagate without becoming a gate refusal.
  await assert.rejects(
    runRlLoop(client, { pmRoot: initialized.path, author: "" }, { id: "infra-loop", config: LOOP_CONFIG, approval: String(approval.item.id) }),
    /author/,
  );
  const candidate = await client.get("infra-loop-g1", { depth: "deep" });
  assert.equal(candidate.item.status, "open");
  const comments = await client.comments(String(candidate.item.id));
  assert.ok(!JSON.stringify(comments).includes("promotion refused"), "an infrastructure failure must not be recorded as a promotion refusal");
});

test("two simultaneous Git worktree loops preserve every item, metric and history in both merge directions", async () => {
  const { root, pmRoot, client, harness } = await workspace();
  execFileSync("git", ["init", "-b", "main"], { cwd: root });
  execFileSync("git", ["config", "user.name", "SteveBot"], { cwd: root });
  execFileSync("git", ["config", "user.email", "1153461+unbraind@users.noreply.github.com"], { cwd: root });
  writeFileSync(join(root, ".gitignore"), readFileSync(join(process.cwd(), ".gitignore"), "utf8"));
  execFileSync("pm", ["merge", "install"], { cwd: root });
  const envFile = writeJson(root, "env.json", loopEnvironmentSpec(parseLoopConfig(LOOP_CONFIG)));
  const environment = resultOf(await harness.runCommand({ command: "rl env register", pmRoot, options: { file: envFile } }));
  const approvalA = await createApproval(client, "approval-a", 3);
  const approvalB = await createApproval(client, "approval-b", 3);
  execFileSync("git", ["add", ".agents", ".gitattributes", ".gitignore"], { cwd: root });
  execFileSync("git", ["commit", "-m", "Seed shared environment and approvals"], { cwd: root });
  const branchRoots = [join(root, "branch-a"), join(root, "branch-b")];
  for (const [index, branchRoot] of branchRoots.entries()) {
    execFileSync("git", ["worktree", "add", "-b", `agent-${index}`, branchRoot, "main"], { cwd: root });
  }
  const loops = await Promise.all(branchRoots.map((branchRoot, index) =>
    runRlLoop(new PmClient({ pmRoot: join(branchRoot, ".agents/pm"), author: `loop-${index}` }),
      { pmRoot: join(branchRoot, ".agents/pm"), author: `loop-${index}` },
      { id: `loop-${index}`, config: LOOP_CONFIG, approval: index === 0 ? approvalA : approvalB })));
  const histories = new Map<string, string>();
  for (const [index, loop] of loops.entries()) {
    assert.equal(loop.environment, environment.id);
    assert.equal(loop.promoted, 3);
    for (const id of [loop.seed_generation, ...loop.generations.flatMap((generation) => [generation.item, generation.run])]) {
      histories.set(id, readFileSync(join(branchRoots[index], ".agents/pm/history", `${id}.jsonl`), "utf8"));
    }
    execFileSync("git", ["add", ".agents/pm"], { cwd: branchRoots[index] });
    execFileSync("git", ["commit", "-m", `Record loop ${index}`], { cwd: branchRoots[index] });
  }
  // Freeze both independent tips so neither reverse merge incorporates the
  // first merge commit and accidentally becomes a fast-forward.
  const tips = branchRoots.map((branchRoot) => execFileSync("git", ["rev-parse", "HEAD"], { cwd: branchRoot, encoding: "utf8" }).trim());
  for (const [index, branchRoot] of branchRoots.entries()) {
    execFileSync("git", ["merge", "--no-edit", tips[1 - index]], { cwd: branchRoot, stdio: "inherit" });
    const mergedRoot = join(branchRoot, ".agents/pm");
    const mergedClient = new PmClient({ pmRoot: mergedRoot, author: "verify" });
    for (const loop of loops) {
      for (const generation of loop.generations) {
        const shown = resultOf(await harness.runCommand({ command: "rl run show", pmRoot: mergedRoot, args: [generation.run] }));
        const receipt: BanditGeneration = replayLoop(parseLoopConfig(LOOP_CONFIG)).receipts[generation.generation - 1];
        assert.deepEqual(shown.details?.events, collectionMetricEvents(receipt), `${generation.run} changed metrics during merge`);
        const stored = await mergedClient.get(generation.item, { depth: "deep" });
        assert.equal(stored.item.status, "closed");
      }
    }
    for (const [id, history] of histories) {
      assert.equal(readFileSync(join(mergedRoot, "history", `${id}.jsonl`), "utf8"), history);
      const verified = await mergedClient.run("history", { id, verify: true, strictExit: true });
      assert.ok(verified);
    }
    const lineage = resultOf(await harness.runCommand({ command: "rl lineage", pmRoot: mergedRoot, options: { format: "json" } }));
    const heads = (lineage.details?.view as { ancestries: Array<{ head: string }> }).ancestries.map((entry) => entry.head);
    assert.deepEqual(heads.sort(), loops.map((loop) => loop.generations[2].item).sort());
  }
});
