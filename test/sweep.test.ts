/** Sweep planning: a declared space expanded into independent child-run arms, merged across branches. */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { PmClient } from "@unbrained/pm-cli/sdk/core";
import { EXIT_CODE, init, isPmCliExpectedError } from "@unbrained/pm-cli/sdk/runtime";
import { createExtensionTestHarness, type ExtensionTestHarness } from "@unbrained/pm-cli/sdk/testing";

import extension, { removePlannedArms, RL_ITEM_TYPES, type RlCommandResult } from "../index.ts";
import {
  buildSweepStatus,
  expandSearchSpace,
  MAX_SWEEP_ARMS,
  parseSelectionRule,
  parseSweepSpec,
  renderSweepStatus,
  SELECTION_RULE_KINDS,
  type SweepSpec,
} from "../sweep.ts";

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

/** Assert a refusal carries an explicit typed code and conflict exit. */
function typedRefusal(code: string) {
  return (error: unknown): boolean => isPmCliExpectedError(error) && error.exitCode === EXIT_CODE.CONFLICT && String((error as { context?: { code?: string } }).context?.code) === code;
}

/** Assert an item does not resolve: the host's not-found exit. */
function typedNotFound(error: unknown): boolean {
  return isPmCliExpectedError(error) && error.exitCode === EXIT_CODE.NOT_FOUND;
}

/** Assert a usage-input refusal carries its typed code on the usage exit. */
function typedUsage(code: string) {
  return (error: unknown): boolean => isPmCliExpectedError(error) && error.exitCode === EXIT_CODE.USAGE && String((error as { context?: { code?: string } }).context?.code) === code;
}

/** Representative environment fixture. */
const ENV_SPEC = {
  name: "Grid World",
  version: "3",
  task_suite: ["reach-goal"],
  reward_specification: { goal: 10 },
};

/** Write one search-space file. */
function writeSpace(root: string, space: unknown, filename = "space.json"): string {
  const path = join(root, filename);
  writeFileSync(path, JSON.stringify(space));
  return path;
}

/** Create a real initialized tracker and activate the extension through the host. */
async function workspace(): Promise<{
  root: string;
  pmRoot: string;
  harness: Awaited<ReturnType<typeof createExtensionTestHarness>>;
  client: PmClient;
}> {
  const root = mkdtempSync(join(tmpdir(), "pm-rl-sweep-"));
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
  return { root, pmRoot: initialized.path, harness, client };
}

/** Register one shared environment and return its resolved id. */
async function registerEnv(root: string, pmRoot: string, harness: ExtensionTestHarness): Promise<string> {
  const envFile = join(root, "environment.json");
  writeFileSync(envFile, JSON.stringify(ENV_SPEC));
  return resultOf(await harness.runCommand({ command: "rl env register", pmRoot, options: { file: envFile } })).id!;
}

test("search-space expansion is the deterministic cartesian product in sorted key order", () => {
  assert.deepEqual(expandSearchSpace({ lr: [0.1, 0.01], batch: [32] }), [
    { batch: 32, lr: 0.1 },
    { batch: 32, lr: 0.01 },
  ]);
  assert.deepEqual(expandSearchSpace({}), []);
  assert.deepEqual(expandSearchSpace({ optimizer: ["adam"] }), [{ optimizer: "adam" }]);
  assert.throws(() => expandSearchSpace({ lr: [] }), typedUsage("invalid_search_space"));
});

test("selection rules support exactly max_final, min_final over a metric, or none", () => {
  assert.deepEqual(parseSelectionRule("none"), { kind: "none" });
  assert.deepEqual(parseSelectionRule("max_final:episode_return"), { kind: "max_final", metric: "episode_return" });
  assert.deepEqual(parseSelectionRule("min_final:loss"), { kind: "min_final", metric: "loss" });
  assert.deepEqual([...SELECTION_RULE_KINDS].sort(), ["max_final", "min_final"].sort());
  for (const bad of ["best_guess", "max_final:", ":metric", "max_final:has spaces", "MAX_FINAL:x"]) {
    assert.throws(() => parseSelectionRule(bad), typedUsage("invalid_selection_rule"), bad);
  }
});

