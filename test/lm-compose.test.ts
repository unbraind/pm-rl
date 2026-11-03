/** Shared-contract LM unit, real-process and real-container recursive execution drills. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFileSync, fork, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { setTimeout } from "node:timers/promises";
import { after, test } from "node:test";
import { composeConfiguration, composeProject } from "../compose.ts";
import { runRlLoop, resumeRlLoop, rlLoopStatus, type JsonValue } from "../index.ts";
import { lmCollectBatch, lmConfigurationJson, parseLmLoopConfig, type LmLoopConfig } from "../lm.ts";
import { parseLoopProgramme, parseLoopConfig } from "../loop.ts";
import { lmProcessInput, processLmTraining, restoreLmProcessInput, validateLmProcessCheckpoint, verifyLmProcessJob } from "../process-lm.ts";
import { lmTrainerMain } from "../process-lm-trainer.ts";
import { executeProcessTrainer, launchTrainer, listProcessJobs, parseProcessAdapter, processJobId, processStaging, readProcessJob, validateProcessCompletion, verifiedProcessPolicy, type ProcessAdapter, type ProcessCompletion, type Resources } from "../process.ts";
import { configuration, processWorkspace } from "./fixtures/process-workspace.ts";

const allowance = { training_steps: 6, wall_ms: 60_000, storage_bytes: 2_097_152, compute_units: 60_000, tokens: 100_000 };
const budget: Resources = { training_steps: 20_000, wall_ms: 120_000, storage_bytes: 4_194_304, compute_units: 120_000, tokens: 2_000_000 };
const imagePlaceholder = `sha256:${"a".repeat(64)}`;
const example = JSON.parse(readFileSync(new URL("../examples/loop-lm.json", import.meta.url), "utf8")) as Record<string, JsonValue>;
/** Programme declares all limits before parsing or execution. */
function rawConfig(selected: ProcessAdapter = { kind: "compose-lm", image: imagePlaceholder, memory_bytes: 268_435_456, cpus: 1, allowance }): JsonValue {
  return { ...example, max_generations: 2, budget: 128, adapter: selected as unknown as JsonValue };
}
let cached: LmLoopConfig | undefined;
/** Reuse only the deterministic frozen base across independent scratch trackers. */
function config(): LmLoopConfig { cached ??= parseLmLoopConfig(rawConfig()); return cached; }
/** Build a real collected request with held-out examples excluded. */
function inputFor(selected?: ProcessAdapter) {
  const cfg = selected === undefined ? config() : parseLmLoopConfig({ ...lmConfigurationJson(config()) as Record<string, JsonValue>, adapter: selected as unknown as JsonValue });
  const step = { learningRate: cfg.learningRate, evaluationSamples: cfg.evaluationSamples };
  return lmProcessInput(cfg, step, 1, cfg.initial, lmCollectBatch(cfg, 1, cfg.initial), "process-drill");
}
/** Capture real stdin/stdout IO without substituting numerical results. */
async function staged() {
  const { root } = await processWorkspace(budget); const directory = join(root, "staged"); mkdirSync(directory);
  const input = inputFor(); const id = processJobId(input, undefined, config().process);
  let output = "";
  const sink = new Writable({ write(chunk, _encoding, callback) { output += String(chunk); callback(); } });
  await lmTrainerMain([process.execPath, new URL("../process-lm-trainer.ts", import.meta.url).pathname], new URL("../process-lm-trainer.ts", import.meta.url).href,
    Readable.from([JSON.stringify({ job: id.toUpperCase(), input })]), sink, directory);
  assert.equal((JSON.parse(readFileSync(join(directory, "completion.json"), "utf8")) as ProcessCompletion).job, id);
  writeFileSync(join(directory, "runner.json"), JSON.stringify({ started_at: Date.now() - 5000 }));
  return { directory, input, id, output, receipt: JSON.parse(readFileSync(join(directory, "completion.json"), "utf8")) as ProcessCompletion<{ digest: string }> };
}

