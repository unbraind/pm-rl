/** Behavioural acceptance for sealed projections, real fits, feature sensitivity and statistical refusals. */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Readable, Writable } from "node:stream";
import { test } from "node:test";
import extension, { hashJson, type JsonValue, type RlCommandResult } from "../index.ts";
import { createExtensionTestHarness } from "@unbrained/pm-cli/sdk/testing";
import { isPmCliExpectedError } from "@unbrained/pm-cli/sdk/runtime";
import { buildTrackerDataset, readTrackerDataset, readTrackerSplit, trackerHistoryExample, TRACKER_SPLITS } from "../dataset.ts";
import { calibratePrefixTarget, prefixInnerExample, projectHistoryPrefix, validateHistoryPrefix, type HistoryPrefix, type PrefixProjection } from "../prefix-data.ts";
import { binaryCalibration, fitPrefix, prefixCheckpoint, prefixFeatures, prefixPrediction, prefixProbability, validatePrefixCompletion, validatePrefixKnobs, type PrefixCheckpoint } from "../prefix.ts";
import { majorityBinomial, fitHistoryPrefix, prefixAccuracy, prefixMajorityComparison } from "../prefix-environment.ts";
import { prefixTrainerArgv, prefixTrainerMain, runPrefixTrainer } from "../prefix-trainer.ts";
import { INITIAL_RECIPE, recipeArtifact, seededRecipes } from "../recipe.ts";
import { metaWorkspace, withTrackerSources, metaConfig, git } from "./fixtures/meta-workspace.ts";
import { compareRecipes, runRlMeta, type RecipePolicy } from "../meta.ts";
import { executeProcessTrainer, validateProcessCompletion, readProcessJob, listProcessJobs, type ProcessCompletion, type ProcessInput } from "../process.ts";
import { runLiveMetaAcceptance, liveMetaMain } from "../scripts/live-meta.ts";

const knobs = { regularisation: 0.001, ngram_order: 2, hashing_width: 32 };
const prefix: HistoryPrefix = { events: ["create", "claim", "update", "comment_add"], fields: ["status", "title", "description", "status"], words: [42, 77, 12], elapsed_ms: 80_000, authors: 2 };
const recipe = recipeArtifact({ ...INITIAL_RECIPE.knobs, prefix: knobs });

test("probability calibration exposes confidence errors even with identical hard predictions", () => {
  const source = prefixCheckpoint(new Array<number>(32).fill(0), knobs);
  assert.equal(prefixProbability(prefix, source), 0.5);
  const weights = [...source.weights]; weights[0] = Math.log(3);
  const confident = prefixCheckpoint(weights, knobs);
  assert.ok(Math.abs(prefixProbability(prefix, confident) - 0.75) < 1e-15);
  assert.equal(prefixPrediction(prefix, confident), prefixPrediction(prefix, source));
  const labels = Array.from({ length: 1000 }, (_, index) => index % 4 === 0 ? 0 as const : 1 as const);
  const calibrated = binaryCalibration(labels.map(() => 0.75), labels);
  const uninformative = binaryCalibration(labels.map(() => 0.5), labels);
  assert.equal(calibrated.accuracy.correct, 750); assert.deepEqual(calibrated.accuracy, uninformative.accuracy);
  assert.ok(calibrated.accuracy.interval[0] < 0.75 && calibrated.accuracy.interval[0] > 0.7);
  assert.ok(calibrated.accuracy.interval[1] > 0.75 && calibrated.accuracy.interval[1] < 0.8);
  assert.equal(calibrated.brier, 0.1875); assert.equal(uninformative.brier, 0.25);
  assert.ok(calibrated.log_loss < uninformative.log_loss); assert.equal(calibrated.ece, 0); assert.equal(uninformative.ece, 0.25);
  assert.deepEqual(calibrated.bins[3], { samples: 1000, probability: 0.75, frequency: 0.75 });
  assert.deepEqual(calibrated.bins[0], { samples: 0, probability: null, frequency: null });
  const perfect = binaryCalibration([0, 1], [0, 1]);
  assert.equal(perfect.brier, 0); assert.equal(perfect.ece, 0); assert.ok(perfect.log_loss < 2e-12);
  assert.equal(perfect.accuracy.interval[1], 1);
  const wrong = binaryCalibration([1, 0], [0, 1]);
  assert.equal(wrong.brier, 1); assert.equal(wrong.ece, 1); assert.ok(wrong.log_loss > 27); assert.equal(wrong.accuracy.interval[0], 0);
  const bins = binaryCalibration([0, 0.2, 0.4, 0.6, 0.8, 1], [0, 0, 0, 1, 1, 1]);
  assert.deepEqual(bins.bins.map((bin) => bin.samples), [1, 1, 1, 1, 2]);
  assert.ok(Math.abs(bins.brier - 1 / 15) < 1e-15);
  for (const values of [[], [0.5, 0.5]]) assert.throws(() => binaryCalibration(values, [0]), /samples/);
  assert.throws(() => binaryCalibration([], []), /samples/);
  for (const value of [NaN, Infinity, -0.1, 1.1]) assert.throws(() => binaryCalibration([value], [1]), /values/);
  assert.throws(() => binaryCalibration([0.5], [2 as 1]), /values/);
});
/** Generate a public-shaped history with deliberately distinct future-only values. */
function history(extra: readonly Record<string, unknown>[] = []): string {
  return [
    { ts: "2026-01-01T00:00:00Z", op: "create", author: "one", patch: [{ path: "/metadata/status", value: "open" }, { path: "/metadata/title", value: "Urgent repair" }, { path: "/metadata/description", value: "First description" }, { path: "/metadata/type", value: "Task" }] },
    { ts: "2026-01-01T00:01:00Z", op: "claim", author: "two", patch: [{ path: "/metadata/status", value: "in_progress" }, { path: "/metadata/title", value: "Future title" }, { path: "/metadata/description", value: "Future description" }] },
    { ts: "2026-01-01T01:00:00Z", op: "update", patch: [{ path: "/metadata/status", value: "closed" }] }, ...extra,
  ].map((event) => JSON.stringify(event)).join("\n");
}

