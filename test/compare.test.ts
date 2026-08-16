/** Run comparison: pure metric/config diff math and the compare command. */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { PmClient } from "@unbrained/pm-cli/sdk/core";
import { init, isPmCliExpectedError } from "@unbrained/pm-cli/sdk/runtime";
import { createExtensionTestHarness, type ExtensionTestHarness } from "@unbrained/pm-cli/sdk/testing";

import extension, { RL_ITEM_TYPES, type EnvironmentSpec, type JsonValue, type RlCommandResult } from "../index.ts";
import {
  buildConfigDelta,
  buildCompareView,
  diffJsonValues,
  diffMetricSeries,
  renderCompareReport,
  type CompareView,
  type JsonDelta,
  type MetricSeriesDiff,
  type RunCompareInput,
} from "../compare.ts";

const roots: string[] = [];

after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

/** Extract a successful structured command result, failing loudly on an unhandled command. */
function resultOf(run: { result?: unknown; handled: boolean }): RlCommandResult {
  assert.equal(run.handled, true, JSON.stringify(run));
  return run.result as RlCommandResult;
}

/**
 * Assert a command refusal carries an explicit typed code and conflict exit.
 *
 * The cross-environment refusal must be a typed refusal, not a warning and not
 * a silent best-effort answer, so the code is asserted alongside the message.
 */
function typedRefusal(code: string) {
  return (error: unknown): boolean =>
    isPmCliExpectedError(error) && error.exitCode === 4 && String((error as { context?: { code?: string } }).context?.code) === code;
}

/** One metric event, for building pure series fixtures. */
function event(step: number, metric: string, value: number): { step: number; metric: string; value: number } {
  return { step, metric, value };
}

/** The environment specification the command fixtures run under. */
const SPEC: EnvironmentSpec = {
  name: "Grid World",
  version: "3",
  task_suite: ["reach-goal"],
  reward_specification: { goal: 10, step: -0.01 },
};

/** A run input with seeded defaults, overridden only where a pure test varies a field. */
function runInput(overrides: Partial<RunCompareInput> = {}): RunCompareInput {
  return {
    id: "run-x",
    algorithm: "PPO",
    environment: "env-1",
    events: [],
    environmentSpec: SPEC,
    config: {},
    ...overrides,
  };
}

// -------------------------------------------------------------------------------------------------
// Pure series math: the common range, per-metric diffs, and edge shapes.
// -------------------------------------------------------------------------------------------------

test("diffMetricSeries restricts per-metric differences to the common step range", () => {
  const baseline = [
    event(0, "episode_return", 1),
    event(1, "episode_return", 2),
    event(2, "episode_return", 3),
    event(0, "reward", 0.5),
  ];
  const candidate = [
    event(1, "episode_return", 3),
    event(2, "episode_return", 3),
    event(3, "episode_return", 4),
    event(1, "extra", 9),
  ];
  const diff = diffMetricSeries(baseline, candidate);
  assert.deepEqual(diff.baseline_range, { first: 0, last: 2 });
  assert.deepEqual(diff.candidate_range, { first: 1, last: 3 });
  assert.deepEqual(diff.common_range, { first: 1, last: 2 });
  assert.deepEqual(diff.metrics.map((metric) => metric.metric), ["episode_return", "extra", "reward"]);
  const episode = diff.metrics[0] as MetricSeriesDiff;
  assert.deepEqual(episode.common_steps, [1, 2]);
  assert.deepEqual(episode.differences, [{ step: 1, baseline: 2, candidate: 3, delta: 1 }]);
  assert.equal(episode.max_abs_delta, 1);
  // Steps 0 and 3 fall OUTSIDE the common range and are reported nowhere,
  // rather than read as one-sided differences.
  assert.deepEqual(episode.baseline_only_steps, []);
  assert.deepEqual(episode.candidate_only_steps, []);
  assert.equal((diff.metrics[1] as MetricSeriesDiff).present, "candidate_only");
  assert.equal((diff.metrics[2] as MetricSeriesDiff).present, "baseline_only");
});

