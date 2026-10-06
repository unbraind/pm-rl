/** The persisted language-model loop: real CLI acceptance, receipts, resume and refusals. */
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { PmClient } from "@unbrained/pm-cli/sdk/core";
import { init, isPmCliExpectedError } from "@unbrained/pm-cli/sdk/runtime";
import { createExtensionTestHarness, type ExtensionTestHarness } from "@unbrained/pm-cli/sdk/testing";
import { encodeEventSegments, readSeries, type MetricEvent } from "../series.ts";
import { parseGenerationSpec } from "../lineage.ts";
import { lmCollectBatch, parseLmCollectionEvent, parseLmLoopConfig, serializeLmCheckpoint, LM_COLLECTION_METRIC, type LmLoopConfig, type LmObservation } from "../lm.ts";
import extension, {
  runRlLoop, resumeRlLoop, rlLoopStatus,
  RL_ITEM_TYPES, type JsonValue, type RlCommandResult, type RlLoopReport,
} from "../index.ts";

const roots: string[] = [];

after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

/** The measured language-model acceptance programme, exactly as shipped. */
const LM_CONFIG: JsonValue = JSON.parse(readFileSync(new URL("../examples/loop-lm.json", import.meta.url), "utf8")) as JsonValue;

/** A small language-model programme for the cheap durable-execution drills. */
function smallConfig(overrides: Record<string, unknown> = {}): Record<string, JsonValue> {
  return {
    trainer: "lm",
    environment: { name: "LM rotate small", version: "1" },
    task: "rotate",
    alphabet: ["0", "1", "2"],
    string_length: 2,
    model: { d_model: 8, ffn: 12, layers: 1, rank: 2 },
    limits: { max_parameters: 1024, max_checkpoint_bytes: 8192, max_steps: 256, max_wall_seconds: 60, model_license: "MIT", dataset_license: "MIT" },
    training: [{ id: "t0", string: "00" }, { id: "t1", string: "12" }, { id: "t2", string: "21" }, { id: "t3", string: "02" }, { id: "t4", string: "11" }],
    evaluation: [{ id: "h0", string: "01" }, { id: "h1", string: "22" }, { id: "h2", string: "10" }, { id: "h3", string: "20" }],
    seed: 11,
    max_generations: 2,
    samples_per_generation: 32,
    budget: 64,
    learning_rate: 0.8,
    fit_steps: 12,
    kl_weight: 0.01,
    clip_norm: 0.5,
    minimum_improvement: 0.01,
    maximum_gap: 0.5,
    evaluation_samples: 400,
    confidence: 0.9,
    min_samples: 5,
    ...overrides,
  };
}

/** Create a real initialized tracker, persist the public schema, and activate the extension. */
async function workspace(): Promise<{
  root: string;
  pmRoot: string;
  client: PmClient;
  harness: ExtensionTestHarness;
}> {
  const root = mkdtempSync(join(tmpdir(), "pm-rl-lm-loop-test-"));
  roots.push(root);
  const initialized = await init("rl", { defaults: true, author: "pm-rl-test", agentGuidance: "skip" }, { cwd: root });
  const client = new PmClient({ pmRoot: initialized.path, author: "pm-rl-test" });
  for (const itemType of RL_ITEM_TYPES) {
    await client.schemaAddType(itemType.name, {
      folder: itemType.folder,
      alias: [...(itemType.aliases ?? [])],
      description: itemType.description,
      defaultStatus: itemType.default_status,
    });
  }
  const harness = await createExtensionTestHarness(extension, { name: "pm-rl", capabilities: ["commands", "hooks", "schema"] });
  assert.deepEqual(harness.activation.failed, []);
  return { root, pmRoot: initialized.path, client, harness };
}

/** Extract a successful structured command result. */
function resultOf(run: { result?: unknown; handled: boolean }): RlCommandResult {
  assert.equal(run.handled, true, JSON.stringify(run));
  return run.result as RlCommandResult;
}

