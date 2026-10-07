/** Real HTTP receipt recovery against built code and real scratch PM projects. */
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { PmClient } from "@unbrained/pm-cli/sdk/core";
import { init, isPmCliExpectedError } from "@unbrained/pm-cli/sdk/runtime";
import { runRlLoop, resumeRlLoop } from "../dist/index.js";
import { runRlLoop as runSource, resumeRlLoop as resumeSource, rlLoopStatus, type JsonValue } from "../index.ts";
import { readSeries, encodeEventSegments } from "../series.ts";
import { configValue } from "./fixtures/systemone.ts";

/** Initialize an isolated real SDK tracker with explicit paths, including under pm test. */
async function workspace() {
  const root = mkdtempSync(join(tmpdir(), "rl-receipts-"));
  const pmRoot = join(root, ".agents", "pm");
  await init("rl", { defaults: true, agentGuidance: "skip", author: "receipt-test" }, { cwd: root, pmRoot });
  const client = new PmClient({ cwd: root, pmRoot, author: "receipt-test" });
  await client.create({ id: "approval", type: "Decision", title: "Bounded approval", body: '```json\n{"permitted_promotions":2}\n```' });
  return { root, pmRoot, client };
}

/** A durable idempotency service fixture: HTTP retries return its original immutable receipt. */
async function receiptServer(dropFirst = false, barrierAt = 0, dropBody = false) {
  let remoteReady!: () => void;
  const remote = new Promise<void>((resolve) => { remoteReady = resolve; });
  const receipts = new Map<string, string>();
  let physical = 0; let attempts = 0;
  const server = createServer((request, reply) => {
    let body = "";
    request.on("data", (chunk: Buffer) => { body += chunk.toString(); });
    request.on("end", () => {
      attempts += 1;
      const key = String(request.headers["idempotency-key"] ?? `legacy-${attempts}`);
      const payload = JSON.parse(body) as { request_id?: string; receipt_protocol?: string; state: string };
      if (request.headers["idempotency-key"] !== undefined) {
        assert.equal(payload.request_id, key); assert.equal(payload.receipt_protocol, "idempotency-v1");
      }
      let receipt = receipts.get(key);
      if (receipt === undefined) {
        physical += 1;
        const bug = /[Ff]ix|[Rr]epair/.test((JSON.parse(body) as { state: string }).state);
        receipt = JSON.stringify({ request_id: key, decision_id: `decision-${physical}`, physical_requests: 1,
          answers: { kind: { probabilities: { Bug: bug ? 0.6 : 0.4, Feature: bug ? 0.4 : 0.6 } } },
          usage: { input_tokens: 10, output_tokens: 1, latency_ms: 12 } });
        receipts.set(key, receipt);
      }
      if (attempts === barrierAt) { remoteReady(); return; }
      if (dropFirst && attempts === 1) { reply.destroy(); return; }
      if (dropBody && attempts === 1) { reply.writeHead(200, { "content-type": "application/json", "content-length": Buffer.byteLength(receipt) }); reply.write(receipt.slice(0, 20)); setImmediate(() => reply.destroy()); return; }
      reply.end(receipt);
    });
  });
  await new Promise<void>((resolve) => { server.listen(0, "127.0.0.1", resolve); });
  const address = server.address(); assert.ok(address !== null && typeof address !== "string");
  return { server, remote, baseURL: `http://127.0.0.1:${address.port}`, physical: () => physical, attempts: () => attempts };
}

test("built receipt recovery reconciles a lost HTTP response without a second inference", async () => {
  const endpoint = await receiptServer(true); const { root, pmRoot, client } = await workspace();
  const config = configValue(endpoint.baseURL);
  config.decision_model = { base_url: endpoint.baseURL, model: "tev1:4b", timeout_ms: 10000, receipt_protocol: "idempotency-v1" };
  try {
    await assert.rejects(runRlLoop(client, { pmRoot, author: "receipt-test" }, { id: "recovery", config, approval: "approval" }));
    const report = await resumeRlLoop(client, { pmRoot, author: "receipt-test" }, { id: "recovery", approval: "approval" });
    assert.equal(report.samples_consumed, 8); assert.equal(report.promoted, 2);
    assert.equal(endpoint.physical(), 8, "retry must retrieve the original decision rather than infer again");
    assert.equal(endpoint.attempts(), 9);
    for (const generation of report.generations) {
      const notes = await client.notes(generation.run!, { outputBudget: "unbounded", outputLimit: "unbounded" });
      assert.ok(!("output_budget_exceeded" in notes));
      const events = readSeries(notes.notes.map((note) => note.text)).events;
      assert.equal(events.length, 4);
      assert.equal(events.reduce((sum, event) => sum + Number(event.tags!.tokens), 0), 44);
    }
    await resumeRlLoop(client, { pmRoot, author: "receipt-test" }, { id: "recovery", approval: "approval" });
    assert.equal(endpoint.attempts(), 9);
  } finally { endpoint.server.closeAllConnections(); endpoint.server.close(); rmSync(root, { recursive: true, force: true }); }
});

