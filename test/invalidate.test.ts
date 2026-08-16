/** Transitive result invalidation: the directed walk over stored dependency edges. */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { PmClient } from "@unbrained/pm-cli/sdk/core";
import { createPmCliExpectedError, EXIT_CODE, init, isPmCliExpectedError } from "@unbrained/pm-cli/sdk/runtime";
import { createExtensionTestHarness, type ExtensionTestHarness } from "@unbrained/pm-cli/sdk/testing";

import extension, { RL_ITEM_TYPES, type RlCommandResult } from "../index.ts";
import { renderInvalidateReport, transitiveInvalidation, type InvalidationEntry, type ItemDependencyEdge } from "../invalidate.ts";

const roots: string[] = [];

after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

/** Extract a successful structured command result, failing loudly on an unhandled command. */
function resultOf(run: { result?: unknown; handled: boolean }): RlCommandResult {
  assert.equal(run.handled, true, JSON.stringify(run));
  return run.result as RlCommandResult;
}

/** A host SDK whose client is the given real client; the production commands read only `context.sdk.client`. */
type HostSdk = NonNullable<Parameters<ExtensionTestHarness["runCommand"]>[0]["sdk"]>;
function sdkWith(client: PmClient): HostSdk {
  return { client } as unknown as HostSdk;
}

/**
 * Assert a command refusal carries an explicit typed code and conflict exit.
 *
 * The package's contract is that its refusals are typed, not prose: the code is
 * what a recursive loop branches on, so a test that only matched the message
 * would let a refactor rename the code silently.
 */
function typedRefusal(code: string) {
  return (error: unknown): boolean => isPmCliExpectedError(error) && error.exitCode === EXIT_CODE.CONFLICT && String((error as { context?: { code?: string } }).context?.code) === code;
}

/** The runtime's own expected-error shape, pinned so typed refusals stay recognizable. */
test("createPmCliExpectedError carries the typed code refusals branch on", () => {
  const error = createPmCliExpectedError("refused", { exitCode: 4, context: { code: "some_code" } });
  assert.equal(isPmCliExpectedError(error), true);
  assert.deepEqual((error as { context?: { code?: string } }).context, { code: "some_code" });
});

/** Directed reachability over stored edges: multi-hop paths, cycles, dangling targets, non-results. */
test("transitiveInvalidation walks dependents directionally with paths, cycles and dangling edges", () => {
  const items: ItemDependencyEdge[] = [
    { id: "env-1", type: "Environment", targets: [] },
    { id: "run-1", type: "Run", targets: ["env-1"] },
    { id: "run-2", type: "Run", targets: ["env-1"] },
    { id: "gen-1", type: "Generation", targets: ["run-1"] },
    { id: "task-1", type: "Task", targets: ["run-1"] },
    { id: "eval-1", type: "EvalResult", targets: ["run-1"] },
    { id: "transfer-1", type: "Transfer", targets: ["env-1", "env-2"] },
    // A second environment version whose own runs do NOT derive from env-1: the
    // undirected host blast-radius walk would cross transfer-1 into them.
    { id: "env-2", type: "Environment", targets: [] },
    { id: "run-3", type: "Run", targets: ["env-2"] },
    // A dangling target named by a real item resolves to nothing and adds no result.
    { id: "run-dangling", type: "Run", targets: ["env-nowhere"] },
    // A dependency cycle reachable from env-1 through run-1.
    { id: "cyc-a", type: "Run", targets: ["run-1", "cyc-b"] },
    { id: "cyc-b", type: "Run", targets: ["cyc-a"] },
  ];
  const entries = transitiveInvalidation("env-1", items);
  assert.deepEqual(entries.map((entry) => entry.id), ["cyc-a", "cyc-b", "eval-1", "run-1", "run-2", "transfer-1"]);
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  assert.deepEqual(byId.get("run-1")!.path, ["env-1", "run-1"]);
  assert.deepEqual(byId.get("eval-1")!.path, ["env-1", "run-1", "eval-1"]);
  assert.equal(byId.get("eval-1")!.distance, 2);
  assert.deepEqual(byId.get("cyc-a")!.path, ["env-1", "run-1", "cyc-a"]);
  // run-3 depends on env-2, and transfer-1 depends on BOTH environments: data
  // flows from env-1 into the transfer, never from the transfer back out into
  // env-2's own runs. Only transfer-1 (which depends on env-1) is invalidated.
  assert.equal(byId.has("run-3"), false);
  assert.equal(byId.has("gen-1"), false, "a Generation on the path is invalidated but is not a reported result");
  assert.equal(byId.has("task-1"), false);
  // A dangling target named by a real item is never followed outward — no item
  // sits at its far end — so it creates no path through the graph. As a ROOT it
  // does have dependents in the edge data (run-dangling depends on it), and the
  // command refuses that root at its item read before the walk ever runs.
  const danglingRoot = transitiveInvalidation("env-nowhere", items);
  assert.deepEqual(danglingRoot.map((entry) => entry.id), ["run-dangling"]);
  assert.deepEqual(danglingRoot[0]!.path, ["env-nowhere", "run-dangling"]);
  // The dangling edge from env-1's subtree never reaches run-dangling.
  assert.equal(byId.has("run-dangling"), false);
  // A root with no dependents at all reports nothing, and the root is never
  // reported as invalidating itself.
  assert.deepEqual(transitiveInvalidation("run-2", items), []);
});

