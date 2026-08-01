/** Host-level tests for pm-rl's schema and first environment/run lifecycle. */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { PmClient } from "@unbrained/pm-cli/sdk/core";
import type { CommandHandlerContext } from "@unbrained/pm-cli/sdk/authoring";
import { init } from "@unbrained/pm-cli/sdk/runtime";
import { createExtensionTestHarness } from "@unbrained/pm-cli/sdk/testing";

import extension, {
  canonicalJson,
  hashJson,
  idSegment,
  parseEnvironmentSpec,
  RL_COMMANDS,
  RL_ITEM_TYPES,
  type EnvironmentSpec,
  type JsonValue,
  type RlCommandResult,
} from "../index.ts";

const roots: string[] = [];

after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

/** Create a real initialized tracker and activate the extension through the host. */
async function workspace(): Promise<{
  root: string;
  pmRoot: string;
  harness: Awaited<ReturnType<typeof createExtensionTestHarness>>;
}> {
  const root = mkdtempSync(join(tmpdir(), "pm-rl-test-"));
  roots.push(root);
  const initialized = await init("rl", { defaults: true, author: "pm-rl-test", agentGuidance: "skip" }, { cwd: root });
  // The 2026.8.1 testing harness activates schema registrations in memory but
  // omits the command SDK (#853), so its real-client fallback cannot see those
  // registrations. Materialize the same public schema in this temporary tracker;
  // this is real host state, not a command/API double.
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
  return { root, pmRoot: initialized.path, harness };
}

/** Extract a successful structured command result. */
function resultOf(run: { result?: unknown; handled: boolean }): RlCommandResult {
  assert.equal(run.handled, true, JSON.stringify(run));
  return run.result as RlCommandResult;
}

/** Representative environment fixture shared across lifecycle tests. */
const SPEC: EnvironmentSpec = {
  name: "Grid World",
  version: "3",
  task_suite: ["reach-goal", "avoid-trap"],
  reward_specification: { goal: 10, step: -0.01, trap: -5 },
  action_space: ["up", "down", "left", "right"],
};

test("canonical environment identities ignore object insertion order but preserve array order", () => {
  const left: JsonValue = { z: 1, nested: { b: true, a: null }, list: ["x", "y"] };
  const right: JsonValue = { list: ["x", "y"], nested: { a: null, b: true }, z: 1 };
  assert.equal(canonicalJson(left), canonicalJson(right));
  assert.equal(hashJson(left), hashJson(right));
  assert.notEqual(hashJson(left), hashJson({ ...right, list: ["y", "x"] }));
  assert.equal(canonicalJson("plain"), '"plain"');
  assert.equal(canonicalJson(false), "false");
  assert.equal(canonicalJson(null), "null");
});

test("environment parsing rejects every incomplete or malformed source with an expected error", () => {
  assert.deepEqual(parseEnvironmentSpec(JSON.stringify(SPEC)), SPEC);
  for (const [text, message] of [
    ["not-json", /not valid JSON/],
    ["[]", /one JSON object/],
    [JSON.stringify({ ...SPEC, name: "" }), /non-empty string name/],
    [JSON.stringify({ ...SPEC, version: 4 }), /non-empty string version/],
    [JSON.stringify({ name: "x", version: "1", reward_specification: {} }), /requires task_suite/],
    [JSON.stringify({ name: "x", version: "1", task_suite: [] }), /requires reward_specification/],
  ] as Array<[string, RegExp]>) {
    assert.throws(() => parseEnvironmentSpec(text), message);
  }
  assert.equal(idSegment(" Grid / World v3 "), "grid-world-v3");
  assert.equal(idSegment("***"), "environment");
  assert.equal(idSegment("a".repeat(40)).length, 28);
});

