/** Packed real-CLI acceptance: recursive learning, artifacts, refusals and CPU budget. */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { PmClient } from "@unbrained/pm-cli/sdk/core";
import { init } from "@unbrained/pm-cli/sdk/runtime";
import type { RlLoopReport } from "../index.ts";
import { parseGenerationSpec } from "../lineage.ts";

test("packed pm CLI performs three real LM generations and records contamination refusal under 20 seconds", async () => {
  const root = mkdtempSync(join(tmpdir(), "pm-rl-lm-cli-"));
  try {
    const tracker = await init("rl", { defaults: true, agentGuidance: "skip", author: "rl-acceptance" }, { cwd: root });
    const client = new PmClient({ pmRoot: tracker.path, cwd: root, author: "rl-acceptance" });
    const approval = await client.create({ id: "approval", type: "Decision", title: "Bounded synthetic LM approval", body: '```json\n{"permitted_promotions":4}\n```' });
    const cli = resolve("node_modules/@unbrained/pm-cli/dist/cli.js");
    const env = { ...process.env, NODE_V8_COVERAGE: undefined, PM_PATH: tracker.path, PM_AUTHOR: "rl-acceptance", PM_TELEMETRY_SOURCE_CONTEXT: "test", PM_TELEMETRY_INLINE_FLUSH: "1" };
    const pack = JSON.parse(execFileSync("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", root], { encoding: "utf8", env })) as Array<{ filename: string }>;
    execFileSync(process.execPath, [cli, "package", "install", join(root, pack[0]!.filename), "--project", "--json"], { cwd: root, env, stdio: "pipe", timeout: 60_000 });
    const config = JSON.parse(readFileSync(new URL("../examples/loop-lm.json", import.meta.url), "utf8")) as Record<string, unknown>;
    const file = join(root, "cfg.json");
    writeFileSync(file, JSON.stringify(config));
    const started = performance.now();
    const output = JSON.parse(execFileSync(process.execPath, [cli, "rl", "loop", "run", "proof", "--file", file, "--approval", String(approval.item.id), "--json"], { cwd: root, env, encoding: "utf8", timeout: 25_000 })) as { details: RlLoopReport };
    const elapsed = performance.now() - started;
    const report = output.details;
    assert.ok(elapsed < 20_000, `real CLI took ${elapsed.toFixed(0)}ms`);
    assert.equal(report.generations.length, 3);
    assert.equal(report.promoted, 2);
    assert.equal(report.stop_reason, "evaluation_rejected");
    assert.notEqual(report.generations[0]!.candidate_checkpoint, report.generations[1]!.candidate_checkpoint);
    let previous = "";
    const rows: Record<string, unknown>[] = [];
    for (const generation of report.generations) {
      const item = await client.get(generation.item);
      const fenced = /```json\n([\s\S]+?)\n```/.exec(String(item.item.body));
      assert.ok(fenced?.[1]);
      const spec = parseGenerationSpec(fenced[1], "CLI generation");
      const receipt = spec.training_config as Record<string, unknown>;
      const run = await client.get(generation.run);
      assert.equal(run.item.component, receipt.source_checkpoint);
      if (generation.generation > 1) assert.equal(receipt.source_checkpoint, previous);
      const bytes = readFileSync(join(tracker.path, String(receipt.checkpoint_path)));
      assert.equal(bytes.byteLength, receipt.checkpoint_bytes);
      assert.equal(`sha256:${createHash("sha256").update(bytes).digest("hex")}`, generation.candidate_checkpoint);
      assert.ok(Number(receipt.parameter_delta_l2) > 0);
      if (generation.generation === 1) assert.equal(receipt.baseline_exact_match, 0);
      if (generation.generation === 2) assert.ok(Number(receipt.candidate_exact_match) > 0);
      rows.push({ generation: generation.generation, source: receipt.source_checkpoint, candidate: receipt.candidate_checkpoint, exact_match: receipt.candidate_exact_match, reward: receipt.candidate_held_out_mean, promoted: generation.promoted, delta_l2: receipt.parameter_delta_l2, wall_ms: receipt.wall_ms, bytes: receipt.checkpoint_bytes, total_parameters: receipt.total_parameters });
      previous = generation.candidate_checkpoint;
    }
    assert.match(report.refusal_reason ?? "", /regress/i);
    assert.equal(report.final_checkpoint, report.generations[1]!.candidate_checkpoint);
    const dirty = { ...config, evaluation: [{ id: "foreign-held-out", string: (config.training as Array<{ string: string }>)[0]!.string }] };
    writeFileSync(file, JSON.stringify(dirty));
    const refused = spawnSync(process.execPath, [cli, "rl", "loop", "run", "dirty", "--file", file, "--approval", String(approval.item.id), "--json"], { cwd: root, env, encoding: "utf8" });
    assert.notEqual(refused.status, 0);
    assert.match(refused.stderr + refused.stdout, /lm_dataset_overlap/);
    assert.ok(JSON.stringify(await client.comments(String(approval.item.id))).includes("lm_dataset_overlap"));
    console.log(JSON.stringify({ measured_cli_ms: elapsed, total_parameters: rows[0]!.total_parameters, generations: rows }));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