test("prefix projection stops at the seeded cut, retains normalized features and omits future text and identities", () => {
  let sawFirst = false; let sawSecond = false;
  for (let seed = 0; seed < 30; seed += 1) {
    const row = projectHistoryPrefix(history(), "public-fixture/pm-alpha", "a".repeat(40), "item", seed)!;
    const changed = projectHistoryPrefix(history([{ op: "update", patch: [{ path: "/metadata/status", value: "open" }] }]), "public-fixture/pm-alpha", "a".repeat(40), "item", seed)!;
    assert.deepEqual(row.example.history, changed.example.history); assert.equal(changed.reopened, "true");
    assert.equal(row.item_type, "Task"); assert.equal(row.reopened, "false");
    assert.ok(!JSON.stringify(row.example).includes("Future")); assert.ok(!JSON.stringify(row.example).includes('"one"'));
    if (row.example.history!.events.length === 1) sawFirst = true; else sawSecond = true;
    validateHistoryPrefix(row.example.history!);
  }
  assert.ok(sawFirst && sawSecond);
  assert.equal(projectHistoryPrefix("", "r", "c", "i", 42), null);
  assert.equal(projectHistoryPrefix(JSON.stringify({ patch: [{ path: "/metadata/status", value: "closed" }] }), "r", "c", "i", 42), null);
  assert.equal(projectHistoryPrefix(history().replaceAll('2026-01-01', 'invalid'), "r", "c", "i", 42), null);
  assert.equal(projectHistoryPrefix(history().replace('"ts":"2026-01-01T01:00:00Z",', ''), "r", "c", "i", 42), null);
  const weird = history().replace('"claim"', '"unrecognized_operation"').replace('"First description"', '"!!!"');
  for (let seed = 0; seed < 8; seed += 1) assert.ok(projectHistoryPrefix(weird, "r", "c", "i", seed));
  const removed = history().replace('"Future title"', '"Future title","op":"remove"');
  for (let seed = 0; seed < 30; seed += 1) assert.ok(projectHistoryPrefix(removed, "r", "c", "i", seed));
  const missing = history().replace('"author":"one",', '').replace('"op":"claim",', '');
  for (let seed = 0; seed < 30; seed += 1) assert.ok(projectHistoryPrefix(missing, "r", "c", "i", seed));
  assert.equal(projectHistoryPrefix(history().replace('"ts":"2026-01-01T00:00:00Z",', ''), "r", "c", "i", 42), null);
  assert.ok(projectHistoryPrefix(history().replace('"/metadata/type"', '"/metadata/priority"'), "r", "c", "i", 42));
  const noPatch = history().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
  noPatch.splice(1, 0, { ts: "2026-01-01T00:00:30Z" });
  for (let seed = 0; seed < 30; seed += 1) assert.ok(projectHistoryPrefix(noPatch.map((event) => JSON.stringify(event)).join("\n"), "r", "c", "i", seed));
});