test("LM Compose parser declares image, licences, fit, memory, CPU and resource bounds", () => {
  const cfg = config(); assert.equal(parseLoopProgramme(lmConfigurationJson(cfg)).trainer, "lm");
  assert.equal(parseLmLoopConfig(lmConfigurationJson(cfg)).digest, cfg.digest);
  assert.throws(() => lmProcessInput({ ...cfg, process: undefined }, { learningRate: 1, evaluationSamples: 1 }, 1, cfg.initial, [], "x"));
  const selected = cfg.process!;
  for (const extra of [{ memory_bytes: undefined }, { memory_bytes: 1 }, { memory_bytes: 2 ** 31 }, { cpus: undefined }, { cpus: 0 }, { cpus: 5 }, { cpus: Infinity }, { cpus: NaN }, { image: "mutable" }, { command: "untrusted" }]) assert.throws(() => parseProcessAdapter({ ...selected, ...extra }));
  for (const steps of [0, 10001]) assert.throws(() => parseProcessAdapter({ ...selected, allowance: { ...allowance, training_steps: steps } }));
  for (const extra of [{ kind: "compose-bandit", image: imagePlaceholder, allowance: { ...allowance, training_steps: 1 } }, { ...selected, allowance: { ...allowance, training_steps: 5 } }, { ...selected, allowance: { ...allowance, wall_ms: 60_001 } }]) assert.throws(() => parseLmLoopConfig(rawConfig(extra as ProcessAdapter)));
  assert.throws(() => parseLoopConfig({ ...configuration, adapter: selected as unknown as JsonValue }));
  const generated = composeConfiguration(imagePlaceholder, selected as Extract<ProcessAdapter, { kind: "compose-lm" }>) as { services: { trainer: Record<string, unknown> } };
  assert.equal(generated.services.trainer["mem_limit"], 268_435_456); assert.equal(generated.services.trainer["memswap_limit"], 268_435_456);
  assert.equal(generated.services.trainer["cpus"], 1); assert.equal(generated.services.trainer["network_mode"], "none");
  assert.notEqual(String(generated.services.trainer["user"]).split(":")[0], "0");
  const input = inputFor(); const text = JSON.stringify(input);
  for (const item of cfg.evaluation) assert.ok(!text.includes(`"string":"${item.string}"`));
  assert.equal(processJobId(input, ["ignored"], selected), processJobId(input, undefined, selected));
  assert.notEqual(processJobId(input, undefined, selected), processJobId(input, undefined, { ...selected, memory_bytes: 134_217_728 } as ProcessAdapter));
  assert.notEqual(processJobId(input, undefined, selected), processJobId(input, undefined, { ...selected, cpus: 0.5 } as ProcessAdapter));
});

test("LM real fit publishes canonical tensors and rejects corrupt bytes, memory and token evidence", async () => {
  const { directory, input, id, receipt, output } = await staged();
  assert.equal(JSON.parse(output.trim().split("\n")[1]).type, "complete");
  assert.notEqual(receipt.policy.digest, input.source.digest);
  assert.ok(processLmTraining(input, receipt).parameterDeltaL2 > 0);
  assert.equal(validateProcessCompletion(directory, id, input, allowance).policy.digest, receipt.policy.digest);
  for (const wallMs of [-1, receipt.usage.wall_ms + 1]) {
    const invalid = { ...receipt, training: { ...receipt.training as Record<string, JsonValue>, wall_ms: wallMs } };
    assert.throws(() => processLmTraining(input, invalid), /fit wall/);
  }
  const bytes = readFileSync(join(directory, "checkpoint.json"));
  for (const altered of [{ ...receipt, policy: { digest: input.source.digest } }, { ...receipt, peak_memory_bytes: 0 }, { ...receipt, peak_memory_bytes: 2 ** 30 }, { ...receipt, peak_memory_bytes: undefined }, { ...receipt, usage: { ...receipt.usage, tokens: 0 } }]) assert.throws(() => validateLmProcessCheckpoint(bytes, altered, input));
  assert.throws(() => validateLmProcessCheckpoint(Buffer.from("corrupt"), receipt, input));
  assert.throws(() => validateLmProcessCheckpoint(bytes, receipt, { ...input, lm: { ...input.lm!, config: { ...input.lm!.config, limits: { ...input.lm!.config.limits, maxCheckpointBytes: 1 } } } }));
  assert.throws(() => restoreLmProcessInput({ ...input, source: { digest: imagePlaceholder } }));
  writeFileSync(join(directory, "checkpoint.json"), "corrupt"); assert.throws(() => validateProcessCompletion(directory, id, input, allowance));
});

