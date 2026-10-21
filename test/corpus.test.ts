/** Real tracker snapshots and inherited durable jobs work without Git or source mutation. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { isPmCliExpectedError } from "@unbrained/pm-cli/sdk/runtime";
import { createExtensionTestHarness } from "@unbrained/pm-cli/sdk/testing";
import { buildTrackerLoopCorpus, corpusHeldOut, sealTrackerLoopCorpus, verifyTrackerLoopCorpus } from "../corpus.ts";
import { banditProcessInput, generationTrainingConfig, parseLoopConfig, runLoopGeneration, seedTrainingConfig } from "../loop.ts";
import extension, { type JsonValue } from "../index.ts";
import { banditCheckpoint, fitBanditBatch } from "../bandit.ts";
import { processWorkspace, trainingInput } from "./fixtures/process-workspace.ts";
import { executeProcessTrainer, listProcessJobs, parseProcessAdapter } from "../process.ts";

const bounds = JSON.parse(readFileSync(new URL("../examples/loop-corpus.json", import.meta.url), "utf8")) as Record<string, JsonValue>;
const items = Array.from({ length: 80 }, (_, index) => ({ id: `source-${index}`, title: "x".repeat(index + 1), status: index % 3 === 0 ? "open" : "closed" }));

/** Match the typed refusal rather than a parser or runtime accident. */
function refuses(code: string): (error: unknown) => boolean { return (error) => isPmCliExpectedError(error) && error.context.code === code; }

test("sealed corpora group identical inputs, bind labels and IDs, and do not retain text or paths", () => {
  const rows = [...items, { id: "duplicate-title", title: "  Ｘ  ", status: "closed" }, { id: "long-title", title: "😀".repeat(300), status: "open" }];
  const corpus = sealTrackerLoopCorpus(rows, bounds);
  assert.deepEqual(sealTrackerLoopCorpus([...rows].reverse(), bounds), corpus);
  assert.notEqual(sealTrackerLoopCorpus(rows.slice(1), bounds).snapshot, corpus.snapshot);
  assert.notEqual(sealTrackerLoopCorpus(rows.map((row, index) => index === 0 ? { ...row, status: "closed" } : row), bounds).snapshot, corpus.snapshot);
  const config = parseLoopConfig(corpus.programme);
  assert.ok(config.training.length >= 2 && config.evaluation.length >= 2);
  assert.equal(config.training.length + config.evaluation.length, rows.length);
  const trainingFeatures = new Set(config.training.map((example) => example.feature));
  assert.ok(config.evaluation.every((example) => !trainingFeatures.has(example.feature)), "identical model inputs never cross partitions");
  assert.equal(corpus.rows.filter((row) => row.length === 1).length, 2, "NFKC and whitespace duplicates share the split");
  assert.equal(corpus.rows.filter((row) => row.length === 256).length, 1, "Unicode lengths are capped before projection");
  assert.equal(corpus.held_out_closed, corpus.rows.filter((row) => corpusHeldOut(row.length) && row.closed).length);
  assert.ok(!JSON.stringify(corpus).includes("source-"));
  assert.ok(!JSON.stringify(corpus).includes("duplicate-title"));
  assert.ok(!JSON.stringify(corpus).includes("😀"));
  assert.equal((sealTrackerLoopCorpus(items, { ...bounds, trainer: "bandit" }).programme as Record<string, JsonValue>).trainer, "bandit");
});

test("malformed snapshots, override datasets, duplicate identities and undersized splits refuse before training", () => {
  for (const value of [null, [], 1, "bounds"]) assert.throws(() => sealTrackerLoopCorpus(items, value), refuses("corpus_invalid_bounds"));
  assert.throws(() => sealTrackerLoopCorpus(items, { ...bounds, trainer: "lm" }), refuses("corpus_invalid_bounds"));
  for (const key of ["training", "evaluation", "environment", "corpus"]) assert.throws(() => sealTrackerLoopCorpus(items, { ...bounds, [key]: [] }), refuses("corpus_external_datasets"));
  assert.throws(() => sealTrackerLoopCorpus(Array.from({ length: 10001 }, () => items[0]), bounds), refuses("corpus_item_limit"));
  for (const row of [{ id: 3 }, { title: 3 }, { status: 3 }, { id: " " }, { title: " " }, { status: " " }]) {
    assert.throws(() => sealTrackerLoopCorpus([{ ...items[0], ...row }] as typeof items, bounds), refuses("corpus_invalid_item"));
  }
  assert.throws(() => sealTrackerLoopCorpus([...items, items[0]], bounds), refuses("corpus_duplicate_item"));
  for (const subset of [[], items.filter((item) => corpusHeldOut(item.title.length)), items.filter((item) => !corpusHeldOut(item.title.length)), items.slice(0, 2)]) {
    assert.throws(() => sealTrackerLoopCorpus(subset, bounds), refuses("corpus_insufficient_split"));
  }
  assert.throws(() => sealTrackerLoopCorpus(items, { ...bounds, minimum_improvement: 0 }), /strictly positive/);
});

