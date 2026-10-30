/** Real tracker regressions for larger checkpoints, integrity, reachability and concurrent promotion without Git. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import childProcess, { fork } from "node:child_process";
import { once } from "node:events";
import fs, { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { dirname, join, relative } from "node:path";
import { mock, test } from "node:test";
import { PmClient } from "@unbrained/pm-cli/sdk/core";
import { isPmCliExpectedError } from "@unbrained/pm-cli/sdk/runtime";
import { createExtensionTestHarness } from "@unbrained/pm-cli/sdk/testing";
import extension, { controllerAuthorityRoot, controllerHasGitAncestor, withRlController } from "../index.ts";
import { checkpointArtifactPath, collectCheckpointArtifacts, decodeCheckpointArtifacts, encodeCheckpointArtifacts, inspectCheckpointArtifact, MAX_CHECKPOINT_BYTES, readCheckpointArtifact, readCheckpointLedger, type CheckpointArtifact } from "../checkpoint-artifacts.ts";
import { prefixCheckpoint } from "../prefix.ts";
import { initialImprover } from "../improver.ts";
import { executeImproverFit, improverAdapter, type LearnerTrial } from "../improver-environment.ts";
import { runRecursiveImprover } from "../recursive-improver.ts";
import { listProcessJobs, processStaging, readProcessJob, stagingBytes, validateProcessCompletion, type ProcessInput } from "../process.ts";
import { checkpointWorkspace } from "./fixtures/checkpoint-workspace.ts";
import { buildTrackerDataset } from "../dataset.ts";
import { withTrackerSources } from "./fixtures/meta-workspace.ts";
import { checkpointBenchmarkMain, measureCheckpointLoads } from "../scripts/checkpoint-benchmark.ts";
import { liveMetaConfiguration } from "../scripts/live-meta.ts";
import { isMainInvocation } from "../scripts/script-launcher.ts";
import { prefixTrainerMain } from "../prefix-trainer.ts";
import { referenceTrainerMain } from "../process-bandit.ts";
import { lmTrainerMain } from "../process-lm-trainer.ts";

/** Match stable errors instead of accepting accidental parser or filesystem exceptions. */
function refuses(code: string): (error: unknown) => boolean { return (error) => isPmCliExpectedError(error) && error.context.code === code; }

/** Build a Git-free PATH using process tools discovered before PATH is restricted. */
function checkpointToolBin(root: string, searchPath = process.env.PATH): string {
  const bin = join(root, "bin"); mkdirSync(bin); symlinkSync(process.execPath, join(bin, "node"));
  for (const tool of ["ps", "getconf"]) {
    let executable: string;
    try { executable = childProcess.execFileSync("/bin/sh", ["-c", `command -v ${tool}`], { encoding: "utf8", env: { ...process.env, PATH: searchPath } }).trim(); }
    catch (cause) { throw new Error(`Required process tool '${tool}' was not found on the supplied PATH.`, { cause }); }
    symlinkSync(executable, join(bin, tool));
  }
  return bin;
}

test("restricted process tools follow the supplied PATH instead of platform installation paths", async () => {
  const w = await checkpointWorkspace();
  const tools = join(w.root, "tools"); mkdirSync(tools);
  for (const tool of ["ps", "getconf"]) symlinkSync(process.execPath, join(tools, tool));
  const bin = checkpointToolBin(w.root, tools);
  for (const tool of ["ps", "getconf"]) assert.equal(readlinkSync(join(bin, tool)), join(tools, tool));
  assert.equal(readlinkSync(join(bin, "node")), process.execPath);
});

test("restricted process tools name each missing executable and preserve the lookup cause", async () => {
  const w = await checkpointWorkspace();
  for (const missing of ["ps", "getconf"]) {
    const root = join(w.root, missing); mkdirSync(root);
    const tools = join(root, "tools"); mkdirSync(tools);
    if (missing === "getconf") symlinkSync(process.execPath, join(tools, "ps"));
    assert.throws(() => checkpointToolBin(root, tools), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.message, `Required process tool '${missing}' was not found on the supplied PATH.`);
      assert.ok(error.cause instanceof Error);
      return true;
    });
  }
});

test("checkpoint benchmark and trainer imports tolerate non-file launcher entries while gates remain strict", async () => {
  const w = await checkpointWorkspace();
  const entry = join(w.root, "missing-entry");
  const moduleUrl = new URL("../scripts/checkpoint-benchmark.ts", import.meta.url).href;
  assert.throws(() => isMainInvocation([process.execPath, entry], moduleUrl), /ENOENT/);
  assert.throws(() => isMainInvocation([process.execPath, process.argv[1]], new URL("../missing-module.ts", import.meta.url).href, true), /ENOENT/);
  for (const main of [checkpointBenchmarkMain, prefixTrainerMain, referenceTrainerMain, lmTrainerMain]) {
    await main([process.execPath, entry]);
    await main([process.execPath]);
  }
  for (const launcher of ["missing", "absent"]) {
    const result = childProcess.spawnSync(process.execPath, ["--input-type=module", "-e",
      `${launcher === "missing" ? 'process.argv[1] = "[eval]";' : "delete process.argv[1];"} await import(${JSON.stringify(moduleUrl)}); await import(${JSON.stringify(new URL("../process-lm-trainer.ts", import.meta.url).href)});`],
    { encoding: "utf8", timeout: 60_000 });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "", "imports must not start a benchmark or trainer");
  }
});

test("README states the existing storage reservation through width 64", () => {
  const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
  assert.match(readme, /widths\s+through 64 retain the existing 4096-byte reservation\. Widths above 64, up to 4096,\s+require an explicit larger storage approval/);
});

test("invalid policies cannot publish permanent blobs or ledger roots", async () => {
  const w = await checkpointWorkspace();
  const policy = prefixCheckpoint(new Array<number>(4096).fill(0.125), w.config.initial.arms[0].config.prefix);
  const improver = initialImprover();
  for (const invalid of [
    { ...policy, weights: [0] }, { ...policy, weights: policy.weights.map(() => 0.25) },
    { ...policy, knobs: { ...policy.knobs, hashing_width: 3 } },
    { ...improver, exploration: -1 }, { ...improver, digest: policy.digest },
  ]) {
    await assert.rejects(encodeCheckpointArtifacts(w.pmRoot, "invalid", [policy, invalid]), refuses("checkpoint_artifact_invalid"));
    assert.equal(existsSync(join(w.pmRoot, "artifacts")), false, "validation must precede all publication");
  }
  const ref = await encodeCheckpointArtifacts(w.pmRoot, "valid", policy) as CheckpointArtifact;
  await assert.rejects(encodeCheckpointArtifacts(w.pmRoot, "invalid-after-valid", { ...policy, weights: [0] }), refuses("checkpoint_artifact_invalid"));
  assert.deepEqual(inspectCheckpointArtifact(w.pmRoot, ref.digest).value, policy);
  assert.deepEqual(await collectCheckpointArtifacts(w.pmRoot), { retained: 1, removed: 0 });
  assert.equal(readCheckpointLedger(w.pmRoot).length, 1);
});

