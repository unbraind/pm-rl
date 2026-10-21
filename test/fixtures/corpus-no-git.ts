/** Native process acceptance with no Git executable, immutable sources and real external policy updates. */
import assert from "node:assert/strict";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PmClient } from "@unbrained/pm-cli/sdk/core";
import { init, isPmCliExpectedError } from "@unbrained/pm-cli/sdk/runtime";
import { createExtensionTestHarness } from "@unbrained/pm-cli/sdk/testing";
import extension, { hashJson, resumeRlLoop, rlLoopStatus, runRlLoop, type RlCommandResult, type JsonValue } from "../../index.ts";
import { corpusHeldOut } from "../../corpus.ts";
import { listProcessJobs, processStaging, type ProcessAdapter } from "../../process.ts";

try {
const root = process.argv[2];
const initialized = await init("rl", { defaults: true, agentGuidance: "skip", author: "corpus-test" }, { cwd: root, pmRoot: join(root, ".agents/pm") });
const pmRoot = initialized.path;
const client = new PmClient({ pmRoot, author: "corpus-test", noExtensions: true });
for (let index = 64; index < 94; index += 1) await client.create({ id: `input-${index}`, type: "Task", title: "t".repeat(index), status: "closed", closeReason: "Completed synthetic source fixture" });
/** Snapshot every source item and its append-only history, excluding SDK caches. */
function sourceBytes(): string {
  return hashJson(["tasks", "history"].flatMap((folder) => readdirSync(join(pmRoot, folder)).sort().map((file) => readFileSync(join(pmRoot, folder, file), "utf8"))));
}
const before = sourceBytes();
process.stdout.write("source initialized\n");
const harness = await createExtensionTestHarness(extension, { name: "pm-rl", capabilities: ["commands", "hooks", "schema"] });
const output = join(root, "sealed.json");
const boundsFile = join(root, "bounds.json");
const declared = JSON.parse(readFileSync(new URL("../../examples/loop-corpus.json", import.meta.url), "utf8")) as Record<string, JsonValue>;
const adapter = declared.adapter as unknown as ProcessAdapter;
writeFileSync(boundsFile, JSON.stringify({ ...declared, samples_per_generation: 32, budget: 64,
  adapter: { ...adapter, allowance: { ...adapter.allowance, wall_ms: 30_000 } } }));
const options = { from_tracker: pmRoot, file: boundsFile, output };
const built = await harness.runCommand({ command: "rl corpus build", pmRoot, args: [], options });
assert.equal(built.handled, true); assert.equal((built.result as RlCommandResult).action, "rl-corpus-build");
assert.equal(sourceBytes(), before, "building must leave item and history bytes untouched");
const sealedBytes = readFileSync(output, "utf8");
await assert.rejects(harness.runCommand({ command: "rl corpus build", pmRoot, args: [], options }),
  (error: unknown) => isPmCliExpectedError(error) && error.context.code === "corpus_output_exists");
assert.equal(readFileSync(output, "utf8"), sealedBytes);
process.stdout.write("sealed corpus verified\n");
const { item: approval } = await client.create({ id: "allowance", title: "Bounded corpus run", type: "Decision", body: '```json\n{"permitted_promotions":2,"resource_budget":{"training_steps":16,"wall_ms":60000,"storage_bytes":524288,"compute_units":2000,"tokens":0}}\n```' });
const config = JSON.parse(sealedBytes) as JsonValue;
const request = { id: "corpus-recursion", config, approval: approval.id };
const report = await runRlLoop(client, { pmRoot, author: "corpus-test" }, request);
assert.equal(report.promoted, 2, JSON.stringify(report)); assert.equal(report.generations.length, 2);
process.stdout.write("two fits completed\n");
const [first, second] = report.generations;
assert.notEqual(first.candidate_checkpoint, second.candidate_checkpoint);
assert.equal((await client.get(second.run)).item.component, first.candidate_checkpoint);
const jobs = await listProcessJobs(client);
assert.equal(jobs.length, 2); assert.ok(jobs.every((job) => job.settled && job.charge.training_steps === 8));
const checkpoints = jobs.map((job) => readFileSync(join(processStaging(pmRoot, job.id), "checkpoint.json"), "utf8"));
// The source changes after sealing; resume must verify the sealed programme instead of collecting a new corpus.
await client.create({ id: "later-source", type: "Task", title: "Changed after seal" });
const resumed = await resumeRlLoop(client, { pmRoot, author: "corpus-test" }, { id: request.id, approval: approval.id });
assert.equal(resumed.resumed_generations, 2); assert.equal(resumed.final_checkpoint, report.final_checkpoint);
assert.deepEqual(jobs.map((job) => readFileSync(join(processStaging(pmRoot, job.id), "checkpoint.json"), "utf8")), checkpoints);
assert.equal((await listProcessJobs(client)).length, 2);
assert.equal((await rlLoopStatus(client, request.id, pmRoot)).promoted, 2);
process.stdout.write("resume verified\n");
assert.ok(Array.from({ length: 30 }, (_, i) => corpusHeldOut(i + 64)).some(Boolean));
writeFileSync(join(root, "result.json"), JSON.stringify(report));
process.stdout.write("two promoted successors; sealed replay\n");
} catch (error) { process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`); process.exitCode = 1; }
