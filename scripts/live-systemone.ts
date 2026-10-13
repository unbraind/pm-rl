/** Real two-generation acceptance for a frozen System One model; CI supplies a local HTTP server. */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { join, relative, resolve } from "node:path";
import { PmClient } from "@unbrained/pm-cli/sdk/core";
import { init } from "@unbrained/pm-cli/sdk/runtime";
import { runRlLoop, canonicalJson, type JsonValue } from "../index.ts";
import {
  parseSystemOneLoopConfig, parseStoredSystemOneGeneration, parseSystemOneDecisionEvent,
  systemOneCheckpoint, systemOneCheckpointJson, systemOneAccuracy, systemOneCalibrationError,
  type SystemOneCheckpoint, type SystemOneLoopConfig,
  SYSTEMONE_HELD_OUT_METRIC,
} from "../systemone.ts";
import { readSeries, type MetricEvent } from "../series.ts";
import { parseGenerationSpec } from "../lineage.ts";
import { isMainInvocation } from "./script-launcher.ts";
import { LIVE_TIMEOUT_MS } from "./live-watchdog.ts";

/** Shared whole-run deadline for the SDK worker and its process watchdog. */
export { LIVE_TIMEOUT_MS } from "./live-watchdog.ts";

/** Build synthetic PM item routing examples and a bounded calibration programme. */
export function liveConfiguration(baseURL = "http://127.0.0.1:11434", model = "tev1:4b"): JsonValue {
  return {
    trainer: "systemone", environment: { name: "Synthetic PM item routing", version: "1" },
    decision_model: { base_url: baseURL, model, timeout_ms: 600000 },
    questions: { kind: { type: "choice", instructions: "Classify this project management item. Choose Bug for repairing broken behavior or Feature for adding functionality.", criteria: { Bug: "Repair a defect", Feature: "Add new functionality" } } },
    training: [
      { id: "train-crash", title: "Fix export crash", description: "Exporting a report crashes the application. Repair the defect.", labels: { kind: "Bug" } },
      { id: "train-format", title: "Add CSV export", description: "Implement a new CSV export feature.", labels: { kind: "Feature" } },
    ],
    evaluation: [
      { id: "eval-search", title: "Repair broken search", description: "Search fails with an error on valid input. Fix this defect.", labels: { kind: "Bug" } },
      { id: "eval-pdf", title: "Add PDF downloads", description: "Implement a new PDF download feature.", labels: { kind: "Feature" } },
    ],
    initial_head: { log_temperature: { kind: 2 }, biases: { kind: { Bug: 0, Feature: 0 } } },
    seed: 42, max_generations: 2, samples_per_generation: 2, budget: 8,
    learning_rate: 0.5, fit_steps: 2, minimum_improvement: 0.001, maximum_gap: 0.5,
    evaluation_samples: 40000, confidence: 0.95, min_samples: 10,
  };
}

/** Frozen model identity and the verified CPU execution configuration. */
export interface LiveModelEvidence {
  readonly name: string;
  readonly digest: string;
  readonly size_bytes: number;
  readonly num_gpu: 0;
  readonly num_thread: number;
}

/** Content-bound lineage and held-out measurements for one actual head fit. */
export interface LiveGenerationEvidence {
  readonly generation: number;
  readonly item: string;
  readonly run: string;
  readonly source: string;
  readonly checkpoint: string;
  readonly checkpoint_file: string;
  readonly collection_digest: string;
  readonly collecting_policy: string;
  readonly promoted: boolean;
  readonly refusal_reason: string | null;
  readonly accuracy_before: number;
  readonly accuracy_after: number;
  readonly ece_before: number;
  readonly ece_after: number;
  readonly held_out_mean_before: number;
  readonly held_out_mean_after: number;
  readonly evaluation_samples: number;
  readonly tokens: number;
  readonly decisions: readonly MetricEvent[];
}

/** Retained real PM receipts, canonical checkpoints and the bounded run transcript. */
export interface LiveAcceptanceEvidence {
  readonly model: LiveModelEvidence;
  readonly programme: string;
  readonly training_digest: string;
  readonly evaluation_digest: string;
  readonly artifacts: string;
  readonly initial_checkpoint: string;
  readonly generations: readonly LiveGenerationEvidence[];
  readonly tokens: number;
  readonly elapsed_ms: number;
  readonly wall_ms_per_query: number;
  readonly endpoint_ms: number;
  readonly endpoint_ms_per_query: number;
  readonly queries: number;
  readonly timeout_ms: number;
  readonly stop_reason: string;
}

