/** Read one public tracker copy and retain descriptive causal-protocol evidence without changing its records. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { PmClient } from "@unbrained/pm-cli/sdk/core";
import { runWithWorkspaceRecipe, PM_WORKSPACE_RECIPE_SCHEMA } from "@unbrained/pm-cli/sdk";
import { evaluationComparison } from "../evaluation-plan.ts";
import { readSequentialEvaluation } from "../sequential-evaluation.ts";
import { causalWorkspace, causalStep } from "./fixtures/causal-evaluation.ts";

/** Hash authoritative public records only; SDK read caches are derived, disposable state. */
function trackerDigest(root: string): string {
  const hash = createHash("sha256");
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(directory, entry.name);
      if (entry.isDirectory() && !["runtime", "locks", "search", "transactions"].includes(entry.name)) visit(path);
      if (entry.isFile() && /\.(toon|jsonl|json)$/.test(entry.name)) hash.update(relative(root, path)).update(readFileSync(path));
    }
  };
  visit(root); return hash.digest("hex");
}
const acceptanceCwd = process.cwd();
const source = process.argv[2]; const commit = process.argv[3];
assert.match(commit, /^[a-f0-9]{40}$/);
const before = trackerDigest(source);
const client = new PmClient({ pmRoot: source, author: "public-replay", noExtensions: true });
const items = (await client.listAllComplete({ includeBody: false })).items.sort((a, b) => a.id.localeCompare(b.id)).slice(0, 64);
assert.equal(items.length, 64);
const w = await causalWorkspace();
try {
  w.plan = { ...w.plan, population: "Public pm-rl tracker snapshot", selection: "First 64 canonical item IDs", correlation_unit: "repository", members: items.map(item => ({ id: item.id, unit: "repository" })), criterion: { ...w.plan.criterion, minSamples: 1 }, stopping: { kind: "sequential", method: "hoeffding-alpha-spending/1", observations: 64, independent_units: 1, unit_order: ["repository"], looks: [1], review: "rl-review" } };
  w.rows = items.map(item => ({ id: item.id, candidate: item.status === "closed" ? 1 : 0, incumbent: 0.5 }));
  const clocks = [2032, 2031, 2030, 2029, 2028];
  for (const [i, step] of ["review", "plan", "run", "candidate", "last"].entries()) await runWithWorkspaceRecipe({ schema: PM_WORKSPACE_RECIPE_SCHEMA, seed: step, clock: `${clocks[i]}-01-01T00:00:00.000Z`, tickMs: 0, operations: [] }, () => causalStep(w, step));
  const report = await readSequentialEvaluation(w.client, w.plan.candidate);
  assert.ok(report !== null && !("status" in report));
  assert.equal(report.verdict.decision, "refuse");
  assert.equal(trackerDigest(source), before);
  writeFileSync("docs/evaluation-lifecycle-evidence.json", JSON.stringify({ format: "pm-rl/evaluation-lifecycle-evidence/1", source: { repository: "https://github.com/unbraind/pm-rl", commit, authoritative_digest: before, unchanged: true }, records: items.length, correlation_units: 1, measurement: "Descriptive closed-item fraction against constant 0.5; no trained policy or causal effect claim", clock_years: clocks, comparison: evaluationComparison(w.plan), report: { observations: report.observations, independent_units: report.independent_units, candidate_mean: report.candidate_mean, incumbent_mean: report.incumbent_mean, state: report.sequential!.state, verdict: report.verdict.decision }, non_git_target: true }, null, 2) + "\n");
} finally { process.chdir(acceptanceCwd); rmSync(w.root, { recursive: true, force: true }); }
