/** Public-copy validation: two recursive generations, retained cards, packed CLI and immutable source. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, statSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { PmClient } from "@unbrained/pm-cli/sdk/core";
import { init, isPmCliExpectedError } from "@unbrained/pm-cli/sdk/runtime";
import { runRlLoop, resumeRlLoop, rlLoopStatus, hashJson, type JsonValue } from "../index.ts";
import { buildTrackerLoopCorpus } from "../corpus.ts";
import { exportPolicyCard, replayPolicyCard, adoptPolicyCard, type PolicyCard } from "../policy-card.ts";

/** Fingerprint every supplied public file, requiring read-only permissions on files and directories. */
function fingerprint(root: string): { digest: string; files: number } {
  const hash = createHash("sha256"); let files = 0;
  /** Traverse only the explicit public snapshot. */
  function walk(relative: string): void {
    assert.equal(statSync(join(root, relative)).mode & 0o222, 0);
    for (const entry of readdirSync(join(root, relative), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const key = join(relative, entry.name);
      if (entry.isDirectory()) walk(key);
      else { assert.ok(entry.isFile()); assert.equal(statSync(join(root, key)).mode & 0o222, 0); files += 1; hash.update(JSON.stringify(key)); hash.update(readFileSync(join(root, key))); }
    }
  }
  walk(""); return { digest: hash.digest("hex"), files };
}
const [source, output, commit, archive] = process.argv.slice(2);
assert.match(commit, /^[a-f0-9]{40}$/); const before = fingerprint(source);
const sourceClient = new PmClient({ pmRoot: source, noExtensions: true });
const bounds = JSON.parse(readFileSync(new URL("../examples/loop-corpus.json", import.meta.url), "utf8")) as Record<string, JsonValue>;
delete bounds.adapter;
const corpus = await buildTrackerLoopCorpus(sourceClient, bounds);
const majority = Math.max(corpus.held_out_closed, corpus.held_out_items - corpus.held_out_closed) / corpus.held_out_items;
const root = mkdtempSync(join(tmpdir(), "card-acceptance-"));
const { path: pmRoot } = await init("rl", { defaults: true, agentGuidance: "skip", author: "card-acceptance" }, { cwd: root });
const cli = resolve("node_modules/@unbrained/pm-cli/dist/cli.js");
const commandEnv: NodeJS.ProcessEnv = { ...process.env, PM_PATH: pmRoot, PM_AUTHOR: "card-acceptance", GIT_CEILING_DIRECTORIES: dirname(root) };
execFileSync(process.execPath, [cli, "package", "install", resolve(archive), "--project", "--json"], { cwd: root, env: commandEnv });
const bin = join(root, "bin"); mkdirSync(bin); symlinkSync(process.execPath, join(bin, "node")); symlinkSync("/usr/bin/getconf", join(bin, "getconf")); commandEnv.PATH = bin;
process.env.PATH = bin; process.env.GIT_CEILING_DIRECTORIES = dirname(root);
const client = new PmClient({ pmRoot, cwd: root, author: "card-acceptance", noExtensions: true });
await client.create({ id: "rl-approval", type: "Decision", title: "Two bounded recursive generations", body: '```json\n{"permitted_promotions":2}\n```' });
const started = performance.now();
let laterGenerationReplays = 0;
const report = await runRlLoop(client, { pmRoot, author: "card-acceptance" }, { id: "cards", config: corpus.programme, approval: "rl-approval", onPhase: async (phase, generation) => {
  if (phase === "collect" && generation === 2) {
    const earlier = await exportPolicyCard(client, "rl-cards-g1");
    await replayPolicyCard(client, earlier); laterGenerationReplays += 1;
  }
} });
assert.equal(report.generations.length, 2); assert.equal(report.promoted, 2); assert.equal(laterGenerationReplays, 1);
const resumed = await resumeRlLoop(client, { pmRoot, author: "card-acceptance" }, { id: "cards", approval: "rl-approval" });
assert.equal(resumed.resumed_generations, 2); assert.equal(resumed.final_checkpoint, report.final_checkpoint);
assert.equal((await rlLoopStatus(client, "cards", pmRoot)).stop_reason, report.stop_reason);
const inventory = (await client.listAllComplete({ includeBody: true })).items;
const cards = inventory.filter((item) => String(item.id).includes("-policy-card-")).map((item) => JSON.parse(String(item.body)) as PolicyCard);
const generations = [];
for (const generation of report.generations) {
  const related = cards.filter((card) => card.subject === generation.item);
  assert.ok(related.some((card) => card.outcome === "candidate")); assert.ok(related.some((card) => card.outcome === "promoted"));
  const card = await exportPolicyCard(client, generation.item); const replay = await replayPolicyCard(client, card);
  assert.equal((await adoptPolicyCard(client, card)).digest, card.digest);
  if (generation.generation === 1) writeFileSync(new URL("../examples/policy-card.json", import.meta.url), JSON.stringify(card, null, 2) + "\n");
  const file = join(root, "card.json"); writeFileSync(file, JSON.stringify(card));
  /** Exercise the packed extension through the installed host with no Git executable. */
  const command = (args: string[]) => execFileSync(process.execPath, [cli, "rl", "policy-card", ...args], { cwd: root, env: commandEnv, encoding: "utf8" });
  const json = command(["export", generation.item, "--json"]); const toon = command(["export", generation.item]);
  assert.equal((JSON.parse(json) as { details: PolicyCard }).details.digest, card.digest);
  const cliReplay = JSON.parse(command(["replay", "--file", file, "--json"])) as { details: { results: unknown[] } };
  assert.equal(cliReplay.details.results.length, card.evidence.length);
  assert.equal((JSON.parse(command(["adopt", "--file", file, "--json"])) as { details: { suitable: boolean } }).details.suitable, true);
  let missing = "";
  try { await adoptPolicyCard(client, { ...card, evidence: [] }); assert.fail("Missing provenance must refuse"); }
  catch (error) { assert.ok(isPmCliExpectedError(error)); missing = String(error.context.code); assert.equal(missing, "card_missing_provenance"); }
  generations.push({ generation: generation.generation, promoted: generation.promoted, sampled_held_out_mean: generation.held_out_mean, retained_cards: related.length, outcomes: related.map((card) => card.outcome), evidence_results: replay.results.length, card_digest: card.digest, json_bytes: Buffer.byteLength(json), toon_bytes: Buffer.byteLength(toon), missing_provenance: missing });
}
let citedResults = 0;
for (const card of cards) citedResults += (await replayPolicyCard(client, card)).results.length;
assert.deepEqual(fingerprint(source), before);
writeFileSync(output, JSON.stringify({ format: "pm-rl/policy-card-evidence/1", source: { repository: "unbraind/pm-ops", commit, license: "MIT", ...before, digest_after: before.digest }, corpus: { snapshot: corpus.snapshot, training_items: corpus.training_items, held_out_items: corpus.held_out_items, held_out_closed: corpus.held_out_closed }, generations, majority_baseline_accuracy: majority, sampled_policies_beat_majority: report.generations.map((generation) => generation.held_out_mean > majority), retained_cards: cards.length, later_generation_replays: laterGenerationReplays, resumed_generations: resumed.resumed_generations, cited_results_replayed: citedResults, samples_consumed: report.samples_consumed, stop_reason: report.stop_reason, elapsed_ms: performance.now() - started, programme_digest: hashJson(corpus.programme), no_git: true, git_absent_from_path: true, source_unchanged: true, limits: ["Finite snapshot status recognition; sampled episodes reuse held-out items.", "Two recursive numerical-policy generations do not establish cross-repository generalization or proposer transfer.", "Adoption checks suitability only; backend consent and normal gates remain required."] }, null, 2) + "\n");
