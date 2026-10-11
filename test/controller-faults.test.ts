/** Native SDK lock races and unreadable durable receipts in disposable real trackers. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join, relative } from "node:path";
import { test } from "node:test";
import { setActiveExtensionHooks, type ExtensionApi, type OnWriteHook } from "@unbrained/pm-cli";
import { PmClient, type GetResult } from "@unbrained/pm-cli/sdk/core";
import { acquireLock, getHistoryPath, getItemPath, init, isPmCliExpectedError, normalizeItemId, readSettings, EXIT_CODE } from "@unbrained/pm-cli/sdk/runtime";
import { createExtensionTestHarness } from "@unbrained/pm-cli/sdk/testing";
import { loopLeaseLockId, loopProcessIdentityIO, loopProcessStartTime, LOOP_LEASE_TTL_SECONDS, resumeRlLoop, runRlLoop, type JsonValue, type LoopProcessIdentityIO, type RefusalAuditContext } from "../index.ts";
import { lmConfigurationJson, parseLmLoopConfig } from "../lm.ts";

const author = "native-fault-test";
const id = "native-fault";
const config: Record<string, JsonValue> = { ...JSON.parse(readFileSync(new URL("../examples/loop-bandit.json", import.meta.url), "utf8")) as Record<string, JsonValue>, max_generations: 1 };
const bounded = { timeout: 120_000 };
const completeRead = { depth: "standard", outputLimit: "unbounded", outputBudget: "unbounded" } as const;

/** Read a complete real SDK item and reject an omitted-output envelope. */
async function completeItem(client: PmClient, key: string): Promise<GetResult> {
  const result = await client.get(key, completeRead);
  assert.ok("item" in result, "the unbounded SDK read must retain the actual item");
  return result;
}

/** Initialize one real tracker, then release observational hooks and all disposable files. */
async function inWorkspace(operation: (fixture: { root: string; pmRoot: string; client: PmClient; approval: string }) => Promise<void>): Promise<void> {
  const previousCwd = process.cwd();
  const root = mkdtempSync(join(tmpdir(), "pm-rl-native-fault-"));
  try {
    const initialized = await init("rl", { defaults: true, agentGuidance: "skip", author }, { cwd: root, pmRoot: join(root, ".agents", "pm") });
    const client = new PmClient({ cwd: root, pmRoot: initialized.path, author, noExtensions: true });
    const approval = await client.create({ id: "approval", title: "Bounded native fault drill", type: "Decision", body: '```json\n{"permitted_promotions":1}\n```' });
    await operation({ root, pmRoot: initialized.path, client, approval: String(approval.item.id) });
  } finally {
    setActiveExtensionHooks(null);
    process.chdir(previousCwd);
    rmSync(root, { recursive: true, force: true });
  }
}

/** Read an actual SDK-created lock record, requiring its native ownership coordinates. */
function readNativeLock(path: string): Record<string, unknown> {
  const value: unknown = JSON.parse(readFileSync(path, "utf8"));
  assert.ok(value !== null && typeof value === "object" && !Array.isArray(value));
  const record = value as Record<string, unknown>;
  assert.equal(typeof record["token"], "string");
  assert.equal(record["pid"], process.pid);
  return record;
}

