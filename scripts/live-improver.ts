/** Opt-in public-tracker acceptance with a 20-minute process watchdog and scratch-only source copies. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { PmClient } from "@unbrained/pm-cli/sdk/core";
import { init } from "@unbrained/pm-cli/sdk/runtime";
import { hashJson, type JsonValue } from "../index.ts";
import { buildImproverDataset } from "../improver-data.ts";
import type { TrackerBuildOptions } from "../dataset.ts";
import { IMPROVER_ADAPTER } from "../improver-environment.ts";
import { improverBudget, improverConfiguration, summarizeImproverScores, type ImproverConfig, type ImproverReport } from "../recursive-improver.ts";
import { listProcessJobs } from "../process.ts";
import { streamProcess } from "./audit-git-identities.ts";
import { isMainInvocation } from "./script-launcher.ts";

/** Copy only declared public source snapshots; all Git writes and checkouts belong to disposable clones. */
export function copyImproverSources(fleet: string, scratch: string, pins: readonly { readonly repo: string; readonly commit: string }[]): string[] {
  mkdirSync(scratch, { recursive: true });
  return pins.map((pin) => {
    assert.match(pin.repo, /^[\w-]+\/pm-[\w-]+$/); assert.match(pin.commit, /^[a-f0-9]{40}$/);
    const name = pin.repo.split("/")[1]; const copy = join(scratch, name);
    execFileSync("git", ["clone", "--quiet", "--shared", "--no-checkout", join(fleet, name), copy], { timeout: 30_000, stdio: "pipe" });
    execFileSync("git", ["remote", "set-url", "origin", `https://github.com/${pin.repo}.git`], { cwd: copy, stdio: "pipe" });
    execFileSync("git", ["checkout", "--quiet", pin.commit, "--", ".agents/pm"], { cwd: copy, timeout: 30_000, stdio: "pipe" });
    return join(copy, ".agents/pm");
  });
}

/** Fix eligible source identities from the sealed public corpus, independently of fitted or promoted scores. */
export function improverLivePins(pinsFile = resolve(import.meta.dirname, "../docs/meta-live-evidence.json")): NonNullable<TrackerBuildOptions["pins"]> {
  const corpus = (JSON.parse(readFileSync(pinsFile, "utf8")) as { dataset: { sources: NonNullable<TrackerBuildOptions["pins"]> } }).dataset.sources;
  const cohort = ["unbraind/pm-csv", "unbraind/pm-beads", "unbraind/pm-rl", "unbraind/pm-starter"];
  return cohort.map((repo) => { const pin = corpus.find((source) => source.repo === repo); assert.ok(pin !== undefined, "improver_live_pin"); return pin; });
}

/** One proposal per task leaves runtime headroom for durable fits on the shared CPU host. */
export function liveImproverConfiguration(): ImproverConfig { return { ...improverConfiguration(), candidates: 1 }; }

/** Resolve the explicit live-only input without opening any source tracker during ordinary test imports. */
export function improverLiveRoot(environment: NodeJS.ProcessEnv): string { return environment["PM_RL_TRACKER_ROOT"] ?? resolve(import.meta.dirname, "../../..", "fleet"); }

