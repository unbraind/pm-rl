/** Real tracker/process acceptance for recipe search, with corruption, accounting and compartment drills. */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { fork } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { createExtensionTestHarness } from "@unbrained/pm-cli/sdk/testing";
import { certifyCompleteListResult } from "@unbrained/pm-cli/sdk/runtime";
import extension, { hashJson, withRlController, type JsonValue, type RlCommandResult, loopLeaseLockId } from "../index.ts";
import { compareRecipes, durableRecipeProposals, metaReservation, parseMetaConfig, proposeRecipes, recipeExamples, recipeSuccessor, runRlMeta, scoreTrackerPolicy, type MetaConfig, type MetaRequest } from "../meta.ts";
import { INITIAL_RECIPE, recipeArtifact, seededRecipes } from "../recipe.ts";
import { banditCheckpoint } from "../bandit.ts";
import { readTrackerSplit, type TrackerDataset, type TrackerExample, TRACKER_SPLITS } from "../dataset.ts";
import { listProcessJobs } from "../process.ts";
import { metaConfig, metaSpec, metaWorkspace, withTrackerSources } from "./fixtures/meta-workspace.ts";
import { liveMetaConfiguration, liveMetaMain, liveMetaOptions, printLiveMetaEvidence, publicTrackerDirectories, runLiveMetaAcceptance } from "../scripts/live-meta.ts";
import { runLiveCommand } from "../scripts/live-watchdog.ts";
import { openTrackerEnvironment, trackerDiagnostics } from "../tracker-environment.ts";

/** Bind a bounded request to the real temporary tracker and synthetic committed sources. */
function requestFor(workspace: Awaited<ReturnType<typeof metaWorkspace>>, id: string, config = metaConfig): MetaRequest {
  return { id, config, dataset: workspace.dataset, approval: workspace.approval, proposer: "seeded" };
}

test("meta programme bounds and search domains cannot tune the statistical gate or trainer command", () => {
  assert.deepEqual(parseMetaConfig(metaConfig), metaConfig);
  for (const key of ["seed", "meta_generations", "candidates", "timeout_ms", "evaluation_samples"] as const) {
    for (const value of [NaN, -1, 0x100000001, 1.1]) assert.throws(() => parseMetaConfig({ ...metaConfig, [key]: value }));
  }
  for (const patch of [{ criterion: { ...metaConfig.criterion, effectThreshold: 0 } }, { maximum_gap: NaN }, { maximum_gap: -1 }, { maximum_gap: 2 },
    { adapter: { kind: "shell" } }, { adapter: { ...metaConfig.adapter, kind: "compose-bandit", image: "sha256:" + "a".repeat(64) } }]) assert.throws(() => parseMetaConfig({ ...metaConfig, ...patch }));
  assert.equal(liveMetaConfiguration().meta_generations, 2);
  assert.throws(() => parseMetaConfig({ ...metaConfig, criterion: null }));
});

test("reward shaping, selection, ordering and temperature affect training only; proxy-only gain is refused", async () => {
  const w = await metaWorkspace(); const examples = readTrackerSplit(w.dataset, w.manifest, "train");
  const capabilities = openTrackerEnvironment(w.client, w.coordinates, w.dataset, metaConfig, w.approval);
  assert.deepEqual(Object.keys(capabilities).sort(), ["digest", "finalTest", "fit", "selection"]);
  const recipe = recipeArtifact({ ...INITIAL_RECIPE.knobs, selection: "balanced", curriculum: "reverse", temperature: 0.5, correct_weight: 0.75, incorrect_weight: 0.1 });
  const training = recipeExamples(examples, recipe, true); const held = recipeExamples(examples, recipe, false);
  assert.ok(training.length <= examples.length); assert.ok(training.some((example) => example.rewards[0] === 0.1));
  assert.ok(training.some((example) => example.rewards[1] === 0.1)); assert.deepEqual(new Set(held.flatMap((example) => [...example.rewards])), new Set([0, 1]));
  assert.throws(() => recipeExamples(examples.filter((example) => example.label === "completed"), recipe, true), /balanced_class_missing/);
  const incumbent = { recipe: INITIAL_RECIPE, weight: 0, checkpoint: banditCheckpoint(0).digest };
  const candidate = { recipe, weight: 1, checkpoint: banditCheckpoint(1).digest };
  const score = scoreTrackerPolicy(examples, candidate, "context", 42);
  assert.equal(score.samples, examples.length);
  const criterion = { confidence: 0.95, minSamples: 10, effectThreshold: 0.01 };
  const refused = compareRecipes(candidate, incumbent, { mean: 0.5, samples: 1000, context: "context" }, { mean: 0.5, samples: 1000, context: "context" }, criterion);
  assert.equal(refused.verdict.decision, "refuse"); assert.ok(refused.gain_lower_bound < 0);
  const accepted = compareRecipes(candidate, incumbent, { mean: 0.9, samples: 1000, context: "context" }, { mean: 0.5, samples: 1000, context: "context" }, criterion);
  assert.equal(accepted.verdict.decision, "promote"); assert.ok(accepted.gain_lower_bound > 0.01);
  const better = compareRecipes({ ...candidate, recipe: recipeArtifact({ ...recipe.knobs, temperature: 1.5 }) }, incumbent,
    { mean: 0.95, samples: 1000, context: "context" }, { mean: 0.5, samples: 1000, context: "context" }, criterion);
  assert.equal(recipeSuccessor(incumbent, [refused, accepted, better]).promoted, better.candidate.recipe.digest);
  assert.deepEqual(recipeSuccessor(incumbent, [refused]), { successor: incumbent, promoted: null });
  assert.equal(compareRecipes(candidate, incumbent, { ...score, context: "different" }, score, criterion).verdict.decision, "refuse");
});

