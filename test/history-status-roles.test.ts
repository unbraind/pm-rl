/** Pinned SDK status roles, historical projection compatibility and plain-directory dataset consumers. */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { PmClient } from "@unbrained/pm-cli/sdk/core";
import { init, normalizeStatusInput, readSettings } from "@unbrained/pm-cli/sdk/runtime";
import { resolveRuntimeStatusRegistry, type PmSettings } from "@unbrained/pm-cli/sdk";
import { committedTrackerStatusRegistry, historyBlobs, trackerHistoryExample, trackerTreePaths } from "../dataset.ts";
import { buildImproverDataset, projectImproverHistory, readImproverDataset, readImproverTasks, IMPROVER_ROLES } from "../improver-data.ts";
import { withTrackerSources, git } from "./fixtures/meta-workspace.ts";

/** Keep creation features fixed while varying the terminal spelling and duration. */
function history(index: number, opened: string, ended: string): string {
  const start = 1_700_000_000_000 + index * 86_400_000;
  return [
    { ts: new Date(start).toISOString(), op: "create", patch: [{ path: "/metadata/status", value: opened }, { path: "/metadata/type", value: index % 2 ? "Task" : "Issue" }, { path: "/metadata/title", value: "Synthetic creation features" }] },
    ...Array.from({ length: index % 5 }, (_, offset) => ({ ts: new Date(start + 100 + offset).toISOString(), op: "update", patch: [{ path: "/metadata/status", value: "in_progress" }] })),
    { ts: new Date(start + (index % 2 ? 60_000 : 10_000)).toISOString(), op: "update", patch: [{ path: "/metadata/status", value: ended }] },
  ].map((event) => JSON.stringify(event)).join("\n");
}

test("configured in-progress status projects without an active role", () => {
  const defaults = resolveRuntimeStatusRegistry({} as PmSettings["schema"]);
  const registry = resolveRuntimeStatusRegistry({ statuses: [...defaults.definitions, { id: "doing", roles: [], aliases: ["working"] }], workflow: { in_progress_status: "doing" } } as unknown as PmSettings["schema"]);
  assert.equal(registry.active_statuses.has("doing"), false);
  assert.equal(registry.in_progress_status, "doing");
  for (const status of ["doing", " WORKING "]) {
    assert.deepEqual(trackerHistoryExample(history(0, status, "closed"), "public/pm-fixture", "pin", "item", registry)!.prefix, ["in_progress"]);
  }
});

test("committed workflow files pin role-less lifecycle statuses in every SDK container", async () => {
  await withTrackerSources(async ({ directories }) => {
    const pmRoot = directories[0]; const root = dirname(dirname(pmRoot));
    await init("roles", { defaults: true, agentGuidance: "skip", author: "status-test" }, { cwd: root, pmRoot });
    const settings = await readSettings(pmRoot);
    settings.schema.statuses.push({ id: "triage", roles: [], aliases: [] }, { id: "doing", roles: [], aliases: [] });
    const workflow = { open_status: "triage", in_progress_status: "doing" };
    for (const [index, value] of [workflow, { workflow }, { workflows: workflow }].entries()) {
      const file = ["schema/workflows.json", "schema/workflows-ä.json", "schema/workflows\nline.json"][index];
      settings.schema.files.workflows = file;
      writeFileSync(join(pmRoot, "settings.json"), JSON.stringify(settings));
      writeFileSync(join(pmRoot, file), JSON.stringify(value));
      git(root, ["add", ".agents/pm/settings.json", `.agents/pm/${file}`]);
      git(root, ["-c", "user.name=Public Fixture", "-c", "user.email=public@example.test", "commit", "-qm", "Pin synthetic role-less workflow"]);
      const commit = git(root, ["rev-parse", "HEAD"]);
      writeFileSync(join(pmRoot, file), JSON.stringify({ open_status: "open", in_progress_status: "in_progress" }));
      const registry = committedTrackerStatusRegistry(root, commit);
      assert.equal(registry.open_status, "triage");
      assert.equal(registry.in_progress_status, "doing");
      assert.deepEqual(trackerHistoryExample(history(0, "triage", "closed"), "public/pm-fixture", commit, "item", registry)!.prefix, ["open"]);
      assert.deepEqual(trackerHistoryExample(history(0, "doing", "closed"), "public/pm-fixture", commit, "item", registry)!.prefix, ["in_progress"]);
    }
  });
});