test("sealed programmes reject renamed held-out leaks, changed targets and corrupt snapshot evidence", () => {
  const original = sealTrackerLoopCorpus(items, bounds).programme as Record<string, JsonValue>;
  for (const corpus of [null, [], "bad", {}, { format: "pm-rl/tracker-loop-corpus/1", rows: null }]) {
    assert.throws(() => verifyTrackerLoopCorpus({ ...original, corpus }), refuses("corpus_invalid_seal"));
  }
  const corpus = original.corpus as Record<string, JsonValue>;
  const rows = corpus.rows as Record<string, JsonValue>[];
  for (const badRow of [null, "bad", { ...rows[0], item: "bad" }, { ...rows[0], content: "bad" }, { ...rows[0], length: 0 }, { ...rows[0], length: 257 }, { ...rows[0], length: 1.5 }, { ...rows[0], closed: 1 }]) {
    assert.throws(() => verifyTrackerLoopCorpus({ ...original, corpus: { ...corpus, rows: [badRow] } }), refuses("corpus_invalid_seal"));
  }
  assert.throws(() => verifyTrackerLoopCorpus({ ...original, corpus: { ...corpus, rows: Array.from({ length: 10001 }, () => rows[0]) } }), refuses("corpus_invalid_seal"));
  assert.throws(() => verifyTrackerLoopCorpus({ ...original, corpus: { ...corpus, rows: [rows[0], rows[0]] } }), refuses("corpus_duplicate_item"));
  assert.throws(() => verifyTrackerLoopCorpus({ ...original, corpus: { ...corpus, snapshot: "changed" } }), refuses("corpus_snapshot_drift"));
  for (const field of ["training", "evaluation", "environment"]) { const missing = { ...original }; delete missing[field]; assert.throws(() => verifyTrackerLoopCorpus(missing), refuses("corpus_dataset_drift")); }
  const heldOut = original.evaluation as Record<string, JsonValue>[];
  for (const changed of [
    { ...original, training: [...original.training as JsonValue[], { ...heldOut[0], id: "renamed-leak" }] },
    { ...original, evaluation: heldOut.slice(1) },
    { ...original, environment: { name: "different", version: corpus.snapshot } },
  ]) assert.throws(() => parseLoopConfig(changed), refuses("corpus_dataset_drift"));
});

test("bounded repeated updates match finite differences of the source-policy importance objective", () => {
  const training = [{ id: "zero", feature: 1, rewards: [1, 0] as const }, { id: "one", feature: -0.7, rewards: [0, 1] as const }];
  const observations = [{ example: "zero", action: 0 as const, reward: 1 }, { example: "one", action: 1 as const, reward: 1 }];
  const source = banditCheckpoint(0.4);
  /** Empirical expected reward under a candidate, corrected for the actual collection policy. */
  const objective = (weight: number): number => observations.reduce((sum, row, index) => {
    const x = training[index].feature;
    const current = 1 / (1 + Math.exp(-weight * x)); const initial = 1 / (1 + Math.exp(-source.weight * x));
    return sum + row.reward * (row.action === 1 ? current / initial : (1 - current) / (1 - initial));
  }, 0) / observations.length;
  let expected = source.weight;
  for (let step = 0; step < 8; step += 1) expected += 0.5 * (objective(expected + 1e-5) - objective(expected - 1e-5)) / 2e-5;
  const actual = fitBanditBatch(training, source, observations, 0.5, 8);
  assert.ok(Math.abs(actual.weight - expected) < 1e-8);
  assert.ok(objective(actual.weight) > objective(source.weight));
  for (const invalid of [NaN, 0, -1, 257, 1.5]) assert.throws(() => fitBanditBatch(training, source, observations, 0.5, invalid), /bandit_fit_steps/);
  assert.equal(fitBanditBatch([{ id: "cap", feature: 1, rewards: [0, 1] }], banditCheckpoint(20), [{ example: "cap", action: 1, reward: 1 }], 1, 256).weight, 20);
});

