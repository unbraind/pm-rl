/** Public-copy sensitivity validation; emit only counts, digests, parameters and generic slice names. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PmClient } from "@unbrained/pm-cli/sdk/core";
import { init, normalizeStatusInput } from "@unbrained/pm-cli/sdk/runtime";
import { readSettings, resolveRuntimeStatusRegistry } from "@unbrained/pm-cli/sdk";
import { hashJson, runRlLoop, resumeRlLoop, type JsonValue } from "../index.ts";
import { corpusHeldOut } from "../corpus.ts";
import { measureTrainingInfluence, recordTrainingInfluence, attachTrainingInfluence, readTrainingInfluence, summarizeTrainingInfluence } from "../training-influence.ts";

/** Fingerprint the explicitly supplied read-only public copy without inspecting any other directory. */
function fingerprint(root: string): { files: number; digest: string } {
  const hash = createHash("sha256"); let files = 0;
  /** Enforce read-only modes for every supplied file and directory. */
  function walk(relative: string): void {
    assert.equal(statSync(join(root, relative)).mode & 0o222, 0);
    for (const entry of readdirSync(join(root, relative), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const key = join(relative, entry.name);
      if (entry.isDirectory()) walk(key);
      else { assert.ok(entry.isFile()); assert.equal(statSync(join(root, key)).mode & 0o222, 0); hash.update(key); hash.update(readFileSync(join(root, key))); files += 1; }
    }
  }
  walk(""); return { files, digest: hash.digest("hex") };
}
const [source, commit, output] = process.argv.slice(2); assert.match(commit, /^[a-f0-9]{40}$/);
const before = fingerprint(source); const sourceClient = new PmClient({ pmRoot: source, noExtensions: true });
const inventory = await sourceClient.listAllComplete({ includeBody: false });
const registry = resolveRuntimeStatusRegistry((await readSettings(source)).schema);
const rows = inventory.items.map((item) => {
  const length = Math.min(256, [...item.title.normalize("NFKC").trim().replaceAll(/\s+/g, " ").toLowerCase()].length);
  const done = registry.terminal_done_statuses.has(normalizeStatusInput(item.status, registry)!);
  return { id: hashJson(item.id), length, done, feature: Math.log1p(length) / Math.log(257), rewards: done ? [0, 1] : [1, 0] };
}).sort((a, b) => a.id.localeCompare(b.id));
const training = rows.filter((row) => !corpusHeldOut(row.length)); const held = rows.filter((row) => corpusHeldOut(row.length));
assert.ok(training.length > 2 && held.length > 1);
const project = (row: typeof rows[number]) => ({ id: row.id, feature: row.feature, rewards: row.rewards });
const evaluations = [{ id: "all", members: held.map((row) => row.id) }, ...[false, true].flatMap((done) => { const members = held.filter((row) => row.done === done).map((row) => row.id); return members.length === 0 ? [] : [{ id: done ? "done-role" : "other-roles", members }]; })];
const input = { format: "pm-rl/training-influence/1", learner: { seed: 42, initial_weight: 0, samples: 512, fit_steps: 8, learning_rate: 0.5 }, training: training.map(project), held_out: held.map(project),
  slices: [{ id: "omit-first-half", members: training.slice(0, Math.floor(training.length / 2)).map((row) => row.id), weight: 0 }, { id: "omit-second-half", members: training.slice(Math.floor(training.length / 2)).map((row) => row.id), weight: 0 }, { id: "reweight-first-half", members: training.slice(0, Math.floor(training.length / 2)).map((row) => row.id), weight: 2 }], evaluations, budget: { fits: 4, samples: 2048, updates: 32 } };
const root = mkdtempSync(join(tmpdir(), "rl-influence-public-"));
process.env.GIT_CEILING_DIRECTORIES = dirname(root);
const tracker = await init("rl", { defaults: true, agentGuidance: "skip", author: "influence-acceptance" }, { cwd: root });
const bin = join(root, "bin"); mkdirSync(bin); symlinkSync(process.execPath, join(bin, "node")); symlinkSync("/usr/bin/getconf", join(bin, "getconf")); process.env.PATH = bin;
const client = new PmClient({ cwd: root, pmRoot: tracker.path, author: "influence-acceptance", noExtensions: true });
const started = performance.now(); const measured = await recordTrainingInfluence(client, input);
assert.deepEqual(measureTrainingInfluence(input), measured.report); assert.deepEqual((await readTrainingInfluence(client, measured.id)).report, measured.report);
const partial = measureTrainingInfluence({ ...input, budget: { fits: 2, samples: 1024, updates: 16 } });
assert.equal(partial.complete, false); assert.equal(partial.ranking, null); assert.equal(partial.omitted.length, 2);
const proposal = await attachTrainingInfluence(client, { environment: { name: "Public tracker status projection", version: hashJson(input.training as JsonValue) }, training: input.training as JsonValue, evaluation: input.held_out as JsonValue, seed: 42, initial_weight: 0, samples_per_generation: 512, fit_steps: 8, max_generations: 2, budget: 1024, learning_rate: 0.5, minimum_improvement: 0.0001, maximum_gap: 1, evaluation_samples: 10000, confidence: 0.95, min_samples: 2 }, measured.id);
await client.create({ id: "approval", type: "Decision", title: "Two bounded public-copy generations", body: '```json\n{"permitted_promotions":2}\n```', unset: ["parent"] });
const loop = await runRlLoop(client, { pmRoot: tracker.path, author: "influence-acceptance" }, { id: "measured", approval: "approval", config: proposal });
const resumed = await resumeRlLoop(client, { pmRoot: tracker.path, author: "influence-acceptance" }, { id: "measured", approval: "approval" });
assert.equal(resumed.final_checkpoint, loop.final_checkpoint); assert.deepEqual(fingerprint(source), before);
writeFileSync(output, JSON.stringify({ format: "pm-rl/training-influence-evidence/validation-1", source: { repository: "unbraind/pm-ops", commit, license: "MIT", ...before, source_unchanged: true },
  corpus: { items: rows.length, training: training.length, held_out: held.length, held_out_done_role: held.filter((row) => row.done).length, status_semantics: "SDK registry terminal_done role" },
  full: { ...summarizeTrainingInfluence(measured.report), baseline_scores: measured.report.baseline!.scores, exact_checkpoints: [measured.report.baseline!.checkpoint, ...measured.report.comparisons.map((row) => row.fit.checkpoint)] }, partial: summarizeTrainingInfluence(partial),
  recursive_feedback: { generations: loop.generations.length, promoted: loop.promoted, resumed_generations: resumed.resumed_generations, stop_reason: loop.stop_reason, final_checkpoint: loop.final_checkpoint },
  no_git: true, git_absent_from_path: true, elapsed_ms: performance.now() - started,
  limits: ["Finite public snapshot status projection; not generalization evidence.", "One fixed learner and seed; associations only, no causal identification or importance ranking.", "History replay verifies the original evidence; it grants no promotion authority."] }, null, 2) + "\n");