test("diffMetricSeries reports one-sided in-range steps per metric", () => {
  const diff = diffMetricSeries(
    [
      event(1, "loss", 1),
      event(2, "loss", 2),
      event(3, "loss", 3),
      event(1, "reward", 1),
      event(3, "reward", 3),
    ],
    [
      event(1, "loss", 5),
      event(3, "loss", 6),
      event(1, "reward", 5),
      event(2, "reward", 6),
      event(3, "reward", 7),
    ],
  );
  assert.deepEqual(diff.common_range, { first: 1, last: 3 });
  const loss = diff.metrics[0] as MetricSeriesDiff;
  assert.deepEqual(loss.common_steps, [1, 3]);
  assert.deepEqual(loss.differences, [
    { step: 1, baseline: 1, candidate: 5, delta: 4 },
    { step: 3, baseline: 3, candidate: 6, delta: 3 },
  ]);
  // The candidate skipped step 2 inside the shared range: reported, not read
  // as a zero or dropped.
  assert.deepEqual(loss.baseline_only_steps, [2]);
  assert.deepEqual(loss.candidate_only_steps, []);
  assert.equal(loss.max_abs_delta, 4);
  const reward = diff.metrics[1] as MetricSeriesDiff;
  assert.deepEqual(reward.common_steps, [1, 3]);
  assert.deepEqual(reward.baseline_only_steps, []);
  assert.deepEqual(reward.candidate_only_steps, [2]);
});

test("diffMetricSeries reports an explicitly empty common range for zero overlapping steps", () => {
  const diff = diffMetricSeries(
    [event(0, "episode_return", 1), event(2, "episode_return", 2)],
    [event(100, "episode_return", 5), event(102, "episode_return", 6)],
  );
  assert.equal(diff.common_range, null);
  const metric = diff.metrics[0] as MetricSeriesDiff;
  assert.equal(metric.present, "both");
  assert.deepEqual(metric.common_steps, []);
  assert.deepEqual(metric.differences, []);
  assert.equal(metric.max_abs_delta, null);
  // An empty run shares no range with anything.
  const empty = diffMetricSeries([], [event(0, "loss", 1)]);
  assert.equal(empty.baseline_range, null);
  assert.equal(empty.common_range, null);
  assert.equal((empty.metrics[0] as MetricSeriesDiff).present, "candidate_only");
  assert.deepEqual(diffMetricSeries([], []).metrics, []);
});

test("a repeated measurement at one step uses the later value in the diff", () => {
  const diff = diffMetricSeries(
    [event(1, "loss", 1), event(1, "loss", 2)],
    [event(1, "loss", 2)],
  );
  const loss = diff.metrics[0] as MetricSeriesDiff;
  // If the earlier occurrence won, 1 against 2 would differ; the later 2 agrees.
  assert.deepEqual(loss.differences, []);
  assert.deepEqual(loss.common_steps, [1]);
});

// -------------------------------------------------------------------------------------------------
// Pure JSON diff math: the config delta's leaves.
// -------------------------------------------------------------------------------------------------

test("diffJsonValues reports changed, added and removed leaves by path", () => {
  const left: JsonValue = { a: 1, b: { c: 2, d: [1, 2] }, keep: "same" };
  const right: JsonValue = { a: 1, b: { c: 3, d: [1] }, keep: "same", seed: 3 };
  assert.deepEqual(diffJsonValues(left, right), [
    { path: "b.c", baseline: 2, candidate: 3 },
    { path: "b.d[1]", baseline: 2, candidate: undefined },
    { path: "seed", baseline: undefined, candidate: 3 },
  ]);
  // A longer candidate array reports per-index additions.
  assert.deepEqual(diffJsonValues([1], [1, 2]), [{ path: "[1]", baseline: undefined, candidate: 2 }]);
  // Mismatched kinds report one delta at the path instead of a structural guess.
  assert.deepEqual(diffJsonValues({ x: { deep: 1 } }, { x: 5 }), [{ path: "x", baseline: { deep: 1 }, candidate: 5 }]);
  // The root itself is addressed by the empty path.
  assert.deepEqual(diffJsonValues(1, 2), [{ path: "", baseline: 1, candidate: 2 }]);
  assert.deepEqual(diffJsonValues(null, 0), [{ path: "", baseline: null, candidate: 0 }]);
  // Identical values report nothing.
  assert.deepEqual(diffJsonValues({ a: [1, { b: null }] }, { a: [1, { b: null }] }), []);
});

