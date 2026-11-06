/** Explicit opt-in public acceptance; all copied inputs and process staging remain ignored locally. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { init } from "@unbrained/pm-cli/sdk/runtime";
import { hashJson, type JsonValue } from "../../json-identity.ts";
import { loadTransferCorpus, replayTransferEvaluation, transferPower, TRANSFER_DESIGN } from "../../proposer-transfer.ts";
import { PmClient } from "@unbrained/pm-cli/sdk/core";
import { buildImproverDataset, IMPROVER_ROLES } from "../../improver-data.ts";
import { proposerEvolutionConfiguration, runProposerEvolution } from "../../proposer-evolution.ts";
import { copyImproverSources } from "../../scripts/live-improver.ts";


import { requireDiagnosticScratch } from "./transfer-replay.ts";

const [mode, fleet, scratch, rootFlag, requestedRoot] = process.argv.slice(2);
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
    if (!/^pm-[\w-]+$/.test(name) || ["pm-cli", "pm-observer", "pm-web-hosted", "pm-web", "pm-gpt"].includes(name)) continue;
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
  const selected = Object.fromEntries(IMPROVER_ROLES.map((role) => {
    const eligible = [...new Set(original.tasks[role].map((task) => task.repo))].filter((repo) => original.tasks[role].filter((task) => task.repo === repo).length === 2).sort((a, b) => hashJson({ repo: a, seed: 42 }).localeCompare(hashJson({ repo: b, seed: 42 }))).slice(0, 3);
    return [role, original.tasks[role].filter((task) => eligible.includes(task.repo))];
  })) as unknown as typeof original.tasks;
  const { digest: _, ...prior } = original.manifest;
  const record = { ...prior, splits: Object.fromEntries(IMPROVER_ROLES.map((role) => [role, { tasks: selected[role].length, digest: hashJson(selected[role] as unknown as JsonValue) }])) };
  const manifest = { ...record, digest: hashJson(record as unknown as JsonValue) };
  const directory = join(output, "bounded-dataset"); mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "improver-dataset.json"), JSON.stringify(manifest));
  for (const role of IMPROVER_ROLES) writeFileSync(join(directory, `${role}.json`), JSON.stringify(selected[role]));
  const project = resolve(requestedPmRoot, "../.."); mkdirSync(project, { recursive: true });
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