test("synthetic held-out splits report majority baselines and deterministic prediction diversity", async () => {
  const w = await metaWorkspace();
  const environment = openTrackerEnvironment(w.client, w.coordinates, w.dataset, metaConfig, w.approval);
  const seed = { recipe: INITIAL_RECIPE, weight: 0, checkpoint: banditCheckpoint(0).digest };
  const same = { ...seed, recipe: recipeArtifact({ ...INITIAL_RECIPE.knobs, learning_rate: 1 }) };
  const comparison = environment.selection(same, seed);
  const final = environment.finalTest(seed, same);
  for (const diagnostics of [comparison.diagnostics, final.diagnostics]) {
    assert.deepEqual(diagnostics.majority_class, { label: "completed", correct: 16, samples: 32, mean: 0.5 });
    assert.equal(diagnostics.predictions.distinct_labels, 2);
    assert.equal(diagnostics.predictions.counts.completed + diagnostics.predictions.counts.cancelled, 32);
    assert.deepEqual(diagnostics.disagreements, [{ recipe: seed.recipe.digest, differing: 0, samples: 32, rate: 0 }]);
  }
  assert.deepEqual(environment.selection(same, seed), comparison);
  const examples = readTrackerSplit(w.dataset, w.manifest, "meta-validation");
  const positive = { ...same, weight: 1000 }; const negative = { ...seed, weight: -1000 };
  const polarized = environment.selection(positive, negative, [seed]);
  assert.equal(polarized.diagnostics.disagreements[0].rate, 1);
  assert.ok(polarized.diagnostics.disagreements[1].rate > 0 && polarized.diagnostics.disagreements[1].rate < 1);
  const cancelled = examples.filter((example) => example.label === "cancelled");
  const constant = trackerDiagnostics(cancelled, positive, [], metaConfig.seed);
  assert.deepEqual(constant.majority_class, { label: "cancelled", correct: 16, samples: 16, mean: 1 });
  assert.deepEqual(constant.predictions, { distinct_labels: 1, counts: { completed: 0, cancelled: 16 } });
  const completed = trackerDiagnostics(examples.filter((example) => example.label === "completed"), positive, [], metaConfig.seed);
  assert.deepEqual(completed.predictions, { distinct_labels: 1, counts: { completed: 16, cancelled: 0 } });
  assert.throws(() => trackerDiagnostics([], seed, [], 42), /meta_diagnostics_empty/);
});

test("two real meta generations retain recipes and process jobs, then resume without double charge or reading inner/final splits", { timeout: 600_000 }, async () => {
  const w = await metaWorkspace(); const request = requestFor(w, "recursive"); const phases: string[] = [];
  const first = await runRlMeta(w.client, w.coordinates, { ...request, onStep(key) { phases.push(key); } });
  assert.equal(first.generations.length, 2); assert.ok(first.generations.every((generation) => generation.candidates.length === 2));
  assert.deepEqual(first.generations.flatMap((generation) => generation.candidates.map((candidate) => candidate.diagnostics.disagreements.length)), [1, 2, 3, 4]);
  assert.equal(first.generations[1].candidates[0].incumbent, first.generations[0].promoted ?? first.initial.recipe.digest);
  assert.ok(phases.indexOf("final-test") > phases.indexOf("m2-promote"));
  const jobs = await listProcessJobs(w.client); assert.ok(jobs.length >= 5);
  assert.ok(jobs.every((job) => job.settled && job.charge.training_steps === 1 && job.approval === w.approval));
  assert.ok(first.generations.every((generation) => generation.candidates.every((candidate) => !("inner_held_out" in candidate))));
  const reservation = await w.client.get("recursive-reservation"); const original = String(reservation.item.body);
  renameSync(join(w.dataset, "inner-held-out.json"), join(w.dataset, "sealed-inner.json"));
  renameSync(join(w.dataset, "final-test.json"), join(w.dataset, "sealed-final.json"));
  assert.deepEqual(await runRlMeta(w.client, w.coordinates, request), first);
  assert.equal(String((await w.client.get("recursive-reservation")).item.body), original);
  assert.deepEqual(await listProcessJobs(w.client), jobs);
  await assert.rejects(runRlMeta(w.client, w.coordinates, { ...request, config: { ...request.config, seed: 43 } }), /disagrees/);
  const receipt = await w.client.get("recursive-step-m1-promote"); const record = JSON.parse(String(receipt.item.body)) as { result: { promoted: string } }; record.result.promoted = "forged";
  await w.client.update(receipt.item.id, { body: JSON.stringify(record) });
  await assert.rejects(runRlMeta(w.client, w.coordinates, request), /damaged/);
});