test("LM real child process uses the shared stream and refuses mismatched adapter limits before reserving", async () => {
  const { root, client, coordinates, approval } = await processWorkspace(budget); const input = inputFor(); const directory = join(root, "process"); mkdirSync(directory);
  const id = processJobId(input, undefined, config().process);
  await launchTrainer(directory, id, input, allowance, [process.execPath, new URL("../process-lm-trainer.ts", import.meta.url).pathname]);
  assert.notEqual(validateProcessCompletion(directory, id, input, allowance).policy.digest, input.source.digest);
  for (const selected of [{ kind: "process-bandit", allowance: { ...allowance, training_steps: 1 } }, { ...config().process!, memory_bytes: 134_217_728 }, { ...config().process!, allowance: { ...allowance, training_steps: 1 } }]) await assert.rejects(executeProcessTrainer(client, coordinates, input, approval, selected as ProcessAdapter));
  assert.equal((await listProcessJobs(client)).length, 0);
});

const version = spawnSync("docker", ["compose", "version"], { encoding: "utf8" });
const skip = version.status === 0 ? false : `SKIPPED: docker compose version failed: ${version.error?.message ?? version.stderr.trim()}`;
const images = new Map<string, string>();
const imageRun = randomUUID();
const imageOwner = process.env["PM_RL_VALIDATION_OWNER"] ?? `pm-rl-${imageRun}`;
after(() => { for (const [mode, image] of images) if (mode !== "production") execFileSync("docker", ["image", "rm", "--force", image], { stdio: "ignore" }); });
/** Build only named and labelled repository trainer images; retain the production image. */
function adapter(mode = "fit"): Extract<ProcessAdapter, { kind: "compose-lm" }> {
  let image = images.get(mode);
  if (image === undefined) {
    image = execFileSync("docker", ["build", "--quiet", "--tag", `pm-rl-lm-${mode}-${imageRun}`, "--label", `pm-rl-validation-run=pm-rl-${imageRun}`, "--label", `pm-rl-validation-owner=${imageOwner}`, "--file", mode === "production" ? "lm-trainer.Dockerfile" : "test/fixtures/lm-compose.Dockerfile", "--build-arg", `MODE=${mode}`, "."], { encoding: "utf8", timeout: 180_000 }).trim();
    assert.match(image, /^sha256:[a-f0-9]{64}$/u); images.set(mode, image);
  }
  return { kind: "compose-lm", image, memory_bytes: 268_435_456, cpus: 1, allowance };
}
/** Wait for durable evidence without depending on scheduler timing. */
async function until(predicate: () => boolean): Promise<void> {
  for (let count = 0; count < 1200; count += 1) { if (predicate()) return; await setTimeout(25); }
  assert.fail("LM container barrier was not reached");
}
/** Observe the daemon's actual kernel-OOM flag before allowing the idle fixture supervisor to exit. */
async function nativeOomRecorded(id: string, directory: string): Promise<void> {
  const deadline = performance.now() + 30_000;
  for (;;) {
    const remaining = deadline - performance.now();
    assert.ok(remaining > 0, "Docker did not record the native OOM within the existing barrier bound");
    const result = spawnSync("docker", ["container", "inspect", `${composeProject(id, directory)}-trainer`, "--format", "{{.State.OOMKilled}}"],
      { encoding: "utf8", timeout: Math.max(1, Math.floor(Math.min(1000, remaining))) });
    assert.equal(result.status, 0, "memory fixture supervisor must remain inspectable until native OOM acknowledgement");
    if (result.stdout.trim() === "true") return;
    await setTimeout(25);
  }
}
/** Spawn the real controller with the existing transaction-boundary barriers. */
function controller(pmRoot: string, approval: string, cfg: JsonValue, mode: string) {
  const child = fork(new URL("./fixtures/process-controller.ts", import.meta.url), [pmRoot, approval, JSON.stringify(cfg), mode], { silent: true, execArgv: [], env: { ...process.env, NODE_V8_COVERAGE: undefined } });
  const messages: unknown[] = []; let diagnostics = "";
  child.stderr!.on("data", (chunk: Buffer) => { diagnostics += String(chunk); });
  const result = new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.on("message", (message) => messages.push(message)); child.once("exit", (code) => { if (messages.length === 0 && code !== null && code !== 0) reject(new Error(diagnostics)); else resolve(code); }); });
  /** Observe a boundary already reached or a future IPC notification. */
  const ready = (name = "ready"): Promise<void> => messages.includes(name) ? Promise.resolve() : new Promise((resolve, reject) => { child.on("message", (message) => { if (message === name) resolve(); }); child.once("exit", () => reject(new Error(`Controller exited before barrier: ${diagnostics} ${JSON.stringify(messages)}`))); });
  return { child, messages, result, ready };
}
/** Assert only this job's exact container was removed. */
function removed(id: string, directory: string): void {
  const result = spawnSync("docker", ["container", "inspect", `${composeProject(id, directory)}-trainer`], { encoding: "utf8" });
  assert.notEqual(result.status, 0); assert.match(result.stderr, /No such (object|container)/u);
}

