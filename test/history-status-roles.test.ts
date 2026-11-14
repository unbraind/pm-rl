/** Pinned SDK status roles, historical projection compatibility and plain-directory dataset consumers. */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { PmClient } from "@unbrained/pm-cli/sdk/core";
import { init, normalizeStatusInput, readSettings } from "@unbrained/pm-cli/sdk/runtime";
import { resolveRuntimeStatusRegistry, type PmSettings } from "@unbrained/pm-cli/sdk";
import { committedTrackerStatusRegistry, trackerHistoryExample } from "../dataset.ts";
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
      assert.ok(tasks.every((task) => task.train.length > 0 && task.evaluation.length > 0));
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
