/** Real vector corpus attempts share one sealed non-Git tracker and retain every refusal across replay. */
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PmClient } from "@unbrained/pm-cli/sdk/core";
import { corpusHeldOut } from "../../corpus.ts";
import { init } from "@unbrained/pm-cli/sdk/runtime";
import { baselineMain } from "../../scripts/live-baseline.ts";
import { type JsonValue } from "../../index.ts";

/** Exercise the same real jobs in-process for source coverage and in a Git-free child for acceptance. */
export async function vectorNoGit(root: string): Promise<void> {
const { path: pmRoot } = await init("rl", { defaults: true, agentGuidance: "skip", author: "baseline-test" }, { cwd: root, pmRoot: join(root, ".agents/pm") });
const client = new PmClient({ pmRoot, author: "baseline-test", noExtensions: true });
const lengths = [false, true].flatMap((heldOut) => Array.from({ length: 200 }, (_, index) => index + 40).filter((length) => corpusHeldOut(length) === heldOut).slice(0, 10));
for (const length of lengths) await client.create({ id: `source-${length}`, type: "Task", title: "t".repeat(length), status: "closed", closeReason: "Synthetic completed source" });
const bounds = JSON.parse(readFileSync(new URL("../../examples/loop-corpus-baseline.json", import.meta.url), "utf8")) as Record<string, JsonValue>;
const selected = { ...bounds, fit_steps: 8, samples_per_generation: 32, budget: 96, evaluation_samples: 512,
  adapter: { kind: "process-bandit", allowance: { training_steps: 8, wall_ms: 30000, storage_bytes: 262144, compute_units: 10000, tokens: 0 } } };
const boundsFile = join(root, "bounds.json"); writeFileSync(boundsFile, JSON.stringify(selected));
const scriptUrl = new URL("../../scripts/live-baseline.ts", import.meta.url);
await baselineMain(["node", fileURLToPath(scriptUrl), pmRoot, join(root, "controller"), boundsFile], scriptUrl.href);
const evidence = JSON.parse(readFileSync(join(root, "controller", "evidence.json"), "utf8")) as Record<string, JsonValue>;
assert.ok((evidence.charges as Record<string, JsonValue>[]).every((job) => job.source_policy === evidence.final_checkpoint));
assert.equal(evidence.promoted, 0);
assert.equal((evidence.generations as Record<string, JsonValue>[]).length, 3);
assert.ok((evidence.generations as Record<string, JsonValue>[]).every((row) => row.refusal === "item_constant_not_beaten"));
assert.equal(evidence.samples_consumed, 96);
process.stdout.write("three refused vector proposals; sealed replay; incumbent retained\n");

}
if (process.argv[1] === fileURLToPath(import.meta.url)) await vectorNoGit(process.argv[2]);