test("buildConfigDelta computes every explanation field from the recorded configurations", () => {
  const delta = buildConfigDelta(
    runInput({ algorithm: "PPO", config: { learning_rate: 0.1 }, environmentSpec: SPEC }),
    runInput({
      id: "run-y",
      algorithm: "PPO-LR",
      config: { learning_rate: 0.01 },
      environmentSpec: { ...SPEC, version: "4", reward_specification: { goal: 20 } },
    }),
  );
  assert.deepEqual(delta.algorithm, { baseline: "PPO", candidate: "PPO-LR" });
  assert.deepEqual(delta.hyperparameters, [{ path: "learning_rate", baseline: 0.1, candidate: 0.01 }]);
  assert.deepEqual(delta.environment_version, { baseline: "3", candidate: "4" });
  assert.deepEqual(delta.reward_specification, [
    { path: "goal", baseline: 10, candidate: 20 },
    { path: "step", baseline: -0.01, candidate: undefined },
  ]);
  // Equal recorded configurations explain nothing.
  const same = buildConfigDelta(runInput(), runInput({ id: "run-y" }));
  assert.equal(same.algorithm, null);
  assert.deepEqual(same.hyperparameters, []);
  assert.equal(same.environment_version, null);
  assert.deepEqual(same.reward_specification, []);
});

test("buildCompareView carries each run's range and the shared common range", () => {
  const view = buildCompareView(
    runInput({ id: "run-a", events: [event(0, "loss", 1), event(3, "loss", 2)] }),
    runInput({ id: "run-b", events: [event(3, "loss", 2), event(5, "loss", 3)] }),
  );
  assert.deepEqual(view.baseline.step_range, { first: 0, last: 3 });
  assert.deepEqual(view.candidate.step_range, { first: 3, last: 5 });
  assert.deepEqual(view.common_step_range, { first: 3, last: 3 });
  assert.equal(view.baseline.environment, "env-1");
});

