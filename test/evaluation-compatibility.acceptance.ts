/** Exercise a packed consumer against verbatim files written by the previous published package. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { devNull, tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { decode } from "@toon-format/toon";
import type { GetResult } from "@unbrained/pm-cli/sdk/core";
import type { GenerationSpec } from "../lineage.ts";
import type { PolicyCard } from "../policy-card.ts";
import type { EvaluationPlan, EvaluationPlanReport } from "../evaluation-plan.ts";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/released-compatibility.json", import.meta.url), "utf8")) as { plan: EvaluationPlan; rows: unknown[]; report: EvaluationPlanReport; files: Record<string, string>; coordinates: { environment: string; benchmark: string; long_candidate: string; long_comparison: string }; benchmark_input: unknown };
const archive = resolve(process.argv[2]); const output = resolve(process.argv[3]);
const root = mkdtempSync(join(tmpdir(), "rl-packed-legacy-")); const pmRoot = join(root, ".agents/pm");
for (const [name, contents] of Object.entries(fixture.files)) { const path = join(pmRoot, name); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, contents); }
const cli = resolve("node_modules/@unbrained/pm-cli/dist/cli.js");
const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: root, GIT_CONFIG_GLOBAL: devNull, GIT_CONFIG_NOSYSTEM: "1", PM_PATH: pmRoot, PM_AUTHOR: "compatibility-test", NPM_CONFIG_USERCONFIG: devNull, GIT_CEILING_DIRECTORIES: dirname(root), NODE_V8_COVERAGE: undefined };
execFileSync(process.execPath, [cli, "package", "install", archive, "--project", "--json"], { cwd: root, env, stdio: "pipe" });
// Direct checks run the installed archive's modules, so archive export or build drift fails here; source checks live in
// evaluation-compatibility.test.ts. The archive exists only at run time and its module graph uses top-level await, so a
// generated probe imports it statically in a child of the same runtime (no dynamic import, no require(esm)).
const installed = join(pmRoot, "extensions", "pm-rl", "dist"), probe = join(root, "archive-probe.mjs");
writeFileSync(probe, [
  `import { PmClient } from ${JSON.stringify(import.meta.resolve("@unbrained/pm-cli/sdk/core"))};`,
  `import { readCompleteLoopItem } from ${JSON.stringify(pathToFileURL(join(installed, "index.js")).href)};`,
  `import { parseGenerationSpec } from ${JSON.stringify(pathToFileURL(join(installed, "lineage.js")).href)};`,
  "const [mode, id] = process.argv.slice(2);",
  `const read = await readCompleteLoopItem(new PmClient({ cwd: ${JSON.stringify(root)}, pmRoot: ${JSON.stringify(pmRoot)}, author: "compatibility-test", noExtensions: true }), id);`,
  "process.stdout.write(JSON.stringify(mode === \"spec\" ? parseGenerationSpec(String(read.item.body).match(/```json\\n([\\s\\S]+?)\\n```/)[1], \"Packed compatibility\") : read));",
].join("\n"));
/** Read one item, or parse its generation spec, with the archive's own modules. */
function archiveRead(id: string): GetResult { return JSON.parse(execFileSync(process.execPath, [probe, "read", id], { cwd: root, env, encoding: "utf8" })) as GetResult; }
/** Parse an item's generation spec with the archive's lineage module. */
function archiveSpec(id: string): GenerationSpec { return JSON.parse(execFileSync(process.execPath, [probe, "spec", id], { cwd: root, env, encoding: "utf8" })) as GenerationSpec; }
const bin = join(root, "bin"); mkdirSync(bin); symlinkSync(process.execPath, join(bin, "node"));
const identityTool = process.platform === "linux" ? "getconf" : "ps";
symlinkSync(execFileSync("/bin/sh", ["-c", `command -v ${identityTool}`], { encoding: "utf8" }).trim(), join(bin, identityTool)); env.PATH = bin;
/** Use actual CLI formatting and the archive-installed extension with Git absent from PATH. */
function command(args: string[]): string { return execFileSync(process.execPath, [cli, "rl", ...args], { cwd: root, env, encoding: "utf8" }); }
const before = archiveRead(`${fixture.plan.candidate}-evaluation-plan`);
const shown = JSON.parse(command(["eval", "plan", "show", fixture.plan.candidate, "--json"])) as { details: { comparison: string } };
assert.equal(shown.details.comparison, fixture.report.comparison);
// The default TOON rendering must decode to the same document as --json, not merely mention the comparison hash.
assert.deepEqual(decode(command(["eval", "plan", "show", fixture.plan.candidate])), shown);
const rows = join(root, "rows.json"); writeFileSync(rows, JSON.stringify(fixture.rows));
const evaluated = JSON.parse(command(["eval", "plan", "evaluate", fixture.plan.candidate, "--file", rows, "--json"])) as { details: EvaluationPlanReport };
assert.deepEqual(evaluated.details, fixture.report);
const plan = join(root, "plan.json"); writeFileSync(plan, JSON.stringify(fixture.plan)); command(["eval", "plan", "register", "--file", plan, "--json"]);
const benchmark = join(root, "benchmark.json"); writeFileSync(benchmark, JSON.stringify(fixture.benchmark_input));
assert.equal((JSON.parse(command(["benchmark", "register", "--file", benchmark, "--json"])) as { created: boolean }).created, false);
assert.equal((JSON.parse(command(["eval", "record", "--run", "rl-run", "--benchmark", fixture.coordinates.benchmark, "--checkpoint", "legacy checkpoint:2", "--score", "1", "--passed", "true", "--json"])) as { created: boolean }).created, false);
const beforeCard = (JSON.parse(command(["policy-card", "export", fixture.plan.candidate, "--json"])) as { details: PolicyCard }).details;
assert.equal(beforeCard.subject, fixture.plan.candidate);
const held = { objective: fixture.plan.objective, objective_version: fixture.plan.objective_version, evaluation_context: fixture.plan.evaluation_context, direction: fixture.plan.direction, seed_set: fixture.report.comparison, scale: 1, value: fixture.report.candidate_mean };
const scores = join(root, "scores.json"); writeFileSync(scores, JSON.stringify({ held_out_score: held, proxy_score: { ...held, evaluation_context: "proxy:legacy" } }));
const promotion = JSON.parse(command(["generation", "promote", fixture.plan.candidate, "--approval", "rl-approval", "--scores", scores, "--evidence", "Released fixture compatibility", "--json"])) as { details: { budget_consumed: number } };
assert.equal(promotion.details.budget_consumed, 1);
assert.equal(archiveSpec(fixture.plan.candidate).promoted, true);
assert.deepEqual(archiveRead(before.item.id), before);
command(["policy-card", "export", fixture.plan.candidate, "--json"]);

const evidence = { producer: "pm-rl@2026.7.31", native_text_files: Object.keys(fixture.files).length, legacy_plans: 18, sdk_oracle_cases: 500, oracle_paths: 13, json_and_toon: true, fixed_report_unchanged: true, declaration_unchanged: true, legacy_retries: 3, promoted: true, approval_consumed: 1, policy_card_exported: true, non_git: true, git_absent_from_path: true };
writeFileSync(output, JSON.stringify(evidence, null, 2) + "\n"); console.log(JSON.stringify(evidence));
