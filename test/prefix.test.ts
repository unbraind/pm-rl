/** Behavioural acceptance for sealed projections, real fits, feature sensitivity and statistical refusals. */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { test } from "node:test";
import extension, { hashJson, type JsonValue, type RlCommandResult } from "../index.ts";
import { createExtensionTestHarness } from "@unbrained/pm-cli/sdk/testing";
import { buildTrackerDataset, readTrackerDataset, readTrackerSplit, TRACKER_SPLITS } from "../dataset.ts";
import { calibratePrefixTarget, prefixInnerExample, projectHistoryPrefix, validateHistoryPrefix, type HistoryPrefix, type PrefixProjection } from "../prefix-data.ts";
import { fitPrefix, prefixCheckpoint, prefixFeatures, prefixPrediction, validatePrefixCompletion, validatePrefixKnobs, type PrefixCheckpoint } from "../prefix.ts";
import { majorityBinomial, fitHistoryPrefix, prefixAccuracy, prefixMajorityComparison } from "../prefix-environment.ts";
import { prefixTrainerArgv, prefixTrainerMain, runPrefixTrainer } from "../prefix-trainer.ts";
import { INITIAL_RECIPE, recipeArtifact, seededRecipes } from "../recipe.ts";
import { metaWorkspace, withTrackerSources, metaConfig } from "./fixtures/meta-workspace.ts";
import { compareRecipes, runRlMeta, type RecipePolicy } from "../meta.ts";
import { executeProcessTrainer, validateProcessCompletion, type ProcessCompletion, type ProcessInput } from "../process.ts";
import { runLiveMetaAcceptance, liveMetaMain } from "../scripts/live-meta.ts";

const knobs = { regularisation: 0.001, ngram_order: 2, hashing_width: 32 };
const prefix: HistoryPrefix = { events: ["create", "claim", "update", "comment_add"], fields: ["status", "title", "description", "status"], words: [42, 77, 12], elapsed_ms: 80_000, authors: 2 };
const recipe = recipeArtifact({ ...INITIAL_RECIPE.knobs, prefix: knobs });
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

test("hashed learner responds to every declared observable and actually changes bounded parameters", () => {
  const features = prefixFeatures(prefix, knobs);
  for (const change of [{ events: [...prefix.events].reverse() }, { fields: ["priority"] }, { words: [99] }, { elapsed_ms: 0 }, { authors: 1 }]) assert.notDeepEqual(prefixFeatures({ ...prefix, ...change }, knobs), features);
  const source = prefixCheckpoint(new Array<number>(32).fill(0), knobs);
  const fit = fitPrefix({ knobs, rows: Array.from({ length: 128 }, () => ({ prefix, label: 0 as const })) }, source, 0.5);
  assert.notEqual(source.digest, fit.digest); assert.equal(prefixPrediction(prefix, fit), "fast"); assert.equal(prefixPrediction(prefix, source), "slow");
  assert.deepEqual(fit, prefixCheckpoint(fit.weights, knobs));
  for (const patch of [{ regularisation: -1 }, { regularisation: NaN }, { ngram_order: 0 }, { ngram_order: 1.2 }, { hashing_width: 128 }]) assert.throws(() => validatePrefixKnobs({ ...knobs, ...patch }));
  for (const patch of [{ events: [] }, { fields: ["bad/path"] }, { words: [-1] }, { elapsed_ms: -1 }, { authors: 0.5 }]) assert.throws(() => validateHistoryPrefix({ ...prefix, ...patch }));
  assert.throws(() => prefixCheckpoint([0], knobs), /weights/); assert.throws(() => prefixCheckpoint(new Array<number>(32).fill(Infinity), knobs), /weights/);
  assert.throws(() => fitPrefix({ knobs, rows: [] }, source, 0.5), /bounds/);
  assert.throws(() => fitPrefix({ knobs, rows: [{ prefix, label: 2 as 0 }] }, source, 0.5), /label/);
  assert.throws(() => fitPrefix({ knobs: { ...knobs, regularisation: 0.02 }, rows: [] }, source, 0.5), /source_knobs/);
  assert.ok(prefixFeatures({ ...prefix, events: ["create"] }, { ...knobs, ngram_order: 3 }).length === 32);
  assert.throws(() => recipeArtifact({ ...recipe.knobs, prefix: { ...knobs, hashing_width: 128 } }));
  assert.ok(seededRecipes(recipe, 42, 1, 8).every((next) => next.knobs.prefix !== undefined));
});