test("search-space expansion refuses a cartesian product beyond the sweep arm cap", () => {
  const values = [0, 1, 2, 3];
  // Exactly at the cap still expands.
  assert.equal(expandSearchSpace({ a: values, b: values, c: values }).length, MAX_SWEEP_ARMS);
  // One dimension past it refuses with the typed code before growing further:
  // planning writes one arm per host call sequentially, so an unbounded product
  // would mean unbounded sequential work.
  assert.throws(() => expandSearchSpace({ a: values, b: values, c: values, d: values }), (error: unknown): boolean => {
    if (!typedUsage("search_space_too_large")(error)) return false;
    assert.match(String((error as Error).message), /expands to 256 arms; the cap is /);
    return true;
  });
  // A single dimension with a huge candidate array is refused BEFORE the
  // intermediate product is materialized: the projected size is known
  // arithmetically (products.length * values.length), so no allocation
  // precedes the refusal.
  assert.throws(
    () => expandSearchSpace({ lr: Array.from({ length: MAX_SWEEP_ARMS + 1 }, (_, index) => index) }),
    typedUsage("search_space_too_large"),
  );
});

test("a stored sweep specification is validated field by field", () => {
  const spec: SweepSpec = {
    search_space: { lr: [0.1, 0.01] },
    selection_rule: { kind: "max_final", metric: "episode_return" },
    algorithm: "PPO",
    environment_id: "env-x",
    environment_spec_hash: "hash-x",
    arms: [{ id: "sweep-a-arm-1", config: { lr: 0.1 } }],
  };
  assert.deepEqual(parseSweepSpec(JSON.stringify(spec)), spec);
  assert.throws(() => parseSweepSpec(JSON.stringify({ ...spec, arms: [] })), typedRefusal("invalid_sweep_arms"));
  assert.throws(() => parseSweepSpec(JSON.stringify({ ...spec, algorithm: "" })), typedRefusal("invalid_sweep_algorithm"));
  assert.throws(() => parseSweepSpec(JSON.stringify({ ...spec, environment_id: "" })), typedRefusal("invalid_sweep_environment_id"));
  assert.throws(() => parseSweepSpec(JSON.stringify({ ...spec, search_space: {} })), typedRefusal("invalid_sweep_search_space"));
  assert.throws(() => parseSweepSpec(JSON.stringify({ ...spec, selection_rule: { kind: "argmax" } })), typedRefusal("invalid_selection_rule"));
});

test("a stored sweep specification refuses malformed JSON, objects, and arm entries", () => {
  const spec: SweepSpec = {
    search_space: { lr: [0.1] },
    selection_rule: { kind: "none" },
    algorithm: "PPO",
    environment_id: "env-x",
    environment_spec_hash: "hash-x",
    arms: [{ id: "a", config: {} }],
  };
  assert.throws(() => parseSweepSpec("not-json"), typedRefusal("invalid_sweep_json"));
  // A non-object payload is refused by the shared JSON guard's own code.
  assert.throws(() => parseSweepSpec("[]"), typedRefusal("invalid_json_object"));
  assert.throws(() => parseSweepSpec(JSON.stringify({ ...spec, algorithm: 3 })), typedRefusal("invalid_sweep_algorithm"));
  assert.throws(() => parseSweepSpec(JSON.stringify({ ...spec, environment_spec_hash: "" })), typedRefusal("invalid_sweep_environment_spec_hash"));
  assert.throws(() => parseSweepSpec(JSON.stringify({ ...spec, search_space: [1] })), typedRefusal("invalid_sweep_search_space"));
  assert.throws(() => parseSweepSpec(JSON.stringify({ ...spec, search_space: { lr: "fast" } })), typedRefusal("invalid_sweep_search_space"));
  assert.throws(() => parseSweepSpec(JSON.stringify({ ...spec, search_space: { lr: [] } })), typedRefusal("invalid_sweep_search_space"));
  assert.throws(() => parseSweepSpec(JSON.stringify({ ...spec, selection_rule: 7 })), typedRefusal("invalid_selection_rule"));
  assert.throws(() => parseSweepSpec(JSON.stringify({ ...spec, selection_rule: { kind: "max_final" } })), typedRefusal("invalid_selection_rule"));
  assert.throws(() => parseSweepSpec(JSON.stringify({ ...spec, selection_rule: { kind: "argmax", metric: "x" } })), typedRefusal("invalid_selection_rule"));
  assert.throws(() => parseSweepSpec(JSON.stringify({ ...spec, arms: "three" })), typedRefusal("invalid_sweep_arms"));
  assert.throws(() => parseSweepSpec(JSON.stringify({ ...spec, arms: ["a"] })), typedRefusal("invalid_sweep_arms"));
  assert.throws(() => parseSweepSpec(JSON.stringify({ ...spec, arms: [{ id: "  ", config: {} }] })), typedRefusal("invalid_sweep_arms"));
  // An array is not a configuration object, even though typeof [] === "object".
  assert.throws(() => parseSweepSpec(JSON.stringify({ ...spec, arms: [{ id: "a", config: [] }] })), typedRefusal("invalid_sweep_arms"));
});

