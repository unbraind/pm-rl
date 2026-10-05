/** Durable replay, cancellation, status and real controller contention. */
import assert from "node:assert/strict";
import { fork, execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, symlinkSync, existsSync, statSync, readdirSync } from "node:fs";
import { tmpdir, hostname } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:http";
import { after, test } from "node:test";
import { PmClient } from "@unbrained/pm-cli/sdk/core";
import { setActiveExtensionServices, createPmCliExpectedError, type ExtensionApi } from "@unbrained/pm-cli";
import { init, isPmCliExpectedError, acquireLock, EXIT_CODE } from "@unbrained/pm-cli/sdk/runtime";
import { createExtensionTestHarness } from "@unbrained/pm-cli/sdk/testing";
import extension, { runRlLoop, resumeRlLoop, rlLoopStatus, loopLeaseLockId, loopProcessStartTime, loopProcessIdentityIO, LOOP_LEASE_TTL_SECONDS, type JsonValue } from "../index.ts";
import { parseStoredLoopGeneration, verifyStoredLoopGeneration, parseLoopConfig, generationTrainingConfig, runLoopGeneration } from "../loop.ts";
import { readSeries, encodeEventSegments, type MetricEvent } from "../series.ts";
import { configValue } from "./fixtures/systemone.ts";
import { banditCheckpoint } from "../bandit.ts";

const roots: string[] = [];
after(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });
const config = JSON.parse(readFileSync(new URL("../examples/loop-bandit.json", import.meta.url), "utf8")) as Record<string, JsonValue>;

/** Initialize a real PM project and its approval decision. */
async function workspace() {
  const root = mkdtempSync(join(tmpdir(), "pm-rl-durable-")); roots.push(root);
  const initialized = await init("rl", { defaults: true, agentGuidance: "skip", author: "rl-test" }, { cwd: root });
  const client = new PmClient({ pmRoot: initialized.path, cwd: root, author: "rl-test" });
  const approval = await client.create({ id: "approval", title: "Bounded approval", type: "Decision", body: '```json\n{"permitted_promotions":3}\n```' });
  return { root, pmRoot: initialized.path, client, approval: String(approval.item.id) };
}

/** Normalize invocation-local replay counters for receipt comparison. */
function stable<T extends { resumed_generations: number }>(report: T) { const { resumed_generations, ...value } = report; return value; }

test("crashes at every completed phase preserve budget, artifacts and one promotion", async () => {
  for (const phase of ["collect", "train", "evaluate", "promote"] as const) {
    const { client, pmRoot, approval } = await workspace();
    const coordinates = { pmRoot, author: "rl-test" };
    const request = { id: "drill", config, approval };
    await assert.rejects(runRlLoop(client, coordinates, { ...request, onPhase(current) { if (current === phase) throw new Error("injected crash"); } }), /injected crash/);
    const before = await rlLoopStatus(client, "drill");
    assert.ok(before.samples_consumed > 0); assert.equal(before.next_generation, phase === "promote" ? 2 : 1);
    const resumed = await resumeRlLoop(client, coordinates, { id: "drill", approval });
    assert.equal(resumed.promoted, 3); assert.equal(resumed.samples_consumed, Number(config.budget));
    assert.deepEqual(stable(await runRlLoop(client, coordinates, request)), stable(resumed));
    const status = await rlLoopStatus(client, "drill");
    assert.equal(status.stop_reason, "generation_limit"); assert.equal(status.next_generation, null);
    for (const generation of resumed.generations) {
      const history = readFileSync(join(pmRoot, "history", `${generation.item}.jsonl`), "utf8");
      assert.equal(history.split('\n').filter((line) => line.includes('"op":"create"')).length, 1);
      const notes = await client.notes(generation.run!, { outputBudget: "unbounded", outputLimit: "unbounded" });
      assert.ok(!("output_budget_exceeded" in notes));
      assert.equal(notes.notes.length, 1);
    }
    const comments = await client.comments(resumed.seed_generation);
    assert.equal(comments.comments.filter((comment) => comment.text.startsWith("Loop drill terminal report:")).length, 1);
  }
});

test("AbortSignal stops at a persisted boundary and harness resume and status complete it", async () => {
  const { client, root, pmRoot, approval } = await workspace();
  const controller = new AbortController();
  await assert.rejects(runRlLoop(client, { pmRoot, author: "rl-test" }, { id: "cancel", config, approval, signal: controller.signal,
    onPhase() { controller.abort(); } }), (error: unknown) => isPmCliExpectedError(error) && error.context.code === "loop_cancelled");
  const harness = await createExtensionTestHarness(extension, { name: "pm-rl", capabilities: ["commands", "hooks", "schema"] });
  const status = await harness.runCommand({ command: "rl loop status", pmRoot, args: ["cancel"] }); assert.equal(status.handled, true);
  const resumed = await harness.runCommand({ command: "rl loop resume", pmRoot, args: ["cancel"], options: { approval } }); assert.equal(resumed.handled, true);
  const file = join(root, "config.json"); writeFileSync(file, JSON.stringify(config));
  const repeat = await harness.runCommand({ command: "rl loop run", pmRoot, args: ["cancel"], options: { file, approval } }); assert.equal(repeat.handled, true);
});