/** Create the approval Decision that bounds a loop's promotions. */
async function createApproval(client: PmClient, id: string, permittedPromotions: number): Promise<string> {
  const approval = await client.create({
    id,
    title: id,
    type: "Decision",
    status: "open",
    body: `# ${id}\n\n\`\`\`json\n${JSON.stringify({ permitted_promotions: permittedPromotions })}\n\`\`\``,
  });
  return String(approval.item.id);
}

/** Write one JSON document and return its path. */
function writeJson(root: string, name: string, value: unknown): string {
  const path = join(root, name);
  writeFileSync(path, JSON.stringify(value));
  return path;
}

/** Run one loop through the public command surface and return its structured report. */
async function runLoopCommand(harness: ExtensionTestHarness, pmRoot: string, root: string, id: string, config: JsonValue, approval: string): Promise<RlLoopReport> {
  const file = writeJson(root, `${id}.json`, config);
  const run = resultOf(await harness.runCommand({ command: "rl loop run", pmRoot, args: [id], options: { file, approval } }));
  return run.details as unknown as RlLoopReport;
}

/** Strip the resume counter that legitimately differs between two invocations. */
function stable(report: RlLoopReport): RlLoopReport {
  return { ...report, resumed_generations: 0 };
}

/** Extract the JSON fence from one stored generation body and parse it as a spec. */
function generationSpecOf(body: string): ReturnType<typeof parseGenerationSpec> {
  const fenced = /```json\n([\s\S]+?)\n```/.exec(body);
  assert.ok(fenced?.[1] !== undefined, "generation body has no JSON specification fence");
  return parseGenerationSpec(fenced[1], "generation body");
}

/** Assert one expected CLI refusal by its stable machine code. */
function refusalOf(action: () => Promise<unknown> | unknown, code: string): Promise<void> {
  return Promise.resolve(action()).then(() => assert.fail(`expected refusal ${code}`), (error: unknown) => {
    assert.ok(isPmCliExpectedError(error), JSON.stringify(error));
    assert.equal(error.context.code, code);
  });
}