test("renderCompareReport states the range, every metric, and the full config delta", () => {
  const rich: CompareView = {
    baseline: { id: "run-a", algorithm: "PPO", environment: "env-1", step_range: { first: 0, last: 3 } },
    candidate: { id: "run-b", algorithm: "PPO", environment: "env-1", step_range: { first: 1, last: 4 } },
    common_step_range: { first: 1, last: 3 },
    metrics: [
      {
        metric: "episode_return",
        present: "both",
        common_steps: [1, 2, 3],
        differences: [{ step: 2, baseline: 2, candidate: 3.5, delta: 1.5 }],
        baseline_only_steps: [1],
        candidate_only_steps: [3],
        max_abs_delta: 1.5,
      },
      { metric: "loss", present: "both", common_steps: [1, 2, 3], differences: [], baseline_only_steps: [], candidate_only_steps: [], max_abs_delta: null },
      { metric: "reward", present: "baseline_only", common_steps: [], differences: [], baseline_only_steps: [], candidate_only_steps: [], max_abs_delta: null },
      { metric: "extra", present: "candidate_only", common_steps: [], differences: [], baseline_only_steps: [], candidate_only_steps: [], max_abs_delta: null },
    ],
    config_delta: {
      algorithm: { baseline: "PPO", candidate: "PPO-LR" },
      hyperparameters: [
        { path: "learning_rate", baseline: 0.1, candidate: 0.01 },
        { path: "", baseline: 1, candidate: 2 },
      ],
      environment_version: { baseline: "3", candidate: "4" },
      reward_specification: [{ path: "goal", baseline: 10, candidate: 20 }],
    },
  };
  const rendered = renderCompareReport(rich);
  const lines = rendered.split("\n");
  assert.equal(lines[0], "compare run-a (baseline) with run-b (candidate)");
  assert.equal(lines[1], "environment: env-1");
  assert.match(rendered, /common step range: 1\.\.3/);
  assert.match(rendered, /episode_return: 3 common step\(s\), 1 differing, max \|delta\| 1\.5/);
  assert.match(rendered, /  step 2: 2 -> 3\.5 \(\+1\.5\)/);
  assert.match(rendered, /  only the baseline measured steps: 1/);
  assert.match(rendered, /  only the candidate measured steps: 3/);
  assert.match(rendered, /loss: 3 common step\(s\), 0 differing/);
  assert.match(rendered, /reward: only the baseline run measured this metric/);
  assert.match(rendered, /extra: only the candidate run measured this metric/);
  assert.match(rendered, /algorithm: PPO -> PPO-LR/);
  assert.match(rendered, /  learning_rate: 0\.1 -> 0\.01/);
  assert.match(rendered, /  \(root\): 1 -> 2/);
  assert.match(rendered, /environment version: 3 -> 4/);
  assert.match(rendered, /  goal: 10 -> 20/);
  const emptyRange = renderCompareReport({
    baseline: { id: "run-e", algorithm: "PPO", environment: "env-1", step_range: { first: 0, last: 2 } },
    candidate: { id: "run-f", algorithm: "PPO", environment: "env-1", step_range: { first: 100, last: 102 } },
    common_step_range: null,
    metrics: [],
    config_delta: { algorithm: null, hyperparameters: [], environment_version: null, reward_specification: [] },
  });
  assert.match(emptyRange, /common step range: none \(the runs measured no overlapping steps\)/);
  assert.match(emptyRange, /algorithm: unchanged/);
  assert.match(emptyRange, /hyperparameters: unchanged/);
  assert.match(emptyRange, /environment version: unchanged/);
  assert.match(emptyRange, /reward specification: unchanged/);
});

// -------------------------------------------------------------------------------------------------
// The command over a real tracker: real runs, real notes, typed refusals.
// -------------------------------------------------------------------------------------------------

/** A real initialized tracker with the pm-rl schema materialized. */
async function compareWorkspace(): Promise<{
  root: string;
  pmRoot: string;
  client: PmClient;
  harness: ExtensionTestHarness;
}> {
  const root = mkdtempSync(join(tmpdir(), "pm-rl-compare-"));
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
  const harness = await createExtensionTestHarness(extension, { name: "pm-rl", capabilities: ["commands", "schema"] });
  assert.deepEqual(harness.activation.failed, []);
  return { root, pmRoot: initialized.path, client, harness };
}

/** Write one environment version file with its own reward specification. */
function writeEnv(root: string, version: string, goal: number): string {
  const path = join(root, `env-v${version}.json`);
  writeFileSync(path, JSON.stringify({ name: "Grid World", version, task_suite: ["reach-goal"], reward_specification: { goal } }));
  return path;
}

/** Start a real run under an environment and log its metrics, all through the command surface. */
async function startRun(
  harness: ExtensionTestHarness,
  pmRoot: string,
  root: string,
  id: string,
  environment: string,
  config: Record<string, unknown>,
  metrics: string,
): Promise<string> {
  const configFile = join(root, `${id}-config.json`);
  writeFileSync(configFile, JSON.stringify(config));
  const metricFile = join(root, `${id}-metrics.ndjson`);
  writeFileSync(metricFile, metrics);
  const started = resultOf(await harness.runCommand({
    command: "rl run start",
    pmRoot,
    args: [id],
    options: { environment, algorithm: "PPO", configFile },
  })).id!;
  await harness.runCommand({ command: "rl run log", pmRoot, args: [started], options: { file: metricFile } });
  return started;
}

