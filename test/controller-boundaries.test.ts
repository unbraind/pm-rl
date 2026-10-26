/** Canonical SDK identities and complete callback failure paths on real non-git trackers. */
import assert from "node:assert/strict";
import { ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { mock, test } from "node:test";
import { readHistoryEntries } from "@unbrained/pm-cli/sdk";
import { createExtensionTestHarness } from "@unbrained/pm-cli/sdk/testing";
import { getHistoryPath, isPmCliExpectedError, normalizeItemId, normalizeRawItemId } from "@unbrained/pm-cli/sdk/runtime";
import { acquireStateLock, canonicalIdentifier, canonicalItemIdentifier, canonicalProgrammeId, commitStateTransaction } from "../state-boundary.ts";
import extension, { resolveEvaluationPlan, evaluationComparison, loopLeaseLockId, loopProcessStartTime, withRlController, runRlLoop, type JsonValue } from "../index.ts";
import { controllerCallback, controllerCallbackIO, executeProcessTrainer, processJobId, processStaging, readProcessJob, reserveProcessJob, stopTrainer } from "../process.ts";
import { allowance, processWorkspace, trainingInput } from "./fixtures/process-workspace.ts";

/** Hold both successful native leases until the competing acquisition has returned. */
async function contenders(root: string, left: string, right: string, same: boolean): Promise<void> {
  const results = await Promise.allSettled([left, right].map((id) => acquireStateLock(root, id, 60, "canonical-test", false, false, 0)));
  try {
    assert.equal(results.filter((result) => result.status === "fulfilled").length, same ? 1 : 2, `${left} / ${right}`);
    for (const result of results) if (result.status === "rejected") assert.ok(isPmCliExpectedError(result.reason));
  } finally { for (const result of results) if (result.status === "fulfilled") await result.value(); }
}

test("canonical identity property: 500 SDK variant pairs share exactly one lease or remain independent", { timeout: 180000 }, async () => {
  const { pmRoot, root, client, coordinates, approval } = await processWorkspace();
  assert.equal(existsSync(join(root, ".git")), false);
  let seed = 0x107ca5e;
  const pool = ["Race", "prefix-Hyphen", "Évaluation", "e\u0301valuation", "Δ-run", "日本語", "under_score"];
  for (let index = 0; index < 500; index += 1) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const left = index === 0 ? "Race" : `${pool[seed % pool.length]}-${index}`;
    const right = index === 0 ? "race" : index % 3 === 0 ? left.normalize(index % 2 === 0 ? "NFC" : "NFD") : index % 3 === 1 ? `#${left.toUpperCase()}` : `${left}-other`;
    const expectedLeft = normalizeRawItemId(left); const expectedRight = normalizeRawItemId(right);
    await contenders(pmRoot, left, right, expectedLeft === expectedRight);
    assert.equal(canonicalIdentifier(left), expectedLeft); assert.equal(canonicalIdentifier(right), expectedRight);
    assert.equal(processStaging(pmRoot, left) === processStaging(pmRoot, right), expectedLeft === expectedRight);
    assert.equal(loopLeaseLockId(left) === loopLeaseLockId(right), expectedLeft === expectedRight);
  }
  const item = await client.create({ id: "Race", title: "Canonical native item", type: "Task" });
  for (const variant of ["Race", "race", "#RACE", "rl-RACE"]) {
    assert.equal((await client.get(variant)).item.id, item.item.id);
    assert.equal(canonicalItemIdentifier(variant, "rl"), normalizeItemId(variant, "rl"));
    assert.equal(await canonicalProgrammeId(client, variant), "race");
  }
  await contenders(pmRoot, loopLeaseLockId(await canonicalProgrammeId(client, "Race")), loopLeaseLockId(await canonicalProgrammeId(client, "rl-RACE")), true);
  // Strict round-one whitespace refusal remains in force, even when the SDK's permissive resolver would trim it.
  for (const variant of [" Race", "race ", "\tRace\r\n"]) {
    assert.equal(normalizeItemId(variant, "rl"), item.item.id);
    assert.throws(() => canonicalIdentifier(variant), (error) => isPmCliExpectedError(error) && error.context.code === "rl_identifier_invalid");
    await assert.rejects(canonicalProgrammeId(client, variant), isPmCliExpectedError);
  }
  const unresolved = { format: "pm-rl/evaluation-plan/1", candidate: "Race", incumbent: "#INCUMBENT", incumbent_version: "v1", population: "test", selection: "all", correlation_unit: "session", members: [{ id: "m", unit: "u" }], objective: "reward", objective_version: "v1", evaluation_context: "held-out", direction: "maximize", reward_bounds: [0, 1], criterion: { confidence: 0.95, minSamples: 1, effectThreshold: 0 }, stopping: { kind: "sequential", method: "hoeffding-alpha-spending/1", observations: 1, independent_units: 1, unit_order: ["u"], looks: [1], review: "#REVIEW" } };
  const plan = await resolveEvaluationPlan(client, unresolved);
  assert.equal(plan.candidate, normalizeItemId("Race", "rl"));
  assert.equal(evaluationComparison(plan), evaluationComparison(await resolveEvaluationPlan(client, { ...unresolved, candidate: "rl-race", incumbent: "rl-incumbent", stopping: { ...unresolved.stopping, review: "rl-review" } })));
  let applied = 0;
  for (const transactionId of ["Case-Journal", "case-journal"]) await commitStateTransaction({ pmRoot, transactionId, author: "canonical-test", steps: [{ id: transactionId === "Case-Journal" ? "Apply" : "apply",
    inspect: async () => ({ state: (await client.get(item.item.id)).item.priority === 1 ? "applied" : "pending" }),
    apply: async () => { applied += 1; await client.update(item.item.id, { priority: 1 }); }, compensate: async () => undefined,
  }] });
  assert.equal(applied, 1); assert.equal((await client.get(item.item.id)).item.priority, 1);
  const input = trainingInput(); const jobId = processJobId(input);
  const reserved = await reserveProcessJob(client, coordinates, jobId.toUpperCase(), input, approval, allowance);
  assert.deepEqual(await reserveProcessJob(client, coordinates, `#rl-${jobId.toUpperCase()}`, input, approval, allowance), reserved);
  assert.equal((await readProcessJob(client, `rl-${jobId.toUpperCase()}`))!.id, jobId);
  assert.equal(JSON.parse(String((await client.get(jobId, { full: true })).item.body)).id, jobId);
  console.log(JSON.stringify({ canonical_sequences: 500, sdk_unicode_equivalence: normalizeRawItemId("É") === normalizeRawItemId("E\u0301"), whitespace: "strict-refusal" }));
});