test("status computes the verdict only when the selection rule supports one, stating why otherwise", () => {
  const arms = (values: Array<number | null>) =>
    values.map((value, index) => ({
      id: `sweep-a-arm-${index + 1}`,
      config: { lr: index },
      status: "in_progress",
      metric_events: 3,
      last_step: 9,
      final_value: value,
    }));

  // A supported rule with data names the winner per direction, ties broken deterministically.
  const max = buildSweepStatus({ kind: "max_final", metric: "episode_return" }, arms([4.0, 7.5, 7.5]));
  assert.equal(max.selection_metric, "episode_return");
  assert.match(max.winner!, /arm-2/);
  assert.match(max.winner_reason!, /tied/);

  const min = buildSweepStatus({ kind: "min_final", metric: "loss" }, arms([0.2, 0.6]));
  assert.match(min.winner!, /arm-1/);

  // A tie under min_final is broken and stated the same way.
  const minTie = buildSweepStatus({ kind: "min_final", metric: "loss" }, arms([0.3, 0.3]));
  assert.match(minTie.winner!, /arm-1/);
  assert.match(minTie.winner_reason!, /tied/);

  // The rule declares no winner: data exists, and status still reports none.
  const none = buildSweepStatus({ kind: "none" }, arms([4.0, 9.0]));
  assert.equal(none.winner, null);
  assert.match(none.winner_reason!, /declares no winner/);

  // No arm has measured the selection metric yet: no winner is invented.
  const unmeasured = buildSweepStatus({ kind: "max_final", metric: "bleu" }, arms([null, null]));
  assert.equal(unmeasured.winner, null);
  assert.match(unmeasured.winner_reason!, /no arm has measured "bleu"/);

  const rendered = renderSweepStatus({ ...max, sweep: "sweep-a" });
  assert.match(rendered, /sweep-a \| rule: max_final:episode_return/);
  assert.match(rendered, /winner: /);
  const renderedNone = renderSweepStatus({ ...none, sweep: "sweep-a" });
  assert.match(renderedNone, /winner: none \(the selection rule declares no winner\)/);
});