test("compare reports per-metric differences over the common range with the full config delta", async () => {
  const { root, pmRoot, harness } = await compareWorkspace();
  const env = resultOf(await harness.runCommand({ command: "rl env register", pmRoot, options: { file: writeEnv(root, "3", 10) } })).id!;
  const runA = await startRun(harness, pmRoot, root, "run-a", env, { learning_rate: 0.1, optimizer: { beta: 0.9 } }, [
    '{"step":0,"metric":"episode_return","value":1}',
    '{"step":1,"metric":"episode_return","value":2}',
    '{"step":2,"metric":"episode_return","value":3}',
    '{"step":3,"metric":"episode_return","value":4}',
    '{"step":0,"metric":"loss","value":0.5}',
    '{"step":1,"metric":"loss","value":0.25}',
    '{"step":2,"metric":"loss","value":0.125}',
    '{"step":3,"metric":"loss","value":0.0625}',
  ].join("\n"));
  const runB = await startRun(harness, pmRoot, root, "run-b", env, { learning_rate: 0.01, optimizer: { beta: 0.999 }, seed: 3 }, [
    '{"step":1,"metric":"episode_return","value":3}',
    '{"step":2,"metric":"episode_return","value":4}',
    '{"step":3,"metric":"episode_return","value":5}',
    '{"step":4,"metric":"episode_return","value":6}',
    '{"step":1,"metric":"loss","value":0.25}',
    '{"step":2,"metric":"loss","value":0.125}',
    '{"step":3,"metric":"loss","value":0.0625}',
    '{"step":4,"metric":"loss","value":0.03125}',
  ].join("\n"));
  const result = resultOf(await harness.runCommand({ command: "rl compare", pmRoot, args: [runA, runB] }));
  assert.equal(result.action, "rl-compare");
  assert.equal(result.details?.format, "json");
  assert.deepEqual(result.details?.common_step_range, { first: 1, last: 3 });
  const metrics = result.details?.metrics as MetricSeriesDiff[];
  assert.deepEqual(metrics.map((metric) => metric.metric), ["episode_return", "loss"]);
  const episode = metrics[0]!;
  assert.deepEqual(episode.common_steps, [1, 2, 3]);
  assert.deepEqual(episode.differences, [
    { step: 1, baseline: 2, candidate: 3, delta: 1 },
    { step: 2, baseline: 3, candidate: 4, delta: 1 },
    { step: 3, baseline: 4, candidate: 5, delta: 1 },
  ]);
  assert.equal(episode.max_abs_delta, 1);
  const loss = metrics[1]!;
  assert.deepEqual(loss.differences, []);
  assert.equal(loss.max_abs_delta, null);
  const delta = result.details?.config_delta as ReturnType<typeof buildConfigDelta>;
  assert.equal(delta.algorithm, null);
  assert.deepEqual(delta.hyperparameters, [
    { path: "learning_rate", baseline: 0.1, candidate: 0.01 },
    { path: "optimizer.beta", baseline: 0.9, candidate: 0.999 },
    { path: "seed", baseline: undefined, candidate: 3 },
  ]);
  assert.equal(delta.environment_version, null);
  assert.deepEqual(delta.reward_specification, []);
  // The table path renders the same view; the harness default is json, so the
  // host-owned --json global flag is explicitly opted out here.
  const table = resultOf(await harness.runCommand({ command: "rl compare", pmRoot, args: [runA, runB], global: { json: false } }));
  assert.equal(table.details?.format, "table");
  const output = String(table.details?.output);
  assert.match(output, /common step range: 1\.\.3/);
  assert.match(output, /episode_return: 3 common step\(s\), 3 differing, max \|delta\| 1/);
  assert.match(output, /  step 1: 2 -> 3 \(\+1\)/);
  assert.match(output, /  learning_rate: 0\.1 -> 0\.01/);
  assert.match(output, /  seed: \(absent\) -> 3/);
  assert.match(output, /loss: 3 common step\(s\), 0 differing/);
  assert.match(output, /algorithm: unchanged/);
  assert.match(output, /environment version: unchanged/);
  assert.equal(result.details?.output, undefined);
});