test("the shipped extension activates all commands, item types, fields, and least-privilege capabilities", async () => {
  const { harness } = await workspace();
  for (const command of RL_COMMANDS) harness.assertCommandContract({ name: command.name });
  for (const itemType of RL_ITEM_TYPES) harness.assertItemType({ name: itemType.name });
  assert.deepEqual(harness.assertCapabilityUsage({ declared: ["commands", "schema"] }).unused, []);

  const manifest = JSON.parse(readFileSync(join(import.meta.dirname, "..", "manifest.json"), "utf8")) as {
    name: string;
    version: string;
    entry: string;
    pm_min_version: string;
  };
  const pkg = JSON.parse(readFileSync(join(import.meta.dirname, "..", "package.json"), "utf8")) as {
    name: string;
    version: string;
    peerDependencies: Record<string, string>;
  };
  assert.equal(extension.name, manifest.name);
  assert.equal(extension.version, manifest.version);
  assert.equal(pkg.version, manifest.version);
  assert.equal(manifest.entry, "./dist/index.js");
  assert.equal(manifest.pm_min_version, "2026.8.1");
  assert.equal(pkg.peerDependencies["@unbrained/pm-cli"], ">=2026.8.1");
  await harness.deactivate();
});

test("an environment registers idempotently by canonical content and can be listed and shown", async () => {
  const { root, pmRoot, harness } = await workspace();
  const file = join(root, "grid.json");
  await assert.rejects(
    harness.runCommand({ command: "rl env register", pmRoot, options: { file: join(root, "absent.json") } }),
    /Environment file could not be read/,
  );
  writeFileSync(file, JSON.stringify(SPEC));
  const first = resultOf(await harness.runCommand({ command: "rl env register", pmRoot, options: { file } }));
  assert.equal(first.created, true);
  assert.match(first.id ?? "", /^rl-env-grid-world-3-[0-9a-f]{12}$/);
  const second = resultOf(await harness.runCommand({ command: "rl env register", pmRoot, options: { file } }));
  assert.equal(second.created, false);
  assert.equal(second.id, first.id);

  const listed = resultOf(await harness.runCommand({ command: "rl env list", pmRoot }));
  assert.equal(listed.details?.count, 1);
  const shown = resultOf(await harness.runCommand({ command: "rl env show", pmRoot, args: [first.id!] }));
  assert.equal(shown.details?.version, "3");
  assert.match(String(shown.details?.body), /reward_specification/);
  const updateOptions = { message: "simulate an identity collision", affectedVersion: "different" };
  await new PmClient({ pmRoot, author: "pm-rl-test" }).update(first.id!, updateOptions);
  await assert.rejects(
    harness.runCommand({ command: "rl env register", pmRoot, options: { file } }),
    /already exists with a different specification hash/,
  );
});

test("a real run links exact provenance, appends NDJSON metrics, reads them in step order, and finishes", async () => {
  const { root, pmRoot, harness } = await workspace();
  const environmentFile = join(root, "environment.json");
  const configFile = join(root, "config.json");
  const metricFile = join(root, "metrics.ndjson");
  writeFileSync(environmentFile, JSON.stringify(SPEC));
  writeFileSync(configFile, JSON.stringify({ learning_rate: 0.001, seed: 7 }));
  writeFileSync(metricFile, [
    '{"step":2,"metric":"episode_return","value":8}',
    '{"step":0,"metric":"episode_return","value":1}',
    '{"step":1,"metric":"loss","value":0.5}',
  ].join("\n"));
  const environment = resultOf(await harness.runCommand({ command: "rl env register", pmRoot, options: { file: environmentFile } }));
  const started = resultOf(await harness.runCommand({
    command: "rl run start",
    pmRoot,
    args: ["training-seed-7"],
    options: { environment: environment.id, algorithm: "PPO", configFile },
  }));
  assert.equal(started.created, true);
  assert.equal(started.details?.environment_id, environment.id);

  const logged = resultOf(await harness.runCommand({ command: "rl run log", pmRoot, args: [started.id!], options: { file: metricFile } }));
  // These bounds describe stream arrival order; `show` separately sorts by numeric step.
  assert.equal(logged.details?.appended, 3);
  assert.equal(logged.details?.segments, 1);
  assert.ok(Number(logged.details?.stored_bytes) > 0);
  assert.equal(logged.details?.first_step, 2);
  assert.equal(logged.details?.last_step, 1);
  const shown = resultOf(await harness.runCommand({ command: "rl run show", pmRoot, args: [started.id!] }));
  const events = shown.details?.events as Array<{ step: number }>;
  assert.deepEqual(events.map((event) => event.step), [0, 1, 2]);
  assert.equal(shown.details?.comments, 0);

  const finished = resultOf(await harness.runCommand({ command: "rl run finish", pmRoot, args: [started.id!], options: { reason: "budget exhausted" } }));
  assert.equal(finished.details?.status, "closed");
  await assert.rejects(
    harness.runCommand({ command: "rl run log", pmRoot, args: [started.id!], options: { file: metricFile } }),
    /only an in-progress run accepts metrics/,
  );
});