test("committed workflow references retain path guards and the per-blob byte bound", async () => {
  await withTrackerSources(async ({ directories }) => {
    const pmRoot = directories[0]; const root = dirname(dirname(pmRoot));
    await init("roles", { defaults: true, agentGuidance: "skip", author: "status-test" }, { cwd: root, pmRoot });
    const settings = await readSettings(pmRoot);
    for (const file of ["../outside.json", "/outside.json", "schema\\outside.json"]) {
      settings.schema.files.workflows = file;
      writeFileSync(join(pmRoot, "settings.json"), JSON.stringify(settings));
      git(root, ["add", ".agents/pm/settings.json"]);
      git(root, ["-c", "user.name=Public Fixture", "-c", "user.email=public@example.test", "commit", "-qm", "Pin invalid synthetic workflow reference"]);
      assert.throws(() => committedTrackerStatusRegistry(root, "HEAD"), /dataset_workflow_schema_path/);
    }
    settings.schema.files.workflows = "schema/oversized-workflow.json";
    writeFileSync(join(pmRoot, "settings.json"), JSON.stringify(settings));
    writeFileSync(join(pmRoot, settings.schema.files.workflows), JSON.stringify({ padding: "x".repeat(8 * 1024 * 1024) }));
    git(root, ["add", ".agents/pm/settings.json", ".agents/pm/schema/oversized-workflow.json"]);
    git(root, ["-c", "user.name=Public Fixture", "-c", "user.email=public@example.test", "commit", "-qm", "Pin oversized synthetic workflow"]);
    assert.throws(() => committedTrackerStatusRegistry(root, "HEAD"), /dataset_history_bytes/);
  });
});

test("optional workflow shapes preserve the SDK inline fallback", async () => {
  await withTrackerSources(async ({ directories }) => {
    const pmRoot = directories[0]; const root = dirname(dirname(pmRoot));
    await init("roles", { defaults: true, agentGuidance: "skip", author: "status-test" }, { cwd: root, pmRoot });
    const settings = await readSettings(pmRoot);
    settings.schema.statuses.push({ id: "triage", roles: [], aliases: [] });
    settings.schema.workflow.open_status = "triage";
    settings.schema.files.workflows = "schema/optional-workflow.json";
    for (const value of [null, "invalid", [], {}, { workflow: null }, { workflow: [] }, { workflow: "invalid" }, { workflows: null }, { workflows: [] }, { workflows: "invalid" }, { workflow: {}, workflows: { open_status: "open" } }]) {
      writeFileSync(join(pmRoot, "settings.json"), JSON.stringify(settings));
      writeFileSync(join(pmRoot, settings.schema.files.workflows), JSON.stringify(value));
      git(root, ["add", ".agents/pm/settings.json", ".agents/pm/schema/optional-workflow.json"]);
      git(root, ["-c", "user.name=Public Fixture", "-c", "user.email=public@example.test", "commit", "-qm", "Pin optional synthetic workflow shape"]);
      const actual = committedTrackerStatusRegistry(root, "HEAD");
      const expected = resolveRuntimeStatusRegistry((await readSettings(pmRoot)).schema);
      assert.equal(actual.open_status, expected.open_status);
      assert.equal(actual.open_status, "triage");
    }
  });
});

