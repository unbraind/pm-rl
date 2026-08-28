/** Benchmark, evaluation-provenance, and fail-closed leaderboard acceptance tests. */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { PmClient } from "@unbrained/pm-cli/sdk/core";
import { EXIT_CODE, init, isPmCliExpectedError } from "@unbrained/pm-cli/sdk/runtime";
import { createExtensionTestHarness, type ExtensionTestHarness } from "@unbrained/pm-cli/sdk/testing";

import extension, {
  hashJson,
  parseBenchmarkSpec,
  parseEvalResultSpec,
  RL_ITEM_TYPES,
  type EnvironmentSpec,
  type JsonValue,
  type RlCommandResult,
} from "../index.ts";
import {
  rankLeaderboard,
  renderLeaderboard,
  type BenchmarkSpec,
  type LeaderboardCandidate,
} from "../leaderboard.ts";

const roots: string[] = [];

after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

/** Extract a successful structured command result. */
function resultOf(run: { result?: unknown; handled: boolean }): RlCommandResult {
  assert.equal(run.handled, true, JSON.stringify(run));
  return run.result as RlCommandResult;
}

/** Assert one machine-readable conflict refusal. */
function typedRefusal(code: string) {
  return (error: unknown): boolean => isPmCliExpectedError(error) && error.exitCode === EXIT_CODE.CONFLICT && String((error as { context?: { code?: string } }).context?.code) === code;
}

/** Extract one required JSON fence so fixture-format drift fails explicitly. */
function fencedJson(body: unknown): string {
  const fenced = String(body).match(/```json\n([\s\S]+?)\n```/)?.[1];
  assert.ok(fenced !== undefined, `expected a JSON fence in body: ${String(body)}`);
  return fenced;
}

