/** Second automatic re-review protects physical layouts, portable consumers and surviving diagnostic evidence. */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs, { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { checkedTrackerSourcePath, buildTrackerDataset } from "../dataset.ts";
import { copyImproverSources } from "../scripts/live-improver.ts";
import { requireDiagnosticScratch, replayDiagnosticMain } from "./fixtures/transfer-replay.ts";
import { transferLiveMain } from "./fixtures/transfer-live.ts";
import { assertTransferProbe } from "./fixtures/transfer-reverts.ts";
import { withTransferScratch } from "./fixtures/transfer-scratch.ts";

/** Child processes inherit only process tools and task-owned identity roots, never ambient credentials. */
function childEnvironment(home: string, path = process.env.PATH): NodeJS.ProcessEnv {
  return { PATH: path, HOME: home, NPM_CONFIG_USERCONFIG: "/dev/null", npm_config_userconfig: "/dev/null", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
}

test("pm-cli position controls document and enforce the fixed tracker suffix at every source entry", async () => {
  const source = readFileSync(new URL("../dataset.ts", import.meta.url), "utf8");
  assert.match(source, /Callers supply <repo>\/\.agents\/pm/); assert.match(source, /copyImproverSources constructs this fixed layout; buildTrackerDataset additionally validates layout and remote identity/);
  await withTransferScratch("transfer-position-", async (scratch) => {
    for (const name of ["pm-cli", "PM-CLI", "ＰＭ-ＣＬＩ"]) {
      const tracker = join(scratch, name, ".agents/pm"); mkdirSync(tracker, { recursive: true });
      assert.throws(() => checkedTrackerSourcePath(tracker), /dataset_forbidden_source/);
      const alias = join(scratch, `alias-${name}`); symlinkSync(join(scratch, name), alias, "dir");
      assert.throws(() => checkedTrackerSourcePath(join(alias, ".agents/pm")), /dataset_forbidden_source/);
      for (let depth = 0; depth < 5; depth++) {
        const allowed = join(scratch, name, ...Array.from({ length: depth }, (_, index) => `level-${index}`), "pm-public", ".agents/pm"); mkdirSync(allowed, { recursive: true });
        assert.equal(checkedTrackerSourcePath(allowed), realpathSync(allowed));
      }
    }
    const invalidLayout = join(scratch, "pm-cli/.agents/pm/extra/trailing"); mkdirSync(invalidLayout, { recursive: true });
    // The shared path-only guard has a documented precondition; public entry points enforce it before metadata or copying.
    assert.throws(() => buildTrackerDataset([invalidLayout, invalidLayout, invalidLayout], join(scratch, "projection")), /dataset_tracker_directory/);
    assert.throws(() => copyImproverSources(scratch, join(scratch, "copies"), [{ repo: "public-fixture/pm-cli", commit: "a".repeat(40) }]), /dataset_forbidden_source/);
    assert.equal(existsSync(join(scratch, "projection")), false); assert.equal(existsSync(join(scratch, "copies")), false);
  });
});

test("every diagnostic entry validates physical scratch layout before output writes or project derivation", async () => {
  await withTransferScratch("transfer-layout-", async (scratch) => {
    for (const suffix of ["pm", "other/pm", "other.agents/pm", ".agents/other", "parent/.agents/pm/extra"]) {
      const root = join(scratch, "requested", suffix); const output = join(scratch, "unopened-output");
      assert.throws(() => requireDiagnosticScratch(root), /diagnostic_scratch_layout/);
      await assert.rejects(replayDiagnosticMain(["--pm-root", root, "--receipt", "unopened.json"]), /diagnostic_scratch_layout/);
      for (const mode of ["bounded", "run"]) await assert.rejects(transferLiveMain([mode, "unopened-fleet", output, "--pm-root", root]), /diagnostic_scratch_layout/);
      assert.equal(existsSync(output), false); assert.equal(existsSync(join(scratch, "requested")), false);
    }
    const project = join(scratch, "physical"); mkdirSync(project); const alias = join(scratch, "alias"); symlinkSync(project, alias, "dir");
    const valid = join(alias, ".agents/pm"); assert.equal(requireDiagnosticScratch(valid), join(realpathSync(project), ".agents/pm"));
    await assert.rejects(replayDiagnosticMain(["--pm-root", valid, "--receipt", "unopened.json"]), /ENOENT/);
    for (const mode of ["bounded", "run"]) await assert.rejects(transferLiveMain([mode, "unopened-fleet", join(scratch, `valid-${mode}`), "--pm-root", valid]), /ENOENT/);
    assert.equal(existsSync(join(project, ".agents")), false);
    const wrong = join(scratch, "wrong"); mkdirSync(wrong); const disguised = join(scratch, "disguised/.agents"); mkdirSync(disguised, { recursive: true }); symlinkSync(wrong, join(disguised, "pm"), "dir");
    assert.throws(() => requireDiagnosticScratch(join(disguised, "pm")), /diagnostic_scratch_layout/);
  });
});

test("receipt scratch assertions accept a symlinked temporary directory deterministically", async () => {
  await withTransferScratch("transfer-physical-", async (scratch) => {
    const physical = join(scratch, "physical"); mkdirSync(physical); const alias = join(scratch, "alias"); symlinkSync(physical, alias, "dir");
    const env = { ...childEnvironment(scratch), TMPDIR: alias, TMP: alias, TEMP: alias };
    const child = spawnSync(process.execPath, ["--test", "--test-concurrency=2", "--test-name-pattern=^diagnostic replay requires", "test/transfer-receipt.test.ts"], { cwd: resolve(import.meta.dirname, ".."), env, encoding: "utf8", timeout: 30_000 });
    assert.equal(child.status, 0, child.stdout + child.stderr); assert.match(child.stdout, /pass 1/);
  });
});

test("failed probe diagnostics survive scratch cleanup for every failure mode with bounded output", async () => {
  const identity = "synthetic-probe:expected-assertion (relative-source.ts)"; const marker = "PROBE_OUTPUT_TAIL";
  for (const mode of ["zero", "wrong", "import", "signal", "missing"]) {
    let location = "";
    await assert.rejects(withTransferScratch("transfer-probe-message-", async (scratch) => {
      location = scratch;
      const script = mode === "signal" ? `require('node:fs').writeSync(2,'${marker}');process.kill(process.pid,'SIGTERM')` : `process.stdout.write('x'.repeat(8000)+'${marker}');${mode === "import" ? "process.stderr.write('SyntaxError')" : ""};process.exit(${mode === "zero" ? 0 : 1})`;
      const result = spawnSync(mode === "missing" ? join(scratch, "absent-executable") : process.execPath, ["-e", script], { encoding: "utf8", env: childEnvironment(scratch) });
      assertTransferProbe(identity, result, mode === "import" ? /PROBE_OUTPUT_TAIL/ : /AssertionError/);
    }), (error) => {
      assert.ok(error instanceof assert.AssertionError); assert.ok(error.message.includes(identity));
      assert.ok(error.message.includes(mode === "missing" ? "ENOENT" : marker)); assert.ok(error.message.includes("status=")); assert.ok(error.message.length < 5000); return true;
    });
    assert.equal(existsSync(location), false);
  }
  const correct = spawnSync(process.execPath, ["-e", "console.log('AssertionError');process.exit(1)"], { encoding: "utf8" });
  assert.doesNotThrow(() => assertTransferProbe(identity, correct, /AssertionError/));
});

test("scratch cleanup retries transient directory races and preserves operation errors on permanent failure", async (t) => {
  const actual = fs.rmSync; let location = ""; let attempts = 0;
  const transient = t.mock.method(fs, "rmSync", ((path: fs.PathLike, options?: fs.RmOptions) => {
    if (path === location && attempts++ < 2) throw Object.assign(new Error("Synthetic directory race"), { code: "ENOTEMPTY" });
    return actual(path, options);
  }) as typeof fs.rmSync); syncBuiltinESMExports();
  try { await assert.doesNotReject(async () => assert.equal(await withTransferScratch("transfer-cleanup-retry-", async (scratch) => { location = scratch; writeFileSync(join(scratch, "owned"), "synthetic"); return 7; }), 7)); assert.equal(attempts, 3); assert.equal(existsSync(location), false); }
  finally { transient.mock.restore(); syncBuiltinESMExports(); if (location !== "") actual(location, { recursive: true, force: true }); }
  const owned: string[] = [];
  const operation = new Error("OPERATION_FAILURE"); const cleanup = Object.assign(new Error("CLEANUP_FAILURE"), { code: "EACCES" });
  const denied = t.mock.method(fs, "rmSync", ((path: fs.PathLike, options?: fs.RmOptions) => { if (path === location) throw cleanup; return actual(path, options); }) as typeof fs.rmSync); syncBuiltinESMExports();
  try {
    await assert.rejects(withTransferScratch("transfer-cleanup-permanent-", async (scratch) => { location = scratch; owned.push(scratch); throw operation; }), (error) => error instanceof AggregateError && error.errors[0] === operation && error.errors[1] === cleanup);
    await assert.rejects(withTransferScratch("transfer-cleanup-only-", async (scratch) => { location = scratch; owned.push(scratch); }), (error) => error === cleanup);
  } finally { denied.mock.restore(); syncBuiltinESMExports(); for (const directory of owned) actual(directory, { recursive: true, force: true }); }
});

test("Node packed checks remain mandatory when Bun is missing while real Bun failures still fail", { timeout: 240_000 }, async () => {
  await withTransferScratch("transfer-optional-runtime-", async (scratch) => {
    const bin = join(scratch, "bin"); mkdirSync(bin); symlinkSync(process.execPath, join(bin, "node"));
    for (const tool of ["npm", "tar", "gzip", "git", "sh", "ps", "getconf"]) {
      const executable = execFileSync("/bin/sh", ["-c", `command -v ${tool}`], { encoding: "utf8" }).trim(); symlinkSync(realpathSync(executable), join(bin, tool));
    }
    const env = childEnvironment(scratch, bin); const args = ["--test", "--test-concurrency=2", "--test-name-pattern=^packed npm and Bun consumers", "test/transfer-refusal.test.ts"];
    const run = () => spawnSync(process.execPath, args, { cwd: resolve(import.meta.dirname, ".."), env, encoding: "utf8", timeout: 90_000 });
    const absent = run(); assert.equal(absent.status, 0, absent.stdout + absent.stderr); assert.match(absent.stdout, /Packed runtime node: SDK=146 CLI=4 verified/); assert.match(absent.stdout, /Bun unavailable \(ENOENT\)/);
    const bun = join(bin, "bun"); writeFileSync(bun, `#!${process.execPath}\nconsole.error('BUN_EXECUTION_FAILURE');process.exit(23);\n`); chmodSync(bun, 0o755);
    const broken = run(); assert.equal(broken.status, 1, broken.stdout + broken.stderr); assert.match(broken.stdout + broken.stderr, /BUN_EXECUTION_FAILURE/); assert.doesNotMatch(broken.stdout, /Bun unavailable/);
    chmodSync(bun, 0o644);
    const denied = run(); assert.equal(denied.status, 1, denied.stdout + denied.stderr); assert.match(denied.stdout + denied.stderr, /EACCES/); assert.doesNotMatch(denied.stdout, /Bun unavailable/);
  });
});