test("all four target distributions and calibration use only supplied fit rows and reject degenerate medians", () => {
  const rows = Array.from({ length: 20 }, (_, index) => ({ remaining_ms: index, next_lifecycle: index % 2 === 0 ? "closed" : "in_progress", reopened: "false", item_type: "Task" }) as PrefixProjection);
  const calibration = calibratePrefixTarget(rows);
  assert.equal(calibration.threshold_ms, 10); assert.deepEqual(calibration.candidates[3].counts, { fast: 11, slow: 9 });
  assert.equal(calibration.candidates.length, 4); assert.throws(() => calibratePrefixTarget([]), /samples/);
  assert.throws(() => calibratePrefixTarget(rows.map((row) => ({ ...row, remaining_ms: 1 }))), /unbalanced/);
  assert.equal(prefixInnerExample("00000000"), true); assert.equal(prefixInnerExample("00000001"), false);
});

for (const invalid of ["empty", "unknown"] as const) test(`lifecycle prefix contract: ${invalid} histories cannot seal unreadable datasets`, async () => {
  await withTrackerSources(async ({ root, directories }) => {
    const events = history().split("\n");
    const malformed = invalid === "empty" ? [JSON.stringify({ ts: "2026-01-01T00:00:00Z", op: "create" }), events[2]].join("\n") : history().replace('"value":"open"', '"value":"unknown"');
    const file = `history/${invalid}.jsonl`; const project = dirname(dirname(directories[0]));
    writeFileSync(join(directories[0], file), malformed);
    git(project, ["add", `.agents/pm/${file}`]);
    git(project, ["-c", "user.name=Public Fixture", "-c", "user.email=public@example.test", "commit", "-qm", "Add malformed synthetic prefix"]);
    const directory = join(root, "malformed-prefix");
    if (invalid === "unknown") {
      assert.throws(() => buildTrackerDataset(directories, directory, 42, { task: "history-prefix" }), /dataset_unknown_status: unknown/);
      assert.equal(existsSync(join(directory, "dataset.json")), false);
      for (let seed = 0; seed < 30; seed += 1) assert.throws(() => projectHistoryPrefix(malformed, "r", "c", "i", seed), /dataset_unknown_status: unknown/);
      assert.throws(() => trackerHistoryExample(malformed, "r", "c", "i"), /dataset_unknown_status: unknown/);
      for (const patches of [["unknown"], ["unknown", "closed"]]) {
        const imported = JSON.stringify({ patch: patches.map((value) => ({ path: "/metadata/status", value })) });
        assert.throws(() => projectHistoryPrefix(imported, "r", "c", "i", 42), /dataset_unknown_status: unknown/);
        assert.throws(() => trackerHistoryExample(imported, "r", "c", "i"), /dataset_unknown_status: unknown/);
      }
    } else {
      const manifest = buildTrackerDataset(directories, directory, 42, { task: "history-prefix" });
      const rows = TRACKER_SPLITS.flatMap((split) => readTrackerSplit(directory, manifest, split));
      assert.equal(rows.length, 160, "the status-free cut is omitted, while every sealed split remains readable");
      assert.equal(projectHistoryPrefix(malformed, "r", "c", "i", 42), null);
    }
    const valid = join(root, "valid-prefix");
    const manifest = buildTrackerDataset(directories.slice(1), valid, 42, { task: "history-prefix" });
    const rows = readTrackerSplit(valid, manifest, "train").map((row, index) => index === 0 ? { ...row, prefix: invalid === "empty" ? [] : ["unknown"] } : row);
    writeFileSync(join(valid, "train.json"), JSON.stringify(rows));
    const sealed = { ...manifest, splits: { ...manifest.splits, train: { count: rows.length, digest: hashJson(rows as unknown as JsonValue) } } };
    assert.throws(() => readTrackerSplit(valid, sealed, "train"), invalid === "empty" ? /dataset_prefix/ : /dataset_unknown_status: unknown/);
  });
});

