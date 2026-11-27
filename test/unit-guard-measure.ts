#!/usr/bin/env node
/**
 * Reproducible masking and token-savings measurement for the per-unit
 * regression guard (`pm-rl-unit-guard`).
 *
 * One command builds the package, packs it, installs that exact archive into a
 * fresh non-git scratch tracker, and replays the seeded synthetic study
 * (seed 42: 32 downstream workflows, two paired observations each, one
 * workflow regressing) through BOTH surfaces:
 *
 * - the SDK: plan registration, sealed evaluation and the promotion gate
 *   (`registerEvaluationPlan`, `recordPlanEvaluation`, `enforceEvaluationPlan`);
 * - the CLI: the real `pm` binary with the packed `pm-rl` package providing
 *   `rl eval plan register/evaluate` and `rl generation promote`, in JSON and
 *   TOON renderings.
 *
 * It then measures two things and prints one JSON object on stdout:
 *
 * 1. Masking. The aggregate-only comparison promotes a candidate whose mean
 *    improves while one declared workflow unit regresses; the sealed
 *    `max_unit_regression` guard refuses that same promotion in both objective
 *    directions, and an equivalent 32-cohort protection refuses too.
 * 2. Context savings, counted with the pinned `js-tiktoken` `o200k_base`
 *    tokenizer over the exact minified JSON an agent would read: the compact
 *    typed refusal (unit, both scores, bound, remedy) versus reading the raw
 *    sealed plan plus all 64 raw observations, and the per-unit guard versus
 *    the equivalent protected-cohort declaration.
 *
 * Nothing outside the scratch directory is written. The approval Decision
 * permits exactly one promotion; every guard refusal happens before the budget
 * mutation and the one passing candidate consumes the allowance.
 *
 * @example
 * ```bash
 * node test/unit-guard-measure.ts
 * ```
 */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { getEncoding } from "js-tiktoken";
import { PmClient } from "@unbrained/pm-cli/sdk/core";
import { init, isPmCliExpectedError } from "@unbrained/pm-cli/sdk/runtime";
import { generationProvenance, hashJson, type RlCommandResult } from "../index.ts";
import { evaluatePlan, enforceEvaluationPlan, registerEvaluationPlan, recordPlanEvaluation, type EvaluationPlan, type EvaluationPlanReport, type EvaluationObservation } from "../evaluation-plan.ts";
import type { GenerationSpec, ScoreRecord } from "../lineage.ts";
import { unitGuardStudy } from "./fixtures/unit-guard-study.ts";
import { identityPath } from "./fixtures/identity-path.ts";