test("plan expands the declared space into child runs carrying each arm's hyperparameters", async () => {
  const { root, pmRoot, harness, client } = await workspace();
  const environment = await registerEnv(root, pmRoot, harness);
  const planned = resultOf(await harness.runCommand({
    command: "rl sweep plan",
    pmRoot,
    args: ["sweep-lr"],
    options: {
      file: writeSpace(root, { search_space: { lr: [0.1, 0.01], batch: [64] }, selection_rule: "max_final:episode_return" }),
      environment,
      algorithm: "PPO",
    },
  }));
  assert.equal(planned.action, "rl-sweep-plan");
  // The host scopes created ids under its alias, so the reported sweep id is
  // the RESOLVED id ("rl-sweep-lr"), not the raw requested argument.
  assert.equal(planned.id, "rl-sweep-lr");
  assert.deepEqual(planned.details?.arms, ["rl-sweep-lr-arm-1", "rl-sweep-lr-arm-2"]);

  // Each child is an ordinary Run whose configuration IS the arm's hyperparameters.
  for (const [armId, lr] of [["rl-sweep-lr-arm-1", 0.1], ["rl-sweep-lr-arm-2", 0.01]] as const) {
    const shown = resultOf(await harness.runCommand({ command: "rl run show", pmRoot, args: [armId] }));
    assert.equal(shown.action, "rl-run-show");
    const stored = await client.get(armId, { depth: "deep" });
    assert.match(String(stored.item.body), new RegExp(`"lr": ${lr}`));
    assert.equal(stored.item.environment, environment);
  }

  // Re-planning the same sweep refuses on the sweep id itself.
  await assert.rejects(
    harness.runCommand({
      command: "rl sweep plan",
      pmRoot,
      args: ["sweep-lr"],
      options: {
        file: writeSpace(root, { search_space: { lr: [0.1] }, selection_rule: "none" }, "again.json"),
        environment,
        algorithm: "PPO",
      },
    }),
    typedRefusal("sweep_exists"),
  );

  // A stray arm without its owning sweep is caught by the arm pre-check.
  await client.create({ id: "rl-sweep-stray-arm-1", title: "stray", type: "Run", status: "in_progress", environment, affectedVersion: "h", fixedVersion: "c", component: "PPO" });
  await assert.rejects(
    harness.runCommand({
      command: "rl sweep plan",
      pmRoot,
      args: ["sweep-stray"],
      options: {
        file: writeSpace(root, { search_space: { lr: [0.1] }, selection_rule: "none" }, "stray.json"),
        environment,
        algorithm: "PPO",
      },
    }),
    typedRefusal("sweep_arm_exists"),
  );

  // A no-winner rule plans fine and reports its kind in the receipt.
  const plannedNone = resultOf(await harness.runCommand({
    command: "rl sweep plan",
    pmRoot,
    args: ["sweep-observe"],
    options: {
      file: writeSpace(root, { search_space: { lr: [0.5, 0.05] }, selection_rule: "none" }, "observe.json"),
      environment,
      algorithm: "DQN",
    },
  }));
  assert.equal(plannedNone.details?.selection_rule, "none");

  // An invalid selection rule is refused before anything is written.
  await assert.rejects(
    harness.runCommand({
      command: "rl sweep plan",
      pmRoot,
      args: ["sweep-bad"],
      options: {
        file: writeSpace(root, { search_space: { lr: [0.1] }, selection_rule: "best" }, "bad.json"),
        environment,
        algorithm: "PPO",
      },
    }),
    typedUsage("invalid_selection_rule"),
  );
});

