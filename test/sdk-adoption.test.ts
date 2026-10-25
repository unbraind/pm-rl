/** Behavioral prerequisites for replacing controller recovery with native SDK leases. */
import assert from "node:assert/strict";
import { readFile, writeFile, mkdtemp, rm } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { commitWorkspaceTransaction, type CommitWorkspaceTransactionOptions } from "@unbrained/pm-cli/sdk";
import { PmClient } from "@unbrained/pm-cli/sdk/core";
import { acquireLock, getHistoryPath, init, isPmCliExpectedError } from "@unbrained/pm-cli/sdk/runtime";
import { commitProcessTransaction, loopProcessStartTime, rlLoopStatus, runRlLoop, withProcessJobFence, type JsonValue } from "../index.ts";

/** Initialize a real standalone tracker with no enclosing Git repository. */
async function workspace(execute: (root: string, client: PmClient) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "rl-sdk-adoption-"));
  const previousCeiling = process.env["GIT_CEILING_DIRECTORIES"];
  process.env["GIT_CEILING_DIRECTORIES"] = dirname(directory);
  try {
    const root = join(directory, ".agents", "pm");
    await init("rl", { defaults: true, agentGuidance: "skip", author: "adoption-test" }, { cwd: directory, pmRoot: root });
    await execute(root, new PmClient({ cwd: directory, pmRoot: root, author: "adoption-test", noExtensions: true }));
  } finally {
    if (previousCeiling === undefined) delete process.env["GIT_CEILING_DIRECTORIES"];
    else process.env["GIT_CEILING_DIRECTORIES"] = previousCeiling;
    await rm(directory, { recursive: true, force: true });
  }
}

/** Seed a token-owned native lock with a demonstrably obsolete process birth identity. */
async function abandoned(root: string, id: string): Promise<() => Promise<void>> {
  const release = await acquireLock(root, id, 1_000_000_000, "previous-controller");
  const path = join(root, "locks", `${id}.lock`);
  const record = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  const start = loopProcessStartTime(process.pid);
  assert.ok(start !== null);
  await writeFile(path, JSON.stringify({ ...record, hostname: hostname(), process_start_time: `${start}:obsolete` }));
  return release;
}

test("SDK adoption prerequisite: a dead native phase holder recovers before its TTL", async () => {
  await workspace(async (pmRoot) => {
    const id = "adoption-phase";
    const release = await abandoned(pmRoot, id);
    try {
      await assert.rejects(acquireLock(pmRoot, id, 1_000_000_000, "adoption-test", false, false, 0, { maxWaitMs: 0 }), (error: unknown) => isPmCliExpectedError(error) && error.context.code === "lock_conflict");
      assert.equal(await withProcessJobFence({ pmRoot, author: "adoption-test" }, id, async () => "recovered"), "recovered");
    } finally { await release(); }
  });
});

test("SDK adoption prerequisite: transaction recovery retains the full transition observer", async () => {
  await workspace(async (pmRoot) => {
    const release = await abandoned(pmRoot, "sdk-workspace-transaction");
    const transitions: string[] = [];
    let applied = false;
    const options: CommitWorkspaceTransactionOptions = {
      pmRoot, author: "adoption-test", transactionId: "adoption-transaction", lockTtlSeconds: 1_000_000_000, lockWaitMs: 1,
      steps: [{ id: "effect", async inspect() { return { state: applied ? "applied" : "pending" }; }, async apply() { applied = true; return "receipt"; }, async compensate() { applied = false; } }],
      onTransition(context) { transitions.push(context.transition); },
    };
    try {
      await assert.rejects(commitWorkspaceTransaction(options), (error: unknown) => isPmCliExpectedError(error) && error.context.code === "lock_conflict");
      assert.deepEqual(transitions, []);
      await commitProcessTransaction(options);
      assert.ok(applied);
      assert.deepEqual(transitions, ["prepared", "step_applied", "step_recorded", "committing", "committed"]);
    } finally { await release(); }
  });
});

test("SDK adoption integrity prerequisite: primed event caches cannot hide corrupt promotion history", async () => {
  await workspace(async (pmRoot, client) => {
    await client.create({ id: "approval", title: "Bounded adoption drill", type: "Decision", body: '```json\n{"permitted_promotions":1}\n```' });
    const config = { ...JSON.parse(await readFile(new URL("../examples/loop-bandit.json", import.meta.url), "utf8")) as Record<string, JsonValue>, max_generations: 1 };
    const report = await runRlLoop(client, { pmRoot, author: "adoption-test" }, { id: "adoption", config, approval: "approval" });
    assert.equal(report.promoted, 1);
    const status = await rlLoopStatus(client, "adoption", pmRoot);
    assert.equal(status.promoted, 1);
    const item = await client.get("adoption-g1", { outputBudget: "unbounded", outputLimit: "unbounded" });
    assert.ok("item" in item);
    const id = String(item.item.id);
    await client.comments(id, { outputBudget: "unbounded", outputLimit: "unbounded" });
    await client.notes(id, { outputBudget: "unbounded", outputLimit: "unbounded" });
    const path = getHistoryPath(pmRoot, id);
    const original = await readFile(path, "utf8");
    const rows = original.trimEnd().split("\n");
    const entry = JSON.parse(rows[0]) as Record<string, unknown>;
    entry["author"] = "corrupted-after-cache-prime";
    rows[0] = JSON.stringify(entry);
    await writeFile(path, `${rows.join("\n")}\n`);
    await assert.rejects(rlLoopStatus(client, "adoption", pmRoot), (error: unknown) => isPmCliExpectedError(error) && error.context.code === "loop_generation_drift");
    await writeFile(path, original);
    assert.equal((await rlLoopStatus(client, "adoption", pmRoot)).promoted, 1);
  });
});
