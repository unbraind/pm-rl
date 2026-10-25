/** Public-tracker acceptance with aggregate-only receipts and an independently read-only source. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync, mkdirSync, symlinkSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { tmpdir } from "node:os";
import { PmClient } from "@unbrained/pm-cli/sdk/core";
import { init, isPmCliExpectedError } from "@unbrained/pm-cli/sdk/runtime";
import { generationProvenance, hashJson, type JsonValue } from "../index.ts";
import { readEvaluationPlan, enforceEvaluationPlan, type EvaluationPlan } from "../evaluation-plan.ts";
import { shadowInputDigest, observeShadow, compareShadow, type ShadowDeployment } from "../shadow.ts";
import type { GenerationSpec, ScoreRecord } from "../lineage.ts";

/** Fingerprint every supplied source file and require read-only modes throughout. */
function fingerprint(root: string): { digest: string; files: number } {
  const digest = createHash("sha256"); let files = 0;
  /** Traverse only this explicitly selected public tracker copy. */
  function walk(relative: string): void {
    for (const entry of readdirSync(join(root, relative), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const key = join(relative, entry.name); const file = join(root, key); assert.equal(statSync(file).mode & 0o222, 0);
      if (entry.isDirectory()) walk(key); else { assert.ok(entry.isFile()); files += 1; digest.update(JSON.stringify(key)); digest.update(readFileSync(file)); }
    }
  }
  walk(""); return { digest: digest.digest("hex"), files };
}
const [source, output, commit, archive] = process.argv.slice(2).map((value) => value);
assert.match(commit, /^[a-f0-9]{40}$/); const before = fingerprint(source);
const sourceClient = new PmClient({ pmRoot: source, noExtensions: true });
const corpus = (await sourceClient.listAllComplete({ includeBody: false })).items;
const selected = [...corpus].sort((a, b) => String(a.id).localeCompare(String(b.id))).slice(0, 20);
assert.equal(selected.length, 20);
const root = mkdtempSync(join(tmpdir(), "shadow-acceptance-")); const cli = resolve("node_modules/@unbrained/pm-cli/dist/cli.js");
const initialized = await init("rl", { defaults: true, author: "shadow-acceptance", agentGuidance: "skip" }, { cwd: root });
const commandEnv: NodeJS.ProcessEnv = { ...process.env, PM_PATH: initialized.path, PM_AUTHOR: "shadow-acceptance", GIT_CEILING_DIRECTORIES: dirname(root) };
execFileSync(process.execPath, [cli, "package", "install", resolve(archive), "--project", "--json"], { cwd: root, env: commandEnv, stdio: "pipe" });
const bin = join(root, "bin"); mkdirSync(bin); symlinkSync(process.execPath, join(bin, "node")); commandEnv.PATH = bin;
process.env.GIT_CEILING_DIRECTORIES = dirname(root); process.env.PATH = bin;
const client = new PmClient({ pmRoot: initialized.path, author: "shadow-acceptance", noExtensions: true });
for (const name of ["Generation", "Run"]) await client.schemaAddType(name, { folder: `${name.toLowerCase()}s`, defaultStatus: "open" });
const active = { event: "open" }; const candidate = { event: "closed" };
const seed: GenerationSpec = { base_checkpoint: "active-policy", policy: "", collection_runs: [], training_config: { shadow_policy: hashJson(active) }, environment_version: "", reward_spec_version: "", parent: null, seed: true, promoted: false, approval: null, proxy_score: null, held_out_score: null, gap: null, promotion_evidence: null };
await client.create({ id: "rl-seed", type: "Generation", title: "Active routing baseline", body: `\`\`\`json\n${JSON.stringify(seed)}\n\`\`\``, affectedVersion: hashJson(generationProvenance(seed)) });
const inputs = Object.fromEntries(selected.map((item) => [hashJson(String(item.id)), shadowInputDigest("event")]));
const deployment: ShadowDeployment = { format: "pm-rl/shadow/1", consent: "rl-consent", generation: "rl-candidate", incumbent: "rl-seed", active, candidate, inputs, budget: { active_calls: selected.length, candidate_calls: selected.length } };
await client.create({ id: "rl-consent", type: "Decision", title: "Public input shadow consent", body: JSON.stringify({ format: "pm-rl/shadow-consent/1", deployment: hashJson(deployment as unknown as JsonValue) }) });
const plan: EvaluationPlan = { format: "pm-rl/evaluation-plan/1", candidate: "rl-candidate", incumbent: "rl-seed", incumbent_version: hashJson(generationProvenance(seed)), population: `Public unbraind/pm-context tracker at ${commit}`, selection: "First 20 item ids in sorted complete snapshot; no outcome filtering", correlation_unit: "public repository", members: Object.keys(inputs).map((id) => ({ id, unit: "public-repository" })), objective: "closed_status_accuracy", objective_version: "constant-classifiers/1", evaluation_context: hashJson(selected.map((item) => ({ id: item.id, status: item.status })) as JsonValue), direction: "maximize", reward_bounds: [0, 1], criterion: { confidence: 0.95, minSamples: 10, effectThreshold: 0.01 }, stopping: { kind: "fixed", observations: selected.length, independent_units: 1 } };
const config = join(root, "deployment.json"); writeFileSync(config, JSON.stringify({ deployment, plan }));
/** Invoke the packed command surface in a plain tracker with no Git executable. */
function command(args: string[]): string { return execFileSync(process.execPath, [cli, "rl", "shadow", ...args], { cwd: root, env: commandEnv, encoding: "utf8" }); }
const registered = JSON.parse(command(["register", "--file", config, "--json"])) as { details: { reserved_calls: number } };
assert.equal(registered.details.reserved_calls, 40);
await client.create({ id: "rl-collection", type: "Run", title: "Post-declaration collection" });
const reservation = (await readEvaluationPlan(client, "rl-candidate"))!;
const successor: GenerationSpec = { ...seed, seed: false, parent: "rl-seed", policy: "collection-policy", collection_runs: ["rl-collection"], environment_version: "train-env", reward_spec_version: "reward", training_config: { shadow_policy: hashJson(candidate) }, evaluation_plan: reservation.comparison };
await client.create({ id: "rl-candidate", type: "Generation", title: "Shadow candidate", body: `\`\`\`json\n${JSON.stringify(successor)}\n\`\`\``, affectedVersion: hashJson(generationProvenance(successor)) });
let closed = 0; let unchangedActive = 0; let jsonBytes = 0;
for (const [i, item] of selected.entries()) {
  const isClosed = item.status === "closed"; if (isClosed) closed += 1;
  const value = { id: hashJson(String(item.id)), input: "event", rewards: { open: isClosed ? 0 : 1, closed: isClosed ? 1 : 0 } };
  const observed = await observeShadow(client, "rl-candidate", value); if (observed.active_action === "open") unchangedActive += 1;
  if (i === 0) {
    const inputFile = join(root, "input.json"); writeFileSync(inputFile, JSON.stringify(value));
    const serialized = command(["observe", "rl-candidate", "--file", inputFile, "--json"]); jsonBytes = Buffer.byteLength(serialized); assert.match(serialized, /active_action/);
  }
}
const report = await compareShadow(client, "rl-candidate"); const cliJson = command(["compare", "rl-candidate", "--json"]); const toon = command(["compare", "rl-candidate"]);
assert.equal(report.candidate_failures, 0); assert.equal(report.observations, 20); assert.equal(report.outcome?.independent_units, 1); assert.equal(report.outcome?.verdict.decision, "refuse");
const score: ScoreRecord = { objective: plan.objective, objective_version: plan.objective_version, evaluation_context: plan.evaluation_context, seed_set: reservation.comparison, direction: "maximize", scale: 1, value: report.outcome!.candidate_mean };
let code = "";
try { await enforceEvaluationPlan(client, "rl-candidate", score); assert.fail("Single tracker must not authorize deployment"); } catch (error) { assert.ok(isPmCliExpectedError(error)); code = String(error.context.code); assert.equal(code, "eval_plan_refused"); }
assert.deepEqual(fingerprint(source), before); assert.equal(unchangedActive, 20);
writeFileSync(output, `${JSON.stringify({ format: "pm-rl/shadow-evidence/1", source: { repository: "unbraind/pm-context", commit, license: "MIT", tracker_files: before.files, digest_before: before.digest, digest_after: before.digest }, complete_items: corpus.length, selected_items: selected.length, closed_items: closed, open_or_other_items: selected.length - closed, active_actions_preserved: unchangedActive, observations: report.observations, disagreements: report.disagreements, candidate_failures: report.candidate_failures, reserved_calls: registered.details.reserved_calls, charged: report.charged, independent_units: report.outcome?.independent_units, active_mean: report.outcome?.incumbent_mean, candidate_mean: report.outcome?.candidate_mean, promotion_refusal: code, promotion_performed: false, non_git: true, git_absent_from_path: true, output_bytes: { observation_json: jsonBytes, comparison_json: Buffer.byteLength(cliJson), comparison_toon: Buffer.byteLength(toon) } }, null, 2)}\n`);