test("Race/race controllers cannot force-claim the same seed concurrently", { timeout: 120000 }, async () => {
  const { client, coordinates, approval } = await processWorkspace();
  const config = { ...JSON.parse(readFileSync(new URL("../examples/loop-bandit.json", import.meta.url), "utf8")) as Record<string, JsonValue>, max_generations: 1 };
  let ready!: () => void; let release!: () => void;
  const started = new Promise<void>((resolve) => { ready = resolve; }); const held = new Promise<void>((resolve) => { release = resolve; });
  const running = runRlLoop(client, coordinates, { id: "Race", approval, config, async onPhase() { ready(); await held; throw new Error("bounded test pause"); } }).then(() => null, (error: unknown) => error);
  await started;
  try {
    const before = await client.get("race-seed", { full: true });
    await assert.rejects(runRlLoop(client, { ...coordinates, author: "competing-controller" }, { id: "race", approval, config }),
      (error) => isPmCliExpectedError(error) && error.context.code === "loop_controller_active");
    assert.deepEqual(await client.get("race-seed", { full: true }), before);
  } finally { release(); assert.match(String(await running), /bounded test pause/); }
});

test("callback wrapper observes synchronous and asynchronous failures in every callback family", async () => {
  for (const name of ["stdout", "stderr", "error", "close", "stdin", "poll", "timer", "abort", "heartbeat", "signal"]) {
    const failures: unknown[] = [];
    controllerCallback(name, (error) => { failures.push(error); }, () => { throw new Error(name); })();
    controllerCallback(name, (error) => { failures.push(error); }, async () => { throw new Error(name); })();
    await new Promise<void>((resolve) => { setImmediate(resolve); });
    assert.equal(failures.length, 2);
  }
  assert.doesNotThrow(() => controllerCallback("throwing-sink", () => { throw new Error("sink"); }, () => { throw new Error("operation"); })());
});