/** Publish a whole native record by replacing the pathname while preserving its old inode. */
function replaceNativeLock(path: string, record: Record<string, unknown>): void {
  const temporary = `${path}.${randomUUID()}.drill`;
  try {
    writeFileSync(temporary, `${JSON.stringify(record)}\n`, { flag: "wx" });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

/** Seed a genuine SDK phase mutex whose local PID has an obsolete birth identity. */
async function deadPhaseMutex(pmRoot: string): Promise<{ path: string; release: () => Promise<void> }> {
  const lock = `${loopLeaseLockId(id)}-recovery`;
  const release = await acquireLock(pmRoot, lock, 1_000_000_000, "previous-phase-holder");
  const path = join(pmRoot, "locks", `${lock}.lock`);
  const start = loopProcessStartTime(process.pid);
  assert.ok(start !== null);
  replaceNativeLock(path, { ...readNativeLock(path), hostname: hostname(), process_start_time: `${start}:obsolete` });
  return { path, release };
}

/** Delegate every OS probe, mutating storage only during classification of the seeded holder. */
function duringHolderProbe(mutate: () => void): { io: LoopProcessIdentityIO; probes: () => number } {
  let count = 0;
  return {
    io: { ...loopProcessIdentityIO, exec(file, args) {
      const result = loopProcessIdentityIO.exec(file, args);
      count += 1;
      if (count === 2) mutate();
      return result;
    } },
    probes: () => count,
  };
}

/** Capture domain bytes, excluding only explicitly permitted seed claim metadata and journals. */
function domainFiles(pmRoot: string, excluded: readonly string[] = []): Record<string, string> {
  const files: Record<string, string> = {};
  /** Walk only the disposable tracker, retaining actual domain document and history bytes. */
  function visit(directory: string): void {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const name = relative(pmRoot, path);
      if (entry.isDirectory() && !["runtime", "locks", "cache"].includes(entry.name)) visit(path);
      else if (entry.isFile() && (entry.name.endsWith(".toon") || (directory === join(pmRoot, "history") && entry.name.endsWith(".jsonl"))) && !excluded.includes(entry.name)) files[name] = readFileSync(path, "utf8");
    }
  }
  visit(pmRoot);
  return files;
}

/** Require the domain error rather than accepting an arbitrary rejected promise. */
function refusal(code: string): (error: unknown) => boolean {
  return (error) => {
    assert.ok(isPmCliExpectedError(error));
    assert.equal(error.context.code, code);
    return true;
  };
}

/** Activate a supported native write observer immediately after the real own-birth probe. */
async function nativeWriteObserver(observe: OnWriteHook) {
  const harness = await createExtensionTestHarness({ activate(api: ExtensionApi) { api.hooks.onWrite(observe); } }, { name: "native-fault-observer", capabilities: ["hooks"] });
  const io: LoopProcessIdentityIO = { ...loopProcessIdentityIO, exec(file, args) {
    const result = loopProcessIdentityIO.exec(file, args);
    setActiveExtensionHooks(harness.activation.hooks);
    return result;
  } };
  return { io, cleanup: async () => { setActiveExtensionHooks(null); await harness.deactivate(); } };
}

test("a dead phase mutex disappearing before open recovers with one budget and promotion", bounded, async () => {
  await inWorkspace(async ({ pmRoot, client, approval }) => {
    const mutex = await deadPhaseMutex(pmRoot);
    const probe = duringHolderProbe(() => rmSync(mutex.path));
    try {
      const report = await runRlLoop(client, { pmRoot, author }, { id, config, approval, processIdentityIO: probe.io });
      assert.ok(probe.probes() >= 2);
      assert.equal(report.promoted, 1);
      assert.equal(report.samples_consumed, config["samples_per_generation"]);
      assert.equal(report.generations.length, 1);
      for (const key of [`${id}-seed`, `${id}-g1`, ...["collect", "train", "evaluate", "promote"].map((phase) => `${id}-g1-step-${phase}`)]) {
        const item = await completeItem(client, key);
        const history = readFileSync(getHistoryPath(pmRoot, String(item.item.id)), "utf8");
        assert.equal(history.split("\n").filter((line) => line.includes('"op":"create"')).length, 1);
      }
      assert.deepEqual(readdirSync(join(pmRoot, "locks")), []);
    } finally { await mutex.release(); }
  });
});

test("a successor phase token survives replacement between observation and open", bounded, async () => {
  await inWorkspace(async ({ pmRoot, client, approval }) => {
    const mutex = await deadPhaseMutex(pmRoot);
    const before = domainFiles(pmRoot);
    const successor = { ...readNativeLock(mutex.path), token: randomUUID(), owner: "successor-phase-holder", process_start_time: loopProcessStartTime(process.pid) };
    const probe = duringHolderProbe(() => replaceNativeLock(mutex.path, successor));
    try {
      await assert.rejects(runRlLoop(client, { pmRoot, author }, { id, config, approval, processIdentityIO: probe.io }), refusal("loop_controller_active"));
      assert.ok(probe.probes() >= 2);
      assert.deepEqual(readNativeLock(mutex.path), successor);
      assert.deepEqual(domainFiles(pmRoot), before);
      assert.equal(existsSync(join(pmRoot, "locks", `${loopLeaseLockId(id)}.lock`)), false);
      await mutex.release();
      assert.deepEqual(readNativeLock(mutex.path), successor);
    } finally { await mutex.release(); }
  });
});

test("a real phase open failure propagates and preserves another main holder", bounded, async () => {
  await inWorkspace(async ({ pmRoot, client, approval }) => {
    const mutex = await deadPhaseMutex(pmRoot);
    const main = join(pmRoot, "locks", `${loopLeaseLockId(id)}.lock`);
    const releaseMain = await acquireLock(pmRoot, loopLeaseLockId(id), LOOP_LEASE_TTL_SECONDS, "other-main-holder");
    const mainBytes = readFileSync(main, "utf8");
    const before = domainFiles(pmRoot);
    const sentinel = "successor-owned directory";
    const probe = duringHolderProbe(() => { rmSync(mutex.path); mkdirSync(mutex.path); writeFileSync(join(mutex.path, "holder"), sentinel); });
    try {
      await assert.rejects(runRlLoop(client, { pmRoot, author }, { id, config, approval, processIdentityIO: probe.io }), (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.ok(["EISDIR", "EACCES", "EPERM"].includes(String((error as NodeJS.ErrnoException).code)));
        return true;
      });
      assert.ok(probe.probes() >= 2);
      assert.equal(readFileSync(main, "utf8"), mainBytes);
      assert.equal(readFileSync(join(mutex.path, "holder"), "utf8"), sentinel);
      assert.deepEqual(domainFiles(pmRoot), before);
    } finally { await releaseMain(); await mutex.release(); }
  });
});

for (const fault of ["deleted", "directory"] as const) {
  test(`native phase acquisition followed by ${fault} identity storage fails without advancing`, bounded, async () => {
    await inWorkspace(async ({ pmRoot, client, approval }) => {
      const path = join(pmRoot, "locks", `${loopLeaseLockId(id)}-recovery.lock`);
      const before = domainFiles(pmRoot);
      let published: Record<string, unknown> | undefined;
      const observer = await nativeWriteObserver(({ path: written, op }) => {
        if (written !== path || op !== "lock:create" || published !== undefined) return;
        published = readNativeLock(path);
        assert.equal(published["hostname"], undefined);
        rmSync(path);
        if (fault === "directory") { mkdirSync(path); writeFileSync(join(path, "holder"), JSON.stringify(published)); }
      });
      try {
        await assert.rejects(runRlLoop(client, { pmRoot, author }, { id, config, approval, processIdentityIO: observer.io }), (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.equal((error as NodeJS.ErrnoException).code, fault === "deleted" ? "ENOENT" : "EISDIR");
          return true;
        });
        assert.ok(published !== undefined, "the real SDK wrote its lock before identity publication failed");
        assert.deepEqual(domainFiles(pmRoot), before);
        assert.equal(existsSync(join(pmRoot, "locks", `${loopLeaseLockId(id)}.lock`)), false);
        if (fault === "directory") assert.deepEqual(JSON.parse(readFileSync(join(path, "holder"), "utf8")), published);
        else assert.equal(existsSync(path), false);
        assert.ok(!readdirSync(join(pmRoot, "locks")).some((name) => name.endsWith(".tmp") || name.endsWith(".stale-cleanup")));
      } finally { await observer.cleanup(); }
    });
  });
}

test("a native successor acquired between guard checks fences effects and preserves its seed claim", bounded, async () => {
  await inWorkspace(async ({ root, pmRoot, client, approval }) => {
    const main = join(pmRoot, "locks", `${loopLeaseLockId(id)}.lock`);
    const recovery = join(pmRoot, "locks", `${loopLeaseLockId(id)}-recovery.lock`);
    const successorClient = new PmClient({ cwd: root, pmRoot, author: "successor-controller", noExtensions: true });
    let armed = false;
    let displaced: unknown;
    let successor: Record<string, unknown> | undefined;
    let baseline: Record<string, string> | undefined;
    let releaseSuccessor: (() => Promise<void>) | undefined;
    const phases: string[] = [];
    const observer = await nativeWriteObserver(async ({ path, op }) => {
      if (!armed || path !== recovery || op !== "lock:create") return;
      armed = false;
      const previous = readNativeLock(main);
      displaced = previous["token"];
      replaceNativeLock(main, { ...previous, created_at: "1970-01-01T00:00:00.000Z" });
      releaseSuccessor = await acquireLock(pmRoot, loopLeaseLockId(id), LOOP_LEASE_TTL_SECONDS, "successor-controller", false, false, 0);
      successor = readNativeLock(main);
      await successorClient.claim(`${id}-seed`, { force: true, message: "Synthetic successor owns the seed after native lease takeover" });
      baseline = domainFiles(pmRoot);
    });
    try {
      await assert.rejects(runRlLoop(client, { pmRoot, author }, { id, config, approval, processIdentityIO: observer.io,
        onPhase(phase) { phases.push(phase); if (phase === "collect") armed = true; },
      }), refusal("loop_lease_lost"));
      assert.ok(successor !== undefined && baseline !== undefined, "the write observer acquired a real SDK successor before the second guard check");
      assert.notEqual(successor["token"], displaced);
      assert.deepEqual(readNativeLock(main), successor, "the displaced controller must not renew or rewrite the successor lease");
      assert.deepEqual(domainFiles(pmRoot), baseline, "no stale step write, audit write or claim cleanup after takeover");
      assert.deepEqual(phases, ["collect"]);
      assert.equal(existsSync(recovery), false);
      await assert.rejects(client.get(`${id}-g1-step-train`));
      const seed = await completeItem(client, `${id}-seed`);
      const history = readFileSync(getHistoryPath(pmRoot, String(seed.item.id)), "utf8");
      const last = JSON.parse(history.trim().split("\n").at(-1)!) as Record<string, unknown>;
      assert.equal(last["op"], "claim");
      assert.equal(last["author"], "successor-controller");
    } finally { await observer.cleanup(); await releaseSuccessor?.(); }
  });
});

for (const phase of ["collect", "train"] as const) {
  test(`a real SDK read failure on completed ${phase} storage refuses restart without overwriting evidence`, bounded, async () => {
    await inWorkspace(async ({ root, pmRoot, client, approval }) => {
      const coordinates = { pmRoot, author };
      await assert.rejects(runRlLoop(client, coordinates, { id, config, approval, onPhase(current) { if (current === phase) throw new Error("stop after durable completion"); } }), /stop after durable completion/u);
      const key = `${id}-g1-step-${phase}`;
      const item = await completeItem(client, key);
      const envelope = JSON.parse(String(item.item.body)) as Record<string, unknown>;
      assert.equal(envelope["state"], "complete");
      const path = getItemPath(pmRoot, "Decision", String(item.item.id));
      const original = readFileSync(path, "utf8");
      const preserved = join(root, "completed-receipt");
      renameSync(path, preserved);
      mkdirSync(path);
      writeFileSync(join(path, "holder"), "unreadable completed receipt");
      const seed = await completeItem(client, `${id}-seed`);
      const excluded = [`${String(seed.item.id)}.toon`, `${String(seed.item.id)}.jsonl`];
      const before = domainFiles(pmRoot, excluded);
      let readFailure: Error | undefined;
      await assert.rejects(client.get(key, completeRead), (error: unknown) => { assert.ok(error instanceof Error); readFailure = error; return true; });
      assert.ok(readFailure !== undefined);
      const expectedReadFailure = readFailure;
      const observedPhases: string[] = [];
      await assert.rejects(resumeRlLoop(client, coordinates, { id, approval, onPhase(current) { observedPhases.push(current); } }), (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(error.name, expectedReadFailure.name);
        assert.equal(error.message, expectedReadFailure.message);
        return true;
      });
      assert.deepEqual(observedPhases, []);
      assert.equal(readFileSync(preserved, "utf8"), original);
      assert.equal(readFileSync(join(path, "holder"), "utf8"), "unreadable completed receipt");
      assert.deepEqual(domainFiles(pmRoot, excluded), before);
      const afterSeed = await completeItem(client, String(seed.item.id));
      assert.equal(afterSeed.item.body, seed.item.body);
      assert.equal(afterSeed.item.status, seed.item.status);
      assert.equal(afterSeed.item.assignee, seed.item.assignee);
      assert.deepEqual(readdirSync(join(pmRoot, "locks")), []);
      rmSync(path, { recursive: true });
      renameSync(preserved, path);
      const repaired = await resumeRlLoop(client, coordinates, { id, approval });
      assert.equal(repaired.promoted, 1);
      assert.equal(repaired.samples_consumed, config["samples_per_generation"]);
      assert.equal(readFileSync(path, "utf8"), original, "restored completed evidence is reused byte for byte");
    });
  });
}

test("parent controller heartbeat skips an active step, renews idle ownership and fences a successor", { timeout: 180_000 }, async () => {
  await inWorkspace(async ({ root, pmRoot, client, approval }) => {
    const path = join(pmRoot, "locks", `${loopLeaseLockId(id)}.lock`);
    const interval = LOOP_LEASE_TTL_SECONDS / 3 * 1000 + 1500;
    const update = client.update.bind(client);
    let held = false;
    let successor: Record<string, unknown> | undefined;
    let baseline: Record<string, string> | undefined;
    let releaseSuccessor: (() => Promise<void>) | undefined;
    client.update = async (key, options) => {
      const result = await update(key, options);
      if (!held && key.endsWith(`${id}-g1-step-collect`) && String(options?.body).includes('"state":"complete"')) {
        held = true;
        const active = readNativeLock(path);
        await new Promise<void>((resolve) => { setTimeout(resolve, interval); });
        assert.deepEqual(readNativeLock(path), active, "heartbeat must not run through an active effect and receipt commit");
      }
      return result;
    };
    try {
      await assert.rejects(runRlLoop(client, { pmRoot, author }, { id, config, approval,
        async onPhase(phase) {
          assert.equal(phase, "collect");
          const idle = readNativeLock(path);
          await new Promise<void>((resolve) => { setTimeout(resolve, interval); });
          const renewed = readNativeLock(path);
          assert.equal(renewed["token"], idle["token"]);
          assert.ok(Date.parse(String(renewed["created_at"])) > Date.parse(String(idle["created_at"])), "idle heartbeat must renew the lease");
          replaceNativeLock(path, { ...renewed, created_at: "1970-01-01T00:00:00.000Z" });
          releaseSuccessor = await acquireLock(pmRoot, loopLeaseLockId(id), LOOP_LEASE_TTL_SECONDS, "idle-successor", false, false, 0);
          successor = readNativeLock(path);
          const successorClient = new PmClient({ cwd: root, pmRoot, author: "idle-successor", noExtensions: true });
          await successorClient.claim(`${id}-seed`, { force: true });
          baseline = domainFiles(pmRoot);
          await new Promise<void>((resolve) => { setTimeout(resolve, interval); });
          assert.deepEqual(readNativeLock(path), successor, "failed idle heartbeat must preserve successor ownership");
        },
      }), refusal("loop_lease_lost"));
      assert.ok(held && successor !== undefined && baseline !== undefined);
      assert.deepEqual(readNativeLock(path), successor);
      assert.deepEqual(domainFiles(pmRoot), baseline, "displaced cleanup must preserve the successor claim and completed steps");
      await assert.rejects(client.get(`${id}-g1-step-train`));
    } finally { Object.assign(client, { update }); await releaseSuccessor?.(); }
  });
});

test("a step appearing as unreadable storage between absence checks propagates its real SDK error", bounded, async () => {
  await inWorkspace(async ({ pmRoot, client, approval }) => {
    const key = `${id}-g1-step-collect`;
    const settings = await readSettings(pmRoot);
    const path = getItemPath(pmRoot, "Decision", normalizeItemId(key, settings.id_prefix));
    const get = client.get.bind(client);
    const create = client.create.bind(client);
    let damaged = false;
    let stepCreates = 0;
    let readFailure: Error | undefined;
    client.get = (async (item, options) => {
      try { return await get(item, options); }
      catch (error) {
        if (item === key && !damaged && isPmCliExpectedError(error) && error.exitCode === EXIT_CODE.NOT_FOUND) {
          damaged = true;
          mkdirSync(path);
          writeFileSync(join(path, "holder"), "unreadable concurrent step storage");
        } else if (item === key && damaged) {
          assert.ok(error instanceof Error);
          readFailure = error;
        }
        throw error;
      }
    }) as PmClient["get"];
    client.create = async (options) => {
      if (options?.id === key) stepCreates += 1;
      return create(options);
    };
    const phases: string[] = [];
    try {
      await assert.rejects(runRlLoop(client, { pmRoot, author }, { id, config, approval,
        onPhase(phase) { phases.push(phase); } }), (error: unknown) => {
        assert.ok(readFailure !== undefined);
        assert.equal(error, readFailure, "the SDK read error must survive without being treated as an absent step");
        return true;
      });
      assert.ok(damaged);
      assert.equal(stepCreates, 0, "an unreadable step must never be recreated");
      assert.deepEqual(phases, []);
      assert.equal(readFileSync(join(path, "holder"), "utf8"), "unreadable concurrent step storage");
      await assert.rejects(get(`${id}-g1-collect`));
    } finally { Object.assign(client, { get, create }); }
  });
});

test("a real LM deadline refusal survives lease loss while its audit is fenced", bounded, async () => {
  await inWorkspace(async ({ pmRoot, client, approval }) => {
    const declared = JSON.parse(readFileSync(new URL("../examples/loop-lm.json", import.meta.url), "utf8")) as Record<string, JsonValue>;
    const configuration = lmConfigurationJson(parseLmLoopConfig({ ...declared, max_generations: 1, budget: declared["samples_per_generation"]! })) as Record<string, JsonValue>;
    configuration["limits"] = { ...configuration["limits"] as Record<string, JsonValue>, max_wall_seconds: 0.000001 };
    const collectingRun = `${id}-g1-collect`;
    const main = join(pmRoot, "locks", `${loopLeaseLockId(id)}.lock`);
    let successor: Record<string, unknown> | undefined;
    let releaseSuccessor: (() => Promise<void>) | undefined;
    let comments: unknown;
    const create = client.create.bind(client);
    client.create = async (options) => {
      const result = await create(options);
      if (options?.id === collectingRun) {
        comments = await client.comments(`${id}-seed`);
        replaceNativeLock(main, { ...readNativeLock(main), created_at: "1970-01-01T00:00:00.000Z" });
        releaseSuccessor = await acquireLock(pmRoot, loopLeaseLockId(id), LOOP_LEASE_TTL_SECONDS, "refusal-successor", false, false, 0);
        successor = readNativeLock(main);
      }
      return result;
    };
    try {
      await assert.rejects(runRlLoop(client, { pmRoot, author }, { id, config: configuration, approval }), (error: unknown) => {
        assert.ok(isPmCliExpectedError(error));
        assert.equal(error.context.code, "lm_limit_wall_seconds", "lease loss must not replace the original adapter refusal");
        const context: RefusalAuditContext = error.context;
        assert.ok(String(context.audit_comment_error).includes("controller lease was replaced"));
        return true;
      });
      assert.ok(successor !== undefined && comments !== undefined);
      assert.deepEqual(readNativeLock(main), successor);
      assert.deepEqual(await client.comments(`${id}-seed`), comments, "a displaced controller cannot append an audit comment");
      await assert.rejects(client.get(`${id}-g1`));
    } finally { Object.assign(client, { create }); await releaseSuccessor?.(); }
  });
});

for (const phase of ["LM configuration", "controller preparation"] as const) {
  test(`real unreadable seed storage propagates the first SDK error during ${phase}`, bounded, async () => {
    await inWorkspace(async ({ root, pmRoot, client, approval }) => {
      await assert.rejects(runRlLoop(client, { pmRoot, author }, { id, config, approval,
        onPhase(current) { if (current === "collect") throw new Error("pause before the seed storage drill"); },
      }), /pause before the seed storage drill/);
      const seed = await completeItem(client, `${id}-seed`);
      const path = getItemPath(pmRoot, "Generation", String(seed.item.id));
      const preserved = join(root, "original-seed");
      const before = domainFiles(pmRoot, [`${String(seed.item.id)}.toon`]);
      renameSync(path, preserved);
      mkdirSync(path);
      writeFileSync(join(path, "holder"), "unreadable seed storage");
      const declared = JSON.parse(readFileSync(new URL("../examples/loop-lm.json", import.meta.url), "utf8")) as Record<string, JsonValue>;
      const requestConfig = phase === "LM configuration" ? { ...declared, max_generations: 1, budget: declared["samples_per_generation"]! } : config;
      const get = client.get.bind(client);
      let observedFailure: unknown;
      let reads = 0;
      client.get = (async (key, options) => {
        try { return await get(key, options); }
        catch (error: unknown) {
          if (key === `${id}-seed`) { reads += 1; observedFailure ??= error; }
          throw error;
        }
      }) as PmClient["get"];
      const phases: string[] = [];
      try {
        await assert.rejects(runRlLoop(client, { pmRoot, author }, { id, config: requestConfig, approval,
          onPhase(current) { phases.push(current); },
        }), (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.equal(error, observedFailure, "the first real SDK failure must reach the caller without retry substitution");
          return true;
        });
        assert.equal(reads, 1);
        assert.deepEqual(phases, []);
        assert.equal(readFileSync(join(path, "holder"), "utf8"), "unreadable seed storage");
        assert.deepEqual(domainFiles(pmRoot, [`${String(seed.item.id)}.toon`]), before);
        assert.deepEqual(readdirSync(join(pmRoot, "locks")), []);
      } finally {
        Object.assign(client, { get });
        rmSync(path, { recursive: true });
        renameSync(preserved, path);
      }
    });
  });
}