test("artifact addressing verifies bytes, schemas, ledger roots and conservative garbage collection", async () => {
  const w = await checkpointWorkspace();
  assert.deepEqual(await collectCheckpointArtifacts(w.pmRoot), { retained: 0, removed: 0 });
  assert.equal(await encodeCheckpointArtifacts(w.pmRoot, "empty", null), null);
  assert.deepEqual(await encodeCheckpointArtifacts(w.pmRoot, "partial", [{ weights: [] }, { weights: [], knobs: {} }]), [{ weights: [] }, { weights: [], knobs: {} }]);
  const policy = prefixCheckpoint(new Array<number>(4096).fill(0.125), w.config.initial.arms[0].config.prefix);
  const encoded = await encodeCheckpointArtifacts(w.pmRoot, "promotion:first", { prefix: policy, duplicate: policy, values: [null, true, 3], improver: initialImprover() }) as { prefix: CheckpointArtifact };
  const ref = encoded.prefix; const file = checkpointArtifactPath(w.pmRoot, ref.digest);
  assert.ok(ref.bytes > 4096); assert.ok(lstatSync(file).isFile());
  assert.equal(readdirSync(dirname(file)).length, 2, "identical checkpoints share one immutable blob");
  assert.deepEqual(readCheckpointArtifact(w.pmRoot, ref), policy);
  assert.deepEqual(decodeCheckpointArtifacts(w.pmRoot, encoded), { prefix: policy, duplicate: policy, values: [null, true, 3], improver: initialImprover() });
  assert.deepEqual(inspectCheckpointArtifact(w.pmRoot, ref.digest), { artifact: ref, value: policy });
  await encodeCheckpointArtifacts(w.pmRoot, "promotion:first", policy);
  await encodeCheckpointArtifacts(w.pmRoot, "promotion:first", policy);
  assert.equal(readCheckpointLedger(w.pmRoot).length, 2, "same ledger entry is idempotent");
  const orphan = `${"b".repeat(64)}.json`; writeFileSync(join(dirname(file), orphan), "unreachable");
  writeFileSync(join(dirname(file), ".pending-interrupted"), "incomplete write");
  assert.deepEqual(await collectCheckpointArtifacts(w.pmRoot), { retained: 2, removed: 1 });
  assert.ok(existsSync(file)); assert.ok(existsSync(join(dirname(file), ".pending-interrupted")));
  assert.throws(() => checkpointArtifactPath(w.pmRoot, "../../escape"), refuses("rl_identifier_invalid"));
  for (const patch of [{ bytes: 0 }, { bytes: 1.5 }, { bytes: MAX_CHECKPOINT_BYTES + 1 }, { format: "old" }, { kind: "other" }, { policy: "bad" }]) assert.throws(() => readCheckpointArtifact(w.pmRoot, { ...ref, ...patch } as CheckpointArtifact), refuses("checkpoint_artifact_invalid"));
  assert.throws(() => inspectCheckpointArtifact(w.pmRoot, `sha256:${"c".repeat(64)}`), refuses("checkpoint_artifact_missing"));
  const original = readFileSync(file);
  const reordered = Buffer.from(JSON.stringify({ knobs: policy.knobs, weights: policy.weights, digest: policy.digest }));
  assert.equal(reordered.length, original.length); writeFileSync(file, reordered);
  assert.throws(() => readCheckpointArtifact(w.pmRoot, ref), refuses("checkpoint_artifact_corrupt"));
  writeFileSync(file, Buffer.alloc(original.length, 32));
  assert.throws(() => readCheckpointArtifact(w.pmRoot, ref), refuses("checkpoint_artifact_corrupt"));
  assert.throws(() => readCheckpointArtifact(w.pmRoot, { ...ref, bytes: 1 }), refuses("checkpoint_artifact_corrupt"));
  const secondOrphan = join(dirname(file), `${"d".repeat(64)}.json`); writeFileSync(secondOrphan, "unreachable");
  await assert.rejects(collectCheckpointArtifacts(w.pmRoot), refuses("checkpoint_artifact_corrupt"));
  assert.ok(existsSync(secondOrphan), "an incomplete reachability read must delete nothing");
  await assert.rejects(encodeCheckpointArtifacts(w.pmRoot, "duplicate-corrupt", policy), refuses("checkpoint_artifact_corrupt"));
  writeFileSync(file, original); unlinkSync(file);
  assert.throws(() => readCheckpointArtifact(w.pmRoot, ref), refuses("checkpoint_artifact_missing"));
  symlinkSync(secondOrphan, file);
  assert.throws(() => readCheckpointArtifact(w.pmRoot, ref), refuses("rl_state_path_invalid"));
  unlinkSync(file); writeFileSync(file, original);
  /** A self-consistent byte digest still needs a valid semantic checkpoint identity. */
  const install = (text: string): CheckpointArtifact => {
    const digest = `sha256:${createHash("sha256").update(text).digest("hex")}`;
    writeFileSync(checkpointArtifactPath(w.pmRoot, digest), text); return { ...ref, digest, bytes: Buffer.byteLength(text) };
  };
  assert.throws(() => readCheckpointArtifact(w.pmRoot, install("not JSON")), refuses("checkpoint_artifact_corrupt"));
  assert.throws(() => readCheckpointArtifact(w.pmRoot, install("null")), refuses("checkpoint_artifact_corrupt"));
  assert.throws(() => readCheckpointArtifact(w.pmRoot, install(JSON.stringify({ ...policy, weights: [0] }))), refuses("checkpoint_artifact_corrupt"));
  assert.throws(() => readCheckpointArtifact(w.pmRoot, install(JSON.stringify({ ...policy, weights: policy.weights.map(() => 0.25) }))), refuses("checkpoint_artifact_corrupt"));
  assert.throws(() => readCheckpointArtifact(w.pmRoot, { ...ref, kind: "improver" }), refuses("checkpoint_artifact_corrupt"));
  assert.throws(() => readCheckpointArtifact(w.pmRoot, { ...ref, policy: `sha256:${"0".repeat(64)}` }), refuses("checkpoint_artifact_corrupt"));
  const ledger = join(w.pmRoot, "artifacts/pm-rl/ledger");
  for (const record of [null, { format: "old", key: "bad", artifacts: [] }, { format: "pm-rl/checkpoint-ledger/1", key: 1, artifacts: [] }, { format: "pm-rl/checkpoint-ledger/1", key: "bad", artifacts: null }]) {
    const text = JSON.stringify(record); const file = join(ledger, `${createHash("sha256").update(text).digest("hex")}.json`);
    writeFileSync(file, text); assert.throws(() => readCheckpointLedger(w.pmRoot), refuses("checkpoint_artifact_corrupt")); unlinkSync(file);
  }
});