/** The report renders the header, one line per result, and the reaching path. */
test("renderInvalidateReport renders the header, one line per result, and the reaching path", () => {
  const entries: InvalidationEntry[] = [
    { id: "eval-a", type: "EvalResult", distance: 2, path: ["env-1", "run-a", "eval-a"] },
    { id: "run-a", type: "Run", distance: 1, path: ["env-1", "run-a"] },
  ];
  const rendered = renderInvalidateReport("env-1", "Environment", entries);
  assert.equal(rendered.split("\n")[0], "env-1 (Environment) invalidates 2 tracked result(s):");
  assert.match(rendered, /eval-a \| EvalResult \| 2 hop\(s\) \| reached by env-1 → run-a → eval-a/);
  assert.equal(renderInvalidateReport("env-2", "Environment", []).split("\n").length, 1);
});

/**
 * A real tracker whose dependency graph pm itself stores.
 *
 * Environments are registered through the real `rl env register` command (three
 * generations of versions, each a changed reward specification), runs through
 * `rl run start` and `rl run log`, and the benchmark, eval results, transfers,
 * cycle, dangling edge and non-result affected item through the real PmClient
 * `create` action with `dep` edges — the same storage path the CLI's `pm create
 * --dep` drives. Nothing here hand-writes graph objects the command could only
 * have produced itself.
 */
