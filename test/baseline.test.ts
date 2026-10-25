/** Capacity, item-paired promotion and sealed replay regressions use real numerical fitting and SDK jobs. */
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { PmClient } from "@unbrained/pm-cli/sdk/core";
import { isPmCliExpectedError } from "@unbrained/pm-cli/sdk/runtime";
import { banditCheckpoint, banditProbability, fitBanditBatch, validatedBanditDatasets } from "../bandit.ts";
import { itemBootstrap, pairedItemEvidence } from "../item-evaluation.ts";
import { corpusHeldOut, sealTrackerLoopCorpus, titleFeatures, verifyTrackerLoopCorpus } from "../corpus.ts";
import { generationTrainingConfig, loopPromotionScores, parseLoopConfig, parseStoredLoopGeneration, runLoopGeneration, seedTrainingConfig, verifyStoredLoopGeneration } from "../loop.ts";
import { runRlLoop, resumeRlLoop, rlLoopStatus, appendCommentOnce, promoteGenerationCore, type JsonValue } from "../index.ts";
import { executeProcessTrainer, parseProcessAdapter, listProcessJobs } from "../process.ts";
import { parseScoreRecord } from "../lineage.ts";
import { baselineMain } from "../scripts/live-baseline.ts";
import { vectorNoGit } from "./fixtures/baseline-no-git.ts";
import { processWorkspace, trainingInput } from "./fixtures/process-workspace.ts";

const bounds = JSON.parse(readFileSync(new URL("../examples/loop-corpus-baseline.json", import.meta.url), "utf8")) as Record<string, JsonValue>;
const items = Array.from({ length: 160 }, (_, index) => ({ id: `row-${index}`, title: `${index % 2 === 0 ? "finish" : "future"} ${"z".repeat(index + 1)}`, status: index % 2 === 0 ? "closed" : "open" }));

test("item bootstrap counts held-out items and refuses ties, constants, small samples and paired regressions", () => {
  const rewards = Array.from({ length: 40 }, (_, index) => index % 2 === 0 ? [0, 1] as const : [1, 0] as const);
  const result = pairedItemEvidence(rewards.map(() => 0.9), rewards.map(() => 0.5), rewards, 0.95, 10, 0.01);
  assert.equal(result.accepted, true); assert.equal(result.samples, 40); assert.ok(Math.abs(result.incumbent.mean - 0.4) < 1e-12);
  assert.deepEqual(pairedItemEvidence(rewards.map(() => 0.9), rewards.map(() => 0.5), rewards, 0.95, 10, 0.01), result);
  assert.equal(pairedItemEvidence(rewards.map(() => 0.9), rewards.map(() => 0.9), rewards, 0.95, 10, 0.01).reason, "item_incumbent_not_beaten");
  assert.equal(pairedItemEvidence(rewards.map(() => 0.9), rewards.map(() => 0.5), rewards, 0.95, 41, 0.01).reason, "item_insufficient_samples");
  assert.equal(pairedItemEvidence(rewards.map(() => 0.9), rewards.map(() => 0.5), rewards.map(() => [0, 1]), 0.95, 10, 0.01).reason, "item_constant_not_beaten");
  assert.throws(() => pairedItemEvidence([1], [], [], 0.95, 1, 0.01), /item_pairing/);
  assert.throws(() => pairedItemEvidence([1], [1], [], 0.95, 1, 0.01), /item_pairing/);
  for (const [values, confidence] of [[[], 0.95], [[NaN], 0.95], [[1], NaN], [[1], 0], [[1], 1]] as const) assert.throws(() => itemBootstrap(values, confidence), /item_bootstrap_input/);
});