test("real Compose LM promotes two generations and collects with the promoted checkpoint", { skip }, async (t) => {
  const { client, coordinates, approval, pmRoot } = await processWorkspace(budget); const selected = adapter("production");
  const start = performance.now(); const report = await runRlLoop(client, coordinates, { id: "process-drill", approval, config: rawConfig(selected) });
  const executionMs = performance.now() - start;
  assert.equal(report.promoted, 2); assert.equal(report.process_jobs!.length, 2);
  const rows = [];
  for (const [index, job] of report.process_jobs!.entries()) {
    assert.equal(job.state, "promoted"); assert.equal(job.charge.training_steps, 6); assert.ok(job.charge.tokens > 0);
    const cfg = parseLmLoopConfig(rawConfig(selected));
    const run = await client.get(report.generations[index].run!); assert.equal(run.item.component, job.completion!.source_policy);
    assert.equal(job.completion!.digest, job.completion!.policy.digest); assert.notEqual(job.completion!.source_policy, job.completion!.digest);
    if (index === 1) assert.equal(job.completion!.source_policy, report.process_jobs![0].completion!.digest);
    const directory = processStaging(pmRoot, job.id); const stagedInput = JSON.parse(readFileSync(join(directory, "input.json"), "utf8")).input;
    for (const example of cfg.evaluation) assert.ok(!JSON.stringify(stagedInput).includes(`"string":"${example.string}"`));
    verifiedProcessPolicy(job, pmRoot, stagedInput);
    verifyLmProcessJob(job, pmRoot, stagedInput, { digest: job.completion!.digest, training: job.completion!.training });
    for (const missing of [null, { ...job, completion: null }]) assert.throws(() => verifyLmProcessJob(missing, pmRoot, stagedInput, { digest: job.completion!.digest }));
    assert.throws(() => verifyLmProcessJob(job, pmRoot, stagedInput, { digest: job.completion!.source_policy }));
    assert.throws(() => verifyLmProcessJob(job, pmRoot, stagedInput, { digest: job.completion!.digest, training: null }));
    const stop = JSON.parse(readFileSync(join(directory, "compose-stop.json"), "utf8"));
    assert.equal(stop.resources.memory_bytes, selected.memory_bytes); assert.equal(stop.resources.nano_cpus, 1_000_000_000);
    assert.equal(stop.resources.network, "none"); assert.equal(stop.resources.oom_killed, false); assert.notEqual(stop.resources.user.split(":")[0], "0");
    removed(job.id, directory);
    rows.push({ generation: index + 1, before: job.completion!.source_policy, after: job.completion!.digest, held_out: report.generations[index].held_out_mean,
      usage: job.charge, peak_memory_bytes: job.completion!.peak_memory_bytes });
  }
  assert.equal((await resumeRlLoop(client, coordinates, { id: "process-drill", approval })).resumed_generations, 2);
  assert.equal((await rlLoopStatus(client, "process-drill", pmRoot)).promoted, 2);
  t.diagnostic(JSON.stringify({ execution_ms: executionMs, verification_ms: performance.now() - start - executionMs, image: selected.image, rows }));
});