/** Fork the built controller and fail promptly if it exits before the requested crash barrier. */
function launch(pmRoot: string, config: Record<string, JsonValue>, stage: string, metric: string, step: number) {
  const child = fork(new URL("./fixtures/decision-controller.ts", import.meta.url), [pmRoot, JSON.stringify(config), stage, metric, String(step)], { stdio: ["ignore", "pipe", "pipe", "ipc"] });
  let output = ""; child.stderr!.on("data", (data: Buffer) => { output += data.toString(); });
  const result = new Promise<void>((resolve) => { child.once("exit", () => resolve()); });
  const ready = stage === "remote" ? Promise.resolve() : new Promise<void>((resolve, reject) => {
    child.on("message", (value: unknown) => { if (value === "ready") resolve(); else reject(new Error(JSON.stringify(value))); });
    child.once("exit", () => reject(new Error(`controller ended before barrier: ${output}`)));
  });
  return { child, ready, result };
}

test("SIGKILL at every HTTP-to-PM receipt boundary replays one decision per query", { timeout: 300000 }, async () => {
  for (const metric of ["systemone_decision", "systemone_held_out_decision"]) {
    for (const stage of ["remote", "response", "commit", "request"]) {
      const endpoint = await receiptServer(false, stage === "remote" ? (metric === "systemone_decision" ? 1 : 3) : 0);
      const { root, pmRoot, client } = await workspace();
      const config = configValue(endpoint.baseURL);
      config.decision_model = { base_url: endpoint.baseURL, model: "tev1:4b", timeout_ms: 10000, receipt_protocol: "idempotency-v1" };
      const process = launch(pmRoot, config, stage, metric, 0);
      try {
        await Promise.race([stage === "remote" ? endpoint.remote : process.ready,
          process.result.then(() => { throw new Error("controller exited before crash injection"); })]);
        process.child.kill("SIGKILL"); await process.result;
        const before = await rlLoopStatus(client, "recovery");
        assert.equal(before.samples_consumed, (metric === "systemone_decision" ? 0 : 2) + (stage === "commit" ? 1 : 0));
        const report = await resumeSource(client, { pmRoot, author: "receipt-test" }, { id: "recovery", approval: "approval" });
        assert.equal(report.promoted, 2); assert.equal(report.samples_consumed, 8);
        assert.equal(endpoint.physical(), 8, `${metric}/${stage}`);
        const ids = new Set<string>(); let tokens = 0; let physical = 0;
        for (const generation of report.generations) {
          const notes = await client.notes(generation.run!, { outputBudget: "unbounded", outputLimit: "unbounded" });
          assert.ok(!("output_budget_exceeded" in notes));
          const events = readSeries(notes.notes.map((note) => note.text)).events;
          assert.equal(events.length, 4);
          for (const event of events) {
            assert.ok(!ids.has(event.tags!.decision_id)); ids.add(event.tags!.decision_id);
            physical += Number(event.tags!.physical_requests); tokens += Number(event.tags!.tokens);
            assert.equal(Number(event.tags!.input_tokens) + Number(event.tags!.output_tokens), Number(event.tags!.tokens));
            assert.equal(event.tags!.latency_ms, "12");
          }
        }
        assert.equal(physical, 8); assert.equal(tokens, 88);
        const attempts = endpoint.attempts();
        await resumeSource(client, { pmRoot, author: "receipt-test" }, { id: "recovery", approval: "approval" });
        assert.equal(endpoint.attempts(), attempts);
      } finally { process.child.kill("SIGKILL"); await process.result; endpoint.server.closeAllConnections(); endpoint.server.close(); rmSync(root, { recursive: true, force: true }); }
    }
  }
});

test("receipt resume rejects rewritten namespaces, identities and token accounting before HTTP", async () => {
  for (const fault of ["missing", "malformed", "duplicate-namespace", "request_id", "decision_id", "physical_requests", "input_tokens", "output_tokens", "duplicate-decision"]) {
    const endpoint = await receiptServer(); const { root, pmRoot, client } = await workspace();
    const config = configValue(endpoint.baseURL);
    config.decision_model = { base_url: endpoint.baseURL, model: "tev1:4b", timeout_ms: 10000, receipt_protocol: "idempotency-v1" };
    try {
      await assert.rejects(runSource(client, { pmRoot, author: "receipt-test" }, { id: "recovery", config, approval: "approval",
        onPhase() { throw new Error("pause"); } }), /pause/);
      const run = await client.get("recovery-g1-collect"); const runId = String(run.item.id);
      if (fault === "missing") await client.comments(runId, { delete: 1 });
      else if (fault === "malformed") await client.comments(runId, { edit: 1, add: "SystemOne receipt namespace: bad" });
      else if (fault === "duplicate-namespace") await client.comments(runId, { add: "SystemOne receipt namespace: " + "0".repeat(36) });
      else {
        const notes = await client.notes(runId, { outputBudget: "unbounded", outputLimit: "unbounded" }); assert.ok(!("output_budget_exceeded" in notes));
        const events = [...readSeries([notes.notes[0].text]).events];
        const tags = { ...events[0].tags };
        if (fault === "duplicate-decision") tags.decision_id = "decision-2";
        else tags[fault] = fault === "input_tokens" ? "12" : "";
        await client.notes(runId, { edit: 1, add: encodeEventSegments([{ ...events[0], tags }])[0] });
      }
      const attempts = endpoint.attempts();
      for (const action of [() => rlLoopStatus(client, "recovery"), () => resumeSource(client, { pmRoot, author: "receipt-test" }, { id: "recovery", approval: "approval" })]) {
        await assert.rejects(action(), (error: unknown) => isPmCliExpectedError(error) && error.context.code === "loop_generation_drift", fault);
      }
      assert.equal(endpoint.attempts(), attempts);
    } finally { endpoint.server.closeAllConnections(); endpoint.server.close(); rmSync(root, { recursive: true, force: true }); }
  }
});