test("paired gate property: random vectors pass iff every paired lower bound clears the threshold; equality always refuses", () => {
  let state = 0x25791;
  const random = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 0x1_0000_0000; };
  let passed = 0; let refused = 0;
  for (let trial = 0; trial < 96; trial += 1) {
    const size = 10 + Math.floor(random() * 11);
    const candidate = Array.from({ length: size }, () => 0.65 + random() * 0.35);
    const baselines = Array.from({ length: 3 }, (_, baseline) => candidate.map((value) => trial % 4 === baseline + 1 ? value : random() * 0.4));
    const threshold = [0, 0.01, 0.05][trial % 3];
    const rewards = candidate.map((_, index) => [baselines[1][index], baselines[2][index]] as const);
    const evidence = pairedItemEvidence(candidate, baselines[0], rewards, 0.95, 10, threshold);
    const lowers = baselines.map((baseline) => itemBootstrap(candidate.map((value, index) => value - baseline[index]), 1 - 0.05 / 3).lower);
    assert.equal(evidence.accepted, lowers.every((lower) => lower > threshold), `seeded trial ${trial}`);
    if (evidence.accepted) passed += 1; else refused += 1;
    for (let baseline = 0; baseline < 3; baseline += 1) {
      const tied = baselines.map((values, index) => index === baseline ? candidate : values);
      assert.equal(pairedItemEvidence(candidate, tied[0], candidate.map((_, index) => [tied[1][index], tied[2][index]]), 0.95, 10, threshold).accepted, false);
    }
  }
  assert.ok(passed > 0 && refused > 0);
});

test("vector capacity learns different actions and replays all coefficients and item evidence", () => {
  const examples = (prefix: string) => Array.from({ length: 80 }, (_, index) => ({ id: `${prefix}-${index}`, feature: prefix === "train" ? 0.1 : 0.2, features: [1, index % 2 === 0 ? 1 : -1], rewards: index % 2 === 0 ? [0, 1] : [1, 0] }));
  const config = parseLoopConfig({ ...bounds, fit_steps: 8, retry_rejected: false, adapter: undefined, environment: { name: "Capacity fixture", version: "1" }, training: examples("train"), evaluation: examples("held") } as unknown as JsonValue);
  let source = banditCheckpoint(0);
  for (let generation = 1; generation <= 3; generation += 1) {
    const step = { learningRate: 1, evaluationSamples: 40000 };
    const receipt = runLoopGeneration(config, step, generation, source);
    assert.equal(receipt.promoted, true, JSON.stringify(receipt.itemEvidence));
    assert.ok(receipt.evaluationScore > 0.5);
    assert.ok(receipt.itemEvidence!.constant_one.lower > 0.01 && receipt.itemEvidence!.constant_zero.lower > 0.01);
    const saved = generationTrainingConfig(config, step, generation, receipt);
    const stored = parseStoredLoopGeneration(saved, "fixture");
    assert.deepEqual(verifyStoredLoopGeneration(config, step, generation, source, stored), receipt);
    assert.throws(() => verifyStoredLoopGeneration(config, step, generation, source, { ...stored, itemEvidence: null }), /does not replay/);
    assert.throws(() => verifyStoredLoopGeneration(config, step, generation, source, { ...stored, candidateCoefficients: [1] }), /invalid/);
    for (const candidate_coefficients of [[], [NaN], [21], new Array<number>(65).fill(0), null, "invalid"]) assert.throws(() => parseStoredLoopGeneration({ ...saved as Record<string, JsonValue>, candidate_coefficients }, "bad"), /invalid/);
    source = receipt.candidate;
  }
  assert.deepEqual(parseLoopConfig((seedTrainingConfig(config) as Record<string, JsonValue>).configuration), config);
  const correct = config.evaluation.map((row) => banditProbability(source, row) > 0.5);
  assert.ok(correct.some(Boolean) && correct.some((value) => !value));
});

