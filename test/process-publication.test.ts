/** Full-executor publication faults and native revision fences preserve peer progress and accounting. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { PmClient } from "@unbrained/pm-cli/sdk/core";
import { isPmCliExpectedError } from "@unbrained/pm-cli/sdk/runtime";
import { readLoopRevision, runRlLoop } from "../index.ts";
import { executeProcessTrainer, processDigest, processJobId, processStaging, stopTrainer, readProcessJob, referenceTrainerArgv, reserveProcessJob, RESOURCE_KEYS, transitionProcessJob, type ProcessJobState, type ProcessCoordinates } from "../process.ts";
import { allowance, configuration, processWorkspace, trainingInput } from "./fixtures/process-workspace.ts";

const boundaries = ["prepared", "step_applied", "step_recorded", "committing", "committed", "compensating", "step_compensating", "step_compensated", "compensated"] as const;

/** Read complete native state and a monotonic coordinate through the actual SDK. */
async function evidence(client: PmClient, id: string) {
  return { native: await client.get(id, { full: true, outputBudget: "unbounded", outputLimit: "unbounded" }), revision: await readLoopRevision(client, id) };
}

test("full executor publication faults preserve every peer revision and original cause", async (context) => {
  let cases = 0;
  for (const phase of ["running", "materialized"] as const) for (const peer of ["valid", "foreign"] as const) for (const boundary of boundaries) {
    const resources = { ...allowance, tokens: 4 };
    const { client, coordinates, approval } = await processWorkspace(resources);
    const input = trainingInput(); const adapter = { kind: "process-bandit", allowance: resources } as const;
    const command = referenceTrainerArgv(); const id = processJobId(input, command, adapter);
    const marker = `publication-${phase}-${peer}-${boundary}`;
    let expected: Awaited<ReturnType<typeof evidence>> | undefined;
    const observed = { ...coordinates, async onTransition(step: { transactionId: string; transition: string }) {
      if (!step.transactionId.includes(`-${phase}-v`)) return;
      if (step.transition === boundary) {
        const current = (await client.get(id)).item;
        const body = peer === "foreign" ? "# Foreign peer progress" : JSON.stringify({ ...JSON.parse(String(current.body)) as Record<string, unknown>, outcome: "peer-progress" });
        await client.update(id, { title: "Peer progress", addTags: ["peer-evidence"], body });
        expected = await evidence(client, id);
      }
      if (step.transition === (boundary.startsWith("compens") || boundary.startsWith("step_compens") ? "step_applied" : boundary)) throw new Error(marker);
    } };
    await assert.rejects(executeProcessTrainer(client, observed, input, approval, adapter, undefined, command), (error: unknown) => {
      assert.ok(isPmCliExpectedError(error), String(error));
      assert.equal(error.context.code, "superseded");
      assert.ok(String(error).includes(marker), "an outer cleanup must not replace the original publication refusal");
      return true;
    });
    assert.ok(expected, `${phase}:${peer}:${boundary} was reached`);
    assert.deepEqual(await evidence(client, id), expected, `${phase}:${peer}:${boundary}: full native state and revision retained`);
    if (phase === "running" && peer === "valid") {
      const job = (await readProcessJob(client, id))!;
      assert.deepEqual(job.charge, resources, "every reserved resource remains held");
      assert.equal(job.settled, false);
    }
    cases += 1;
  }
  context.diagnostic(`${cases} full-executor faults across both publication phases and every journal boundary`);
});