test("hashed learner responds to every declared observable and actually changes bounded parameters", () => {
  const features = prefixFeatures(prefix, knobs);
  for (const change of [{ events: [...prefix.events].reverse() }, { fields: ["priority"] }, { words: [99] }, { elapsed_ms: 0 }, { authors: 1 }]) assert.notDeepEqual(prefixFeatures({ ...prefix, ...change }, knobs), features);
  const source = prefixCheckpoint(new Array<number>(32).fill(0), knobs);
  const fit = fitPrefix({ knobs, rows: Array.from({ length: 128 }, () => ({ prefix, label: 0 as const })) }, source, 0.5);
  assert.notEqual(source.digest, fit.digest); assert.equal(prefixPrediction(prefix, fit), "fast"); assert.equal(prefixPrediction(prefix, source), "slow");
  assert.deepEqual(fit, prefixCheckpoint(fit.weights, knobs));
  for (const patch of [{ regularisation: -1 }, { regularisation: NaN }, { ngram_order: 0 }, { ngram_order: 1.2 }, ...[8, 33, 1.5, NaN, 8192].map((hashing_width) => ({ hashing_width }))]) assert.throws(() => validatePrefixKnobs({ ...knobs, ...patch }));
  for (const patch of [{ events: [] }, { fields: ["bad/path"] }, { words: [-1] }, { elapsed_ms: -1 }, { authors: 0.5 }]) assert.throws(() => validateHistoryPrefix({ ...prefix, ...patch }));
  assert.throws(() => prefixCheckpoint([0], knobs), /weights/); assert.throws(() => prefixCheckpoint(new Array<number>(32).fill(Infinity), knobs), /weights/);
  assert.throws(() => fitPrefix({ knobs, rows: [] }, source, 0.5), /bounds/);
  assert.throws(() => fitPrefix({ knobs, rows: [{ prefix, label: 2 as 0 }] }, source, 0.5), /label/);
  assert.throws(() => fitPrefix({ knobs: { ...knobs, regularisation: 0.02 }, rows: [] }, source, 0.5), /source_knobs/);
  assert.ok(prefixFeatures({ ...prefix, events: ["create"] }, { ...knobs, ngram_order: 3 }).length === 32);
  assert.throws(() => recipeArtifact({ ...recipe.knobs, prefix: { ...knobs, hashing_width: 8192 } }));
  assert.ok(seededRecipes(recipe, 42, 1, 8).every((next) => next.knobs.prefix !== undefined));
  const largeRecipe = recipeArtifact({ ...recipe.knobs, prefix: { ...knobs, hashing_width: 4096 } });
  assert.ok(seededRecipes(largeRecipe, 42, 1, 8).every((next) => next.knobs.prefix!.hashing_width >= 1024));
});