async function graphFixture(): Promise<{
  pmRoot: string;
  env1: string;
  env2: string;
  env3: string;
  env4: string;
  run1: string;
  run2: string;
  run3: string;
  run4: string;
  bench: string;
  eval1: string;
  eval2: string;
  eval3: string;
  transfer1: string;
  client: PmClient;
  harness: ExtensionTestHarness;
}> {
  const root = mkdtempSync(join(tmpdir(), "pm-rl-invalidate-"));
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
  // The result types this query reports are fixture-registered here rather than
  // shipped by pm-rl: registering them belongs to their own roadmap slices, and
  // the invalidation query is deliberately a derived query over whatever typed
  // graph the workspace already has.
  for (const [name, folder] of [["Benchmark", "benchmarks"], ["EvalResult", "evals"], ["Transfer", "transfers"]] as const) {
    await client.schemaAddType(name, { folder, description: `pm-rl test ${name}`, defaultStatus: "open" });
  }
  const harness = await createExtensionTestHarness(extension, { name: "pm-rl", capabilities: ["commands", "schema"] });
  assert.deepEqual(harness.activation.failed, []);

  const env1 = resultOf(await harness.runCommand({ command: "rl env register", pmRoot: initialized.path, options: { file: writeEnv(root, "1", 10) } })).id!;
  const env2 = resultOf(await harness.runCommand({ command: "rl env register", pmRoot: initialized.path, options: { file: writeEnv(root, "2", 20) } })).id!;
  const env3 = resultOf(await harness.runCommand({ command: "rl env register", pmRoot: initialized.path, options: { file: writeEnv(root, "3", 30) } })).id!;
  const env4 = resultOf(await harness.runCommand({ command: "rl env register", pmRoot: initialized.path, options: { file: writeEnv(root, "4", 40) } })).id!;

  const startRun = async (id: string, environment: string, config: Record<string, unknown>): Promise<string> => {
    const configFile = join(root, `${id}-config.json`);
    writeFileSync(configFile, JSON.stringify(config));
    const metrics = join(root, `${id}-metrics.ndjson`);
    writeFileSync(metrics, '{"step":0,"metric":"episode_return","value":1}\n{"step":1,"metric":"loss","value":0.5}\n');
    const started = resultOf(await harness.runCommand({
      command: "rl run start",
      pmRoot: initialized.path,
      args: [id],
      options: { environment, algorithm: "PPO", configFile },
    })).id!;
    await harness.runCommand({ command: "rl run log", pmRoot: initialized.path, args: [started], options: { file: metrics } });
    return started;
  };

  const run1 = await startRun("run-1", env1, { learning_rate: 0.1 });
  const run2 = await startRun("run-2", env1, { learning_rate: 0.2 });
  const run3 = await startRun("run-3", env2, { learning_rate: 0.1 });
  const run4 = await startRun("run-4", env3, { learning_rate: 0.1 });

  const bench = String((await client.create({ id: "bench-v1", title: "benchmark v1", type: "Benchmark", status: "open" })).item.id);
  const eval1 = String((await client.create({ id: "eval-1", title: "eval 1", type: "EvalResult", status: "open", dep: [run1, bench] })).item.id);
  const eval2 = String((await client.create({ id: "eval-2", title: "eval 2", type: "EvalResult", status: "open", dep: [run2, bench] })).item.id);
  const eval3 = String((await client.create({ id: "eval-3", title: "eval 3", type: "EvalResult", status: "open", dep: [run3, bench] })).item.id);
  const transfer1 = String((await client.create({ id: "transfer-1", title: "sim to real", type: "Transfer", status: "open", dep: [env1, env2] })).item.id);
  // An affected item that is NOT a result: the walk reaches it, the report must not list it.
  await client.create({ id: "task-1", title: "downstream chore", type: "Task", status: "open", dep: [run1] });
  // A dangling dependency target: pm's `--dep` accepts ids that resolve to nothing.
  await client.create({ id: "run-dangling", title: "run against a missing env", type: "Run", status: "in_progress", dep: ["env-nowhere"] });
  // A dependency cycle reachable from env3: the walk must terminate and still
  // return the exact set, once per item. cyc-a's edge to cyc-b dangles at create
  // time and resolves once cyc-b exists, which is exactly how `pm update --dep`
  // can produce cycles — it accepts ids that do not resolve yet.
  const cycA = String((await client.create({ id: "run-cyc-a", title: "cycle a", type: "Run", status: "in_progress", dep: ["rl-run-cyc-b"] })).item.id);
  const cycB = String((await client.create({ id: "run-cyc-b", title: "cycle b", type: "Run", status: "in_progress", dep: [cycA, env3] })).item.id);
  assert.equal(cycA, "rl-run-cyc-a");
  assert.equal(cycB, "rl-run-cyc-b");

  return {
    pmRoot: initialized.path,
    env1,
    env2,
    env3,
    env4,
    run1,
    run2,
    run3,
    run4,
    bench,
    eval1,
    eval2,
    eval3,
    transfer1,
    client,
    harness,
  };
}