test("two arms advanced on two branches merge with no conflict, and status reads both", async () => {
  const { root, pmRoot, harness } = await workspace();
  const environment = await registerEnv(root, pmRoot, harness);
  resultOf(await harness.runCommand({
    command: "rl sweep plan",
    pmRoot,
    args: ["sweep-git"],
    options: {
      file: writeSpace(root, { search_space: { lr: [0.1, 0.2] }, selection_rule: "max_final:reward" }),
      environment,
      algorithm: "PPO",
    },
  }));

  execFileSync("git", ["init", "-b", "main"], { cwd: root });
  execFileSync("git", ["config", "user.name", "pm-rl-test"], { cwd: root });
  execFileSync("git", ["config", "user.email", "pm-rl-test@example.invalid"], { cwd: root });
  execFileSync("pm", ["merge", "install"], { cwd: root });
  execFileSync("git", ["add", ".agents", ".gitattributes"], { cwd: root });
  execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-m", "Seed sweep"], { cwd: root });

  const metricsA = join(root, "agent-a.ndjson");
  const metricsB = join(root, "agent-b.ndjson");

  execFileSync("git", ["switch", "-c", "agent-a"], { cwd: root });
  // Two steps of the selection metric on one arm exercise the final-value ordering.
  writeFileSync(metricsA, '{"step":1,"metric":"reward","value":3}\n{"step":6,"metric":"reward","value":5}');
  await harness.runCommand({ command: "rl run log", pmRoot, args: ["rl-sweep-git-arm-1"], options: { file: metricsA } });
  execFileSync("git", ["add", ".agents"], { cwd: root });
  execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-m", "Agent A arm"], { cwd: root });

  execFileSync("git", ["switch", "main"], { cwd: root });
  execFileSync("git", ["switch", "-c", "agent-b"], { cwd: root });
  writeFileSync(metricsB, '{"step":1,"metric":"reward","value":8}');
  await harness.runCommand({ command: "rl run log", pmRoot, args: ["rl-sweep-git-arm-2"], options: { file: metricsB } });
  execFileSync("git", ["add", ".agents"], { cwd: root });
  execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-m", "Agent B arm"], { cwd: root });

  // Both branches advanced independent arms of one sweep; the merge keeps both.
  execFileSync("git", ["switch", "agent-a"], { cwd: root });
  execFileSync("git", ["-c", "commit.gpgsign=false", "merge", "--no-edit", "agent-b"], { cwd: root });

  const status = resultOf(await harness.runCommand({ command: "rl sweep status", pmRoot, args: ["rl-sweep-git"] }));
  assert.equal(status.action, "rl-sweep-status");
  const arms = status.details?.arms as Array<{ id: string; metric_events: number; final_value: number }>;
  assert.deepEqual(arms.map((arm) => arm.id), ["rl-sweep-git-arm-1", "rl-sweep-git-arm-2"]);
  assert.deepEqual(arms.map((arm) => arm.final_value), [5, 8]);
  assert.match(String(status.details?.winner), /arm-2/);
});

test("planning refuses malformed space files before anything is written", async () => {
  const { root, pmRoot, harness, client } = await workspace();
  const environment = await registerEnv(root, pmRoot, harness);
  const plan = async (id: string, content: unknown, filename: string): Promise<unknown> =>
    harness.runCommand({
      command: "rl sweep plan",
      pmRoot,
      args: [id],
      options: { file: writeSpace(root, content, filename), environment, algorithm: "PPO" },
    });
  await assert.rejects(plan("sweep-array", [1, 2], "array.json"), typedUsage("invalid_search_space_file"));
  await assert.rejects(plan("sweep-nospace", { selection_rule: "none" }, "nospace.json"), typedUsage("invalid_search_space"));
  await assert.rejects(plan("sweep-norule", { search_space: { lr: [1] } }, "norule.json"), typedUsage("invalid_selection_rule"));
  await assert.rejects(plan("sweep-empty", { search_space: {}, selection_rule: "none" }, "empty.json"), typedUsage("invalid_search_space"));
  // An over-large space refuses on the cap rather than planning unbounded arms.
  const fourValues = [0, 1, 2, 3];
  await assert.rejects(
    plan("sweep-huge", { search_space: { a: fourValues, b: fourValues, c: fourValues, d: fourValues }, selection_rule: "none" }, "huge.json"),
    typedUsage("search_space_too_large"),
  );
  // Each refusal happened before any write: neither the sweep nor an arm exists.
  for (const id of ["sweep-array", "sweep-nospace", "sweep-norule", "sweep-empty", "sweep-huge"]) {
    await assert.rejects(client.get(`rl-${id}`, {}), typedNotFound, `${id} must not be written by a refused plan`);
    await assert.rejects(client.get(`rl-${id}-arm-1`, {}), typedNotFound, `${id} arm must not be written by a refused plan`);
  }
});