test("trainer IO publishes exact measured checkpoint evidence and validation refuses forged parameters", async () => {
  const root = mkdtempSync(join(tmpdir(), "rl-prefix-io-"));
  const source = prefixCheckpoint(new Array<number>(32).fill(0), knobs);
  const input: ProcessInput<PrefixCheckpoint> = { identity: {}, source, training: [], observations: [], training_config: { learning_rate: 0.25, steps: 1 }, lineage: {}, prefix: { rows: [{ prefix, label: 0 }], knobs } };
  let output = "";
  const sink = new Writable({ write(chunk: Buffer, _encoding, callback) { output += String(chunk); callback(); } });
  const artifactRoot = mkdtempSync(join(tmpdir(), "rl-prefix-artifacts-"));
  await runPrefixTrainer(Readable.from([JSON.stringify({ job: "synthetic", input, artifactRoot })]), sink, root);
  const completion = JSON.parse(readFileSync(join(root, "completion.json"), "utf8")) as ProcessCompletion;
  writeFileSync(join(root, "runner.json"), JSON.stringify({ started_at: Date.now() - 1000 }));
  const verified = validateProcessCompletion(root, "synthetic", input, { training_steps: 1, wall_ms: 30000, storage_bytes: 4096, compute_units: 30000, tokens: 0 }, artifactRoot);
  const bytes = Buffer.from(JSON.stringify(verified.policy));
  assert.equal(verified.policy.digest, completion.policy.digest);
  assert.ok(output.includes('"complete"')); validatePrefixCompletion(bytes, verified, input as unknown as ProcessInput);
  assert.throws(() => validatePrefixCompletion(Buffer.from(JSON.stringify({ ...source, digest: "forged" })), completion, input as unknown as ProcessInput), /identity/);
  assert.throws(() => validatePrefixCompletion(bytes, { ...completion, policy: source as unknown as ProcessCompletion["policy"] }, input as unknown as ProcessInput), /policy/);
  assert.throws(() => validatePrefixCompletion(bytes, verified, { ...input, prefix: { rows: [], knobs: { ...knobs, regularisation: 0.01 } } } as unknown as ProcessInput), /knobs/);
  assert.ok(prefixTrainerArgv()[1].endsWith(".ts")); assert.ok(prefixTrainerArgv(new URL("../dist/prefix-trainer.js", import.meta.url).href)[1].endsWith(".js"));
  await prefixTrainerMain(["node", new URL("./prefix.test.ts", import.meta.url).pathname], new URL("../prefix-trainer.ts", import.meta.url).href);
  const other = mkdtempSync(join(tmpdir(), "rl-prefix-main-"));
  await prefixTrainerMain(["node", new URL("../prefix-trainer.ts", import.meta.url).pathname], new URL("../prefix-trainer.ts", import.meta.url).href, Readable.from([JSON.stringify({ job: "synthetic", input, artifactRoot })]), sink, other);
});

test("public snapshot builder pins the task, calibrates only fit items and preserves repository compartments", async () => {
  await withTrackerSources(async ({ root, directories }) => {
    const directory = join(root, "prefix"); const manifest = buildTrackerDataset(directories, directory, 42, { task: "history-prefix" });
    assert.deepEqual(readTrackerDataset(directory), manifest); assert.equal(manifest.task, "history-prefix");
    const train = readTrackerSplit(directory, manifest, "train"); const inner = readTrackerSplit(directory, manifest, "inner-held-out");
    assert.ok(train.every((row) => !prefixInnerExample(row.id))); assert.ok(inner.every((row) => prefixInnerExample(row.id)));
    assert.equal(manifest.calibration!.candidates[0].samples, train.length);
    assert.ok(manifest.calibration!.candidates[3].majority <= 0.6);
    for (const split of TRACKER_SPLITS) assert.ok(readTrackerSplit(directory, manifest, split).every((row) => row.history !== undefined && ["fast", "slow"].includes(row.label)));
    const w = await metaWorkspace();
    const harness = await createExtensionTestHarness(extension, { name: "pm-rl", capabilities: ["commands", "hooks", "schema"] });
    const command = await harness.runCommand({ command: "rl dataset build", pmRoot: w.coordinates.pmRoot, args: directories.slice(1),
      options: { fromTrackers: directories[0], output: join(root, "command-prefix"), task: "history-prefix" } });
    assert.equal(command.handled, true, command.errorMessage ?? "prefix command failed"); assert.equal((command.result as RlCommandResult).details!.task, "history-prefix");
    const pinned = buildTrackerDataset(directories, join(root, "pinned"), 42, { task: "history-prefix", pins: manifest.sources });
    assert.equal(pinned.digest, manifest.digest);
    assert.throws(() => buildTrackerDataset(directories, join(root, "missing-pin"), 42, { pins: [] }), /pin_missing/);
    assert.throws(() => buildTrackerDataset(directories, join(root, "bad-task"), 42, { task: "other" as "history-prefix" }), /dataset_task/);
    const project = dirname(dirname(directories[0]));
    writeFileSync(join(directories[0], "history", "unclosed.jsonl"), JSON.stringify({ ts: "2026-01-01T00:00:00Z", op: "create", author: "fixture", patch: [{ path: "/metadata/status", value: "open" }] }) + "\n");
    git(project, ["add", ".agents/pm/history/unclosed.jsonl"]);
    git(project, ["-c", "user.name=Public Fixture", "-c", "user.email=public@example.test", "commit", "-qm", "Add nonterminal synthetic history"]);
    const partial = buildTrackerDataset(directories, join(root, "with-unclosed"), 42, { task: "history-prefix" });
    assert.equal(TRACKER_SPLITS.reduce((count, split) => count + partial.splits[split].count, 0), 160, "an open-only item has no future close label and must be omitted");
  });
});