test("pm rl loop run performs real recursive self-improvement on the language model", async () => {
  const { root, pmRoot, client, harness } = await workspace();
  const approval = await createApproval(client, "lm-approval", 8);
  const report = await runLoopCommand(harness, pmRoot, root, "lmloop", LM_CONFIG, approval);
  // Three generations executed: two promoted, the third attempted and refused
  // by the strictly-better held-out gate, which is the recorded stop reason.
  assert.equal(report.stop_reason, "evaluation_rejected");
  assert.equal(report.promoted, 2);
  assert.equal(report.generations.length, 3);
  assert.ok(report.refusal_reason !== null);
  assert.ok(report.samples_consumed <= report.budget);
  const [first, second, third] = report.generations.map((generation) => ({ candidate_checkpoint: generation.candidate_checkpoint }));
  assert.notEqual(first.candidate_checkpoint, second.candidate_checkpoint);
  assert.notEqual(third.candidate_checkpoint, second.candidate_checkpoint);
  // Generation two collects with generation one's promoted adapter: the run's
  // component IS the predecessor's candidate checkpoint, asserted by receipt.
  const generationOne = await client.get("lmloop-g1");
  const generationTwo = await client.get("lmloop-g2");
  const runTwo = await client.get("lmloop-g2-collect");
  const runThree = await client.get("lmloop-g3-collect");
  const specOne = generationSpecOf(String(generationOne.item.body));
  const specTwo = generationSpecOf(String(generationTwo.item.body));
  assert.equal(String(runTwo.item.component), first.candidate_checkpoint);
  assert.equal(String(runThree.item.component), second.candidate_checkpoint);
  assert.equal(specOne.policy, first.candidate_checkpoint);
  assert.equal(specTwo.base_checkpoint, first.candidate_checkpoint);
  assert.equal(specOne.promoted, true);
  assert.equal(specTwo.promoted, true);
  // The receipts record the before/after digests, the parameter delta, the
  // reward and evaluation curve, and the wall time of each generation's fit.
  const trainingOne = specOne.training_config as Record<string, unknown>;
  const trainingTwo = specTwo.training_config as Record<string, unknown>;
  const trainingThree = generationSpecOf(String((await client.get("lmloop-g3")).item.body)).training_config as Record<string, unknown>;
  for (const training of [trainingOne, trainingTwo, trainingThree]) {
    assert.match(String(training.source_checkpoint), /^sha256:[a-f0-9]{64}$/);
    assert.match(String(training.candidate_checkpoint), /^sha256:[a-f0-9]{64}$/);
    assert.ok(Number(training.parameter_delta_l2) > 0);
    assert.ok(Number(training.wall_ms) > 0);
    assert.ok(Number(training.loss_after) < Number(training.loss_before));
  }
  // Held-out exact-match strictly improves over the base: the frozen base
  // copies and cannot rotate, so its exact-match is zero, and the promoted
  // generations move the policy measurably up.
  assert.equal(Number(trainingOne.baseline_exact_match), 0);
  assert.ok(Number(trainingTwo.candidate_exact_match) > 0, `candidate exact match ${trainingTwo.candidate_exact_match}`);
  assert.ok(Number(trainingTwo.candidate_exact_match) > Number(trainingOne.baseline_exact_match));
  // The refused third generation records its refusal in the candidate's
  // history; a refused candidate never becomes a collection policy.
  const thirdGeneration = await client.get("lmloop-g3");
  const thirdComments = await client.comments(String(thirdGeneration.item.id));
  assert.ok(JSON.stringify(thirdComments).includes("refused"), "the refusal is recorded in the candidate's history");
  assert.equal(report.final_checkpoint, second.candidate_checkpoint);
  // Every collection run carries the complete per-sample reward curve.
  for (const [index, generation] of report.generations.entries()) {
    const shown = resultOf(await harness.runCommand({ command: "rl run show", pmRoot, args: [generation.run] }));
    assert.equal((shown.details?.events as unknown[]).length, 64, `generation ${index + 1} event count`);
    assert.ok((shown.details?.events as Array<{ metric: string }>).every((event) => event.metric === LM_COLLECTION_METRIC));
  }
  // The status view reconstructs the same chain without mutating anything.
  const status = resultOf(await harness.runCommand({ command: "rl loop status", pmRoot, args: ["lmloop"] }));
  const details = status.details as { trainer: string; generations: unknown[]; promoted: number; stop_reason: string };
  assert.equal(details.trainer, "lm");
  assert.equal(details.promoted, 2);
  assert.equal(details.generations.length, 3);
  assert.equal(details.stop_reason, "evaluation_rejected");
});

test("the persisted training configuration replays the pure step exactly", async () => {
  const { pmRoot, client } = await workspace();
  const approval = await createApproval(client, "lm-replay-approval", 8);
  const report = await runRlLoop(client, { pmRoot, author: "pm-rl-test" }, { id: "replay", config: smallConfig() as JsonValue, approval });
  assert.ok(report.promoted >= 1, `expected a promotion, got ${report.stop_reason}`);
  const config: LmLoopConfig = parseLmLoopConfig(smallConfig() as JsonValue);
  // The decoded run notes reproduce the deterministic collection batch.
  const notes = await client.notes(report.generations[0]!.run, { outputLimit: "unbounded", outputBudget: "unbounded" });
  assert.ok(!("output_budget_exceeded" in notes));
  const events = readSeries(notes.notes.map((note) => note.text)).events;
  const decoded: LmObservation[] = events.map((event, index) => parseLmCollectionEvent(event, config, `event ${index}`));
  assert.deepEqual(decoded, lmCollectBatch(config, 1, config.initial));
  // The persisted training configuration matches the reported candidate.
  const stored = generationSpecOf(String((await client.get("replay-g1")).item.body));
  const training = stored.training_config as Record<string, unknown>;
  assert.equal(training.candidate_checkpoint, report.generations[0]!.candidate_checkpoint);
  assert.equal(training.source_checkpoint, config.initial.digest);
  assert.ok(Number(training.wall_ms) > 0);
});

