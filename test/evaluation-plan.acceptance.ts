/** Read-only public tracker acceptance; retain aggregate numbers and hashes, never source text or local paths. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync, mkdirSync, symlinkSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { tmpdir } from "node:os";
import { PmClient } from "@unbrained/pm-cli/sdk/core";
import { init, isPmCliExpectedError } from "@unbrained/pm-cli/sdk/runtime";
import { generationProvenance, hashJson } from "../index.ts";
import { evaluationComparison, readEvaluationPlan, enforceEvaluationPlan, type EvaluationPlan, type EvaluationPlanReport } from "../evaluation-plan.ts";
import { decidePromotion } from "../promotion.ts";
import type { GenerationSpec, ScoreRecord } from "../lineage.ts";

/** Hash every file in the exact copied source and verify its read-only mode. */
function sourceDigest(root: string): string {
  const digest = createHash("sha256");
  /** Walk only the explicitly supplied tracker copy, in a stable order. */
  function walk(relative: string): void {
    for (const entry of readdirSync(join(root, relative), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const key = join(relative, entry.name); const file = join(root, key);
      assert.equal(statSync(file).mode & 0o222, 0);
      if (entry.isDirectory()) walk(key); else { assert.ok(entry.isFile()); digest.update(JSON.stringify(key)); digest.update(readFileSync(file)); }
    }
  }
  walk(""); return digest.digest("hex");
}
const cli = resolve("node_modules/@unbrained/pm-cli/dist/cli.js"); const archive = resolve(process.argv[5]);
const source = resolve(process.argv[2]); const output = resolve(process.argv[3]); const commit = process.argv[4];
assert.match(commit, /^[a-f0-9]{40}$/);
const before = sourceDigest(source);
const sourceClient = new PmClient({ pmRoot: source, cwd: dirname(source), author: "evaluation-acceptance", noExtensions: true });
const inventory = await sourceClient.listAllComplete({ includeBody: false });
const items = inventory.items; assert.ok(items.length > 10);
const root = mkdtempSync(join(tmpdir(), "rl-plan-acceptance-"));
process.env.GIT_CEILING_DIRECTORIES = dirname(root);
const initialized = await init("rl", { defaults: true, author: "evaluation-acceptance", agentGuidance: "skip" }, { cwd: root, pmRoot: join(root, ".agents/pm") });
const commandEnv: NodeJS.ProcessEnv = { ...process.env, NODE_V8_COVERAGE: undefined, PM_PATH: initialized.path, PM_AUTHOR: "evaluation-acceptance" };
execFileSync(process.execPath, [cli, "package", "install", archive, "--project", "--json"], { cwd: root, env: commandEnv, stdio: "pipe" });
const bin = join(root, "bin"); mkdirSync(bin); symlinkSync(process.execPath, join(bin, "node"));
const identityTool = process.platform === "linux" ? "getconf" : "ps";
symlinkSync(execFileSync("/bin/sh", ["-c", `command -v ${identityTool}`], { encoding: "utf8" }).trim(), join(bin, identityTool)); commandEnv.PATH = bin;
/** Exercise the installed CLI with no Git executable, capturing bounded machine output. */
function command(args: string[]): string { return execFileSync(process.execPath, [cli, "rl", "eval", "plan", ...args], { cwd: root, env: commandEnv, encoding: "utf8" }); }
const client = new PmClient({ pmRoot: initialized.path, cwd: root, author: "evaluation-acceptance", noExtensions: true });
for (const name of ["Generation", "Run"]) await client.schemaAddType(name, { folder: `${name.toLowerCase()}s`, defaultStatus: "open" });
const seed: GenerationSpec = { base_checkpoint: "constant-open-policy", policy: "", collection_runs: [], training_config: {}, environment_version: "", reward_spec_version: "", parent: null, seed: true, promoted: false, approval: null, proxy_score: null, held_out_score: null, gap: null, promotion_evidence: null };
await client.create({ id: "rl-seed", type: "Generation", title: "Frozen baseline", body: `\`\`\`json\n${JSON.stringify(seed)}\n\`\`\``, affectedVersion: hashJson(generationProvenance(seed)) });
const snapshot = hashJson(items.map((item) => ({ id: item.id!, status: item.status! })));
const plan: EvaluationPlan = { format: "pm-rl/evaluation-plan/1", candidate: "rl-candidate", incumbent: "rl-seed", incumbent_version: hashJson(generationProvenance(seed)), population: `Public unbraind/pm-rl tracker at ${commit}`, selection: `Complete snapshot ${snapshot}; no outcome-based filtering`, correlation_unit: "repository (one fleet tracker; no cross-project independence assumed)",
  members: items.map((item) => ({ id: hashJson(String(item.id)), unit: "repository:unbraind/pm-rl" })), objective: "closed_status_accuracy", objective_version: "constant-closed-vs-constant-open/1", evaluation_context: snapshot, direction: "maximize", reward_bounds: [0, 1], criterion: { confidence: 0.95, minSamples: 10, effectThreshold: 0 }, stopping: { kind: "fixed", observations: items.length, independent_units: 1 } };
const planFile = join(root, "plan.json"); writeFileSync(planFile, JSON.stringify(plan));
const registration = JSON.parse(command(["register", "--file", planFile, "--json"])) as { id: string };
const declared = (await readEvaluationPlan(client, plan.candidate))!; assert.equal(registration.id, declared.id);
const toonBytes = Buffer.byteLength(command(["show", plan.candidate]));
await client.create({ id: "rl-collection", type: "Run", title: "Post-declaration collection" });
const candidate: GenerationSpec = { ...seed, evaluation_plan: declared.comparison, base_checkpoint: "constant-closed-policy", parent: "rl-seed", seed: false, policy: "constant-closed-policy", collection_runs: ["rl-collection"], environment_version: "training", reward_spec_version: "training-reward" };
await client.create({ id: "rl-candidate", type: "Generation", title: "Frozen candidate", body: `\`\`\`json\n${JSON.stringify(candidate)}\n\`\`\``, affectedVersion: hashJson(generationProvenance(candidate)) });
const observations = items.map((item) => ({ id: hashJson(String(item.id)), candidate: item.status === "closed" ? 1 : 0, incumbent: item.status === "closed" ? 0 : 1 }));
const observationsFile = join(root, "observations.json"); writeFileSync(observationsFile, JSON.stringify(observations));
const json = command(["evaluate", plan.candidate, "--file", observationsFile, "--json"]);
const report = (JSON.parse(json) as { details: EvaluationPlanReport }).details;
assert.ok(Buffer.byteLength(json) < 2000); assert.ok(toonBytes < 2000);
assert.equal(report.verdict.decision, "refuse");
assert.equal(report.comparison, evaluationComparison(plan));
const score: ScoreRecord = { objective: plan.objective, objective_version: plan.objective_version, evaluation_context: snapshot, direction: "maximize", scale: 1, seed_set: declared.comparison, value: report.candidate_mean };
await assert.rejects(enforceEvaluationPlan(client, "rl-candidate", score), (error: unknown) => isPmCliExpectedError(error) && error.context.code === "eval_plan_refused");
const shared = { objective: plan.objective, objective_version: plan.objective_version, evaluation_context: snapshot, direction: "maximize" as const, rewardBounds: plan.reward_bounds, samples: items.length };
const naive = decidePromotion({ candidate: { ...shared, generation: "rl-candidate", mean: report.candidate_mean }, incumbent: { ...shared, generation: "rl-seed", mean: report.incumbent_mean }, criterion: plan.criterion, contaminationPath: null, expectedGeneration: "rl-candidate" });
assert.equal(sourceDigest(source), before);
writeFileSync(output, JSON.stringify({ source: "https://github.com/unbraind/pm-rl", commit, snapshot, source_digest: before, source_unchanged: true, source_read_only: true, git_repository_required: false, cli_json_bytes: Buffer.byteLength(json), cli_toon_bytes: toonBytes, ...report, naive_episode_gate: naive.decision,
  policy: "Constant closed versus constant not-closed classification; descriptive replay only. One repository is one correlation unit, with no causal generalization or trainer improvement claim." }, null, 2) + "\n");
console.log(JSON.stringify({ observations: report.observations, independent_units: report.independent_units, candidate_mean: report.candidate_mean, incumbent_mean: report.incumbent_mean, decision: report.verdict.decision, naive_episode_gate: naive.decision, source_unchanged: true }));