test("majority comparison computes a one-sided exact tail and refuses insufficient improvement", () => {
  assert.ok(majorityBinomial(80, 100, 0.5).beats_majority); assert.ok(majorityBinomial(80, 100, 0.5).p_value < 1e-6);
  assert.equal(majorityBinomial(50, 100, 0.5).beats_majority, false); assert.equal(majorityBinomial(0, 10, 0).p_value, 1);
  assert.equal(majorityBinomial(1, 10, 0).p_value, 0); assert.equal(majorityBinomial(10, 10, 1).p_value, 1);
  assert.throws(() => majorityBinomial(11, 10, 0.5), /inputs/);
  assert.ok(majorityBinomial(1, 10000, 0.5).p_value > 0.999999);
  assert.ok(majorityBinomial(100, 100, 0.5).p_value < 1e-20);
});

test("real reserved process fits are explicit even when the unchanged inner gate refuses and replay preserves evidence", { timeout: 600_000 }, async () => {
  const w = await metaWorkspace();
  const directory = join(w.root, "prefix-dataset");
  const previousPath = process.env.PATH; process.env.PATH = `${w.bin}:${previousPath}`;
  let manifest;
  try { manifest = buildTrackerDataset(w.directories, directory, 42, { task: "history-prefix", pins: w.manifest.sources }); } finally { process.env.PATH = previousPath; }
  const config = { ...metaConfig, initial_recipe: recipe, criterion: { confidence: 0.95, minSamples: 10, effectThreshold: 0.01 } };
  const report = await runRlMeta(w.client, w.coordinates, { id: "prefix-loop", config, dataset: directory, approval: w.approval, proposer: "seeded" });
  assert.equal(report.generations.length, 2);
  for (const policy of [report.initial, ...report.generations.flatMap((generation) => generation.candidates.map((candidate) => candidate.candidate))]) {
    assert.ok(policy.fit!.changed); assert.ok(policy.fit!.candidate.weights.some((weight) => weight !== 0));
    assert.ok(policy.fit!.accepted || policy.fit!.refusal !== null);
    assert.equal(policy.checkpoint, policy.prefix!.digest);
    assert.equal((await readProcessJob(w.client, policy.fit!.job))!.state, policy.fit!.accepted ? "promoted" : "evaluated");
    assert.equal(policy.fit!.calibration.candidate.accuracy.mean, policy.fit!.mean);
    assert.equal(policy.fit!.calibration.candidate.samples, policy.fit!.samples);
    assert.equal(policy.fit!.calibration.retained.accuracy.mean, prefixAccuracy(readTrackerSplit(directory, manifest, "inner-held-out"), policy));
    assert.ok(policy.fit!.calibration.training_frequency.brier >= 0);
  }
  assert.ok(report.final_test.majority_test !== undefined);
  assert.ok(report.final_test.diagnostics.calibration);
  assert.equal(report.final_test.diagnostics.calibration!.accuracy.mean, report.final_test.after.mean);
  const programmeId = "prefix-loop-step-programme";
  const programmeBody = String((await w.client.get(programmeId)).item.body);
  const programme = JSON.parse(programmeBody) as Record<string, JsonValue>;
  const legacyInput = { ...(programme.result as Record<string, JsonValue>), format: "pm-rl/meta-programme/1" };
  const jobsBeforeLegacy = await listProcessJobs(w.client);
  try {
    await w.client.update(programmeId, { body: JSON.stringify({ ...programme, input: hashJson({ binding: hashJson(legacyInput), value: legacyInput }), result: legacyInput, digest: hashJson(legacyInput) }) });
    const phases: string[] = [];
    await assert.rejects(runRlMeta(w.client, w.coordinates, { id: "prefix-loop", config, dataset: directory, approval: w.approval, proposer: "seeded", onStep(key) { phases.push(key); } }), (error: unknown) => isPmCliExpectedError(error) && error.context.code === "loop_step_drift");
    assert.deepEqual(phases, [], 'pre-calibration programmes refuse before any phase is adopted');
    assert.deepEqual(await listProcessJobs(w.client), jobsBeforeLegacy);
  } finally { await w.client.update(programmeId, { body: programmeBody }); }
  const originalSplits = { train: readFileSync(join(directory, "train.json")), "inner-held-out": readFileSync(join(directory, "inner-held-out.json")) };
  const copy = { ...manifest, splits: { ...manifest.splits } };
  /** Rebind only disposable synthetic split content to test inner acceptance and gap rejection. */
  const uniform = (split: "train" | "inner-held-out", label: "fast" | "slow"): void => {
    const rows = readTrackerSplit(directory, copy, split).map((row) => ({ ...row, label }));
    writeFileSync(join(directory, `${split}.json`), JSON.stringify(rows));
    copy.splits[split] = { count: rows.length, digest: hashJson(rows as unknown as JsonValue) };
  };
  uniform("train", "fast"); uniform("inner-held-out", "fast");
  const accepted = await fitHistoryPrefix(w.client, w.coordinates, directory, copy, config, w.approval, recipe, "accepted", new AbortController().signal);
  assert.ok(accepted.fit!.accepted); assert.equal(accepted.fit!.refusal, null);
  assert.equal((await readProcessJob(w.client, accepted.fit!.job))!.state, "promoted");
  assert.ok(accepted.prefix!.weights.some((weight) => weight !== 0));
  assert.deepEqual(await fitHistoryPrefix(w.client, w.coordinates, directory, copy, config, w.approval, recipe, "accepted", new AbortController().signal), accepted);
  await assert.rejects(fitHistoryPrefix(w.client, w.coordinates, directory, copy, config, w.approval, recipeArtifact({ ...recipe.knobs, selection: "balanced" }), "no-class", new AbortController().signal), /balanced_class_missing/);
  uniform("train", "slow");
  const gap = await fitHistoryPrefix(w.client, w.coordinates, directory, copy, config, w.approval, recipe, "gap", new AbortController().signal);
  assert.equal(gap.fit!.refusal, "gap_rejected");
  assert.equal((await readProcessJob(w.client, gap.fit!.job))!.state, "evaluated");
  assert.deepEqual(await fitHistoryPrefix(w.client, w.coordinates, directory, copy, config, w.approval, recipe, "gap", new AbortController().signal), gap);
  const overlap = [...readTrackerSplit(directory, copy, "inner-held-out"), readTrackerSplit(directory, copy, "train")[0]];
  writeFileSync(join(directory, "inner-held-out.json"), JSON.stringify(overlap));
  copy.splits["inner-held-out"] = { count: overlap.length, digest: hashJson(overlap as unknown as JsonValue) };
  await assert.rejects(fitHistoryPrefix(w.client, w.coordinates, directory, copy, config, w.approval, recipe, "overlap", new AbortController().signal), /prefix_inner_overlap/);
  for (const split of ["train", "inner-held-out"] as const) writeFileSync(join(directory, `${split}.json`), originalSplits[split]);
  assert.deepEqual(await runRlMeta(w.client, w.coordinates, { id: "prefix-loop", config, dataset: directory, approval: w.approval, proposer: "seeded" }), report);
  assert.throws(() => prefixAccuracy([], report.initial), /inputs/);
  await assert.rejects(fitHistoryPrefix(w.client, w.coordinates, directory, manifest, config, w.approval, INITIAL_RECIPE, "missing", new AbortController().signal), /recipe_required/);
  const source = prefixCheckpoint(new Array<number>(32).fill(0), knobs);
  const input: ProcessInput<PrefixCheckpoint> = { identity: {}, source, training: [], observations: [], training_config: { learning_rate: 0.25, steps: 1 }, lineage: {}, prefix: { rows: [{ prefix, label: 0 }], knobs } };
  await assert.rejects(executeProcessTrainer(w.client, w.coordinates, input, w.approval, { kind: "compose-bandit", image: `sha256:${"a".repeat(64)}`, allowance: config.adapter.allowance }), /packaged process adapter/);
  await assert.rejects(executeProcessTrainer(w.client, w.coordinates, { ...input, lm: {} as NonNullable<ProcessInput["lm"]> }, w.approval, config.adapter), /packaged process adapter/);
  const signal = AbortSignal.abort();
  await assert.rejects(fitHistoryPrefix(w.client, w.coordinates, directory, manifest, config, w.approval, recipe, "cancelled", signal));
});