test("two real Git branches merge independently appended run metrics without loss", async () => {
  const { root, pmRoot, harness } = await workspace();
  const environmentFile = join(root, "environment.json");
  const agentAFile = join(root, "agent-a.ndjson");
  const agentBFile = join(root, "agent-b.ndjson");
  writeFileSync(environmentFile, JSON.stringify(SPEC));
  writeFileSync(agentAFile, '{"step":1,"metric":"reward","value":3}');
  writeFileSync(agentBFile, '{"step":2,"metric":"reward","value":5}');

  execFileSync("git", ["init", "-b", "main"], { cwd: root });
  execFileSync("git", ["config", "user.name", "pm-rl-test"], { cwd: root });
  execFileSync("git", ["config", "user.email", "pm-rl-test@example.invalid"], { cwd: root });
  execFileSync("pm", ["merge", "install"], { cwd: root });
  const environment = resultOf(await harness.runCommand({ command: "rl env register", pmRoot, options: { file: environmentFile } }));
  const run = resultOf(await harness.runCommand({
    command: "rl run start",
    pmRoot,
    args: ["concurrent-sweep"],
    options: { environment: environment.id, algorithm: "PPO" },
  }));
  execFileSync("git", ["add", ".agents", ".gitattributes"], { cwd: root });
  execFileSync("git", ["commit", "-m", "Seed shared run"], { cwd: root });

  execFileSync("git", ["switch", "-c", "agent-a"], { cwd: root });
  const agentA = resultOf(await harness.runCommand({ command: "rl run log", pmRoot, args: [run.id!], options: { file: agentAFile } }));
  assert.equal(agentA.details?.appended, 1);
  execFileSync("git", ["add", ".agents"], { cwd: root });
  execFileSync("git", ["commit", "-m", "Agent A metric"], { cwd: root });

  execFileSync("git", ["switch", "main"], { cwd: root });
  execFileSync("git", ["switch", "-c", "agent-b"], { cwd: root });
  const agentB = resultOf(await harness.runCommand({ command: "rl run log", pmRoot, args: [run.id!], options: { file: agentBFile } }));
  assert.equal(agentB.details?.appended, 1);
  execFileSync("git", ["add", ".agents"], { cwd: root });
  execFileSync("git", ["commit", "-m", "Agent B metric"], { cwd: root });

  execFileSync("git", ["switch", "agent-a"], { cwd: root });
  execFileSync("git", ["merge", "--no-edit", "agent-b"], { cwd: root });
  const shown = resultOf(await harness.runCommand({ command: "rl run show", pmRoot, args: [run.id!] }));
  assert.deepEqual(shown.details?.events, [
    { step: 1, metric: "reward", value: 3 },
    { step: 2, metric: "reward", value: 5 },
  ]);
});

