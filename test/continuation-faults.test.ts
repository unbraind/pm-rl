/** Durable continuation rejects damaged receipts and lost evidence in a real tracker. */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { PmClient } from "@unbrained/pm-cli/sdk/core";
import { init, isPmCliExpectedError } from "@unbrained/pm-cli/sdk/runtime";
import { hashJson, runRlLoop, resumeRlLoop, rlLoopStatus, type JsonValue } from "../index.ts";
import {
  jsonLmAdapter, lmCheckpointPath, parseLmCollectionEvent, parseLmLoopConfig,
  restoreLmTraining, serializeLmCheckpoint,
} from "../lm.ts";
import { encodeEventSegments, readSeries } from "../series.ts";

const AUTHOR = "codex-sol-faults";
const LOOP = "faults";
const FOREIGN_DIGEST = `sha256:${"a".repeat(64)}`;

/** One bounded, real rotate model shared by all sequential continuation faults. */
const CONFIG: Record<string, JsonValue> = {
  trainer: "lm",
  environment: { name: "LM continuation faults", version: "1" },
  task: "rotate", alphabet: ["0", "1", "2"], string_length: 2,
  model: { d_model: 8, ffn: 12, layers: 1, rank: 2 },
  limits: { max_parameters: 1024, max_checkpoint_bytes: 8192, max_steps: 256,
    max_wall_seconds: 60, model_license: "MIT", dataset_license: "MIT" },
  training: [{ id: "t0", string: "00" }, { id: "t1", string: "12" },
    { id: "t2", string: "21" }, { id: "t3", string: "02" }, { id: "t4", string: "11" }],
  evaluation: [{ id: "h0", string: "01" }, { id: "h1", string: "22" },
    { id: "h2", string: "10" }, { id: "h3", string: "20" }],
  seed: 11, max_generations: 1, samples_per_generation: 32, budget: 32,
  learning_rate: 0.8, fit_steps: 12, kl_weight: 0.01, clip_norm: 0.5,
  minimum_improvement: 0.01, maximum_gap: 0.5, evaluation_samples: 400,
  confidence: 0.9, min_samples: 5,
};

/** Read the entire persisted body; projection ceilings would hide large LM receipts. */
async function storedBody(client: PmClient, id: string): Promise<string> {
  const result = await client.get(id, { depth: "standard", outputBudget: "unbounded", outputLimit: "unbounded" });
  assert.ok("item" in result);
  const body = result.item.body;
  assert.ok(typeof body === "string");
  return body;
}