test("cancellation after committed inner work resumes exactly once; a contender cannot launch while the outer lease is held", { timeout: 600_000 }, async () => {
  const w = await metaWorkspace(); const controller = new AbortController(); const request = requestFor(w, "cancel", { ...metaConfig, meta_generations: 1, candidates: 1 });
  await assert.rejects(runRlMeta(w.client, w.coordinates, { ...request, signal: controller.signal, async onStep(key) {
    if (key === "initial") {
      await assert.rejects(runRlMeta(w.client, w.coordinates, request), /controller|contended/);
      controller.abort(new Error("synthetic cancellation"));
    }
  } }), /synthetic cancellation/);
  const jobs = await listProcessJobs(w.client); assert.equal(jobs.length, 1);
  const report = await runRlMeta(w.client, w.coordinates, request); assert.equal(report.generations.length, 1);
  const resumedJobs = await listProcessJobs(w.client);
  assert.ok(resumedJobs.length >= 2); assert.deepEqual(resumedJobs.find((job) => job.id === jobs[0].id), jobs[0]);
  const cancelled = new AbortController(); cancelled.abort(new Error("pre-cancelled"));
  await assert.rejects(runRlMeta(w.client, w.coordinates, { ...request, signal: cancelled.signal }), /pre-cancelled/);
});

test("a real outer SIGKILL adopts the committed fit and its original settled reservation", { timeout: 600_000 }, async () => {
  const w = await metaWorkspace(); const request = requestFor(w, "killed", { ...metaConfig, meta_generations: 1, candidates: 1 });
  const file = join(w.root, "kill-request.json"); writeFileSync(file, JSON.stringify(request));
  const environment = { ...process.env }; delete environment.NODE_V8_COVERAGE;
  const child = fork(new URL("./fixtures/meta-controller.ts", import.meta.url), [w.coordinates.pmRoot, file], { execArgv: [], env: environment, cwd: w.project, stdio: ["ignore", "ignore", "pipe", "ipc"] });
  let stderr = ""; child.stderr!.on("data", (bytes: Buffer) => { stderr += String(bytes); });
  const exited = once(child, "exit");
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const message = once(child, "message");
    const earlyExit = exited.then(() => { throw new Error(`Outer controller exited early: ${stderr}`); });
    const deadline = new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("Outer checkpoint barrier timed out")), 300_000); });
    await Promise.race([message, earlyExit, deadline]); clearTimeout(timer);
    const jobs = await listProcessJobs(w.client); assert.equal(jobs.length, 1);
    child.kill("SIGKILL"); await exited;
    const report = await runRlMeta(w.client, w.coordinates, request); assert.equal(report.generations.length, 1);
    assert.deepEqual((await listProcessJobs(w.client)).find((job) => job.id === jobs[0].id), jobs[0]);
  } finally {
    clearTimeout(timer); if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await exited; }
  }
});

test("a genuinely better recipe clears the unchanged gate and becomes the next meta generation incumbent", { timeout: 600_000 }, async (context) => {
  const w = await metaWorkspace();
  const fixture = JSON.parse(readFileSync(new URL("./fixtures/tracker-signal.json", import.meta.url), "utf8")) as {
    seed: number; initial_knobs: typeof INITIAL_RECIPE.knobs;
    splits: Record<typeof TRACKER_SPLITS[number], { repetitions: number; patterns: Pick<TrackerExample, "prefix" | "label">[] }>;
  };
  const initial = recipeArtifact(fixture.initial_knobs);
  const splits = { ...w.manifest.splits };
  for (const split of TRACKER_SPLITS) {
    const source = readTrackerSplit(w.dataset, w.manifest, split)[0];
    const signal = fixture.splits[split];
    const expanded = Array.from({ length: signal.repetitions * signal.patterns.length }, (_, index) => ({
      ...source, ...signal.patterns[index % signal.patterns.length], id: hashJson({ index, split, fixture: "known-signal" }),
    }));
    writeFileSync(join(w.dataset, `${split}.json`), JSON.stringify(expanded));
    splits[split] = { count: expanded.length, digest: hashJson(expanded as unknown as JsonValue) };
  }
  const { digest: _digest, ...record } = { ...w.manifest, splits };
  const manifest: TrackerDataset = { ...record, digest: hashJson(record as unknown as JsonValue) };
  writeFileSync(join(w.dataset, "dataset.json"), JSON.stringify(manifest));
  const report = await runRlMeta(w.client, w.coordinates, requestFor(w, "improvement", { ...liveMetaConfiguration(), initial_recipe: initial, seed: fixture.seed }));
  context.diagnostic(JSON.stringify({ sanity: "committed tracker-signal", criterion: liveMetaConfiguration().criterion, generations: report.generations, final_test: report.final_test }));
  assert.ok(report.generations[0].promoted !== null);
  assert.equal(report.generations[1].candidates[0].incumbent, report.generations[0].promoted);
  const first = report.generations[0].candidates[0]; assert.equal(first.verdict.decision, "promote");
  assert.ok(first.gain_lower_bound >= liveMetaConfiguration().criterion.effectThreshold);
  assert.equal(first.verdict.candidateEpsilon, Math.sqrt(Math.log(2 / (1 - 0.9875)) / (2 * splits["meta-validation"].count)));
  assert.ok(first.diagnostics.disagreements[0].rate > 0);
  assert.ok(report.final_test.after.mean > report.final_test.before.mean + liveMetaConfiguration().criterion.effectThreshold);
  assert.ok(report.final_test.after.mean > report.final_test.diagnostics.majority_class.mean);
});