test("real Compose LM staged completion survives SIGKILL without retraining or double charge", { skip }, async () => {
  const { client, coordinates, approval, pmRoot } = await processWorkspace(budget); const selected = adapter();
  const running = controller(pmRoot, approval, { ...rawConfig(selected) as Record<string, JsonValue>, max_generations: 1 }, "materialized"); await running.ready();
  const [job] = await listProcessJobs(client); assert.equal(job.state, "running"); const directory = processStaging(pmRoot, job.id);
  const bytes = readFileSync(join(directory, "checkpoint.json")); const completion = readFileSync(join(directory, "completion.json"));
  running.child.kill("SIGKILL"); await running.result;
  assert.equal((await resumeRlLoop(client, coordinates, { id: "process-drill", approval })).promoted, 1);
  assert.deepEqual(readFileSync(join(directory, "checkpoint.json")), bytes); assert.deepEqual(readFileSync(join(directory, "completion.json")), completion);
  assert.equal(readFileSync(join(directory, "launches.ndjson"), "utf8").trim().split("\n").length, 1);
  const jobs = await listProcessJobs(client); assert.equal(jobs.length, 1); assert.equal(jobs[0].charge.training_steps, 6); assert.equal(jobs[0].settled, true); removed(job.id, directory);
});

test("real Compose LM mid-fit cancellation retains evidence and process_cancelled", { skip }, async () => {
  const { client, coordinates, approval, pmRoot } = await processWorkspace(budget);
  const selected = { ...adapter(), allowance: { ...allowance, training_steps: 1000, tokens: 1_000_000 } };
  const raw = { ...rawConfig(selected) as Record<string, JsonValue>, max_generations: 1, fit_steps: 1000, limits: { ...example["limits"] as Record<string, JsonValue>, max_steps: 2000 } };
  const cfg = parseLmLoopConfig(raw); const input = lmProcessInput(cfg, { learningRate: 1, evaluationSamples: 1600 }, 1, cfg.initial, lmCollectBatch(cfg, 1, cfg.initial), "process-drill");
  const id = processJobId(input, undefined, selected); const directory = processStaging(pmRoot, id); const abort = new AbortController();
  const running = assert.rejects(executeProcessTrainer(client, coordinates, input, approval, selected, abort.signal), /cancelled/);
  await until(() => existsSync(join(directory, "events.ndjson"))); abort.abort(); await running;
  const job = (await readProcessJob(client, id))!; assert.equal(job.state, "cancelled"); assert.equal(job.outcome, "process_cancelled"); assert.equal(job.settled, true);
  assert.ok(existsSync(join(directory, "input.json"))); assert.ok(existsSync(join(directory, "events.ndjson"))); assert.equal(job.completion, null); removed(id, directory);
});