/** Reproduce the sealed corpus through the packed CLI; explicit synthetic pins/config also exercise this exact path in CI. */
export async function liveImproverWorker(fleet: string, pins = improverLivePins(), config = liveImproverConfiguration()): Promise<void> {
  const started = performance.now(); const repo = resolve(import.meta.dirname, "..");
  process.stdout.write("Preparing pinned public tracker tasks.\n");
  const parent = join(repo, ".agents/pm/runtime/improver"); mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, "run-"));
  const implementation = Object.fromEntries(["improver.ts", "improver-data.ts", "improver-environment.ts", "recursive-improver.ts", "prefix.ts", "prefix-trainer.ts", "process.ts", "promotion.ts", "index.ts"].map((file) => [file, hashJson(readFileSync(join(repo, file), "utf8"))]));
  const directories = copyImproverSources(fleet, join(root, "sources"), pins);
  const manifest = buildImproverDataset(directories, join(root, "dataset"), 42, { pins });
  const budget = improverBudget(manifest, config);
  const spec = { permitted_promotions: budget.fits + config.generations,
    resource_budget: Object.fromEntries(Object.entries(IMPROVER_ADAPTER.allowance).map(([key, value]) => [key, value * budget.max_process_jobs])) };
  const project = join(root, "controller"); mkdirSync(project); execFileSync("git", ["init", "--quiet"], { cwd: project });
  const initialized = await init("rl", { defaults: true, agentGuidance: "skip", author: "codex-agent" }, { cwd: project, pmRoot: join(project, ".agents/pm") });
  const client = new PmClient({ cwd: project, pmRoot: initialized.path, author: "codex-agent", noExtensions: true });
  const approval = await client.create({ id: "approval", type: "Decision", title: "Approve fixed recursive improver acceptance", body: `\`\`\`json\n${JSON.stringify(spec)}\n\`\`\`` });
  // The controller's original deadline includes dataset construction and packaging.
  const bounded = { ...config, timeout_ms: Math.floor(config.timeout_ms - (performance.now() - started)) };
  writeFileSync(join(root, "programme.json"), JSON.stringify(bounded, null, 2));
  const cli = join(repo, "node_modules/@unbrained/pm-cli/dist/cli.js");
  const environment = { ...process.env, PM_PATH: initialized.path, PM_AUTHOR: "codex-agent" };
  const [{ filename }] = JSON.parse(execFileSync("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", root], { cwd: repo, encoding: "utf8" })) as { filename: string }[];
  execFileSync(process.execPath, [cli, "package", "install", join(root, filename), "--project", "--json"], { cwd: project, env: environment, timeout: 60_000, stdio: "pipe" });
  const args = [cli, "--author", "codex-agent", "rl", "improver", "run", "rsi-live", "--file", join(root, "programme.json"), "--dataset", join(root, "dataset"), "--approval", String(approval.item.id), "--json"];
  const output = execFileSync(process.execPath, args, { cwd: project, env: environment, encoding: "utf8", timeout: bounded.timeout_ms, maxBuffer: 16 * 1024 * 1024 });
  const report = (JSON.parse(output) as { details: ImproverReport }).details;
  writeFileSync(join(root, "report.json"), JSON.stringify(report, null, 2));
  const jobs = await listProcessJobs(client);
  assert.equal(jobs.filter((job) => ["evaluated", "promoted"].includes(job.state)).length, budget.fits);
  assert.ok(jobs.length <= budget.max_process_jobs && jobs.every((job) => job.settled));
  const usage = Object.fromEntries(Object.keys(IMPROVER_ADAPTER.allowance).map((key) => [key, jobs.reduce((sum, job) => sum + job.charge[key as keyof typeof job.charge], 0)]));
  const evidence = { format: "pm-rl/improver-acceptance/1", config: bounded, dataset: manifest, report_digest: hashJson(report as unknown as JsonValue),
    implementation,
    budget, usage, elapsed_ms: performance.now() - started,
    generations: report.generations.map((generation) => ({ generation: generation.generation, policy: generation.policy, candidate: generation.candidate, promoted: generation.promoted,
      development: ["time-to-close", "issue-type"].map((target) => ({ target, ...summarizeImproverScores(generation.development.scores.filter((score) => score.target === target)) })),
      meta: { before: generation.meta.baseline, after: generation.meta.candidate, gain: generation.meta.gain, lower_bound: generation.meta.lower_bound, verdict: generation.meta.verdict } })),
    audit: ["time-to-close", "issue-type"].map((target) => ({ target,
      before: summarizeImproverScores(report.audit.before.scores.filter((score) => score.target === target)), after: summarizeImproverScores(report.audit.after.scores.filter((score) => score.target === target)) })),
    retained: report.retained.digest };
  writeFileSync(join(root, "evidence.json"), JSON.stringify(evidence, null, 2));
  process.stdout.write(`${JSON.stringify({ evidence: root.slice(repo.length + 1) + "/evidence.json", elapsed_ms: evidence.elapsed_ms, fits: budget.fits, process_jobs: jobs.length, generations: evidence.generations.map((row) => ({ generation: row.generation, score: row.meta.after.mean, promoted: row.promoted })) }, null, 2)}\n`);
}

if (isMainInvocation(process.argv, import.meta.url)) {
  if (process.argv[2] === "--worker") await liveImproverWorker(improverLiveRoot(process.env));
  else await streamProcess(process.execPath, [import.meta.filename, "--worker"], { cwd: resolve(import.meta.dirname, ".."), env: process.env, timeoutMs: 1_195_000, escalationMs: 5000 }, (chunk) => { process.stdout.write(chunk); });
}