test("one fitted classifier distinguishes prefixes with both labels instead of learning only a constant", () => {
  const left = { ...prefix, events: ["create"], words: [2, 4, 6, 8], fields: ["status"], elapsed_ms: 0, authors: 1 };
  const right = { ...prefix, events: ["comment_add", "claim", "comment_add"], words: [21, 23, 25], fields: ["files", "tests"], elapsed_ms: 100_000_000, authors: 4 };
  const rows = Array.from({ length: 256 }, () => [{ prefix: left, label: 0 as const }, { prefix: right, label: 1 as const }]).flat();
  const source = prefixCheckpoint(new Array<number>(32).fill(0), knobs);
  const fitted = fitPrefix({ knobs, rows }, source, 1);
  assert.equal(prefixPrediction(left, fitted), "fast"); assert.equal(prefixPrediction(right, fitted), "slow");
  const examples = rows.slice(0, 100).map((row, index) => ({ id: String(index), repo: "public-fixture/pm-paired", commit: "a".repeat(40), prefix: ["open"], history: row.prefix, label: row.label === 0 ? "fast" as const : "slow" as const }));
  const policy = { recipe, weight: 0, checkpoint: fitted.digest, prefix: fitted };
  const comparison = prefixMajorityComparison(examples, policy);
  assert.ok(comparison.beats_majority); assert.equal(comparison.wins, 50); assert.equal(comparison.losses, 0);
  const seed = { ...policy, checkpoint: source.digest, prefix: source };
  assert.equal(prefixMajorityComparison(examples, seed).beats_majority, false);
  const marginal = examples.map((row, index) => ({ ...row, label: index < 50 ? "fast" as const : "slow" as const, history: index === 0 ? left : right }));
  const marginalComparison = prefixMajorityComparison(marginal, policy);
  assert.equal(marginalComparison.wins - marginalComparison.losses, 1); assert.equal(marginalComparison.beats_majority, false);
  const identical = prefixMajorityComparison(examples.map((row) => ({ ...row, label: "slow" })), seed);
  assert.equal(identical.p_value, 1); assert.equal(identical.wins + identical.losses, 0);
});