test("real Compose LM corrupt checkpoints and exceeded memory/time refuse promotion", { skip }, async () => {
  for (const mode of ["corrupt", "memory", "time"]) {
    const { client, coordinates, approval, pmRoot } = await processWorkspace(budget);
    const selected = mode === "time" ? { ...adapter("time"), allowance: { ...allowance, training_steps: 1000, wall_ms: 15_000, tokens: 1_000_000 } } : mode === "memory" ? { ...adapter(mode), memory_bytes: 201_326_592 } : adapter(mode);
    const cfg = mode === "time" ? { ...rawConfig(selected) as Record<string, JsonValue>, fit_steps: 1000, limits: { ...example["limits"] as Record<string, JsonValue>, max_steps: 2060 } } : rawConfig(selected);
    const refused = assert.rejects(runRlLoop(client, coordinates, { id: "process-drill", approval, config: cfg }), Error, `${mode}: the injected resource fault must refuse`);
    try {
      if (mode === "memory") {
        const id = processJobId(inputFor(selected), undefined, selected); const directory = processStaging(pmRoot, id);
        await until(() => existsSync(join(directory, "memory-child.json")));
        const child = JSON.parse(readFileSync(join(directory, "memory-child.json"), "utf8")) as { exit_code: number | null; signal: string | null };
        assert.deepEqual(child, { exit_code: null, signal: "SIGKILL" }, "the kernel must kill the memory-exhausting child");
        await nativeOomRecorded(id, directory);
      }
    } finally {
      if (mode === "memory") {
        for (const job of await listProcessJobs(client)) writeFileSync(join(processStaging(pmRoot, job.id), "memory-release.json"), "{}");
      }
      await refused;
    }
    const [job] = await listProcessJobs(client); assert.equal(job.state, "failed"); assert.equal(job.settled, true); assert.equal(job.completion, null);
    assert.equal((await client.listAllComplete({})).items.filter((item) => item.type === "Run").length, 1, `${mode}: a failed fit cannot collect a successor`);
    assert.equal((await client.listAllComplete({})).items.filter((item) => item.type === "Generation" && item.status === "closed").length, 0);
    assert.equal(job.outcome, mode === "corrupt" ? "process_checkpoint_invalid" : mode === "time" ? "process_limit_exceeded" : "trainer_failure");
    const directory = processStaging(pmRoot, job.id); assert.ok(existsSync(join(directory, "input.json")));
    if (mode === "memory") {
      assert.ok(existsSync(join(directory, "partial.json")));
      const partial = JSON.parse(readFileSync(join(directory, "partial.json"), "utf8")) as { heap_limit_bytes: number; oom_score_adjustment: number };
      assert.ok(partial.heap_limit_bytes > selected.memory_bytes, "the physical cgroup guard must precede the V8 heap ceiling");
      assert.equal(partial.oom_score_adjustment, 1000);
      const stopped = JSON.parse(readFileSync(join(directory, "compose-stop.json"), "utf8")) as { resources: { oom_killed: boolean } };
      assert.equal(stopped.resources.oom_killed, true, JSON.stringify(stopped.resources));
    }
    if (mode === "time") {
      assert.ok(existsSync(join(directory, "events.ndjson")));
      const barrier = JSON.parse(readFileSync(join(directory, "time-barrier.json"), "utf8")) as { initial_progress_written: boolean };
      assert.equal(barrier.initial_progress_written, true);
    }
    removed(job.id, directory);
    await assert.rejects(resumeRlLoop(client, coordinates, { id: "process-drill", approval }));
  }
});

test("two real Compose LM controllers launch once and reserve once", { skip }, async () => {
  const { client, coordinates, approval, pmRoot } = await processWorkspace(budget); const selected = adapter();
  const raw = { ...rawConfig(selected) as Record<string, JsonValue>, max_generations: 1 };
  const contenders = [controller(pmRoot, approval, raw, "race"), controller(pmRoot, approval, raw, "race")];
  await Promise.all(contenders.map((entry) => entry.ready("starting"))); for (const entry of contenders) entry.child.send("start");
  const winner = await Promise.any(contenders.map(async (entry) => { await entry.ready(); return entry; }));
  const loser = contenders.find((entry) => entry !== winner)!; assert.equal(await loser.result, 1); assert.ok(JSON.stringify(loser.messages).includes("loop_controller_active"));
  winner.child.send("continue"); assert.equal(await winner.result, 0);
  const jobs = await listProcessJobs(client); assert.equal(jobs.length, 1); assert.equal(jobs[0].charge.training_steps, 6);
  const directory = processStaging(pmRoot, jobs[0].id); assert.equal(readFileSync(join(directory, "launches.ndjson"), "utf8").trim().split("\n").length, 1);
  assert.equal((await resumeRlLoop(client, coordinates, { id: "process-drill", approval })).resumed_generations, 1); removed(jobs[0].id, directory);
});