test("canonical reservation lookup ignores another programme's suffixed receipt and rejects wrong types", { timeout: 600_000 }, async () => {
  const w = await metaWorkspace();
  const foreign = await w.client.create({ id: "a-victim-reservation", type: "Decision", title: "Other programme reservation", body: JSON.stringify({
    format: "pm-rl/meta-reservation/1", id: "a-victim-reservation", binding: "other-programme", approval: w.approval,
    charge: { training_samples: 0, proposal_calls: 0, recipe_promotions: 0 },
  }) });
  const foreignBody = String((await w.client.get(foreign.item.id)).item.body);
  const request = { ...requestFor(w, "victim", { ...metaConfig, meta_generations: 1, candidates: 1 }),
    onStep(key: string) { if (key === "programme") throw new Error("canonical reservation committed"); } };
  await assert.rejects(runRlMeta(w.client, w.coordinates, request), /canonical reservation committed/);
  const own = await w.client.get("victim-reservation");
  assert.equal((JSON.parse(String(own.item.body)) as { id: string }).id, "victim-reservation");
  await assert.rejects(runRlMeta(w.client, w.coordinates, request), /canonical reservation committed/);
  assert.equal(String((await w.client.get(own.item.id)).item.body), String(own.item.body));
  assert.equal(String((await w.client.get(foreign.item.id)).item.body), foreignBody);
  await w.client.create({ id: "wrong-reservation", type: "Task", title: "Invalid reservation type", body: own.item.body });
  await assert.rejects(runRlMeta(w.client, w.coordinates, requestFor(w, "wrong")), /meta_reservation_drift/);
});

test("canonical proposal lookup ignores matching foreign bindings and refuses damaged own envelopes", async () => {
  const w = await metaWorkspace(); const signal = new AbortController().signal;
  const request = { config: metaConfig, proposer: "decision-model" as const, decisionEndpoint: "http://127.0.0.1:1" };
  const binding = hashJson({ config: request.config as unknown as JsonValue, incumbent: INITIAL_RECIPE.digest, generation: 1, endpoint: request.decisionEndpoint });
  const result = { recipes: seededRecipes(INITIAL_RECIPE, metaConfig.seed, 1, metaConfig.candidates), proposer: "foreign-complete" };
  const foreign = await w.client.create({ id: "a-victim-m1-proposal-attempt", type: "Decision", title: "Other programme proposal", body: JSON.stringify({
    id: "a-victim-m1-proposal-attempt", binding, state: "complete", result, digest: hashJson(result as unknown as JsonValue),
  }) });
  const foreignBody = String((await w.client.get(foreign.item.id)).item.body);
  const own = await durableRecipeProposals(w.client, "victim", request, INITIAL_RECIPE, 1, signal);
  assert.equal(own.proposer, "seeded:model-unavailable");
  assert.deepEqual(await durableRecipeProposals(w.client, "victim", request, INITIAL_RECIPE, 1, signal), own);
  assert.equal(String((await w.client.get(foreign.item.id)).item.body), foreignBody);
  const item = await w.client.get("victim-m1-proposal-attempt"); const record = JSON.parse(String(item.item.body)) as Record<string, unknown>;
  assert.equal(record.id, "victim-m1-proposal-attempt");
  for (const id of ["other-m1-proposal-attempt", undefined]) {
    await w.client.update(item.item.id, { body: JSON.stringify({ ...record, id }) });
    await assert.rejects(durableRecipeProposals(w.client, "victim", request, INITIAL_RECIPE, 1, signal), /meta_proposal_drift/);
  }
  await w.client.create({ id: "typed-m1-proposal-attempt", type: "Task", title: "Invalid proposal type", body: JSON.stringify({ ...record, id: "typed-m1-proposal-attempt" }) });
  await assert.rejects(durableRecipeProposals(w.client, "typed", request, INITIAL_RECIPE, 1, signal), /meta_proposal_drift/);
  const broken = await w.client.create({ id: "broken-m1-proposal-attempt", type: "Decision", title: "Unreadable proposal record" });
  const path = join(w.coordinates.pmRoot, "decisions", `${broken.item.id}.toon`); const original = readFileSync(path, "utf8");
  try {
    writeFileSync(path, "broken: [invalid\n");
    const failure: unknown = await w.client.get(broken.item.id).catch((error: unknown) => error);
    assert.ok(failure instanceof Error, "damaged tracker item must fail the real SDK read");
    await assert.rejects(durableRecipeProposals(w.client, "broken", request, INITIAL_RECIPE, 1, signal), { message: failure.message });
  } finally { writeFileSync(path, original); }
});