test("title vectors have no status dependency and malformed vector seals fail before fitting", () => {
  const original = sealTrackerLoopCorpus(items, bounds).programme as Record<string, JsonValue>;
  const changed = sealTrackerLoopCorpus(items.map((item) => ({ ...item, status: "closed" })), bounds).programme as Record<string, JsonValue>;
  const corpus = original.corpus as Record<string, JsonValue>;
  const rows = corpus.rows as Record<string, JsonValue>[];
  assert.deepEqual(rows.map((row) => row.features), ((changed.corpus as Record<string, JsonValue>).rows as Record<string, JsonValue>[]).map((row) => row.features));
  for (const features of [undefined, [], new Array<number>(64).fill(2), new Array<number>(64).fill(NaN), new Array<string>(64).fill("text")]) {
    assert.throws(() => verifyTrackerLoopCorpus({ ...original, corpus: { ...corpus, rows: [{ ...rows[0], features }] } }), /corpus_invalid_seal/);
  }
  assert.throws(() => sealTrackerLoopCorpus(items, { ...bounds, feature_mode: "status" }), /corpus_invalid_bounds/);
  assert.equal(titleFeatures("!!!")[0], 1);
  assert.ok(titleFeatures("a b c d e f g h i j").some((value) => value < 0));
  assert.ok(titleFeatures("a b c d e f g h i j").some((value) => value > 0));
  const legacy = sealTrackerLoopCorpus(items, { ...bounds, feature_mode: undefined, retry_rejected: false } as unknown as JsonValue).programme as Record<string, JsonValue>;
  const legacyCorpus = legacy.corpus as Record<string, JsonValue>;
  assert.throws(() => verifyTrackerLoopCorpus({ ...legacy, corpus: { ...legacyCorpus, rows: [{ ...(legacyCorpus.rows as Record<string, JsonValue>[])[0], features: [1] }] } }), /corpus_invalid_seal/);
});

test("vector updates match finite differences of the actual source-policy importance objective", () => {
  const training = [{ id: "one", feature: 0, features: [1, -0.7], rewards: [0, 1] as const }, { id: "zero", feature: 0, features: [1, 0.8], rewards: [1, 0] as const }];
  const observations = [{ example: "one", action: 1 as const, reward: 1 }, { example: "zero", action: 0 as const, reward: 1 }];
  const source = banditCheckpoint(0, [0.2, -0.3]);
  /** Independently differentiate the empirical importance objective rather than mirroring its gradient. */
  const objective = (coefficients: readonly number[]): number => observations.reduce((sum, row, index) => {
    const probability = banditProbability(banditCheckpoint(0, coefficients), training[index]);
    const initial = banditProbability(source, training[index]);
    return sum + (row.action === 1 ? probability / initial : (1 - probability) / (1 - initial));
  }, 0) / observations.length;
  const expected = [...source.coefficients!];
  for (let step = 0; step < 8; step += 1) {
    const derivatives = expected.map((_, index) => { const plus = [...expected]; const minus = [...expected]; plus[index] += 1e-5; minus[index] -= 1e-5; return (objective(plus) - objective(minus)) / 2e-5; });
    for (let index = 0; index < expected.length; index += 1) expected[index] += 0.5 * derivatives[index];
  }
  const fitted = fitBanditBatch(training, source, observations, 0.5, 8);
  fitted.coefficients!.forEach((value, index) => assert.ok(Math.abs(value - expected[index]) < 1e-8));
  assert.deepEqual(validatedBanditDatasets({ training: [training[0]], evaluation: [training[1]] }).training[0].features, [1, -0.7]);
  assert.throws(() => banditProbability(source, { ...training[0], features: undefined }), /bandit_dimensions/);
  assert.throws(() => banditProbability(source, { ...training[0], features: [1] }), /bandit_dimensions/);
  for (const features of [[], [NaN], [2], new Array<number>(65).fill(0), undefined]) assert.throws(() => validatedBanditDatasets({ training: [{ ...training[0], features }], evaluation: [training[1]] }), /bandit_invalid/);
});

test("vector checkpoint validation is enforced by the real external trainer receipt path", async () => {
  const workspace = await processWorkspace({ training_steps: 2, wall_ms: 60000, storage_bytes: 131072, compute_units: 2000, tokens: 0 });
  const input = trainingInput();
  const vector = { ...input, training: input.training.map((row) => ({ ...row, features: [1, row.feature] })) };
  const job = await executeProcessTrainer(workspace.client, workspace.coordinates, vector, workspace.approval, parseProcessAdapter({ kind: "process-bandit", allowance: { training_steps: 1, wall_ms: 30000, storage_bytes: 65536, compute_units: 1000, tokens: 0 } }));
  assert.equal(job.completion!.policy.coefficients!.length, 2);
});


