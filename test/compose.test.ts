/** Real Docker Compose contract, container death, cancellation, controller races and successor collection. */
import assert from "node:assert/strict";
import { execFileSync, fork, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { test } from "node:test";
import { composeConfiguration, composeProject, stopComposeTrainer } from "../compose.ts";
import { resumeRlLoop, rlLoopStatus } from "../index.ts";
import { executeProcessTrainer, listProcessJobs, parseProcessAdapter, processJobId, processStaging, readProcessJob, reserveProcessJob, type ProcessAdapter } from "../process.ts";
import { configuration, processWorkspace, trainingInput } from "./fixtures/process-workspace.ts";

// SIGKILL-able controllers and trainers must not leave truncated V8 reports.
delete process.env["NODE_V8_COVERAGE"];
const version = spawnSync("docker", ["compose", "version"], { encoding: "utf8" });
const skip = version.status === 0 ? false : `SKIPPED: docker compose version failed: ${version.error?.message ?? version.stderr.trim()}`;
const allowance = { training_steps: 1, wall_ms: 30_000, storage_bytes: 65_536, compute_units: 1000, tokens: 0 };
const budget = { ...allowance, training_steps: 2, wall_ms: 60_000, storage_bytes: 131_072, compute_units: 2000 };
const images = new Map<string, string>();

/** Build only a local fixture plus the Node base; a build or daemon failure is a hard test failure. */
function adapter(mode = "fit"): ProcessAdapter {
  let image = images.get(mode);
  if (image === undefined) {
    image = execFileSync("docker", ["build", "--quiet", "--file", "test/fixtures/compose.Dockerfile", "--build-arg", `MODE=${mode}`, "."], { encoding: "utf8", timeout: 120_000 }).trim();
    assert.match(image, /^sha256:[a-f0-9]{64}$/u); images.set(mode, image);
  }
  return { kind: "compose-bandit", image, allowance };
}

/** Wait for a durable container barrier, with a bounded timeout and no timing-based assertions. */
async function partial(directory: string): Promise<void> {
  for (let attempt = 0; attempt < 600; attempt += 1) {
    if (existsSync(join(directory, "partial.json"))) return;
    await setTimeout(25);
  }
  assert.fail("Container did not publish its partial artifact");
}

/** Assert cleanup against the exact content-derived name, never a host-wide container query. */
function removed(id: string, directory: string): void {
  const result = spawnSync("docker", ["container", "inspect", `${composeProject(id, directory)}-trainer`], { encoding: "utf8" });
  assert.notEqual(result.status, 0); assert.match(result.stderr, /No such (object|container)/u);
}

/** Fork the real recursive controller, with barriers at the existing transaction boundaries. */
function controller(pmRoot: string, approval: string, mode: string, selected: ProcessAdapter, generations = 1) {
  const config = { ...configuration, adapter: selected, max_generations: generations };
  const child = fork(new URL("./fixtures/process-controller.ts", import.meta.url), [pmRoot, approval, JSON.stringify(config), mode], { silent: true, execArgv: [], env: { ...process.env, NODE_V8_COVERAGE: undefined } });
  const messages: unknown[] = []; let diagnostics = "";
  child.stderr!.on("data", (chunk: Buffer) => { diagnostics += String(chunk); });
  const result = new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.on("message", (message) => messages.push(message)); child.once("exit", (code) => { if (messages.length === 0 && code !== null && code !== 0) reject(new Error(diagnostics)); else resolve(code); }); });
  /** Observe a real IPC barrier, including a notification already received. */
  const ready = (name = "ready"): Promise<void> => messages.includes(name) ? Promise.resolve() : new Promise((resolve, reject) => { child.on("message", (message) => { if (message === name) resolve(); }); child.once("exit", () => reject(new Error(`Controller exited before barrier: ${diagnostics}`))); });
  return { child, result, ready, messages };
}