/** Fetch bounded metadata from the same local Ollama service that performs inference. */
async function modelMetadata(config: SystemOneLoopConfig, path: string, signal: AbortSignal, body?: JsonValue): Promise<Record<string, unknown>> {
  const response = await fetch(`${config.endpoint.baseURL}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body), signal,
  });
  assert.ok(response.ok, `Ollama metadata refused HTTP ${response.status}`);
  const value: unknown = await response.json();
  assert.ok(value !== null && typeof value === "object" && !Array.isArray(value), "Invalid Ollama metadata");
  return value as Record<string, unknown>;
}

/** Refuse remote, unpinned or GPU-capable configurations before spending any decision query. @internal */
export async function cpuModelEvidence(config: SystemOneLoopConfig, signal: AbortSignal): Promise<LiveModelEvidence> {
  const url = new URL(config.endpoint.baseURL);
  assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(url.hostname), "Live acceptance requires a local Ollama endpoint");
  const tags = await modelMetadata(config, "/api/tags", signal);
  assert.ok(Array.isArray(tags.models), "Ollama model inventory is missing");
  const model = tags.models.find((entry: unknown) => entry !== null && typeof entry === "object" && "name" in entry && entry.name === config.endpoint.model) as Record<string, unknown> | undefined;
  assert.ok(model !== undefined, "The decision model is unavailable");
  assert.ok(model.remote_model === undefined && model.remote_host === undefined, "Live acceptance requires local model weights");
  assert.ok(typeof model.digest === "string" && /^[a-f0-9]{64}$/.test(model.digest), "Invalid model content digest");
  assert.ok(Number.isSafeInteger(model.size) && Number(model.size) > 0, "Invalid model size");
  const show = await modelMetadata(config, "/api/show", signal, { model: config.endpoint.model });
  assert.ok(typeof show.parameters === "string" && /^num_gpu\s+0\s*$/m.test(show.parameters), "CPU-only acceptance requires model parameter num_gpu 0");
  const threads = /^num_thread\s+(\d+)\s*$/m.exec(show.parameters);
  assert.ok(threads !== null && Number(threads[1]) >= 1 && Number(threads[1]) <= 4, "CPU-only acceptance requires num_thread from 1 to 4");
  return { name: config.endpoint.model, digest: model.digest, size_bytes: Number(model.size), num_gpu: 0, num_thread: Number(threads[1]) };
}

/** Verify the actual loaded runner after each response, before committing decisions or fitting. @internal */
export async function verifyCpuRunner(config: SystemOneLoopConfig, model: LiveModelEvidence, signal: AbortSignal): Promise<void> {
  const status = await modelMetadata(config, "/api/ps", signal);
  assert.ok(Array.isArray(status.models), "Ollama runner inventory is missing");
  const runner = status.models.find((entry: unknown) => entry !== null && typeof entry === "object" && "name" in entry && entry.name === model.name) as Record<string, unknown> | undefined;
  assert.ok(runner !== undefined && runner.digest === model.digest && runner.size_vram === 0, "The decision runner must match the pinned model and use zero GPU bytes");
}

/** Materialize canonical checkpoint bytes and verify their hash against the policy identity. */
function writeCheckpoint(root: string, config: SystemOneLoopConfig, checkpoint: SystemOneCheckpoint): string {
  const file = `${checkpoint.digest.slice(7)}.json`;
  const bytes = canonicalJson(systemOneCheckpointJson(checkpoint.parameters, config.questions));
  writeFileSync(join(root, file), bytes, { flag: "wx" });
  assert.equal(`sha256:${createHash("sha256").update(readFileSync(join(root, file))).digest("hex")}`, checkpoint.digest);
  return file;
}

/** Run the real persisted controller, retaining successful and failed evidence inside ignored package state. */
export async function runLiveAcceptance(value: JsonValue, timeoutMs = LIVE_TIMEOUT_MS): Promise<LiveAcceptanceEvidence> {
  assert.ok(Number.isInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= LIVE_TIMEOUT_MS, "Live deadline must be within 15 minutes");
  const started = performance.now();
  const signal = AbortSignal.timeout(timeoutMs);
  const config = parseSystemOneLoopConfig(value);
  const repoRoot = resolve(import.meta.dirname, "..");
  const parent = join(repoRoot, ".agents/pm/runtime/live");
  mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, "run-"));
  try {
    const model = await cpuModelEvidence(config, signal);
    // Own Git metadata keeps the controller's worktree authority inside these artifacts too.
    const git = spawnSync("git", ["init", "--quiet", root], { timeout: 5000 });
    assert.equal(git.status, 0, "Could not initialize artifact-local controller authority");
    writeFileSync(join(root, "programme.json"), JSON.stringify(value, null, 2));
    writeCheckpoint(root, config, config.initial);
    const initialized = await init("rl", { defaults: true, agentGuidance: "skip", author: "codex-agent" }, { cwd: root, pmRoot: join(root, ".agents/pm") });
    const client = new PmClient({ pmRoot: initialized.path, cwd: root, author: "codex-agent", noExtensions: true });
    const approval = await client.create({ id: "approval", type: "Decision", title: "Allow two bounded CPU calibration promotions", body: '```json\n{"permitted_promotions":2}\n```' });
    const report = await runRlLoop(client, { pmRoot: initialized.path, author: "codex-agent" }, {
      id: "live", config: value, approval: String(approval.item.id), signal,
      async onDecision(stage) { if (stage === "response") await verifyCpuRunner(config, model, signal); },
    });
    writeFileSync(join(root, "loop-report.json"), JSON.stringify(report, null, 2));
    assert.equal(report.promoted, 2, `Live acceptance needs two promotions: ${JSON.stringify(report)}`);
    const generations: LiveGenerationEvidence[] = [];
    let source = config.initial;
    let tokens = 0;
    let endpointMs = 0;
    for (const generation of report.generations) {
      const item = await client.get(generation.item);
      const match = /```json\n([\s\S]+?)\n```/.exec(String(item.item.body));
      assert.ok(match !== null);
      const spec = parseGenerationSpec(match[1], "live generation");
      const stored = parseStoredSystemOneGeneration(spec.training_config as JsonValue, config.questions, "live generation");
      const candidate = systemOneCheckpoint(stored.candidateParameters, config.questions);
      assert.notEqual(candidate.digest, source.digest);
      assert.equal(spec.promoted, true);
      const run = await client.get(generation.run);
      assert.equal(run.item.component, source.digest, "successor collection must use the promoted head");
      const notes = await client.notes(generation.run, { outputBudget: "unbounded", outputLimit: "unbounded" });
      assert.ok(!("output_budget_exceeded" in notes));
      const events = readSeries(notes.notes.map((note) => note.text)).events;
      const heldOut = events.filter((event) => event.metric === SYSTEMONE_HELD_OUT_METRIC).map((event) => parseSystemOneDecisionEvent(event, SYSTEMONE_HELD_OUT_METRIC, config.questions, "live evidence"));
      tokens += stored.usageTokens;
      endpointMs += events.reduce((sum, event) => sum + Number(event.tags!["latency_ms"]), 0);
      generations.push({ generation: generation.generation, item: generation.item, run: generation.run,
        source: source.digest, checkpoint: candidate.digest, checkpoint_file: writeCheckpoint(root, config, candidate),
        collection_digest: stored.collectionDigest, collecting_policy: String(run.item.component),
        promoted: generation.promoted, refusal_reason: generation.refusal_reason,
        accuracy_before: systemOneAccuracy(heldOut, config.evaluation, config.questions, source), accuracy_after: systemOneAccuracy(heldOut, config.evaluation, config.questions, candidate),
        ece_before: systemOneCalibrationError(heldOut, config.evaluation, config.questions, source, 10), ece_after: systemOneCalibrationError(heldOut, config.evaluation, config.questions, candidate, 10),
        held_out_mean_before: stored.incumbentHeldOutMean, held_out_mean_after: stored.candidateHeldOutMean,
        evaluation_samples: stored.evaluationSamples, tokens: stored.usageTokens, decisions: events });
      source = candidate;
    }
    const elapsedMs = performance.now() - started;
    signal.throwIfAborted();
    assert.ok(elapsedMs <= timeoutMs, "Live run exceeded its whole-run deadline");
    const evidence: LiveAcceptanceEvidence = { model, programme: config.digest, training_digest: config.trainingDigest, evaluation_digest: config.evaluationDigest,
      artifacts: relative(repoRoot, root), initial_checkpoint: config.initial.digest, generations, tokens,
      elapsed_ms: elapsedMs, wall_ms_per_query: elapsedMs / report.samples_consumed, endpoint_ms: endpointMs,
      endpoint_ms_per_query: endpointMs / report.samples_consumed, queries: report.samples_consumed, timeout_ms: timeoutMs, stop_reason: report.stop_reason };
    writeFileSync(join(root, "summary.json"), JSON.stringify(evidence, null, 2));
    return evidence;
  } catch (error) {
    // Retain failure evidence without copying possibly private filesystem diagnostics.
    try {
      writeFileSync(join(root, "failure.json"), JSON.stringify({ failed: true, deadline_aborted: signal.aborted }));
    } catch {
      // Evidence is best effort; preserve the original acceptance error.
    }
    throw error;
  }
}

/** Execute the opt-in live script with configurable local endpoint coordinates. */
export async function main(environment: Readonly<Record<string, string | undefined>>, print: (text: string) => void): Promise<void> {
  const result = await runLiveAcceptance(liveConfiguration(environment["SYSTEMONE_BASE_URL"], environment["SYSTEMONE_MODEL"]));
  print(JSON.stringify(result, null, 2));
}

if (isMainInvocation(process.argv, import.meta.url)) await main(process.env, console.log);