test("trainer IO publishes exact measured checkpoint evidence and validation refuses forged parameters", async () => {
  const root = mkdtempSync(join(tmpdir(), "rl-prefix-io-"));
  const source = prefixCheckpoint(new Array<number>(32).fill(0), knobs);
  const input: ProcessInput<PrefixCheckpoint> = { identity: {}, source, training: [], observations: [], training_config: { learning_rate: 0.25, steps: 1 }, lineage: {}, prefix: { rows: [{ prefix, label: 0 }], knobs } };
  let output = "";
  const sink = new Writable({ write(chunk: Buffer, _encoding, callback) { output += String(chunk); callback(); } });
  await runPrefixTrainer(Readable.from([JSON.stringify({ job: "synthetic", input })]), sink, root);
  const completion = JSON.parse(readFileSync(join(root, "completion.json"), "utf8")) as ProcessCompletion;
  const bytes = readFileSync(join(root, "checkpoint.json"));
  writeFileSync(join(root, "runner.json"), JSON.stringify({ started_at: Date.now() - 1000 }));
  assert.equal(validateProcessCompletion(root, "synthetic", input, { training_steps: 1, wall_ms: 30000, storage_bytes: 4096, compute_units: 30000, tokens: 0 }).policy.digest, completion.policy.digest);
  assert.ok(output.includes('"complete"')); validatePrefixCompletion(bytes, completion, input as unknown as ProcessInput);
  assert.throws(() => validatePrefixCompletion(Buffer.from(JSON.stringify({ ...source, digest: "forged" })), completion, input as unknown as ProcessInput), /identity/);
  assert.throws(() => validatePrefixCompletion(bytes, { ...completion, policy: source as unknown as ProcessCompletion["policy"] }, input as unknown as ProcessInput), /policy/);
  assert.throws(() => validatePrefixCompletion(bytes, completion, { ...input, prefix: { rows: [], knobs: { ...knobs, regularisation: 0.01 } } } as unknown as ProcessInput), /knobs/);
  assert.ok(prefixTrainerArgv()[1].endsWith(".ts")); assert.ok(prefixTrainerArgv(new URL("../dist/prefix-trainer.js", import.meta.url).href)[1].endsWith(".js"));
  await prefixTrainerMain(["node", new URL("./prefix.test.ts", import.meta.url).pathname], new URL("../prefix-trainer.ts", import.meta.url).href);
  const other = mkdtempSync(join(tmpdir(), "rl-prefix-main-"));
  await prefixTrainerMain(["node", new URL("../prefix-trainer.ts", import.meta.url).pathname], new URL("../prefix-trainer.ts", import.meta.url).href, Readable.from([JSON.stringify({ job: "synthetic", input })]), sink, other);
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
  }
  assert.ok(report.final_test.majority_test !== undefined);
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
  assert.ok(accepted.prefix!.weights.some((weight) => weight !== 0));
  assert.deepEqual(await fitHistoryPrefix(w.client, w.coordinates, directory, copy, config, w.approval, recipe, "accepted", new AbortController().signal), accepted);
  await assert.rejects(fitHistoryPrefix(w.client, w.coordinates, directory, copy, config, w.approval, recipeArtifact({ ...recipe.knobs, selection: "balanced" }), "no-class", new AbortController().signal), /balanced_class_missing/);
  uniform("train", "slow");
  const gap = await fitHistoryPrefix(w.client, w.coordinates, directory, copy, config, w.approval, recipe, "gap", new AbortController().signal);
  assert.equal(gap.fit!.refusal, "gap_rejected");
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