const repoRoot = resolve(import.meta.dirname, "..");
const tokenizer = getEncoding("o200k_base");
/** Count context tokens exactly as the pinned o200k_base tokenizer does. */
function tokens(text: string): number { return tokenizer.encode(text).length; }
/** Run one build/pack step quietly, forwarding output only on failure. */
function step(command: string, args: readonly string[]): string {
  const result = spawnSync(command, args, { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, NPM_CONFIG_USERCONFIG: "/dev/null", npm_config_userconfig: "/dev/null" } });
  if (result.status !== 0) { process.stderr.write(`${result.stdout ?? ""}${result.stderr ?? ""}`); throw new Error(`${command} ${args.join(" ")} failed with status ${result.status}`); }
  return result.stdout ?? "";
}
const scratch = mkdtempSync(join(tmpdir(), "rl-unit-guard-measure-"));
const archiveDirectory = join(scratch, "archive");
try {
  step("npm", ["run", "build"]);
  mkdirSync(archiveDirectory);
  const archiveName = step("npm", ["pack", "--ignore-scripts", "--pack-destination", archiveDirectory, "--quiet"]).trim().split("\n").at(-1)!.trim();
  const archive = join(archiveDirectory, archiveName);
  const tracker = await init("rl", { defaults: true, author: "unit-guard-measure", agentGuidance: "skip" }, { cwd: scratch, pmRoot: join(scratch, ".agents/pm") });
  const commandEnv: NodeJS.ProcessEnv = { ...process.env, PM_PATH: tracker.path, PM_AUTHOR: "unit-guard-measure", GIT_CEILING_DIRECTORIES: scratch, NPM_CONFIG_USERCONFIG: "/dev/null", npm_config_userconfig: "/dev/null" };
  for (const key of Object.keys(commandEnv)) if (/token|secret|password|credential|api_?key|NPM_MEDIA_SERVER/i.test(key)) delete commandEnv[key];
  commandEnv.PATH = identityPath(scratch);
  const launcher = [process.execPath, resolve(repoRoot, "node_modules/@unbrained/pm-cli/dist/cli.js")] as const;
  /** Execute the real installed CLI entrypoint; all durable output stays in the scratch project. */
  function command(args: readonly string[]): string { return execFileSync(launcher[0], [...launcher.slice(1), ...args], { cwd: scratch, env: commandEnv, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }); }
  /** Capture a CLI refusal without failing the measurement run. */
  function refusal(args: readonly string[]): string {
    try { command(args); assert.fail(`CLI ${args.join(" ")} unexpectedly succeeded`); }
    catch (error) { const failure = error as { status?: number; stdout?: string; stderr?: string }; assert.notEqual(failure.status, 0); return `${failure.stdout ?? ""}${failure.stderr ?? ""}`.trim(); }
  }
  function file(name: string, value: unknown): string { const path = join(scratch, name); writeFileSync(path, JSON.stringify(value)); return path; }
  command(["package", "install", archive, "--project", "--json"]);
  const client = new PmClient({ cwd: scratch, pmRoot: tracker.path, author: "unit-guard-measure", noExtensions: true });
  for (const name of ["Generation", "Run"]) await client.schemaAddType(name, { folder: `${name.toLowerCase()}s`, defaultStatus: "open" });
  const spec: GenerationSpec = { base_checkpoint: "active-policy", policy: "", collection_runs: [], training_config: {}, environment_version: "", reward_spec_version: "", parent: null, seed: true, promoted: false, approval: null, proxy_score: null, held_out_score: null, gap: null, promotion_evidence: null };
  await client.create({ id: "rl-seed", title: "Baseline", type: "Generation", body: `\`\`\`json\n${JSON.stringify(spec)}\n\`\`\``, affectedVersion: hashJson(generationProvenance(spec)), unset: ["parent"] });
  const study = unitGuardStudy(hashJson(generationProvenance(spec)));
  const observations = study.observations as EvaluationObservation[];
  const mirrored: EvaluationObservation[] = observations.map((row) => ({ id: row.id, candidate: row.incumbent, incumbent: row.candidate }));
  const plans: Record<string, EvaluationPlan> = {
    "rl-aggregate": { ...study.aggregate, candidate: "rl-aggregate" },
    "rl-guarded": { ...study.guarded, candidate: "rl-guarded" },
    "rl-cohort": { ...study.expanded, candidate: "rl-cohort" },
    "rl-guarded-min": { ...study.guarded, candidate: "rl-guarded-min", direction: "minimize" },
  };
  const environment = (JSON.parse(command(["rl", "env", "register", "--file", file("env.json", { name: "Synthetic training", version: "1", task_suite: ["train"], reward_specification: { reward: 1 } }), "--json"])) as RlCommandResult).id!;
  await client.create({ id: "rl-approval", type: "Decision", title: "One synthetic promotion", body: '```json\n{"permitted_promotions":1}\n```', unset: ["parent"] });
  const reports: Record<string, EvaluationPlanReport> = {};
  const comparisons: Record<string, unknown> = {};
  const declarations: Record<string, string> = {};
  const cliBytes: Record<string, number> = {};
  for (const [candidate, plan] of Object.entries(plans)) {
    const rows = candidate === "rl-guarded-min" ? mirrored : observations;
    declarations[candidate] = JSON.stringify(plan);
    const registered = JSON.parse(command(["rl", "eval", "plan", "register", "--file", file(`${candidate}-plan.json`, plan), "--json"])) as RlCommandResult;
    assert.equal(registered.details?.max_unit_regression, plan.max_unit_regression ?? undefined);
    comparisons[candidate] = registered.details?.comparison;
    assert.equal((JSON.parse(command(["rl", "eval", "plan", "show", candidate, "--json"])) as RlCommandResult).details?.max_unit_regression, plan.max_unit_regression ?? undefined);
    const run = `${candidate}-collection`;
    command(["rl", "run", "start", run, "--environment", environment, "--algorithm", "bandit", "--json"]);
    command(["rl", "generation", "register", candidate, "--base-checkpoint", "candidate", "--parent", "rl-seed", "--policy", "candidate", "--collection-runs", run, "--environment", environment, "--json"]);
    const evaluate = ["rl", "eval", "plan", "evaluate", candidate, "--file", file(`${candidate}-observations.json`, rows)] as const;
    const json = command([...evaluate, "--json"]);
    const toon = command([...evaluate]);
    const report = (JSON.parse(json) as { details: EvaluationPlanReport }).details;
    assert.deepEqual(report, await recordPlanEvaluation(client, candidate, rows));
    assert.deepEqual(report, evaluatePlan(plan, rows));
    reports[candidate] = report;
    if (candidate === "rl-guarded") { cliBytes.evaluate_json = Buffer.byteLength(json); cliBytes.evaluate_toon = Buffer.byteLength(toon); }
    // The SDK registration boundary refuses an edited guard bound for the same candidate.
    await assert.rejects(registerEvaluationPlan(client, { ...plan, max_unit_regression: 1 - (plan.max_unit_regression ?? 0) }), (error: unknown) => isPmCliExpectedError(error) && error.context.code === "eval_plan_drift");
  }
  /** A score binds the exact measured mean and comparison to the sealed plan, as promotion requires. */
  function score(plan: EvaluationPlan, report: EvaluationPlanReport): ScoreRecord { return { objective: plan.objective, objective_version: plan.objective_version, evaluation_context: plan.evaluation_context, direction: plan.direction, seed_set: report.comparison, scale: plan.reward_bounds[1] - plan.reward_bounds[0], value: report.candidate_mean }; }
  const promote = (candidate: string): string => command(["rl", "generation", "promote", candidate, "--approval", "rl-approval", "--scores", file(`${candidate}-scores.json`, { held_out_score: score(plans[candidate], reports[candidate]), proxy_score: { ...score(plans[candidate], reports[candidate]), evaluation_context: "proxy" } }), "--evidence", "Sealed downstream workflow comparison", "--json"]);
  const guardedRefusal = refusal(["rl", "generation", "promote", "rl-guarded", "--approval", "rl-approval", "--scores", file("rl-guarded-scores.json", { held_out_score: score(plans["rl-guarded"], reports["rl-guarded"]), proxy_score: { ...score(plans["rl-guarded"], reports["rl-guarded"]), evaluation_context: "proxy" } }), "--evidence", "Sealed downstream workflow comparison"]);
  const minRefusal = refusal(["rl", "generation", "promote", "rl-guarded-min", "--approval", "rl-approval", "--scores", file("rl-guarded-min-scores.json", { held_out_score: score(plans["rl-guarded-min"], reports["rl-guarded-min"]), proxy_score: { ...score(plans["rl-guarded-min"], reports["rl-guarded-min"]), evaluation_context: "proxy" } }), "--evidence", "Sealed downstream workflow comparison"]);
  const cohortRefusal = refusal(["rl", "generation", "promote", "rl-cohort", "--approval", "rl-approval", "--scores", file("rl-cohort-scores.json", { held_out_score: score(plans["rl-cohort"], reports["rl-cohort"]), proxy_score: { ...score(plans["rl-cohort"], reports["rl-cohort"]), evaluation_context: "proxy" } }), "--evidence", "Sealed downstream workflow comparison"]);
  assert.match(guardedRefusal, new RegExp(`Correlation unit ${study.regressed} regressed beyond its declared bound: candidate mean 0, incumbent mean 1, bound 0, 1 unit\\(s\\) in breach\\.`));
  assert.match(minRefusal, new RegExp(`Correlation unit ${study.regressed} regressed beyond its declared bound: candidate mean 1, incumbent mean 0, bound 0, 1 unit\\(s\\) in breach\\.`));
  assert.match(cohortRefusal, /eval_cohort_regression/);
  const promotion = JSON.parse(promote("rl-aggregate")) as RlCommandResult;
  assert.equal(promotion.details?.budget_consumed, 1);
  // The SDK gate passes the masked aggregate and refuses the guarded promotions with the same witness.
  await enforceEvaluationPlan(client, "rl-aggregate", score(plans["rl-aggregate"], reports["rl-aggregate"]));
  for (const guarded of ["rl-guarded", "rl-guarded-min"]) {
    await assert.rejects(enforceEvaluationPlan(client, guarded, score(plans[guarded], reports[guarded])), (error: unknown) => isPmCliExpectedError(error) && error.context.code === "eval_unit_regression" && error.message.includes(`Correlation unit ${study.regressed} regressed`));
  }
  const guard = reports["rl-guarded"].unit_guard!;
  // The render's recovery bundle echoes the command line (scratch paths), so the
  // measurement extracts the complete typed refusal message the CLI prints under "What happened".
  const compactRefusal = /What happened:\n\s+(Evaluation plan refused \(eval_unit_regression\)\.[\s\S]*?reviewed stopping protocol\.)/.exec(guardedRefusal)?.[1];
  assert.ok(compactRefusal !== undefined, "the CLI must render the complete typed refusal in one call");
  const refusalTokens = tokens(compactRefusal);
  // Count only plans exactly as sealed for this replay, refusing any lookalike fixture plan.
  function sealedTokens(candidate: string): number {
    const plan = plans[candidate];
    assert.equal(evaluatePlan(plan, candidate === "rl-guarded-min" ? mirrored : observations).comparison, comparisons[candidate], `measured plan must be the sealed plan for ${candidate}`);
    assert.equal(declarations[candidate], JSON.stringify(plan), `measured declaration must be the registered file for ${candidate}`);
    return tokens(declarations[candidate]);
  }
  const rawPlanTokens = sealedTokens("rl-guarded");
  const rawObservationsTokens = tokens(JSON.stringify(observations));
  const rawTokens = rawPlanTokens + rawObservationsTokens;
  const equivalent = (candidate: string, report: EvaluationPlanReport): { plan_tokens: number; report_tokens: number; verdict: string } => ({ plan_tokens: sealedTokens(candidate), report_tokens: tokens(JSON.stringify(report)), verdict: report.verdict.decision });
  const aggregate = equivalent("rl-aggregate", reports["rl-aggregate"]);
  const guarded = equivalent("rl-guarded", reports["rl-guarded"]);
  const cohort = equivalent("rl-cohort", reports["rl-cohort"]);
  assert.equal(reports["rl-aggregate"].verdict.decision, "promote");
  assert.ok(Math.abs(reports["rl-aggregate"].candidate_mean - 0.96875) < 1e-9);
  assert.equal(reports["rl-guarded"].aggregate_verdict?.decision, "promote");
  assert.equal(reports["rl-guarded-min"].aggregate_verdict?.decision, "promote");
  const equivalentSavings = (cohort.plan_tokens + cohort.report_tokens) - (guarded.plan_tokens + guarded.report_tokens);
  const measurement = {
    study: { seed: 42, correlation_unit: "workflow", workflows: 32, observations: observations.length, regressed_unit: study.regressed, reward_bounds: [0, 1] as const, tokenizer: "js-tiktoken o200k_base" },
    masking: [
      { direction: "maximize", aggregate_verdict: reports["rl-aggregate"].verdict.decision, candidate_mean: reports["rl-aggregate"].candidate_mean, incumbent_mean: reports["rl-aggregate"].incumbent_mean, guard: { worst_unit: guard.worst_unit, candidate_mean: guard.candidate_mean, incumbent_mean: guard.incumbent_mean, max_regression: guard.max_regression, violations: guard.violations }, sdk_refusal: "eval_unit_regression", cli_refusal: "eval_unit_regression" },
      { direction: "minimize", aggregate_verdict: reports["rl-guarded-min"].aggregate_verdict?.decision, candidate_mean: reports["rl-guarded-min"].candidate_mean, incumbent_mean: reports["rl-guarded-min"].incumbent_mean, guard: { worst_unit: reports["rl-guarded-min"].unit_guard!.worst_unit, candidate_mean: reports["rl-guarded-min"].unit_guard!.candidate_mean, incumbent_mean: reports["rl-guarded-min"].unit_guard!.incumbent_mean, max_regression: reports["rl-guarded-min"].unit_guard!.max_regression, violations: reports["rl-guarded-min"].unit_guard!.violations }, sdk_refusal: "eval_unit_regression", cli_refusal: "eval_unit_regression" },
    ],
    approval: { permitted_promotions: 1, consumed: promotion.details?.budget_consumed, refused_before_consumption: 3 },
    equivalent_plans: { "aggregate-only": aggregate, "per-unit-guard": guarded, "32-protected-cohorts": cohort, saved_tokens: equivalentSavings, saved_fraction: Number((equivalentSavings / (cohort.plan_tokens + cohort.report_tokens)).toFixed(4)) },
    refusal_versus_raw_evaluations: { refusal_tokens: refusalTokens, refusal_bytes: Buffer.byteLength(compactRefusal), raw_plan_tokens: rawPlanTokens, raw_observations_tokens: rawObservationsTokens, saved_tokens: rawTokens - refusalTokens, saved_fraction: Number(((rawTokens - refusalTokens) / rawTokens).toFixed(4)) },
    cli_output_bytes: { ...cliBytes, promote_refusal_render: Buffer.byteLength(guardedRefusal) },
    surfaces: { sdk: "PmClient registerEvaluationPlan/recordPlanEvaluation/enforceEvaluationPlan on the scratch tracker", cli: "packed pm-rl archive through the pm CLI (JSON and TOON)" },
    inference_calls: 0,
  };
  assert.ok(measurement.equivalent_plans.saved_tokens > 0);
  assert.ok(measurement.refusal_versus_raw_evaluations.saved_tokens > 0);
  console.log(JSON.stringify(measurement, null, 2));
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