test("fit steps are bounded, persisted and matched to a reservation before any job launches", async () => {
  const original = sealTrackerLoopCorpus(items, bounds).programme as Record<string, JsonValue>;
  for (const fit_steps of [0, 257, 1.5, "eight"]) assert.throws(() => parseLoopConfig({ ...original, fit_steps }), refuses("loop_invalid_fit_steps"));
  assert.throws(() => parseLoopConfig({ ...original, fit_steps: 1 }), refuses("loop_fit_allowance_mismatch"));
  const config = parseLoopConfig(original); assert.equal(config.fitSteps, 8);
  const step = { learningRate: config.learningRate, evaluationSamples: config.evaluationSamples };
  const receipt = runLoopGeneration(config, step, 1, banditCheckpoint(0));
  assert.equal((generationTrainingConfig(config, step, 1, receipt) as Record<string, JsonValue>).fit_steps, 8);
  const seed = seedTrainingConfig(config) as Record<string, JsonValue>;
  assert.equal(parseLoopConfig(seed.configuration).fitSteps, 8);
  assert.deepEqual(parseLoopConfig(seed.configuration).corpus, config.corpus);
  assert.equal(banditProcessInput(config, step, 1, receipt).training_config.steps, 8);
  const w = await processWorkspace();
  await assert.rejects(executeProcessTrainer(w.client, w.coordinates, { ...trainingInput(), training_config: { learning_rate: 0.5, steps: 8 } }, w.approval, parseProcessAdapter({ kind: "process-bandit", allowance: { training_steps: 1, wall_ms: 5000, storage_bytes: 65536, compute_units: 1000, tokens: 0 } })), refuses("process_invalid_adapter"));
  assert.deepEqual(await listProcessJobs(w.client), []);
  await assert.rejects(buildTrackerLoopCorpus(w.client, bounds), refuses("corpus_insufficient_split"));
  const lengths = [false, true].flatMap((held) => Array.from({ length: 80 }, (_, i) => i + 1).filter((n) => corpusHeldOut(n) === held).slice(0, 2));
  for (const length of lengths) await w.client.create({ id: `source-${length}`, type: "Task", title: "z".repeat(length) });
  const harness = await createExtensionTestHarness(extension, { name: "pm-rl", capabilities: ["commands", "hooks", "schema"] });
  const built = await harness.runCommand({ command: "rl corpus build", pmRoot: w.pmRoot, args: [], options: { from_tracker: w.pmRoot, file: new URL("../examples/loop-corpus.json", import.meta.url).pathname, output: join(w.root, "sealed.json") } });
  assert.equal(built.handled, true); assert.equal((JSON.parse(readFileSync(join(w.root, "sealed.json"), "utf8")) as Record<string, JsonValue>).fit_steps, 8);
  const rejectedConfig = parseLoopConfig({ ...bounds, environment: { name: "Regression", version: "1" }, training: [{ id: "train", feature: 1, rewards: [0, 1] }], evaluation: [{ id: "opposite", feature: 0.8, rewards: [1, 0] }] });
  const rejected = runLoopGeneration(rejectedConfig, step, 1, banditCheckpoint(0));
  assert.notEqual(rejected.candidate.digest, rejected.source.digest); assert.equal(rejected.promoted, false); assert.ok(rejected.refusalReason); assert.ok(rejected.evaluationScore < rejected.baselineScore);
});

test("real non-git corpus command trains two successors, resumes sealed inputs and preserves source bytes", { timeout: 300_000 }, () => {
  const root = mkdtempSync(join(tmpdir(), "rl-corpus-no-git-"));
  try {
    const bin = join(root, "tools"); mkdirSync(bin);
    symlinkSync(process.execPath, join(bin, "node"));
    for (const tool of ["ps", "getconf"]) {
      const path = execFileSync("sh", ["-c", `command -v ${tool}`], { encoding: "utf8" }).trim();
      symlinkSync(path, join(bin, tool));
    }
    const output = execFileSync(process.execPath, [new URL("./fixtures/corpus-no-git.ts", import.meta.url).pathname, root], {
      encoding: "utf8", timeout: 280_000, env: { ...process.env, NODE_V8_COVERAGE: undefined, PATH: bin, GIT_CEILING_DIRECTORIES: dirname(root) },
    });
    assert.match(output, /two promoted successors; sealed replay/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
