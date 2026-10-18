/** Opt-in acceptance over real public fleet history, with a whole-run watchdog and retained local evidence. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { PmClient } from "@unbrained/pm-cli/sdk/core";
import { init } from "@unbrained/pm-cli/sdk/runtime";
import { buildTrackerDataset } from "../dataset.ts";
import { runRlMeta, type MetaConfig, type MetaReport } from "../meta.ts";
import { INITIAL_RECIPE } from "../recipe.ts";
import { isMainInvocation } from "./script-launcher.ts";
import { LIVE_WORKER_DEADLINE_MS, LIVE_WORKER_TIMEOUT_ENV } from "./live-watchdog.ts";

/** Discover only immediate fleet checkouts, verifying visibility before allowing history reads. */
export function publicTrackerDirectories(fleet: string): string[] {
  const directories: string[] = [];
  for (const entry of readdirSync(fleet, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith("pm-") || ["pm-web", "pm-gpt", "pm-cli"].includes(entry.name)) continue;
    const metadata = JSON.parse(execFileSync("gh", ["repo", "view", `unbraind/${entry.name}`, "--json", "visibility,licenseInfo"], { encoding: "utf8", timeout: 30_000 })) as { visibility: string; licenseInfo: { key: string } | null };
    if (metadata.visibility === "PUBLIC" && metadata.licenseInfo?.key === "mit") directories.push(join(fleet, entry.name, ".agents/pm"));
  }
  return directories.sort();
}

/** Two meta-generations and two candidates, with every fit covered by the same pre-approved resource Decision. */
export function liveMetaConfiguration(): MetaConfig {
  return { initial_recipe: INITIAL_RECIPE, seed: 42, meta_generations: 2, candidates: 2, timeout_ms: 840_000,
    criterion: { confidence: 0.95, minSamples: 10, effectThreshold: 0.01 }, maximum_gap: 0.3, evaluation_samples: 40_000,
    adapter: { kind: "process-bandit", allowance: { training_steps: 1, wall_ms: 30_000, storage_bytes: 4096, compute_units: 30_000, tokens: 0 } } };
}

/** Build real data at acceptance time and retain results without committing tracker inputs or local paths. */
export async function runLiveMetaAcceptance(directories: readonly string[], timeoutMs = LIVE_WORKER_DEADLINE_MS): Promise<{ artifacts: string; elapsed_ms: number; report: MetaReport }> {
  assert.ok(Number.isInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= LIVE_WORKER_DEADLINE_MS, "meta_live_timeout");
  const signal = AbortSignal.timeout(timeoutMs);
  const started = performance.now();
  const repoRoot = resolve(import.meta.dirname, "..");
  const parent = join(repoRoot, ".agents/pm/runtime/live-meta");
  mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, "run-"));
  try {
    execFileSync("git", ["init", "--quiet", root]);
    const dataset = buildTrackerDataset(directories, join(root, "dataset"));
    signal.throwIfAborted();
    const initialized = await init("rl", { defaults: true, agentGuidance: "skip", author: "codex-agent" }, { cwd: root, pmRoot: join(root, ".agents/pm") });
    const client = new PmClient({ pmRoot: initialized.path, cwd: root, author: "codex-agent", noExtensions: true });
    const spec = { permitted_promotions: 20, resource_budget: { training_steps: 20, wall_ms: 600_000, storage_bytes: 81_920, compute_units: 600_000, tokens: 0 },
      meta_budget: { training_samples: 20_480, proposal_calls: 4, recipe_promotions: 2 } };
    const approval = await client.create({ id: "approval", type: "Decision", title: "Pre-approved two-generation recipe acceptance", body: `\`\`\`json\n${JSON.stringify(spec)}\n\`\`\`` });
    const config = liveMetaConfiguration();
    writeFileSync(join(root, "programme.json"), JSON.stringify(config, null, 2));
    const report = await runRlMeta(client, { pmRoot: initialized.path, author: "codex-agent" }, { id: "meta-live", config,
      dataset: join(root, "dataset"), approval: String(approval.item.id), proposer: "seeded", signal });
    assert.equal(report.generations.length, 2, "meta_live_two_generations");
    assert.equal(report.dataset, dataset.digest);
    signal.throwIfAborted();
    const evidence = { artifacts: relative(repoRoot, root), elapsed_ms: performance.now() - started, report };
    writeFileSync(join(root, "summary.json"), JSON.stringify(evidence, null, 2));
    return evidence;
  } catch (error) {
    writeFileSync(join(root, "failure.json"), JSON.stringify({ failed: true, deadline_aborted: signal.aborted }));
    throw error;
  }
}

/** Resolve explicit local fleet input and print the complete acceptance evidence. */
export async function liveMetaMain(environment: NodeJS.ProcessEnv, emit = printLiveMetaEvidence): Promise<void> {
  const started = performance.now();
  const { fleet, timeout } = liveMetaOptions(environment);
  const directories = publicTrackerDirectories(fleet);
  const evidence = await runLiveMetaAcceptance(directories, Math.floor(timeout - (performance.now() - started)));
  emit(evidence);
}

/** Print one complete evidence envelope without intercepting the test runner's asynchronous protocol stream. */
export function printLiveMetaEvidence(evidence: Awaited<ReturnType<typeof runLiveMetaAcceptance>>): void {
  process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
}

/** Resolve live-only filesystem input and watchdog budget without opening any source tracker. */
export function liveMetaOptions(environment: NodeJS.ProcessEnv): { fleet: string; timeout: number } {
  return { fleet: environment["PM_RL_TRACKER_ROOT"] ?? resolve(import.meta.dirname, "../../..", "fleet"),
    timeout: Number(environment[LIVE_WORKER_TIMEOUT_ENV] ?? LIVE_WORKER_DEADLINE_MS) };
}

if (isMainInvocation(process.argv, import.meta.url)) await liveMetaMain(process.env);