test("checkpoint inspection isolates unrelated missing or corrupt blobs while GC refuses deletion", async () => {
  const w = await checkpointWorkspace();
  assert.equal(existsSync(join(w.root, ".git")), false);
  const policy = initialImprover();
  const ref = await encodeCheckpointArtifacts(w.pmRoot, "healthy", policy) as CheckpointArtifact;
  const unrelated = await encodeCheckpointArtifacts(w.pmRoot, "unrelated", prefixCheckpoint(new Array<number>(4096).fill(0.125), w.config.initial.arms[0].config.prefix)) as CheckpointArtifact;
  const file = checkpointArtifactPath(w.pmRoot, unrelated.digest);
  const orphan = checkpointArtifactPath(w.pmRoot, `sha256:${"e".repeat(64)}`); writeFileSync(orphan, "unreachable");
  const harness = await createExtensionTestHarness(extension, { name: "pm-rl", capabilities: ["commands", "hooks", "schema"] });
  for (const missing of [false, true]) {
    if (missing) unlinkSync(file); else writeFileSync(file, "corrupt");
    const code = missing ? "checkpoint_artifact_missing" : "checkpoint_artifact_corrupt";
    assert.deepEqual(inspectCheckpointArtifact(w.pmRoot, ref.digest), { artifact: ref, value: policy });
    const shown = await harness.runCommand({ command: "rl checkpoint show", pmRoot: w.pmRoot, args: [ref.digest] });
    assert.ok(JSON.stringify(shown).includes(policy.digest));
    assert.throws(() => inspectCheckpointArtifact(w.pmRoot, unrelated.digest), refuses(code));
    assert.throws(() => readCheckpointLedger(w.pmRoot), refuses(code));
    await assert.rejects(collectCheckpointArtifacts(w.pmRoot), refuses(code));
    assert.ok(existsSync(orphan), "incomplete certification must never delete an orphan");
  }
});

test("checkpoint inspection reads only the target blob once despite duplicate roots", async () => {
  const w = await checkpointWorkspace();
  const policy = initialImprover();
  const ref = await encodeCheckpointArtifacts(w.pmRoot, "first", policy) as CheckpointArtifact;
  await encodeCheckpointArtifacts(w.pmRoot, "second", policy);
  const other = await encodeCheckpointArtifacts(w.pmRoot, "other", prefixCheckpoint(new Array<number>(4096).fill(0.125), w.config.initial.arms[0].config.prefix)) as CheckpointArtifact;
  const file = checkpointArtifactPath(w.pmRoot, ref.digest); const otherFile = checkpointArtifactPath(w.pmRoot, other.digest);
  const reads = mock.method(fs, "openSync"); syncBuiltinESMExports();
  try {
    assert.deepEqual(inspectCheckpointArtifact(w.pmRoot, ref.digest), { artifact: ref, value: policy });
    assert.equal(reads.mock.calls.filter((call) => call.arguments[0] === file).length, 1);
    assert.equal(reads.mock.calls.filter((call) => call.arguments[0] === otherFile).length, 0);
  } finally { reads.mock.restore(); syncBuiltinESMExports(); }
});

test("checkpoint descriptor keeps the validated inode when its path is replaced", async () => {
  const w = await checkpointWorkspace();
  assert.equal(existsSync(join(w.root, ".git")), false);
  const policy = initialImprover();
  const ref = await encodeCheckpointArtifacts(w.pmRoot, "descriptor", policy) as CheckpointArtifact;
  const file = checkpointArtifactPath(w.pmRoot, ref.digest);
  const original = readFileSync(file);
  for (const replacement of ["oversized", "symlink", "directory"]) {
    const saved = `${file}.saved`;
    let swapped = false;
    /** Replace the pathname after metadata validation, leaving any open inode intact. */
    const swap = (): void => {
      if (swapped) return;
      swapped = true; fs.renameSync(file, saved);
      if (replacement === "symlink") symlinkSync(saved, file);
      else if (replacement === "directory") mkdirSync(file);
      else { writeFileSync(file, original); fs.truncateSync(file, MAX_CHECKPOINT_BYTES + 1); }
    };
    const originalFstat = fs.fstatSync;
    const descriptorStat = mock.method(fs, "fstatSync", (handle: number) => {
      const stat = originalFstat(handle); swap(); return stat;
    });
    const closes = mock.method(fs, "closeSync"); syncBuiltinESMExports();
    try {
      assert.deepEqual(readCheckpointArtifact(w.pmRoot, ref), policy);
      assert.equal(swapped, true);
      assert.equal(closes.mock.calls.filter((call) => call.arguments[0] === descriptorStat.mock.calls[0].arguments[0]).length, 1, "validated descriptor must close on success");
    } finally {
      descriptorStat.mock.restore(); closes.mock.restore(); syncBuiltinESMExports();
      fs.rmSync(file, { recursive: true }); fs.renameSync(saved, file);
    }
  }
});

test("checkpoint descriptor bounds reads when the validated inode grows or shrinks", async () => {
  const w = await checkpointWorkspace();
  const ref = await encodeCheckpointArtifacts(w.pmRoot, "bounded", initialImprover()) as CheckpointArtifact;
  const file = checkpointArtifactPath(w.pmRoot, ref.digest); const original = readFileSync(file);
  for (const size of [0, MAX_CHECKPOINT_BYTES + 100]) {
    const originalFstat = fs.fstatSync;
    const descriptorStat = mock.method(fs, "fstatSync", (handle: number) => {
      const stat = originalFstat(handle); fs.truncateSync(file, size); return stat;
    });
    const reads = mock.method(fs, "readSync"); const pathReads = mock.method(fs, "readFileSync");
    const closes = mock.method(fs, "closeSync"); syncBuiltinESMExports();
    try {
      assert.throws(() => readCheckpointArtifact(w.pmRoot, ref), refuses("checkpoint_artifact_corrupt"));
      const total = reads.mock.calls.reduce((sum, call) => sum + Number(call.result), 0)
        + pathReads.mock.calls.reduce((sum, call) => sum + Buffer.byteLength(call.result as Buffer), 0);
      assert.ok(total <= original.length + 1, "growth must not cause an unbounded read");
      assert.equal(closes.mock.calls.filter((call) => call.arguments[0] === descriptorStat.mock.calls[0].arguments[0]).length, 1, "validated descriptor must close on size drift");
    } finally {
      for (const spy of [descriptorStat, reads, pathReads, closes]) spy.mock.restore();
      syncBuiltinESMExports(); writeFileSync(file, original);
    }
  }
});