test("programme id bounds prevent outer and inner lease collisions before any write", { timeout: 600_000 }, async () => {
  const w = await metaWorkspace();
  for (const id of ["a".repeat(21), "a".repeat(28), "tracker-search-public-fleet-v1"]) {
    await assert.rejects(runRlMeta(w.client, w.coordinates, { ...requestFor(w, id),
      onStep() { throw new Error("oversize programme reached a write"); } }), /meta_programme_id/);
  }
  assert.equal(certifyCompleteListResult(await w.client.listAllComplete({ includeBody: false })).items.length, 1);
  const id = "abcdefghijklmnopqrst";
  const identities = [id, `${id}-initial`, ...Array.from({ length: 10 }, (_, generation) =>
    Array.from({ length: 8 }, (_, candidate) => `${id}-m${generation + 1}-c${candidate}`)).flat()];
  assert.equal(new Set(identities.map(loopLeaseLockId)).size, 82, "all bounded inner leases remain distinct at the maximum accepted id length");
  const request = requestFor(w, id, { ...metaConfig, meta_generations: 1, candidates: 1 });
  const report = await runRlMeta(w.client, w.coordinates, request); const jobs = await listProcessJobs(w.client);
  assert.equal(report.generations.length, 1);
  assert.deepEqual(await runRlMeta(w.client, w.coordinates, request), report);
  assert.deepEqual(await listProcessJobs(w.client), jobs);
});

test("README dataset command builds from its first flag value and positional tracker directories", async () => {
  const w = await metaWorkspace(); const harness = await createExtensionTestHarness(extension, { name: "pm-rl", capabilities: ["commands", "hooks", "schema"] });
  const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
  const usage = /`pm rl dataset build ([^`]+)`/.exec(readme); assert.ok(usage !== null);
  await withTrackerSources(async (source) => {
    const placeholders: Record<string, string[]> = { "<first-directory>": [source.directories[0]], "<more-directories...>": source.directories.slice(1), "<new-directory>": [join(source.root, "documented-dataset")] };
    const words = usage[1].replace(/\.$/, "").split(/\s+/).flatMap((word) => placeholders[word] ?? [word]);
    const trackers = words.indexOf("--from-trackers"); const output = words.indexOf("--output");
    const result = await harness.runCommand({ command: "rl dataset build", pmRoot: w.coordinates.pmRoot,
      args: words.slice(trackers + 2, output), options: { fromTrackers: words[trackers + 1], output: words[output + 1] } });
    assert.equal(result.handled, true, result.errorMessage ?? "documented command must build a dataset");
    assert.equal((result.result as RlCommandResult).action, "rl-dataset-build");
  });
});

test("an interrupted atomic search reservation is retained once, including drift refusal on resume", { timeout: 600_000 }, async () => {
  const w = await metaWorkspace(); const request = requestFor(w, "transaction", { ...metaConfig, meta_generations: 1, candidates: 1 });
  await assert.rejects(runRlMeta(w.client, { ...w.coordinates, onTransition(context) { if (context.transition === "step_applied") throw new Error("reservation interrupted"); } }, request), /reservation interrupted/);
  const item = await w.client.get("transaction-reservation"); const original = JSON.parse(String(item.item.body)) as { charge: Record<string, number> };
  await w.client.update(item.item.id, { body: JSON.stringify({ ...original, binding: "changed" }) });
  await assert.rejects(runRlMeta(w.client, w.coordinates, request), /meta_reservation_drift/);
  for (const patch of [{ format: "foreign" }, { id: "foreign" }, { approval: "foreign" }, { charge: { ...original.charge, proposal_calls: 1 } }]) {
    await w.client.update(item.item.id, { body: JSON.stringify({ ...original, ...patch }) });
    await assert.rejects(runRlMeta(w.client, w.coordinates, request), /meta_reservation_drift/);
  }
  await w.client.create({ id: "copied-reservation", type: "Decision", title: "Copied control receipt", body: JSON.stringify(original) });
  await assert.rejects(runRlMeta(w.client, w.coordinates, { ...request, id: "copied" }), /meta_reservation_drift/);
  await w.client.update(item.item.id, { body: JSON.stringify(original) });
  await assert.rejects(runRlMeta(w.client, w.coordinates, { ...request, onStep(key) { if (key === "programme") throw new Error("retained once"); } }), /retained once/);
  assert.equal(String((await w.client.get(item.item.id)).item.body), JSON.stringify(original));
  const task = await w.client.create({ type: "Task", title: "Not an approval", body: '```json\n{}\n```' });
  await assert.rejects(runRlMeta(w.client, w.coordinates, { ...request, approval: task.item.id }), /meta_approval_required/);
});

test("programme identity cannot hide approval reservations through SDK case folding", { timeout: 600_000 }, async () => {
  const w = await metaWorkspace(); const request = requestFor(w, "canonical", { ...metaConfig, meta_generations: 1, candidates: 1 });
  const spec = { ...metaSpec, meta_budget: { training_samples: 1024, proposal_calls: 0, recipe_promotions: 1 } };
  await w.client.update(w.approval, { body: `\`\`\`json\n${JSON.stringify(spec)}\n\`\`\`` });
  for (const id of ["UPPER", "under_score", "", "../outside"]) {
    await assert.rejects(runRlMeta(w.client, w.coordinates, { ...request, id, onStep() { throw new Error("noncanonical programme reached a write"); } }), /meta_programme_id/);
  }
  assert.equal(certifyCompleteListResult(await w.client.listAllComplete({ includeBody: false })).items.length, 1, "invalid identities leave only the approval");
  await w.client.create({ id: "LEGACY-reservation", type: "Decision", title: "Retained case-folded allocation", body: JSON.stringify({
    format: "pm-rl/meta-reservation/1", id: "LEGACY-reservation", approval: w.approval,
    charge: { training_samples: 1024, proposal_calls: 0, recipe_promotions: 1 },
  }) });
  await assert.rejects(runRlMeta(w.client, w.coordinates, { ...request, onStep() { throw new Error("retained allocation was hidden"); } }), /meta_budget_exhausted/);
});