test("live prefix acceptance installs the packed command and retains public per-example provenance", { timeout: 600_000 }, async () => {
  await withTrackerSources(async ({ root, directories }) => {
    const snapshot = buildTrackerDataset(directories, join(root, "pins"));
    const pinsFile = join(root, "original-evidence.json"); writeFileSync(pinsFile, JSON.stringify({ dataset: snapshot }));
    let evidence: Awaited<ReturnType<typeof runLiveMetaAcceptance>> | undefined;
    await liveMetaMain({ PM_RL_TRACKER_ROOT: root }, (value) => { evidence = value; }, pinsFile);
    assert.equal(evidence!.report.generations.length, 2);
    assert.ok(evidence!.report.initial.fit!.changed);
    const summary = JSON.parse(readFileSync(join(new URL("..", import.meta.url).pathname, evidence!.artifacts, "summary.json"), "utf8")) as { examples: { repo: string; commit: string; prefix_digest: string }[] };
    assert.equal(summary.examples.length, 160);
    assert.ok(summary.examples.every((row) => row.repo.startsWith("public-fixture/") && /^[a-f0-9]{40}$/.test(row.commit) && /^[a-f0-9]{64}$/.test(row.prefix_digest)));
  });
});

test("inner comparison distinguishes fitted checkpoint identity from its unchanged recipe identity", () => {
  const source: RecipePolicy = { recipe, weight: 0, checkpoint: "source-checkpoint" };
  const candidate = { ...source, checkpoint: "fitted-checkpoint" };
  const score = { mean: 1, samples: 1000, context: "synthetic-sealed" };
  const baseline = { ...score, mean: 0 };
  const criterion = { confidence: 0.95, minSamples: 10, effectThreshold: 0.01 };
  assert.equal(compareRecipes(candidate, source, score, baseline, criterion, "checkpoint").verdict.decision, "promote");
  assert.equal(compareRecipes(candidate, source, score, baseline, criterion).verdict.decision, "refuse");
});


test("live target selector rejects unknown families before reading any source", async () => {
  await assert.rejects(liveMetaMain({ PM_RL_TRACKER_TASK: "unknown" }), /meta_live_task/);
});
