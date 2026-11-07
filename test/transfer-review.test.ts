/** Review regressions use real SDK trackers, physical filesystem identities and disposable executable copies. */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { init, isPmCliExpectedError } from "@unbrained/pm-cli/sdk/runtime";
import { createExtensionTestHarness } from "@unbrained/pm-cli/sdk/testing";
import extension, { type RlCommandResult } from "../index.ts";
import { proposerEvolutionConfiguration, parseProposerEvolutionConfig, proposerCorpusReader } from "../proposer-evolution.ts";
import { ProposerRefusal } from "../proposer-program.ts";
import { buildTrackerDataset } from "../dataset.ts";
import { IMPROVER_ROLES } from "../improver-data.ts";
import { processWorkspace } from "./fixtures/process-workspace.ts";
import { transferCorpus, sealTransferCorpus, writeTransferDataset } from "./fixtures/transfer-corpus.ts";
import { boundedDiagnosticCorpus, transferLiveMain } from "./fixtures/transfer-live.ts";
import { withTransferScratch } from "./fixtures/transfer-scratch.ts";
import { copyRevertWorkspace } from "./fixtures/transfer-reverts.ts";
import { copyImproverSources } from "../scripts/live-improver.ts";

test("resolved private tracker aliases refuse before external metadata or history access", async () => {
  const w = await processWorkspace();
  for (const name of ["pm-observer", "pm-web-hosted", "PM-OBSERVER", "ＰＭ-ＷＥＢ-ＨＯＳＴＥＤ", "PM-HOSTED-DATA", "ＰＭ-ＷＥＢ", "PM-GPT"]) {
    const physical = join(w.root, name, ".agents/pm"); mkdirSync(physical, { recursive: true });
    const alias = join(w.root, `neutral-${name.length}-${name.codePointAt(0)}`);
    // Distinct names can share lengths and first characters; one alias per iteration suffices.
    const link = alias + name.codePointAt(name.length - 1); symlinkSync(join(w.root, name), link, "dir");
    assert.throws(() => buildTrackerDataset([join(link, ".agents/pm"), w.pmRoot, w.pmRoot], join(w.root, "unused-output")), /dataset_forbidden_source/);
    assert.equal(existsSync(join(w.root, "unused-output")), false);
  }
  const fleet = join(w.root, "fleet"); mkdirSync(fleet);
  symlinkSync(join(w.root, "pm-observer"), join(fleet, "pm-neutral"), "dir");
  assert.throws(() => copyImproverSources(fleet, join(w.root, "copies"), [{ repo: "public-fixture/pm-neutral", commit: "a".repeat(40) }]), /dataset_forbidden_source/);
  assert.equal(existsSync(join(w.root, "copies")), false);
  await assert.rejects(transferLiveMain(["build", fleet, join(w.root, "live-build")]), /dataset_forbidden_source/);
});

test("malformed transfer declarations consistently refuse through parser and native CLI validation", async () => {
  const w = await processWorkspace(); const config = proposerEvolutionConfiguration();
  const harness = await createExtensionTestHarness(extension, { name: "pm-rl", capabilities: ["commands", "hooks", "schema"] });
  const file = join(w.root, "declaration.json");
  for (const transfer of [null, "abc", 5, false, [], {}, { effect: 0.1, alpha: 0.05, power: 0.8, extra: true }, { effect: 0.1, alpha: 0, power: 0.8 }, { effect: 0.01, alpha: 0.05, power: 0.8 }]) {
    assert.throws(() => parseProposerEvolutionConfig({ ...config, transfer }), ProposerRefusal);
    writeFileSync(file, JSON.stringify({ ...config, transfer }));
    await assert.rejects(harness.runCommand({ pmRoot: w.pmRoot, command: "rl proposer validate", options: { file } }), /proposer_invalid/);
  }
  const { transfer: _transfer, ...legacy } = config;
  for (const declaration of [config, legacy]) {
    writeFileSync(file, JSON.stringify(declaration));
    const result = (await harness.runCommand({ pmRoot: w.pmRoot, command: "rl proposer validate", options: { file } })).result as RlCommandResult;
    assert.equal(result.details!.valid, true);
  }
});