test("two distinct outer programmes cannot oversubscribe one approved search reservation", { timeout: 600_000 }, async () => {
  const w = await metaWorkspace();
  const spec = { ...metaSpec, meta_budget: { training_samples: 1024, proposal_calls: 0, recipe_promotions: 1 } };
  await w.client.update(w.approval, { body: `\`\`\`json\n${JSON.stringify(spec)}\n\`\`\`` });
  const config = { ...metaConfig, meta_generations: 1, candidates: 1 };
  const outcomes = await Promise.allSettled(["concurrent-one", "concurrent-two"].map((id) => runRlMeta(w.client, w.coordinates, {
    ...requestFor(w, id, config), onStep(key) { if (key === "programme") throw new Error("stop after the sole reservation"); },
  })));
  assert.ok(outcomes.every((outcome) => outcome.status === "rejected"));
  const reasons = outcomes.map((outcome) => String((outcome as PromiseRejectedResult).reason));
  assert.equal(reasons.filter((reason) => reason.includes("meta_budget_exhausted")).length, 1, reasons.join("\n"));
  assert.equal(reasons.filter((reason) => reason.includes("sole reservation")).length, 1, reasons.join("\n"));
});

test("one pre-approved Decision cannot be enlarged, replaced or oversubscribed, including pretty reservation bodies", { timeout: 600_000 }, async () => {
  const w = await metaWorkspace();
  await w.client.create({ type: "Task", title: "Unrelated data record", body: "Synthetic evaluator content must stay outside accounting reads." });
  for (const key of ["training_samples", "proposal_calls", "recipe_promotions"] as const) {
    const spec = { ...metaSpec, meta_budget: { ...metaSpec.meta_budget, [key]: 0 } };
    await w.client.update(w.approval, { body: `\`\`\`json\n${JSON.stringify(spec)}\n\`\`\`` });
    await assert.rejects(runRlMeta(w.client, w.coordinates, { ...requestFor(w, `exhaust-${key.replaceAll("_", "-")}`), proposer: "decision-model" }), new RegExp(`meta_budget_exhausted: ${key}`));
  }
  await w.client.update(w.approval, { body: `\`\`\`json\n${JSON.stringify(metaSpec)}\n\`\`\`` });
  const request = requestFor(w, "bound", { ...metaConfig, meta_generations: 1, candidates: 1 });
  await assert.rejects(runRlMeta(w.client, w.coordinates, { ...request, async onStep(key) {
    if (key === "programme") await w.client.update(w.approval, { body: `\`\`\`json\n${JSON.stringify({ ...metaSpec, permitted_promotions: 101 })}\n\`\`\`` });
  } }), /meta_budget_drift/);
  await w.client.update(w.approval, { body: `\`\`\`json\n${JSON.stringify(metaSpec)}\n\`\`\`` });
  const reservation = await w.client.get("bound-reservation");
  const replacement = await w.client.create({ type: "Decision", title: "Identical spec with a different approval identity", body: `\`\`\`json\n${JSON.stringify(metaSpec)}\n\`\`\`` });
  await assert.rejects(runRlMeta(w.client, w.coordinates, { ...request, approval: replacement.item.id, onStep(key) { if (key === "programme") throw new Error("approval identity switched"); } }), /disagrees/);
  await w.client.update(reservation.item.id, { title: "Renamed reserved search", body: JSON.stringify(JSON.parse(String(reservation.item.body)), null, 2) });
  await w.client.create({ id: "foreign-reservation", type: "Decision", title: "Unbound copied envelope", body: reservation.item.body });
  await w.client.create({ id: "prose-reservation", type: "Decision", title: "Unrelated control record", body: "Prose mentioning pm-rl/meta-reservation/1" });
  const independent = await w.client.create({ id: "independent-reservation", type: "Decision", title: "Different approval allocation" });
  const copied = JSON.parse(String(reservation.item.body)) as Record<string, unknown>;
  await w.client.update(independent.item.id, { body: JSON.stringify({ ...copied, id: independent.item.id, approval: replacement.item.id }) });
  for (const [index, value] of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1].entries()) {
    const record = JSON.parse(String(reservation.item.body)) as { charge: Record<string, number> };
    record.charge.training_samples = value;
    await w.client.update(reservation.item.id, { body: JSON.stringify(record) });
    await assert.rejects(runRlMeta(w.client, w.coordinates, requestFor(w, `invalid-charge-${index}`, { ...metaConfig, meta_generations: 1, candidates: 1 })), /meta_reservation_charge/);
  }
  await w.client.update(reservation.item.id, { body: String(reservation.item.body) });
  const spec = { ...metaSpec, meta_budget: { ...metaSpec.meta_budget, training_samples: 1024 } };
  await w.client.update(w.approval, { body: `\`\`\`json\n${JSON.stringify(spec)}\n\`\`\`` });
  await assert.rejects(runRlMeta(w.client, w.coordinates, { ...requestFor(w, "second", { ...metaConfig, meta_generations: 1, candidates: 1 }),
    onStep(key) { if (key === "programme") throw new Error("hidden reservation admitted"); },
  }), /training_samples/);
  for (const body of ["plain", "pm-rl/meta-reservation/1 prose", '{"other":"pm-rl/meta-reservation/1"}']) assert.equal(metaReservation(body), null);
  assert.ok(metaReservation(String((await w.client.get("bound-reservation")).item.body)) !== null);
  for (const body of ["no fence", '```json\n{}\n```', '```json\n{"meta_budget":null}\n```', '```json\n{"meta_budget":{"training_samples":-1}}\n```']) {
    await w.client.update(w.approval, { body }); await assert.rejects(runRlMeta(w.client, w.coordinates, requestFor(w, "invalid-approval")));
  }
  await assert.rejects(runRlMeta(w.client, w.coordinates, { ...requestFor(w, "invalid-proposer"), proposer: "bad" as "seeded" }), /meta_proposer/);
});