test("every process lifecycle transition refuses stale sources and acknowledges a peer winner", async (context) => {
  const transitions: readonly [ProcessJobState, readonly ProcessJobState[]][] = [
    ["planned", ["running", "failed", "cancelled"]], ["running", ["materialized", "failed", "cancelled"]],
    ["materialized", ["evaluated", "failed", "cancelled", "invalidated"]], ["evaluated", ["promoted", "failed", "cancelled", "invalidated"]], ["promoted", ["invalidated"]],
  ];
  const path: readonly ProcessJobState[] = ["running", "materialized", "evaluated", "promoted"];
  let cases = 0;
  for (const [from, targets] of transitions) for (const to of targets) {
    const { client, coordinates, approval } = await processWorkspace(); const input = trainingInput(); const id = processJobId(input);
    let source = await reserveProcessJob(client, coordinates, id, input, approval, allowance);
    for (const state of path) { if (source.state === from) break; source = await transitionProcessJob(client, coordinates, source, state, "fixture-progress"); }
    assert.equal(source.state, from);
    await client.update(id, { body: JSON.stringify({ ...source, outcome: "peer-progress" }), addTags: ["peer-evidence"] });
    const expected = await evidence(client, id);
    await assert.rejects(transitionProcessJob(client, coordinates, source, to, "stale-request"), (error: unknown) => isPmCliExpectedError(error) && error.context.code === "superseded");
    assert.deepEqual(await evidence(client, id), expected, `${from}:${to}`); cases += 1;
  }
  const { client, coordinates, approval } = await processWorkspace(); const input = trainingInput(); const id = processJobId(input);
  const source = await reserveProcessJob(client, coordinates, id, input, approval, allowance);
  const peer = await transitionProcessJob(client, coordinates, source, "running", "same-result");
  const expected = await evidence(client, id);
  assert.deepEqual(await transitionProcessJob(client, coordinates, source, "running", "same-result"), peer);
  assert.deepEqual(await evidence(client, id), expected, "peer success is read back without another write");
  context.diagnostic(`${cases} stale lifecycle transitions plus an unchanged peer winner`);
});

test("native item CAS rejects ABA between the last inspection and write, even at a fixed clock", async (context) => {
  context.mock.timers.enable({ apis: ["Date"], now: new Date("2026-10-29T00:00:00.000Z") });
  try {
    let baselineConfigurations = 0;
    for (const fault of [false, true]) {
      const { client, coordinates, approval } = await processWorkspace(); const input = trainingInput(); const id = processJobId(input);
      const source = await reserveProcessJob(client, coordinates, id, input, approval, allowance);
      let prepared = false; let applied = false; let configurations = 0; let injected = false;
      let expected: Awaited<ReturnType<typeof evidence>> | undefined;
      const intercepted = new Proxy(client, {
        get(target, property, receiver) {
          const value: unknown = Reflect.get(target, property, receiver);
          if (property === "config") return async (...args: Parameters<PmClient["config"]>) => {
            if (prepared && !applied) {
              configurations += 1;
              if (fault && configurations === baselineConfigurations) {
                const original = (await target.get(id)).item;
                await target.update(id, { body: JSON.stringify({ ...source, outcome: "peer-ABA" }) });
                await target.update(id, { body: String(original.body) });
                const restored = (await target.get(id)).item;
                assert.equal(restored.body, original.body); assert.equal(restored.updated_at, original.updated_at);
                injected = true; expected = await evidence(target, id);
              }
            }
            return target.config(...args);
          };
          return typeof value === "function" ? value.bind(target) : value;
        },
      }) as PmClient;
      const observed = { ...coordinates, onTransition(step: { transition: string }) {
        if (step.transition === "prepared") prepared = true;
        if (step.transition === "step_applied") applied = true;
      } };
      const execute = transitionProcessJob(intercepted, observed, source, "running", "launch");
      if (!fault) { await execute; baselineConfigurations = configurations; assert.ok(configurations > 0); }
      else {
        await assert.rejects(execute, (error: unknown) => isPmCliExpectedError(error) && error.context.code === "superseded");
        assert.equal(injected, true);
        assert.deepEqual(await evidence(client, id), expected);
        assert.equal(processDigest((await readProcessJob(client, id))!), processDigest(source));
      }
    }
  } finally { context.mock.timers.reset(); }
});


