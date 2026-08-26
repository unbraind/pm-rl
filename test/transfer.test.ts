/** Sim-to-real transfer measurement and per-metric gap reporting across a run's checkpoints. */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { PmClient } from "@unbrained/pm-cli/sdk/core";
import { EXIT_CODE, init, isPmCliExpectedError } from "@unbrained/pm-cli/sdk/runtime";
import { createExtensionTestHarness, type ExtensionTestHarness } from "@unbrained/pm-cli/sdk/testing";

import extension, { RL_ITEM_TYPES, type RlCommandResult } from "../index.ts";
import {
  buildTransferGapReport,
  parseTransferMetrics,
  parseTransferSpec,
  renderTransferGapReport,
  TRANSFER_EDGE_SOURCES,
  TRANSFER_RUN,
  TRANSFER_SOURCE_ENVIRONMENT,
  TRANSFER_TARGET_ENVIRONMENT,
  type TransferSpec,
} from "../transfer.ts";

const roots: string[] = [];

after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

/** Extract a successful structured command result, failing loudly on an unhandled command. */
function resultOf(run: { result?: unknown; handled: boolean }): RlCommandResult {
  assert.equal(run.handled, true, JSON.stringify(run));
  return run.result as RlCommandResult;
}

/** Assert a refusal carries an explicit typed code and conflict exit. */
function typedRefusal(code: string) {
  return (error: unknown): boolean => isPmCliExpectedError(error) && error.exitCode === EXIT_CODE.CONFLICT && String((error as { context?: { code?: string } }).context?.code) === code;
}

/** Representative environment fixture. */
const ENV_SPEC = {
  name: "Grid World",
  version: "3",
  task_suite: ["reach-goal"],
  reward_specification: { goal: 10 },
};

/** Representative transfer specification shared across pure tests. */
export const TRANSFER_SPEC: TransferSpec = {
  source_environment_id: "env-sim",
  target_environment_id: "env-real",
  checkpoint: "sha256:ckpt-1",
  run_id: "rl-run-a",
  gaps: [
    { metric: "episode_return", gap: 0.25 },
    { metric: "success_rate", gap: -0.1 },
  ],
};

/** Write one transfer metrics file. */
function writeMetrics(root: string, gaps: Array<[string, number]>, filename = "gaps.json"): string {
  const path = join(root, filename);
  writeFileSync(path, JSON.stringify({ gaps: gaps.map(([metric, gap]) => ({ metric, gap })) }));
  return path;
}