/** Narrow a fixture's JSON object without weakening the test's TypeScript contract. */
function object(value: JsonValue): Record<string, JsonValue> {
  assert.ok(value !== null && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, JsonValue>;
}

/** Decode a valid fixture receipt; faults are introduced only after this read. */
function receipt(body: string): Record<string, JsonValue> {
  return object(JSON.parse(body) as JsonValue);
}

/** Preserve a valid envelope checksum while changing the payload's semantic evidence. */
function changedResult(body: string, change: (value: Record<string, JsonValue>) => void): string {
  const envelope = receipt(body);
  const result = object(envelope.result!);
  change(result);
  envelope.digest = hashJson(result);
  return JSON.stringify(envelope);
}

/** Restore the exact receipt even when a regression assertion fails. */
async function withBody(client: PmClient, id: string, body: string, action: () => Promise<void>): Promise<void> {
  const original = await storedBody(client, id);
  await client.update(id, { body });
  try { await action(); }
  finally { await client.update(id, { body: original }); }
}

/** Assert the caller receives a stable refusal, including when the parser throws synchronously. */
async function refuses(action: () => unknown, codes: readonly string[]): Promise<void> {
  await assert.rejects(async () => { await action(); }, (error: unknown) => {
    assert.ok(isPmCliExpectedError(error), `expected a typed refusal, received ${String(error)}`);
    assert.ok(codes.includes(String(error.context.code)), `unexpected refusal ${String(error.context.code)}`);
    return true;
  });
}

test("one paused tiny-LM loop refuses receipt corruption and lost collection evidence", async (context) => {
  const root = mkdtempSync(join(tmpdir(), "pm-rl-continuation-faults-"));
  try {
    const initialized = await init("rl", { defaults: true, agentGuidance: "skip", author: AUTHOR }, { cwd: root, pmRoot: join(root, ".agents", "pm") });
    const pmRoot = initialized.path;
    const client = new PmClient({ pmRoot, cwd: root, author: AUTHOR, noExtensions: true });
    const approval = String((await client.create({ id: "approval", title: "One bounded promotion", type: "Decision",
      body: '```json\n{"permitted_promotions":1}\n```' })).item.id);
    const coordinates = { pmRoot, author: AUTHOR };
    const collectId = `${LOOP}-g1-step-collect`;
    const trainId = `${LOOP}-g1-step-train`;
    const evaluateId = `${LOOP}-g1-step-evaluate`;
    const runId = `${LOOP}-g1-collect`;
    const candidateId = `${LOOP}-g1`;
    const status = () => rlLoopStatus(client, LOOP, pmRoot);
    const resume = () => resumeRlLoop(client, coordinates, { id: LOOP, approval });

    // A completed fit exists, but no candidate has been registered at this boundary.
    await assert.rejects(runRlLoop(client, coordinates, { id: LOOP, config: CONFIG, approval,
      onPhase(phase) { if (phase === "train") throw new Error("pause after durable fit"); } }), /pause after durable fit/);
    const collectedStatus = await status();
    assert.equal(collectedStatus.promoted, 0);
    assert.equal(collectedStatus.samples_consumed, 32);
    assert.equal(collectedStatus.generations[0]?.item, null);
    const collectBody = await storedBody(client, collectId);
    const trainBody = await storedBody(client, trainId);
    const collection = receipt(collectBody);
    const withoutResult = { ...collection };
    delete withoutResult.result;

    const envelopeFaults: ReadonlyArray<readonly [string, string]> = [
      ["malformed JSON", '{"format":'],
      ["null JSON", "null"],
      ["array JSON", "[]"],
      ["scalar JSON", "true"],
      ["foreign format", JSON.stringify({ ...collection, format: "foreign" })],
      ["foreign step key", JSON.stringify({ ...collection, key: `${LOOP}-g2-step-collect` })],
      ["foreign input identity", JSON.stringify({ ...collection, input: "0".repeat(64) })],
      ["unknown state", JSON.stringify({ ...collection, state: "finished" })],
      ["missing completed result", JSON.stringify(withoutResult)],
      ...[null, [], true].map((result) => [`non-object result ${JSON.stringify(result)}`, JSON.stringify({ ...collection, result, digest: hashJson(result) })] as const),
      ["damaged result digest", JSON.stringify({ ...collection, digest: "0".repeat(64) })],
      ["rewritten result without a new digest", JSON.stringify({ ...collection, result: { run: "foreign", events: [] } })],
    ];
    for (const [name, body] of envelopeFaults) {
      await context.test(`completed collection receipt rejects ${name}`, async () => {
        await withBody(client, collectId, body, async () => {
          await refuses(status, ["loop_step_drift"]);
          await refuses(resume, ["loop_step_drift"]);
        });
      });
    }

    const training = object(receipt(trainBody).result!);
    const trainingFaults: ReadonlyArray<readonly [string, JsonValue]> = [
      ["generation", 2], ["source_checkpoint", FOREIGN_DIGEST],
      ["candidate_checkpoint", FOREIGN_DIGEST], ["collection_digest", FOREIGN_DIGEST],
      ["parameter_delta_l2", Number(training.parameter_delta_l2) + 1],
    ];
    for (const [field, value] of trainingFaults) {
      await context.test(`resume refuses a rehashed fit with foreign ${field}`, async () => {
        await withBody(client, trainId, changedResult(trainBody, (result) => { result[field] = value; }), async () => {
          await refuses(resume, ["lm_invalid_checkpoint", "loop_step_drift", "loop_generation_drift"]);
        });
      });
    }
    await context.test("resume refuses rehashed fit tensors that no longer identify its candidate", async () => {
      const damaged = changedResult(trainBody, (result) => {
        const tensors = object(result.candidate_adapter!);
        const values = tensors.aq;
        assert.ok(Array.isArray(values));
        values[0] = Number(values[0]) + 1;
      });
      await withBody(client, trainId, damaged, async () => {
        await refuses(resume, ["lm_invalid_checkpoint", "loop_step_drift", "loop_generation_drift"]);
      });
    });

    const config = parseLmLoopConfig(CONFIG);
    const notes = await client.notes(runId, { outputBudget: "unbounded", outputLimit: "unbounded" });
    assert.ok(!("output_budget_exceeded" in notes));
    const savedNotes = notes.notes;
    assert.equal(savedNotes.length, 1, "tiny fixture must fit in one metric segment");
    const events = readSeries(savedNotes.map((note) => note.text)).events;
    assert.equal(events.length, config.samplesPerGeneration);
    const observations = events.map((event, index) => parseLmCollectionEvent(event, config, `fixture event ${index}`));
    await context.test("a saved fit cannot bind a reordered real collection batch", async () => {
      assert.notDeepEqual([...observations].reverse(), observations);
      await refuses(() => restoreLmTraining(training, config, 1, config.initial, [...observations].reverse()), ["lm_invalid_checkpoint"]);
    });

    /** Corrupt real stored annotations while leaving the completed collection receipt intact. */
    async function evidenceFaults(boundary: string): Promise<void> {
      for (const [name, retained] of [["missing", []], ["truncated", events.slice(0, -1)]] as const) {
        await context.test(`${boundary}: completed collection cannot accept ${name} run evidence`, async () => {
          const replacement = encodeEventSegments(retained)[0] ?? "Collection evidence removed for the fault drill.";
          await client.notes(runId, { edit: 1, add: replacement });
          try {
            await refuses(status, ["loop_generation_drift"]);
            await refuses(resume, ["loop_generation_drift"]);
          } finally {
            await client.notes(runId, { edit: 1, add: savedNotes[0]!.text });
          }
        });
      }
    }
    await evidenceFaults("before candidate registration");

    // Reuse the same fit and batch, pausing after evaluation registers the candidate.
    await assert.rejects(resumeRlLoop(client, coordinates, { id: LOOP, approval,
      onPhase(phase) { if (phase === "evaluate") throw new Error("pause after durable evaluation"); } }), /pause after durable evaluation/);
    assert.equal(await storedBody(client, trainId), trainBody);
    const evaluatedStatus = await status();
    assert.equal(evaluatedStatus.promoted, 0);
    assert.equal(typeof evaluatedStatus.generations[0]?.item, "string");
    const evaluateBody = await storedBody(client, evaluateId);
    const evaluation = object(receipt(evaluateBody).result!);
    const evaluationFaults: ReadonlyArray<readonly [string, JsonValue]> = [
      ["generation", 2], ["source_checkpoint", FOREIGN_DIGEST], ["collection_digest", FOREIGN_DIGEST],
      ["loss_before", Number(evaluation.loss_before) + 1], ["loss_after", Number(evaluation.loss_after) + 1],
      ["parameter_delta_l2", Number(evaluation.parameter_delta_l2) + 1],
      ["learning_rate", Number(evaluation.learning_rate) / 2],
      ["evaluation_samples", Number(evaluation.evaluation_samples) + 1],
    ];
    for (const [field, value] of evaluationFaults) {
      await context.test(`candidate continuation refuses a rehashed evaluation with foreign ${field}`, async () => {
        await withBody(client, evaluateId, changedResult(evaluateBody, (result) => { result[field] = value; }), async () => {
          await refuses(status, ["loop_generation_drift", "loop_step_drift", "lm_invalid_checkpoint"]);
          await refuses(resume, ["loop_generation_drift", "loop_step_drift", "lm_invalid_checkpoint"]);
        });
      });
    }
    await context.test("evaluation cannot substitute a valid checkpoint different from its durable fit", async () => {
      assert.notEqual(config.initial.digest, training.candidate_checkpoint);
      const changed = changedResult(evaluateBody, (result) => {
        result.candidate_adapter = jsonLmAdapter(config.initial.adapter);
        result.candidate_checkpoint = config.initial.digest;
        result.checkpoint_path = lmCheckpointPath(config.initial);
        result.checkpoint_bytes = serializeLmCheckpoint(config.initial, config).bytes;
      });
      await withBody(client, evaluateId, changed, async () => {
        await refuses(status, ["loop_generation_drift", "loop_step_drift", "lm_invalid_checkpoint"]);
        await refuses(resume, ["loop_generation_drift", "loop_step_drift", "lm_invalid_checkpoint"]);
      });
    });
    await context.test("a registered candidate cannot disagree with its intact evaluation receipt", async () => {
      const body = await storedBody(client, candidateId);
      const fenced = /```json\n([\s\S]+?)\n```/.exec(body);
      assert.ok(fenced?.[1] !== undefined);
      const spec = receipt(fenced[1]);
      const candidateTraining = object(spec.training_config!);
      candidateTraining.wall_ms = Number(candidateTraining.wall_ms) + 1;
      await withBody(client, candidateId, body.replace(fenced[1], JSON.stringify(spec)), async () => {
        await refuses(status, ["loop_step_drift", "loop_generation_drift", "lm_invalid_checkpoint"]);
        await refuses(resume, ["loop_step_drift", "loop_generation_drift", "lm_invalid_checkpoint"]);
      });
    });
    await evidenceFaults("after candidate registration");

    await context.test("legacy LM candidates cannot hide missing collection evidence", async () => {
      await withBody(client, collectId, JSON.stringify({ ...receipt(collectBody), state: "running" }), async () => {
        await client.notes(runId, { edit: 1, add: "Legacy collection evidence removed for the fault drill." });
        try {
          await refuses(status, ["loop_generation_drift"]);
          await refuses(resume, ["loop_generation_drift"]);
        } finally { await client.notes(runId, { edit: 1, add: savedNotes[0]!.text }); }
      });
    });

    await context.test("restoring all evidence permits one promotion without collecting or fitting again", async () => {
      const phases: string[] = [];
      const report = await resumeRlLoop(client, coordinates, { id: LOOP, approval,
        onPhase(phase) { phases.push(phase); } });
      assert.ok(!phases.some((phase) => ["collect", "train", "evaluate"].includes(phase)), "completed work was repeated");
      assert.equal(report.stop_reason, "generation_limit");
      assert.equal(report.promoted, 1);
      assert.equal(report.samples_consumed, config.samplesPerGeneration);
      assert.equal(report.generations.length, 1);
      assert.equal(report.final_checkpoint, training.candidate_checkpoint);
      assert.equal(await storedBody(client, collectId), collectBody);
      assert.equal(await storedBody(client, trainId), trainBody);
      assert.equal(await storedBody(client, evaluateId), evaluateBody);
      const restored = await client.notes(runId, { outputBudget: "unbounded", outputLimit: "unbounded" });
      assert.ok(!("output_budget_exceeded" in restored));
      assert.deepEqual(restored.notes.map((note) => note.text), savedNotes.map((note) => note.text));
      const again = await resume();
      assert.deepEqual({ ...again, resumed_generations: 0 }, { ...report, resumed_generations: 0 });
    });
    await context.test("legacy LM records without step receipts retain deterministic verification", async () => {
      const legacyCollection = JSON.stringify({ ...receipt(collectBody), state: "running" });
      const legacyTraining = JSON.stringify({ ...receipt(trainBody), state: "running" });
      const legacyEvaluation = JSON.stringify({ ...receipt(evaluateBody), state: "running" });
      await withBody(client, collectId, legacyCollection, async () => {
        await withBody(client, trainId, legacyTraining, async () => {
          await withBody(client, evaluateId, legacyEvaluation, async () => {
            assert.equal((await status()).promoted, 1);
            assert.equal((await resume()).promoted, 1);
          });
        });
      });
    });
    await context.test("a completed promotion receipt cannot silently repromote a reverted generation", async () => {
      const body = await storedBody(client, candidateId);
      const fenced = /```json\n([\s\S]+?)\n```/.exec(body);
      assert.ok(fenced?.[1] !== undefined);
      const spec = receipt(fenced[1]);
      Object.assign(spec, { promoted: false, approval: null, proxy_score: null,
        held_out_score: null, gap: null, promotion_evidence: null });
      const reverted = body.replace(fenced[1], JSON.stringify(spec));
      const promotionBody = await storedBody(client, `${LOOP}-g1-step-promote`);
      await withBody(client, candidateId, reverted, async () => {
        await refuses(resume, ["loop_step_drift"]);
        assert.equal(await storedBody(client, candidateId), reverted);
        assert.equal(await storedBody(client, `${LOOP}-g1-step-promote`), promotionBody);
      });
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
