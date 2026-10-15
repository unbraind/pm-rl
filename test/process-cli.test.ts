/** Packed CLI acceptance for process selection, compact output, complete JSON and two-generation lineage. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";
import type { RlLoopReport, RlLoopStatusReport } from "../index.ts";
import { configuration, processWorkspace } from "./fixtures/process-workspace.ts";

test("packed CLI trains two external generations, resumes and reports compact/default and complete JSON evidence", async () => {
  const { root, pmRoot, approval, client } = await processWorkspace(); const cli = resolve("node_modules/@unbrained/pm-cli/dist/cli.js");
  const env = { ...process.env, PM_PATH: pmRoot, PM_AUTHOR: "process-test", NODE_V8_COVERAGE: undefined, PM_TELEMETRY_SOURCE_CONTEXT: "test", PM_TELEMETRY_INLINE_FLUSH: "1" };
  const { PM_PATH: _fixtureRoot, ...packEnv } = env;
  const [{ filename }] = JSON.parse(execFileSync("npm", ["pack", "--ignore-scripts", "--foreground-scripts=false", "--json", "--pack-destination", root], { encoding: "utf8", env: { ...packEnv, npm_config_ignore_scripts: "true" } })) as Array<{ filename: string }>;
  execFileSync(process.execPath, [cli, "package", "install", join(root, filename), "--project", "--json"], { cwd: root, env, stdio: "pipe", timeout: 60000 });
  const file = join(root, "programme.json"); writeFileSync(file, JSON.stringify(configuration));
  const start = performance.now();
  const { details: report } = JSON.parse(execFileSync(process.execPath, [cli, "rl", "loop", "run", "process-demo", "--file", file, "--approval", approval, "--json"], { cwd: root, env, encoding: "utf8", timeout: 20000 })) as { details: RlLoopReport };
  const elapsed = performance.now() - start;
  // Elapsed time is reported, not asserted: host load must not fail an otherwise correct run within the subprocess timeout.
  console.log(`process CLI loop: ${Math.round(elapsed)} ms`);
  assert.equal(report.promoted, 2); assert.equal(report.process_jobs!.length, 2);
  const rows = [];
  for (const job of report.process_jobs!) {
    assert.equal(job.state, "promoted"); assert.equal(job.settled, true);
    const bytes = readFileSync(join(pmRoot, "runtime/pm-rl/jobs", job.id, "checkpoint.json"));
    assert.equal(`sha256:${createHash("sha256").update(bytes).digest("hex")}`, job.completion!.digest);
    rows.push({ generation: (job.binding as { generation: number }).generation, source: job.completion!.source_policy, candidate: job.completion!.policy.digest, artifact: job.completion!.digest, resources: job.charge });
  }
  assert.equal(rows[1].source, rows[0].candidate);
  const second = await client.get(report.generations[1].run); assert.equal(second.item.component, rows[0].candidate);
  const { details: status } = JSON.parse(execFileSync(process.execPath, [cli, "rl", "loop", "status", "process-demo", "--json"], { cwd: root, env, encoding: "utf8" })) as { details: RlLoopStatusReport };
  assert.equal(status.final_checkpoint, report.final_checkpoint); assert.equal(status.process_jobs!.length, 2);
  const compact = execFileSync(process.execPath, [cli, "rl", "loop", "resume", "process-demo", "--approval", approval], { cwd: root, env, encoding: "utf8" });
  assert.ok(compact.includes("promoted")); assert.ok(!compact.includes("training_config"));
  const compactStatus = execFileSync(process.execPath, [cli, "rl", "loop", "status", "process-demo"], { cwd: root, env, encoding: "utf8" }); assert.ok(!compactStatus.includes("training_config"));
  const compactRun = execFileSync(process.execPath, [cli, "rl", "loop", "run", "process-demo", "--file", file, "--approval", approval], { cwd: root, env, encoding: "utf8" }); assert.ok(!compactRun.includes("training_config"));
  console.log(JSON.stringify({ process_cli_ms: elapsed, held_out: report.generations.map((entry) => entry.held_out_mean), generations: rows }));
});