/** Write one environment version file with its own reward specification. */
function writeEnv(root: string, version: string, goal: number): string {
  const path = join(root, `env-v${version}.json`);
  writeFileSync(path, JSON.stringify({
    name: "Grid World",
    version,
    task_suite: ["reach-goal"],
    reward_specification: { goal },
  }));
  return path;
}

test("invalidating one environment version returns exactly its transitive results with their paths", async () => {
  const fixture = await graphFixture();
  const result = resultOf(await fixture.harness.runCommand({ command: "rl invalidate", pmRoot: fixture.pmRoot, args: [fixture.env1] }));
  assert.equal(result.action, "rl-invalidate");
  assert.equal(result.id, fixture.env1);
  assert.equal(result.details?.format, "json");
  assert.equal(result.details?.root_type, "Environment");
  const invalidated = result.details?.invalidated as InvalidationEntry[];
  // Exactly the v1 subtree: its two runs, the eval results on those runs, and
  // the transfer that depends on v1 directly. Not run-3/eval-3 (v2's subtree —
  // the transfer's second environment does not make them derive from v1), not
  // task-1 (affected but not a result), not run-dangling (dangling edge).
  assert.deepEqual(invalidated.map((entry) => entry.id), [fixture.eval1, fixture.eval2, fixture.run1, fixture.run2, fixture.transfer1]);
  assert.deepEqual(invalidated.map((entry) => entry.type), ["EvalResult", "EvalResult", "Run", "Run", "Transfer"]);
  const byId = new Map(invalidated.map((entry) => [entry.id, entry]));
  assert.deepEqual(byId.get(fixture.run1)!.path, [fixture.env1, fixture.run1]);
  assert.equal(byId.get(fixture.run1)!.distance, 1);
  assert.deepEqual(byId.get(fixture.eval1)!.path, [fixture.env1, fixture.run1, fixture.eval1]);
  assert.equal(byId.get(fixture.eval1)!.distance, 2);
  assert.deepEqual(byId.get(fixture.transfer1)!.path, [fixture.env1, fixture.transfer1]);
});

test("invalidating the second environment version returns its own subtree and the shared transfer", async () => {
  const fixture = await graphFixture();
  const result = resultOf(await fixture.harness.runCommand({ command: "rl invalidate", pmRoot: fixture.pmRoot, args: [fixture.env2] }));
  const invalidated = result.details?.invalidated as InvalidationEntry[];
  assert.deepEqual(invalidated.map((entry) => entry.id), [fixture.eval3, fixture.run3, fixture.transfer1]);
});

test("invalidating an environment whose dependents form a cycle terminates with the exact set", async () => {
  const fixture = await graphFixture();
  const result = resultOf(await fixture.harness.runCommand({ command: "rl invalidate", pmRoot: fixture.pmRoot, args: [fixture.env3] }));
  const invalidated = result.details?.invalidated as InvalidationEntry[];
  const cycA = invalidated.find((entry) => entry.id.endsWith("run-cyc-a"))!;
  const cycB = invalidated.find((entry) => entry.id.endsWith("run-cyc-b"))!;
  assert.ok(cycA !== undefined && cycB !== undefined, "both cycle members appear exactly once");
  assert.deepEqual(invalidated.map((entry) => entry.id).sort(), [cycA.id, cycB.id, fixture.run4].sort());
  // Each is reached through the shortest path into the cycle.
  assert.deepEqual(cycB.path, [fixture.env3, cycB.id]);
  assert.deepEqual(cycA.path, [fixture.env3, cycB.id, cycA.id]);
});