test("received headers, timeout and cancellation recover the remote receipt with original accounting", async () => {
  for (const fault of ["body", "timeout", "cancel"]) {
    const endpoint = await receiptServer(false, fault === "body" ? 0 : 1, fault === "body");
    const { root, pmRoot, client } = await workspace(); const controller = new AbortController();
    const config = configValue(endpoint.baseURL);
    config.decision_model = { base_url: endpoint.baseURL, model: "tev1:4b", timeout_ms: fault === "timeout" ? 100 : 10000, receipt_protocol: "idempotency-v1" };
    try {
      const running = runSource(client, { pmRoot, author: "receipt-test" }, { id: "recovery", config, approval: "approval", signal: controller.signal });
      const rejected = assert.rejects(running);
      if (fault === "cancel") { await endpoint.remote; controller.abort(); }
      await rejected;
      const report = await resumeSource(client, { pmRoot, author: "receipt-test" }, { id: "recovery", approval: "approval" });
      assert.equal(report.samples_consumed, 8); assert.equal(endpoint.physical(), 8); assert.equal(endpoint.attempts(), 9);
    } finally { endpoint.server.closeAllConnections(); endpoint.server.close(); rmSync(root, { recursive: true, force: true }); }
  }
});


test("independent tracker runs have distinct receipt namespaces and observable commit boundaries", async () => {
  const endpoint = await receiptServer(); const workspaces = [await workspace(), await workspace()];
  const config = configValue(endpoint.baseURL);
  config.decision_model = { base_url: endpoint.baseURL, model: "tev1:4b", timeout_ms: 10000, receipt_protocol: "idempotency-v1" };
  const keys = new Set<string>();
  try {
    for (const { pmRoot, client } of workspaces) {
      const stages: string[] = [];
      const report = await runSource(client, { pmRoot, author: "receipt-test" }, { id: "recovery", config, approval: "approval",
        onDecision(stage) { stages.push(stage); } });
      assert.deepEqual(stages, Array.from({ length: 8 }, () => ["request", "response", "commit"]).flat());
      for (const generation of report.generations) {
        const notes = await client.notes(generation.run!, { outputBudget: "unbounded", outputLimit: "unbounded" }); assert.ok(!("output_budget_exceeded" in notes));
        for (const event of readSeries(notes.notes.map((note) => note.text)).events) { assert.ok(!keys.has(event.tags!.request_id)); keys.add(event.tags!.request_id); }
      }
    }
    assert.equal(keys.size, 16); assert.equal(endpoint.physical(), 16);
  } finally { endpoint.server.closeAllConnections(); endpoint.server.close(); for (const { root } of workspaces) rmSync(root, { recursive: true, force: true }); }
});


test("a run interrupted before dispatch can establish its not-yet-written namespace", async () => {
  const endpoint = await receiptServer(); const { root, pmRoot, client } = await workspace();
  const config = configValue(endpoint.baseURL);
  config.decision_model = { base_url: endpoint.baseURL, model: "tev1:4b", timeout_ms: 10000, receipt_protocol: "idempotency-v1" };
  try {
    await assert.rejects(runSource(client, { pmRoot, author: "receipt-test" }, { id: "recovery", config, approval: "approval",
      onDecision() { throw new Error("before dispatch"); } }), /before dispatch/);
    const run = await client.get("recovery-g1-collect");
    await client.comments(String(run.item.id), { delete: 1 });
    assert.equal(endpoint.physical(), 0);
    assert.equal((await rlLoopStatus(client, "recovery")).samples_consumed, 0);
    assert.equal((await resumeSource(client, { pmRoot, author: "receipt-test" }, { id: "recovery", approval: "approval" })).samples_consumed, 8);
    assert.equal(endpoint.physical(), 8);
  } finally { endpoint.server.closeAllConnections(); endpoint.server.close(); rmSync(root, { recursive: true, force: true }); }
});