test("checkpoint descriptor handles short reads and closes after metadata or IO failures", async () => {
  const w = await checkpointWorkspace(); const policy = initialImprover();
  const ref = await encodeCheckpointArtifacts(w.pmRoot, "io", policy) as CheckpointArtifact;
  const file = checkpointArtifactPath(w.pmRoot, ref.digest);
  const originalRead = fs.readSync;
  const shortRead = mock.method(fs, "readSync", (handle: number, buffer: NodeJS.ArrayBufferView, offset: number, length: number, position: number | null) => originalRead(handle, buffer, offset, Math.min(length, 7), position));
  syncBuiltinESMExports();
  try { assert.deepEqual(readCheckpointArtifact(w.pmRoot, ref), policy); }
  finally { shortRead.mock.restore(); syncBuiltinESMExports(); }
  for (const method of ["fstatSync", "readSync"] as const) {
    const failure = mock.method(fs, method, () => { throw new Error("synthetic descriptor failure"); });
    const closes = mock.method(fs, "closeSync"); syncBuiltinESMExports();
    try {
      assert.throws(() => readCheckpointArtifact(w.pmRoot, ref), refuses("checkpoint_artifact_corrupt"));
      assert.equal(closes.mock.callCount(), 1);
    } finally { failure.mock.restore(); closes.mock.restore(); syncBuiltinESMExports(); }
  }
  const original = readFileSync(file);
  fs.truncateSync(file, MAX_CHECKPOINT_BYTES + 1);
  assert.throws(() => readCheckpointArtifact(w.pmRoot, ref), refuses("checkpoint_artifact_corrupt"));
  unlinkSync(file); mkdirSync(file);
  assert.throws(() => readCheckpointArtifact(w.pmRoot, ref), refuses("checkpoint_artifact_corrupt"));
  fs.rmdirSync(file); writeFileSync(file, original);
});

test("checkpoint descriptor also bounds the benchmark legacy comparison before reading oversized files", async () => {
  const w = await checkpointWorkspace();
  const policy = prefixCheckpoint(new Array<number>(16).fill(0.125), { ...w.config.initial.arms[0].config.prefix, hashing_width: 16 });
  const ref = await encodeCheckpointArtifacts(w.pmRoot, "benchmark-bound", policy) as CheckpointArtifact;
  assert.ok(ref.bytes <= 4096);
  const file = checkpointArtifactPath(w.pmRoot, ref.digest);
  fs.truncateSync(file, MAX_CHECKPOINT_BYTES + 1);
  const reads = mock.method(fs, "readSync"); const pathReads = mock.method(fs, "readFileSync"); syncBuiltinESMExports();
  try {
    assert.throws(() => measureCheckpointLoads(w.pmRoot, ref, 1), refuses("checkpoint_artifact_corrupt"));
    assert.equal(reads.mock.callCount() + pathReads.mock.callCount(), 0, "oversized baseline must be refused before reading bytes");
  } finally { reads.mock.restore(); pathReads.mock.restore(); syncBuiltinESMExports(); }
});

test("checkpoint inspection structurally validates every ledger reference without reading its blob", async () => {
  const w = await checkpointWorkspace();
  const ref = await encodeCheckpointArtifacts(w.pmRoot, "healthy", initialImprover()) as CheckpointArtifact;
  const ledger = join(w.pmRoot, "artifacts/pm-rl/ledger");
  for (const [invalid, code] of [[null, "checkpoint_artifact_invalid"], [1, "checkpoint_artifact_invalid"], [{ ...ref, bytes: 0 }, "checkpoint_artifact_invalid"], [{ ...ref, digest: "../../escape" }, "rl_identifier_invalid"]] as const) {
    const text = JSON.stringify({ format: "pm-rl/checkpoint-ledger/1", key: "invalid", artifacts: [invalid] });
    const file = join(ledger, `${createHash("sha256").update(text).digest("hex")}.json`);
    writeFileSync(file, text);
    assert.throws(() => inspectCheckpointArtifact(w.pmRoot, ref.digest), refuses(code));
    unlinkSync(file);
  }
});

test("publication failure exposes neither a partial digest file nor a ledger root", async () => {
  const w = await checkpointWorkspace();
  const failure = mock.method(fs, "linkSync", () => { throw new Error("synthetic publication failure"); }); syncBuiltinESMExports();
  try { await assert.rejects(encodeCheckpointArtifacts(w.pmRoot, "failed", w.config.initial), /synthetic publication failure/); }
  finally { failure.mock.restore(); syncBuiltinESMExports(); }
  assert.deepEqual(readdirSync(join(w.pmRoot, "artifacts/pm-rl/sha256")), []);
  assert.deepEqual(readCheckpointLedger(w.pmRoot), []);
});

test("checkpoint batch publication writes one complete ledger root and retries idempotently", async () => {
  const w = await checkpointWorkspace();
  assert.equal(existsSync(join(w.root, ".git")), false);
  const prefix = prefixCheckpoint(new Array<number>(4096).fill(0.125), w.config.initial.arms[0].config.prefix);
  const value = { prefix, duplicate: prefix, improver: initialImprover() };
  const original = fs.linkSync;
  let ledgerAttempts = 0;
  const failure = mock.method(fs, "linkSync", (...args: Parameters<typeof original>) => {
    if (fs.realpathSync(dirname(String(args[1]))) === join(w.pmRoot, "artifacts/pm-rl/ledger")) {
      ledgerAttempts += 1;
      assert.equal(readdirSync(join(w.pmRoot, "artifacts/pm-rl/sha256")).length, 2, "all blobs precede the ledger root");
      throw new Error("synthetic ledger publication failure");
    }
    return original(...args);
  }); syncBuiltinESMExports();
  try { await assert.rejects(encodeCheckpointArtifacts(w.pmRoot, "batch", value), /synthetic ledger publication failure/); }
  finally { failure.mock.restore(); syncBuiltinESMExports(); }
  assert.equal(ledgerAttempts, 1);
  assert.deepEqual(readdirSync(join(w.pmRoot, "artifacts/pm-rl/ledger")), []);
  const refs = await encodeCheckpointArtifacts(w.pmRoot, "batch", value) as Record<keyof typeof value, CheckpointArtifact>;
  await encodeCheckpointArtifacts(w.pmRoot, "batch", value);
  assert.deepEqual(readCheckpointLedger(w.pmRoot), [{ format: "pm-rl/checkpoint-ledger/1", key: "batch", artifacts: [refs.prefix, refs.improver] }]);
  const ledger = join(w.pmRoot, "artifacts/pm-rl/ledger"); const files = readdirSync(ledger);
  assert.equal(files.length, 1);
  assert.equal(files[0], `${createHash("sha256").update(readFileSync(join(ledger, files[0]))).digest("hex")}.json`);
  assert.deepEqual(decodeCheckpointArtifacts(w.pmRoot, refs), value);
  assert.deepEqual(await collectCheckpointArtifacts(w.pmRoot), { retained: 2, removed: 0 });
});