test("identical metrics with different configurations report an empty diff and a real config delta", async () => {
  const { root, pmRoot, harness } = await compareWorkspace();
  const env = resultOf(await harness.runCommand({ command: "rl env register", pmRoot, options: { file: writeEnv(root, "3", 10) } })).id!;
  const metrics = '{"step":0,"metric":"episode_return","value":2}\n{"step":1,"metric":"episode_return","value":3}\n';
  const runC = await startRun(harness, pmRoot, root, "run-c", env, { batch_size: 64 }, metrics);
  const runD = await startRun(harness, pmRoot, root, "run-d", env, { batch_size: 256 }, metrics);
  const result = resultOf(await harness.runCommand({ command: "rl compare", pmRoot, args: [runC, runD] }));
  const series = result.details?.metrics as MetricSeriesDiff[];
  assert.deepEqual(series[0]!.differences, []);
  assert.equal(series[0]!.max_abs_delta, null);
  const delta = result.details?.config_delta as ReturnType<typeof buildConfigDelta>;
  assert.deepEqual(delta.hyperparameters, [{ path: "batch_size", baseline: 64, candidate: 256 }]);
});

test("runs that share no steps report an explicitly empty common range", async () => {
  const { root, pmRoot, harness } = await compareWorkspace();
  const env = resultOf(await harness.runCommand({ command: "rl env register", pmRoot, options: { file: writeEnv(root, "3", 10) } })).id!;
  const runE = await startRun(harness, pmRoot, root, "run-e", env, { seed: 1 }, [
    '{"step":0,"metric":"episode_return","value":1}',
    '{"step":2,"metric":"episode_return","value":2}',
  ].join("\n"));
  const runF = await startRun(harness, pmRoot, root, "run-f", env, { seed: 2 }, [
    '{"step":100,"metric":"episode_return","value":5}',
    '{"step":102,"metric":"episode_return","value":6}',
  ].join("\n"));
  const result = resultOf(await harness.runCommand({ command: "rl compare", pmRoot, args: [runE, runF] }));
  assert.equal(result.details?.common_step_range, null);
  const metrics = result.details?.metrics as MetricSeriesDiff[];
  assert.equal(metrics[0]!.present, "both");
  assert.deepEqual(metrics[0]!.common_steps, []);
  assert.deepEqual(metrics[0]!.differences, []);
  const table = resultOf(await harness.runCommand({ command: "rl compare", pmRoot, args: [runE, runF], global: { json: false } }));
  assert.match(String(table.details?.output), /common step range: none \(the runs measured no overlapping steps\)/);
});

test("compare refuses runs from different environment versions with a typed refusal naming both", async () => {
  const { root, pmRoot, harness } = await compareWorkspace();
  const env1 = resultOf(await harness.runCommand({ command: "rl env register", pmRoot, options: { file: writeEnv(root, "3", 10) } })).id!;
  const env2 = resultOf(await harness.runCommand({ command: "rl env register", pmRoot, options: { file: writeEnv(root, "4", 20) } })).id!;
  const runV1 = await startRun(harness, pmRoot, root, "run-v1", env1, { seed: 1 }, '{"step":0,"metric":"episode_return","value":1}');
  const runV2 = await startRun(harness, pmRoot, root, "run-v2", env2, { seed: 2 }, '{"step":0,"metric":"episode_return","value":2}');
  await assert.rejects(
    harness.runCommand({ command: "rl compare", pmRoot, args: [runV1, runV2] }),
    (error: unknown): boolean => typedRefusal("environment_version_mismatch")(error)
      && String((error as Error).message).includes(env1)
      && String((error as Error).message).includes(env2),
  );
});

