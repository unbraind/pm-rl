/** Actual SDK creation histories feed an external balanced trainer and replay without Git. */
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PmClient } from "@unbrained/pm-cli/sdk/core";
import { init } from "@unbrained/pm-cli/sdk/runtime";
import { createExtensionTestHarness } from "@unbrained/pm-cli/sdk/testing";
import { corpusHeldOut } from "../../corpus.ts";
import extension, { type JsonValue, type RlCommandResult } from "../../index.ts";
import { runBaselineAcceptance } from "../../scripts/live-baseline.ts";

/** Keep fixture budgets small while exercising real files, process receipts, status and source immutability. */
export async function intakeNoGit(root: string): Promise<void> {
  const { path: pmRoot } = await init("intake", { defaults: true, agentGuidance: "skip", author: "intake-test" }, { cwd: root, pmRoot: join(root, ".agents/pm") });
  const client = new PmClient({ pmRoot, author: "intake-test", noExtensions: true });
  for (const held of [false, true]) for (const issue of [false, true]) {
    const prefix = issue ? "fix crash " : "future roadmap ";
    const length = Array.from({ length: 100 }, (_, index) => index + 30).find((length) => corpusHeldOut(length) === held)!;
    await client.create({ id: `source-${held}-${issue}`, type: issue ? "Issue" : "Feature", title: prefix + "z".repeat(length - prefix.length) });
  }
  const bounds = JSON.parse(readFileSync(new URL("../../examples/loop-intake-objective.json", import.meta.url), "utf8")) as Record<string, JsonValue>;
  const harness = await createExtensionTestHarness(extension, { name: "pm-rl", capabilities: ["commands", "hooks", "schema"] });
  const output = join(root, "sealed-intake.json");
  const invalidBounds = join(root, "invalid-bounds.json"); writeFileSync(invalidBounds, "null");
  await assert.rejects(harness.runCommand({ command: "rl corpus build", pmRoot, args: [], options: { from_tracker: pmRoot, file: invalidBounds, output } }), /corpus_invalid_bounds/);
  await assert.rejects(runBaselineAcceptance(pmRoot, join(root, "invalid-controller"), null), /corpus_invalid_bounds/);
  const built = await harness.runCommand({ command: "rl corpus build", pmRoot, args: [], options: {
    from_tracker: pmRoot, file: new URL("../../examples/loop-intake-objective.json", import.meta.url).pathname, output,
  } });
  assert.equal((built.result as RlCommandResult).details!.held_out_positive, 1);
  assert.equal((JSON.parse(readFileSync(output, "utf8")) as Record<string, JsonValue>).objective, "intake-issue-balanced-v1");
  const selected = { ...bounds, max_generations: 1, samples_per_generation: 32, budget: 32, min_samples: 1 };
  const evidence = await runBaselineAcceptance(pmRoot, join(root, "controller"), selected);
  const result = evidence as Record<string, JsonValue>;
  assert.equal(result.promoted, 0);
  const generations = result.generations as Record<string, JsonValue>[];
  assert.equal(generations.length, 1); assert.equal(generations[0].refusal, "item_heuristic_not_beaten");
  assert.deepEqual((result.baselines as Record<string, JsonValue>).constant_one, { mean: 0.5, lower: 0.5, upper: 0.5 });
  assert.equal((result.replay as Record<string, JsonValue>).no_new_jobs, true);
  process.stdout.write("balanced intake fit and sealed replay\n");
}
if (process.argv[1] === fileURLToPath(import.meta.url)) await intakeNoGit(process.argv[2]);