test("SDK roles project randomized custom terminals and aliases while preserving released histories", async () => {
  await withTrackerSources(async (source) => {
    const root = join(source.root, "plain"); mkdirSync(root);
    const { path: pmRoot } = await init("roles", { defaults: true, agentGuidance: "skip", author: "status-test" }, { cwd: root, pmRoot: join(root, ".agents/pm") });
    const client = new PmClient({ cwd: root, pmRoot, author: "status-test", noExtensions: true });
    for (const [id, roles] of [["queued", ["active"]], ["paused", ["blocked"]], ["idea", ["draft"]], ["settled", ["terminal", "terminal_done"]], ["abandoned", ["terminal", "terminal_canceled"]]] as const) {
      await client.schemaAddStatus(id, { role: [...roles], alias: [`alias-${id}`] });
    }
    const schema = (await readSettings(pmRoot)).schema;
    const registry = resolveRuntimeStatusRegistry(schema);
    let seed = 42;
    for (let index = 0; index < 128; index++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      const terminal = seed % 2 ? "settled" : "abandoned";
      const custom = `terminal-${seed}`;
      const randomized = resolveRuntimeStatusRegistry({ ...schema, statuses: [...schema.statuses, { id: custom, aliases: [`alias-${custom}`], roles: ["terminal", terminal === "settled" ? "terminal_done" : "terminal_canceled"] }] });
      const randomHistory = history(index, "queued", ` ALIAS-${custom.toUpperCase()} `);
      assert.ok(projectImproverHistory(randomHistory, "public/pm-fixture", "item", randomized));
      assert.equal(trackerHistoryExample(randomHistory, "public/pm-fixture", "pin", "item", randomized)!.label, terminal === "settled" ? "completed" : "cancelled");
      const value = history(index, "queued", ` ALIAS-${terminal.toUpperCase()} `);
      const projected = projectImproverHistory(value, "public/pm-fixture", "item", registry);
      assert.ok(projected); assert.equal(projected.terminal_at - projected.prediction_at, index % 2 ? 59_999 : 9_999);
      assert.equal(trackerHistoryExample(value, "public/pm-fixture", "pin", "item", registry)!.label, terminal === "settled" ? "completed" : "cancelled");
      const historical = history(index, "open", ["closed", "canceled", "cancelled"][index % 3]);
      assert.deepEqual(projectImproverHistory(historical, "public/pm-fixture", "item", registry), projectImproverHistory(historical, "public/pm-fixture", "item"));
      assert.deepEqual(trackerHistoryExample(historical, "public/pm-fixture", "pin", "item", registry), trackerHistoryExample(historical, "public/pm-fixture", "pin", "item"));
    }
    for (const [status, expected] of [["queued", "in_progress"], ["paused", "blocked"], ["idea", "open"]]) {
      assert.deepEqual(trackerHistoryExample(history(0, status, "settled"), "public/pm-fixture", "pin", "item", registry)!.prefix, [expected]);
      assert.equal(projectImproverHistory(history(0, "open", status), "public/pm-fixture", "item", registry), null);
    }
    assert.equal(projectImproverHistory(history(0, "open", "unknown"), "public/pm-fixture", "item", registry), null);
    assert.throws(() => trackerHistoryExample(history(0, "unknown", "settled"), "public/pm-fixture", "pin", "item", registry), /dataset_unknown_status/);
    assert.equal(trackerHistoryExample(history(0, "settled", "settled"), "public/pm-fixture", "pin", "item", registry), null);
    const redefined = resolveRuntimeStatusRegistry({ ...schema, statuses: schema.statuses.map((status) => status.id === "closed" ? { ...status, roles: ["active"] } : status) });
    assert.equal(projectImproverHistory(history(0, "open", "closed"), "public/pm-fixture", "item", redefined), null);
  });
});