test("actual CLI signal callback failures cancel cleanly and remove owned signal handlers", async () => {
  for (const fault of [true, false]) {
    const { pmRoot, root, client, approval } = await processWorkspace();
    const file = join(root, "programme.json"); writeFileSync(file, readFileSync(new URL("../examples/loop-bandit.json", import.meta.url)));
    const harness = await createExtensionTestHarness(extension, { name: "pm-rl", capabilities: ["commands", "hooks", "schema"] });
    const before = [process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")];
    let injected = false;
    controllerCallbackIO.before = (site) => { if (site === "callback.signal") { injected = true; if (fault) throw new Error("injected signal callback failure"); } };
    const register = process.once.bind(process);
    const dispatch = mock.method(process, "once", (name: string | symbol, listener: (...args: unknown[]) => void) => {
      const result = register(name, listener);
      if (name === "SIGTERM" && new Error().stack?.includes("installCancellationSignals")) listener();
      return result;
    });
    try {
      await assert.rejects(harness.runCommand({ command: "rl loop run", pmRoot, args: ["Signal-Callback"], options: { file, approval }, global: { author: "process-test" } }), (error) => isPmCliExpectedError(error) && error.context.code === "loop_cancelled");
      assert.ok(injected);
      assert.equal((await client.get("signal-callback-seed", { full: true })).item.assignee, undefined);
      assert.ok((await client.comments("signal-callback-seed")).comments.some((entry) => entry.text.includes("cancellation recorded")));
      assert.deepEqual(readdirSync(join(pmRoot, "locks")), []);
      assert.deepEqual([process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")], before);
    } finally { dispatch.mock.restore(); controllerCallbackIO.before = () => undefined; }
  }
});

test("callback fault matrix reaps real children and settles each reservation once", { timeout: 600000 }, async (t) => {
  const budget = { training_steps: 1000, wall_ms: 5000000, storage_bytes: 100000000, compute_units: 1000000, tokens: 0 };
  let { pmRoot, root, client, coordinates, approval } = await processWorkspace(budget);
  const input = trainingInput(); const adapter = { kind: "process-bandit", allowance: { ...allowance, wall_ms: 60000 } } as const;
  const fixture = new URL("./fixtures/process-trainer.ts", import.meta.url).pathname;
  const sites = new Set<string>(); let count = 0;
  let outside = join(root, "outside"); mkdirSync(outside); let tripwire = join(outside, "sentinel"); writeFileSync(tripwire, "unchanged");
  const unhandled: unknown[] = []; const monitor = (error: unknown): void => { unhandled.push(error); };
  process.on("uncaughtExceptionMonitor", monitor); process.on("unhandledRejection", monitor);
  try {
    controllerCallbackIO.before = (site) => { sites.add(site); };
    await executeProcessTrainer(client, coordinates, input, approval, adapter, undefined, [process.execPath, fixture, "callback-good", "baseline"]);
    controllerCallbackIO.before = () => undefined;
    const operations = [...sites].filter((site) => !site.startsWith("callback.")).sort();
    assert.ok(operations.includes("stderr.path") && operations.includes("stdout.read") && operations.includes("poll.staging.list"));
    for (const site of [...operations, "callback.stdout", "callback.stderr", "callback.close", "callback.poll", "callback.timer", "callback.abort", "failure.kill", "failure.kill-all", "review.symlink", "child.symlink"]) {
      for (const code of site.endsWith("symlink") ? ["symlink"] : ["EACCES", "ENOSPC", "ENOENT", "EISDIR", "statePath"]) {
        await t.test(`${site}/${code}`, async () => {
        count += 1; let injected = false;
        // Bound tracker size without deleting any accounting evidence or replacing the real SDK.
        if (count % 10 === 0) {
          ({ pmRoot, root, client, coordinates, approval } = await processWorkspace(budget));
          outside = join(root, "outside"); mkdirSync(outside); tripwire = join(outside, "sentinel"); writeFileSync(tripwire, "unchanged");
        }
        const cancellation = new AbortController();
        const command = [process.execPath, fixture, site === "child.symlink" ? "callback-symlink" : "callback-good", site === "child.symlink" ? tripwire : String(count)];
        const id = processJobId(input, command); const directory = processStaging(pmRoot, id);
        controllerCallbackIO.before = (current) => {
          if (site === "callback.abort" && current === "callback.timer" && !cancellation.signal.aborted) cancellation.abort();
          if (site.startsWith("failure.kill") && current === "stderr.path") throw new Error("force cleanup");
          const target = site === "review.symlink" ? "stderr.path" : site === "failure.kill-all" ? "failure.kill" : site;
          if (current !== target || (injected && site !== "failure.kill-all")) return;
          injected = true;
          if (site === "review.symlink") { symlinkSync(tripwire, join(directory, "stderr.log")); return; }
          throw Object.assign(new Error(`Injected ${code} at ${site}`), { code });
        };
        await assert.rejects(executeProcessTrainer(client, coordinates, input, approval, adapter, cancellation.signal, command), isPmCliExpectedError);
        controllerCallbackIO.before = () => undefined;
        assert.ok(injected || site === "child.symlink", `unreached ${site}`);
        const job = (await readProcessJob(client, id))!; assert.equal(job.state, site === "callback.abort" ? "cancelled" : "failed"); assert.equal(job.settled, true);
        const native = await client.get(id, { full: true });
        const history = await readHistoryEntries(getHistoryPath(pmRoot, native.item.id), native.item.id);
        assert.equal(history.filter((entry) => entry.patch.some((patch) => patch.path === "/body" && "value" in patch && typeof patch.value === "string" && (patch.value.includes('"state":"failed"') || patch.value.includes('"state":"cancelled"')))).length, 1);
        const runner = JSON.parse(readFileSync(join(directory, "runner.json"), "utf8")) as { pid: number };
        assert.throws(() => process.kill(runner.pid, 0), { code: "ESRCH" });
        assert.deepEqual(readdirSync(join(pmRoot, "locks")), []);
        assert.equal(readFileSync(tripwire, "utf8"), "unchanged"); assert.deepEqual(readdirSync(outside), ["sentinel"]);
        const saved = await client.get(id, { full: true });
        await assert.rejects(executeProcessTrainer(client, coordinates, input, approval, adapter, undefined, command));
        assert.deepEqual(await client.get(id, { full: true }), saved);
        if (count % 20 === 0) console.log(JSON.stringify({ fault_cases_verified: count }));
        });
      }
    }
    assert.deepEqual(unhandled, []); console.log(JSON.stringify({ callback_operation_sites: operations, fault_cases: count, unhandled: unhandled.length }));
  } finally { controllerCallbackIO.before = () => undefined; process.removeListener("uncaughtExceptionMonitor", monitor); process.removeListener("unhandledRejection", monitor); }
});


test("heartbeat callback failures retain a terminal audit and release the owned claim and lease", async () => {
  const { client, coordinates, approval, pmRoot } = await processWorkspace();
  const interval = globalThis.setInterval;
  const clock = mock.method(globalThis, "setInterval", (callback: () => void, milliseconds?: number) => interval(callback, milliseconds === 20000 ? 25 : milliseconds));
  let injected = false;
  controllerCallbackIO.before = (site) => { if (site === "callback.heartbeat" && !injected) { injected = true; throw new Error("injected heartbeat failure"); } };
  const config = { ...JSON.parse(readFileSync(new URL("../examples/loop-bandit.json", import.meta.url), "utf8")) as Record<string, JsonValue>, max_generations: 1 };
  try {
    await assert.rejects(runRlLoop(client, coordinates, { id: "Heartbeat", approval, config }), (error) => isPmCliExpectedError(error) && error.context.code === "loop_callback_failed");
    assert.ok(injected);
    assert.equal((await client.get("heartbeat-seed", { full: true })).item.assignee, undefined);
    const notes = await client.comments("heartbeat-seed");
    assert.equal(notes.comments.filter((entry) => entry.text.includes("terminal callback failure")).length, 1);
    assert.deepEqual(readdirSync(join(pmRoot, "locks")), []);
    const outer = await processWorkspace(); const outerFault = { injected: false };
    controllerCallbackIO.before = (site) => { if (site === "callback.heartbeat" && !outerFault.injected) { outerFault.injected = true; throw new Error("outer heartbeat failure"); } };
    const comments = outer.client.comments.bind(outer.client); let lost = false;
    outer.client.comments = (async (...args: Parameters<typeof outer.client.comments>) => {
      const result = await comments(...args);
      if (args[1]?.add?.includes("terminal callback failure")) { lost = true; throw new Error("lost terminal audit response"); }
      return result;
    }) as typeof outer.client.comments;
    await assert.rejects(withRlController(outer.client, outer.coordinates, { id: "Heartbeat-Outer", approval: outer.approval, recoveryCommand: "resume outer" }, new AbortController().signal, async (step) => {
      await new Promise<void>((resolve) => { setTimeout(resolve, 75); });
      await step("check", {}, async () => ({}));
    }), (error) => isPmCliExpectedError(error) && error.context.code === "loop_callback_failed");
    assert.ok(outerFault.injected && lost);
    assert.equal((await comments(outer.approval)).comments.filter((entry) => entry.text.includes("terminal callback failure")).length, 1);
    assert.deepEqual(readdirSync(join(outer.pmRoot, "locks")), []);
  } finally { controllerCallbackIO.before = () => undefined; clock.mock.restore(); }
});

test("recovery stops only the exact live trainer birth identity and awaits native reaping", async () => {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"]);
  await once(child, "spawn");
  const closed = once(child, "close");
  try {
    const identity = loopProcessStartTime(child.pid!); assert.ok(identity);
    stopTrainer(child.pid!, `${identity}-foreign`); assert.equal(process.kill(child.pid!, 0), true);
    stopTrainer(child.pid!, identity); assert.equal((await closed)[1], "SIGKILL");
  } finally { if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await closed; } }
});

test("a false native stop result and emitted error cannot recurse or bypass reaping", async () => {
  const { client, coordinates, approval, pmRoot } = await processWorkspace(); const input = trainingInput();
  const command = [process.execPath, new URL("./fixtures/process-trainer.ts", import.meta.url).pathname, "callback-good", "false-stop"];
  const native = ChildProcess.prototype.kill; let calls = 0;
  const stop = mock.method(ChildProcess.prototype, "kill", function (this: ChildProcess, signal?: NodeJS.Signals | number): boolean {
    calls += 1;
    if (calls === 1) {
      this.emit("error", Object.assign(new Error("transient native stop failure"), { code: "EACCES" }));
      this.emit("error", Object.assign(new Error("repeated native stop failure"), { code: "EACCES" }));
      return false;
    }
    return native.call(this, signal);
  });
  controllerCallbackIO.before = (site) => { if (site === "stderr.path") throw new Error("diagnostic failure"); };
  try {
    await assert.rejects(executeProcessTrainer(client, coordinates, input, approval, { kind: "process-bandit", allowance }, undefined, command), isPmCliExpectedError);
    assert.equal(calls, 1, "fallback uses the owned native PID instead of recursively dispatching stop errors");
    const job = (await readProcessJob(client, processJobId(input, command)))!; assert.equal(job.settled, true); assert.equal(job.state, "failed");
    const runner = JSON.parse(readFileSync(join(processStaging(pmRoot, job.id), "runner.json"), "utf8")) as { pid: number };
    assert.throws(() => process.kill(runner.pid, 0), { code: "ESRCH" }); assert.deepEqual(readdirSync(join(pmRoot, "locks")), []);
  } finally { controllerCallbackIO.before = () => undefined; stop.mock.restore(); }
});