test("rejected and budget-exhausted loops reconstruct the exact spent budget", async () => {
  for (const value of [{ ...config, maximum_gap: 0 }, { ...config, budget: Number(config.samples_per_generation) }]) {
    const { client, pmRoot, approval } = await workspace(); const request = { id: "stop", config: value, approval };
    const first = await runRlLoop(client, { pmRoot, author: "rl-test" }, request);
    assert.deepEqual(stable(await runRlLoop(client, { pmRoot, author: "rl-test" }, request)), stable(first));
    const status = await rlLoopStatus(client, "stop"); assert.equal(status.samples_consumed, first.samples_consumed); assert.equal(status.stop_reason, first.stop_reason);
  }
});

test("persisted bandit checkpoint and replay field corruption are refused", () => {
  const parsed = parseLoopConfig(config); const step = { learningRate: parsed.learningRate, evaluationSamples: parsed.evaluationSamples };
  const source = banditCheckpoint(parsed.initialWeight); const receipt = runLoopGeneration(parsed, step, 1, source);
  const raw = generationTrainingConfig(parsed, step, 1, receipt) as Record<string, JsonValue>;
  const stored = parseStoredLoopGeneration(raw, "record");
  assert.deepEqual(verifyStoredLoopGeneration(parsed, step, 1, source, stored), receipt);
  assert.throws(() => verifyStoredLoopGeneration(parsed, step, 1, source, { ...stored, candidateCheckpoint: "tampered" }));
  assert.throws(() => verifyStoredLoopGeneration(parsed, step, 1, source, { ...stored, trainingScore: -1 }));
  for (const [key, value] of [["format", "bad"], ["generation", 0], ["action_counts", [1]], ["action_counts", [-1, 2]], ["candidate_weight", 21], ["samples", 0], ["source_checkpoint", "bad"], ["training_score", null]] as const) assert.throws(() => parseStoredLoopGeneration({ ...raw, [key]: value } as JsonValue, "record"), `field ${key}`);
});

/** Fork a real controller and retain its final structured result. */
function launch(pmRoot: string, approval: string, mode: string) {
  const child = fork(new URL("./fixtures/controller.ts", import.meta.url), [pmRoot, approval, JSON.stringify(config), mode], { silent: true });
  let output = ""; child.stderr!.on("data", (chunk: Buffer) => { output += chunk.toString(); });
  const result = new Promise<{ code: number | null; messages: unknown[] }>((resolve, reject) => {
    const messages: unknown[] = []; child.on("message", (message) => messages.push(message)); child.on("error", reject);
    child.on("exit", (code) => { if (code !== 0 && messages.length === 0) reject(new Error(output)); else resolve({ code, messages }); });
  });
  const ready = (mode === "hold" || mode === "cli") ? new Promise<void>((resolve, reject) => { child.on("message", (message) => { if (message === "ready") resolve(); }); child.on("exit", (code) => { if (code !== 0) reject(new Error(output)); }); }) : Promise.resolve();
  return { child, result, ready };
}

test("two real processes launch once; SIGKILL lease recovery and signal cancellation resume", async () => {
  for (const signal of ["SIGKILL", "SIGINT", "SIGTERM"] as const) {
    const { client, pmRoot, approval } = await workspace();
    const winner = launch(pmRoot, approval, "hold"); await winner.ready;
    const loser = launch(pmRoot, approval, "run");
    const lost = await loser.result; assert.ok(JSON.stringify(lost.messages).includes("loop_controller_active"));
    winner.child.kill(signal); await winner.result;
    const resumed = await resumeRlLoop(client, { pmRoot, author: "rl-test" }, { id: "race", approval });
    assert.equal(resumed.promoted, 3); assert.equal(resumed.samples_consumed, Number(config.budget));
  }
});