test("improver builder pins file-backed SDK roles and non-git readers retain sealed datasets", { timeout: 120_000 }, async () => {
  await withTrackerSources(async (source) => {
    const pins = [];
    for (const [sourceIndex, directory] of source.directories.entries()) {
      const root = dirname(dirname(directory));
      await init("roles", { defaults: true, agentGuidance: "skip", author: "status-test" }, { cwd: root, pmRoot: directory });
      const client = new PmClient({ cwd: root, pmRoot: directory, author: "status-test", noExtensions: true });
      await client.schemaAddStatus("finished", { role: ["terminal", "terminal_done"], alias: ["finished-alias"] });
      for (let index = 0; index < 40; index++) writeFileSync(join(directory, "history", `item-${index}.jsonl`), history(index, "open", "finished-alias"));
      git(root, ["config", "core.quotePath", "true"]);
      for (const [index, name] of ["item-ä.jsonl", "item space.jsonl", "item\nline.jsonl"].entries()) renameSync(join(directory, "history", `item-${index}.jsonl`), join(directory, "history", name));
      git(root, ["add", ".agents/pm/settings.json", ".agents/pm/schema", ".agents/pm/history"]);
      git(root, ["-c", "user.name=Public Fixture", "-c", "user.email=public@example.test", "commit", "-qm", "Pin synthetic custom terminal registry"]);
      const commit = git(root, ["rev-parse", "HEAD"]);
      pins.push({ repo: `public-fixture/pm-${["alpha", "beta", "gamma", "delta", "epsilon"][sourceIndex]}`, commit, role: sourceIndex < 2 ? "train" as const : sourceIndex < 4 ? "meta-validation" as const : "final-test" as const });
      // The file overrides stale inline settings; neither working file is part of the pinned snapshot.
      const settings = JSON.parse(readFileSync(join(directory, "settings.json"), "utf8")) as PmSettings;
      settings.schema.statuses = [];
      writeFileSync(join(directory, "settings.json"), JSON.stringify(settings));
      writeFileSync(join(directory, "schema/statuses.json"), JSON.stringify({ statuses: [] }));
      assert.ok(committedTrackerStatusRegistry(root, commit).terminal_done_statuses.has("finished"));
    }
    const output = join(source.root, "plain-dataset");
    const manifest = buildImproverDataset(source.directories, output, 42, { pins });
    assert.equal(existsSync(join(source.root, ".git")), false);
    assert.deepEqual(readImproverDataset(output), manifest);
    for (const role of IMPROVER_ROLES) {
      const tasks = readImproverTasks(output, manifest, role);
      assert.equal(tasks.length, manifest.sources.filter((entry) => entry.role === role).length * 2);
      assert.ok(tasks.every((task) => task.train.length + task.evaluation.length === 40), "every unusual committed history participates in each balanced task");
    }
  });
});

test("committed registry reads ASCII Unicode space and newline filenames byte-exactly", async () => {
  await withTrackerSources(async ({ directories }) => {
    const pmRoot = directories[0]; const root = dirname(dirname(pmRoot));
    await init("roles", { defaults: true, agentGuidance: "skip", author: "status-test" }, { cwd: root, pmRoot });
    git(root, ["config", "core.quotePath", "true"]);
    const settings = await readSettings(pmRoot);
    const body = JSON.stringify({ statuses: [{ id: "file-only", roles: ["terminal", "terminal_done"], description: "Synthetic größe" }] }) + "\n";
    for (const file of ["schema/roles-ascii.json", "schema/roles-ä.json", "schema/roles space.json", "schema/roles\nline.json"]) {
      settings.schema.files.statuses = file;
      writeFileSync(join(pmRoot, "settings.json"), JSON.stringify(settings)); writeFileSync(join(pmRoot, file), body);
      git(root, ["add", ".agents/pm/settings.json", ".agents/pm/schema"]);
      git(root, ["-c", "user.name=Public Fixture", "-c", "user.email=public@example.test", "commit", "-qm", "Pin exact synthetic schema pathname"]);
      const commit = git(root, ["rev-parse", "HEAD"]); const path = `.agents/pm/${file}`;
      assert.ok(trackerTreePaths(root, commit, ".agents/pm").includes(path), "the committed listing retains the exact pathname");
      assert.deepEqual(historyBlobs(root, commit, [path, ".agents/pm/settings.json"]), [body, JSON.stringify(settings)]);
      writeFileSync(join(pmRoot, file), JSON.stringify({ statuses: [] }));
      const registry = committedTrackerStatusRegistry(root, commit);
      assert.ok(registry.terminal_done_statuses.has(normalizeStatusInput("file-only", registry)!));
      assert.equal(trackerHistoryExample(history(0, "open", "file-only"), "public/pm-fixture", commit, "item", registry)!.label, "completed");
    }
  });
});