test("checkpoint batch publication refuses oversized ledger metadata before publishing any blob", async () => {
  const w = await checkpointWorkspace();
  const knobs = { regularisation: 0.001, ngram_order: 2, hashing_width: 16 };
  const policies = Array.from({ length: 8192 }, (_, index) => prefixCheckpoint(new Array<number>(16).fill(index / 8192), knobs));
  const writes = mock.method(fs, "linkSync", () => { throw new Error("unexpected publication before ledger validation"); }); syncBuiltinESMExports();
  try {
    await assert.rejects(encodeCheckpointArtifacts(w.pmRoot, "oversized-batch", policies), refuses("checkpoint_artifact_invalid"));
    await assert.rejects(encodeCheckpointArtifacts(w.pmRoot, "x".repeat(MAX_CHECKPOINT_BYTES), policies[0]), refuses("checkpoint_artifact_invalid"));
    assert.equal(writes.mock.callCount(), 0);
  } finally { writes.mock.restore(); syncBuiltinESMExports(); }
  assert.equal(existsSync(join(w.pmRoot, "artifacts/pm-rl/sha256")), false);
  assert.deepEqual(readCheckpointLedger(w.pmRoot), []);
});

test("plain-directory controllers never invoke Git and honor discovery ceilings", async () => {
  const w = await checkpointWorkspace();
  const ceiling = process.env.GIT_CEILING_DIRECTORIES;
  delete process.env.GIT_CEILING_DIRECTORIES;
  try {
    assert.equal(controllerHasGitAncestor(w.root), false);
    assert.equal(controllerAuthorityRoot(w.pmRoot), w.pmRoot);
  } finally { if (ceiling !== undefined) process.env.GIT_CEILING_DIRECTORIES = ceiling; }
  assert.equal(controllerHasGitAncestor(w.root, ""), false);
  const git = join(w.root, ".git"); mkdirSync(git);
  const nested = join(w.root, "nested"); mkdirSync(nested);
  assert.equal(controllerHasGitAncestor(nested, ""), true);
  assert.equal(controllerHasGitAncestor(nested, w.root), false);
  fs.rmdirSync(git);
  const original = childProcess.execFileSync; let gitCalls = 0;
  const spy = mock.method(childProcess, "execFileSync", (...args: Parameters<typeof original>) => {
    if (args[0] === "git") { gitCalls += 1; throw new Error("Git probe on a plain tracker"); }
    return original(...args);
  }); syncBuiltinESMExports();
  try {
    const result = await withRlController(w.client, w.coordinates, { id: "nogit", approval: w.approval, recoveryCommand: "pm rl improver run nogit" }, AbortSignal.timeout(60_000), async (step) => step("proof", {}, async () => ({ ok: true })));
    assert.deepEqual(result, { ok: true }); assert.equal(gitCalls, 0);
    mkdirSync(git);
    await withRlController(w.client, w.coordinates, { id: "unavailable", approval: w.approval, recoveryCommand: "pm rl improver run unavailable" }, AbortSignal.timeout(60_000), async (step) => step("proof", {}, async () => ({ ok: true })));
    assert.equal(gitCalls, 0, "unavailable Git executable must preserve standalone operations");
    fs.rmdirSync(git);
  } finally { spy.mock.restore(); syncBuiltinESMExports(); }
});

test("mixed Git executable availability preserves shared worktree authority and launch refusal", async () => {
  const w = await checkpointWorkspace();
  childProcess.execFileSync("git", ["init", "-b", "main"], { cwd: w.root, stdio: "ignore" });
  writeFileSync(join(w.root, "tracked"), "fixture");
  childProcess.execFileSync("git", ["add", "tracked"], { cwd: w.root });
  childProcess.execFileSync("git", ["-c", "user.name=Test Agent", "-c", "user.email=test@example.invalid", "commit", "-m", "Fixture"], { cwd: w.root, stdio: "ignore" });
  const second = join(w.root, "peer");
  childProcess.execFileSync("git", ["worktree", "add", second, "-b", "peer"], { cwd: w.root, stdio: "ignore" });
  const client = new PmClient({ cwd: second, pmRoot: join(second, ".agents/pm"), author: "checkpoint-test", noExtensions: true });
  await client.init("rl", { defaults: true, agentGuidance: "skip", author: "checkpoint-test" });
  const coordinates = { ...w.coordinates, pmRoot: join(second, ".agents/pm") };
  const expected = join(fs.realpathSync(join(w.root, ".git")), "pm-rl-controllers");
  assert.equal(controllerAuthorityRoot(w.pmRoot), expected);
  assert.equal(controllerAuthorityRoot(coordinates.pmRoot), expected);
  const request = { id: "mixed", approval: w.approval, recoveryCommand: "pm rl improver run mixed" };
  const runPeer = () => withRlController(client, coordinates, request, AbortSignal.timeout(60_000), async () => { throw new Error("peer executed"); });
  const original = childProcess.execFileSync;
  let gitCalls = 0;
  const spy = mock.method(childProcess, "execFileSync", (...args: Parameters<typeof original>) => {
    if (args[0] === "git") { gitCalls += 1; throw new Error("Git unavailable for peer"); }
    return original(...args);
  });
  try {
    await withRlController(w.client, w.coordinates, request, AbortSignal.timeout(60_000), async () => {
      syncBuiltinESMExports();
      await assert.rejects(runPeer(), refuses("loop_controller_active"));
    });
    await assert.rejects(runPeer(), refuses("loop_launch_elsewhere"));
    assert.equal(gitCalls, 0, "authority selection must not depend on Git executable resolution");
  } finally { spy.mock.restore(); syncBuiltinESMExports(); }
  const marker = join(second, ".git");
  const pointer = readFileSync(marker, "utf8");
  for (const malformed of ["invalid", "gitdir: missing\n"]) {
    writeFileSync(marker, malformed);
    assert.throws(() => controllerAuthorityRoot(coordinates.pmRoot), refuses("loop_git_metadata_unavailable"));
  }
  writeFileSync(marker, pointer);
  const metadata = pointer.trim().slice("gitdir: ".length);
  const commonFile = join(metadata, "commondir"); const common = readFileSync(commonFile, "utf8");
  writeFileSync(commonFile, w.root);
  assert.throws(() => controllerAuthorityRoot(coordinates.pmRoot), refuses("loop_git_metadata_unavailable"));
  writeFileSync(commonFile, common);
  for (const target of [join(metadata, "HEAD"), join(w.root, ".git", "objects")]) {
    const saved = `${target}-saved`; fs.renameSync(target, saved);
    try {
      if (target.endsWith("HEAD")) mkdirSync(target); else writeFileSync(target, "not a directory");
      assert.throws(() => controllerAuthorityRoot(coordinates.pmRoot), refuses("loop_git_metadata_unavailable"));
    } finally {
      if (target.endsWith("HEAD")) fs.rmdirSync(target); else unlinkSync(target);
      fs.renameSync(saved, target);
    }
  }
});

