/** Published SDK lock refusals, package translations and native filesystem interleavings. */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mock, test } from "node:test";
import { PmClient } from "@unbrained/pm-cli/sdk/core";
import { acquireLock, acquireLockLease, EXIT_CODE, init, isPmCliExpectedError } from "@unbrained/pm-cli/sdk/runtime";
import { createExtensionTestHarness } from "@unbrained/pm-cli/sdk/testing";
import extension, { type RlCommandResult } from "../index.ts";
import { acquireStateLock, acquireStateLease, commitStateTransaction, identifierClient } from "../state-boundary.ts";

/** Match the public machine refusal, exit code and actionable recovery together. */
function refusal(code: string, exitCode: number) {
  return (error: unknown): boolean => isPmCliExpectedError(error) && error.context.code === code && error.exitCode === exitCode && typeof error.context.required === "string";
}

for (const [name, acquire] of [["acquireLock", acquireLock], ["acquireLockLease", acquireLockLease]] as const) {
  test(`SDK ${name} refuses a symlinked locks directory without leaving an outside lock`, async () => {
    const root = mkdtempSync(join(tmpdir(), "rl-sdk-link-"));
    try {
      const state = join(root, "state"), outside = join(root, "outside"); mkdirSync(state); mkdirSync(outside);
      writeFileSync(join(outside, "sentinel"), "retain"); symlinkSync(outside, join(state, "locks"), "dir");
      await assert.rejects(acquire(state, "confined", 30, "lock-test", false, false, 0), refusal("lock_path_unsafe", EXIT_CODE.CONFLICT));
      assert.deepEqual(readdirSync(outside), ["sentinel"]); assert.equal(readFileSync(join(outside, "sentinel"), "utf8"), "retain");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}

for (const name of ["lock", "lease", "transaction"] as const) {
  test(`package ${name} maps the SDK refusal after a locks-directory substitution at mkdir`, async () => {
    const root = mkdtempSync(join(tmpdir(), "rl-sdk-swap-"));
    try {
      const state = join(root, "state"), outside = join(root, "outside"); mkdirSync(state); mkdirSync(outside);
      const locks = join(state, "locks"); const mkdir = fs.mkdir; let swapped = false;
      const hook = mock.method(fs, "mkdir", async (...args: Parameters<typeof mkdir>) => {
        if (!swapped && args[0] === locks) { symlinkSync(outside, locks, "dir"); swapped = true; }
        return mkdir(...args);
      });
      let applied = false;
      try {
        await assert.rejects(async () => {
          if (name === "lock") return acquireStateLock(state, "confined", 30, "lock-test", false, false, 0);
          if (name === "lease") return acquireStateLease(state, "confined", 30, "lock-test", false, false, 0);
          return commitStateTransaction({ pmRoot: state, transactionId: "confined", author: "lock-test", steps: [{ id: "step", inspect: async () => ({ state: "pending" }), apply: async () => { applied = true; }, compensate: async () => { assert.fail("unsafe compensation"); } }] });
        }, refusal("rl_state_path_invalid", EXIT_CODE.USAGE));
      } finally { hook.mock.restore(); }
      assert.ok(swapped, "the substitution must happen inside the SDK, after package preflight");
      assert.equal(applied, false); assert.deepEqual(readdirSync(outside), []);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}

test("SDK late-open replacement refuses but retains its stray empty lock (upstream limitation)", async () => {
  const root = mkdtempSync(join(tmpdir(), "rl-sdk-late-swap-"));
  try {
    const state = join(root, "state"), outside = join(root, "outside"); mkdirSync(state); mkdirSync(outside);
    const locks = join(state, "locks"), saved = join(state, "saved-locks"), open = fs.open; let swapped = false;
    const hook = mock.method(fs, "open", async (...args: Parameters<typeof open>) => {
      if (!swapped && args[0] === join(locks, "confined.lock") && args[1] === "wx") {
        swapped = true; await fs.rename(locks, saved); symlinkSync(outside, locks, "dir");
      }
      return open(...args);
    });
    try { await assert.rejects(acquireLock(state, "confined", 30, "lock-test", false, false, 0), refusal("lock_path_unsafe", EXIT_CODE.CONFLICT)); }
    finally { hook.mock.restore(); }
    assert.ok(swapped); assert.deepEqual(readdirSync(outside), ["confined.lock"]); assert.equal(readFileSync(join(outside, "confined.lock")).length, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("command SDK mutations translate symlink refusals and retain outside bytes", async () => {
  const root = mkdtempSync(join(tmpdir(), "rl-command-locks-"));
  const harness = await createExtensionTestHarness(extension, { name: "pm-rl", capabilities: ["commands", "schema", "hooks"] });
  try {
    const state = join(root, "state"), outside = join(root, "outside");
    await init("rl", { defaults: true, author: "lock-test", agentGuidance: "skip" }, { cwd: root, pmRoot: state });
    const client = new PmClient({ cwd: root, pmRoot: state, author: "lock-test", noExtensions: true });
    assert.equal(identifierClient(client).toString(), client.toString());
    const environment = (await harness.runCommand({ command: "rl env register", pmRoot: state, options: { file: "examples/grid-world.json" } })).result as RlCommandResult;
    await harness.runCommand({ command: "rl run start", pmRoot: state, args: ["rl-run"], options: { environment: environment.id, algorithm: "test" } });
    mkdirSync(outside); writeFileSync(join(outside, "sentinel"), "retain");
    const other = join(root, "other-environment.json"); writeFileSync(other, JSON.stringify({ name: "other", version: "1", task_suite: ["task"], reward_specification: { goal: 1 } }));
    const metrics = join(root, "metrics.ndjson"); writeFileSync(metrics, '{"step":1,"metric":"reward","value":1}\n');
    await harness.runCommand({ command: "rl run log", pmRoot: state, args: ["rl-run"], options: { file: metrics } });
    rmSync(join(state, "locks"), { recursive: true, force: true }); symlinkSync(outside, join(state, "locks"), "dir");
    for (const command of [
      { command: "rl env register", options: { file: other } },
      { command: "rl run start", args: ["rl-next"], options: { environment: environment.id, algorithm: "test" } },
      { command: "rl run log", args: ["rl-run"], options: { file: metrics } },
      { command: "rl run finish", args: ["rl-run"], options: { reason: "done" } },
      { command: "rl generation register", args: ["rl-seed"], options: { baseCheckpoint: "checkpoint" } },
      { command: "rl checkpoint gc" },
    ]) {
      await assert.rejects(harness.runCommand({ ...command, pmRoot: state }), refusal("rl_state_path_invalid", EXIT_CODE.USAGE), command.command);
      assert.deepEqual(readdirSync(outside), ["sentinel"], command.command); assert.equal(readFileSync(join(outside, "sentinel"), "utf8"), "retain");
    }
  } finally { await harness.deactivate(); rmSync(root, { recursive: true, force: true }); }
});

test("the package retains unrelated SDK transport failures by identity", async () => {
  const client = new PmClient({ noExtensions: true }); const unavailable = new Error("Synthetic SDK transport unavailable");
  const hook = mock.method(client, "config", async () => { throw unavailable; });
  try { await assert.rejects(identifierClient(client).config("project", "get", "id_prefix"), error => error === unavailable); }
  finally { hook.mock.restore(); }
});