test("process journals bind the target revision instead of replaying an older prepared plan", async () => {
  const { client, coordinates, approval } = await processWorkspace(); const input = trainingInput(); const id = processJobId(input);
  const source = await reserveProcessJob(client, coordinates, id, input, approval, allowance);
  const firstRevision = await readLoopRevision(client, id); const keys: string[] = [];
  await assert.rejects(transitionProcessJob(client, { ...coordinates, onTransition(step) {
    if (step.transition === "prepared") { keys.push(step.transactionId); throw new Error("prepared journal interruption"); }
  } }, source, "running", "launch"), /prepared journal interruption/);
  assert.ok(keys[0].includes(`-v${firstRevision}-`));
  await client.update(id, { addTags: ["peer-annotation"] });
  const currentRevision = await readLoopRevision(client, id); assert.ok(currentRevision > firstRevision);
  const result = await transitionProcessJob(client, { ...coordinates, onTransition(step) { if (step.transition === "prepared") keys.push(step.transactionId); } }, source, "running", "launch");
  assert.equal(result.state, "running"); assert.equal(keys.length, 2);
  assert.ok(keys[1].includes(`-v${currentRevision}-`)); assert.ok(keys[1].endsWith(processDigest(result).slice(-64))); assert.notEqual(keys[0], keys[1]);
  assert.ok((await client.get(id)).item.tags?.includes("peer-annotation"));
});

test("recursive controller propagates publication refusal and reports peer process state", async () => {
  const { client, coordinates, approval } = await processWorkspace();
  let expected: Awaited<ReturnType<typeof evidence>> | undefined; let jobId: string | undefined;
  const observed: ProcessCoordinates = { ...coordinates, async onTransition(step) {
    const match = /^(process-[a-f0-9]{64})-running-v/.exec(step.transactionId);
    if (match !== null && step.transition === "step_applied") {
      jobId = match[1];
      const job = (await readProcessJob(client, jobId))!;
      await client.update(jobId, { body: JSON.stringify({ ...job, outcome: "peer-controller-progress" }) });
      expected = await evidence(client, jobId);
      throw new Error("recursive publication interruption");
    }
  } };
  await assert.rejects(runRlLoop(client, observed, { id: "publication-controller", config: { ...configuration, max_generations: 1 }, approval }), (error: unknown) => {
    assert.ok(isPmCliExpectedError(error)); assert.equal(error.context.code, "superseded");
    assert.match(String(error), /recursive publication interruption/);
    assert.ok("authoritative_report" in error.context, "the controller reads authoritative peer state");
    return true;
  });
  assert.ok(jobId); assert.ok(expected);
  assert.deepEqual(await evidence(client, jobId), expected);
  const job = (await readProcessJob(client, jobId))!;
  assert.equal(job.state, "running"); assert.equal(job.settled, false); assert.deepEqual(job.charge, allowance);
});