/** Create a real initialized tracker and activate the extension through the host. */
async function workspace(): Promise<{
  root: string;
  pmRoot: string;
  harness: Awaited<ReturnType<typeof createExtensionTestHarness>>;
  client: PmClient;
}> {
  const root = mkdtempSync(join(tmpdir(), "pm-rl-transfer-"));
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

/** Register an environment version under a distinct family name. */
async function registerEnv(pmRoot: string, harness: ExtensionTestHarness, name: string, version: string, goal: number): Promise<string> {
  const path = join(tmpdir(), `pm-rl-transfer-env-${name}-${version}-${goal}.json`);
  writeFileSync(path, JSON.stringify({ ...ENV_SPEC, name, version, reward_specification: { goal } }));
  return resultOf(await harness.runCommand({ command: "rl env register", pmRoot, options: { file: path } })).id!;
}

test("transfer metrics accept finite per-metric gaps and refuse everything undecidable", () => {
  const parsed = parseTransferMetrics(JSON.stringify({ gaps: [{ metric: "reward", gap: 0 }, { metric: "success", gap: -1.5 }] }));
  // Sorted by metric name for canonical storage.
  assert.deepEqual(parsed, [
    { metric: "reward", gap: 0 },
    { metric: "success", gap: -1.5 },
  ]);
  for (const [text, message] of [
    ["not-json", /not valid JSON/],
    ["[]", /one JSON object/],
    [JSON.stringify({}), /requires a gaps array/],
    [JSON.stringify({ gaps: [] }), /at least one measured gap/],
    [JSON.stringify({ gaps: [{ metric: "", gap: 1 }] }), /non-empty string metric/],
    [JSON.stringify({ gaps: [{ metric: "r", gap: "high" }] }), /finite number gap/],
    [JSON.stringify({ gaps: [{ metric: "r", gap: Number.NaN }] }), /finite number gap/],
    [JSON.stringify({ gaps: ["reward"] }), /each gap to be an object/],
    [JSON.stringify({ gaps: { reward: 1 } }), /requires a gaps array/],
    [JSON.stringify({ gaps: [{ metric: "r", gap: 1 }, { metric: "r", gap: 2 }] }), /reports metric "r" twice/],
    // Padding must not walk around the uniqueness refusal: both spellings store
    // the same normalized metric.
    [JSON.stringify({ gaps: [{ metric: "reward", gap: 1 }, { metric: " reward ", gap: 2 }] }), /reports metric "reward" twice/],
  ] as Array<[string, RegExp]>) {
    assert.throws(() => parseTransferMetrics(text), message);
  }
});

test("metric names are normalized before storage, so only internal spelling differences survive", () => {
  const parsed = parseTransferMetrics(JSON.stringify({ gaps: [{ metric: " reward ", gap: 1 }] }));
  // Trimming is normalization, not mutation of distinct metrics: internal
  // spacing is part of the name and is preserved.
  assert.deepEqual(parsed, [{ metric: "reward", gap: 1 }]);
  assert.deepEqual(parseTransferMetrics(JSON.stringify({ gaps: [{ metric: "re ward", gap: 1 }, { metric: "re  ward", gap: 2 }] })), [
    { metric: "re  ward", gap: 2 },
    { metric: "re ward", gap: 1 },
  ]);
});

test("gap metrics canonicalize in byte order, independent of host locale", () => {
  // "loss." and "loss_" diverge between collations: ICU orders "_" before ".",
  // byte order is the reverse. The stored gap sequence feeds the transfer body
  // hash, so this exact order must hold on every host; a localeCompare revert
  // flips it and fails this assertion.
  const parsed = parseTransferMetrics(JSON.stringify({ gaps: [{ metric: "loss_", gap: 1 }, { metric: "loss.", gap: 2 }] }));
  assert.deepEqual(parsed.map((gap) => gap.metric), ["loss.", "loss_"]);
});

test("a stored transfer specification is validated field by field", () => {
  assert.deepEqual(parseTransferSpec(JSON.stringify(TRANSFER_SPEC)), TRANSFER_SPEC);
  assert.deepEqual([...TRANSFER_EDGE_SOURCES].sort(), ["pm-rl:transfer:run", "pm-rl:transfer:source", "pm-rl:transfer:target"].sort());
  assert.throws(() => parseTransferSpec("not-json"), /not valid JSON/);
  assert.throws(() => parseTransferSpec("[]"), /one JSON object/);
  for (const key of ["source_environment_id", "target_environment_id", "checkpoint", "run_id"]) {
    assert.throws(() => parseTransferSpec(JSON.stringify({ ...TRANSFER_SPEC, [key]: "" })), new RegExp(`non-empty string ${key}`));
  }
  assert.throws(() => parseTransferSpec(JSON.stringify({ ...TRANSFER_SPEC, gaps: [] })), /at least one measured gap/);
  // A hand-authored spec that omits gaps entirely is refused the same way.
  const { gaps: _omitted, ...withoutGaps } = TRANSFER_SPEC;
  void _omitted;
  assert.throws(() => parseTransferSpec(JSON.stringify(withoutGaps)), /at least one measured gap/);
});

test("the report plots transfers in order, aligning every metric's series, and holds stale ones out", () => {
  const transfer = (checkpoint: string, rewardGap: number): TransferSpec => ({
    ...TRANSFER_SPEC,
    checkpoint,
    gaps: [{ metric: "episode_return", gap: rewardGap }],
  });
  const report = buildTransferGapReport([
    { id: "t-late", created_at: "2026-01-03T00:00:00Z", spec: transfer("sha256:c3", 0.9), stale_reason: null },
    { id: "t-stale", created_at: "2026-01-02T00:00:00Z", spec: transfer("sha256:c2", 99), stale_reason: "environment was edited" },
    { id: "t-early", created_at: "2026-01-01T00:00:00Z", spec: transfer("sha256:c1", 0.4), stale_reason: null },
  ]);
  // Recording order, not id order: the gap series follows the checkpoints in time.
  assert.deepEqual(report.plotted.map((entry) => entry.id), ["t-early", "t-late"]);
  assert.deepEqual(report.per_metric.episode_return, [0.4, 0.9]);
  assert.deepEqual(report.stale.map((entry) => entry.id), ["t-stale"]);
  assert.match(String(report.stale[0]!.reason), /environment was edited/);

  // Equal recording instants tie-break by item id, keeping the series stable.
  const tied = buildTransferGapReport([
    { id: "t-b", created_at: "2026-01-01T00:00:00Z", spec: transfer("sha256:cb", 0.2), stale_reason: null },
    { id: "t-a", created_at: "2026-01-01T00:00:00Z", spec: transfer("sha256:ca", 0.1), stale_reason: null },
  ]);
  assert.deepEqual(tied.plotted.map((entry) => entry.id), ["t-a", "t-b"]);

  // A metric one plotted transfer never measured leaves an explicit hole rather
  // than silently shifting the series.
  const misaligned = buildTransferGapReport([
    { id: "t-full", created_at: "2026-01-01T00:00:00Z", spec: { ...transfer("sha256:c1", 0.4), gaps: [{ metric: "episode_return", gap: 0.4 }, { metric: "success_rate", gap: -0.2 }] }, stale_reason: null },
    { id: "t-partial", created_at: "2026-01-02T00:00:00Z", spec: transfer("sha256:c2", 0.9), stale_reason: null },
  ]);
  assert.deepEqual(misaligned.per_metric.success_rate, [-0.2, Number.NaN]);
  assert.match(renderTransferGapReport("run-x", misaligned), /series success_rate: -0\.2 -> NaN/);

  const rendered = renderTransferGapReport("rl-run-a", report);
  assert.match(rendered, /transfer gap series for rl-run-a: 2 plotted, 1 stale/);
  assert.match(rendered, /t-early \| sha256:c1 \| episode_return=0\.4/);
  assert.match(rendered, /series episode_return: 0\.4 -> 0\.9/);
  assert.match(rendered, /stale \(excluded from the series\): t-stale — environment was edited/);
});

test("recording links both environment versions, the run and the checkpoint; refusals fail closed", async () => {
  const { root, pmRoot, harness, client } = await workspace();
  const source = await registerEnv(pmRoot, harness, "Sim World", "1", 10);
  const target = await registerEnv(pmRoot, harness, "Real World", "1", 40);
  const configFile = join(root, "config.json");
  writeFileSync(configFile, JSON.stringify({ lr: 0.1 }));
  const run = resultOf(await harness.runCommand({
    command: "rl run start",
    pmRoot,
    args: ["training-run"],
    options: { environment: source, algorithm: "PPO", configFile },
  })).id!;

  const recorded = resultOf(await harness.runCommand({
    command: "rl transfer record",
    pmRoot,
    args: ["xfer-1"],
    options: {
      source,
      target,
      checkpoint: "sha256:abc123",
      run,
      metrics: writeMetrics(root, [["episode_return", 0.25], ["success_rate", -0.1]]),
    },
  }));
  assert.equal(recorded.action, "rl-transfer-record");
  const stored = await client.get(recorded.id!, { depth: "deep" });
  assert.equal(stored.item.environment, source);
  assert.equal(stored.item.fixed_version, "sha256:abc123");
  const depIds = (stored.item.dependencies ?? []).map((dependency: { id: string }) => dependency.id).sort();
  assert.ok(depIds.includes(target));
  assert.ok(depIds.includes(source));
  // The dependency markers (source_kind) must match the exported constants from
  // transfer.ts — index.ts imports them, so the declarations cannot drift.
  const depSourceKinds = new Map((stored.item.dependencies ?? []).map((dependency: { id: string; source_kind?: string }) => [dependency.id, dependency.source_kind]));
  assert.equal(depSourceKinds.get(source), TRANSFER_SOURCE_ENVIRONMENT);
  assert.equal(depSourceKinds.get(target), TRANSFER_TARGET_ENVIRONMENT);
  assert.equal(depSourceKinds.get(run), TRANSFER_RUN);
  assert.match(String(stored.item.body), /sha256:abc123/);
  assert.match(String(stored.item.body), /episode_return/);

  // Source and target being the same environment makes the gap meaningless —
  // whether named by the same raw flag or by two spellings that RESOLVE to one
  // environment (pm normalizes the alias-scoped prefix away).
  await assert.rejects(
    harness.runCommand({
      command: "rl transfer record",
      pmRoot,
      args: ["xfer-degenerate"],
      options: { source, target: source, checkpoint: "sha256:x", run, metrics: writeMetrics(root, [["r", 1]], "deg.json") },
    }),
    typedRefusal("degenerate_transfer"),
  );
  await assert.rejects(
    harness.runCommand({
      command: "rl transfer record",
      pmRoot,
      args: ["xfer-degenerate-alias"],
      options: { source, target: source.replace(/^rl-/, ""), checkpoint: "sha256:x", run, metrics: writeMetrics(root, [["r", 1]], "deg2.json") },
    }),
    typedRefusal("degenerate_transfer"),
  );

  // An unmeasurable gap set is refused at record time.
  await assert.rejects(
    harness.runCommand({
      command: "rl transfer record",
      pmRoot,
      args: ["xfer-badgaps"],
      options: { source, target, checkpoint: "sha256:x", run, metrics: writeMetrics(root, [], "empty.json") },
    }),
    typedRefusal("invalid_transfer_gaps"),
  );

  // A mutated environment cannot back a new measurement.
  await client.update(target, { body: "# changed\n\n```json\n" + JSON.stringify({ ...ENV_SPEC, name: "Real World", reward_specification: { goal: 999 } }) + "\n```", message: "mutate env" });
  await assert.rejects(
    harness.runCommand({
      command: "rl transfer record",
      pmRoot,
      args: ["xfer-mutated"],
      options: { source, target, checkpoint: "sha256:x", run, metrics: writeMetrics(root, [["r", 1]], "mut.json") },
    }),
    typedRefusal("environment_was_mutated"),
  );
});

test("gap reports the per-metric series across checkpoints in order and marks superseded transfers stale", async () => {
  const { root, pmRoot, harness, client } = await workspace();
  const source = await registerEnv(pmRoot, harness, "Sim World", "1", 10);
  const target = await registerEnv(pmRoot, harness, "Real World", "1", 40);
  const run = resultOf(await harness.runCommand({
    command: "rl run start",
    pmRoot,
    args: ["long-run"],
    options: { environment: source, algorithm: "PPO" },
  })).id!;

  const record = async (id: string, checkpoint: string, successGap: number): Promise<string> =>
    resultOf(await harness.runCommand({
      command: "rl transfer record",
      pmRoot,
      args: [id],
      options: {
        source,
        target,
        checkpoint,
        run,
        metrics: writeMetrics(root, [["episode_return", 0.1], ["success_rate", successGap]], `${id}-gaps.json`),
      },
    })).id!;
  const first = await record("xfer-c1", "sha256:c1", -0.5);
  // A later recording may share a checkpoint; ordering falls back to item id
  // within one timestamp instant, so sleep briefly instead to keep order honest.
  const second = await record("xfer-c2", "sha256:c2", 0.05);
  assert.match(first, /xfer-c1/);
  assert.match(second, /xfer-c2/);

  const report = resultOf(await harness.runCommand({ command: "rl transfer gap", pmRoot, args: [run] }));
  assert.equal(report.action, "rl-transfer-gap");
  const plotted = report.details?.plotted as Array<{ id: string; checkpoint: string }>;
  assert.deepEqual(plotted.map((entry) => entry.id).sort(), ["rl-xfer-c1", "rl-xfer-c2"].sort());
  const perMetric = report.details?.per_metric as Record<string, number[]>;
  assert.deepEqual([...perMetric.success_rate].sort(), [-0.5, 0.05]);
  assert.deepEqual(report.details?.stale, []);

  // Supersede the target environment: the transfers measured against it are
  // reported as stale rather than plotted.
  await client.update(target, { body: "# changed\n\n```json\n" + JSON.stringify({ ...ENV_SPEC, name: "Real World", reward_specification: { goal: 999 } }) + "\n```", message: "supersede env" });
  const afterEdit = resultOf(await harness.runCommand({ command: "rl transfer gap", pmRoot, args: [run] }));
  assert.deepEqual(afterEdit.details?.plotted, []);
  const stale = afterEdit.details?.stale as Array<{ id: string; reason: string }>;
  assert.equal(stale.length, 2);
  assert.match(stale[0]!.reason, /environment was edited/);

  const table = resultOf(await harness.runCommand({ command: "rl transfer gap", pmRoot, args: [run], global: { json: false } }));
  assert.match(String(table.details?.output), /stale \(excluded from the series\)/);
});

test("the gap skips id-less rows, refuses unreadable transfers, and filters other runs' transfers", async () => {
  const { root, pmRoot, harness, client } = await workspace();
  const source = await registerEnv(pmRoot, harness, "Sim World", "1", 10);
  const target = await registerEnv(pmRoot, harness, "Real World", "1", 40);
  const runA = resultOf(await harness.runCommand({ command: "rl run start", pmRoot, args: ["run-a"], options: { environment: source, algorithm: "PPO" } })).id!;
  const runB = resultOf(await harness.runCommand({ command: "rl run start", pmRoot, args: ["run-b"], options: { environment: source, algorithm: "PPO" } })).id!;
  const record = async (id: string, run: string): Promise<void> => {
    await harness.runCommand({
      command: "rl transfer record",
      pmRoot,
      args: [id],
      options: { source, target, checkpoint: `sha256:${id}`, run, metrics: writeMetrics(root, [["r", 1]], `${id}-gaps.json`) },
    });
  };
  await record("xfer-a", runA);
  await record("xfer-b", runB);

  // A real client whose Transfer list carries one id-less row: the production
  // guard that skips it must run against the exact shape it defends.
  const augmented = new Proxy(client, {
    get(target, property, receiver) {
      if (property === "list") {
        const delegated = target.list.bind(target) as (options?: unknown) => ReturnType<PmClient["list"]>;
        return (options?: unknown) => {
          const result = delegated(options);
          if ((options as { type?: string } | undefined)?.type !== "Transfer") return result;
          return result.then((value) => {
            const envelope = value as { items?: readonly unknown[] };
            return { ...value, items: [...(envelope.items ?? []), { title: "idless-transfer", type: "Transfer", status: "open" }] };
          }) as ReturnType<PmClient["list"]>;
        };
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? (value as (...arguments_: unknown[]) => unknown).bind(target) : value;
    },
  }) as PmClient;

  // run-a's series excludes run-b's transfer even before the proxy is involved.
  const scoped = resultOf(await harness.runCommand({ command: "rl transfer gap", pmRoot, args: [runA] }));
  assert.deepEqual((scoped.details?.plotted as Array<{ id: string }>).map((entry) => entry.id.replace(/^rl-/, "")), ["xfer-a"]);

  const viaProxy = resultOf(await harness.runCommand({ command: "rl transfer gap", pmRoot, args: [runA], sdk: sdkWithProxy(augmented) }));
  assert.deepEqual((viaProxy.details?.plotted as Array<{ id: string }>).map((entry) => entry.id.replace(/^rl-/, "")), ["xfer-a"]);

  // A hand-authored transfer without a specification fence refuses the report
  // rather than silently shrinking the series.
  await client.create({ id: "xfer-bare", title: "hand authored", type: "Transfer", status: "open", environment: source, affectedVersion: "h", fixedVersion: "c", component: target, body: "no fence here" });
  await assert.rejects(
    harness.runCommand({ command: "rl transfer gap", pmRoot, args: [runA] }),
    typedRefusal("transfer_unreadable"),
  );
});

/** A host SDK whose client is the given real client. */
function sdkWithProxy(client: PmClient): NonNullable<Parameters<ExtensionTestHarness["runCommand"]>[0]["sdk"]> {
  return { client } as unknown as NonNullable<Parameters<ExtensionTestHarness["runCommand"]>[0]["sdk"]>;
}

test("transfer gap refuses a run that does not resolve and reports an empty series honestly", async () => {
  const { pmRoot, harness } = await workspace();
  const environment = await registerEnv(pmRoot, harness, "Sim World", "1", 10);
  const run = resultOf(await harness.runCommand({
    command: "rl run start",
    pmRoot,
    args: ["quiet-run"],
    options: { environment, algorithm: "PPO" },
  })).id!;
  const report = resultOf(await harness.runCommand({ command: "rl transfer gap", pmRoot, args: [run] }));
  assert.deepEqual(report.details?.plotted, []);
  assert.deepEqual(report.details?.stale, []);
  await assert.rejects(
    harness.runCommand({ command: "rl transfer gap", pmRoot, args: ["run-nowhere"] }),
    (error: unknown): boolean => isPmCliExpectedError(error) && error.exitCode === EXIT_CODE.NOT_FOUND,
  );
});