test("large learner trains, promotes, resumes and audits by digest with no Git executable", { timeout: 900_000 }, async () => {
  const w = await checkpointWorkspace();
  const bin = checkpointToolBin(w.root);
  const originalPath = process.env.PATH; const originalCeiling = process.env.GIT_CEILING_DIRECTORIES;
  process.env.PATH = bin; process.env.GIT_CEILING_DIRECTORIES = dirname(w.root);
  try {
    assert.equal(existsSync(join(w.root, ".git")), false);
    const request = { id: "capacity", config: w.config, dataset: w.dataset, approval: w.approval };
    await assert.rejects(runRecursiveImprover(w.client, w.coordinates, { ...request, onStep(key) { if (key === "g1-d-t0-c0") throw new Error("crash after promotion"); } }), /crash after promotion/);
    const jobs = await listProcessJobs(w.client); assert.equal(jobs.length, 1); assert.equal(jobs[0].state, "promoted");
    const trialReceipt = String((await w.client.get("capacity-step-g1-d-t0-c0")).item.body);
    assert.equal(trialReceipt.includes('"weights"'), false, "durable phase receipts must retain checkpoint references");
    assert.ok(trialReceipt.includes("pm-rl/checkpoint-artifact/1"));
    const ref = jobs[0].completion!.artifact!; assert.ok(ref.bytes > 4096);
    assert.equal(measureCheckpointLoads(w.pmRoot, ref, 2).legacy_4096_byte_reader, null);
    const staged = JSON.parse(readFileSync(join(processStaging(w.pmRoot, jobs[0].id), "completion.json"), "utf8")) as { policy: object };
    assert.deepEqual(Object.keys(staged.policy), ["digest"]);
    assert.ok(lstatSync(join(processStaging(w.pmRoot, jobs[0].id), "checkpoint.json")).size < 4096);
    assert.ok(lstatSync(join(processStaging(w.pmRoot, jobs[0].id), "completion.json")).size < 4096);
    const report = await runRecursiveImprover(w.client, w.coordinates, request);
    assert.ok(report.generations[0].development.trials[0].trial.promoted);
    assert.equal((await listProcessJobs(w.client)).length, 5, "resume must reuse the promoted learner");
    assert.deepEqual(await runRecursiveImprover(w.client, w.coordinates, request), report);
    assert.equal((await listProcessJobs(w.client)).length, 5, "replay must launch no trainer");
    const retained = report.generations[0].development.learners[0].checkpoint;
    assert.deepEqual(readCheckpointArtifact(w.pmRoot, ref), retained);
    assert.deepEqual((await readProcessJob(w.client, jobs[0].id, w.pmRoot))!.completion!.policy, retained);
    const harness = await createExtensionTestHarness(extension, { name: "pm-rl", capabilities: ["commands", "hooks", "schema"] });
    const shown = await harness.runCommand({ command: "rl checkpoint show", pmRoot: w.pmRoot, args: [ref.digest] });
    assert.ok(JSON.stringify(shown).includes(retained.digest));
    await harness.runCommand({ command: "rl checkpoint gc", pmRoot: w.pmRoot });
    const file = checkpointArtifactPath(w.pmRoot, ref.digest); const original = readFileSync(file);
    const before = await listProcessJobs(w.client);
    for (const missing of [false, true]) {
      if (missing) unlinkSync(file); else writeFileSync(file, "corrupt");
      await assert.rejects(runRecursiveImprover(w.client, w.coordinates, request), refuses(missing ? "checkpoint_artifact_missing" : "checkpoint_artifact_corrupt"));
      assert.deepEqual(await listProcessJobs(w.client), before, "damaged promoted checkpoints must never retrain");
      writeFileSync(file, original);
    }
    const knobs = retained.knobs;
    const source = prefixCheckpoint(new Array<number>(knobs.hashing_width).fill(0), knobs);
    const input: ProcessInput<typeof source> = { identity: { programme_id: "integrity" }, source, training: [], observations: [], training_config: { learning_rate: 0.5, steps: 1 }, lineage: {}, prefix: { knobs, rows: [{ prefix: { events: ["create"], fields: [], words: [100], authors: 1, elapsed_ms: 0 }, label: 0 }] } };
    const job = await executeImproverFit(w.client, w.coordinates, input, w.approval, AbortSignal.timeout(60_000));
    const checkpoint = checkpointArtifactPath(w.pmRoot, job.completion!.artifact!.digest);
    unlinkSync(checkpoint);
    const beforeMissing = await listProcessJobs(w.client);
    await assert.rejects(executeImproverFit(w.client, w.coordinates, input, w.approval, AbortSignal.timeout(60_000)), refuses("checkpoint_artifact_missing"));
    assert.deepEqual(await listProcessJobs(w.client), beforeMissing, "missing completed artifacts may not consume a recovery attempt");
    const stage = processStaging(w.pmRoot, jobs[0].id);
    const completionFile = join(stage, "completion.json"); const completionText = readFileSync(completionFile, "utf8"); const completionStat = lstatSync(completionFile);
    const completion = JSON.parse(completionText) as typeof jobs[0]["completion"];
    const originalInput: ProcessInput<typeof source> = { ...input, source: prefixCheckpoint(new Array<number>(retained.knobs.hashing_width).fill(0), retained.knobs), training_config: completion!.training_config, lineage: completion!.lineage, prefix: { knobs: retained.knobs, rows: [] } };
    for (const changes of [{ artifact: undefined }, { artifact: { ...completion!.artifact!, policy: `sha256:${"a".repeat(64)}` } }, { policy: { digest: `sha256:${"a".repeat(64)}` } }, { digest: `sha256:${"a".repeat(64)}` }]) {
      writeFileSync(completionFile, JSON.stringify({ ...completion, ...changes }));
      assert.throws(() => validateProcessCompletion(stage, jobs[0].id, originalInput, jobs[0].allowance, w.pmRoot), refuses("process_checkpoint_invalid"));
    }
    writeFileSync(completionFile, " ".repeat(4097));
    assert.throws(() => validateProcessCompletion(stage, jobs[0].id, originalInput, jobs[0].allowance, w.pmRoot), refuses("process_receipt_invalid"));
    writeFileSync(completionFile, completionText);
    utimesSync(completionFile, completionStat.atime, completionStat.mtime);
    assert.throws(() => validateProcessCompletion(stage, jobs[0].id, { ...originalInput, prefix: undefined }, jobs[0].allowance, w.pmRoot), refuses("process_checkpoint_invalid"));
    assert.throws(() => validateProcessCompletion(stage, jobs[0].id, originalInput, { ...jobs[0].allowance, wall_ms: 900_000, storage_bytes: stagingBytes(stage) + ref.bytes - 1 }, w.pmRoot),
      (error: unknown) => refuses("process_limit_exceeded")(error) && error instanceof Error && error.message.includes("artifact exceeded"));
  } finally { process.env.PATH = originalPath; if (originalCeiling === undefined) delete process.env.GIT_CEILING_DIRECTORIES; else process.env.GIT_CEILING_DIRECTORIES = originalCeiling; }
});