test("item-gated fitting preserves incumbent, budget and replay without a Git executable", { timeout: 300_000 }, () => {
  const root = mkdtempSync(join(tmpdir(), "rl-vector-no-git-"));
  try {
    const bin = join(root, "tools"); mkdirSync(bin); symlinkSync(process.execPath, join(bin, "node"));
    for (const tool of ["ps", "getconf"]) symlinkSync(execFileSync("sh", ["-c", `command -v ${tool}`], { encoding: "utf8" }).trim(), join(bin, tool));
    const output = execFileSync(process.execPath, [new URL("./fixtures/baseline-no-git.ts", import.meta.url).pathname, root, "1"], { encoding: "utf8", timeout: 280_000,
      env: { ...process.env, NODE_V8_COVERAGE: undefined, PATH: bin, GIT_CEILING_DIRECTORIES: dirname(root) } });
    assert.match(output, /1 refused vector proposals; sealed replay; incumbent retained/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("exploration requires a sealed vector corpus and defaults to stop-on-refusal", () => {
  const programme = sealTrackerLoopCorpus(items, bounds).programme as Record<string, JsonValue>;
  const config = parseLoopConfig(programme);
  assert.equal(config.retryRejected, true);
  assert.equal(parseLoopConfig((seedTrainingConfig(config) as Record<string, JsonValue>).configuration).retryRejected, true);
  for (const retry_rejected of ["true", 1, null]) assert.throws(() => parseLoopConfig({ ...programme, retry_rejected }), /Rejected-generation exploration/);
  const legacy = sealTrackerLoopCorpus(items, { ...bounds, feature_mode: undefined, retry_rejected: false } as unknown as JsonValue).programme as Record<string, JsonValue>;
  assert.throws(() => parseLoopConfig({ ...legacy, retry_rejected: true }), /Rejected-generation exploration/);
  assert.equal(parseLoopConfig(legacy).retryRejected, false);
  assert.throws(() => parseLoopConfig({ ...programme, corpus: undefined, retry_rejected: true } as unknown as JsonValue), /Rejected-generation exploration/);
});


test("bounded refused generations replay through the actual controller and status walker", { timeout: 300_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "rl-vector-controller-"));
  try { await vectorNoGit(root); }
  finally { rmSync(root, { recursive: true, force: true }); }
});


test("acceptance dispatcher refuses missing coordinates and does not run on import", async () => {
  const scriptUrl = new URL("../scripts/live-baseline.ts", import.meta.url);
  await baselineMain(["node", fileURLToPath(import.meta.url)], scriptUrl.href);
  for (const coordinates of [[], ["source"], ["source", "output"]]) await assert.rejects(baselineMain(["node", fileURLToPath(scriptUrl), ...coordinates], scriptUrl.href), /Supply a public tracker/);
});

test("vector promotion refuses an improving checkpoint that still loses to a constant", () => {
  const programme = sealTrackerLoopCorpus(items.map((item) => ({ ...item, status: "closed" })), { ...bounds, retry_rejected: false }).programme;
  const config = parseLoopConfig(programme);
  const step = { learningRate: 1, evaluationSamples: 40000 };
  const receipt = runLoopGeneration(config, step, 1, banditCheckpoint(0));
  assert.ok(receipt.evaluationScore > receipt.baselineScore + config.minimumImprovement);
  assert.equal(receipt.promoted, false); assert.equal(receipt.refusalReason, "item_constant_not_beaten");
  const unchanged = runLoopGeneration(config, step, 1, banditCheckpoint(0), banditCheckpoint(0));
  assert.equal(unchanged.stopReason, "unchanged_checkpoint");
});


test("sealed exploration stops on the original gap and sampled-evidence refusals", { timeout: 300_000 }, async () => {
  const workspace = await processWorkspace();
  const common = { ...bounds, adapter: undefined, fit_steps: 8, samples_per_generation: 32, budget: 96 };
  const weak = sealTrackerLoopCorpus(items.map((item) => ({ ...item, status: "closed" })), { ...common, evaluation_samples: 1 } as unknown as JsonValue);
  const gap = sealTrackerLoopCorpus(items.map((item) => ({ ...item, status: corpusHeldOut([...item.title].length) ? "open" : "closed" })), common as unknown as JsonValue);
  for (const [id, corpus, reason] of [["sample-stop", weak, "evaluation_rejected"], ["gap-stop", gap, "gap_rejected"]] as const) {
    const result = await runRlLoop(workspace.client, workspace.coordinates, { id, config: corpus.programme, approval: workspace.approval });
    assert.equal(result.generations.length, 1); assert.equal(result.promoted, 0);
    assert.equal(result.stop_reason, reason);
    assert.ok(!result.generations[0].refusal_reason!.startsWith("item_"));
    const status = await rlLoopStatus(workspace.client, id, workspace.pmRoot);
    assert.equal(status.stop_reason, reason); assert.equal(status.generations.length, 1);
  }
});


test("refused vector retries converge at every collect train evaluate refusal and terminal boundary on one plain tracker", { timeout: 600_000 }, async (context) => {
  for (const boundary of ["collect", "train", "evaluate", "refuse-before", "refuse-after", "record-before", "record-after"] as const) await context.test(boundary, async () => {
    const w = await processWorkspace({ training_steps: 16, wall_ms: 60000, storage_bytes: 524288, compute_units: 20000, tokens: 0 });
    const lengths = [false, true].flatMap((held) => Array.from({ length: 200 }, (_, i) => i + 40).filter((length) => corpusHeldOut(length) === held).slice(0, 10));
    const config = sealTrackerLoopCorpus(lengths.map((length) => ({ id: `source-${length}`, title: "t".repeat(length), status: "closed" })), {
      ...bounds, max_generations: 2, samples_per_generation: 32, budget: 64, fit_steps: 8, evaluation_samples: 512,
      adapter: { kind: "process-bandit", allowance: { training_steps: 8, wall_ms: 30000, storage_bytes: 262144, compute_units: 10000, tokens: 0 } },
    }).programme;
    const peer = new PmClient({ pmRoot: w.pmRoot, cwd: w.root, author: "peer", noExtensions: true });
    const foreign = await peer.create({ id: "foreign-process", type: "Task", title: "Unrelated record", tags: "rl-process-job", body: "# Foreign package content" });
    const comments = w.client.comments.bind(w.client); let injected = false; let interleaved = false;
    const crash = () => { injected = true; throw new Error("vector boundary crash"); };
    w.client.comments = (async (...args: Parameters<PmClient["comments"]>) => {
      const text = args[1]?.add;
      const point = typeof text !== "string" ? null : text.startsWith("Loop boundary generation 1 refused:") ? "refuse" : text.startsWith("Loop boundary terminal report:") ? "record" : null;
      if (!injected && boundary === `${point}-before`) crash();
      const result = await comments(...args);
      if (!injected && boundary === `${point}-after`) crash();
      return result;
    }) as PmClient["comments"];
    await assert.rejects(runRlLoop(w.client, w.coordinates, { id: "boundary", config, approval: w.approval, async onPhase(phase, generation) {
      if (generation !== 1) return;
      // A real second controller attempts the competing transition at every phase boundary.
      await assert.rejects(resumeRlLoop(peer, { pmRoot: w.pmRoot, author: "peer" }, { id: "boundary", approval: w.approval }),
        (error: unknown) => isPmCliExpectedError(error) && error.context.code === "loop_controller_active");
      interleaved = true;
      if (!injected && phase === boundary) crash();
    } }), /vector boundary crash/);
    assert.equal(injected, true); assert.equal(interleaved, true);
    Object.assign(w.client, { comments });
    const resumed = await resumeRlLoop(peer, { pmRoot: w.pmRoot, author: "peer" }, { id: "boundary", approval: w.approval });
    assert.equal(resumed.promoted, 0); assert.equal(resumed.generations.length, 2); assert.equal(resumed.samples_consumed, 64);
    assert.ok(resumed.generations.every((row) => row.refusal_reason === "item_constant_not_beaten"));
    const jobs = await listProcessJobs(peer);
    assert.equal(jobs.length, 2); assert.ok(jobs.every((job) => job.state === "failed" && job.settled && job.charge.training_steps === 8));
    assert.ok(jobs.every((job) => job.completion!.source_policy === resumed.final_checkpoint));
    assert.ok(resumed.skipped_records?.some((row) => row.id === foreign.item.id && row.reason === "foreign_identity"));
    assert.equal((await peer.get(foreign.item.id)).item.body, "# Foreign package content");
    for (const row of resumed.generations) {
      const history = readFileSync(join(w.pmRoot, "history", `${row.item}.jsonl`), "utf8");
      assert.equal(history.split("\n").filter((line) => line.includes('"op":"create"')).length, 1);
      const message = `Loop boundary generation ${row.generation} refused: item_constant_not_beaten`;
      await Promise.all([appendCommentOnce(w.client, row.item, message), appendCommentOnce(peer, row.item, message)]);
      assert.equal((await peer.comments(row.item)).comments.filter((entry) => entry.text === message).length, 1);
    }
    const again = await resumeRlLoop(w.client, w.coordinates, { id: "boundary", approval: w.approval });
    assert.equal(again.final_checkpoint, resumed.final_checkpoint); assert.deepEqual(await listProcessJobs(peer), jobs);
    assert.equal((await peer.comments(resumed.seed_generation)).comments.filter((entry) => entry.text.startsWith("Loop boundary terminal report:")).length, 1);
  });
});


test("vector winners survive competing controllers and crashes at every successful cycle boundary", { timeout: 600_000 }, async (context) => {
  for (const boundary of ["collect", "train", "evaluate", "promote"] as const) await context.test(boundary, async () => {
    const w = await processWorkspace();
    const examples = (prefix: string) => Array.from({ length: 40 }, (_, index) => ({ id: `${prefix}-${index}`, feature: prefix === "train" ? 0.1 : 0.2,
      features: [1, index % 2 === 0 ? 1 : -1], rewards: index % 2 === 0 ? [0, 1] : [1, 0] }));
    const config = { ...bounds, max_generations: 2, fit_steps: 8, retry_rejected: false, adapter: undefined,
      environment: { name: "Paired boundary fixture", version: "1" }, training: examples("train"), evaluation: examples("held") } as unknown as JsonValue;
    const peer = new PmClient({ pmRoot: w.pmRoot, cwd: w.root, author: "peer", noExtensions: true });
    let injected = false;
    await assert.rejects(runRlLoop(w.client, w.coordinates, { id: "winner", config, approval: w.approval, async onPhase(phase, generation) {
      if (generation !== 1 || phase !== boundary) return;
      injected = true;
      await assert.rejects(resumeRlLoop(peer, { pmRoot: w.pmRoot, author: "peer" }, { id: "winner", approval: w.approval }),
        (error: unknown) => isPmCliExpectedError(error) && error.context.code === "loop_controller_active");
      if (phase === "evaluate") {
        const parsed = parseLoopConfig(config); const step = { learningRate: 1, evaluationSamples: 40000 };
        const receipt = runLoopGeneration(parsed, step, 1, banditCheckpoint(0));
        const scores = loopPromotionScores(parsed, step, 1, receipt);
        await promoteGenerationCore(peer, { pmRoot: w.pmRoot, author: "peer" }, "rl-winner-g1", w.approval,
          parseScoreRecord(scores.proxy_score, "proxy"), parseScoreRecord(scores.held_out_score, "held"), "Peer committed paired-evidence winner");
      }
      throw new Error("winner boundary crash");
    } }), /winner boundary crash/);
    assert.equal(injected, true);
    const resumed = await resumeRlLoop(w.client, w.coordinates, { id: "winner", approval: w.approval });
    assert.equal(resumed.promoted, 2);
    if (boundary === "evaluate") assert.equal(resumed.generations[0].promoted_by, "peer");
    assert.equal((await peer.get(resumed.generations[1].run)).item.component, resumed.generations[0].candidate_checkpoint);
    const status = await rlLoopStatus(peer, "winner", w.pmRoot);
    assert.equal(status.promoted, resumed.promoted); assert.equal(status.final_checkpoint, resumed.final_checkpoint);
    const again = await resumeRlLoop(peer, { pmRoot: w.pmRoot, author: "peer" }, { id: "winner", approval: w.approval });
    assert.equal(again.final_checkpoint, resumed.final_checkpoint);
  });
});
