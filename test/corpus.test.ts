/** Real tracker snapshots and inherited durable jobs work without Git or source mutation. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs, { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import fsPromises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { test } from "node:test";
import { EXIT_CODE, isPmCliExpectedError } from "@unbrained/pm-cli/sdk/runtime";
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

/** Populate a real tracker with the smallest valid split shared by command regressions. */
async function seedCorpusSource(client: Awaited<ReturnType<typeof processWorkspace>>["client"]): Promise<void> {
  const lengths = [false, true].flatMap((held) => Array.from({ length: 80 }, (_, i) => i + 1).filter((n) => corpusHeldOut(n) === held).slice(0, 2));
  for (const length of lengths) await client.create({ id: `source-${length}`, type: "Task", title: "z".repeat(length) });
}

test("corpus output conflicts refuse before source or bounds reads without exposing paths", async () => {
  const w = await processWorkspace();
  const harness = await createExtensionTestHarness(extension, { name: "pm-rl", capabilities: ["commands", "hooks", "schema"] });
  const existing = join(w.root, "existing.json"); writeFileSync(existing, "preserve bytes");
  const dangling = join(w.root, "dangling.json"); symlinkSync(join(w.root, "absent"), dangling);
  for (const output of [existing, dangling, w.pmRoot]) {
    await assert.rejects(harness.runCommand({ command: "rl corpus build", pmRoot: w.pmRoot, args: [], options: {
      from_tracker: join(w.root, "missing-source"), file: join(w.root, "missing-bounds"), output,
    } }), (error: unknown) => {
      assert.ok(isPmCliExpectedError(error)); assert.equal(error.context.code, "corpus_output_exists");
      assert.equal(error.exitCode, EXIT_CODE.CONFLICT); assert.ok(!error.message.includes(w.root)); return true;
    });
  }
  assert.equal(readFileSync(existing, "utf8"), "preserve bytes");
  assert.equal(existsSync(join(w.root, "absent")), false);
});

test("corpus output inside the source refuses before inventory reads through relative and symlink aliases", async () => {
  const w = await processWorkspace();
  const harness = await createExtensionTestHarness(extension, { name: "pm-rl", capabilities: ["commands", "hooks", "schema"] });
  const nested = join(w.pmRoot, "nested"); mkdirSync(nested);
  const alias = join(w.root, "source-alias"); symlinkSync(w.pmRoot, alias, "dir");
  const childAlias = join(w.root, "child-alias"); symlinkSync(nested, childAlias, "dir");
  /** Capture every source file, so rejected commands cannot add or alter tracker bytes. */
  const snapshot = (): [string, string][] => readdirSync(w.pmRoot, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile()).map((entry) => {
    const path = join(entry.parentPath, entry.name); return [relative(w.pmRoot, path), readFileSync(path, "hex")];
  });
  const before = snapshot();
  for (const [source, output] of [
    [w.pmRoot, join(w.pmRoot, "sealed.json")], [w.pmRoot, join(nested, "sealed.json")],
    [w.pmRoot, join(alias, "sealed.json")], [alias, join(w.pmRoot, "sealed.json")],
    [w.pmRoot, join(childAlias, "sealed.json")], [w.pmRoot, relative(process.cwd(), join(nested, "..", "sealed.json"))],
  ]) {
    await assert.rejects(harness.runCommand({ command: "rl corpus build", pmRoot: w.pmRoot, args: [], options: {
      from_tracker: source, file: join(w.root, "missing-bounds"), output,
    } }), refuses("corpus_output_inside_source"));
    assert.equal(existsSync(output), false); assert.deepEqual(snapshot(), before);
  }
});

test("corpus exclusive publication handles a real concurrent creator and preserves other IO errors", async (t) => {
  const w = await processWorkspace(); await seedCorpusSource(w.client);
  const harness = await createExtensionTestHarness(extension, { name: "pm-rl", capabilities: ["commands", "hooks", "schema"] });
  const options = { from_tracker: w.pmRoot, file: new URL("../examples/loop-corpus.json", import.meta.url).pathname, output: join(dirname(w.pmRoot), "sealed.json") };
  const sibling = `${w.pmRoot}-copy`; mkdirSync(sibling);
  for (const output of [options.output, join(sibling, "sealed.json")]) {
    await harness.runCommand({ command: "rl corpus build", pmRoot: w.pmRoot, args: [], options: { ...options, output } });
    assert.equal((JSON.parse(readFileSync(output, "utf8")) as Record<string, JsonValue>).fit_steps, 8);
    rmSync(output);
  }
  const original = fsPromises.writeFile;
  for (const conflict of [true, false]) {
    const parent = join(w.root, conflict ? "race" : "removed"); mkdirSync(parent);
    const output = join(parent, "sealed.json");
    const injection = t.mock.method(fsPromises, "writeFile", async (...args: Parameters<typeof original>) => {
      if (args[0] === output) {
        if (conflict) writeFileSync(output, "concurrent creator"); else rmSync(parent, { recursive: true });
      }
      return original(...args);
    });
    syncBuiltinESMExports();
    try {
      const command = harness.runCommand({ command: "rl corpus build", pmRoot: w.pmRoot, args: [], options: { ...options, output } });
      if (conflict) await assert.rejects(command, refuses("corpus_output_exists"));
      else await assert.rejects(command, refuses("corpus_output_parent_missing"));
      if (conflict) assert.equal(readFileSync(output, "utf8"), "concurrent creator");
    } finally { injection.mock.restore(); syncBuiltinESMExports(); }
  }
  for (const code of ["EACCES", "ENOTDIR"]) {
    const injection = t.mock.method(fsPromises, "writeFile", async () => { throw Object.assign(new Error(`synthetic ${code}`), { code }); });
    syncBuiltinESMExports();
    try {
      const command = harness.runCommand({ command: "rl corpus build", pmRoot: w.pmRoot, args: [], options });
      if (code === "ENOTDIR") await assert.rejects(command, refuses("corpus_output_parent_missing"));
      else assert.match(JSON.stringify(await command), /synthetic EACCES/);
    } finally { injection.mock.restore(); syncBuiltinESMExports(); }
  }
});

