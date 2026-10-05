/** The live script uses the same persisted controller against a real deterministic HTTP endpoint in CI. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { test } from "node:test";
import { liveConfiguration, runLiveAcceptance, main } from "../scripts/live-systemone.ts";

test("live acceptance measures two promoted heads, successor collection, tokens and latency", async () => {
  let requests = 0;
  const server = createServer((request, reply) => {
    let body = ""; request.on("data", (chunk: Buffer) => { body += chunk.toString(); });
    request.on("end", () => {
      requests += 1;
      const { state } = JSON.parse(body) as { state: string };
      const isBug = /[Ff]ix|[Rr]epair/.test(state);
      reply.setHeader("content-type", "application/json");
      reply.end(JSON.stringify({ answers: { kind: { type: "choice", probabilities: { Bug: isBug ? 0.97 : 0.03, Feature: isBug ? 0.03 : 0.97 } } }, usage: { input_tokens: 10, output_tokens: 1 } }));
    });
  });
  await new Promise<void>((resolve) => { server.listen(0, "127.0.0.1", resolve); });
  const address = server.address(); assert.ok(address !== null && typeof address !== "string");
  const baseURL = `http://127.0.0.1:${address.port}`;
  try {
    assert.ok(liveConfiguration());
    const report = await runLiveAcceptance(liveConfiguration(baseURL, "tev1:4b"));
    assert.equal(report.tokens, 88); assert.equal(report.queries, 8); assert.equal(requests, 8);
    assert.ok(Number(report.endpoint_ms) > 0);
    let printed = "";
    await main({ SYSTEMONE_BASE_URL: baseURL, SYSTEMONE_MODEL: "tev1:4b" }, (text) => { printed = text; });
    assert.equal((JSON.parse(printed) as { queries: number }).queries, 8);
    const child = spawn(process.execPath, ["scripts/live-systemone.ts"], { env: { ...process.env, SYSTEMONE_BASE_URL: baseURL, SYSTEMONE_MODEL: "tev1:4b" } });
    let output = ""; child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString(); });
    const code = await new Promise<number | null>((resolve, reject) => { child.on("error", reject); child.on("exit", resolve); });
    assert.equal(code, 0); assert.equal((JSON.parse(output) as { queries: number }).queries, 8);
    const bad = liveConfiguration(baseURL, "tev1:4b") as Record<string, unknown>;
    await assert.rejects(runLiveAcceptance({ ...bad, minimum_improvement: 1 } as Parameters<typeof runLiveAcceptance>[0]), /two promotions/);
  } finally { server.closeAllConnections(); await new Promise<void>((resolve) => { server.close(() => resolve()); }); }
});
