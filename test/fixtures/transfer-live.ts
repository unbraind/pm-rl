/** Explicit opt-in public acceptance; all copied inputs and process staging remain ignored locally. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { init } from "@unbrained/pm-cli/sdk/runtime";
import { hashJson, type JsonValue } from "../../json-identity.ts";
import { loadTransferCorpus, replayTransferEvaluation, transferPower, TRANSFER_DESIGN, verifyTransferCorpus, type TransferCorpus } from "../../proposer-transfer.ts";
import { PmClient } from "@unbrained/pm-cli/sdk/core";
import { buildImproverDataset, IMPROVER_ROLES } from "../../improver-data.ts";
import { proposerEvolutionConfiguration, runProposerEvolution } from "../../proposer-evolution.ts";
import { copyImproverSources } from "../../scripts/live-improver.ts";
import { checkedTrackerSourcePath, excludedTrackerName } from "../../dataset.ts";


import { requireDiagnosticScratch } from "./transfer-replay.ts";
import { isMainInvocation } from "../../scripts/script-launcher.ts";

/** Select the declared three complete trackers per role before creating any diagnostic output. */
export function boundedDiagnosticCorpus(original: TransferCorpus): TransferCorpus {
  verifyTransferCorpus(original);
  const selected = Object.fromEntries(IMPROVER_ROLES.map((role) => {
    const eligible = [...new Set(original.tasks[role].map((task) => task.repo))].filter((repo) => original.tasks[role].filter((task) => task.repo === repo).length === 2 && new Set(original.tasks[role].filter((task) => task.repo === repo).map((task) => task.target)).size === 2).sort((a, b) => hashJson({ repo: a, seed: 42 }).localeCompare(hashJson({ repo: b, seed: 42 }))).slice(0, 3);
    assert.equal(eligible.length, 3, "diagnostic_bounded_trackers");
    return [role, original.tasks[role].filter((task) => eligible.includes(task.repo))];
  })) as unknown as typeof original.tasks;
  const { digest: _, ...prior } = original.manifest;
  const record = { ...prior, splits: Object.fromEntries(IMPROVER_ROLES.map((role) => [role, { tasks: selected[role].length, digest: hashJson(selected[role] as unknown as JsonValue) }])) as TransferCorpus["manifest"]["splits"] };
  const manifest = { ...record, digest: hashJson(record as unknown as JsonValue) };
  const corpus = { manifest, tasks: selected }; verifyTransferCorpus(corpus); return corpus;
}

/** Explicit invocation keeps imports inert and binds live writes to caller-owned scratch. */
export async function transferLiveMain(argv: readonly string[]): Promise<void> {
  const [mode, fleet, scratch, rootFlag, requestedRoot] = argv;
  assert.ok(mode === "build" || mode === "run" || mode === "bounded");
  const requestedPmRoot = mode === "build" ? undefined : (() => {
    assert.ok(rootFlag === "--pm-root" && requestedRoot !== undefined, "diagnostic_explicit_pm_root_required");
    return requireDiagnosticScratch(requestedRoot);
  })();
  const output = resolve(scratch); mkdirSync(output, { recursive: true });
  if (mode === "build") {
    const pins: { repo: string; commit: string }[] = []; const excluded: string[] = [];
    for (const name of readdirSync(fleet).sort()) {
      // Deny by directory name before opening any source, even its Git configuration.
      if (!/^pm-[\w-]+$/.test(name) || excludedTrackerName(name)) continue;
      checkedTrackerSourcePath(join(fleet, name, ".agents/pm"));
      const repo = `unbraind/${name}`;
      let metadata: { visibility: string; licenseInfo: { key: string } | null };
      try { metadata = JSON.parse(execFileSync("gh", ["repo", "view", repo, "--json", "visibility,licenseInfo"], { encoding: "utf8", timeout: 30_000 })) as { visibility: string; licenseInfo: { key: string } | null }; } catch { excluded.push(repo); continue; }
      if (metadata.visibility !== "PUBLIC" || metadata.licenseInfo?.key !== "mit") { excluded.push(repo); continue; }
      const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: join(fleet, name), encoding: "utf8" }).trim();
      assert.equal(execFileSync("gh", ["api", `repos/${repo}/commits/${commit}`, "--jq", ".sha"], { encoding: "utf8", timeout: 30_000 }).trim(), commit);
      pins.push({ repo, commit });
    }
    const copies = copyImproverSources(fleet, join(output, "sources"), pins);
    const manifest = buildImproverDataset(copies, join(output, "dataset"), 42);
    writeFileSync(join(output, "pins.json"), JSON.stringify({ pins, excluded }));
    console.log(JSON.stringify({ sources: manifest.sources, omitted: manifest.omitted, splits: manifest.splits, digest: manifest.digest, design: transferPower(0, { ...TRANSFER_DESIGN, looks: 2 }) }));
  } else {
    assert.ok(requestedPmRoot !== undefined);
    const original = loadTransferCorpus(join(output, "dataset"));
    const { manifest, tasks: selected } = boundedDiagnosticCorpus(original);
    const directory = join(output, "bounded-dataset"); mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "improver-dataset.json"), JSON.stringify(manifest));
    for (const role of IMPROVER_ROLES) writeFileSync(join(directory, `${role}.json`), JSON.stringify(selected[role]));
    const project = dirname(dirname(requestedPmRoot)); mkdirSync(project, { recursive: true });
    const initialized = await init("transfer", { defaults: true, agentGuidance: "skip", author: "codex-sol" }, { cwd: project, pmRoot: requestedPmRoot });
    const pmRoot = initialized.path;
    const client = new PmClient({ cwd: project, pmRoot, noExtensions: true, author: "codex-sol" });
    const approval = await client.create({ id: "approval", type: "Decision", title: "Fixed three-tracker diagnostic resource approval", body: '```json\n'+JSON.stringify({ permitted_promotions: 31, meta_budget: { training_samples: 3840, proposal_calls: 5, recipe_promotions: 1 }, resource_budget: { training_steps: 60, wall_ms: 1950000, compute_units: 1950000, storage_bytes: 327680, tokens: 0 }, corpus: manifest.digest })+'\n```' });
    const config = { ...proposerEvolutionConfiguration(), generations: 1, candidates: 1, updates: 64, timeout_ms: 600_000 };
    const started = performance.now();
    console.log(JSON.stringify({ corpus: manifest.digest, selected: IMPROVER_ROLES.map((role) => ({ role, trackers: [...new Set(selected[role].map((task) => task.repo))] })), config }));
    const report = await runProposerEvolution(client, { pmRoot, author: "codex-sol" }, { id: "rsipower-bounded", approval: approval.item.id, dataset: directory, config, async onStep(key) { console.log(JSON.stringify({ step: key, elapsed_ms: Math.ceil(performance.now() - started) })); } });
    assert.deepEqual(await replayTransferEvaluation(client, report.transfer.digest), report.transfer.report);
    const envelope = JSON.parse(String((await client.get(`transfer-${report.transfer.digest}`)).item.body)) as { corpus: string };
    const result = { elapsed_ms: Math.ceil(performance.now() - started), report, corpus: envelope.corpus };
    writeFileSync(join(output, "bounded-result.json"), JSON.stringify(result));
    console.log(JSON.stringify(result));
  }

}

if (isMainInvocation(process.argv, import.meta.url)) await transferLiveMain(process.argv.slice(2));