test("committed registry supports inline and absent schema and refuses escaping schema references", async () => {
  await withTrackerSources(async ({ directories }) => {
    const root = dirname(dirname(directories[0]));
    const original = git(root, ["rev-parse", "HEAD"]);
    assert.ok(committedTrackerStatusRegistry(root, original).terminal_done_statuses.has("closed"));
    const pmRoot = directories[0];
    await init("roles", { defaults: true, agentGuidance: "skip", author: "status-test" }, { cwd: root, pmRoot });
    const settings = await readSettings(pmRoot);
    const statusPath = join(pmRoot, "schema/statuses.json");
    settings.schema.statuses.push({ id: "inline-only", roles: ["terminal", "terminal_done"] });
    settings.schema.files.statuses = " ./schema//statuses.json ";
    for (const definitions of [[{ id: "file-only", roles: ["terminal", "terminal_canceled"] }], { definitions: [{ id: "file-only", roles: ["terminal", "terminal_canceled"] }] }, { statuses: [{ id: "file-only", roles: ["terminal", "terminal_canceled"] }] }, null, "invalid-shape", {}]) {
      writeFileSync(join(pmRoot, "settings.json"), JSON.stringify(settings));
      writeFileSync(statusPath, JSON.stringify(definitions)); git(root, ["add", ".agents/pm/settings.json", ".agents/pm/schema/statuses.json"]);
      git(root, ["-c", "user.name=Public Fixture", "-c", "user.email=public@example.test", "commit", "-qm", "Supported synthetic SDK registry containers"]);
      const actual = committedTrackerStatusRegistry(root, "HEAD");
      const expected = resolveRuntimeStatusRegistry((await readSettings(pmRoot)).schema);
      assert.deepEqual(actual.terminal_statuses, expected.terminal_statuses);
      assert.deepEqual(actual.terminal_done_statuses, expected.terminal_done_statuses);
      assert.deepEqual(actual.terminal_canceled_statuses, expected.terminal_canceled_statuses);
      assert.ok(actual.terminal_done_statuses.has(normalizeStatusInput("inline-only", actual)!));
    }
    settings.schema.files.statuses = "optional.json";
    const path = join(pmRoot, "settings.json");
    writeFileSync(path, JSON.stringify(settings)); git(root, ["add", ".agents/pm/settings.json"]);
    git(root, ["-c", "user.name=Public Fixture", "-c", "user.email=public@example.test", "commit", "-qm", "Inline synthetic registry"]);
    assert.ok(committedTrackerStatusRegistry(root, "HEAD").terminal_done_statuses.has("closed"));
    for (const file of ["../outside.json", "/outside.json", "schema\\outside.json"]) {
      settings.schema.files.statuses = file; writeFileSync(path, JSON.stringify(settings)); git(root, ["add", ".agents/pm/settings.json"]);
      git(root, ["-c", "user.name=Public Fixture", "-c", "user.email=public@example.test", "commit", "-qm", "Invalid synthetic schema reference"]);
      assert.throws(() => committedTrackerStatusRegistry(root, "HEAD"), /dataset_status_schema_path/);
    }
  });
});
