/** Public read-only tracker acceptance with installed CLI, SDK role lookup and aggregate-only evidence. */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync, mkdirSync, symlinkSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { tmpdir } from "node:os";
import { PmClient } from "@unbrained/pm-cli/sdk/core";
import { init, readSettings, resolveRuntimeStatusRegistry } from "@unbrained/pm-cli/sdk";
import { generationProvenance, hashJson } from "../index.ts";
import { evaluationComparison, readEvaluationPlan, type EvaluationPlan, type EvaluationPlanReport } from "../evaluation-plan.ts";
import type { GenerationSpec } from "../lineage.ts";

/** Digest only the explicitly provided public tracker copy and require read-only permissions. */
function digest(root: string): string {
  const hash = createHash("sha256");
  /** Stable recursive walk confined to the provided tracker root. */
  function walk(relative: string): void {
    for (const entry of readdirSync(join(root, relative), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(relative, entry.name); assert.equal(statSync(join(root, path)).mode & 0o222, 0);
      if (entry.isDirectory()) walk(path); else { assert.ok(entry.isFile()); hash.update(path); hash.update(readFileSync(join(root, path))); }
    }
  }
  walk(""); return hash.digest("hex");
}
const source = resolve(process.argv[2]); const output = resolve(process.argv[3]); const commit = process.argv[4]; const archive = resolve(process.argv[5]);
assert.match(commit, /^[a-f0-9]{40}$/); const before = digest(source);
const sourceClient = new PmClient({ cwd: dirname(source), pmRoot: source, author: "sequential-acceptance", noExtensions: true });
const items = (await sourceClient.listAllComplete({ includeBody: false })).items;
const registry = resolveRuntimeStatusRegistry((await readSettings(source)).schema);
const done = items.filter((item) => registry.terminal_done_statuses.has(String(item.status))).length;
const root = mkdtempSync(join(tmpdir(), "rl-sequential-public-")); process.env.GIT_CEILING_DIRECTORIES = dirname(root);
const tracker = await init("rl", { defaults: true, author: "sequential-acceptance", agentGuidance: "skip" }, { cwd: root, pmRoot: join(root, ".agents/pm") });
const cli = resolve("node_modules/@unbrained/pm-cli/dist/cli.js"); const env: NodeJS.ProcessEnv = { ...process.env, PM_PATH: tracker.path, PM_AUTHOR: "sequential-acceptance", NODE_V8_COVERAGE: undefined };
execFileSync(process.execPath, [cli, "package", "install", archive, "--project", "--json"], { cwd: root, env, stdio: "pipe" });
const bin = join(root, "bin"); mkdirSync(bin); symlinkSync(process.execPath, join(bin, "node")); const identityTool = process.platform === "linux" ? "getconf" : "ps"; symlinkSync(execFileSync("/bin/sh", ["-c", `command -v ${identityTool}`], { encoding: "utf8" }).trim(), join(bin, identityTool)); env.PATH = bin;
/** Execute the actual installed command surface without any Git executable. */
function command(args: string[]): string { return execFileSync(process.execPath, [cli, "rl", "eval", "plan", ...args], { cwd: root, env, encoding: "utf8" }); }
const client = new PmClient({ cwd: root, pmRoot: tracker.path, author: "sequential-acceptance", noExtensions: true });
for (const type of ["Generation", "Run"]) await client.schemaAddType(type, { folder: `${type.toLowerCase()}s`, defaultStatus: "open" });
const seed: GenerationSpec = { base_checkpoint: "constant-not-done", policy: "", collection_runs: [], training_config: {}, environment_version: "", reward_spec_version: "", parent: null, seed: true, promoted: false, approval: null, proxy_score: null, held_out_score: null, gap: null, promotion_evidence: null };
await client.create({ id: "rl-seed", type: "Generation", title: "Fixed incumbent", body: `\`\`\`json\n${JSON.stringify(seed)}\n\`\`\``, affectedVersion: hashJson(generationProvenance(seed)) });
const snapshot = hashJson(items.map((item) => ({ id: String(item.id), status: String(item.status) })));
const plan: EvaluationPlan = { format: "pm-rl/evaluation-plan/1", candidate: "rl-candidate", incumbent: "rl-seed", incumbent_version: hashJson(generationProvenance(seed)), population: `Public unbraind/pm-rl at ${commit}`, selection: `Complete SDK snapshot ${snapshot}; no outcome filtering`, correlation_unit: "repository; related items are not independent units", members: items.map((item) => ({ id: hashJson(String(item.id)), unit: "public-repository" })), objective: "done-role-accuracy", objective_version: "constant-classifiers/1", evaluation_context: snapshot, direction: "maximize", reward_bounds: [0, 1], criterion: { confidence: 0.95, minSamples: 1, effectThreshold: 0 }, stopping: { kind: "sequential", method: "hoeffding-alpha-spending/1", observations: items.length, independent_units: 1, unit_order: ["public-repository"], looks: [1], review: "rl-review" } };
await client.create({ id: "rl-review", type: "Decision", title: "Review descriptive public replay", body: JSON.stringify({ format: "pm-rl/sequential-review/1", comparison: evaluationComparison(plan) }) });
const file = join(root, "plan.json"); writeFileSync(file, JSON.stringify(plan)); command(["register", "--file", file, "--json"]);
const registered = (await readEvaluationPlan(client, plan.candidate))!;
await client.create({ id: "rl-collection", type: "Run", title: "Post-declaration collection" });
const candidate: GenerationSpec = { ...seed, evaluation_plan: registered.comparison, base_checkpoint: "constant-done", parent: "rl-seed", seed: false, policy: "constant-done", collection_runs: ["rl-collection"], environment_version: "training", reward_spec_version: "v1" };
await client.create({ id: plan.candidate, type: "Generation", title: "Declared candidate", body: `\`\`\`json\n${JSON.stringify(candidate)}\n\`\`\``, affectedVersion: hashJson(generationProvenance(candidate)) });
const rows = items.map((item) => { const isDone = registry.terminal_done_statuses.has(String(item.status)); return { id: hashJson(String(item.id)), candidate: isDone ? 1 : 0, incumbent: isDone ? 0 : 1 }; });
const rowsFile = join(root, "rows.json"); writeFileSync(rowsFile, JSON.stringify(rows));
const json = command(["advance", plan.candidate, "--file", rowsFile, "--json"]); const report = (JSON.parse(json) as { details: EvaluationPlanReport }).details;
const toon = command(["resume", plan.candidate]);
const restarted = (JSON.parse(command(["resume", plan.candidate, "--json"])) as { details: EvaluationPlanReport }).details;
assert.deepEqual(restarted, report); assert.equal(report.sequential?.state, "exhausted"); assert.equal(report.verdict.decision, "refuse");
assert.equal(report.observations, items.length); assert.equal(report.independent_units, 1); assert.ok(Math.abs(report.candidate_mean - done / items.length) < 1e-14);
assert.ok(Buffer.byteLength(json) < 2000); assert.ok(Buffer.byteLength(toon) < 2000); assert.equal(digest(source), before);
const checkpointRecords = (await client.listAllComplete({ includeBody: false })).items.filter((item) => String(item.id).includes("-look-")).length;
// A separate synthetic probe exercises the review's exact creation order against the packed CLI.
const invalid: EvaluationPlan = { ...plan, candidate: "rl-invalid", members: Array.from({ length: 64 }, (_, index) => ({ id: `m${index}`, unit: `u${index}` })), stopping: { kind: "sequential", method: "hoeffding-alpha-spending/1", observations: 64, independent_units: 64, unit_order: Array.from({ length: 64 }, (_, index) => `u${index}`), looks: [16, 64], review: "rl-invalid-review" } };
const invalidComparison = evaluationComparison(invalid);
await client.create({ id: "rl-invalid-review", type: "Decision", title: "Synthetic review", body: JSON.stringify({ format: "pm-rl/sequential-review/1", comparison: invalidComparison }) });
writeFileSync(file, JSON.stringify(invalid)); command(["register", "--file", file, "--json"]);
const invalidCandidate: GenerationSpec = { ...candidate, evaluation_plan: invalidComparison, collection_runs: ["rl-invalid-run"] };
await client.create({ id: invalid.candidate, type: "Generation", title: "Synthetic pre-collection candidate", body: `\`\`\`json\n${JSON.stringify(invalidCandidate)}\n\`\`\``, affectedVersion: hashJson(generationProvenance(invalidCandidate)) });
let previous: string | null = null;
for (const [slot, count] of [16, 64].entries()) {
  const observations = invalid.members.slice(0, count).map((member, index) => ({ id: member.id, candidate: index >= 16 ? 1 : 0, incumbent: 0 }));
  const raw = { format: "pm-rl/sequential-checkpoint/1", comparison: invalidComparison, previous, observations }; const seal = hashJson(raw);
  await client.create({ id: `rl-invalid-evaluation-plan-look-${slot + 1}`, type: "Decision", title: "Synthetic sealed look", tags: "pm-rl:sequential-checkpoint", body: JSON.stringify(raw), affectedVersion: seal });
  if (slot === 0) await client.create({ id: "rl-invalid-run", type: "Run", title: "Synthetic late collection" });
  previous = seal; writeFileSync(rowsFile, JSON.stringify(observations));
}
const beforeRefusals = (await client.listAllComplete({ includeBody: true })).items;
for (const args of [["resume", invalid.candidate], ["resume", invalid.candidate, "--json"], ["advance", invalid.candidate, "--file", rowsFile, "--json"]]) {
  const result = spawnSync(process.execPath, [cli, "rl", "eval", "plan", ...args], { cwd: root, env, encoding: "utf8" });
  assert.equal(result.status, 4); assert.match(result.stdout + result.stderr, /eval_plan_late/);
}
assert.deepEqual((await client.listAllComplete({ includeBody: true })).items, beforeRefusals); assert.equal(digest(source), before);
const evidence = { source: "https://github.com/unbraind/pm-rl", commit, snapshot, source_digest: before, source_read_only: true, source_unchanged: true, non_git: true, git_absent_from_path: true, items: items.length, done_role_items: done, cli_json_bytes: Buffer.byteLength(json), cli_toon_bytes: Buffer.byteLength(toon), resumed_exactly: true, checkpoint_records: checkpointRecords, packed_chronology_refusals: 3, packed_chronology_unchanged: true, ...report, limitation: "Descriptive public replay. One repository is one correlation unit; no causal benefit or deployed promotion claim." };
writeFileSync(output, JSON.stringify(evidence, null, 2) + "\n"); console.log(JSON.stringify(evidence));