test("two Git worktree processes share launch authority and merge one job's artifacts", async (context) => {
  const { root, pmRoot, approval, client } = await workspace();
  execFileSync("git", ["init", "-b", "main"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Test Agent"], { cwd: root }); execFileSync("git", ["config", "user.email", "test@example.invalid"], { cwd: root });
  writeFileSync(join(root, ".gitignore"), ".agents/pm/locks/\n.agents/pm/runtime/\n.agents/pm/search/\n.agents/pm/transactions/\n.agents/pm/checkpoints/\nother/\n");
  execFileSync("pm", ["merge", "install"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["add", ".agents/pm", ".gitignore", ".gitattributes"], { cwd: root }); execFileSync("git", ["commit", "-m", "Initial tracker"], { cwd: root, stdio: "ignore" });
  const second = join(root, "other"); execFileSync("git", ["worktree", "add", second, "-b", "other"], { cwd: root, stdio: "ignore" });
  const winner = launch(pmRoot, approval, "hold"); await winner.ready;
  const loser = launch(join(second, ".agents/pm"), approval, "run"); assert.ok(JSON.stringify((await loser.result).messages).includes("loop_controller_active"));
  winner.child.send("continue"); assert.equal((await winner.result).code, 0);
  const alias = join(root, "alias"); symlinkSync(root, alias, process.platform === "win32" ? "junction" : "dir");
  const sameWorktree = launch(join(alias, ".agents/pm"), approval, "run"); assert.equal((await sameWorktree.result).code, 0);
  rmSync(alias);
  const late = launch(join(second, ".agents/pm"), approval, "run"); assert.ok(JSON.stringify((await late.result).messages).includes("loop_launch_elsewhere"));
  const authorityGet = PmClient.prototype.get;
  const unreadable = context.mock.method(PmClient.prototype, "get", (async function (this: PmClient, id, options) {
      if (id === loopLeaseLockId("race")) throw new Error("launch journal unreadable");
      return authorityGet.call(this, id, options);
    }) as PmClient["get"]);
  try {
    await assert.rejects(runRlLoop(client, { pmRoot, author: "rl-test" }, { id: "race", config, approval }), /launch journal unreadable/);
  } finally { unreadable.mock.restore(); }
  const losingClient = new PmClient({ pmRoot: join(second, ".agents/pm"), cwd: second, author: "rl-test" });
  await assert.rejects(runRlLoop(losingClient, { pmRoot: join(second, ".agents/pm"), author: "rl-test" }, { id: "race", config, approval }), (error: unknown) => {
    assert.ok(isPmCliExpectedError(error)); assert.equal(error.context.code, "loop_launch_elsewhere");
    assert.ok(error.message.includes(`authority item ${loopLeaseLockId("race")}`));
    assert.ok(error.message.includes("reassign")); assert.ok(!error.message.includes(root)); return true;
  });
  losingClient.comments = async () => { throw new Error("launch receipt unreadable"); };
  await assert.rejects(runRlLoop(losingClient, { pmRoot: join(second, ".agents/pm"), author: "rl-test" }, { id: "race", config, approval }), /launch receipt unreadable/);
  execFileSync("git", ["add", ".agents/pm"], { cwd: root }); execFileSync("git", ["commit", "-m", "Persist one job"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["add", ".agents/pm"], { cwd: second }); execFileSync("git", ["commit", "--allow-empty", "-m", "Record contending controller"], { cwd: second, stdio: "ignore" });
  execFileSync("git", ["merge", "--no-edit", "main"], { cwd: second, stdio: "pipe" });
  const merged = new PmClient({ pmRoot: resolve(second, ".agents/pm"), cwd: second, author: "rl-test" });
  const status = await rlLoopStatus(merged, "race"); assert.equal(status.promoted, 3);
  const repeat = launch(join(second, ".agents/pm"), approval, "run"); assert.equal((await repeat.result).code, 0);
});

/** Listen to actual decision requests and label them from their synthetic state. */
async function decisionServer() {
  let calls = 0;
  const server = createServer((request, reply) => {
    let body = ""; request.on("data", (chunk: Buffer) => { body += chunk.toString(); });
    request.on("end", () => {
      calls += 1;
      const state = (JSON.parse(body) as { state: string }).state;
      const bug = /[Ff]ix|[Rr]epair/.test(state);
      reply.end(JSON.stringify({ answers: { kind: { probabilities: { Bug: bug ? 0.6 : 0.4, Feature: bug ? 0.4 : 0.6 } } }, usage: { input_tokens: 10, output_tokens: 1 } }));
    });
  });
  await new Promise<void>((resolve) => { server.listen(0, "127.0.0.1", resolve); });
  const address = server.address(); assert.ok(address !== null && typeof address !== "string");
  return { server, baseURL: `http://127.0.0.1:${address.port}`, calls: () => calls };
}

test("decision-model crash replay never re-queries persisted decisions and status accounts partial evidence", async () => {
  const endpoint = await decisionServer();
  try {
    for (const phase of ["collect", "train", "evaluate", "promote"] as const) {
      const { client, pmRoot, approval } = await workspace(); const value = configValue(endpoint.baseURL);
      const before = endpoint.calls(); const request = { id: "decision", config: value, approval };
      await assert.rejects(runRlLoop(client, { pmRoot, author: "rl-test" }, { ...request, onPhase(current) { if (current === phase) throw new Error("interrupted"); } }), /interrupted/);
      const status = await rlLoopStatus(client, "decision"); assert.equal(status.samples_consumed, 4);
      const report = await resumeRlLoop(client, { pmRoot, author: "rl-test" }, { id: "decision", approval });
      assert.equal(report.promoted, 2); assert.equal(report.samples_consumed, 8); assert.equal(endpoint.calls() - before, 8);
      assert.deepEqual(stable(await runRlLoop(client, { pmRoot, author: "rl-test" }, request)), stable(report));
      assert.equal((await rlLoopStatus(client, "decision")).stop_reason, "generation_limit");
    }
    const { client, pmRoot, approval } = await workspace(); const value = configValue(endpoint.baseURL); const controller = new AbortController();
    const update = client.update.bind(client);
    client.update = async (id, options) => { const result = await update(id, options); if (options?.note) controller.abort(); return result; };
    await assert.rejects(runRlLoop(client, { pmRoot, author: "rl-test" }, { id: "partial", config: value, approval, signal: controller.signal }));
    const partial = await rlLoopStatus(client, "partial"); assert.equal(partial.samples_consumed, 1); assert.equal(partial.generations[0].phase, "collecting");
    client.update = update;
    assert.equal((await resumeRlLoop(client, { pmRoot, author: "rl-test" }, { id: "partial", approval })).promoted, 2);
  } finally { endpoint.server.closeAllConnections(); endpoint.server.close(); }
});

test("recorded promotion refusal stays terminal on replay and governing approval cannot switch", async () => {
  const { client, pmRoot, approval } = await workspace();
  const limited = await client.create({ id: "limited", type: "Decision", title: "One promotion", body: '```json\n{"permitted_promotions":1}\n```' });
  const request = { id: "limited-loop", config, approval: String(limited.item.id) };
  const first = await runRlLoop(client, { pmRoot, author: "rl-test" }, request); assert.equal(first.stop_reason, "promotion_refused");
  assert.deepEqual(stable(await runRlLoop(client, { pmRoot, author: "rl-test" }, request)), stable(first));
  assert.equal((await rlLoopStatus(client, "limited-loop")).samples_consumed, first.samples_consumed);
  await assert.rejects(resumeRlLoop(client, { pmRoot, author: "rl-test" }, { id: "limited-loop", approval }), (error: unknown) => isPmCliExpectedError(error) && error.context.code === "loop_approval_mismatch");
});

test("resume refuses missing seed programme, missing runs and corrupted lineage or run identity", async () => {
  const { client, pmRoot, approval } = await workspace();
  const request = { id: "corruption", config, approval };
  await assert.rejects(runRlLoop(client, { pmRoot, author: "rl-test" }, { ...request, onPhase(phase) { if (phase === "train") throw new Error("pause"); } }));
  const run = await client.get("corruption-g1-collect"); const candidate = await client.get("corruption-g1"); const seed = await client.get("corruption-seed");
  const body = String(candidate.item.body);
  await client.update(String(candidate.item.id), { body: body.replace('"parent":', '"parent": "foreign", "original_parent":') });
  await assert.rejects(rlLoopStatus(client, "corruption")); await client.update(String(candidate.item.id), { body });
  await client.update(String(run.item.id), { component: "tampered" }); await assert.rejects(rlLoopStatus(client, "corruption")); await client.update(String(run.item.id), { component: String(run.item.component) });
  const seedBody = String(seed.item.body); await client.update(String(seed.item.id), { body: seedBody.replace('"configuration":', '"foreign_configuration":') });
  await assert.rejects(rlLoopStatus(client, "corruption")); await assert.rejects(resumeRlLoop(client, { pmRoot, author: "rl-test" }, { id: "corruption", approval }));
  await client.update(String(seed.item.id), { body: seedBody });
  await client.delete(String(run.item.id), { force: true }); await assert.rejects(rlLoopStatus(client, "corruption"));
});

test("the actual CLI signal handlers retain artifacts for both SIGINT and SIGTERM", async () => {
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    const { client, pmRoot, approval } = await workspace();
    const child = launch(pmRoot, approval, "cli"); await child.ready; child.child.kill(signal);
    const outcome = await child.result; assert.ok(JSON.stringify(outcome.messages).includes("loop_cancelled"), JSON.stringify(outcome));
    assert.equal((await resumeRlLoop(client, { pmRoot, author: "rl-test" }, { id: "race", approval })).promoted, 3);
  }
});

test("malformed and legacy controller records refuse; EPERM requires matching birth time", async () => {
  for (const record of [[], {}, { pid: process.pid, created_at: "bad date", ttl_seconds: 30 }]) {
    const { client, pmRoot, approval } = await workspace();
    const lock = loopLeaseLockId("corrupt-lock");
    const release = await acquireLock(pmRoot, lock, LOOP_LEASE_TTL_SECONDS, "test");
    writeFileSync(join(pmRoot, "locks", `${lock}.lock`), JSON.stringify(record));
    await assert.rejects(runRlLoop(client, { pmRoot, author: "rl-test" }, { id: "corrupt-lock", config: { ...config, max_generations: 1 }, approval }));
    await release();
  }
  const { client, pmRoot, approval } = await workspace(); const lock = loopLeaseLockId("permission");
  const release = await acquireLock(pmRoot, lock, LOOP_LEASE_TTL_SECONDS, "test");
  const path = join(pmRoot, "locks", `${lock}.lock`);
  const record = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  writeFileSync(path, JSON.stringify({ ...record, hostname: hostname(), process_start_time: loopProcessStartTime(process.pid) }));
  const kill = process.kill;
  try {
    process.kill = (pid, signal) => { if (pid === process.pid && signal === 0) throw Object.assign(new Error("Permission denied"), { code: "EPERM" }); return kill(pid, signal); };
    await assert.rejects(runRlLoop(client, { pmRoot, author: "rl-test" }, { id: "permission", config, approval }), (error: unknown) => isPmCliExpectedError(error) && error.context.code === "loop_controller_active");
  } finally { process.kill = kill; await release(); }
});

test("real live same-identity holder blocks even force and an expired timestamp", async () => {
  const { client, pmRoot, approval } = await workspace();
  const winner = launch(pmRoot, approval, "hold"); await winner.ready;
  try {
    const path = join(pmRoot, "locks", `${loopLeaseLockId("race")}.lock`);
    const record = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    assert.equal(record.hostname, hostname()); assert.equal(record.pid, winner.child.pid);
    assert.equal(record.process_start_time, loopProcessStartTime(winner.child.pid!));
    writeFileSync(path, JSON.stringify({ ...record, created_at: "1970-01-01T00:00:00.000Z", ttl_seconds: 1 }));
    for (const forceTakeover of [false, true]) {
      await assert.rejects(resumeRlLoop(client, { pmRoot, author: "rl-test" }, { id: "race", approval, forceTakeover }), (error: unknown) => {
        assert.ok(isPmCliExpectedError(error)); assert.equal(error.context.code, "loop_controller_active");
        assert.ok(error.message.includes(`locks/${loopLeaseLockId("race")}.lock`));
        assert.ok(error.message.includes(`pm rl loop resume race --approval ${approval} --force-takeover`));
        assert.ok(!error.message.includes(pmRoot)); return true;
      });
    }
  } finally { winner.child.kill("SIGKILL"); await winner.result; }
});

test("reused PID with mismatched birth time recovers while the unrelated real process exists", async () => {
  const { client, pmRoot, approval } = await workspace();
  const winner = launch(pmRoot, approval, "hold"); await winner.ready;
  try {
    const path = join(pmRoot, "locks", `${loopLeaseLockId("race")}.lock`);
    const record = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    writeFileSync(path, JSON.stringify({ ...record, process_start_time: "1970-01-01T00:00:00.000Z" }));
    assert.equal((await resumeRlLoop(client, { pmRoot, author: "rl-test" }, { id: "race", approval })).promoted, 3);
    assert.equal(process.kill(winner.child.pid!, 0), true);
  } finally { winner.child.kill("SIGKILL"); await winner.result; }
});

test("foreign-host lease refuses automatic recovery and CLI force takeover audits the previous holder", async () => {
  const { client, pmRoot, approval } = await workspace();
  const winner = launch(pmRoot, approval, "hold"); await winner.ready;
  try {
    const path = join(pmRoot, "locks", `${loopLeaseLockId("race")}.lock`);
    const record = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    writeFileSync(path, JSON.stringify({ ...record, hostname: "other-host.invalid" }));
    await assert.rejects(resumeRlLoop(client, { pmRoot, author: "rl-test" }, { id: "race", approval }), /holder is ambiguous/);
    const harness = await createExtensionTestHarness(extension, { name: "pm-rl", capabilities: ["commands", "hooks", "schema"] });
    const result = await harness.runCommand({ command: "rl loop resume", pmRoot, args: ["race"], options: { approval, force_takeover: true }, global: { author: "operator-test" } });
    assert.equal(result.handled, true);
    const seed = await client.get("race-seed");
    const history = readFileSync(join(pmRoot, "history", `${seed.item.id}.jsonl`), "utf8");
    assert.ok(history.includes("forced lease takeover by operator-test"));
    assert.ok(history.includes(String(winner.child.pid))); assert.ok(history.includes("hostname_digest"));
    assert.ok(!history.includes("other-host.invalid")); assert.ok(!history.includes(hostname())); assert.ok(!history.includes(pmRoot));
  } finally { winner.child.kill("SIGKILL"); await winner.result; }
});

test("portable process birth probes preserve precision and refuse unavailable signals", () => {
  const stat = `42 (name with ) parentheses) S ${Array(18).fill("0").join(" ")} 1234`;
  const io = { read: (path: string) => path === "/proc/stat" ? "btime 1000000000\n" : stat, exec: () => "100" };
  assert.equal(loopProcessStartTime(42, "linux", io), "2001-09-09T01:46:52.340Z");
  for (const [read, exec] of [
    [() => "invalid", () => "100"],
    [() => "btime 0", () => "100"],
    [io.read, () => "0"],
    [io.read, () => { throw new Error("unavailable"); }],
  ] as const) assert.equal(loopProcessStartTime(42, "linux", { read, exec }), null);
  assert.equal(loopProcessStartTime(42, "linux", { read: () => { throw new Error("denied"); }, exec: io.exec }), null);
  assert.equal(loopProcessStartTime(42, "linux", { read: (path) => path === "/proc/stat" ? "no boot epoch" : stat, exec: io.exec }), null);
  assert.equal(loopProcessStartTime(42, "linux", { read: (path) => path === "/proc/stat" ? "btime 0" : stat, exec: io.exec }), null);
  for (const platform of ["darwin", "win32"] as const) {
    assert.equal(loopProcessStartTime(42, platform, { read: io.read, exec(file, args) {
      assert.equal(file, platform === "win32" ? "powershell.exe" : "ps");
      assert.ok(args.join(" ").includes("42")); return " precise process birth ";
    } }), "precise process birth");
    assert.equal(loopProcessStartTime(42, platform, { read: io.read, exec: () => "" }), null);
  }
});

test("ambiguous local identities and malformed leases require override; audit failure preserves the lease", async () => {
  const { client, pmRoot, approval } = await workspace();
  const request = { id: "ambiguous", config: { ...config, max_generations: 1 }, approval };
  await runRlLoop(client, { pmRoot, author: "rl-test" }, request);
  const path = join(pmRoot, "locks", `${loopLeaseLockId(request.id)}.lock`);
  for (const record of [{ hostname: hostname(), pid: 0 }, { hostname: hostname(), pid: "bad" }, { hostname: hostname(), pid: process.pid }, null, "broken JSON"]) {
    writeFileSync(path, typeof record === "string" ? record : JSON.stringify(record));
    await assert.rejects(resumeRlLoop(client, { pmRoot, author: "rl-test" }, request), /holder is (ambiguous|unverifiable)/);
  }
  const update = client.update.bind(client);
  const contents = readFileSync(path, "utf8");
  client.update = async (id, options) => { if (options?.comment) throw new Error("audit unavailable"); return update(id, options); };
  await assert.rejects(resumeRlLoop(client, { pmRoot, author: "rl-test" }, { ...request, forceTakeover: true }), /audit unavailable/);
  assert.equal(readFileSync(path, "utf8"), contents);
  client.update = update;
  const harness = await createExtensionTestHarness(extension, { name: "pm-rl", capabilities: ["commands", "hooks", "schema"] });
  assert.equal((await harness.runCommand({ command: "rl loop resume", pmRoot, args: [request.id], options: { approval, forceTakeover: true } })).handled, true);
  const lock = await acquireLock(pmRoot, loopLeaseLockId(request.id), LOOP_LEASE_TTL_SECONDS, "test");
  writeFileSync(path, JSON.stringify({ hostname: hostname(), pid: process.pid, process_start_time: "different" }));
  await resumeRlLoop(client, { pmRoot, author: "rl-test" }, { ...request, forceTakeover: true });
  await lock();
});

test("unavailable own birth-time probing refuses before acquiring locks even with force", async () => {
  const { client, pmRoot, approval } = await workspace();
  const request = { id: "no-probe", config: { ...config, max_generations: 1 }, approval };
  const processIdentityIO = { ...loopProcessIdentityIO, exec: () => { throw new Error("OS probe tooling unavailable"); } };
  for (const forceTakeover of [false, true]) {
    await assert.rejects(runRlLoop(client, { pmRoot, author: "rl-test" }, { ...request, forceTakeover, processIdentityIO }), (error: unknown) => {
      assert.ok(isPmCliExpectedError(error)); assert.equal(error.context.code, "loop_identity_unavailable");
      assert.ok(error.message.includes("--force-takeover cannot bypass"));
      assert.ok(error.message.includes(`locks/${loopLeaseLockId(request.id)}.lock`)); assert.ok(!error.message.includes(pmRoot)); return true;
    });
    assert.equal(existsSync(join(pmRoot, "locks", `${loopLeaseLockId(request.id)}.lock`)), false);
    assert.equal(existsSync(join(pmRoot, "locks", `${loopLeaseLockId(request.id)}-recovery.lock`)), false);
    await assert.rejects(client.get(`${request.id}-seed`));
  }
  await runRlLoop(client, { pmRoot, author: "rl-test" }, request);
  const release = await acquireLock(pmRoot, loopLeaseLockId(request.id), LOOP_LEASE_TTL_SECONDS, "test");
  try {
    const path = join(pmRoot, "locks", `${loopLeaseLockId(request.id)}.lock`);
    const before = readFileSync(path, "utf8");
    await assert.rejects(resumeRlLoop(client, { pmRoot, author: "rl-test" }, { ...request, forceTakeover: true, processIdentityIO }), (error: unknown) => isPmCliExpectedError(error) && error.context.code === "loop_identity_unavailable");
    assert.equal(readFileSync(path, "utf8"), before);
  } finally { await release(); }
});

test("live local PID with unavailable probing or missing recorded identity blocks forced takeover", async () => {
  const { client, pmRoot, approval } = await workspace();
  const winner = launch(pmRoot, approval, "hold"); await winner.ready;
  const path = join(pmRoot, "locks", `${loopLeaseLockId("race")}.lock`);
  const original = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  const pid = winner.child.pid!;
  const processIdentityIO = {
    ...loopProcessIdentityIO,
    read: (path: string) => { if (path === `/proc/${pid}/stat`) throw new Error("holder probe denied"); return loopProcessIdentityIO.read(path); },
    exec: (file: string, args: string[]) => {
      if (args.includes(String(pid)) || args.some((arg) => arg.includes(`-Id ${pid} `))) throw new Error("holder probe denied");
      return loopProcessIdentityIO.exec(file, args);
    },
  };
  try {
    const { hostname: omittedHost, ...legacy } = original; assert.equal(typeof omittedHost, "string");
    for (const record of [original, { ...original, process_start_time: null }, legacy]) {
      writeFileSync(path, JSON.stringify(record)); const before = readFileSync(path, "utf8");
      for (const forceTakeover of [false, true]) {
        await assert.rejects(resumeRlLoop(client, { pmRoot, author: "rl-test" }, { id: "race", approval, forceTakeover, processIdentityIO }), /holder is unverifiable/);
        assert.equal(readFileSync(path, "utf8"), before);
      }
    }
    writeFileSync(path, JSON.stringify({ ...original, process_start_time: null }));
    await assert.rejects(resumeRlLoop(client, { pmRoot, author: "rl-test" }, { id: "race", approval, forceTakeover: true }), /holder is unverifiable/);
    const seed = await client.get("race-seed");
    assert.ok(!readFileSync(join(pmRoot, "history", `${seed.item.id}.jsonl`), "utf8").includes("forced lease takeover"));
  } finally { winner.child.kill("SIGKILL"); await winner.result; }
  const { hostname: omittedHost, ...legacy } = original; assert.equal(typeof omittedHost, "string");
  writeFileSync(path, JSON.stringify(legacy));
  assert.equal((await resumeRlLoop(client, { pmRoot, author: "rl-test" }, { id: "race", approval, forceTakeover: true })).promoted, 3);
});

test("identity publication atomically replaces the SDK record while recovery stays serialized", async () => {
  const { client, pmRoot, approval } = await workspace();
  const id = "atomic-identity"; const lock = loopLeaseLockId(id); const path = join(pmRoot, "locks", `${lock}.lock`);
  let oldInode = 0; let token: unknown; let capturedStart: string | null = null; let probes = 0;
  let observed!: () => void; const captured = new Promise<void>((resolve) => { observed = resolve; });
  let proceed!: () => void; const permitted = new Promise<void>((resolve) => { proceed = resolve; });
  const harness = await createExtensionTestHarness({ activate(api: ExtensionApi) {
    api.registerService("lock_acquire", async (context) => {
      const payload = context.payload as { id: string };
      if (payload.id !== lock) return { handled: false };
      setActiveExtensionServices(null);
      try {
        const release = await acquireLock(pmRoot, lock, LOOP_LEASE_TTL_SECONDS, "rl-test");
        oldInode = statSync(path).ino;
        const record = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>; token = record.token;
        assert.equal(record.hostname, undefined); observed(); await permitted;
        return { handled: true, result: release };
      } finally { setActiveExtensionServices(harness.activation.services); }
    });
  } }, { name: "atomic-identity", capabilities: ["services"] });
  const get = client.get.bind(client);
  client.get = (async (id, options) => { const result = await get(id, options); if (id === approval) setActiveExtensionServices(harness.activation.services); return result; }) as PmClient["get"];
  const request = { id, config: { ...config, max_generations: 1 }, approval };
  const running = runRlLoop(client, { pmRoot, author: "rl-test" }, { ...request,
    processIdentityIO: { ...loopProcessIdentityIO, exec(file, args) { probes += 1; return loopProcessIdentityIO.exec(file, args); } },
    onPhase() {
      const record = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
      assert.notEqual(statSync(path).ino, oldInode); assert.equal(record.token, token);
      assert.equal(record.hostname, hostname()); assert.equal(typeof record.process_start_time, "string");
      capturedStart = String(record.process_start_time); assert.equal(probes, 1);
      assert.ok(!readdirSync(join(pmRoot, "locks")).some((name) => name.startsWith(`${lock}.lock.`)));
    },
  });
  try {
    await Promise.race([captured, running.then(() => { throw new Error("controller ended before identity publication"); })]);
    await assert.rejects(runRlLoop(client, { pmRoot, author: "rl-test" }, { ...request, forceTakeover: true }), /lease recovery is contended/);
    proceed(); assert.equal((await running).promoted, 1);
    assert.equal(existsSync(path), false);
    const seed = await get(`${id}-seed`);
    assert.ok(readFileSync(join(pmRoot, "history", `${seed.item.id}.jsonl`), "utf8").includes(capturedStart!));
  } finally { proceed(); await running.catch(() => undefined); setActiveExtensionServices(null); }
});

test("SDK lock conflict names recovery and identity-write failure releases the acquired lock", async () => {
  for (const mode of ["lease-conflict", "identity-write", "recovery-conflict", "recovery-io"] as const) {
    const { client, pmRoot, approval } = await workspace();
    let released = false;
    const harness = await createExtensionTestHarness({ activate(api: ExtensionApi) {
      api.registerService("lock_acquire", (context) => {
        const payload = context.payload as { id: string };
        const target = `${loopLeaseLockId("identity-fault")}${mode.startsWith("recovery") ? "-recovery" : ""}`;
        if (payload.id !== target) return { handled: false };
        if (mode !== "identity-write") return { handled: true, result: { get release() {
          if (mode === "recovery-io") throw new Error("recovery IO failure");
          throw createPmCliExpectedError("conflict", { exitCode: EXIT_CODE.CONFLICT });
        } } };
        return { handled: true, result: () => { released = true; } };
      });
    } }, { name: "identity-fault", capabilities: ["services"] });
    const get = client.get.bind(client);
    client.get = (async (id, options) => { const result = await get(id, options); if (id === approval) setActiveExtensionServices(harness.activation.services); return result; }) as PmClient["get"];
    try {
      await assert.rejects(runRlLoop(client, { pmRoot, author: "rl-test" }, { id: "identity-fault", config, approval }), (error: unknown) => {
        if (mode === "recovery-io") assert.match((error as Error).message, /recovery IO failure/);
        else if (mode !== "identity-write") { assert.ok(isPmCliExpectedError(error)); assert.equal(error.context.code, "loop_controller_active"); assert.ok(error.message.includes("--force-takeover")); }
        else { assert.equal((error as NodeJS.ErrnoException).code, "ENOENT"); assert.equal(released, true); }
        return true;
      });
    } finally { setActiveExtensionServices(null); }
  }
});

test("read failures and omitted comments propagate; release errors still release the controller mutex", async () => {
  const { client, pmRoot, approval } = await workspace(); const coordinates = { pmRoot, author: "rl-test" }; const request = { id: "fault", config: { ...config, max_generations: 1 }, approval };
  const get = client.get.bind(client);
  for (const suffix of ["-collect", "-g1"]) {
    client.get = (async (id, options) => { if (id.endsWith(suffix)) throw new Error("read failure"); return get(id, options); }) as PmClient["get"];
    await assert.rejects(runRlLoop(client, coordinates, request), /read failure/);
  }
  client.get = get;
  const comments = client.comments.bind(client);
  client.comments = (async () => ({ output_budget_exceeded: true })) as unknown as PmClient["comments"];
  await assert.rejects(runRlLoop(client, coordinates, request), (error: unknown) => isPmCliExpectedError(error) && error.context.code === "loop_history_incomplete");
  client.comments = comments;
  const release = client.release.bind(client); client.release = async () => { throw new Error("release failure"); };
  assert.equal((await runRlLoop(client, coordinates, request)).promoted, 1);
  client.release = release; assert.equal((await runRlLoop(client, coordinates, request)).promoted, 1);
});

test("bandit continuation refuses extra or rewritten metric evidence", async () => {
  for (const extra of [false, true]) {
    const { client, pmRoot, approval } = await workspace(); const request = { id: "metric-drift", config, approval };
    await assert.rejects(runRlLoop(client, { pmRoot, author: "rl-test" }, { ...request, onPhase(phase) { if (phase === "collect") throw new Error("pause"); } }));
    const notes = client.notes.bind(client);
    client.notes = (async (id, options) => {
      const result = await notes(id, options);
      assert.ok(!("output_budget_exceeded" in result));
      const events = [...readSeries(result.notes.map((note) => note.text)).events];
      if (extra) events.push({ step: events.length, metric: "collection_reward", value: 0 }); else events[0] = { ...events[0], value: events[0].value === 0 ? 1 : 0 };
      return { ...result, notes: encodeEventSegments(events).map((text) => ({ text, author: "test", created_at: "2026-01-01T00:00:00.000Z" })) };
    }) as PmClient["notes"];
    await assert.rejects(rlLoopStatus(client, "metric-drift"), (error: unknown) => isPmCliExpectedError(error) && error.context.code === "loop_generation_drift");
  }
});

test("decision receipt corruption, incomplete phases and exhausted query budgets refuse advancement", async () => {
  const endpoint = await decisionServer();
  try {
    for (const fault of ["collection-overflow", "held-overflow", "foreign-metric", "foreign-example", "bad-index", "negative-tokens", "rewritten-reward", "incomplete-candidate", "closed-incomplete", "generation-index", "usage-total"]) {
      const { client, pmRoot, approval } = await workspace(); const value = configValue(endpoint.baseURL);
      await assert.rejects(runRlLoop(client, { pmRoot, author: "rl-test" }, { id: "decision-fault", config: value, approval,
        onPhase(phase) { if (phase === (fault === "closed-incomplete" ? "collect" : "train")) throw new Error("pause"); } }));
      if (fault === "generation-index" || fault === "usage-total") {
        const item = await client.get("decision-fault-g1");
        const body = String(item.item.body).replace(fault === "generation-index" ? '"generation": 1' : '"usage_tokens": 44', fault === "generation-index" ? '"generation": 2' : '"usage_tokens": 0');
        await client.update(String(item.item.id), { body });
      } else {
        const notes = client.notes.bind(client);
        client.notes = (async (id, options) => {
          const result = await notes(id, options); assert.ok(!("output_budget_exceeded" in result));
          let events: MetricEvent[] = [...readSeries(result.notes.map((note) => note.text)).events];
          const collection = events.filter((event) => event.metric === "systemone_decision");
          const held = events.filter((event) => event.metric === "systemone_held_out_decision");
          const first = collection[0];
          if (fault === "collection-overflow") events.push({ ...first, step: 2 });
          if (fault === "held-overflow") events.push({ ...held[0], step: 2 });
          if (fault === "foreign-metric") events.push({ step: 0, metric: "foreign", value: 0 });
          if (fault === "foreign-example") events[events.indexOf(first)] = { ...first, tags: { ...first.tags, example: "foreign" } };
          if (fault === "bad-index") events[events.indexOf(first)] = { ...first, step: 7 };
          if (fault === "negative-tokens") events[events.indexOf(first)] = { ...first, tags: { ...first.tags, tokens: "-1" } };
          if (fault === "rewritten-reward") events[events.indexOf(first)] = { ...first, value: first.value === 0 ? 1 : 0 };
          if (fault === "incomplete-candidate" || fault === "closed-incomplete") events = [...collection, held[0]];
          return { ...result, notes: encodeEventSegments(events).map((text) => ({ text, author: "test", created_at: "2026-01-01T00:00:00.000Z" })) };
        }) as PmClient["notes"];
      }
      await assert.rejects(rlLoopStatus(client, "decision-fault"), (error: unknown) => isPmCliExpectedError(error) && error.context.code === "loop_generation_drift", fault);
    }
    const { client, pmRoot, approval } = await workspace();
    const value = { ...configValue(endpoint.baseURL), budget: 4 };
    const request = { id: "query-budget", config: value, approval };
    const report = await runRlLoop(client, { pmRoot, author: "rl-test" }, request); assert.equal(report.stop_reason, "budget_exhausted"); assert.equal(report.samples_consumed, 4);
    assert.deepEqual(stable(await runRlLoop(client, { pmRoot, author: "rl-test" }, request)), stable(report));
    assert.equal((await rlLoopStatus(client, "query-budget")).stop_reason, "budget_exhausted");
    const notes = client.notes.bind(client);
    client.notes = (async (id, options) => {
      const result = await notes(id, options); assert.ok(!("output_budget_exceeded" in result));
      return { ...result, notes: result.notes.slice(0, 1) };
    }) as PmClient["notes"];
    await assert.rejects(runRlLoop(client, { pmRoot, author: "rl-test" }, { id: "finish-incomplete", config: configValue(endpoint.baseURL), approval }));
  } finally { endpoint.server.closeAllConnections(); endpoint.server.close(); }
});


test("SDK controller lease failures propagate without creating job artifacts", async () => {
  for (const error of [new Error("lease IO failure"), createPmCliExpectedError("lease usage failure")]) {
    const { client, pmRoot, approval } = await workspace();
    const harness = await createExtensionTestHarness({ activate(api: ExtensionApi) {
      api.registerService("lock_acquire", (context) => {
        const payload = context.payload as { id: string };
        if (payload.id === loopLeaseLockId("lease-failure")) return { handled: true, result: { get release() { throw error; } } };
        return { handled: false };
      });
    } }, { name: "lease-failure", capabilities: ["services"] });
    const get = client.get.bind(client);
    client.get = (async (id, options) => {
      const result = await get(id, options);
      if (id === approval) setActiveExtensionServices(harness.activation.services);
      return result;
    }) as PmClient["get"];
    try {
      await assert.rejects(runRlLoop(client, { pmRoot, author: "rl-test" }, { id: "lease-failure", config, approval }), (caught: unknown) => caught === error);
    } finally { setActiveExtensionServices(null); }
    await assert.rejects(get("lease-failure-seed"));
  }
});