test("checkpoint benchmark measures both capacities and verified load paths on a sealed corpus", { timeout: 900_000 }, async () => {
  await withTrackerSources(async (source) => {
    const dataset = join(source.root, "checkpoint-data"); buildTrackerDataset(source.directories, dataset, 42, { task: "history-prefix" });
    const output = join(source.root, "checkpoint-evidence.json");
    const moduleUrl = new URL("../scripts/checkpoint-benchmark.ts", import.meta.url).href;
    await checkpointBenchmarkMain([process.execPath, new URL(moduleUrl).pathname, dataset, relative(process.cwd(), join(source.root, "benchmark")), output], moduleUrl, { ...liveMetaConfiguration(), meta_generations: 1, candidates: 1 });
    const evidence = JSON.parse(readFileSync(output, "utf8")) as { runs: { hashing_width: number; checkpoints: { checkpoint_bytes: number; legacy_4096_byte_reader: object | null }[] }[] };
    assert.equal(JSON.stringify(evidence).includes('"weights"'), false, "publish measurements and digests without committing checkpoint payloads");
    assert.deepEqual(evidence.runs.map((run) => run.hashing_width), [32, 4096]);
    assert.ok(evidence.runs[0].checkpoints.every((checkpoint) => checkpoint.legacy_4096_byte_reader !== null));
    assert.ok(evidence.runs[1].checkpoints.some((checkpoint) => checkpoint.checkpoint_bytes > 4096));
  });
});

test("two processes promote into one plain tracker without losing roots or corrupting shared artifacts", { timeout: 900_000 }, async () => {
  const w = await checkpointWorkspace();
  const file = join(w.root, "request.json"); const config = w.config.initial.arms[1].config;
  writeFileSync(file, JSON.stringify({ root: w.root, pmRoot: w.pmRoot, dataset: w.dataset, manifest: w.manifest, approval: w.approval, config }));
  const bin = checkpointToolBin(w.root);
  const children = ["writer-one", "writer-two"].map((job) => fork(new URL("./fixtures/checkpoint-promoter.ts", import.meta.url), [file, job], { env: { ...process.env, PATH: bin, GIT_CEILING_DIRECTORIES: dirname(w.root), PM_LOCK_WAIT_MS: "30000" }, stdio: ["ignore", "pipe", "pipe", "ipc"] }));
  try {
    const ready = children.map((child) => once(child, "message"));
    const exits = children.map((child) => once(child, "exit"));
    const errors: string[] = []; for (const child of children) child.stderr!.on("data", (data: Buffer) => errors.push(String(data)));
    await Promise.all(ready);
    const results = children.map((child) => once(child, "message"));
    for (const child of children) child.send({ go: true });
    await collectCheckpointArtifacts(w.pmRoot);
    const completed = await Promise.race([Promise.all(results), Promise.all(exits).then((codes) => { throw new Error(`Promoters exited before receipts: ${JSON.stringify(codes)} ${errors.join("\n")}`); })]);
    const trials = completed.map(([result]) => (result as { trial: LearnerTrial }).trial);
    assert.ok(trials.every((trial) => trial.promoted));
    assert.deepEqual(trials[0].candidate.checkpoint, trials[1].candidate.checkpoint);
    assert.deepEqual((await Promise.all(exits)).map(([code]) => code), [0, 0], errors.join("\n"));
    const jobs = await listProcessJobs(w.client); assert.equal(jobs.length, 2); assert.ok(jobs.every((job) => job.state === "promoted"));
    for (const job of jobs) assert.deepEqual(readCheckpointArtifact(w.pmRoot, job.completion!.artifact!), trials[0].candidate.checkpoint);
    const roots = readCheckpointLedger(w.pmRoot);
    for (const job of jobs) assert.ok(roots.some((entry) => entry.key === `job:${job.id}:promoted`));
    assert.equal((await collectCheckpointArtifacts(w.pmRoot)).retained, 1);
  } finally { for (const child of children) if (child.exitCode === null) child.kill("SIGKILL"); }
});


test("checkpoint operations refuse a directory link swapped between check and use", async (t) => {
  for (const boundary of ["mkdir", "open", "write", "link", "unlink"] as const) {
    await t.test(boundary, async () => {
    const w = await checkpointWorkspace();
    const outside = join(w.root, "outside"); mkdirSync(outside); writeFileSync(join(outside, "sentinel"), "untouched");
    const artifacts = join(w.pmRoot, "artifacts"); mkdirSync(artifacts);
    const saved = join(w.pmRoot, "saved-artifacts");
    let swapped = false;
    /** Replace only this disposable store; descriptor-relative calls must never enter the link. */
    function swap(): void { if (!swapped) { swapped = true; fs.renameSync(artifacts, saved); symlinkSync(outside, artifacts, "dir"); } }
    const method = { mkdir: "mkdirSync", open: "openSync", write: "writeFileSync", link: "linkSync", unlink: "unlinkSync" }[boundary] as "mkdirSync" | "openSync" | "writeFileSync" | "linkSync" | "unlinkSync";
    const native = fs[method];
    const hook = mock.method(fs, method, (...args: unknown[]) => {
      const path = String(args[0]);
      if ((boundary === "mkdir" && (path.endsWith("/artifacts") || path.endsWith("/pm-rl") || path.endsWith("/sha256")))
        || (boundary === "open" && path.includes(".pending-"))
        || (boundary === "write" && typeof args[0] === "number")
        || boundary === "link" || boundary === "unlink") swap();
      return Reflect.apply(native, fs, args);
    }); syncBuiltinESMExports();
    try { await assert.rejects(encodeCheckpointArtifacts(w.pmRoot, `swap-${boundary}`, initialImprover()), refuses("rl_state_path_invalid")); }
    finally { hook.mock.restore(); syncBuiltinESMExports(); }
    assert.ok(swapped, boundary);
    assert.deepEqual(readdirSync(outside), ["sentinel"]); assert.equal(readFileSync(join(outside, "sentinel"), "utf8"), "untouched");
    });
  }
});