test("Compose selection binds immutable images and validates isolated configuration", async () => {
  const image = `sha256:${"a".repeat(64)}`; const selected = { kind: "compose-bandit", image, allowance } as const;
  assert.deepEqual(parseProcessAdapter(selected), selected);
  for (const bad of [undefined, 42, "node:22-alpine", "repo@sha256:abc", `sha256:${"g".repeat(64)}`]) assert.throws(() => parseProcessAdapter({ ...selected, image: bad }));
  assert.throws(() => parseProcessAdapter({ ...selected, command: "untrusted" }));
  const input = trainingInput(); const id = processJobId(input, undefined, selected);
  assert.equal(processJobId(input, ["ignored-host-path"], selected), id);
  assert.notEqual(processJobId(input), id);
  assert.notEqual(processJobId(input, undefined, { ...selected, image: `sha256:${"b".repeat(64)}` }), id);
  assert.match(composeProject(id, "."), /^pm-rl-[a-f0-9]{64}$/u); assert.throws(() => composeProject("foreign", "."));
  assert.notEqual(composeProject(id, "workspace-a"), composeProject(id, "workspace-b"));
  const generated = composeConfiguration(image) as { services: { trainer: Record<string, unknown> } };
  assert.equal(generated.services.trainer["network_mode"], "none");
  assert.equal(generated.services.trainer["ports"], undefined); assert.equal(generated.services.trainer["pull_policy"], "never");
  assert.equal(generated.services.trainer["read_only"], true);
  const { root } = await processWorkspace(); const directory = join(root, "staging"); mkdirSync(directory);
  await stopComposeTrainer(directory, id, image, "recovery");
  writeFileSync(join(directory, "compose.json"), "{}");
  await assert.rejects(stopComposeTrainer(directory, id, image, "recovery"), /configuration drifted/);
});

test("real Compose launch produces a receipt and replays one settled reservation", { skip }, async () => {
  const { client, coordinates, approval, pmRoot } = await processWorkspace(budget); const selected = adapter(); const input = trainingInput();
  const job = await executeProcessTrainer(client, coordinates, input, approval, selected);
  assert.equal(job.id, processJobId(input, undefined, selected)); assert.equal(job.state, "materialized"); assert.equal(job.settled, true);
  assert.equal(job.charge.training_steps, 1); assert.notEqual(job.completion!.policy.digest, input.source.digest);
  const directory = processStaging(pmRoot, job.id); const retained = readFileSync(join(directory, "completion.json"));
  assert.deepEqual(await executeProcessTrainer(client, coordinates, input, approval, selected), job);
  assert.deepEqual(readFileSync(join(directory, "completion.json")), retained);
  assert.equal(readFileSync(join(directory, "launches.ndjson"), "utf8").trim().split("\n").length, 1);
  assert.equal(JSON.parse(readFileSync(join(directory, "compose-stop.json"), "utf8")).reason, "exited"); removed(job.id, processStaging(pmRoot, job.id));
});

test("real Compose container death retains staging, commits failure and releases the active reservation", { skip }, async () => {
  const { client, coordinates, approval, pmRoot } = await processWorkspace(budget); const selected = adapter("hang"); const input = trainingInput(); const id = processJobId(input, undefined, selected);
  const directory = processStaging(pmRoot, id);
  const run = assert.rejects(executeProcessTrainer(client, coordinates, input, approval, selected), /unsuccessfully/);
  await partial(directory); execFileSync("docker", ["kill", `${composeProject(id, directory)}-trainer`], { stdio: "ignore" }); await run;
  const job = (await readProcessJob(client, id))!;
  assert.equal(job.state, "failed"); assert.equal(job.outcome, "trainer_failure"); assert.equal(job.settled, true);
  assert.deepEqual(job.charge, allowance); assert.ok(existsSync(join(directory, "partial.json")));
  assert.equal(JSON.parse(readFileSync(join(directory, "compose-stop.json"), "utf8")).reason, "failed");
  assert.equal((await listProcessJobs(client)).filter((entry) => !entry.settled).length, 0); removed(id, directory);
  await assert.rejects(executeProcessTrainer(client, coordinates, input, approval, selected), /Process job is failed/);
});