/** Create one real tracker, client, and activated extension harness. */
async function workspace(): Promise<{ root: string; pmRoot: string; client: PmClient; harness: ExtensionTestHarness }> {
  const root = mkdtempSync(join(tmpdir(), "pm-rl-leaderboard-"));
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

/** Register one environment and source run through the public command surface. */
async function sourceRun(root: string, pmRoot: string, harness: ExtensionTestHarness, version: string): Promise<{ environment: string; run: string }> {
  const environmentFile = join(root, `environment-${version}.json`);
  const spec: EnvironmentSpec = {
    name: "Grid World",
    version,
    task_suite: ["train"],
    reward_specification: { goal: Number(version) },
  };
  writeFileSync(environmentFile, JSON.stringify(spec));
  const environment = resultOf(await harness.runCommand({ command: "rl env register", pmRoot, options: { file: environmentFile } })).id!;
  const run = resultOf(await harness.runCommand({
    command: "rl run start",
    pmRoot,
    args: [`run-${version}`],
    options: { environment, algorithm: "PPO" },
  })).id!;
  return { environment, run };
}

/** Write and register one benchmark through the real extension command. */
async function benchmark(root: string, pmRoot: string, harness: ExtensionTestHarness, contaminatedBy?: string): Promise<string> {
  const file = join(root, `benchmark-${contaminatedBy === undefined ? "clean" : "contaminated"}.json`);
  writeFileSync(file, JSON.stringify({
    name: "Agent Safety",
    version: "1",
    task_suite: ["held-out"],
    scoring_function: { metric: "success_rate" },
    pass_criteria: { gte: 0.8 },
    direction: "maximize",
  }));
  return resultOf(await harness.runCommand({
    command: "rl benchmark register",
    pmRoot,
    options: { file, ...(contaminatedBy === undefined ? {} : { contaminatedBy }) },
  })).id!;
}

/** Record one evaluation through the real command surface. */
async function evaluation(pmRoot: string, harness: ExtensionTestHarness, run: string, benchmarkId: string, checkpoint: string, score: number, passed: boolean): Promise<RlCommandResult> {
  return resultOf(await harness.runCommand({
    command: "rl eval record",
    pmRoot,
    options: { run, benchmark: benchmarkId, checkpoint, score: String(score), passed },
  }));
}

/** Create one clean, comparable evaluation fixture through only public commands. */
async function comparableFixture(): Promise<{
  root: string;
  pmRoot: string;
  client: PmClient;
  harness: ExtensionTestHarness;
  environment: string;
  run: string;
  benchmarkId: string;
  evalId: string;
}> {
  const current = await workspace();
  const source = await sourceRun(current.root, current.pmRoot, current.harness, "1");
  const benchmarkId = await benchmark(current.root, current.pmRoot, current.harness);
  const evalId = (await evaluation(current.pmRoot, current.harness, source.run, benchmarkId, "sha", 0.9, true)).id!;
  return { ...current, ...source, benchmarkId, evalId };
}

test("benchmark and evaluation parsers canonicalize valid provenance and refuse malformed inputs", () => {
  const valid = {
    name: " Safety ",
    version: " 1 ",
    task_suite: [],
    scoring_function: "accuracy",
    pass_criteria: { gte: 0.5 },
    direction: "maximize",
    contaminated_environments: [" env-b ", "env-a", "env-a"],
    harness: { seed: 42 },
  };
  assert.deepEqual(parseBenchmarkSpec(JSON.stringify(valid)), {
    ...valid,
    name: "Safety",
    version: "1",
    contaminated_environments: ["env-a", "env-b"],
  });
  for (const [text, message] of [
    ["bad", /not valid JSON/],
    ["[]", /one JSON object/],
    [JSON.stringify({ ...valid, name: "" }), /non-empty string name/],
    [JSON.stringify({ ...valid, version: 1 }), /non-empty string version/],
    [JSON.stringify({ ...valid, task_suite: undefined }), /requires task_suite/],
    [JSON.stringify({ ...valid, scoring_function: undefined }), /requires scoring_function/],
    [JSON.stringify({ ...valid, pass_criteria: undefined }), /requires pass_criteria/],
    [JSON.stringify({ ...valid, direction: "sideways" }), /maximize or minimize/],
    [JSON.stringify({ ...valid, contaminated_environments: "env-a" }), /array of non-empty/],
    [JSON.stringify({ ...valid, contaminated_environments: [""] }), /array of non-empty/],
  ] as Array<[string, RegExp]>) {
    assert.throws(() => parseBenchmarkSpec(text), message);
  }

  const evalSpec = {
    checkpoint: " ckpt ", score: 0.9, passed: true, run_id: " run ", benchmark_id: " bench ",
    environment_id: " env ", environment_spec_hash: " spec ", reward_spec_hash: " reward ",
  };
  assert.deepEqual(parseEvalResultSpec(JSON.stringify(evalSpec)), {
    checkpoint: "ckpt", score: 0.9, passed: true, run_id: "run", benchmark_id: "bench",
    environment_id: "env", environment_spec_hash: "spec", reward_spec_hash: "reward",
  });
  for (const [text, message] of [
    ["bad", /not valid JSON/],
    ["[]", /one JSON object/],
    [JSON.stringify({ ...evalSpec, checkpoint: "" }), /requires a non-empty string checkpoint/],
    [JSON.stringify({ ...evalSpec, score: Number.NaN }), /score must be finite/],
    [JSON.stringify({ ...evalSpec, passed: "yes" }), /passed must be a boolean/],
  ] as Array<[string, RegExp]>) {
    assert.throws(() => parseEvalResultSpec(text), message);
  }
});

test("ranking is direction aware, byte-stable on ties, and renders complete provenance", () => {
  const base: Omit<LeaderboardCandidate, "eval_id" | "score" | "passed" | "checkpoint"> = {
    run_id: "run-a", benchmark_id: "bench-a", environment_id: "env-a",
    environment_spec_hash: "environment-hash", reward_spec_hash: "reward-hash",
  };
  const candidates: LeaderboardCandidate[] = [
    { ...base, eval_id: "eval-z", checkpoint: "ckpt-z", score: 3, passed: true },
    { ...base, eval_id: "eval-a", checkpoint: "ckpt-a", score: 3, passed: false },
    { ...base, eval_id: "eval-low", checkpoint: "ckpt-low", score: 1, passed: false },
  ];
  assert.deepEqual(rankLeaderboard("maximize", candidates).map((row) => [row.rank, row.eval_id]), [[1, "eval-a"], [2, "eval-z"], [3, "eval-low"]]);
  const minimized = rankLeaderboard("minimize", candidates);
  assert.deepEqual(minimized.map((row) => row.eval_id), ["eval-low", "eval-a", "eval-z"]);
  const spec: BenchmarkSpec = {
    name: "Safety", version: "1", task_suite: [], scoring_function: "score",
    pass_criteria: { lte: 2 }, direction: "minimize", contaminated_environments: [],
  };
  const report = renderLeaderboard("bench-a", spec, minimized);
  assert.match(report, /^Safety 1 \(bench-a, minimize\) — 3 result\(s\)/);
  assert.match(report, /1 \| 1 \| no \| ckpt-low/);
  assert.match(report, /2 \| 3 \| no \| ckpt-a/);
  assert.match(report, /3 \| 3 \| yes \| ckpt-z/);
  assert.equal(renderLeaderboard("bench-a", spec, []).split("\n").length, 2);
});

test("real commands register immutable benchmarks and evaluations and rank one comparable environment", async () => {
  const { root, pmRoot, client, harness } = await workspace();
  const source = await sourceRun(root, pmRoot, harness, "1");
  const benchmarkId = await benchmark(root, pmRoot, harness);
  const benchmarkFile = join(root, "benchmark-clean.json");
  const duplicate = resultOf(await harness.runCommand({ command: "rl benchmark register", pmRoot, options: { file: benchmarkFile } }));
  assert.equal(duplicate.created, false);
  assert.equal(duplicate.id, benchmarkId);
  const empty = resultOf(await harness.runCommand({ command: "rl leaderboard", pmRoot, args: [benchmarkId], global: { json: false } }));
  assert.equal(empty.details?.environment_id, null);
  assert.equal(empty.details?.count, 0);

  const lower = await evaluation(pmRoot, harness, source.run, benchmarkId, "sha-low", 0.7, false);
  const lowerString = await evaluation(pmRoot, harness, source.run, benchmarkId, "sha-low-string", 0.6, false);
  const higher = await evaluation(pmRoot, harness, source.run, benchmarkId, "sha-high", 0.9, true);
  assert.equal((await evaluation(pmRoot, harness, source.run, benchmarkId, "sha-high", 0.9, true)).created, false);
  const higherItem = await client.get(higher.id!, { depth: "deep" });
  assert.deepEqual(higherItem.item.dependencies?.map((dependency) => [dependency.kind, dependency.source_kind]), [
    ["verifies", "pm-rl:eval:benchmark"],
    ["discovered_from", "pm-rl:eval:run"],
  ]);
  const shown = resultOf(await harness.runCommand({ command: "rl leaderboard", pmRoot, args: [benchmarkId], global: { json: false } }));
  assert.equal(shown.details?.count, 3);
  assert.equal(shown.details?.environment_id, source.environment);
  assert.equal((shown.details?.rows as Array<{ eval_id: string }>)[0]?.eval_id, higher.id);
  assert.match(String(shown.details?.output), new RegExp(`${higher.id}.*${source.run}.*${source.environment}`));
  assert.equal((shown.details?.complete_list as { item_count: number }).item_count, 6);
  const json = resultOf(await harness.runCommand({ command: "rl leaderboard", pmRoot, args: [benchmarkId], global: { json: true } }));
  assert.equal(json.details?.format, "json");
  assert.equal((json.details?.rows as Array<{ eval_id: string }>)[1]?.eval_id, lower.id);
  assert.equal((json.details?.rows as Array<{ eval_id: string }>)[2]?.eval_id, lowerString.id);
});

test("leaderboard refuses both mixed environment versions and declared benchmark contamination", async () => {
  const { root, pmRoot, client, harness } = await workspace();
  const first = await sourceRun(root, pmRoot, harness, "1");
  const second = await sourceRun(root, pmRoot, harness, "2");
  const clean = await benchmark(root, pmRoot, harness);
  await evaluation(pmRoot, harness, first.run, clean, "sha-a", 0.9, true);
  await evaluation(pmRoot, harness, second.run, clean, "sha-b", 0.8, true);
  await assert.rejects(
    harness.runCommand({ command: "rl leaderboard", pmRoot, args: [clean] }),
    typedRefusal("environment_version_mismatch"),
  );

  const contaminated = await benchmark(root, pmRoot, harness, `${first.environment},${first.environment.slice(3)}`);
  const contaminatedItem = (await client.get(contaminated, { depth: "deep" })).item;
  assert.deepEqual(parseBenchmarkSpec(fencedJson(contaminatedItem.body)).contaminated_environments, [first.environment]);
  await evaluation(pmRoot, harness, first.run, contaminated, "sha-c", 0.99, true);
  await assert.rejects(
    harness.runCommand({ command: "rl leaderboard", pmRoot, args: [contaminated] }),
    typedRefusal("benchmark_contaminated"),
  );
});

test("benchmark and evaluation commands reject incomplete input and mutated identities", async () => {
  const { root, pmRoot, client, harness } = await workspace();
  const source = await sourceRun(root, pmRoot, harness, "1");
  await assert.rejects(harness.runCommand({ command: "rl benchmark register", pmRoot }), /requires --file/);
  await assert.rejects(harness.runCommand({ command: "rl leaderboard", pmRoot }), /requires a benchmark id/);
  const benchmarkId = await benchmark(root, pmRoot, harness);
  await assert.rejects(harness.runCommand({ command: "rl eval record", pmRoot, options: { run: source.run, benchmark: benchmarkId, checkpoint: "sha", score: "NaN", passed: true } }), /finite --score/);
  await assert.rejects(harness.runCommand({ command: "rl eval record", pmRoot, options: { run: source.run, benchmark: benchmarkId, checkpoint: "sha", score: "1", passed: "maybe" } }), /requires --passed true/);

  const result = await evaluation(pmRoot, harness, source.run, benchmarkId, "sha", 1, true);
  const item = await client.get(result.id!, { depth: "deep" });
  const changed = parseEvalResultSpec(fencedJson(item.item.body));
  await client.update(result.id!, {
    body: `# changed\n\n\`\`\`json\n${JSON.stringify({ ...changed, score: 2 }, null, 2)}\n\`\`\``,
    message: "simulate forbidden eval mutation",
  });
  await assert.rejects(
    evaluation(pmRoot, harness, source.run, benchmarkId, "sha", 1, true),
    typedRefusal("eval_result_identity_collision"),
  );
  await assert.rejects(
    harness.runCommand({ command: "rl leaderboard", pmRoot, args: [benchmarkId] }),
    typedRefusal("eval_result_was_mutated"),
  );

  const benchmarkItem = await client.get(benchmarkId, { depth: "deep" });
  const benchmarkSpec = parseBenchmarkSpec(fencedJson(benchmarkItem.item.body));
  await client.update(benchmarkId, {
    body: `# changed\n\n\`\`\`json\n${JSON.stringify({ ...benchmarkSpec, version: "2" }, null, 2)}\n\`\`\``,
    message: "simulate forbidden benchmark mutation",
  });
  await assert.rejects(
    harness.runCommand({ command: "rl leaderboard", pmRoot, args: [benchmarkId] }),
    typedRefusal("benchmark_was_mutated"),
  );
  await assert.rejects(
    harness.runCommand({ command: "rl benchmark register", pmRoot, options: { file: join(root, "benchmark-clean.json") } }),
    typedRefusal("benchmark_was_mutated"),
  );
  assert.notEqual(
    hashJson({ ...benchmarkSpec, version: "2" } as unknown as JsonValue),
    benchmarkItem.item.affected_version,
  );
});

test("benchmark reads refuse missing identities, missing bodies, and contamination graph drift", async () => {
  const { root, pmRoot, client, harness } = await workspace();
  const missingHash = await client.create({ id: "benchmark-no-hash", title: "No hash", type: "Benchmark", status: "open" });
  await assert.rejects(
    harness.runCommand({ command: "rl leaderboard", pmRoot, args: [missingHash.item.id] }),
    typedRefusal("benchmark_missing_hash"),
  );

  const spec: BenchmarkSpec = {
    name: "No Body", version: "1", task_suite: [], scoring_function: "score",
    pass_criteria: { gte: 0 }, direction: "maximize", contaminated_environments: [],
  };
  const specHash = hashJson(spec as unknown as JsonValue);
  const missingBody = await client.create({
    id: `benchmark-no-body-${specHash.slice(0, 12)}`,
    title: "No body",
    type: "Benchmark",
    status: "open",
    affectedVersion: specHash,
    fixedVersion: "1",
    component: "maximize",
  });
  await assert.rejects(
    harness.runCommand({ command: "rl leaderboard", pmRoot, args: [missingBody.item.id] }),
    typedRefusal("benchmark_missing_spec"),
  );

  const source = await sourceRun(root, pmRoot, harness, "1");
  const contaminated = await benchmark(root, pmRoot, harness, source.environment);
  await client.update(contaminated, { clearDeps: true, message: "simulate contamination graph drift" });
  await assert.rejects(
    harness.runCommand({ command: "rl leaderboard", pmRoot, args: [contaminated] }),
    typedRefusal("benchmark_contamination_graph_mismatch"),
  );
});

test("evaluation recording refuses unattributable runs and detects an existing identity collision", async () => {
  const { root, pmRoot, client, harness } = await workspace();
  const benchmarkId = await benchmark(root, pmRoot, harness);
  const unattributed = await client.create({ id: "run-unattributed", title: "Unattributed", type: "Run", status: "in_progress" });
  await assert.rejects(
    harness.runCommand({ command: "rl eval record", pmRoot, options: { run: unattributed.item.id, benchmark: benchmarkId, checkpoint: "sha", score: "1", passed: "true" } }),
    typedRefusal("run_environment_unrecorded"),
  );

  const source = await sourceRun(root, pmRoot, harness, "1");
  const result = await evaluation(pmRoot, harness, source.run, benchmarkId, "sha", 1, true);
  const falseString = resultOf(await harness.runCommand({
    command: "rl eval record",
    pmRoot,
    options: { run: source.run, benchmark: benchmarkId, checkpoint: "sha-false", score: "0", passed: "false" },
  }));
  assert.equal(falseString.details?.passed, false);
  await client.update(result.id!, { affectedVersion: "different", message: "simulate eval identity collision" });
  await assert.rejects(
    harness.runCommand({ command: "rl eval record", pmRoot, options: { run: source.run, benchmark: benchmarkId, checkpoint: "sha", score: "1", passed: "true" } }),
    typedRefusal("eval_result_identity_collision"),
  );
});

test("leaderboard refuses incomplete or ambiguous typed evaluation edges and an unreadable body", async () => {
  for (const mutation of ["run", "benchmark", "all", "extra"] as const) {
    const { pmRoot, client, harness, run, benchmarkId, evalId } = await comparableFixture();
    if (mutation === "all") {
      await client.update(evalId, { clearDeps: true, message: "remove all evaluation edges" });
    } else {
      await client.update(evalId, {
        replaceDeps: true,
        dep: mutation === "run"
          ? [`id=${benchmarkId},kind=verifies,source_kind=pm-rl:eval:benchmark`]
          : mutation === "benchmark"
            ? [`id=${run},kind=discovered_from,source_kind=pm-rl:eval:run`]
            : [
                `id=${run},kind=discovered_from,source_kind=pm-rl:eval:run`,
                `id=${benchmarkId},kind=verifies,source_kind=pm-rl:eval:benchmark`,
                `id=${benchmarkId},kind=discovered_from,source_kind=pm-rl:eval:run`,
              ],
        message: `${mutation} evaluation provenance edge mutation`,
      });
    }
    await assert.rejects(
      harness.runCommand({ command: "rl leaderboard", pmRoot, args: [benchmarkId] }),
      typedRefusal("eval_result_graph_mismatch"),
    );
  }

  const { pmRoot, client, harness, benchmarkId, evalId } = await comparableFixture();
  await client.update(evalId, { body: "no JSON fence", message: "simulate unreadable eval" });
  await assert.rejects(
    harness.runCommand({ command: "rl leaderboard", pmRoot, args: [benchmarkId] }),
    typedRefusal("eval_result_missing_spec"),
  );
});

test("leaderboard refuses missing runs, run graph drift, stale provenance, and typed metadata drift", async () => {
  {
    const { pmRoot, client, harness, environment, benchmarkId, evalId } = await comparableFixture();
    const original = await client.get(evalId, { depth: "deep" });
    const spec = parseEvalResultSpec(fencedJson(original.item.body));
    const issue = await client.create({ id: "wrong-run", title: "Wrong run", type: "Issue", status: "open" });
    const wrong: typeof spec = { ...spec, run_id: issue.item.id };
    const hash = hashJson(wrong as unknown as JsonValue);
    await client.create({
      id: `eval-wrong-run-${hash.slice(0, 12)}`,
      title: "Wrong run eval",
      type: "EvalResult",
      status: "closed",
      closeReason: "fixture",
      completedAt: new Date().toISOString(),
      body: `\`\`\`json\n${JSON.stringify(wrong, null, 2)}\n\`\`\``,
      dep: [
        `id=${issue.item.id},kind=discovered_from,source_kind=pm-rl:eval:run`,
        `id=${benchmarkId},kind=verifies,source_kind=pm-rl:eval:benchmark`,
      ],
      environment,
      affectedVersion: hash,
      fixedVersion: wrong.checkpoint,
      component: benchmarkId,
    });
    await assert.rejects(harness.runCommand({ command: "rl leaderboard", pmRoot, args: [benchmarkId] }), typedRefusal("eval_result_graph_mismatch"));
  }

  {
    const { pmRoot, client, harness, environment, benchmarkId, evalId } = await comparableFixture();
    const original = await client.get(evalId, { depth: "deep" });
    const spec = parseEvalResultSpec(fencedJson(original.item.body));
    const run = await client.create({ id: "run-without-edge", title: "Run without edge", type: "Run", status: "in_progress", environment });
    const wrong: typeof spec = { ...spec, run_id: run.item.id };
    const hash = hashJson(wrong as unknown as JsonValue);
    await client.create({
      id: `eval-run-graph-${hash.slice(0, 12)}`,
      title: "Run graph drift eval",
      type: "EvalResult",
      status: "closed",
      closeReason: "fixture",
      completedAt: new Date().toISOString(),
      body: `\`\`\`json\n${JSON.stringify(wrong, null, 2)}\n\`\`\``,
      dep: [
        `id=${run.item.id},kind=discovered_from,source_kind=pm-rl:eval:run`,
        `id=${benchmarkId},kind=verifies,source_kind=pm-rl:eval:benchmark`,
      ],
      environment,
      affectedVersion: hash,
      fixedVersion: wrong.checkpoint,
      component: benchmarkId,
    });
    await assert.rejects(harness.runCommand({ command: "rl leaderboard", pmRoot, args: [benchmarkId] }), typedRefusal("eval_result_graph_mismatch"));
  }

  {
    const { pmRoot, client, harness, environment, run, benchmarkId, evalId } = await comparableFixture();
    const original = await client.get(evalId, { depth: "deep" });
    const spec = parseEvalResultSpec(fencedJson(original.item.body));
    const stale: typeof spec = { ...spec, checkpoint: "stale", reward_spec_hash: "stale-reward" };
    const hash = hashJson(stale as unknown as JsonValue);
    await client.create({
      id: `eval-stale-${hash.slice(0, 12)}`,
      title: "Stale provenance eval",
      type: "EvalResult",
      status: "closed",
      closeReason: "fixture",
      completedAt: new Date().toISOString(),
      body: `\`\`\`json\n${JSON.stringify(stale, null, 2)}\n\`\`\``,
      dep: [
        `id=${run},kind=discovered_from,source_kind=pm-rl:eval:run`,
        `id=${benchmarkId},kind=verifies,source_kind=pm-rl:eval:benchmark`,
      ],
      environment,
      affectedVersion: hash,
      fixedVersion: stale.checkpoint,
      component: benchmarkId,
    });
    await assert.rejects(harness.runCommand({ command: "rl leaderboard", pmRoot, args: [benchmarkId] }), typedRefusal("eval_result_provenance_mismatch"));
  }

  {
    const { pmRoot, client, harness, benchmarkId, evalId } = await comparableFixture();
    await client.update(evalId, { fixedVersion: "different", message: "simulate typed metadata drift" });
    await assert.rejects(harness.runCommand({ command: "rl leaderboard", pmRoot, args: [benchmarkId] }), typedRefusal("eval_result_metadata_mismatch"));
  }
});