test("compare refuses runs whose environment is unrecorded, unreadable, mistyped or missing", async () => {
  const { root, pmRoot, client, harness } = await compareWorkspace();
  const env = resultOf(await harness.runCommand({ command: "rl env register", pmRoot, options: { file: writeEnv(root, "3", 10) } })).id!;
  const real = await startRun(harness, pmRoot, root, "run-real", env, { seed: 1 }, '{"step":0,"metric":"episode_return","value":1}');
  const handMade = async (id: string, body: string, environment?: string): Promise<string> =>
    String((await client.create({
      id,
      title: id,
      type: "Run",
      status: "in_progress",
      ...(environment === undefined ? {} : { environment }),
      body,
    })).item.id);
  // A Run the SDK stores without an environment field: comparability is undecidable.
  const bare = await handMade("run-bare", "# bare run\n");
  await assert.rejects(
    harness.runCommand({ command: "rl compare", pmRoot, args: [real, bare] }),
    typedRefusal("run_environment_unrecorded"),
  );
  const validFences = `# hand-made\n\nEnvironment snapshot:\n\n\`\`\`json\n${JSON.stringify(SPEC, null, 2)}\n\`\`\`\n\nRun configuration:\n\n\`\`\`json\n{}\n\`\`\`\n`;
  // A body with no recorded sections at all.
  const noSections = await handMade("run-nosections", "# hand-made run\n\nNo provenance recorded.\n", env);
  await assert.rejects(
    harness.runCommand({ command: "rl compare", pmRoot, args: [real, noSections] }),
    typedRefusal("run_body_unreadable"),
  );
  // An environment snapshot whose fence never arrives.
  const noConfigFence = await handMade("run-noconfigfence", `# hand-made\n\nEnvironment snapshot:\n\n\`\`\`json\n${JSON.stringify(SPEC, null, 2)}\n\`\`\`\n\nRun configuration:\n`, env);
  await assert.rejects(
    harness.runCommand({ command: "rl compare", pmRoot, args: [real, noConfigFence] }),
    typedRefusal("run_body_unreadable"),
  );
  // A configuration fence that does not parse.
  const badConfig = await handMade("run-badconfig", "# hand-made\n\nEnvironment snapshot:\n\n```json\n" + JSON.stringify(SPEC, null, 2) + "\n```\n\nRun configuration:\n\n```json\nnot-json\n```\n", env);
  await assert.rejects(
    harness.runCommand({ command: "rl compare", pmRoot, args: [real, badConfig] }),
    typedRefusal("run_body_unreadable"),
  );
  // A configuration that parses but is not one JSON object.
  const arrayConfig = await handMade("run-arrayconfig", "# hand-made\n\nEnvironment snapshot:\n\n```json\n" + JSON.stringify(SPEC, null, 2) + "\n```\n\nRun configuration:\n\n```json\n[1,2]\n```\n", env);
  await assert.rejects(
    harness.runCommand({ command: "rl compare", pmRoot, args: [real, arrayConfig] }),
    /must contain one JSON object/,
  );
  // A hand-made run with valid fences records no algorithm and no events, and
  // still compares: its summary reports the empty algorithm and range honestly.
  const fenced = await handMade("run-fenced", validFences, env);
  const result = resultOf(await harness.runCommand({ command: "rl compare", pmRoot, args: [real, fenced] }));
  const candidate = result.details?.candidate as { algorithm: string; step_range: { first: number; last: number } | null };
  assert.equal(candidate.algorithm, "");
  assert.equal(candidate.step_range, null);
  // A non-Run argument is the wrong item type, not an unreadable run.
  await assert.rejects(
    harness.runCommand({ command: "rl compare", pmRoot, args: [real, env] }),
    /pm rl expected Run/,
  );
  // Both ids are required and must be non-blank.
  await assert.rejects(
    harness.runCommand({ command: "rl compare", pmRoot, args: [real] }),
    /requires two run ids/,
  );
  await assert.rejects(
    harness.runCommand({ command: "rl compare", pmRoot, args: [real, "  "] }),
    /requires two run ids/,
  );
});