test("invalidating a benchmark returns only results that depend on it, never their runs", async () => {
  const fixture = await graphFixture();
  const result = resultOf(await fixture.harness.runCommand({ command: "rl invalidate", pmRoot: fixture.pmRoot, args: [fixture.bench] }));
  assert.equal(result.details?.root_type, "Benchmark");
  const invalidated = result.details?.invalidated as InvalidationEntry[];
  assert.deepEqual(invalidated.map((entry) => entry.id), [fixture.eval1, fixture.eval2, fixture.eval3]);
  assert.ok(invalidated.every((entry) => entry.type === "EvalResult"));
  assert.deepEqual((invalidated[0] as InvalidationEntry).path, [fixture.bench, fixture.eval1]);
});

test("an environment with no dependents invalidates nothing, and the table path renders the header alone", async () => {
  const fixture = await graphFixture();
  const result = resultOf(await fixture.harness.runCommand({ command: "rl invalidate", pmRoot: fixture.pmRoot, args: [fixture.env4] }));
  assert.equal(result.details?.count, 0);
  assert.deepEqual(result.details?.invalidated, []);
  // The harness defaults ctx.global.json to true; opting out exercises the
  // host-owned --json global flag the command reads but never registers.
  const table = resultOf(await fixture.harness.runCommand({
    command: "rl invalidate",
    pmRoot: fixture.pmRoot,
    args: [fixture.env1],
    global: { json: false },
  }));
  assert.equal(table.details?.format, "table");
  const output = String(table.details?.output);
  assert.match(output, /invalidates 5 tracked result\(s\)/);
  assert.match(output, new RegExp(`${fixture.run1} \\| Run \\| 1 hop\\(s\\) \\| reached by ${fixture.env1} → ${fixture.run1}`));
  // The json path carries no rendered table text.
  assert.equal(result.details?.output, undefined);
});

test("invalidate refuses roots that are neither environments nor benchmarks, and dangling ids stay not found", async () => {
  const fixture = await graphFixture();
  await assert.rejects(
    fixture.harness.runCommand({ command: "rl invalidate", pmRoot: fixture.pmRoot, args: [fixture.run1] }),
    typedRefusal("wrong_invalidation_root"),
  );
  // A dangling dependency target resolves to no item, so the read refuses with
  // the host's not-found exit rather than an empty invalidation set.
  await assert.rejects(
    fixture.harness.runCommand({ command: "rl invalidate", pmRoot: fixture.pmRoot, args: ["env-nowhere"] }),
    (error: unknown): boolean => isPmCliExpectedError(error) && error.exitCode === EXIT_CODE.NOT_FOUND,
  );
});

test("the inventory walk skips a listed row the SDK types without an id", async () => {
  const fixture = await graphFixture();
  // A real client whose list results carry one id-less row: the SDK types a
  // listed item's id as optional, and the production guard that skips it must
  // run against the exact shape it exists to defend.
  const augmented = new Proxy(fixture.client, {
    get(target, property, receiver) {
      if (property === "list") {
        const delegated = target.list.bind(target) as (options?: unknown) => ReturnType<PmClient["list"]>;
        return (options?: unknown) => {
          const result = delegated(options);
          const record = options as { fields?: string } | undefined;
          if (record?.fields !== "id,type,dependencies") return result;
          return result.then((value) => {
            const envelope = value as { items?: readonly unknown[] };
            return { ...value, items: [...(envelope.items ?? []), { title: "idless-row", type: "Run", status: "in_progress" }] };
          }) as ReturnType<PmClient["list"]>;
        };
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? (value as (...arguments_: unknown[]) => unknown).bind(target) : value;
    },
  }) as PmClient;
  const result = resultOf(await fixture.harness.runCommand({
    command: "rl invalidate",
    pmRoot: fixture.pmRoot,
    args: [fixture.env1],
    sdk: sdkWith(augmented),
  }));
  const invalidated = result.details?.invalidated as InvalidationEntry[];
  // The id-less row contributes no edge and no result; the exact v1 set stands.
  assert.deepEqual(invalidated.map((entry) => entry.id), [fixture.eval1, fixture.eval2, fixture.run1, fixture.run2, fixture.transfer1]);
});