test("rerunning one loop id resumes idempotently instead of extending the lineage", async () => {
  const { root, pmRoot, client, harness } = await workspace();
  const approval = await createApproval(client, "lm-small-approval", 8);
  const first = await runLoopCommand(harness, pmRoot, root, "lmsmall", smallConfig() as JsonValue, approval);
  assert.ok(first.promoted >= 1, `expected a promotion, got ${first.stop_reason}`);
  const repeat = await runLoopCommand(harness, pmRoot, root, "lmsmall", smallConfig() as JsonValue, approval);
  assert.deepEqual(stable(repeat), stable(first));
  assert.ok(repeat.resumed_generations >= 1);
  assert.equal((await rlLoopStatus(client, "lmsmall", pmRoot)).promoted, first.promoted);
});

test("a contaminated programme is refused before any completion is collected", async () => {
  const { root, pmRoot, client, harness } = await workspace();
  const approval = await createApproval(client, "lm-contaminated-approval", 8);
  // The held-out set reuses training string content under a new identity.
  const contaminated = smallConfig({ evaluation: [{ id: "h0", string: "12" }, { id: "h1", string: "22" }, { id: "h2", string: "10" }, { id: "h3", string: "20" }] });
  const file = writeJson(root, "contaminated.json", contaminated);
  await refusalOf(() => harness.runCommand({ command: "rl loop run", pmRoot, args: ["dirty"], options: { file, approval } }), "lm_dataset_overlap");
  // Nothing was collected: no run or generation items exist.
  const generations = await client.list({ type: "Generation", status: "all", noTruncate: true });
  assert.equal(generations.items.length, 0);
});

test("configuration limits and runtime clock refusals are recorded without promotion", async () => {
  const { pmRoot, client } = await workspace();
  const approval = await createApproval(client, "limits-approval", 8);
  const value = smallConfig();
  const limits = value.limits as Record<string, JsonValue>;
  for (const [field, limit, code] of [["max_parameters", 1, "lm_limit_parameters_exceeded"], ["max_steps", 60, "lm_limit_steps_exceeded"], ["max_checkpoint_bytes", 1, "lm_limit_checkpoint_bytes"], ["max_wall_seconds", 1e-12, "lm_limit_wall_seconds"], ["model_license", "GPL", "lm_invalid_license"]] as const) {
    await refusalOf(() => runRlLoop(client, { pmRoot, author: "pm-rl-test" }, { id: field, approval, config: { ...value, limits: { ...limits, [field]: limit } } }), code);
    assert.ok(JSON.stringify(await client.comments(approval)).includes(code));
  }
  const now = performance.now.bind(performance);
  try {
    await refusalOf(() => runRlLoop(client, { pmRoot, author: "pm-rl-test" }, {
      id: "clock", approval, config: value,
      onPhase(phase) {
        if (phase === "collect") {
          let elapsed = now();
          performance.now = () => { elapsed += 61_000; return elapsed; };
        }
      },
    }), "lm_limit_wall_seconds");
  } finally {
    performance.now = now;
  }
  assert.ok(JSON.stringify(await client.comments("clock-seed")).includes("execution refused (lm_limit_wall_seconds)"));
});

test("LM status requires artifact authority and refuses missing disk evidence", async () => {
  const { pmRoot, client } = await workspace();
  const approval = await createApproval(client, "artifacts-approval", 8);
  const report = await runRlLoop(client, { pmRoot, author: "pm-rl-test" }, { id: "artifacts", config: smallConfig({ max_generations: 1 }), approval });
  await refusalOf(() => rlLoopStatus(client, "artifacts"), "lm_missing_artifact_root");
  const item = await client.get(report.generations[0]!.item);
  const receipt = generationSpecOf(String(item.item.body)).training_config as Record<string, unknown>;
  rmSync(join(pmRoot, String(receipt.checkpoint_path)));
  await refusalOf(() => rlLoopStatus(client, "artifacts", pmRoot), "lm_checkpoint_artifact_missing");
});

