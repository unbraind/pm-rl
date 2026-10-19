/** Behavioral tests use committed synthetic histories and real temporary SDK trackers and process fits. */
import assert from "node:assert/strict";
import { once } from "node:events";
import { fork, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, renameSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { PmClient } from "@unbrained/pm-cli/sdk/core";
import { init } from "@unbrained/pm-cli/sdk/runtime";
import { createExtensionTestHarness } from "@unbrained/pm-cli/sdk/testing";
import extension, { hashJson, type JsonValue, type RlCommandResult } from "../index.ts";
import { initialImprover, improverArtifact, parseImprover, proposeLearners, updateImprover, type ProposalOutcome } from "../improver.ts";
import { buildImproverDataset, chronologicalTask, historyBeforePrediction, projectImproverHistory, readImproverDataset, readImproverTasks, IMPROVER_ROLES, type ImproverDataset, type ImproverTask, type ImproverProjection } from "../improver-data.ts";
import { compareImprovers, diagnoseImproverLearner, executeImproverFit, improverProcessAttempt, improverAccuracy, improverFeatures, openImproverEnvironment, IMPROVER_CRITERION, IMPROVER_ADAPTER } from "../improver-environment.ts";
import { improverBudget, improverConfiguration, parseImproverConfig, runRecursiveImprover, selectImprover, summarizeImproverScores, type ImproverConfig, type ImproverScore } from "../recursive-improver.ts";
import { prefixCheckpoint, type PrefixCheckpoint } from "../prefix.ts";
import { listProcessJobs, processJobId, processStaging, type ProcessInput } from "../process.ts";
import { prefixTrainerArgv } from "../prefix-trainer.ts";
import { withTrackerSources, git } from "./fixtures/meta-workspace.ts";
import { copyImproverSources, improverLivePins, improverLiveRoot, liveImproverConfiguration, liveImproverWorker } from "../scripts/live-improver.ts";

/** A chronological synthetic task carries a learnable title and future-only sentinel fields. */
function syntheticHistory(index: number): string {
  const started = 1_700_000_000_000 + index * 86_400_000;
  const initial = { ts: new Date(started).toISOString(), op: "create", author: "synthetic-author", patch: [
    { path: "/metadata/status", value: "open" }, { path: "/metadata/type", value: index % 2 === 0 ? "Issue" : "Task" },
    { path: "/metadata/title", value: index % 2 === 0 ? "rapid repair" : "slow planned" }, { path: "/metadata/description", value: "Synthetic description" }] };
  const middle = Array.from({ length: index % 5 }, (_, offset) => ({ ts: new Date(started + (offset + 1) * 1000).toISOString(), op: "update", patch: [{ path: "/metadata/status", value: offset % 2 === 0 ? "in_progress" : "open" }] }));
  return [initial, ...middle, { ts: new Date(started + (index % 2 === 0 ? 10_000 : 60_000)).toISOString(), op: "update", patch: [{ path: "/metadata/status", value: "closed" }, { path: "/metadata/title", value: "Future-only sentinel" }] }].map((event) => JSON.stringify(event)).join("\n");
}

/** Seal a rewritten synthetic compartment while preserving explicit content-address checks in its reader. */
function reseal(directory: string, manifest: ImproverDataset, role: typeof IMPROVER_ROLES[number], tasks: readonly ImproverTask[]): ImproverDataset {
  writeFileSync(join(directory, `${role}.json`), JSON.stringify(tasks));
  const { digest: _digest, ...old } = manifest;
  const record = { ...old, splits: { ...old.splits, [role]: { digest: hashJson(tasks as unknown as JsonValue), tasks: tasks.length } } };
  const next = { ...record, digest: hashJson(record as unknown as JsonValue) };
  writeFileSync(join(directory, "improver-dataset.json"), JSON.stringify(next));
  return next;
}

/** Build from real Git blobs behind the existing synthetic external-metadata executable. */
async function workspace(compact = true) {
  return withTrackerSources(async (source) => {
    for (const directory of source.directories) {
      for (let index = 0; index < 40; index += 1) writeFileSync(join(directory, "history", `item-${index}.jsonl`), syntheticHistory(index));
      const project = dirname(dirname(directory)); git(project, ["add", ".agents/pm/history"]);
      git(project, ["-c", "user.name=Public Fixture", "-c", "user.email=public@example.test", "commit", "-qm", "Chronological synthetic tracker"]);
    }
    const dataset = join(source.root, "improver-data"); let manifest = buildImproverDataset(source.directories, dataset);
    if (compact) for (const role of IMPROVER_ROLES) manifest = reseal(dataset, manifest, role, readImproverTasks(dataset, manifest, role).filter((task) => task.target === "time-to-close").slice(0, 1));
    const project = join(source.root, "improver-controller"); mkdirSync(project);
    const initialized = await init("rl", { defaults: true, agentGuidance: "skip", author: "improver-test" }, { cwd: project, pmRoot: join(project, ".agents/pm") });
    const coordinates = { pmRoot: initialized.path, author: "improver-test" };
    const client = new PmClient({ ...coordinates, cwd: project, noExtensions: true });
    const approval = await client.create({ id: "approval", type: "Decision", title: "Synthetic fixed allowance", body: '```json\n' + JSON.stringify({ permitted_promotions: 1000, resource_budget: Object.fromEntries(Object.entries(IMPROVER_ADAPTER.allowance).map(([key, value]) => [key, value * 1000])) }) + '\n```' });
    const config = { ...improverConfiguration(), candidates: 1, updates: 64, timeout_ms: 300_000 };
    return { ...source, dataset, manifest, client, coordinates, project, approval: String(approval.item.id), config };
  });
}

/** Restore the executable path and remove only run entries created inside this fixture, including assertion failures. */
async function withLiveImproverFixture(bin: string, operation: (root: string, before: ReadonlySet<string>) => Promise<void>): Promise<void> {
  const root = join(import.meta.dirname, '../.agents/pm/runtime/improver'); mkdirSync(root, { recursive: true });
  const before = new Set(readdirSync(root));
  const original = process.env.PATH; process.env.PATH = `${bin}:${original}`;
  try { await operation(root, before); }
  finally {
    process.env.PATH = original;
    for (const entry of readdirSync(root)) if (!before.has(entry)) rmSync(join(root, entry), { recursive: true, force: true });
  }
}

test("live fixture cleanup preserves existing entries on success and assertion failure", async () => {
  const root = join(import.meta.dirname, '../.agents/pm/runtime/improver'); mkdirSync(root, { recursive: true });
  const before = readdirSync(root); const original = process.env.PATH;
  await withLiveImproverFixture('synthetic-bin', async (directory) => {
    mkdirSync(join(directory, 'synthetic-cleanup-success')); writeFileSync(join(directory, 'synthetic-extra-file'), 'fixture');
  });
  assert.deepEqual(readdirSync(root), before); assert.equal(process.env.PATH, original);
  await assert.rejects(withLiveImproverFixture('synthetic-bin', async (directory) => {
    mkdirSync(join(directory, 'synthetic-cleanup-failure')); assert.fail('synthetic assertion failure');
  }), /synthetic assertion failure/);
  assert.deepEqual(readdirSync(root), before); assert.equal(process.env.PATH, original);
});

test("learning rate refuses numeric strings and nonfinite values before artifact addressing", () => {
  const { digest: _digest, ...record } = initialImprover();
  for (const rate of ['0.5', null, true, NaN, Infinity, -Infinity, 0.009, 1.001]) {
    const invalid = { ...record, arms: record.arms.map((arm, index) => index === 0 ? { ...arm, config: { ...arm.config, learning_rate: rate } } : arm) };
    assert.throws(() => improverArtifact(invalid as unknown as typeof record), /improver_config/);
  }
});

test("repository identity keeps suffix-colliding owners bound to their own commit and role", async () => {
  const w = await workspace(false);
  await withTrackerSources(async () => {
    const roots = w.directories.slice(0, 2).map((directory) => dirname(dirname(directory)));
    git(roots[0], ['remote', 'set-url', 'origin', 'https://github.com/org/pm-alpha.git']);
    git(roots[1], ['remote', 'set-url', 'origin', 'git@github.com:xorg/pm-alpha.git']);
    writeFileSync(join(roots[1], 'unique.txt'), 'Distinct public synthetic snapshot');
    git(roots[1], ['add', 'unique.txt']); git(roots[1], ['-c','user.name=Public Fixture','-c','user.email=public@example.test','commit','-qm','Distinct synthetic snapshot']);
    const output = join(w.root, 'collision-data'); const manifest = buildImproverDataset(w.directories, output);
    for (const [index, repo] of ['org/pm-alpha', 'xorg/pm-alpha'].entries()) {
      const source = manifest.sources.find((source) => source.repo === repo)!;
      const tasks = readImproverTasks(output, manifest, source.role).filter((task) => task.repo === repo);
      assert.equal(tasks.length, 2); assert.ok(tasks.every((task) => task.commit === git(roots[index], ['rev-parse', 'HEAD'])));
    }
  });
});

test("improver updates actual proposal preferences from attributable outcomes and preserves bounds", () => {
  const policy = initialImprover(); assert.deepEqual(parseImprover(policy), policy);
  const configs = proposeLearners(policy, 42, 1, "task", 8);
  assert.equal(new Set(configs.map((config) => hashJson(config as unknown as JsonValue))).size, 8);
  const ledger: ProposalOutcome[] = Array.from({ length: 100 }, (_, index) => ({ id: `outcome-${index}`, role: "development", policy: policy.digest, config: configs[index % 2], promoted: index % 2 === 0, gain: index % 2 === 0 ? 0.4 : -0.1 }));
  const next = updateImprover(policy, ledger);
  assert.equal(next.parent, policy.digest); assert.equal(next.version, 2); assert.notEqual(next.ledger, policy.ledger);
  assert.deepEqual(next.arms.map((arm) => arm.config), policy.arms.map((arm) => arm.config));
  assert.equal(next.arms.reduce((sum, arm) => sum + arm.success + arm.failure, 0), 116);
  assert.ok(next.arms.some((arm) => arm.gain > 0));
  assert.deepEqual(updateImprover(policy, [...ledger].reverse()), next, "ledger ordering cannot choose a policy");
  const before = Array.from({ length: 50 }, (_, seed) => proposeLearners(policy, seed, 2, "task", 2));
  const after = Array.from({ length: 50 }, (_, seed) => proposeLearners(next, seed, 2, "task", 2));
  assert.notDeepEqual(after, before, "updating only version metadata is not recursive proposal learning");
  const fresh: ProposalOutcome = { id: 'fresh-observation', policy: next.digest, role: 'development', config: configs[0], promoted: false, gain: 0 };
  const continued = updateImprover(next, [fresh]);
  assert.equal(continued.arms.reduce((sum, arm) => sum + arm.success + arm.failure, 0), 117, 'loading a promoted artifact must retain its learned priors');
  assert.deepEqual(updateImprover(next, [...ledger, fresh], policy).arms, continued.arms, 'cumulative ledgers count each outcome once after promotion');
  for (const broken of [{ ...policy, format: "other" }, { ...policy, version: 0 }, { ...policy, version: 2 }, { ...policy, strategy: "other" }, { ...policy, exploration: 0 }, { ...policy, arms: [] }, { ...policy, ledger: "bad" }, { ...policy, arms: [policy.arms[0], policy.arms[0]] }, { ...policy, arms: [{ ...policy.arms[0], gain: -1 }, policy.arms[1]] }, { ...policy, arms: [{ ...policy.arms[0], success: 0 }, policy.arms[1]] }, { ...policy, arms: [{ ...policy.arms[0], config: { ...configs[0], features: "future" } }, policy.arms[1]] }]) assert.throws(() => parseImprover(broken as typeof policy));
  assert.throws(() => parseImprover({ ...policy, digest: "bad" }), /identity/);
  assert.throws(() => parseImprover({ ...policy, extra: true } as typeof policy), /identity|fields/);
  const { digest: _digest, ...record } = policy;
  assert.throws(() => parseImprover({ ...improverArtifact({ ...record, extra: 1 } as typeof record), extra: 1 } as typeof policy), /fields/);
  for (const count of [0, 9, 1.5]) assert.throws(() => proposeLearners(policy, 1, 1, "t", count), /proposals/);
  assert.throws(() => proposeLearners(policy, -1, 1, "t", 1), /proposals/);
  assert.throws(() => proposeLearners(policy, 1, 0, "t", 1), /proposals/);
  for (const entries of [[], [ledger[0], ledger[0]], [{ ...ledger[0], role: "meta" }], [{ ...ledger[0], gain: NaN }], [{ ...ledger[0], gain: -0.1 }], [{ ...ledger[0], policy: "bad" }], [{ ...ledger[0], config: { ...configs[0], learning_rate: 0.99 } }]]) assert.throws(() => updateImprover(policy, entries as ProposalOutcome[]), /ledger/);
});

test("leakage sentinel: features use strictly prior history and never the type label", () => {
  const history = syntheticHistory(5); const events = history.split("\n").map((line) => JSON.parse(line) as { ts: string; op: string; patch: { path: string; value: string; op?: string }[] });
  const cut = Date.parse(events[0].ts) + 1;
  const features = historyBeforePrediction(events, cut);
  const changed = structuredClone(events); changed[0].patch[1].value = "Issue";
  for (const event of changed.slice(1)) { event.op = "future_secret"; event.patch.push({ path: "/metadata/description", value: "future_label_secret" }); }
  changed.push({ ts: new Date(cut).toISOString(), op: "future_secret", patch: [{ path: "/metadata/title", value: "At prediction timestamp must be excluded" }] });
  assert.deepEqual(historyBeforePrediction(changed, cut), features);
  assert.ok(!features.fields.includes("type")); assert.equal(features.events.length, 1);
  const row = projectImproverHistory(history, "public-fixture/pm-alpha", "item")!;
  assert.equal(row.issue, false); assert.ok(row.terminal_at > row.prediction_at);
  assert.deepEqual(row.prefix, features);
  const permissive = [{ ts: events[0].ts, patch: [{ path: "/metadata/title", value: "!!!", op: "remove" }, { path: "/metadata/title", value: "!!!" }, { path: "/metadata/title", value: "ignored repeat" }, { path: "/metadata/description", value: "kept description" }] }, { ts: events[0].ts, op: "unknown" }];
  assert.ok(historyBeforePrediction(permissive, cut).events.every((op) => op === "other"));
  assert.throws(() => historyBeforePrediction([], cut), /prediction_time/);
  for (const input of ["", "{}", history.replaceAll('"ts":', '"invalid":'), JSON.stringify(events.at(-1)) + '\n' + history, JSON.stringify(events[0]), history.replace('"/metadata/type"', '"/metadata/priority"'), history.replace(events.at(-1)!.ts, events[0].ts)]) assert.equal(projectImproverHistory(input, "r", "i"), null);
  assert.equal(projectImproverHistory(syntheticHistory(0), "r", "i")!.issue, true);
  assert.equal(projectImproverHistory(JSON.stringify({ ts: events[0].ts }) + '\n' + JSON.stringify(events.at(-1)), 'r', 'i'), null);
  assert.equal(projectImproverHistory(history.replace('"/metadata/type","value":"Task"', '"/metadata/type","op":"remove","value":"Task"'), 'r', 'i'), null);
});

test("chronological splits calibrate only earlier available labels, balance targets and reject insufficient cohorts", () => {
  const rows = Array.from({ length: 40 }, (_, index) => projectImproverHistory(syntheticHistory(index), "r", String(index))!);
  const task = chronologicalTask(rows, "r", "c", "time-to-close")!;
  assert.ok(task.train.every((row) => row.available_at < task.cutoff));
  assert.ok(task.evaluation.every((row) => row.prediction_at >= task.cutoff));
  const futureMutated = rows.map((row) => row.prediction_at >= task.cutoff ? { ...row, terminal_at: row.terminal_at + 100_000 } : row);
  const type = chronologicalTask(futureMutated, "r", "c", "issue-type")!;
  assert.equal(type.threshold_ms, null); assert.equal(type.train.length, 24);
  assert.equal(chronologicalTask(futureMutated, "r", "c", "time-to-close"), null, "no balanced future duration cohort remains");
  for (const subset of [rows.slice(0, 9), rows.map((row) => ({ ...row, terminal_at: Number.MAX_SAFE_INTEGER })), rows.map((row) => ({ ...row, prediction_at: rows[0].prediction_at }))]) assert.equal(chronologicalTask(subset, "r", "c", "time-to-close"), null);
  assert.equal(chronologicalTask(rows.map((row) => ({ ...row, issue: false })), "r", "c", "issue-type"), null);
  const tied = chronologicalTask(rows.map((row, index) => ({ ...row, prediction_at: rows[index - index % 2].prediction_at })), 'r', 'c', 'issue-type')!;
  assert.ok(tied.train.some((row, index) => index > 0 && row.prediction_at === tied.train[index - 1].prediction_at));
});

test("frozen public task builder and reader refuse drift, cross-role items and future training labels", async () => {
  const w = await workspace(false);
  assert.deepEqual(readImproverDataset(w.dataset), w.manifest);
  for (const role of IMPROVER_ROLES) assert.ok(readImproverTasks(w.dataset, w.manifest, role).length >= 2);
  const role = "development"; const tasks = readImproverTasks(w.dataset, w.manifest, role); const task = tasks.find((task) => task.target === 'time-to-close')!;
  const peers = tasks.filter((entry) => entry.id !== task.id);
  for (const mutation of [
    { ...task, repo: "wrong/repository" }, { ...task, target: "other" }, { ...task, threshold_ms: null }, { ...task, train: [] },
    { ...task, train: [task.evaluation[0], ...task.train.slice(1)] },
    { ...task, train: task.train.map((row, index) => index === 0 ? { ...row, available_at: task.cutoff } : row) },
    { ...task, evaluation: task.evaluation.map((row) => ({ ...row, prediction_at: task.cutoff - 1 })) },
    { ...task, train: task.train.map((row, index) => index === 0 ? { ...row, label: 2 } : row) },
    { ...task, train: task.train.map((row) => ({ ...row, label: 0 })) },
  ]) {
    const corrupted = reseal(w.dataset, w.manifest, role, [mutation, ...peers] as ImproverTask[]);
    assert.throws(() => readImproverTasks(w.dataset, corrupted, role), /improver_/);
  }
  const corrupted = reseal(w.dataset, w.manifest, role, [task, task]);
  assert.throws(() => readImproverTasks(w.dataset, corrupted, role), /task_duplicate/);
  writeFileSync(join(w.dataset, 'development.json'), '[]'); assert.throws(() => readImproverTasks(w.dataset, corrupted, role), /identity/);
  writeFileSync(join(w.dataset, 'improver-dataset.json'), '{}'); assert.throws(() => readImproverDataset(w.dataset), /identity/);
  const { digest: _digest, ...record } = w.manifest; const doubled = { ...record, sources: [...record.sources, record.sources[0]] };
  writeFileSync(join(w.dataset, 'improver-dataset.json'), JSON.stringify({ ...doubled, digest: hashJson(doubled as unknown as JsonValue) }));
  assert.throws(() => readImproverDataset(w.dataset), /source_overlap/);
  // Missing type labels omit that task, while lifecycle-only verification remains eligible.
  await withTrackerSources(async (source) => {
    const omitted = join(source.root, 'pm-omitted'); mkdirSync(join(omitted, '.agents/pm/history'), { recursive: true });
    git(omitted, ['init','-q']); git(omitted, ['remote','add','origin','https://github.com/public-fixture/pm-omitted.git']);
    writeFileSync(join(omitted, '.agents/pm/history/open.jsonl'), JSON.stringify({ patch: [{ path: '/metadata/status', value: 'open' }] }));
    git(omitted, ['add','.agents/pm']); git(omitted, ['-c','user.name=Public Fixture','-c','user.email=public@example.test','commit','-qm','Open synthetic snapshot']);
    const withOmission = buildImproverDataset([...w.directories, join(omitted, '.agents/pm')], join(source.root, 'with-omission'));
    assert.equal(withOmission.sources.length, 5);
    for (const directory of source.directories) {
      for (let index = 0; index < 40; index += 1) writeFileSync(join(directory, 'history', `item-${index}.jsonl`), syntheticHistory(index).replace('"/metadata/type"', '"/metadata/priority"'));
      const root = dirname(dirname(directory)); git(root, ['add', '.agents/pm/history']); git(root, ['-c','user.name=Public Fixture','-c','user.email=public@example.test','commit','-qm','Synthetic missing label']);
    }
    assert.throws(() => buildImproverDataset(source.directories, join(source.root, 'empty')), /empty_role/);
  });
});

test("proposal masks, immutable budgets, confidence intervals and both gate outcomes remain explicit", () => {
  const policy = initialImprover(); const prefix = projectImproverHistory(syntheticHistory(0), 'r', 'i')!.prefix;
  for (const arm of policy.arms) assert.ok(improverFeatures(prefix, arm.config).events.length > 0);
  const winner = compareImprovers('candidate', 'incumbent', 1, 0, 10_000, 'context'); assert.equal(winner.verdict.decision, 'promote');
  const successor = updateImprover(policy, [{ id: 'positive', policy: policy.digest, role: 'development', config: policy.arms[0].config, promoted: true, gain: 0.5 }]);
  assert.equal(selectImprover(policy, successor, winner).policy, successor);
  assert.equal(selectImprover(policy, successor, compareImprovers('c', 'i', 0.5, 0.5, 10_000, 'x')).policy, policy);
  assert.equal(compareImprovers('c', 'i', 0.5, 0.5, 20, 'x').verdict.decision, 'refuse');
  assert.equal(compareImprovers('c', 'i', 1, 0, 2, 'x').verdict.decision, 'refuse');
  const config = improverConfiguration(); assert.equal(parseImproverConfig(config), config);
  assert.equal(improverLivePins().length, 4); assert.equal(liveImproverConfiguration().candidates, 1);
  assert.equal(improverLiveRoot({ PM_RL_TRACKER_ROOT: 'explicit-fleet' }), 'explicit-fleet'); assert.ok(improverLiveRoot({}).endsWith('/fleet'));
  for (const key of ['seed','generations','candidates','updates','timeout_ms'] as const) assert.throws(() => parseImproverConfig({ ...config, [key]: -1 }), /bound/);
  assert.throws(() => parseImproverConfig({ ...config, criterion: {} } as ImproverConfig), /fields/);
  const scores: ImproverScore[] = [{ task: 'a', repo: 'r', target: 'x', mean: 1, majority: 0.5, retained_baseline: 0.5, samples: 10 }, { task: 'b', repo: 'r', target: 'y', mean: 0, majority: 0.5, retained_baseline: 0.5, samples: 20 }];
  const summary = summarizeImproverScores(scores); assert.equal(summary.trackers, 1); assert.equal(summary.mean, 0.5); assert.deepEqual(summary.interval, [0,1]);
  assert.throws(() => summarizeImproverScores([]), /empty/);
  assert.throws(() => improverAccuracy([], { config: policy.arms[0].config, checkpoint: prefixCheckpoint(new Array<number>(32).fill(0), policy.arms[0].config.prefix) }), /empty/);
});

test("reserved fits preserve candidate evidence on inner rejection and support real promotion and gap refusal", { timeout: 300_000 }, async () => {
  const w = await workspace(); const original = readImproverTasks(w.dataset, w.manifest, 'development')[0];
  const config = initialImprover().arms[0].config;
  const training = Array.from({ length: 64 }, (_, index) => ({ ...original.train[index % original.train.length], id: `train-${index}` }));
  const evaluation = Array.from({ length: 2000 }, (_, index) => ({ ...original.evaluation[index % original.evaluation.length], id: `eval-${index}` }));
  let manifest = reseal(w.dataset, w.manifest, 'development', [{ ...original, train: training, evaluation }]);
  let env = openImproverEnvironment(w.client, w.coordinates, w.dataset, manifest, w.approval, 256, 42, IMPROVER_CRITERION);
  const accepted = await env.fit('development', 0, config, 'positive-fit', null, AbortSignal.timeout(60_000));
  assert.equal(accepted.promoted, true, JSON.stringify({ mean: accepted.mean, gain: accepted.gain, gap: accepted.gap, verdict: accepted.verdict }));
  assert.equal(accepted.diagnostics.distinct_predictions, 2);
  assert.deepEqual(accepted.diagnostics.held_out_classes, { '0': 1000, '1': 1000 });
  assert.equal(accepted.diagnostics.train_accuracy, 1); assert.equal(accepted.diagnostics.train_majority, 0.5);
  assert.equal(accepted.diagnostics.beats_train_majority, true);
  const constant = diagnoseImproverLearner(original, { config, checkpoint: prefixCheckpoint(new Array<number>(32).fill(0), config.prefix) });
  assert.equal(constant.distinct_predictions, 1); assert.equal(constant.beats_train_majority, false);
  assert.deepEqual(constant.held_out_classes, { '0': 0, '1': original.evaluation.length }, 'the zero-weight seed predicts class one on every held-out item');
  assert.equal(constant.train_accuracy, 0.5); assert.equal(constant.held_out_classes['0'] + constant.held_out_classes['1'], original.evaluation.length);
  assert.deepEqual(await env.fit('development', 0, config, 'positive-fit', null, AbortSignal.timeout(60_000)), accepted);
  const held = await env.fit('development', 0, config, 'incumbent-fit', accepted.retained, AbortSignal.timeout(60_000));
  assert.equal(held.promoted, false); assert.equal(held.retained_mean, accepted.retained_mean);
  manifest = reseal(w.dataset, manifest, 'development', [{ ...original, train: training, evaluation: evaluation.map((row) => ({ ...row, label: row.label === 0 ? 1 : 0 })) }]);
  env = openImproverEnvironment(w.client, w.coordinates, w.dataset, manifest, w.approval, 256, 42, IMPROVER_CRITERION);
  const gap = await env.fit('development', 0, config, 'gap-fit', null, AbortSignal.timeout(60_000));
  assert.ok(gap.gap > 0.3); assert.equal(gap.promoted, false); assert.equal(gap.retained_mean, 0.5);
  assert.equal(gap.diagnostics.distinct_predictions, 2); assert.equal(gap.diagnostics.train_accuracy, 1);
  assert.equal(gap.diagnostics.beats_train_majority, true, 'rejected candidate diagnostics must not describe the constant retained learner');
});

test("SIGKILL before exec recovers missing and partial receipts once inside the predeclared budget", { timeout: 300_000 }, async (context) => {
  const w = await workspace(); const task = readImproverTasks(w.dataset, w.manifest, 'development')[0];
  const knobs = initialImprover().arms[0].config.prefix;
  const base: ProcessInput<PrefixCheckpoint> = { identity: { programme_id: 'intent' }, source: prefixCheckpoint(new Array<number>(32).fill(0), knobs), training: [], observations: [],
    training_config: { learning_rate: 0.5, steps: 1 }, lineage: { synthetic: 'intent-recovery' }, prefix: { knobs, rows: task.train.slice(0, 8).map((row) => ({ prefix: row.prefix, label: row.label })) } };
  for (const mode of ['missing','partial','invalid'] as const) {
    const input = { ...base, identity: { programme_id: `intent-${mode}` } };
    const file = join(w.root, `intent-${mode}.json`); writeFileSync(file, JSON.stringify({ input, approval: w.approval }));
    const childEnvironment = { ...process.env }; delete childEnvironment.NODE_V8_COVERAGE;
    const child = fork(new URL('./fixtures/improver-intent.ts', import.meta.url), [w.project, w.coordinates.pmRoot, file, mode], { execArgv: [], env: childEnvironment, stdio: ['ignore','ignore','pipe','ipc'] });
    context.after(async () => { if (child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited; } });
    let stderr = ''; child.stderr!.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    const message = await Promise.race([once(child, 'message'), once(child, 'exit').then(() => { throw new Error(stderr); })]);
    const originalId = (message[0] as { id: string }).id;
    const exited = once(child, 'exit'); child.kill('SIGKILL'); assert.equal((await exited)[1], 'SIGKILL');
    const before = (await listProcessJobs(w.client)).length;
    if (mode === 'invalid') {
      await assert.rejects(executeImproverFit(w.client, w.coordinates, input, w.approval, AbortSignal.timeout(60_000)), /lineage|configuration/);
      await assert.rejects(executeImproverFit(w.client, w.coordinates, input, w.approval, AbortSignal.timeout(60_000)), /failed/);
      assert.equal((await listProcessJobs(w.client)).length, before, 'intact invalid evidence is never retried');
    } else {
      const recovered = await executeImproverFit(w.client, w.coordinates, input, w.approval, AbortSignal.timeout(60_000));
      assert.equal(recovered.state, 'materialized'); assert.notEqual(recovered.completion!.policy.digest, base.source.digest);
      const jobs = await listProcessJobs(w.client); assert.equal(jobs.length, before + 1);
      assert.ok(jobs.find((job) => job.id === originalId)!.settled); assert.equal(jobs.find((job) => job.id === originalId)!.state, 'failed');
      assert.deepEqual(await executeImproverFit(w.client, w.coordinates, input, w.approval, AbortSignal.timeout(60_000)), recovered);
      assert.equal((await listProcessJobs(w.client)).length, jobs.length);
    }
  }
  const invalid = { ...base, identity: { programme_id: 'bounded-failure' }, prefix: { knobs, rows: [] } };
  const before = (await listProcessJobs(w.client)).length;
  await assert.rejects(executeImproverFit(w.client, w.coordinates, invalid, w.approval, AbortSignal.timeout(60_000)), /unsuccessfully/);
  assert.equal((await listProcessJobs(w.client)).length, before + 1, 'an ordinary trainer failure stops the current invocation');
  await assert.rejects(executeImproverFit(w.client, w.coordinates, invalid, w.approval, AbortSignal.timeout(60_000)), /unsuccessfully/);
  await assert.rejects(executeImproverFit(w.client, w.coordinates, invalid, w.approval, AbortSignal.timeout(60_000)), /failed/);
  assert.equal((await listProcessJobs(w.client)).length, before + 2, 'a third attempt cannot consume more compute');
  await assert.rejects(executeImproverFit(w.client, w.coordinates, base, w.approval, AbortSignal.abort(new Error('pre-cancelled'))), /pre-cancelled/);
  const cancellationCount = (await listProcessJobs(w.client)).length;
  await assert.rejects(executeImproverFit(w.client, w.coordinates, { ...base, identity: { programme_id: 'cancelled-fit' } }, w.approval, AbortSignal.timeout(10)));
  assert.ok((await listProcessJobs(w.client)).length <= cancellationCount + 1, 'cancellation never starts a recovery attempt');
  const blocked = { ...base, identity: { programme_id: 'blocked-staging' } };
  const staging = processStaging(w.coordinates.pmRoot, processJobId(improverProcessAttempt(blocked, 0), prefixTrainerArgv(), IMPROVER_ADAPTER));
  mkdirSync(dirname(staging), { recursive: true }); writeFileSync(staging, 'storage fault sentinel');
  await assert.rejects(executeImproverFit(w.client, w.coordinates, blocked, w.approval, AbortSignal.timeout(60_000)), /EEXIST/);
});

test("three recursive generations survive SIGKILL after update, adopt receipts and leave final audit untouched until selection", { timeout: 600_000 }, async (context) => {
  const w = await workspace();
  const request = { id: 'kill-proof', config: w.config, dataset: w.dataset, approval: w.approval };
  const file = join(w.root, 'request.json'); writeFileSync(file, JSON.stringify(request));
  const childEnvironment = { ...process.env }; delete childEnvironment.NODE_V8_COVERAGE;
  const child = fork(new URL('./fixtures/improver-controller.ts', import.meta.url), [w.project, w.coordinates.pmRoot, file], { execArgv: [], env: childEnvironment, stdio: ['ignore','pipe','pipe','ipc'] });
  context.after(async () => { if (child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited; } });
  let stderr = ''; child.stderr!.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
  const message = await Promise.race([once(child, 'message'), once(child, 'exit').then(() => { throw new Error(`controller exited: ${stderr}`); })]);
  assert.equal((message[0] as { key: string }).key, 'g1-update');
  const exit = once(child, 'exit'); child.kill('SIGKILL'); assert.equal((await exit)[1], 'SIGKILL');
  const jobs = await listProcessJobs(w.client); assert.equal(jobs.length, 1);
  const audit = join(w.dataset, 'audit.json'); renameSync(audit, `${audit}.held`);
  await assert.rejects(runRecursiveImprover(w.client, w.coordinates, { ...request, async onStep(key) { if (key === 'g3-generation') throw new Error('all selections committed without audit capability'); } }), /all selections committed/);
  renameSync(`${audit}.held`, audit);
  const before = await listProcessJobs(w.client);
  const report = await runRecursiveImprover(w.client, w.coordinates, request);
  assert.equal(report.generations.length, 3); assert.equal(report.budget.fits, 11);
  assert.ok(report.generations.every((row) => row.candidate.ledger !== report.initial.ledger && row.candidate.digest !== row.policy));
  assert.equal(report.generations[2].candidate.arms.reduce((sum, arm) => sum + arm.failure - 1, 0), 3);
  assert.ok(report.generations.every((row) => !row.promoted));
  for (const row of report.generations) assert.equal(row.any_candidate_beats_train_majority, [...row.development.trials, ...row.meta.before.trials, ...row.meta.after.trials].some(({ trial }) => trial.diagnostics.beats_train_majority));
  const after = await listProcessJobs(w.client); assert.equal(after.length, 11); assert.equal(before.length, 9);
  assert.equal(after.filter((job) => jobs.some((prior) => prior.id === job.id)).length, 1);
  assert.deepEqual(await runRecursiveImprover(w.client, w.coordinates, request), report);
  assert.deepEqual(await listProcessJobs(w.client), after);
  const harness = await createExtensionTestHarness(extension, { name: 'pm-rl', capabilities: ['commands','hooks','schema'] });
  const configFile = join(w.root, 'programme.json'); writeFileSync(configFile, JSON.stringify(w.config));
  const command = await harness.runCommand({ command: 'rl improver run', pmRoot: w.coordinates.pmRoot, args: [request.id], options: { file: configFile, dataset: w.dataset, approval: w.approval, forceTakeover: false }, global: { author: 'improver-test' } });
  assert.equal(command.handled, true, command.errorMessage ?? 'improver command'); assert.deepEqual((command.result as RlCommandResult).details, report);
  const invalid = await harness.runCommand({ command: 'rl improver run', pmRoot: w.coordinates.pmRoot, args: ['INVALID'], options: { file: configFile, dataset: w.dataset, approval: w.approval, force_takeover: true }, global: { author: 'improver-test' } });
  assert.ok(invalid.errorMessage);
  await assert.rejects(runRecursiveImprover(w.client, w.coordinates, { ...request, signal: AbortSignal.abort(new Error('pre-cancelled')) }), /pre-cancelled/);
  await assert.rejects(runRecursiveImprover(w.client, w.coordinates, { ...request, config: { ...w.config, seed: 43 } }), /disagrees/);
  await assert.rejects(runRecursiveImprover(w.client, w.coordinates, { ...request, id: 'TOO-LONG-AND-INVALID' }), /programme_id/);
  const originalBody = String((await w.client.get(w.approval)).item.body);
  await assert.rejects(runRecursiveImprover(w.client, w.coordinates, { ...request, id: 'drift', onStep: async (key) => { if (key === 'programme') await w.client.update(w.approval, { body: originalBody + '\nChanged approval contract.' }); } }), /approval_drift/);
  await w.client.update(w.approval, { body: originalBody });
  const expired = { ...request, id: 'expired', config: { ...w.config, timeout_ms: 1 }, signal: AbortSignal.timeout(60_000) };
  await assert.rejects(runRecursiveImprover(w.client, w.coordinates, { ...expired, onStep: (key) => { if (key === 'programme') throw new Error('original deadline pinned'); } }), /deadline pinned/);
  await assert.rejects(runRecursiveImprover(w.client, w.coordinates, expired), /aborted|timeout/i);
  assert.equal((await listProcessJobs(w.client)).length, after.length, 'drift and an expired original deadline must never launch another fit');
  await w.client.update(w.approval, { type: 'Task' });
  await assert.rejects(runRecursiveImprover(w.client, w.coordinates, request), /approval_required/);
});

test("public command builds chronological tasks and copied sources cannot modify original checkouts", { timeout: 300_000 }, async () => {
  const w = await workspace(false);
  await withTrackerSources(async () => {
    const harness = await createExtensionTestHarness(extension, { name: 'pm-rl', capabilities: ['commands','hooks','schema'] });
    // Reuse the fixture metadata executable without an SDK mock.
    const original = process.env.PATH; process.env.PATH = `${w.bin}:${original}`;
    try {
      const output = join(w.root, 'command-data');
      const result = await harness.runCommand({ command: 'rl improver build', pmRoot: w.coordinates.pmRoot, args: w.directories.slice(1), options: { from_trackers: w.directories[0], output }, global: { author: 'improver-test' } });
      assert.equal(result.handled, true, result.errorMessage ?? 'improver build'); assert.equal((result.result as RlCommandResult).action, 'rl-improver-build');
    } finally { process.env.PATH = original; }
  });
  const firstSource = dirname(dirname(w.directories[0])); writeFileSync(join(firstSource, 'source-only.ts'), 'export const sentinel = true;\n');
  git(firstSource, ['add','source-only.ts']); git(firstSource, ['-c','user.name=Public Fixture','-c','user.email=public@example.test','commit','-qm','Synthetic code exclusion sentinel']);
  const pins = w.directories.map((directory) => ({ repo: git(dirname(dirname(directory)), ['remote','get-url','origin']).replace('https://github.com/','').replace('.git',''), commit: git(dirname(dirname(directory)), ['rev-parse','HEAD']) }));
  const fleet = join(w.root, 'fleet'); mkdirSync(fleet);
  for (const directory of w.directories) execFileSync('ln', ['-s', dirname(dirname(directory)), join(fleet, dirname(dirname(directory)).split('/').at(-1)!)]);
  const copies = copyImproverSources(fleet, join(w.root, 'copies'), pins);
  assert.equal(copies.length, 5); assert.equal(readFileSync(join(copies[0], 'history/item-0.jsonl'), 'utf8'), readFileSync(join(w.directories[0], 'history/item-0.jsonl'), 'utf8'));
  assert.equal(existsSync(join(dirname(dirname(copies[0])), 'source-only.ts')), false, 'source copies contain tracker files only');
  assert.ok(w.directories.every((directory) => git(dirname(dirname(directory)), ['status','--porcelain']) === ''));
  assert.throws(() => copyImproverSources(fleet, join(w.root, 'bad'), [{ repo: 'bad', commit: 'x' }]));
  const missingPins = join(w.root, 'missing-pins.json'); writeFileSync(missingPins, JSON.stringify({ dataset: { sources: [] } }));
  assert.throws(() => improverLivePins(missingPins), /live_pin/);
  await withLiveImproverFixture(w.bin, async (liveRoot, before) => {
    const clockCalls: number[] = [];
    /** Deterministically charge packaging and installation without sleeping or changing trainer behavior. */
    const now = (): number => {
      if (clockCalls.length === 1) {
        const run = readdirSync(liveRoot).find((entry) => !before.has(entry))!;
        assert.ok(readdirSync(join(liveRoot, run)).some((entry) => entry.endsWith('.tgz')), 'package must exist before remaining-time calculation');
        assert.ok(existsSync(join(liveRoot, run, 'controller/.agents/pm/extensions/pm-rl/package.json')), 'installation must finish before remaining-time calculation');
        assert.equal(existsSync(join(liveRoot, run, 'programme.json')), false);
      }
      const time = clockCalls.length === 0 ? 0 : 10_000; clockCalls.push(time); return time;
    };
    await liveImproverWorker(fleet, pins.slice(0, 3).map((pin, index) => ({ ...pin, role: (['train','meta-validation','final-test'] as const)[index] })), { ...w.config, generations: 1, updates: 8 }, now);
    const evidence = readdirSync(liveRoot).filter((entry) => !before.has(entry)).map((entry) => join(liveRoot, entry, 'evidence.json')).find(existsSync)!;
    const measured = JSON.parse(readFileSync(evidence, 'utf8')) as { config: ImproverConfig; budget: { fits: number }; generations: { diagnostics: { development: { distinct_predictions: number }[] }; any_candidate_beats_train_majority: boolean }[] };
    assert.equal(measured.budget.fits, 10); assert.equal(measured.config.timeout_ms, w.config.timeout_ms - 10_000);
    assert.ok(measured.generations[0].diagnostics.development.every((trial) => trial.distinct_predictions >= 1));
    assert.equal(typeof measured.generations[0].any_candidate_beats_train_majority, 'boolean');
  });
  await withLiveImproverFixture(w.bin, async (liveRoot, before) => {
    const times = [0, w.config.timeout_ms + 1];
    await assert.rejects(liveImproverWorker(fleet, pins.slice(0, 3).map((pin, index) => ({ ...pin, role: (['train','meta-validation','final-test'] as const)[index] })), { ...w.config, generations: 1, updates: 8 }, () => times.shift()!), /improver_live_deadline_exhausted/);
    const run = join(liveRoot, readdirSync(liveRoot).find((entry) => !before.has(entry))!);
    assert.ok(readdirSync(run).some((entry) => entry.endsWith('.tgz')));
    assert.equal(existsSync(join(run, 'programme.json')), false, 'exhaustion refuses before invoking the programme');
  });
  assert.throws(() => execFileSync(process.execPath, [join(import.meta.dirname, '../scripts/live-improver.ts')], { env: { ...process.env, PM_RL_TRACKER_ROOT: join(w.root, 'missing-fleet') }, timeout: 30_000, stdio: 'pipe' }));
});