test("decision-model proposals send only recipes through the calibrated adapter and fall back on unavailable local models", async () => {
  let mode = "available"; const states: string[] = []; let rankedFirst = "";
  const server = createServer(async (request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.url === "/api/tags") {
      if (mode === "http-error") response.statusCode = 503;
      response.end(JSON.stringify({ models: mode === "missing" ? [] : [{ name: "tev1:4b", ...(mode === "remote" ? { remote_host: "external" } : {}), ...(mode === "remote-model" ? { remote_model: "external" } : {}) }] })); return;
    }
    let body = ""; for await (const chunk of request) body += String(chunk);
    const parsed = JSON.parse(body) as { state: string; questions: { recipe: { criteria: Record<string, string> } } }; states.push(parsed.state);
    const options = Object.keys(parsed.questions.recipe.criteria);
    rankedFirst = options.at(-1)!;
    response.end(JSON.stringify(mode === "corrupt" ? {} : { answers: { recipe: { probabilities: Object.fromEntries(options.map((option) => [option, mode === "ranked" ? (option === rankedFirst ? 0.7 : 0.1) : 1 / options.length])) } }, usage: { input_tokens: 1, output_tokens: 1 } }));
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); assert.ok(address !== null && typeof address === "object");
  const request = { config: metaConfig, proposer: "decision-model" as const, decisionEndpoint: `http://127.0.0.1:${address.port}` };
  try {
    const proposals = await proposeRecipes(request, INITIAL_RECIPE, 1, new AbortController().signal);
    assert.equal(proposals.proposer, "decision-model"); assert.equal(proposals.recipes.length, metaConfig.candidates);
    mode = "ranked";
    const ranked = await proposeRecipes(request, INITIAL_RECIPE, 1, new AbortController().signal);
    assert.equal(ranked.recipes[0].digest, rankedFirst); mode = "available";
    assert.ok(states.every((state) => !state.includes("prefix") && !state.includes("label") && !state.includes("held_out")));
    const workspace = await metaWorkspace();
    await workspace.client.create({ type: "Task", title: "Unrelated evaluator item", body: "Synthetic held-out canary" });
    const first = await durableRecipeProposals(workspace.client, "proposer", request, INITIAL_RECIPE, 1, new AbortController().signal);
    const calls = states.length;
    assert.deepEqual(await durableRecipeProposals(workspace.client, "proposer", request, INITIAL_RECIPE, 1, new AbortController().signal), first);
    assert.equal(states.length, calls);
    const item = await workspace.client.get("proposer-m1-proposal-attempt"); const record = JSON.parse(String(item.item.body)) as Record<string, unknown>;
    await workspace.client.update(item.item.id, { body: JSON.stringify({ ...record, state: "intent" }) });
    assert.equal((await durableRecipeProposals(workspace.client, "proposer", request, INITIAL_RECIPE, 1, new AbortController().signal)).proposer, "seeded:unresolved-model-attempt");
    assert.equal(states.length, calls);
    await workspace.client.update(item.item.id, { body: JSON.stringify({ ...record, state: "invalid" }) });
    await assert.rejects(durableRecipeProposals(workspace.client, "proposer", request, INITIAL_RECIPE, 1, new AbortController().signal), /proposal_state/);
    await workspace.client.update(item.item.id, { body: JSON.stringify({ ...record, digest: "corrupt" }) });
    await assert.rejects(durableRecipeProposals(workspace.client, "proposer", request, INITIAL_RECIPE, 1, new AbortController().signal), /proposal_receipt/);
    await assert.rejects(durableRecipeProposals(workspace.client, "proposer", { ...request, config: { ...metaConfig, seed: 1 } }, INITIAL_RECIPE, 1, new AbortController().signal), /proposal_drift/);
    for (mode of ["missing", "remote", "remote-model", "corrupt", "http-error"]) {
      assert.deepEqual((await proposeRecipes(request, INITIAL_RECIPE, 1, new AbortController().signal)).recipes, seededRecipes(INITIAL_RECIPE, metaConfig.seed, 1, metaConfig.candidates));
    }
    const controller = new AbortController(); controller.abort(new Error("proposal cancelled"));
    await assert.rejects(proposeRecipes(request, INITIAL_RECIPE, 1, controller.signal), /proposal cancelled/);
    await assert.rejects(proposeRecipes({ config: metaConfig, proposer: "decision-model" }, INITIAL_RECIPE, 1, controller.signal), /proposal cancelled/);
    await assert.rejects(durableRecipeProposals(workspace.client, "default-endpoint", { config: metaConfig, proposer: "decision-model" }, INITIAL_RECIPE, 1, controller.signal), /proposal cancelled/);
    await assert.rejects(proposeRecipes({ ...request, decisionEndpoint: "https://example.test" }, INITIAL_RECIPE, 1, new AbortController().signal), /local_proposer_required/);
  } finally { server.closeAllConnections(); await new Promise<void>((done) => { server.close(() => done()); }); }
  assert.equal((await proposeRecipes({ config: metaConfig, proposer: "decision-model", decisionEndpoint: "http://127.0.0.1:1" }, INITIAL_RECIPE, 1, new AbortController().signal)).proposer, "seeded:model-unavailable");
});