test("status renders unmeasured arms and a no-winner rule in table form without inventing a verdict", async () => {
  const { root, pmRoot, harness } = await workspace();
  const environment = await registerEnv(root, pmRoot, harness);
  await harness.runCommand({
    command: "rl sweep plan",
    pmRoot,
    args: ["sweep-fresh"],
    options: {
      file: writeSpace(root, { search_space: { lr: [0.3, 0.03] }, selection_rule: "none" }, "fresh.json"),
      environment,
      algorithm: "DQN",
    },
  });
  // One arm logs several steps of a metric; the other stays silent.
  const metricsFile = join(root, "fresh.ndjson");
  writeFileSync(metricsFile, '{"step":1,"metric":"reward","value":2}\n{"step":5,"metric":"reward","value":9}\n{"step":2,"metric":"loss","value":0.4}');
  await harness.runCommand({ command: "rl run log", pmRoot, args: ["rl-sweep-fresh-arm-1"], options: { file: metricsFile } });
  const table = resultOf(await harness.runCommand({
    command: "rl sweep status",
    pmRoot,
    args: ["rl-sweep-fresh"],
    global: { json: false },
  }));
  assert.equal(table.details?.format, "table");
  assert.equal(table.details?.winner, null);
  assert.match(table.details?.winner_reason as string, /declares no winner/);
  const output = String(table.details?.output);
  assert.match(output, /rl-sweep-fresh \| rule: none \| 2 arm\(s\)/);
  assert.match(output, /rl-sweep-fresh-arm-1 \| in_progress \| events=3 \| last_step=5 \| selection=-/);
  assert.match(output, /last_step=- \| selection=-/);
  assert.match(output, /winner: none \(the selection rule declares no winner\)/);
});

