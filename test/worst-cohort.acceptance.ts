/** Replay a read-only public tracker through a packed extension and a caller-selected installed host. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync, mkdirSync, symlinkSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { tmpdir } from "node:os";
import { PmClient } from "@unbrained/pm-cli/sdk/core";
import { init, isPmCliExpectedError, readSettings, resolveRuntimeStatusRegistry } from "@unbrained/pm-cli/sdk/runtime";
import { generationProvenance, hashJson, type JsonValue } from "../index.ts";
import { readEvaluationPlan, enforceEvaluationPlan, type EvaluationPlan, type EvaluationPlanReport } from "../evaluation-plan.ts";
import type { GenerationSpec } from "../lineage.ts";

/** Verify the exact read-only snapshot bytes before and after all SDK/CLI reads. */
function digest(root: string): string {
  const hash = createHash("sha256");
  /** Visit only the named scratch copy, never the original repository or a parent directory. */
  function visit(relative: string): void {
    for (const entry of readdirSync(join(root, relative), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const key = join(relative, entry.name); const file = join(root, key); assert.equal(statSync(file).mode & 0o222, 0);
      if (entry.isDirectory()) visit(key); else { assert.ok(entry.isFile()); hash.update(key); hash.update(readFileSync(file)); }
    }
  }
  visit(""); return hash.digest("hex");
}
const source = resolve(process.argv[2]); const output = resolve(process.argv[3]); const commit = process.argv[4]; const archive = resolve(process.argv[5]);
assert.match(commit, /^[a-f0-9]{40}$/);
const launcher = JSON.parse(process.argv[6]) as string[]; assert.ok(launcher.length > 0);
const before = digest(source); const sourceClient = new PmClient({ cwd: dirname(source), pmRoot: source, author: "cohort-acceptance", noExtensions: true });
const items = (await sourceClient.listAllComplete({ includeBody: false })).items;
const registry = resolveRuntimeStatusRegistry((await readSettings(source)).schema);
const active = items.filter((item) => registry.active_statuses.has(String(item.status)));
assert.ok(active.length > 0); assert.ok(items.length > active.length * 2);
const root = mkdtempSync(join(tmpdir(), "rl-cohort-acceptance-"));
const tracker = await init("rl", { defaults: true, author: "cohort-acceptance", agentGuidance: "skip" }, { cwd: root, pmRoot: join(root, ".agents/pm") });
const commandEnv: NodeJS.ProcessEnv = { ...process.env, PM_PATH: tracker.path, PM_AUTHOR: "cohort-acceptance", GIT_CEILING_DIRECTORIES: dirname(root), NODE_V8_COVERAGE: undefined, NPM_CONFIG_USERCONFIG: "/dev/null", npm_config_userconfig: "/dev/null" };
for (const key of Object.keys(commandEnv)) if (/token|secret|password|credential|api_?key|NPM_MEDIA_SERVER/i.test(key)) delete commandEnv[key];
/** Execute the actual installed entrypoint; all durable output stays in the scratch project. */
function command(args: string[]): string { return execFileSync(launcher[0], [...launcher.slice(1), ...args], { cwd: process.argv[7] === undefined ? root : resolve(process.argv[7]), env: commandEnv, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }); }
command(["package", "install", archive, "--project", "--json"]);
// The host has been resolved; running the commands themselves requires no Git executable.
const bin = join(root, "bin"); mkdirSync(bin); symlinkSync(process.execPath, join(bin, "node")); symlinkSync("/bin/sh", join(bin, "sh")); commandEnv.PATH = bin;
const client = new PmClient({ cwd: root, pmRoot: tracker.path, author: "cohort-acceptance", noExtensions: true });
for (const name of ["Generation", "Run"]) await client.schemaAddType(name, { folder: `${name.toLowerCase()}s`, defaultStatus: "open" });
const seed: GenerationSpec = { base_checkpoint: "active-policy", policy: "", collection_runs: [], training_config: {}, environment_version: "", reward_spec_version: "", parent: null, seed: true, promoted: false, approval: null, proxy_score: null, held_out_score: null, gap: null, promotion_evidence: null };
await client.create({ id: "rl-seed", title: "Baseline", type: "Generation", body: `\`\`\`json\n${JSON.stringify(seed)}\n\`\`\``, affectedVersion: hashJson(generationProvenance(seed)), unset: ["parent"] });
const snapshot = hashJson(items.map((item) => ({ id: item.id, status: item.status } as JsonValue)));
const plan: EvaluationPlan = { format: "pm-rl/evaluation-plan/1", candidate: "rl-candidate", incumbent: "rl-seed", incumbent_version: hashJson(generationProvenance(seed)), population: `Public unbraind/pm-rl tracker ${commit}`, selection: `Full snapshot ${snapshot}`, correlation_unit: "repository; no independence between tasks assumed", members: items.map((item) => ({ id: hashJson(item.id), unit: "one-repository" })), objective: "status-role-replay", objective_version: "constant-inactive-vs-active/1", evaluation_context: "held-out", direction: "maximize", reward_bounds: [0, 1], criterion: { confidence: 0.95, minSamples: 10, effectThreshold: 0 }, stopping: { kind: "fixed", observations: items.length, independent_units: 1 }, protected_cohorts: [{ id: "active-tasks", members: active.map((item) => hashJson(item.id)), min_units: 1, max_regression: 0 }] };
const file = join(root, "plan.json"); writeFileSync(file, JSON.stringify(plan));
command(["rl", "eval", "plan", "register", "--file", file, "--json"]);
const registered = (await readEvaluationPlan(client, plan.candidate))!;
await client.create({ id: "rl-collection", title: "Collection", type: "Run", unset: ["parent"] });
const candidate: GenerationSpec = { ...seed, base_checkpoint: "inactive-policy", policy: "inactive-policy", parent: "rl-seed", seed: false, collection_runs: ["rl-collection"], environment_version: "training", reward_spec_version: "1", evaluation_plan: registered.comparison };
await client.create({ id: plan.candidate, title: "Candidate", type: "Generation", body: `\`\`\`json\n${JSON.stringify(candidate)}\n\`\`\``, affectedVersion: hashJson(generationProvenance(candidate)), unset: ["parent"] });
const rows = items.map((item) => { const active = registry.active_statuses.has(String(item.status)); return { id: hashJson(item.id), candidate: active ? 0 : 1, incumbent: active ? 1 : 0 }; });
const observations = join(root, "observations.json"); writeFileSync(observations, JSON.stringify(rows));
const json = command(["rl", "eval", "plan", "evaluate", plan.candidate, "--file", observations, "--json"]);
const toon = command(["rl", "eval", "plan", "evaluate", plan.candidate, "--file", observations]);
const report = (JSON.parse(json) as { details: EvaluationPlanReport }).details;
assert.equal(report.cohorts![0].code, "eval_cohort_regression"); assert.equal(report.verdict.decision, "refuse");
assert.ok(report.candidate_mean > report.incumbent_mean); assert.ok(Buffer.byteLength(json) < 2500); assert.ok(Buffer.byteLength(toon) < 2500);
await assert.rejects(enforceEvaluationPlan(client, plan.candidate, { objective: plan.objective, objective_version: plan.objective_version, evaluation_context: plan.evaluation_context, direction: plan.direction, seed_set: registered.comparison, scale: 1, value: report.candidate_mean }), (error: unknown) => isPmCliExpectedError(error) && error.context.code === "eval_cohort_regression");
assert.equal(digest(source), before);
const evidence = { source: "https://github.com/unbraind/pm-rl", commit, snapshot, source_digest: before, source_unchanged: true, source_read_only: true, git_required: false, items: items.length, active_items: active.length, inactive_items: items.length - active.length, json_bytes: Buffer.byteLength(json), toon_bytes: Buffer.byteLength(toon), report, limitation: "Descriptive constant-policy status-role replay, no inference, training or causal improvement claim. One repository counts as one independent unit; the aggregate also refuses insufficient samples." };
writeFileSync(output, JSON.stringify(evidence, null, 2) + "\n");
console.log(JSON.stringify({ items: evidence.items, active_items: evidence.active_items, candidate_mean: report.candidate_mean, incumbent_mean: report.incumbent_mean, cohort_improvement: report.cohorts![0].improvement, json_bytes: evidence.json_bytes, toon_bytes: evidence.toon_bytes, source_unchanged: true }));