test("verified corpus cache reuses stable projections and invalidates every dataset file identity", async () => {
  const w = await processWorkspace(); const directory = writeTransferDataset(w.root, transferCorpus());
  const current = proposerCorpusReader(directory); let prior = current();
  for (let index = 0; index < 1000; index++) assert.equal(current(), prior);
  for (const name of ["improver-dataset.json", ...IMPROVER_ROLES.map((role) => `${role}.json`)]) {
    const file = join(directory, name); const original = readFileSync(file, "utf8");
    utimesSync(file, 1000, 1000); prior = current(); const info = statSync(file);
    renameSync(file, file + ".prior"); writeFileSync(file, original); utimesSync(file, info.atime, info.mtime);
    const refreshed = current(); assert.notEqual(refreshed, prior); assert.deepEqual(refreshed, prior); prior = refreshed;
    // Same-size changes with restored mtime must still trigger full identity validation.
    const changed = name === "improver-dataset.json" ? original.replace('"seed":42', '"seed":43') : original.replace('"cutoff":4', '"cutoff":5');
    assert.notEqual(changed, original); assert.equal(changed.length, original.length);
    writeFileSync(file, changed); utimesSync(file, info.atime, info.mtime);
    assert.equal(statSync(file, { bigint: true }).mtimeNs, 1_000_000_000_000n);
    assert.throws(current, (error) => isPmCliExpectedError(error) && error.context.code === "proposer_dataset_invalid");
    writeFileSync(file, original); prior = current();
    renameSync(file, file + ".unavailable"); assert.throws(current, (error) => isPmCliExpectedError(error) && error.context.code === "proposer_dataset_invalid"); renameSync(file + ".unavailable", file);
    prior = current();
  }
});

test("bounded live diagnostic requires three complete tracker pairs in every role before writes", async () => {
  const valid = transferCorpus(3); const selected = boundedDiagnosticCorpus(valid);
  for (const role of IMPROVER_ROLES) assert.equal(selected.tasks[role].length, 6);
  for (const role of IMPROVER_ROLES) {
    const w = await processWorkspace();
    const short = transferCorpus({ development: 3, meta: 3, audit: 3, [role]: 2 });
    writeTransferDataset(w.root, short);
    assert.throws(() => boundedDiagnosticCorpus(short), /diagnostic_bounded_trackers/);
    await assert.rejects(transferLiveMain(["bounded", "unused", w.root, "--pm-root", join(w.root, "live/.agents/pm")]), /diagnostic_bounded_trackers/);
    assert.equal(existsSync(join(w.root, "bounded-dataset")), false); assert.equal(existsSync(join(w.root, "live")), false);
  }
  const duplicate = sealTransferCorpus({ ...valid, tasks: { ...valid.tasks, meta: valid.tasks.meta.map((task, index) => index === 1 ? { ...valid.tasks.meta[0], id: task.id } : task) } });
  assert.throws(() => boundedDiagnosticCorpus(duplicate), /diagnostic_bounded_trackers/);
});

test("disposable transfer fixtures remove complete and partially initialized SDK trackers", async () => {
  for (const failure of [false, true]) {
    let location = "";
    const work = withTransferScratch("transfer-review-cleanup-", async (scratch) => {
      location = scratch;
      await init("cleanup", { defaults: true, agentGuidance: "skip", author: "review-test" }, { cwd: scratch, pmRoot: join(scratch, ".agents/pm") });
      assert.equal(existsSync(join(scratch, ".agents/pm/settings.json")), true);
      if (failure) throw new Error("intentional_fixture_failure");
    });
    try {
      if (failure) await assert.rejects(work, /intentional_fixture_failure/); else await work;
      assert.notEqual(location, ""); assert.equal(existsSync(location), false);
    } finally { if (location !== "") rmSync(location, { recursive: true, force: true }); }
  }
  const w = await processWorkspace(); const temp = join(w.root, "child-temp"); mkdirSync(temp);
  const failed = spawnSync(process.execPath, [resolve(import.meta.dirname, "fixtures/transfer-cli.ts")], { cwd: resolve(import.meta.dirname, ".."), env: { PATH: "", HOME: w.root, TMPDIR: temp }, encoding: "utf8", timeout: 30_000 });
  assert.equal(failed.status, 1); assert.match(failed.stderr, /spawnSync npm ENOENT/);
  assert.deepEqual(readdirSync(temp), []);
});

test("behavioral revert runner works from a source copy without Git history", { timeout: 180_000 }, async () => {
  await withTransferScratch("transfer-review-nogit-", async (scratch) => {
    copyRevertWorkspace(resolve(import.meta.dirname, ".."), scratch);
    const result = spawnSync(process.execPath, ["test/fixtures/transfer-reverts.ts", "native replay refuses missing"], { cwd: scratch, env: { PATH: process.env.PATH, HOME: scratch, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" }, encoding: "utf8", timeout: 150_000 });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(result.stdout.trim().split("\n").length, 2);
    const invalid = spawnSync(process.execPath, ["test/fixtures/transfer-reverts.ts", "misspelled-probe"], { cwd: scratch, env: { PATH: process.env.PATH, HOME: scratch, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" }, encoding: "utf8", timeout: 30_000 });
    assert.equal(invalid.status, 1); assert.match(invalid.stderr, /transfer_revert_selection/);
  });
});