test("planning refuses an existing sweep id even when its arms are gone, and cleans up on mid-plan failure", async () => {
  const { root, pmRoot, harness, client } = await workspace();
  const environment = await registerEnv(root, pmRoot, harness);
  // A sweep whose arm runs do not exist (hand-authored owner) must not be
  // re-armed under an owner that already exists.
  await client.create({ id: "sweep-orphan-owner", title: "owner only", type: "Sweep", status: "open", body: "no fence needed for this test" });
  await assert.rejects(
    harness.runCommand({
      command: "rl sweep plan",
      pmRoot,
      args: ["sweep-orphan-owner"],
      options: {
        file: writeSpace(root, { search_space: { lr: [0.1] }, selection_rule: "none" }, "orphan.json"),
        environment,
        algorithm: "PPO",
      },
    }),
    typedRefusal("sweep_exists"),
  );

  // An injected mid-write failure removes every arm the invocation already
  // wrote, leaving nothing behind for a retry to trip over.
  let createCalls = 0;
  const failing = new Proxy(client, {
    get(target, property, receiver) {
      if (property === "create") {
        return async (options?: unknown) => {
          createCalls += 1;
          if (createCalls >= 2) throw new Error("injected host failure on second create");
          const delegated = (Reflect.get(target, "create", receiver) as (...a: unknown[]) => Promise<unknown>).bind(target);
          return delegated(options);
        };
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? (value as (...arguments_: unknown[]) => unknown).bind(target) : value;
    },
  }) as PmClient;
  // The harness captures a non-pm error into errorMessage rather than rejecting;
  // only pm expected errors propagate as rejections.
  const failed = await harness.runCommand({
    command: "rl sweep plan",
    pmRoot,
    args: ["sweep-flaky"],
    options: {
      file: writeSpace(root, { search_space: { lr: [0.3, 0.03], batch: [16, 32] }, selection_rule: "none" }, "flaky.json"),
      environment,
      algorithm: "PPO",
    },
    sdk: sdkWith(failing),
  });
  assert.equal(failed.handled, false);
  assert.match(String(failed.errorMessage), /injected host failure/);
  // Every arm the invocation managed to write was removed before the error
  // surfaced: nothing is left for a retry to trip over.
  for (const armId of ["rl-sweep-flaky-arm-1", "rl-sweep-flaky-arm-2", "rl-sweep-flaky-arm-3", "rl-sweep-flaky-arm-4"]) {
    await assert.rejects(client.get(armId, {}), typedNotFound, `${armId} must not survive a failed plan`);
  }
  await assert.rejects(client.get("rl-sweep-flaky", {}), typedNotFound);

  // A failure on the FINAL create — the Sweep item after every arm succeeded —
  // removes the arms too: a retry under the same id would otherwise hit the arm
  // pre-check and could never complete.
  let lateCreateCalls = 0;
  const failingLate = new Proxy(client, {
    get(target, property, receiver) {
      if (property === "create") {
        return async (options?: unknown) => {
          lateCreateCalls += 1;
          // Four arm creates succeed; the fifth create (the Sweep) fails.
          if (lateCreateCalls >= 5) throw new Error("injected host failure on sweep create");
          const delegated = (Reflect.get(target, "create", receiver) as (...a: unknown[]) => Promise<unknown>).bind(target);
          return delegated(options);
        };
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? (value as (...arguments_: unknown[]) => unknown).bind(target) : value;
    },
  }) as PmClient;
  const failedLate = await harness.runCommand({
    command: "rl sweep plan",
    pmRoot,
    args: ["sweep-late-fail"],
    options: {
      file: writeSpace(root, { search_space: { lr: [0.3, 0.03], batch: [16, 32] }, selection_rule: "none" }, "late-fail.json"),
      environment,
      algorithm: "PPO",
    },
    sdk: sdkWith(failingLate),
  });
  assert.equal(failedLate.handled, false);
  assert.match(String(failedLate.errorMessage), /injected host failure on sweep create/);
  for (const armId of ["rl-sweep-late-fail-arm-1", "rl-sweep-late-fail-arm-2", "rl-sweep-late-fail-arm-3", "rl-sweep-late-fail-arm-4"]) {
    await assert.rejects(client.get(armId, {}), typedNotFound, `${armId} must not survive a failed sweep create`);
  }
  await assert.rejects(client.get("rl-sweep-late-fail", {}), typedNotFound);

  // The sweep id is not wedged: a retry under the same id now succeeds because
  // no arm and no Sweep survived the failed create. Without the cleanup the
  // retry would hit the arm pre-check (sweep_arm_exists) and could never finish.
  const retriedLate = resultOf(await harness.runCommand({
    command: "rl sweep plan",
    pmRoot,
    args: ["sweep-late-fail"],
    options: {
      file: writeSpace(root, { search_space: { lr: [0.3, 0.03], batch: [16, 32] }, selection_rule: "none" }, "late-fail-retry.json"),
      environment,
      algorithm: "PPO",
    },
  }));
  assert.equal(retriedLate.action, "rl-sweep-plan");
  assert.deepEqual(retriedLate.details?.arms, ["rl-sweep-late-fail-arm-1", "rl-sweep-late-fail-arm-2", "rl-sweep-late-fail-arm-3", "rl-sweep-late-fail-arm-4"]);

  // A cleanup that itself cannot remove the arm is refused with BOTH causes
  // named — the removal failure first, the original create failure second.
  // Only the delete trap matters here: removePlannedArms never calls create.
  const failingWorse = new Proxy(client, {
    get(target, property, receiver) {
      if (property === "delete") {
        return async () => { throw new Error("injected removal failure"); };
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? (value as (...arguments_: unknown[]) => unknown).bind(target) : value;
    },
  }) as PmClient;
  await assert.rejects(
    removePlannedArms(failingWorse, [{ id: "rl-sweep-worse-arm-1" }], new Error("injected host failure on second create")),
    (error: unknown): boolean => {
      if (!isPmCliExpectedError(error) || String((error as { context?: { code?: string } }).context?.code) !== "sweep_cleanup_failed") return false;
      const message = String(error.message ?? error);
      assert.match(message, /injected removal failure/, "the removal cause is named first");
      assert.match(message, /injected host failure/, "and the original create cause is not lost");
      return true;
    },
  );
});

test("status refuses a missing sweep and a hand-authored body without a specification fence", async () => {
  const { root, pmRoot, harness, client } = await workspace();
  await assert.rejects(
    harness.runCommand({ command: "rl sweep status", pmRoot, args: ["sweep-nowhere"] }),
    (error: unknown): boolean => isPmCliExpectedError(error) && error.exitCode === EXIT_CODE.NOT_FOUND,
  );
  await client.create({ id: "sweep-bare", title: "hand authored", type: "Sweep", status: "open", body: "no fence" });
  await assert.rejects(
    harness.runCommand({ command: "rl sweep status", pmRoot, args: ["sweep-bare"] }),
    typedRefusal("sweep_unreadable"),
  );
});