test("real Compose cancellation stops the container and retains attributable cancellation evidence", { skip }, async () => {
  const { client, coordinates, approval, pmRoot } = await processWorkspace(budget); const selected = adapter("hang"); const input = trainingInput(); const id = processJobId(input, undefined, selected);
  const directory = processStaging(pmRoot, id); const abort = new AbortController();
  const run = assert.rejects(executeProcessTrainer(client, coordinates, input, approval, selected, abort.signal), /cancelled/);
  await partial(directory); abort.abort(); await run;
  const job = (await readProcessJob(client, id))!;
  assert.equal(job.state, "cancelled"); assert.equal(job.outcome, "process_cancelled"); assert.equal(job.settled, true);
  assert.equal(JSON.parse(readFileSync(join(directory, "compose-stop.json"), "utf8")).reason, "cancelled");
  assert.ok(readFileSync(join(pmRoot, "history", `rl-${id}.jsonl`), "utf8").includes("process_cancelled"));
  assert.ok(existsSync(join(directory, "partial.json"))); removed(id, directory);
});

test("two real Compose controllers produce exactly one launch and one reservation", { skip }, async () => {
  const { client, coordinates, approval, pmRoot } = await processWorkspace(budget); const selected = adapter();
  const contenders = [controller(pmRoot, approval, "race", selected), controller(pmRoot, approval, "race", selected)];
  await Promise.all(contenders.map((entry) => entry.ready("starting")));
  for (const entry of contenders) entry.child.send("start");
  const winner = await Promise.any(contenders.map(async (entry) => { await entry.ready(); return entry; }));
  const loser = contenders.find((entry) => entry !== winner)!;
  assert.equal(await loser.result, 1); assert.ok(JSON.stringify(loser.messages).includes("loop_controller_active"));
  winner.child.send("continue"); assert.equal(await winner.result, 0);
  const jobs = await listProcessJobs(client); assert.equal(jobs.length, 1); assert.equal(jobs[0].charge.training_steps, 1);
  const directory = processStaging(pmRoot, jobs[0].id);
  assert.equal(readFileSync(join(directory, "launches.ndjson"), "utf8").trim().split("\n").length, 1);
  assert.equal((await resumeRlLoop(client, coordinates, { id: "process-drill", approval })).resumed_generations, 1); removed(jobs[0].id, directory);
});

test("real Compose completed staging survives controller SIGKILL before receipt commit", { skip }, async () => {
  const { client, coordinates, approval, pmRoot } = await processWorkspace(budget); const selected = adapter();
  const running = controller(pmRoot, approval, "materialized", selected); await running.ready();
  const [job] = await listProcessJobs(client); assert.equal(job.state, "running"); const directory = processStaging(pmRoot, job.id);
  const checkpoint = readFileSync(join(directory, "checkpoint.json")); const completion = readFileSync(join(directory, "completion.json"));
  running.child.kill("SIGKILL"); await running.result;
  assert.equal((await resumeRlLoop(client, coordinates, { id: "process-drill", approval })).promoted, 1);
  assert.deepEqual(readFileSync(join(directory, "checkpoint.json")), checkpoint); assert.deepEqual(readFileSync(join(directory, "completion.json")), completion);
  assert.equal(readFileSync(join(directory, "launches.ndjson"), "utf8").trim().split("\n").length, 1);
  assert.equal((await listProcessJobs(client)).length, 1); removed(job.id, processStaging(pmRoot, job.id));
});

test("real Compose recovery terminates an orphan trainer without relaunching a running job", { skip }, async () => {
  const { client, coordinates, approval, pmRoot } = await processWorkspace(budget); const selected = adapter("hang");
  const running = controller(pmRoot, approval, "cancel", selected);
  let id = "";
  for (let attempt = 0; attempt < 600; attempt += 1) { const jobs = await listProcessJobs(client); if (jobs.length === 1) { id = jobs[0].id; break; } await setTimeout(25); }
  assert.ok(id); const directory = processStaging(pmRoot, id); await partial(directory);
  running.child.kill("SIGKILL"); await running.result;
  await assert.rejects(resumeRlLoop(client, coordinates, { id: "process-drill", approval }), /no completion receipt/);
  const job = (await readProcessJob(client, id))!; assert.equal(job.state, "failed"); assert.equal(job.settled, true);
  assert.ok(existsSync(join(directory, "partial.json"))); assert.equal(readFileSync(join(directory, "launches.ndjson"), "utf8").trim().split("\n").length, 1); removed(id, directory);
});