test("an oversized candidate is recorded and replayable without materializing its checkpoint", async () => {
  const { pmRoot, client } = await workspace();
  const approval = await createApproval(client, "bytes-approval", 8);
  const value = smallConfig();
  const config = parseLmLoopConfig(value);
  const limit = serializeLmCheckpoint(config.initial, config).bytes;
  const report = await runRlLoop(client, { pmRoot, author: "pm-rl-test" }, { id: "bytes", approval,
    config: { ...value, limits: { ...(value.limits as Record<string, JsonValue>), max_checkpoint_bytes: limit } } });
  assert.equal(report.stop_reason, "checkpoint_limit_exceeded");
  assert.equal(report.promoted, 0);
  assert.equal((await rlLoopStatus(client, "bytes", pmRoot)).stop_reason, "checkpoint_limit_exceeded");
});

test("incomplete post-collection evidence refuses fitting", async () => {
  const { pmRoot, client } = await workspace();
  const approval = await createApproval(client, "incomplete-approval", 8);
  await refusalOf(() => runRlLoop(client, { pmRoot, author: "pm-rl-test" }, { id: "incomplete", approval, config: smallConfig(),
    onPhase(phase) {
      if (phase === "collect") client.notes = (async (id: string) => ({ id, notes: [], count: 0 })) as PmClient["notes"];
    },
  }), "loop_generation_drift");
});

test("a stored candidate cannot resume after its collection evidence disappears", async () => {
  const { pmRoot, client } = await workspace();
  const approval = await createApproval(client, "lost-evidence-approval", 8);
  await assert.rejects(runRlLoop(client, { pmRoot, author: "pm-rl-test" }, { id: "lost-evidence", approval, config: smallConfig(),
    onPhase(phase) { if (phase === "train") throw new Error("pause after candidate"); },
  }), /pause after candidate/);
  client.notes = (async (id: string) => ({ id, notes: [], count: 0 })) as PmClient["notes"];
  await refusalOf(() => rlLoopStatus(client, "lost-evidence", pmRoot), "loop_generation_drift");
});

test("an exhausted promotion budget refuses the persisted promotion and records the refusal", async () => {
  const { root, pmRoot, client, harness } = await workspace();
  const approval = await createApproval(client, "lm-single-approval", 1);
  const report = await runLoopCommand(harness, pmRoot, root, "lmsingle", smallConfig({ max_generations: 2 }) as JsonValue, approval);
  assert.equal(report.stop_reason, "promotion_refused");
  assert.equal(report.promoted, 1);
  assert.ok(report.refusal_reason !== null);
  const comments = await client.comments(report.generations[1]!.item);
  assert.ok(JSON.stringify(comments).includes("promotion refused"));
  assert.equal((await rlLoopStatus(client, "lmsingle", pmRoot)).stop_reason, "promotion_refused");
});

test("an exhausted sample budget stops the loop before collecting past its bound", async () => {
  const { root, pmRoot, client, harness } = await workspace();
  const approval = await createApproval(client, "lm-budget-approval", 8);
  const report = await runLoopCommand(harness, pmRoot, root, "lmbudget", smallConfig({ budget: 32, max_generations: 3 }) as JsonValue, approval);
  assert.equal(report.stop_reason, "budget_exhausted");
  assert.ok(report.generations.length >= 1);
  assert.ok(report.samples_consumed <= 32);
  assert.match(report.refusal_reason ?? "", /sample budget 32 exhausted/);
});

test("a cancellation at the collection boundary resumes from persisted evidence", async () => {
  const { pmRoot, client } = await workspace();
  const approval = await createApproval(client, "lm-resume-approval", 8);
  const controller = new AbortController();
  await assert.rejects(runRlLoop(client, { pmRoot, author: "pm-rl-test" }, { id: "partial", config: smallConfig() as JsonValue, approval, signal: controller.signal,
    onPhase(phase) { if (phase === "collect") controller.abort(); } }), (error: unknown) => {
    assert.ok(isPmCliExpectedError(error), String(error));
    assert.equal(error.context.code, "loop_cancelled");
    return true;
  });
  // The interrupted loop stands with a complete, closed collection run whose
  // fit never executed; the status view names that exact phase.
  const status = await rlLoopStatus(client, "partial", pmRoot);
  assert.equal(status.trainer, "lm");
  assert.equal(status.generations[0]?.phase, "collected");
  assert.equal(status.samples_consumed, 32);
  const report = await resumeRlLoop(client, { pmRoot, author: "pm-rl-test" }, { id: "partial", approval });
  assert.ok(report.promoted >= 1, `expected a promotion, got ${report.stop_reason}`);
  assert.ok(report.samples_consumed <= 64);
  const repeated = await resumeRlLoop(client, { pmRoot, author: "pm-rl-test" }, { id: "partial", approval });
  assert.deepEqual(stable(repeated), stable(report));
  assert.equal((await rlLoopStatus(client, "partial", pmRoot)).stop_reason, report.stop_reason);
});

