/** Real process controller contention, crash windows, signal cancellation and recursive successor use. */
import assert from "node:assert/strict";
import { fork, execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { join, resolve } from "node:path";
import { createExtensionTestHarness } from "@unbrained/pm-cli/sdk/testing";
import { PmClient } from "@unbrained/pm-cli/sdk/core";
import { test } from "node:test";
import extension, { resumeRlLoop, rlLoopStatus, runRlLoop, hashJson, type JsonValue } from "../index.ts";
import { readProcessJob, processStaging, executeProcessTrainer } from "../process.ts";
import { loopEnvironmentSpec, parseLoopConfig, banditProcessInput, runLoopGeneration } from "../loop.ts";
import { banditCheckpoint } from "../bandit.ts";
import { configuration, processWorkspace } from "./fixtures/process-workspace.ts";
// Node's parent coverage hooks remain active; SIGKILL-able children must not inherit its raw-report directory.
delete process.env["NODE_V8_COVERAGE"];

/** Launch a real controller with explicit IPC barriers and retain every structured result. */
function controller(pmRoot: string, approval: string, mode: string, config: JsonValue = configuration) {
  const child = fork(new URL("./fixtures/process-controller.ts", import.meta.url), [pmRoot, approval, JSON.stringify(config), mode], { silent: true, execArgv: [], env: { ...process.env, NODE_V8_COVERAGE: undefined } });
  const messages: unknown[] = []; let stderr = ""; child.stderr!.on("data", (chunk: Buffer) => { stderr += String(chunk); });
  const result = new Promise<{ code: number | null; messages: unknown[] }>((resolve, reject) => { child.on("error", reject); child.on("message", (message) => messages.push(message)); child.on("exit", (code) => { if (code !== 0 && messages.length === 0) reject(new Error(stderr)); else resolve({ code, messages }); }); });
  /** Observe one named barrier, including an already queued IPC notification. */
  const ready = (name = "ready"): Promise<void> => messages.includes(name) ? Promise.resolve() : new Promise((resolve, reject) => { child.on("message", (message) => { if (message === name) resolve(); }); child.once("exit", () => reject(new Error(`Controller exited before ${name}: ${stderr}`))); });
  return { child, result, ready };
}
/** Read retained job bodies from the real complete workspace inventory. */
async function jobs(client: Awaited<ReturnType<typeof processWorkspace>>["client"]) {
  const listed = await client.listAllComplete({ includeBody: true });
  return listed.items.filter((item) => String(item.body).includes('"format":"pm-rl/process-job/1"')).map((item) => JSON.parse(String(item.body)) as { id: string; state: string; charge: { training_steps: number }; settled: boolean });
}

test("two process generations collect with the externally trained promoted successor", async () => {
  const { client, coordinates, approval, pmRoot } = await processWorkspace();
  await client.create({ id: "ordinary-task", type: "Task", title: "Unrelated planning task", body: "Generic planning context" });
  const report = await runRlLoop(client, coordinates, { id: "recursive-process", config: configuration, approval });
  assert.equal(report.promoted, 2); assert.notEqual(report.generations[0].candidate_checkpoint, report.final_checkpoint);
  const first = await client.get(report.generations[0].item); const second = await client.get(report.generations[1].run);
  assert.ok(String(first.item.body).includes(report.generations[0].candidate_checkpoint)); assert.equal(second.item.component, report.generations[0].candidate_checkpoint);
  const retained = await jobs(client); assert.equal(retained.length, 2); assert.ok(retained.every((job) => job.state === "promoted" && job.charge.training_steps === 1 && job.settled));
  const before = retained.map((job) => readFileSync(join(processStaging(pmRoot, job.id), "checkpoint.json"), "utf8"));
  const resumed = await resumeRlLoop(client, coordinates, { id: "recursive-process", approval }); assert.equal(resumed.resumed_generations, 2);
  assert.deepEqual((await jobs(client)), retained); assert.deepEqual(retained.map((job) => readFileSync(join(processStaging(pmRoot, job.id), "checkpoint.json"), "utf8")), before);
  assert.equal((await rlLoopStatus(client, "recursive-process", pmRoot)).final_checkpoint, report.final_checkpoint);
  await assert.rejects(rlLoopStatus(client, "recursive-process"), /tracker artifact root/);
});

test("two real controllers race for one job: one launch, one reservation and one checkpoint", async () => {
  const { client, coordinates, approval, pmRoot } = await processWorkspace();
  const config = { ...configuration, max_generations: 1 };
  const contenders = [controller(pmRoot, approval, "race", config), controller(pmRoot, approval, "race", config)];
  await Promise.all(contenders.map((entry) => entry.ready("starting")));
  for (const entry of contenders) entry.child.send("start");
  const winner = await Promise.any(contenders.map(async (entry) => { await entry.ready(); return entry; }));
  const loser = contenders.find((entry) => entry !== winner)!;
  assert.ok(JSON.stringify((await loser.result).messages).includes("loop_controller_active"));
  winner.child.send("continue"); assert.equal((await winner.result).code, 0);
  const retained = await jobs(client); assert.equal(retained.length, 1); assert.equal(retained[0].charge.training_steps, 1);
  const events = readFileSync(join(processStaging(pmRoot, retained[0].id), "events.ndjson"), "utf8").trim().split('\n');
  assert.equal(events.length, 2); assert.equal(events.filter((line) => line.includes('"type":"complete"')).length, 1);
  assert.equal((await resumeRlLoop(client, coordinates, { id: "process-drill", approval })).resumed_generations, 1);
});

test("SIGKILL with a complete checkpoint before receipt commit recovers without retraining or double charge", async () => {
  const { client, coordinates, approval, pmRoot } = await processWorkspace();
  const config = { ...configuration, max_generations: 1 };
  const running = controller(pmRoot, approval, "materialized", config); await running.ready();
  const [job] = await jobs(client); assert.equal(job.state, "running");
  const directory = processStaging(pmRoot, job.id); const checkpoint = readFileSync(join(directory, "checkpoint.json"), "utf8");
  const events = readFileSync(join(directory, "events.ndjson"), "utf8"); assert.ok(existsSync(join(directory, "completion.json")));
  running.child.kill("SIGKILL"); await running.result;
  const recovered = await resumeRlLoop(client, coordinates, { id: "process-drill", approval }); assert.equal(recovered.promoted, 1);
  assert.equal(readFileSync(join(directory, "checkpoint.json"), "utf8"), checkpoint); assert.equal(readFileSync(join(directory, "events.ndjson"), "utf8"), events);
  assert.equal((await readProcessJob(client, job.id))!.charge.training_steps, 1); assert.equal((await jobs(client)).length, 1);
});

test("SIGTERM mid-training cancels the child, retains artifacts and settles its reservation", async () => {
  const { client, coordinates, approval, pmRoot } = await processWorkspace(); const running = controller(pmRoot, approval, "cancel", { ...configuration, max_generations: 1 });
  let retained: Awaited<ReturnType<typeof jobs>> = [];
  for (let attempt = 0; attempt < 200; attempt += 1) { retained = await jobs(client); if (retained.length === 1 && existsSync(join(processStaging(pmRoot, retained[0].id), "partial.json"))) break; await new Promise<void>((resolve) => { setTimeout(resolve, 25); }); }
  assert.equal(retained.length, 1); const directory = processStaging(pmRoot, retained[0].id); assert.ok(existsSync(join(directory, "partial.json")));
  running.child.kill("SIGTERM"); const result = await running.result; assert.ok(JSON.stringify(result.messages).includes("loop_cancelled"));
  const job = (await readProcessJob(client, retained[0].id))!; assert.equal(job.state, "cancelled"); assert.equal(job.settled, true); assert.equal(job.charge.training_steps, 1);
  assert.equal(readFileSync(join(directory, "partial.json"), "utf8"), "retained partial checkpoint");
  assert.equal((await rlLoopStatus(client, "process-drill", pmRoot)).stop_reason, "process_cancelled");
  await assert.rejects(resumeRlLoop(client, coordinates, { id: "process-drill", approval }), /launcher identity changed/);
  const listed = await client.listAllComplete({}); assert.equal(listed.items.filter((item) => item.type === "Generation").length, 1);
});

test("failed process candidates never become a successor collection policy", async () => {
  for (const mode of ["empty", "checkpoint-only", "corrupt", "oversize"]) {
    const { client, coordinates, approval } = await processWorkspace();
    await assert.rejects(runRlLoop(client, coordinates, { id: "process-failure", config: configuration, approval, processTrainerArgv: [process.execPath, new URL("./fixtures/process-trainer.ts", import.meta.url).pathname, mode] }));
    const listed = await client.listAllComplete({}); assert.equal(listed.items.filter((item) => item.type === "Run").length, 1); assert.equal(listed.items.filter((item) => item.type === "Generation").length, 1);
    const [job] = await jobs(client); assert.equal(job.state, "failed"); assert.equal(job.settled, true);
  }
});


test("real controller crashes after planning, evaluation and promotion resume the same job identity", async () => {
  for (const state of ["planned", "committed-materialized", "evaluated", "promoted"]) {
    const { client, coordinates, approval, pmRoot } = await processWorkspace();
    const running = controller(pmRoot, approval, state, { ...configuration, max_generations: 1 }); await running.ready();
    const [job] = await jobs(client); assert.equal(job.state, state === "committed-materialized" ? "materialized" : state);
    running.child.kill("SIGKILL"); await running.result;
    assert.equal((await resumeRlLoop(client, coordinates, { id: "process-drill", approval })).promoted, 1);
    const final = await jobs(client); assert.equal(final.length, 1); assert.equal(final[0].id, job.id); assert.equal(final[0].charge.training_steps, 1);
  }
});

test("process evaluation and promotion refusals retain the incumbent policy", async () => {
  for (const fault of ["gap", "regression", "budget"]) {
    const { client, coordinates, approval, pmRoot } = await processWorkspace();
    if (fault === "budget") await client.update(approval, { body: '```json\n{"permitted_promotions":1,"resource_budget":{"training_steps":2,"wall_ms":10000,"storage_bytes":131072,"compute_units":2000,"tokens":0}}\n```' });
    const value = fault === "gap" ? { ...configuration, maximum_gap: 0 } : fault === "regression" ? { ...configuration, evaluation: [{ id: "opposite", feature: 0.8, rewards: [1, 0] }] } : configuration;
    const report = await runRlLoop(client, coordinates, { id: "process-reject", config: value, approval });
    assert.equal(report.promoted, fault === "budget" ? 1 : 0); assert.equal(report.generations.at(-1)!.promoted, false);
    const retained = await jobs(client); assert.ok(retained.some((job) => job.state === (fault === "budget" ? "invalidated" : "failed")));
    const status = await rlLoopStatus(client, "process-reject", pmRoot); assert.equal(status.final_checkpoint, report.final_checkpoint); assert.equal(status.next_generation, null);
    // Status keeps the generation verdict the run established instead of the failed job's generic state.
    assert.equal(status.stop_reason, report.stop_reason);
    assert.equal((await resumeRlLoop(client, coordinates, { id: "process-reject", approval })).final_checkpoint, report.final_checkpoint);
  }
});


test("the process command surface returns compact defaults and full JSON from the same durable loop", async () => {
  const { root, pmRoot, approval } = await processWorkspace(); const file = join(root, "config.json"); writeFileSync(file, JSON.stringify({ ...configuration, max_generations: 1 }));
  const harness = await createExtensionTestHarness(extension, { name: "pm-rl", capabilities: ["commands", "hooks", "schema"] });
  const run = await harness.runCommand({ command: "rl loop run", pmRoot, args: ["process-harness"], options: { file, approval }, global: { json: false } }); assert.equal(run.handled, true);
  const json = await harness.runCommand({ command: "rl loop status", pmRoot, args: ["process-harness"], global: { json: true } }); assert.equal(json.handled, true);
  const compact = await harness.runCommand({ command: "rl loop resume", pmRoot, args: ["process-harness"], options: { approval }, global: { json: false } }); assert.equal(compact.handled, true);
});

test("unrelated process jobs preserve reservations, metric notes and lineage in both real worktree merge directions", async () => {
  const { root, pmRoot, client, approval } = await processWorkspace(); const cli = resolve("node_modules/@unbrained/pm-cli/dist/cli.js");
  execFileSync("git", ["init", "-b", "main"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "SteveBot"], { cwd: root }); execFileSync("git", ["config", "user.email", "1153461+unbraind@users.noreply.github.com"], { cwd: root });
  writeFileSync(join(root, ".gitignore"), readFileSync(new URL("../.gitignore", import.meta.url), "utf8"));
  execFileSync(process.execPath, [cli, "merge", "install"], { cwd: root, env: { ...process.env, PM_PATH: pmRoot }, stdio: "ignore" });
  const environmentFile = join(root, "environment.json"); writeFileSync(environmentFile, JSON.stringify(loopEnvironmentSpec(parseLoopConfig(configuration))));
  const harness = await createExtensionTestHarness(extension, { name: "pm-rl", capabilities: ["commands", "hooks", "schema"] });
  await harness.runCommand({ command: "rl env register", pmRoot, options: { file: environmentFile } });
  const extra = await client.create({ id: "approval-b", type: "Decision", title: "Independent branch allocation", body: String((await client.get(approval)).item.body) });
  execFileSync("git", ["add", ".agents/pm", ".gitignore", ".gitattributes"], { cwd: root }); execFileSync("git", ["commit", "-m", "Seed synthetic branch allocations"], { cwd: root, stdio: "ignore" });
  const branches = [join(root, "branch-a"), join(root, "branch-b")];
  for (const [index, branch] of branches.entries()) execFileSync("git", ["worktree", "add", "-b", `process-${index}`, branch, "main"], { cwd: root, stdio: "ignore" });
  const reports = await Promise.all(branches.map((branch, index) => runRlLoop(new PmClient({ pmRoot: join(branch, ".agents/pm"), author: "process-test", noExtensions: true }), { pmRoot: join(branch, ".agents/pm"), author: "process-test" }, { id: `branch-${index}`, config: { ...configuration, max_generations: 1 }, approval: index === 0 ? approval : extra.item.id })));
  const snapshots = [];
  for (const [index, report] of reports.entries()) {
    const branchClient = new PmClient({ pmRoot: join(branches[index], ".agents/pm"), author: "process-test", noExtensions: true });
    snapshots.push({ report, notes: await branchClient.notes(report.generations[0].run), job: report.process_jobs![0] });
    execFileSync("git", ["add", ".agents/pm"], { cwd: branches[index] }); execFileSync("git", ["commit", "-m", "Record synthetic process generation"], { cwd: branches[index], stdio: "ignore" });
  }
  const tips = branches.map((branch) => execFileSync("git", ["rev-parse", "HEAD"], { cwd: branch, encoding: "utf8" }).trim());
  for (const [index, branch] of branches.entries()) {
    execFileSync("git", ["merge", "--no-edit", tips[1 - index]], { cwd: branch, encoding: "utf8" });
    const merged = new PmClient({ pmRoot: join(branch, ".agents/pm"), author: "process-test", noExtensions: true });
    for (const snapshot of snapshots) {
      assert.deepEqual(await merged.notes(snapshot.report.generations[0].run), snapshot.notes);
      assert.deepEqual(await readProcessJob(merged, snapshot.job.id), snapshot.job);
      assert.equal((await merged.get(snapshot.report.generations[0].item)).item.status, "closed");
    }
    assert.equal((await jobs(merged)).length, 2);
    assert.equal((await rlLoopStatus(merged, `branch-${index}`, join(branch, ".agents/pm"))).process_jobs!.length, 1);
  }
});


test("a manually failed materialized or registered candidate cannot progress even with valid checkpoint bytes", async () => {
  for (const phase of ["materialized", "evaluate"] as const) {
    const { client, coordinates, approval, pmRoot } = await processWorkspace();
    if (phase === "materialized") { const running = controller(pmRoot, approval, "committed-materialized"); await running.ready(); running.child.kill("SIGKILL"); await running.result; }
    else await assert.rejects(runRlLoop(client, coordinates, { id: "process-drill", config: configuration, approval, onPhase(current) { if (current === phase) throw new Error("pause for terminal disposition"); } }), /pause for terminal disposition/);
    const [job] = await jobs(client); const full = (await readProcessJob(client, job.id))!;
    await client.update(job.id, { body: JSON.stringify({ ...full, state: "failed", outcome: "explicit_terminal_disposition" }) });
    await assert.rejects(resumeRlLoop(client, coordinates, { id: "process-drill", approval }), /terminal process candidate/);
    // Without a generation verdict, status refuses a terminal job instead of presenting a resumable loop.
    await assert.rejects(rlLoopStatus(client, "process-drill", pmRoot), /terminal process candidate/);
    const after = await client.listAllComplete({ includeBody: true }); assert.ok(!after.items.some((item) => item.type === "Generation" && String(item.body).includes('"promoted": true')));
  }
});


test("a lost controller receipt or multiple job bindings cannot authorize continuation", async () => {
  const { client, coordinates, approval, pmRoot } = await processWorkspace(); const request = { id: "process-drift", config: { ...configuration, max_generations: 1 }, approval };
  const report = await runRlLoop(client, coordinates, request); const step = await client.get(`${request.id}-g1-step-train`);
  const path = join(pmRoot, "decisions", `${step.item.id}.toon`); const retained = readFileSync(path);
  renameSync(path, `${path}.retained`);
  try { await assert.rejects(resumeRlLoop(client, coordinates, { id: request.id, approval }), /no durable trainer receipt/); }
  finally { renameSync(`${path}.retained`, path); }
  assert.equal(readFileSync(path).equals(retained), true);
  const job = report.process_jobs![0]; const id = `process-${"0".repeat(64)}`;
  await client.create({ id, type: "Task", title: "Synthetic conflicting job binding", body: JSON.stringify({ ...job, id }) });
  await assert.rejects(resumeRlLoop(client, coordinates, { id: request.id, approval }), /launcher identity changed/);
});


test("a self-consistent forged train step disagrees with the actual external receipt and blocks promotion", async () => {
  const { client, coordinates, approval } = await processWorkspace(); const id = "forged-step"; const value = { ...configuration, max_generations: 1 }; const config = parseLoopConfig(value);
  const step = { learningRate: config.learningRate, evaluationSamples: config.evaluationSamples }; const source = banditCheckpoint(config.initialWeight);
  const collected = runLoopGeneration(config, step, 1, source, source);
  await assert.rejects(runRlLoop(client, coordinates, { id, config: value, approval, async onPhase(phase) {
    if (phase !== "collect") return;
    await executeProcessTrainer(client, coordinates, banditProcessInput(config, step, 1, collected, id), approval, config.process!);
    const key = `${id}-g1-step-train`; const input = { programme: config.digest, generation: 1, source: source.digest, step: { ...step } }; const result = { forged: true };
    await client.create({ id: key, type: "Decision", title: "Synthetic forged step", body: JSON.stringify({ format: "pm-rl/loop-step/1", key, input: hashJson(input), state: "complete", result, digest: hashJson(result) }) });
  } }), /Process training receipt drifted/);
  assert.equal((await client.listAllComplete({})).items.filter((item) => item.type === "Generation").length, 1);
});


test("parent AbortSignal during an external fit records terminal cancellation and preserves staged evidence", async () => {
  const { client, coordinates, approval, pmRoot } = await processWorkspace(); const abort = new AbortController(); const id = "parent-cancel";
  const argv = [process.execPath, new URL("./fixtures/process-trainer.ts", import.meta.url).pathname, "hang"];
  const outcome = runRlLoop(client, coordinates, { id, config: configuration, approval, signal: abort.signal, processTrainerArgv: argv }).then(() => null, (error: unknown) => error);
  let jobId = "";
  for (let attempt = 0; attempt < 300; attempt += 1) { const retained = await jobs(client); if (retained.length > 0) jobId = retained[0].id; if (jobId.length > 0 && existsSync(join(processStaging(pmRoot, jobId), "partial.json"))) break; await new Promise<void>((resolve) => { setTimeout(resolve, 20); }); }
  assert.ok(existsSync(join(processStaging(pmRoot, jobId), "partial.json"))); abort.abort();
  const error = await outcome; assert.ok(error instanceof Error); assert.match(error.message, /new programme identity/);
  const job = (await readProcessJob(client, jobId))!; assert.equal(job.state, "cancelled"); assert.equal(job.settled, true);
});