test("live entry point builds only synthetic public snapshots in ordinary acceptance tests and retains failure evidence", { timeout: 600_000 }, async () => {
  assert.ok(liveMetaOptions({}).fleet.endsWith("fleet"));
  assert.equal(liveMetaOptions({ PM_RL_TRACKER_ROOT: "synthetic", PM_LIVE_WORKER_TIMEOUT_MS: "1000" }).timeout, 1000);
  await assert.rejects(runLiveMetaAcceptance([], 1000), /dataset_bounds/);
  await withTrackerSources(async (source) => {
    let result: Awaited<ReturnType<typeof runLiveMetaAcceptance>> | undefined;
    await liveMetaMain({ PM_RL_TRACKER_ROOT: source.root }, (evidence) => { result = evidence; });
    assert.equal(result!.report.generations.length, 2);
    const original = process.stdout.write; let printed = "";
    process.stdout.write = ((chunk: string | Uint8Array): boolean => { printed += String(chunk); return true; }) as typeof process.stdout.write;
    try { printLiveMetaEvidence(result!); } finally { process.stdout.write = original; }
    assert.deepEqual(JSON.parse(printed), result);
  });
});

test("public command builds a dataset and executes real bounded meta work, retaining errors for malformed configuration", { timeout: 600_000 }, async () => {
  const w = await metaWorkspace(); const harness = await createExtensionTestHarness(extension, { name: "pm-rl", capabilities: ["commands", "hooks", "schema"] });
  await withTrackerSources(async (source) => {
    const built = await harness.runCommand({ command: "rl dataset build", pmRoot: w.coordinates.pmRoot, args: source.directories.slice(1),
      options: { fromTrackers: source.directories[0], output: join(source.root, "command-dataset") } });
    assert.equal((built.result as RlCommandResult).action, "rl-dataset-build");
    const invalid = await harness.runCommand({ command: "rl dataset build", pmRoot: w.coordinates.pmRoot, args: [], options: { fromTrackers: source.directories[0], output: join(source.root, "invalid-dataset"), seed: "1" } });
    assert.equal(invalid.handled, false); assert.match(invalid.errorMessage!, /dataset_bounds/);
    assert.equal(publicTrackerDirectories(source.root).length, 5);
    writeFileSync(join(source.root, "regular-file"), "ignored");
    for (const name of ["pm-web", "pm-gpt", "pm-cli"]) mkdirSync(join(source.root, name));
    assert.equal(publicTrackerDirectories(source.root).length, 5);
    process.env.RL_FIXTURE_VISIBILITY = "PRIVATE";
    try { assert.equal(publicTrackerDirectories(source.root).length, 0); } finally { delete process.env.RL_FIXTURE_VISIBILITY; }
    process.env.RL_FIXTURE_NO_LICENSE = "1";
    try { assert.equal(publicTrackerDirectories(source.root).length, 0); } finally { delete process.env.RL_FIXTURE_NO_LICENSE; }
  });
  const file = join(w.root, "meta.json"); writeFileSync(file, JSON.stringify({ ...metaConfig, meta_generations: 1, candidates: 1 }));
  const run = await harness.runCommand({ command: "rl meta run", pmRoot: w.coordinates.pmRoot, args: ["command"], options: { file, dataset: w.dataset, approval: w.approval } });
  assert.equal((run.result as RlCommandResult).action, "rl-meta-run");
  const badProposer = await harness.runCommand({ command: "rl meta run", pmRoot: w.coordinates.pmRoot, args: ["bad-proposer"], options: { file, dataset: w.dataset, approval: w.approval, proposer: "invalid" } });
  assert.equal(badProposer.handled, false); assert.match(badProposer.errorMessage!, /meta_proposer/);
  writeFileSync(file, "{}");
  const badConfiguration = await harness.runCommand({ command: "rl meta run", pmRoot: w.coordinates.pmRoot, args: ["bad-command"], options: { file, dataset: w.dataset, approval: w.approval, proposer: "seeded" } });
  assert.equal(badConfiguration.handled, false);
  await assert.rejects(runLiveMetaAcceptance(w.directories, 0), /meta_live_timeout/);
  await assert.rejects(runLiveCommand({ ...process.env, PM_RL_LIVE_SUITE: "meta", PM_RL_TRACKER_ROOT: join(w.root, "missing") }, () => {}, 60_000), /ENOENT/);
});