test("real Compose two-generation run changes checkpoints and collects with the promoted successor", { skip }, async (t) => {
  const { client, coordinates, approval, pmRoot } = await processWorkspace(budget); const selected = adapter();
  // Use a real controller subprocess, then independently reconstruct all results through the SDK.
  const running = controller(pmRoot, approval, "done", selected, 2); assert.equal(await running.result, 0);
  const report = await rlLoopStatus(client, "process-drill", pmRoot); assert.equal(report.promoted, 2);
  const jobs = report.process_jobs!; assert.equal(jobs.length, 2); assert.notEqual(jobs[0].completion!.digest, jobs[1].completion!.digest);
  assert.notEqual(jobs[0].completion!.policy.digest, trainingInput().source.digest);
  assert.equal((await client.get(report.generations[1].run!)).item.component, jobs[0].completion!.policy.digest);
  for (const job of jobs) {
    const directory = processStaging(pmRoot, job.id);
    assert.equal(job.state, "promoted"); assert.equal(job.settled, true); assert.ok(existsSync(join(directory, "completion.json")));
    assert.equal(JSON.parse(readFileSync(join(directory, "compose.json"), "utf8")).services.trainer.image, selected.kind === "compose-bandit" ? selected.image : "unexpected-local-adapter");
    assert.equal(readFileSync(join(directory, "launches.ndjson"), "utf8").trim().split("\n").length, 1); removed(job.id, directory);
  }
  assert.equal((await resumeRlLoop(client, coordinates, { id: "process-drill", approval })).resumed_generations, 2);
  t.diagnostic(JSON.stringify(jobs.map((job) => ({ checkpoint: job.completion!.digest, policy: job.completion!.policy.digest, usage: job.charge }))));
});

test("real Compose recovery before config publication fails safely without a container launch", { skip }, async () => {
  const { client, coordinates, approval, pmRoot } = await processWorkspace(budget); const selected = adapter(); const input = trainingInput(); const id = processJobId(input, undefined, selected);
  const job = await reserveProcessJob(client, coordinates, id, input, approval, allowance);
  await client.update(id, { body: JSON.stringify({ ...job, state: "running" }) });
  await assert.rejects(executeProcessTrainer(client, coordinates, input, approval, selected), /no completion receipt/);
  assert.equal((await readProcessJob(client, id))!.state, "failed"); assert.equal(existsSync(join(processStaging(pmRoot, id), "launches.ndjson")), false); removed(id, processStaging(pmRoot, id));
});

test("real Compose independent trackers with identical jobs cannot stop each other's containers", { skip }, async () => {
  const first = await processWorkspace(budget); const second = await processWorkspace(budget); const selected = adapter("hang"); const input = trainingInput(); const id = processJobId(input, undefined, selected);
  const directories = [first, second].map((workspace) => processStaging(workspace.pmRoot, id));
  const aborts = [new AbortController(), new AbortController()];
  const runs = [first, second].map((workspace, index) => assert.rejects(executeProcessTrainer(workspace.client, workspace.coordinates, input, workspace.approval, selected, aborts[index].signal), /cancelled/));
  await Promise.all(directories.map(partial));
  aborts[0].abort(); await runs[0]; removed(id, directories[0]);
  const alive = execFileSync("docker", ["container", "inspect", `${composeProject(id, directories[1])}-trainer`, "--format", "{{.State.Running}}"], { encoding: "utf8" }); assert.equal(alive.trim(), "true");
  aborts[1].abort(); await runs[1]; removed(id, directories[1]);
});

test("real Compose checkpoint without completion is refused and cannot collect a successor", { skip }, async () => {
  const { client, approval, pmRoot } = await processWorkspace(budget); const selected = adapter("checkpoint-only");
  const running = controller(pmRoot, approval, "done", selected, 2);
  assert.equal(await running.result, 1); assert.ok(JSON.stringify(running.messages).includes("process_receipt_required"));
  const [job] = await listProcessJobs(client); const directory = processStaging(pmRoot, job.id);
  assert.equal(job.state, "failed"); assert.equal(job.settled, true); assert.ok(existsSync(join(directory, "checkpoint.json")));
  assert.equal(existsSync(join(directory, "completion.json")), false);
  assert.equal((await client.listAllComplete({})).items.filter((item) => item.type === "Run").length, 1); removed(job.id, directory);
});
