/** Real two-generation acceptance for a frozen System One model; CI supplies a local HTTP server. */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PmClient } from "@unbrained/pm-cli/sdk/core";
import { init } from "@unbrained/pm-cli/sdk/runtime";
import { runRlLoop, type JsonValue } from "../index.ts";
import {
  parseSystemOneLoopConfig, parseStoredSystemOneGeneration, parseSystemOneDecisionEvent,
  systemOneCheckpoint, systemOneAccuracy, systemOneCalibrationError,
  SYSTEMONE_HELD_OUT_METRIC,
} from "../systemone.ts";
import { readSeries } from "../series.ts";
import { parseGenerationSpec } from "../lineage.ts";
import { isMainInvocation } from "./script-launcher.ts";

/** Build synthetic PM item routing examples and a bounded calibration programme. */
export function liveConfiguration(baseURL = "http://localhost:11434", model = "tev1:4b"): JsonValue {
  return {
    trainer: "systemone", environment: { name: "Synthetic PM item routing", version: "1" },
    decision_model: { base_url: baseURL, model, timeout_ms: 120000 },
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

/** Run the real persisted controller and return measured evidence without retaining scratch data. */
export async function runLiveAcceptance(value: JsonValue): Promise<Record<string, unknown>> {
  const config = parseSystemOneLoopConfig(value);
  const root = mkdtempSync(join(tmpdir(), "pm-rl-live-"));
  try {
    const initialized = await init("rl", { defaults: true, agentGuidance: "skip", author: "rl-acceptance" }, { cwd: root });
    const client = new PmClient({ pmRoot: initialized.path, cwd: root, author: "rl-acceptance" });
    const approval = await client.create({ id: "approval", type: "Decision", title: "Allow two bounded calibration promotions", body: '```json\n{"permitted_promotions":2}\n```' });
    const started = performance.now();
    const report = await runRlLoop(client, { pmRoot: initialized.path, author: "rl-acceptance" }, { id: "live", config: value, approval: String(approval.item.id) });
    const elapsedMs = performance.now() - started;
    assert.equal(report.promoted, 2, `Live acceptance needs two promotions: ${JSON.stringify(report)}`);
    const generations: Record<string, unknown>[] = [];
    let source = config.initial;
    let tokens = 0;
    let endpointMs = 0;
    for (const generation of report.generations) {
      const item = await client.get(generation.item!);
      const match = /```json\n([\s\S]+?)\n```/.exec(String(item.item.body));
      assert.ok(match !== null);
      const spec = parseGenerationSpec(match[1], "live generation");
      const stored = parseStoredSystemOneGeneration(spec.training_config as JsonValue, config.questions, "live generation");
      const candidate = systemOneCheckpoint(stored.candidateParameters, config.questions);
      assert.notEqual(candidate.digest, source.digest);
      const run = await client.get(generation.run!);
      assert.equal(run.item.component, source.digest, "successor collection must use the promoted head");
      const notes = await client.notes(generation.run!, { outputBudget: "unbounded", outputLimit: "unbounded" });
      assert.ok(!("output_budget_exceeded" in notes));
      const events = readSeries(notes.notes.map((note) => note.text)).events;
      const heldOut = events.filter((event) => event.metric === SYSTEMONE_HELD_OUT_METRIC).map((event) => parseSystemOneDecisionEvent(event, SYSTEMONE_HELD_OUT_METRIC, config.questions, "live evidence"));
      tokens += stored.usageTokens;
      endpointMs += events.reduce((sum, event) => sum + Number(event.tags!["latency_ms"]), 0);
      generations.push({ generation: generation.generation, source: source.digest, checkpoint: candidate.digest,
        accuracy_before: systemOneAccuracy(heldOut, config.evaluation, config.questions, source), accuracy_after: systemOneAccuracy(heldOut, config.evaluation, config.questions, candidate),
        ece_before: systemOneCalibrationError(heldOut, config.evaluation, config.questions, source, 10), ece_after: systemOneCalibrationError(heldOut, config.evaluation, config.questions, candidate, 10),
        held_out_mean_before: stored.incumbentHeldOutMean, held_out_mean_after: stored.candidateHeldOutMean, tokens: stored.usageTokens });
      source = candidate;
    }
    return { model: config.endpoint.model, generations, tokens, elapsed_ms: elapsedMs, wall_ms_per_query: elapsedMs / report.samples_consumed, endpoint_ms: endpointMs, endpoint_ms_per_query: endpointMs / report.samples_consumed, queries: report.samples_consumed };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/** Execute the opt-in live script with configurable endpoint coordinates. */
export async function main(environment: Readonly<Record<string, string | undefined>>, print: (text: string) => void): Promise<void> {
  const result = await runLiveAcceptance(liveConfiguration(environment["SYSTEMONE_BASE_URL"], environment["SYSTEMONE_MODEL"]));
  print(JSON.stringify(result, null, 2));
}

if (isMainInvocation(process.argv, import.meta.url)) await main(process.env, console.log);