test("corpus missing or invalid directories refuse with stable path-free errors before inventory reads", async (t) => {
  const w = await processWorkspace();
  const harness = await createExtensionTestHarness(extension, { name: "pm-rl", capabilities: ["commands", "hooks", "schema"] });
  const file = join(w.root, "plain-file"); writeFileSync(file, "preserve bytes");
  const missing = join(w.root, "absent");
  const dangling = join(w.root, "dangling"); symlinkSync(missing, dangling);
  for (const [source, output, code] of [
    ...[missing, file, join(file, "child"), dangling].map((source) => [source, join(w.root, "sealed.json"), "corpus_source_missing"]),
    ...[missing, file, join(file, "child"), dangling].map((parent) => [w.pmRoot, join(parent, "sealed.json"), "corpus_output_parent_missing"]),
  ]) {
    await assert.rejects(harness.runCommand({ command: "rl corpus build", pmRoot: w.pmRoot, args: [], options: {
      from_tracker: source, file: join(w.root, "missing-bounds"), output,
    } }), (error: unknown) => {
      assert.ok(refuses(code)(error)); assert.ok(error instanceof Error); assert.ok(!error.message.includes(w.root)); return true;
    });
    assert.equal(existsSync(output), false);
  }
  const denied = Object.assign(new Error("synthetic read denied"), { code: "EACCES" });
  const original = fs.realpathSync;
  const injection = t.mock.method(fs, "realpathSync", (...args: Parameters<typeof original>) => {
    if (args[0] === w.pmRoot) throw denied;
    return original(...args);
  });
  syncBuiltinESMExports();
  try {
    const result = await harness.runCommand({ command: "rl corpus build", pmRoot: w.pmRoot, args: [], options: {
      from_tracker: w.pmRoot, file: join(w.root, "missing-bounds"), output: join(w.root, "sealed.json"),
    } });
    assert.match(JSON.stringify(result), /synthetic read denied/);
  } finally { injection.mock.restore(); syncBuiltinESMExports(); }
  assert.equal(readFileSync(file, "utf8"), "preserve bytes");
});

test("corpus publication pins canonical targets and rechecks alias and canonical containment after collection", async (t) => {
  const w = await processWorkspace(); await seedCorpusSource(w.client);
  const harness = await createExtensionTestHarness(extension, { name: "pm-rl", capabilities: ["commands", "hooks", "schema"] });
  const file = new URL("../examples/loop-corpus.json", import.meta.url).pathname;
  const sourceFiles = readdirSync(w.pmRoot, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile()).map((entry) => {
    const path = join(entry.parentPath, entry.name); return [path, readFileSync(path, "hex")];
  });
  for (const mode of ["alias-inside", "canonical-inside", "alias-outside", "removed"]) {
    const parent = join(w.root, mode); mkdirSync(parent);
    const alternate = join(w.root, `${mode}-alternate`); mkdirSync(alternate);
    const alias = join(w.root, `${mode}-alias`); symlinkSync(parent, alias, "dir");
    const output = join(alias, "sealed.json");
    const original = fs.readFileSync;
    let swapped = false;
    const injection = t.mock.method(fs, "readFileSync", (...args: Parameters<typeof original>) => {
      const result = original(...args);
      if (args[0] === file && !swapped) {
        swapped = true;
        if (mode === "canonical-inside") { renameSync(parent, `${parent}-saved`); symlinkSync(w.pmRoot, parent, "dir"); }
        else if (mode === "removed") rmSync(parent, { recursive: true });
        else { rmSync(alias); symlinkSync(mode === "alias-inside" ? w.pmRoot : alternate, alias, "dir"); }
      }
      return result;
    });
    syncBuiltinESMExports();
    try {
      const command = harness.runCommand({ command: "rl corpus build", pmRoot: w.pmRoot, args: [], options: { from_tracker: w.pmRoot, file, output } });
      if (mode === "alias-outside") {
        await command;
        assert.equal((JSON.parse(readFileSync(join(parent, "sealed.json"), "utf8")) as Record<string, JsonValue>).fit_steps, 8);
        assert.equal(existsSync(output), false, "publication retains the initially selected canonical target");
      } else await assert.rejects(command, refuses(mode === "removed" ? "corpus_output_parent_missing" : "corpus_output_inside_source"));
      assert.equal(swapped, true);
      assert.equal(existsSync(join(w.pmRoot, "sealed.json")), false);
      for (const [path, bytes] of sourceFiles) assert.equal(readFileSync(path, "hex"), bytes);
    } finally { injection.mock.restore(); syncBuiltinESMExports(); }
  }
});

test("corpus documentation identifies the complete prior executable-source receipts", () => {
  const documentation = readFileSync(new URL("../docs/tracker-loop.md", import.meta.url), "utf8");
  const receipt = documentation.split("## Verification receipts")[1];
  assert.match(receipt, /39645374144/);
  assert.match(receipt, /56e28544c28158f36654fb3f0ce58f300e96ef86/);
  assert.equal((receipt.match(/685\/685/g) ?? []).length, 3);
  assert.match(receipt, /corpus command passes 9\/9/);
  assert.doesNotMatch(receipt, /682\/682|6\/6|a36191ac506a8b29d6b51f0d718caba1bd5e100d/);
});

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
  await seedCorpusSource(w.client);
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