test("collection evidence corruption and tampered lineage refuse advancement", async () => {
  for (const fault of ["foreign-example", "rewritten-reward", "overflow"] as const) {
    const { pmRoot, client } = await workspace();
    const approval = await createApproval(client, `lm-drift-${fault}`, 8);
    await assert.rejects(runRlLoop(client, { pmRoot, author: "pm-rl-test" }, { id: "drift", config: smallConfig() as JsonValue, approval,
      onPhase(phase) { if (phase === "collect") throw new Error("pause"); } }), /pause/);
    const notes = client.notes.bind(client);
    client.notes = (async (id: string, options?: Parameters<PmClient["notes"]>[1]) => {
      const result = await notes(id, options);
      assert.ok(!("output_budget_exceeded" in result));
      const noteList = (result as { notes: Array<{ text: string }> }).notes;
      const events: MetricEvent[] = [...readSeries(noteList.map((note) => note.text)).events];
      if (events.length > 0) {
        const first = events[0]!;
        if (fault === "foreign-example") events[events.indexOf(first)] = { ...first, tags: { ...first.tags, example: "foreign" } };
        if (fault === "rewritten-reward") events[events.indexOf(first)] = { ...first, value: first.value === 0 ? 1 : 0 };
        if (fault === "overflow") events.push({ ...first, step: events.length });
      }
      return { ...result, notes: encodeEventSegments(events).map((text) => ({ text, author: "test", created_at: "2026-01-01T00:00:00.000Z" })) } as Awaited<ReturnType<PmClient["notes"]>>;
    }) as PmClient["notes"];
    await refusalOf(() => rlLoopStatus(client, "drift", pmRoot), "loop_generation_drift");
  }
  // A tampered run component is refused before any evidence is read.
  const { pmRoot, client } = await workspace();
  const approval = await createApproval(client, "lm-drift-component", 8);
  await assert.rejects(runRlLoop(client, { pmRoot, author: "pm-rl-test" }, { id: "component", config: smallConfig() as JsonValue, approval,
    onPhase(phase) { if (phase === "train") throw new Error("pause"); } }), /pause/);
  const run = await client.get("component-g1-collect");
  await client.update(String(run.item.id), { component: `sha256:${"a".repeat(64)}` });
  await refusalOf(() => rlLoopStatus(client, "component", pmRoot), "loop_generation_drift");
});

test("a tampered candidate checkpoint is refused as invalid before the chain advances", async () => {
  const { pmRoot, client } = await workspace();
  const approval = await createApproval(client, "lm-tamper-approval", 8);
  await assert.rejects(runRlLoop(client, { pmRoot, author: "pm-rl-test" }, { id: "tamper", config: smallConfig() as JsonValue, approval,
    onPhase(phase) { if (phase === "train") throw new Error("pause"); } }), /pause/);
  const candidate = await client.get("tamper-g1");
  const body = String(candidate.item.body);
  const spec = generationSpecOf(body);
  const training = spec.training_config as Record<string, unknown>;
  const tensors = training["candidate_adapter"] as Record<string, number[]>;
  // Rewrite one persisted tensor value: the recorded candidate digest no
  // longer matches the tensors the item carries.
  const rewritten = body.replace(String(tensors.aq![0]), "2");
  assert.notEqual(rewritten, body);
  await client.update(String(candidate.item.id), { body: rewritten });
  await refusalOf(() => rlLoopStatus(client, "tamper", pmRoot), "lm_invalid_checkpoint");
});
