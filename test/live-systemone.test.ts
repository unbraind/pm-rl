/** The live script uses the same persisted controller against a real deterministic HTTP endpoint in CI. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { readFileSync, readdirSync, mkdirSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve, join } from "node:path";
import { test } from "node:test";
import { PmClient } from "@unbrained/pm-cli/sdk/core";
import { runRlLoop, resumeRlLoop, type JsonValue } from "../index.ts";
import { runLiveCommand, LIVE_WORKER_DEADLINE_MS } from "../scripts/live-watchdog.ts";
import { parseSystemOneLoopConfig } from "../systemone.ts";
import { configValue } from "./fixtures/systemone.ts";
import { isPmCliExpectedError } from "@unbrained/pm-cli/sdk/runtime";
import { liveConfiguration, runLiveAcceptance, main, LIVE_TIMEOUT_MS, cpuModelEvidence, verifyCpuRunner, type LiveAcceptanceEvidence } from "../scripts/live-systemone.ts";

test("live acceptance measures two promoted heads, successor collection, tokens and latency", async () => {
  let requests = 0;
  let gpuBytes = 0;
  let parameters = "num_gpu 0\nnum_thread 2\n";
  let metadataStatus = 200;
  let metadataBody: unknown;
  let decisionStatus = 200;
  let decisionDelay = 0;
  const model = { name: "tev1:4b", digest: "a".repeat(64), size: 4482415847 };
  const server = createServer((request, reply) => {
    let body = ""; request.on("data", (chunk: Buffer) => { body += chunk.toString(); });
    request.on("end", () => {
      reply.setHeader("content-type", "application/json");
      if (request.url !== "/v1/systemone") {
        reply.statusCode = metadataStatus;
        const result = metadataBody === undefined ? (request.url === "/api/show" ? { parameters } : { models: [{ ...model, size_vram: gpuBytes }] }) : metadataBody;
        reply.end(JSON.stringify(result)); return;
      }
      requests += 1;
      const { state } = JSON.parse(body) as { state: string };
      const isBug = /[Ff]ix|[Rr]epair/.test(state);
      reply.setHeader("content-type", "application/json");
      reply.statusCode = decisionStatus;
      setTimeout(() => reply.end(JSON.stringify({ answers: { kind: { type: "choice", probabilities: { Bug: isBug ? 0.97 : 0.03, Feature: isBug ? 0.03 : 0.97 } } }, usage: { input_tokens: 10, output_tokens: 1 } })), decisionDelay);
    });
  });
  await new Promise<void>((resolve) => { server.listen(0, "127.0.0.1", resolve); });
  const address = server.address(); assert.ok(address !== null && typeof address !== "string");
  const baseURL = `http://127.0.0.1:${address.port}`;
  try {
    assert.ok(liveConfiguration());
    let printed = "";
    await main({ SYSTEMONE_BASE_URL: baseURL, SYSTEMONE_MODEL: "tev1:4b" }, (text) => { printed = text; });
    const report = JSON.parse(printed) as LiveAcceptanceEvidence;
    assert.equal(report.tokens, 88); assert.equal(report.queries, 8); assert.equal(requests, 8);
    assert.ok(Number(report.endpoint_ms) > 0);
    assert.equal(report.model.num_gpu, 0);
    assert.equal(report.model.num_thread, 2);
    assert.equal(report.generations.length, 2);
    assert.equal(report.generations[1].collecting_policy, report.generations[0].checkpoint);
    assert.ok(report.generations.every((generation) => generation.promoted && generation.refusal_reason === null));
    assert.ok(report.generations.every((generation) => generation.decisions.length === 4 && generation.ece_after < generation.ece_before));
    const root = resolve(import.meta.dirname, "..", report.artifacts);
    assert.deepEqual(JSON.parse(readFileSync(join(root, "summary.json"), "utf8")), report);
    for (const generation of report.generations) {
      const bytes = readFileSync(join(root, generation.checkpoint_file));
      assert.equal(`sha256:${createHash("sha256").update(bytes).digest("hex")}`, generation.checkpoint);
    }
    assert.ok(readdirSync(join(root, ".agents/pm/history")).includes(`${report.generations[1].item}.jsonl`));
    assert.ok(root.startsWith(resolve(import.meta.dirname, "../.agents/pm/runtime/live")));
    const pmRoot = join(root, ".agents/pm");
    const client = new PmClient({ pmRoot, cwd: root, author: "codex-agent", noExtensions: true });
    const approval = await client.create({ id: "adversarial-approval", type: "Decision", title: "Bounded adversarial test allowance", body: '```json\n{"permitted_promotions":2}\n```' });
    for (const fault of ["nonfinite", "shape", "digest"]) {
      const id = `invalid-${fault}`;
      await assert.rejects(runRlLoop(client, { pmRoot, author: "codex-agent" }, { id,
        config: { ...(liveConfiguration(baseURL) as Record<string, JsonValue>), max_generations: 1, fit_steps: 20, learning_rate: 1, evaluation_samples: 100 }, approval: String(approval.item.id),
        onPhase(phase) { if (phase === "train") throw new Error("pause before promotion"); } }), /pause before promotion/);
      const item = await client.get(`${id}-g1`);
      const match = /```json\n([\s\S]+?)\n```/.exec(String(item.item.body)); assert.ok(match !== null);
      const spec = JSON.parse(match[1]) as Record<string, JsonValue>;
      assert.equal(spec.promoted, false);
      const stored = spec.training_config as Record<string, JsonValue>;
      assert.ok(Number(stored.candidate_held_out_mean) - Number(stored.incumbent_held_out_mean) > 2 * Math.sqrt(Math.log(40) / 200) + 0.001,
        "adversarial candidates must clear the held-out gate before checkpoint corruption");
      if (fault === "digest") stored.candidate_checkpoint = "sha256:" + "0".repeat(64);
      else stored.candidate_parameters = { log_temperature: { kind: fault === "nonfinite" ? null : 2 }, biases: { kind: fault === "shape" ? { Bug: 0 } : { Bug: 0, Feature: 0 } } };
      let body = '```json\n' + JSON.stringify(spec, null, 2) + '\n```';
      if (fault === "nonfinite") body = body.replace('"kind": null', '"kind": 1e309');
      await client.update(`${id}-g1`, { body });
      await assert.rejects(resumeRlLoop(client, { pmRoot, author: "codex-agent" }, { id, approval: String(approval.item.id) }),
        (error: unknown) => isPmCliExpectedError(error) && error.context.code?.startsWith("systemone_invalid_checkpoint") === true);
      assert.equal((await client.get(`${id}-g1`)).item.body, body, "invalid candidate must remain unpromoted");
    }
    const child = spawn(process.execPath, ["scripts/live-watchdog.ts"], { env: { ...process.env, SYSTEMONE_BASE_URL: baseURL, SYSTEMONE_MODEL: "tev1:4b" } });
    let output = ""; let errors = ""; child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { errors += chunk.toString(); });
    const code = await new Promise<number | null>((resolve, reject) => { child.on("error", reject); child.on("exit", resolve); });
    assert.equal(code, 0, errors.slice(-2000)); assert.equal((JSON.parse(output) as { queries: number }).queries, 8);
    const bad = liveConfiguration(baseURL, "tev1:4b") as Record<string, unknown>;
    await assert.rejects(runLiveAcceptance({ ...bad, minimum_improvement: 1 } as Parameters<typeof runLiveAcceptance>[0]), /two promotions/);
    const refusalDirs = readdirSync(resolve(import.meta.dirname, "../.agents/pm/runtime/live"));
    assert.ok(refusalDirs.some((dir) => {
      try { return JSON.parse(readFileSync(resolve(import.meta.dirname, "../.agents/pm/runtime/live", dir, "loop-report.json"), "utf8")).promoted === 0; } catch { return false; }
    }));
    // The loaded-runner check must stop collection before a candidate exists.
    gpuBytes = 1;
    await assert.rejects(runLiveAcceptance(liveConfiguration(baseURL)), /zero GPU bytes/);
    gpuBytes = 0;
    for (const invalidParameters of ["num_gpu 1\nnum_thread 2", "num_gpu 0", "num_gpu 0\nnum_thread 5", "num_gpu 0\nnum_thread 0"]) {
      parameters = invalidParameters;
      await assert.rejects(runLiveAcceptance(liveConfiguration(baseURL)), /CPU-only/);
    }
    parameters = "num_gpu 0\nnum_thread 2";
    metadataStatus = 503;
    await assert.rejects(runLiveAcceptance(liveConfiguration(baseURL)), /metadata refused/);
    metadataStatus = 200;
    for (const invalid of [null, 0, [], {}, { models: [] }, { models: [{ ...model, name: "other" }] }, { models: [null, 1, {}] }, { models: [{ ...model, remote_model: "remote" }] }, { models: [{ ...model, remote_host: "remote" }] },
      { models: [{ ...model, digest: "bad" }] }, { models: [{ ...model, digest: 0 }] }, { models: [{ ...model, size: -1 }] }, { models: [{ ...model, size: 1.5 }] }]) {
      metadataBody = invalid;
      await assert.rejects(runLiveAcceptance(liveConfiguration(baseURL)));
    }
    metadataBody = undefined;
    await assert.rejects(runLiveAcceptance(liveConfiguration("http://example.invalid")), /local Ollama/);
    decisionStatus = 503;
    await assert.rejects(runLiveAcceptance(liveConfiguration(baseURL)), (error: unknown) => isPmCliExpectedError(error) && error.context.code === "systemone_endpoint_status");
    decisionStatus = 200;
    decisionDelay = 2000;
    await assert.rejects(runLiveAcceptance(liveConfiguration(baseURL), 1000));
    decisionDelay = 0;
    for (const deadline of [0, 1.5, LIVE_TIMEOUT_MS + 1]) await assert.rejects(runLiveAcceptance(liveConfiguration(baseURL), deadline), /15 minutes/);
    const clean = configValue(baseURL);
    await assert.rejects(runLiveAcceptance({ ...clean, evaluation: clean.training }), (error: unknown) => isPmCliExpectedError(error) && error.context.code === "systemone_dataset_overlap");
    await assert.rejects(runLiveAcceptance({ ...clean, initial_head: { log_temperature: { kind: NaN }, biases: { kind: { Bug: 0, Feature: 0 } } } }), isPmCliExpectedError);
  } finally { server.closeAllConnections(); await new Promise<void>((resolve) => { server.close(() => resolve()); }); }
});

test("CPU validation refuses configured GPU use and drifted runner identities before training", async () => {
  const model = { name: "tev1:4b", digest: "a".repeat(64), size: 4482415847 };
  let parameters: unknown = "num_gpu 1\nnum_thread 2";
  let runners: unknown = [{ ...model, size_vram: 0 }];
  let queries = 0;
  const server = createServer((request, reply) => {
    request.resume(); reply.setHeader("content-type", "application/json");
    if (request.url === "/v1/systemone") queries++;
    const body = request.url === "/api/tags" ? { models: [model] } : request.url === "/api/show" ? { parameters } : { models: runners };
    reply.end(JSON.stringify(body));
  });
  await new Promise<void>((done) => { server.listen(0, "127.0.0.1", done); });
  const address = server.address(); assert.ok(address !== null && typeof address !== "string");
  const config = parseSystemOneLoopConfig(liveConfiguration(`http://127.0.0.1:${address.port}`));
  try {
    await assert.rejects(cpuModelEvidence(config, AbortSignal.timeout(10000)), /CPU-only/);
    assert.equal(queries, 0);
    for (const invalid of [undefined, null, 0]) {
      parameters = invalid;
      await assert.rejects(cpuModelEvidence(config, AbortSignal.timeout(10000)), /CPU-only/);
    }
    parameters = "num_gpu 0\nnum_thread 4";
    const evidence = await cpuModelEvidence(config, AbortSignal.timeout(10000));
    await verifyCpuRunner(config, evidence, AbortSignal.timeout(10000));
    for (const invalid of [undefined, [], [null, 1, {}], [{ ...model, name: "other", size_vram: 0 }], [{ ...model, digest: "b".repeat(64), size_vram: 0 }], [{ ...model, size_vram: 1 }]]) {
      runners = invalid;
      await assert.rejects(verifyCpuRunner(config, evidence, AbortSignal.timeout(10000)), /runner|GPU bytes/);
    }
  } finally { server.closeAllConnections(); await new Promise<void>((done) => { server.close(() => done()); }); }
  await assert.rejects(cpuModelEvidence(config, AbortSignal.timeout(10000)), /fetch failed/);
});


test("live watchdog bounds startup and refuses excessive deadlines", async () => {
  for (const timeout of [0, LIVE_TIMEOUT_MS + 1]) await assert.rejects(runLiveCommand({}, () => undefined, timeout), /15 minutes/);
  await assert.rejects(runLiveCommand({ ...process.env, SYSTEMONE_BASE_URL: "http://127.0.0.1:1" }, () => undefined, 100), /timed out/);
});

test("live acceptance preserves the original refusal when failure evidence cannot be written", async () => {
  const parent = resolve(import.meta.dirname, "../.agents/pm/runtime/live");
  mkdirSync(parent, { recursive: true });
  const before = new Set(readdirSync(parent));
  let failurePath: string | undefined;
  const server = createServer((request, reply) => {
    request.resume();
    const added = readdirSync(parent).filter((dir) => !before.has(dir));
    assert.equal(added.length, 1);
    failurePath = join(parent, added[0], "failure.json");
    mkdirSync(failurePath);
    reply.statusCode = 503;
    reply.end();
  });
  await new Promise<void>((done) => { server.listen(0, "127.0.0.1", done); });
  const address = server.address(); assert.ok(address !== null && typeof address !== "string");
  try {
    await assert.rejects(runLiveAcceptance(liveConfiguration(`http://127.0.0.1:${address.port}`)), {
      code: "ERR_ASSERTION", message: "Ollama metadata refused HTTP 503",
    });
    assert.ok(failurePath !== undefined && statSync(failurePath).isDirectory());
  } finally { server.closeAllConnections(); await new Promise<void>((done) => { server.close(() => done()); }); }
});


test("live acceptance retains failure artifacts for preflight refusals and Git setup failure", async (t) => {
  const parent = resolve(import.meta.dirname, "../.agents/pm/runtime/live");
  mkdirSync(parent, { recursive: true });
  const model = { name: "tev1:4b", digest: "a".repeat(64), size: 1 };
  let models: unknown[] = [model];
  let parameters = "num_gpu 1\nnum_thread 2";
  let queries = 0;
  const server = createServer((request, reply) => {
    request.resume();
    if (request.url === "/v1/systemone") queries++;
    reply.setHeader("content-type", "application/json");
    reply.end(JSON.stringify(request.url === "/api/tags" ? { models } : { parameters }));
  });
  await new Promise<void>((done) => { server.listen(0, "127.0.0.1", done); });
  const address = server.address(); assert.ok(address !== null && typeof address !== "string");
  const baseURL = `http://127.0.0.1:${address.port}`;
  /** Verify that this refusal alone creates one retained failure receipt. */
  async function retainedFailure(endpoint: string, message: RegExp): Promise<void> {
    const before = new Set(readdirSync(parent));
    await assert.rejects(runLiveAcceptance(liveConfiguration(endpoint)), message);
    const added = readdirSync(parent).filter((dir) => !before.has(dir));
    assert.equal(added.length, 1);
    const failure = JSON.parse(readFileSync(join(parent, added[0], "failure.json"), "utf8")) as { failed: boolean; deadline_aborted: boolean };
    assert.deepEqual(failure, { failed: true, deadline_aborted: false });
    assert.equal(queries, 0);
  }
  try {
    await t.test("GPU configuration", () => retainedFailure(baseURL, /CPU-only/));
    models = [];
    await t.test("unavailable model", () => retainedFailure(baseURL, /unavailable/));
    await t.test("remote endpoint", () => retainedFailure("http://example.invalid", /local Ollama/));
    models = [model];
    parameters = "num_gpu 0\nnum_thread 2";
    const previous = process.env.GIT_CONFIG_COUNT;
    process.env.GIT_CONFIG_COUNT = "invalid";
    try { await t.test("Git initialization", () => retainedFailure(baseURL, /initialize artifact-local/)); }
    finally {
      if (previous === undefined) delete process.env.GIT_CONFIG_COUNT;
      else process.env.GIT_CONFIG_COUNT = previous;
    }
  } finally { server.closeAllConnections(); await new Promise<void>((done) => { server.close(() => done()); }); }
});

test("the live worker deadline expires before the watchdog kills the worker", () => {
  // The watchdog kills at LIVE_TIMEOUT_MS minus its grace (at most 5 s); the worker must stop itself first to write failure.json.
  const watchdogKillMs = LIVE_TIMEOUT_MS - Math.min(5000, Math.floor(LIVE_TIMEOUT_MS / 2));
  assert.ok(LIVE_WORKER_DEADLINE_MS < watchdogKillMs, `worker deadline ${LIVE_WORKER_DEADLINE_MS} ms must precede the ${watchdogKillMs} ms kill`);
  assert.ok(watchdogKillMs - LIVE_WORKER_DEADLINE_MS >= 10_000, "leave at least 10 s to write and flush failure evidence");
});