test("a run can use an empty configuration while malformed or missing inputs fail closed", async () => {
  const { root, pmRoot, harness } = await workspace();
  const environmentFile = join(root, "environment.json");
  writeFileSync(environmentFile, JSON.stringify(SPEC));
  const environment = resultOf(await harness.runCommand({ command: "rl env register", pmRoot, options: { file: environmentFile } }));
  const started = resultOf(await harness.runCommand({ command: "rl run start", pmRoot, args: ["empty-config"], options: { environment: environment.id, algorithm: "DQN" } }));
  assert.equal(started.details?.config_hash, hashJson({}));
  await assert.rejects(
    harness.runCommand({ command: "rl run finish", pmRoot, args: [started.id!], options: { reason: "no data" } }),
    /has no metric events and cannot be finished/,
  );

  const invalidConfig = join(root, "bad.json");
  writeFileSync(invalidConfig, "not-json");
  await assert.rejects(
    harness.runCommand({ command: "rl run start", pmRoot, args: ["bad-config"], options: { environment: environment.id, algorithm: "DQN", configFile: invalidConfig } }),
    /not valid JSON/,
  );
  await assert.rejects(
    harness.runCommand({ command: "rl run start", pmRoot, args: ["missing-config"], options: { environment: environment.id, algorithm: "DQN", configFile: join(root, "absent.json") } }),
    /could not be read/,
  );

  const emptyMetrics = join(root, "empty.ndjson");
  writeFileSync(emptyMetrics, "\n");
  await assert.rejects(
    harness.runCommand({ command: "rl run log", pmRoot, args: [started.id!], options: { file: emptyMetrics } }),
    /contains no events/,
  );
  await assert.rejects(
    harness.runCommand({ command: "rl run log", pmRoot, args: [started.id!], options: { file: join(root, "absent.ndjson") } }),
    /could not be read/,
  );
  const stdinDescriptor = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
  Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: true });
  try {
    await assert.rejects(
      harness.runCommand({ command: "rl run log", pmRoot, args: [started.id!] }),
      /requires --file or piped NDJSON/,
    );
  } finally {
    if (stdinDescriptor === undefined) delete (process.stdin as { isTTY?: boolean }).isTTY;
    else Object.defineProperty(process.stdin, "isTTY", stdinDescriptor);
  }
  await assert.rejects(
    harness.runCommand({ command: "rl run log", pmRoot, args: [started.id!] }),
    /Metric input could not be read|contains no events/,
  );

  const client = new PmClient({ pmRoot, author: "pm-rl-test" });
  const incomplete = await client.create({
    id: "incomplete-environment",
    title: "Incomplete environment",
    type: "Environment",
    status: "open",
  });
  await assert.rejects(
    harness.runCommand({ command: "rl run start", pmRoot, args: ["unattributable"], options: { environment: incomplete.item.id, algorithm: "DQN" } }),
    /has no specification affected_version/,
  );

  const malformedOptions = {
    id: "malformed-environment",
    title: "Malformed environment",
    type: "Environment",
    status: "open",
    body: "This body has no JSON fence.",
    message: "seed malformed environment",
    affectedVersion: hashJson(SPEC),
  };
  const malformed = await client.create(malformedOptions);
  await assert.rejects(
    harness.runCommand({ command: "rl run start", pmRoot, args: ["malformed-source"], options: { environment: malformed.item.id, algorithm: "DQN" } }),
    /has no JSON specification fence/,
  );

  const changedSpec: EnvironmentSpec = { ...SPEC, reward_specification: { goal: 100 } };
  await client.update(environment.id!, {
    body: `# changed\n\n\`\`\`json\n${JSON.stringify(changedSpec, null, 2)}\n\`\`\``,
    message: "simulate a forbidden in-place environment mutation",
  });
  await assert.rejects(
    harness.runCommand({ command: "rl run start", pmRoot, args: ["mutated-source"], options: { environment: environment.id, algorithm: "DQN" } }),
    /no longer matches its content-addressed identity/,
  );
});

