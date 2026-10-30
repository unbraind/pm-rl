/** Full-executor publication faults and native revision fences preserve peer progress and accounting. */
import assert from "node:assert/strict";
import { test } from "node:test";
import fs, { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { PmClient } from "@unbrained/pm-cli/sdk/core";
import { isPmCliExpectedError } from "@unbrained/pm-cli/sdk/runtime";
import { readLoopRevision, runRlLoop } from "../index.ts";
import { executeProcessTrainer, processDigest, processJobId, processStaging, stopTrainer, readProcessJob, referenceTrainerArgv, reserveProcessJob, RESOURCE_KEYS, transitionProcessJob, type ProcessCompletion, type ProcessJobState, type ProcessCoordinates } from "../process.ts";
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

test("executor and publication final reads refuse advancement at every remaining snapshot gap", async () => {
  for (const gap of ["reservation", "running-snapshot", "running-publication", "materialized-publication"] as const) {
    const { client, coordinates, approval } = await processWorkspace(); const input = trainingInput(); const command = referenceTrainerArgv();
    const adapter = { kind: "process-bandit", allowance } as const; const id = processJobId(input, command, adapter);
    let armed = false; let injected = false; let expected: Awaited<ReturnType<typeof evidence>> | undefined;
    /** Commit actual peer progress after the requested observation, without throwing from the observer. */
    const advance = async (): Promise<void> => {
      injected = true;
      const current = (await readProcessJob(client, id))!;
      await client.update(id, { body: JSON.stringify({ ...current, outcome: `peer-${gap}` }), addTags: ["peer-evidence"] });
      expected = await evidence(client, id);
    };
    const intercepted = new Proxy(client, {
      get(target, property, receiver) {
        const value: unknown = Reflect.get(target, property, receiver);
        if (property === "get") return async (...args: Parameters<PmClient["get"]>) => {
          const result = await target.get(...args);
          if (armed && !injected && args[0] === id && (gap === "reservation" ? args[1]?.at === undefined : args[1]?.at !== undefined)) await advance();
          return result;
        };
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as PmClient;
    const observed: ProcessCoordinates = { ...coordinates, async onTransition(step) {
      if (step.transition !== "committed") return;
      if (gap === "reservation" && step.transactionId.endsWith("-reserve")) armed = true;
      if (gap === "running-snapshot" && step.transactionId.includes("-running-v")) armed = true;
      if ((gap === "running-publication" || gap === "materialized-publication") && step.transactionId.includes(`-${gap.split("-")[0]}-v`)) await advance();
    } };
    await assert.rejects(executeProcessTrainer(intercepted, observed, input, approval, adapter, undefined, command), (error: unknown) => isPmCliExpectedError(error) && error.context.code === "superseded");
    assert.ok(injected, gap); assert.ok(expected); assert.deepEqual(await evidence(client, id), expected, gap);
  }
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

test("staging creation failures refund only planned jobs and preserve every exhausted budget dimension", async (context) => {
  let cases = 0;
  const resources = { ...allowance, tokens: 4 };
  for (const state of ["planned", "running"] as const) for (const obstruction of ["directory", "ancestor"] as const) for (const key of RESOURCE_KEYS) {
    const budget = Object.fromEntries(RESOURCE_KEYS.map((dimension) => [dimension, resources[dimension] * (dimension === key ? 1 : 2)])) as typeof resources;
    const { client, coordinates, approval, pmRoot } = await processWorkspace(budget);
    const input = trainingInput(); const command = referenceTrainerArgv(); const adapter = { kind: "process-bandit", allowance: resources } as const;
    const id = processJobId(input, command, adapter);
    const reserved = await reserveProcessJob(client, coordinates, id, input, approval, resources);
    if (state === "running") await transitionProcessJob(client, coordinates, reserved, "running", "previous-execution");
    const directory = processStaging(pmRoot, id); const blocked = obstruction === "directory" ? directory : dirname(directory);
    mkdirSync(dirname(blocked), { recursive: true }); writeFileSync(blocked, "retained staging obstruction");
    await assert.rejects(executeProcessTrainer(client, coordinates, input, approval, adapter, undefined, command), (error: unknown) => error instanceof Error && "code" in error && ["EEXIST", "ENOTDIR"].includes(String(error.code)));
    const failed = (await readProcessJob(client, id))!;
    assert.equal(failed.state, "failed"); assert.equal(failed.settled, true);
    for (const dimension of RESOURCE_KEYS) assert.equal(failed.charge[dimension], state === "running" ? resources[dimension] : 0, `${state}:${obstruction}:${key}:${dimension}`);
    assert.equal(readFileSync(blocked, "utf8"), "retained staging obstruction");
    const current = await evidence(client, id);
    await assert.rejects(executeProcessTrainer(client, coordinates, input, approval, adapter, undefined, command), (error: unknown) => isPmCliExpectedError(error) && error.context.code === "process_job_terminal");
    assert.deepEqual(await evidence(client, id), current, "replay never refunds again");
    const next = { ...input, identity: { next: true, original: input.identity } }; const nextId = processJobId(next, command, adapter);
    if (state === "running") {
      await assert.rejects(reserveProcessJob(client, coordinates, nextId, next, approval, resources), (error: unknown) => isPmCliExpectedError(error) && error.context.code === "process_budget_exhausted" && String(error).includes(key));
      assert.equal(await readProcessJob(client, nextId), null);
    } else assert.equal((await reserveProcessJob(client, coordinates, nextId, next, approval, resources)).state, "planned");
    cases += 1;
  }
  context.diagnostic(`${cases} planned/running recovery cases, both real filesystem obstructions and all five budget dimensions`);
});

test("every failure settlement edge refuses resource refunds even with claimed completion evidence", async (context) => {
  const edges: readonly [ProcessJobState, readonly ProcessJobState[]][] = [
    ["running", ["materialized", "failed", "cancelled"]], ["materialized", ["failed", "cancelled", "invalidated"]],
    ["evaluated", ["failed", "cancelled", "invalidated"]], ["promoted", ["invalidated"]],
  ];
  let cases = 0;
  const resources = { ...allowance, tokens: 4 };
  for (const [from, targets] of edges) for (const to of targets) {
    const { client, coordinates, approval } = await processWorkspace(resources); const input = trainingInput(); const id = processJobId(input);
    let source = await reserveProcessJob(client, coordinates, id, input, approval, resources);
    for (const state of ["running", "materialized", "evaluated", "promoted"] as const) {
      source = await transitionProcessJob(client, coordinates, source, state, "fixture-progress");
      if (state === from) break;
    }
    const current = await evidence(client, id);
    for (const key of RESOURCE_KEYS) {
      const charge = { ...resources, [key]: resources[key] - 1 };
      const claimed: ProcessCompletion = { format: "pm-rl/process-completion/1", job: id, checkpoint: "checkpoint.json", digest: input.source.digest, policy: input.source, training_config: input.training_config, source_policy: input.source.digest, lineage: input.lineage, usage: charge };
      for (const completion of [null, claimed]) {
        await assert.rejects(transitionProcessJob(client, coordinates, source, to, "unproven-refund", completion, charge), (error: unknown) => isPmCliExpectedError(error) && error.context.code === "process_charge_regression");
        assert.deepEqual(await evidence(client, id), current); cases += 1;
      }
    }
    const retained = await transitionProcessJob(client, coordinates, source, to, "retained-consumption", null, resources);
    assert.deepEqual((await readProcessJob(client, id))!.charge, resources); assert.equal(retained.state, to);
  }
  context.diagnostic(`${cases} refund refusals across every failure/cancellation/invalidation edge and resource dimension`);
});

test("staging failures cannot refund a rewritten or annotated planned reservation", async () => {
  for (const priorExecution of [false, true]) {
    const resources = { ...allowance, tokens: 4 };
    const { client, coordinates, approval, pmRoot } = await processWorkspace(resources); const input = trainingInput();
    const command = referenceTrainerArgv(); const adapter = { kind: "process-bandit", allowance: resources } as const; const id = processJobId(input, command, adapter);
    const reserved = await reserveProcessJob(client, coordinates, id, input, approval, resources);
    if (priorExecution) await transitionProcessJob(client, coordinates, reserved, "running", "previous-execution");
    await client.update(id, { body: JSON.stringify(reserved), addTags: ["peer-annotation"] });
    assert.ok(await readLoopRevision(client, id) > 1);
    const current = await evidence(client, id);
    await assert.rejects(transitionProcessJob(client, coordinates, (await readProcessJob(client, id))!, "failed", "unproven-refund", null, { training_steps: 0, wall_ms: 0, storage_bytes: 0, compute_units: 0, tokens: 0 }), (error: unknown) => isPmCliExpectedError(error) && error.context.code === "process_charge_regression");
    assert.deepEqual(await evidence(client, id), current);
    const directory = processStaging(pmRoot, id); mkdirSync(dirname(directory), { recursive: true }); writeFileSync(directory, "retained staging obstruction");
    await assert.rejects(executeProcessTrainer(client, coordinates, input, approval, adapter, undefined, command));
    const settled = (await readProcessJob(client, id))!; assert.equal(settled.state, "failed"); assert.deepEqual(settled.charge, resources);
    const next = { ...input, identity: { next: true } };
    await assert.rejects(reserveProcessJob(client, coordinates, processJobId(next, command, adapter), next, approval, resources), (error: unknown) => isPmCliExpectedError(error) && error.context.code === "process_budget_exhausted");
  }
});

test("recovery settlement retains reservations when either usage report becomes unreadable and charges observable excess", async (context) => {
  const resources = { ...allowance, tokens: 4 };
  for (const report of ["completion.json", "events.ndjson", "excess"] as const) {
    const { client, coordinates, approval, pmRoot } = await processWorkspace(resources); const input = trainingInput();
    const adapter = { kind: "process-bandit", allowance: resources } as const; const command = referenceTrainerArgv(); const id = processJobId(input, command, adapter);
    const reserved = await reserveProcessJob(client, coordinates, id, input, approval, resources);
    await transitionProcessJob(client, coordinates, reserved, "running", "previous-execution");
    const directory = processStaging(pmRoot, id); mkdirSync(directory, { recursive: true });
    const file = join(directory, report === "excess" ? "events.ndjson" : report);
    const usage = Object.fromEntries(RESOURCE_KEYS.map((key) => [key, resources[key] + 1]));
    writeFileSync(file, JSON.stringify({ usage }) + "\n");
    const read = fs.readFileSync; let refusedReads = 0;
    const fault = context.mock.method(fs, "readFileSync", ((...args: Parameters<typeof fs.readFileSync>) => {
      if (report !== "excess" && String(args[0]) === file) { refusedReads += 1; throw Object.assign(new Error("staging report access denied"), { code: "EACCES" }); }
      return read(...args);
    }) as typeof fs.readFileSync);
    syncBuiltinESMExports();
    try {
      await assert.rejects(executeProcessTrainer(client, coordinates, input, approval, adapter, undefined, command));
      const settled = (await readProcessJob(client, id))!; assert.equal(settled.state, "failed"); assert.equal(settled.settled, true);
      if (report !== "excess") { assert.ok(refusedReads > 0); assert.deepEqual(settled.charge, resources); }
      else for (const key of RESOURCE_KEYS) assert.ok(settled.charge[key] >= resources[key] + 1, key);
    } finally { fault.mock.restore(); syncBuiltinESMExports(); }
    assert.equal(readFileSync(file, "utf8"), JSON.stringify({ usage }) + "\n");
  }
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