test("checkpoint publication permits a symlinked ancestor above its root", async () => {
  const w = await checkpointWorkspace(); const alias = join(w.root, "parent-alias");
  symlinkSync(dirname(w.pmRoot), alias, "dir"); const root = join(alias, w.pmRoot.split("/").at(-1)!);
  const value = initialImprover(); const ref = await encodeCheckpointArtifacts(root, "ancestor-allowed", value) as CheckpointArtifact;
  assert.deepEqual(readCheckpointArtifact(root, ref), value); assert.equal(readCheckpointLedger(root).length, 1);
});


test("unsupported checkpoint runtimes refuse writes while retaining existing checkpoint reads", async () => {
  const w = await checkpointWorkspace(); const existing = await checkpointWorkspace();
  const value = initialImprover(); const ref = await encodeCheckpointArtifacts(existing.pmRoot, "retained", value) as CheckpointArtifact;
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  try {
    Object.defineProperty(process, "platform", { ...platform, value: "unsupported" });
    await assert.rejects(encodeCheckpointArtifacts(w.pmRoot, "unsupported", value), refuses("checkpoint_storage_unsupported"));
    await assert.rejects(collectCheckpointArtifacts(w.pmRoot), refuses("checkpoint_storage_unsupported"));
    assert.deepEqual(readCheckpointArtifact(existing.pmRoot, ref), value);
    assert.deepEqual(inspectCheckpointArtifact(existing.pmRoot, ref.digest), { artifact: ref, value });
    assert.equal(readCheckpointLedger(existing.pmRoot).length, 1);
    assert.deepEqual(readCheckpointLedger(w.pmRoot), []);
  } finally { Object.defineProperty(process, "platform", platform); }
  assert.equal(existsSync(join(w.pmRoot, "artifacts")), false);
});

test("descriptor traversal refuses unavailable procfs, inode mismatch and no-follow errors", async () => {
  for (const mode of ["missing", "denied", "mismatch", "link", "mkdir"] as const) {
    const w = await checkpointWorkspace();
    const open = fs.openSync; const stat = fs.fstatSync; const mkdir = fs.mkdirSync;
    let stats = 0;
    const opens = mock.method(fs, "openSync", (...args: Parameters<typeof open>) => {
      if (String(args[0]).startsWith("/proc/self/fd/") && ["missing", "denied"].includes(mode)) throw Object.assign(new Error("unavailable procfs"), { code: mode === "denied" ? "EACCES" : "ENOENT" });
      if (String(args[0]).endsWith("/pm-rl") && mode === "link") throw Object.assign(new Error("link substitution"), { code: "ELOOP" });
      return open(...args);
    });
    const statsHook = mock.method(fs, "fstatSync", (handle: number) => {
      const result = stat(handle);
      return mode === "mismatch" && ++stats === 2 ? { ...result, ino: Number(result.ino) + 1 } : result;
    });
    const mkdirHook = mock.method(fs, "mkdirSync", (...args: Parameters<typeof mkdir>) => {
      if (String(args[0]).startsWith("/proc/self/fd/") && mode === "mkdir") throw new Error("synthetic descriptor mkdir failure");
      return mkdir(...args);
    }); syncBuiltinESMExports();
    try {
      await assert.rejects(encodeCheckpointArtifacts(w.pmRoot, mode, initialImprover()), mode === "mkdir" ? /synthetic descriptor mkdir failure/ : refuses(mode === "link" ? "rl_state_path_invalid" : "checkpoint_storage_unsupported"));
    } finally { opens.mock.restore(); statsHook.mock.restore(); mkdirHook.mock.restore(); syncBuiltinESMExports(); }
  }
});


test("checkpoint descriptor checks refuse replacement by another ordinary directory", async () => {
  const w = await checkpointWorkspace(); const artifacts = join(w.pmRoot, "artifacts"); mkdirSync(artifacts);
  const write = fs.writeFileSync; let replaced = false;
  const hook = mock.method(fs, "writeFileSync", (...args: Parameters<typeof write>) => {
    if (!replaced && typeof args[0] === "number") {
      replaced = true; fs.renameSync(artifacts, join(w.pmRoot, "old-artifacts")); mkdirSync(artifacts);
    }
    return write(...args);
  }); syncBuiltinESMExports();
  try { await assert.rejects(encodeCheckpointArtifacts(w.pmRoot, "replaced", initialImprover()), refuses("rl_state_path_invalid")); }
  finally { hook.mock.restore(); syncBuiltinESMExports(); }
  assert.ok(replaced); assert.deepEqual(readdirSync(artifacts), []);
});


test("checkpoint publication refuses a pending leaf replaced with a link at publication", async () => {
  const w = await checkpointWorkspace(); const outside = join(w.root, "outside.json"); writeFileSync(outside, "sentinel");
  const link = fs.linkSync; let swapped = false;
  const hook = mock.method(fs, "linkSync", (...args: Parameters<typeof link>) => {
    if (!swapped) { swapped = true; unlinkSync(args[0]); symlinkSync(outside, args[0]); }
    return link(...args);
  }); syncBuiltinESMExports();
  try { await assert.rejects(encodeCheckpointArtifacts(w.pmRoot, "leaf-substitution", initialImprover()), refuses("rl_state_path_invalid")); }
  finally { hook.mock.restore(); syncBuiltinESMExports(); }
  assert.ok(swapped); assert.equal(readFileSync(outside, "utf8"), "sentinel");
  assert.equal(existsSync(join(w.pmRoot, "artifacts/pm-rl/ledger")), false);
});


test("checkpoint ledger reads never create missing storage or replace an invalid store", async () => {
  const w = await checkpointWorkspace();
  assert.deepEqual(readCheckpointLedger(w.pmRoot), []);
  assert.equal(existsSync(join(w.pmRoot, "artifacts")), false);
  const store = join(w.pmRoot, "artifacts", "pm-rl"); mkdirSync(store, { recursive: true });
  const ledger = join(store, "ledger"); writeFileSync(ledger, "retain invalid storage for inspection");
  assert.throws(() => readCheckpointLedger(w.pmRoot), (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOTDIR");
  assert.equal(readFileSync(ledger, "utf8"), "retain invalid storage for inspection");
});
