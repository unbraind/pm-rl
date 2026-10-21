/** Opt-in acceptance over real public fleet history, with a whole-run watchdog and retained local evidence. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { PmClient } from "@unbrained/pm-cli/sdk/core";
import { init } from "@unbrained/pm-cli/sdk/runtime";
import { buildTrackerDataset, readTrackerSplit, TRACKER_SPLITS, type TrackerBuildOptions } from "../dataset.ts";
import { hashJson, type JsonValue } from "../index.ts";
import { runRlMeta, type MetaReport, type MetaRequest } from "../meta.ts";
import { recipeArtifact } from "../recipe.ts";
import { liveMetaConfiguration } from "./meta-configuration.ts";
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

/** Preserve the existing live-script configuration export for callers. */
export { liveMetaConfiguration } from "./meta-configuration.ts";

/** Build real data at acceptance time and retain results without committing tracker inputs or local paths. */
export async function runLiveMetaAcceptance(directories: readonly string[], timeoutMs = LIVE_WORKER_DEADLINE_MS, options: TrackerBuildOptions = {}): Promise<{ artifacts: string; elapsed_ms: number; report: MetaReport }> {
  assert.ok(Number.isInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= LIVE_WORKER_DEADLINE_MS, "meta_live_timeout");
  const signal = AbortSignal.timeout(timeoutMs);
  const started = performance.now();
  const repoRoot = resolve(import.meta.dirname, "..");
  const parent = join(repoRoot, ".agents/pm/runtime/live-meta");
  mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, "run-"));
  try {
    execFileSync("git", ["init", "--quiet", root]);
    const dataset = buildTrackerDataset(directories, join(root, "dataset"), 42, options);
    signal.throwIfAborted();
    const initialized = await init("rl", { defaults: true, agentGuidance: "skip", author: "codex-agent" }, { cwd: root, pmRoot: join(root, ".agents/pm") });
    const client = new PmClient({ pmRoot: initialized.path, cwd: root, author: "codex-agent", noExtensions: true });
    const spec = { permitted_promotions: 20, resource_budget: { training_steps: 20, wall_ms: 600_000, storage_bytes: 81_920, compute_units: 600_000, tokens: 0 },
      meta_budget: { training_samples: 20_480, proposal_calls: 4, recipe_promotions: 2 } };
    const approval = await client.create({ id: "approval", type: "Decision", title: "Pre-approved two-generation recipe acceptance", body: `\`\`\`json\n${JSON.stringify(spec)}\n\`\`\`` });
    const legacy = liveMetaConfiguration();
    const config = options.task === "history-prefix" ? { ...legacy, initial_recipe: recipeArtifact({ ...legacy.initial_recipe.knobs, prefix: { regularisation: 0.001, ngram_order: 2, hashing_width: 32 } }) } : legacy;
    writeFileSync(join(root, "programme.json"), JSON.stringify(config, null, 2));
    const request = { id: "meta-live", config, dataset: join(root, "dataset"), approval: String(approval.item.id), proposer: "seeded" as const, signal };
    const report = options.task === "history-prefix" ? runPackedMeta(root, initialized.path, request, timeoutMs) : await runRlMeta(client, { pmRoot: initialized.path, author: "codex-agent" }, request);
    assert.equal(report.generations.length, 2, "meta_live_two_generations");
    assert.equal(report.dataset, dataset.digest);
    signal.throwIfAborted();
    const provenance = options.task === "history-prefix" ? { dataset, examples: TRACKER_SPLITS.flatMap((split) => readTrackerSplit(join(root, "dataset"), dataset, split).map((row) => ({ split, id: row.id, repo: row.repo, commit: row.commit, prefix_digest: hashJson(row.history as unknown as JsonValue), label: row.label }))) } : {};
    const evidence = { ...provenance, artifacts: relative(repoRoot, root), elapsed_ms: performance.now() - started, report };
    writeFileSync(join(root, "summary.json"), JSON.stringify(evidence, null, 2));
    return evidence;
  } catch (error) {
    writeFileSync(join(root, "failure.json"), JSON.stringify({ failed: true, deadline_aborted: signal.aborted }));
    throw error;
  }
}

/** Resolve explicit local fleet input and print the complete acceptance evidence. */
export async function liveMetaMain(environment: NodeJS.ProcessEnv, emit = printLiveMetaEvidence, pinsFile = resolve(import.meta.dirname, "../docs/meta-live-evidence.json")): Promise<void> {
  const started = performance.now();
  const { fleet, timeout } = liveMetaOptions(environment);
  const task = environment["PM_RL_TRACKER_TASK"] ?? "history-prefix";
  assert.ok(["history-prefix", "terminal-disposition"].includes(task), "meta_live_task");
  const pins = task === "history-prefix" ? (JSON.parse(readFileSync(pinsFile, "utf8")) as { dataset: { sources: NonNullable<TrackerBuildOptions["pins"]> } }).dataset.sources : undefined;
  const directories = pins === undefined ? publicTrackerDirectories(fleet) : pins.map((pin) => join(fleet, pin.repo.split("/")[1], ".agents/pm"));
  const evidence = await runLiveMetaAcceptance(directories, Math.floor(timeout - (performance.now() - started)), pins === undefined ? {} : { task: "history-prefix", pins });
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

/** Exercise the packed public command rather than a source-only entry point for the new family. */
export function runPackedMeta(root: string, pmRoot: string, request: MetaRequest, timeout: number): MetaReport {
  const cli = resolve(import.meta.dirname, "../node_modules/@unbrained/pm-cli/dist/cli.js");
  const environment = { ...process.env, PM_PATH: pmRoot, PM_AUTHOR: "codex-agent" };
  const [{ filename }] = JSON.parse(execFileSync("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", root], { cwd: resolve(import.meta.dirname, ".."), encoding: "utf8" })) as { filename: string }[];
  execFileSync(process.execPath, [cli, "package", "install", join(root, filename), "--project", "--json"], { cwd: root, env: environment, timeout, stdio: "pipe" });
  const output = execFileSync(process.execPath, [cli, "rl", "meta", "run", request.id, "--file", join(root, "programme.json"), "--dataset", request.dataset, "--approval", request.approval, "--proposer", "seeded", "--json"], { cwd: root, env: environment, timeout, encoding: "utf8", maxBuffer: 4 * 1024 * 1024 });
  return (JSON.parse(output) as { details: MetaReport }).details;
}