test("repeated realistic metric batches retain every event with measured bounded history amplification", async (context) => {
  const { root, pmRoot, harness } = await workspace();
  const environmentFile = join(root, "environment.json");
  const metricFile = join(root, "metrics.ndjson");
  writeFileSync(environmentFile, JSON.stringify(SPEC));
  const environment = resultOf(await harness.runCommand({ command: "rl env register", pmRoot, options: { file: environmentFile } }));
  const run = resultOf(await harness.runCommand({ command: "rl run start", pmRoot, args: ["sustained-rate"], options: { environment: environment.id, algorithm: "PPO" } }));
  let canonicalInputBytes = 0;
  let storedSegmentBytes = 0;
  const batches = 40;
  const eventsPerBatch = 250;
  for (let batch = 0; batch < batches; batch += 1) {
    const input = Array.from({ length: eventsPerBatch }, (_value, offset) => JSON.stringify({
      step: batch * eventsPerBatch + offset,
      metric: offset % 10 === 0 ? "episode_return" : "loss",
      value: (batch * eventsPerBatch + offset) / 100,
      tags: { worker: `worker-${batch % 4}` },
    })).join("\n");
    canonicalInputBytes += Buffer.byteLength(input);
    writeFileSync(metricFile, input);
    const logged = resultOf(await harness.runCommand({ command: "rl run log", pmRoot, args: [run.id!], options: { file: metricFile } }));
    assert.equal(logged.details?.appended, eventsPerBatch);
    assert.equal(logged.details?.segments, 1);
    storedSegmentBytes += Number(logged.details?.stored_bytes);
  }
  const shown = resultOf(await harness.runCommand({ command: "rl run show", pmRoot, args: [run.id!] }));
  assert.equal((shown.details?.events as unknown[]).length, batches * eventsPerBatch);
  const historyBytes = statSync(join(pmRoot, "history", `${run.id!}.jsonl`)).size;
  assert.ok(storedSegmentBytes < canonicalInputBytes * 0.2, `${storedSegmentBytes} compressed bytes for ${canonicalInputBytes} input bytes`);
  assert.ok(historyBytes < canonicalInputBytes * 0.7, `${historyBytes} history bytes for ${canonicalInputBytes} input bytes`);
  context.diagnostic(`${batches * eventsPerBatch} events: ${canonicalInputBytes} input bytes, ${storedSegmentBytes} segment bytes, ${historyBytes} total history bytes`);
});

test("domain commands reject missing arguments, options, wrong item types, and absent SDK injection", async () => {
  const { pmRoot, harness } = await workspace();
  await assert.rejects(harness.runCommand({ command: "rl env show", pmRoot }), /requires an environment id/);
  await assert.rejects(harness.runCommand({ command: "rl run finish", pmRoot, args: ["unknown"] }), /requires --reason/);
  const wrong = await new PmClient({ pmRoot, author: "pm-rl-test" }).create({
    id: "wrong-type",
    title: "Not an environment",
    type: "Issue",
    status: "open",
  });
  await assert.rejects(harness.runCommand({ command: "rl env show", pmRoot, args: [wrong.item.id] }), /expected Environment/);
  const listed = resultOf(await harness.runCommand({ command: "rl env list", pmRoot, global: { author: "fallback-test" } }));
  assert.equal(listed.details?.count, 0, "the public real-client fallback must work while the harness omits sdk");
  const command = RL_COMMANDS.find((candidate) => candidate.name === "rl env list");
  assert.ok(command?.run !== undefined);
  const direct = await command.run({ command: "rl env list", args: [], options: {}, global: {}, pm_root: pmRoot }) as RlCommandResult;
  assert.equal(direct.details?.count, 0);
  const client = new PmClient({ pmRoot, author: "injected-test" });
  const injectedSdk = { client } as NonNullable<CommandHandlerContext["sdk"]>;
  const injected = await command.run({ command: "rl env list", args: [], options: {}, global: {}, pm_root: pmRoot, sdk: injectedSdk }) as RlCommandResult;
  assert.equal(injected.details?.count, 0);
});