test("unlaunched staging failure cannot refund a peer transition after the captured source", async () => {
  const { client, coordinates, approval, pmRoot } = await processWorkspace(); const input = trainingInput();
  const adapter = { kind: "process-bandit", allowance } as const; const command = referenceTrainerArgv(); const id = processJobId(input, command, adapter);
  const directory = processStaging(pmRoot, id); mkdirSync(dirname(directory), { recursive: true }); writeFileSync(directory, "owned obstruction");
  let reserved = false; let injected = false; let expected: Awaited<ReturnType<typeof evidence>> | undefined;
  const intercepted = new Proxy(client, {
    get(target, property, receiver) {
      const value: unknown = Reflect.get(target, property, receiver);
      if (property === "get") return async (...args: Parameters<PmClient["get"]>) => {
        const result = await target.get(...args);
        if (reserved && !injected && args[0] === id && args[1]?.at !== undefined) {
          injected = true;
          const current = (await readProcessJob(target, id))!;
          await target.update(id, { body: JSON.stringify({ ...current, state: "running", outcome: "peer-started" }) });
          expected = await evidence(target, id);
        }
        return result;
      };
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as PmClient;
  await assert.rejects(executeProcessTrainer(intercepted, { ...coordinates, onTransition(step) { if (step.transactionId.endsWith("-reserve") && step.transition === "committed") reserved = true; } }, input, approval, adapter, undefined, command), (error: unknown) => isPmCliExpectedError(error) && error.context.code === "superseded");
  assert.ok(expected); assert.deepEqual(await evidence(client, id), expected);
  assert.deepEqual((await readProcessJob(client, id))!.charge, allowance);
});

test("real child failure and cancellation cannot settle a peer's newer running revision", async () => {
  for (const cancel of [false, true]) {
    const resources = { ...allowance, tokens: 4 };
    const { client, coordinates, approval, pmRoot } = await processWorkspace(resources); const input = trainingInput();
    const command = [process.execPath, new URL("./fixtures/process-hang.ts", import.meta.url).pathname];
    const adapter = { kind: "process-bandit", allowance: resources } as const; const id = processJobId(input, command, adapter);
    const directory = processStaging(pmRoot, id); const controller = new AbortController();
    const outcome = executeProcessTrainer(client, coordinates, input, approval, adapter, controller.signal, command).then(() => null, (error: unknown) => error);
    try {
      for (let attempt = 0; attempt < 500 && !existsSync(join(directory, "partial.json")); attempt += 1) await delay(10);
      assert.equal(existsSync(join(directory, "partial.json")), true, "the actual child published its readiness artifact");
      const job = (await readProcessJob(client, id))!;
      await client.update(id, { body: JSON.stringify({ ...job, outcome: "peer-live-progress" }), addTags: ["peer-evidence"] });
      const expected = await evidence(client, id);
      if (cancel) controller.abort();
      else {
        const runner = JSON.parse(readFileSync(join(directory, "runner.json"), "utf8")) as { pid: number; start: string };
        stopTrainer(runner.pid, runner.start);
      }
      const error = await outcome; assert.ok(isPmCliExpectedError(error)); assert.equal(error.context.code, "superseded");
      assert.deepEqual(await evidence(client, id), expected);
      const retained = (await readProcessJob(client, id))!; assert.equal(retained.state, "running"); assert.equal(retained.settled, false); assert.deepEqual(retained.charge, resources);
    } finally { controller.abort(); await outcome; }
  }
});


test("shared transition admission retains foreign targets and permits released legacy job envelopes", async () => {
  const { client, coordinates, approval } = await processWorkspace(); const input = trainingInput(); const id = processJobId(input);
  const source = await reserveProcessJob(client, coordinates, id, input, approval, allowance);
  const foreign = processJobId(input, ["foreign-original"]);
  await client.create({ id: foreign, type: "Task", title: "Foreign original", body: "# Foreign package record" });
  const expected = await evidence(client, foreign);
  await assert.rejects(transitionProcessJob(client, coordinates, { ...source, id: foreign }, "running", "foreign-request"), (error: unknown) => isPmCliExpectedError(error) && error.context.code === "superseded");
  assert.deepEqual(await evidence(client, foreign), expected);
  await client.update(id, { body: JSON.stringify(source, null, 2).replaceAll("\n", "\r\n"), removeTags: ["rl-process-job"], parent: "none", goal: "none", objective: "none", sprint: "none", release: "none" });
  const legacy = (await readProcessJob(client, id))!;
  const result = await transitionProcessJob(client, coordinates, legacy, "running", "legacy-progress");
  assert.equal(result.state, "running"); assert.deepEqual(result.charge, allowance);
});


test("transition producers share the reader resource schema and refuse extreme values before writing", async () => {
  const { client, coordinates, approval } = await processWorkspace(); const input = trainingInput(); const id = processJobId(input);
  const source = await reserveProcessJob(client, coordinates, id, input, approval, allowance); const expected = await evidence(client, id);
  for (const key of RESOURCE_KEYS) for (const value of [NaN, Infinity, -Infinity, -1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(transitionProcessJob(client, coordinates, source, "failed", "invalid-charge", null, { ...allowance, [key]: value }), (error: unknown) => isPmCliExpectedError(error) && error.context.code === "process_invalid_resources");
    assert.deepEqual(await evidence(client, id), expected);
  }
  const valid = await transitionProcessJob(client, coordinates, source, "failed", "producer-round-trip");
  assert.deepEqual(await readProcessJob(client, id), valid);
});
