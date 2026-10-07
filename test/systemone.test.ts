/** Calibration head, checkpoint guards and the real HTTP decision boundary. */
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { after, test } from "node:test";
import { isPmCliExpectedError } from "@unbrained/pm-cli/sdk/runtime";
import { parseLoopProgramme, parseLoopTrainer } from "../loop.ts";
import {
  calibratedProbabilities, executeSystemOneStep, fitSystemOneHead, jsonHeadParameters,
  neutralSystemOneHead, parseStoredSystemOneGeneration, parseSystemOneDecisionEvent,
  parseSystemOneHeadParameters, parseSystemOneLoopConfig, requestSystemOneDecision,
  sampleSystemOneActions, systemOneAccuracy, systemOneCalibrationError, systemOneCheckpoint,
  systemOneDecisionEvent, systemOneEnvironmentSpec, systemOneGenerationTrainingConfig,
  systemOnePromotionScores, systemOneRunConfig, systemOneSampleSeed, systemOneSeedTrainingConfig,
  systemOneState, validatedSystemOneDatasets, verifyStoredSystemOneGeneration,
  SYSTEMONE_COLLECTION_METRIC, SYSTEMONE_HELD_OUT_METRIC, MAX_SYSTEMONE_EXAMPLES,
  verifySystemOneReceiptEvent, systemOneDecisionRequestId,
  type SystemOneObservation,
} from "../systemone.ts";
import type { JsonValue } from "../index.ts";
import { configValue } from "./fixtures/systemone.ts";

const servers: Server[] = [];
after(() => { for (const server of servers) { server.closeAllConnections(); server.close(); } });

/** Assert a stable expected refusal without depending on incidental prose. */
function refuses(action: () => unknown, code: string): void {
  assert.throws(action, (error: unknown) => isPmCliExpectedError(error) && error.context.code === code);
}

/** Deterministic raw probabilities with genuinely imperfect confidence. */
function observations(prefix: string): SystemOneObservation[] {
  return [
    { example: `${prefix}-bug`, answers: { kind: { Bug: 0.6, Feature: 0.4 } }, reward: 1 },
    { example: `${prefix}-feature`, answers: { kind: { Bug: 0.4, Feature: 0.6 } }, reward: 0 },
  ];
}

/** Listen on a real loopback socket; never replace fetch. */
async function endpoint(response: unknown, status = 200, delay = 0): Promise<string> {
  const server = createServer((request, reply) => {
    assert.equal(request.method, "POST"); assert.equal(request.url, "/v1/systemone");
    let body = "";
    request.on("data", (chunk: Buffer) => { body += chunk.toString(); });
    request.on("end", () => {
      const value = JSON.parse(body) as { model: string; questions: Record<string, unknown> };
      assert.equal(value.model, "tev1:4b"); assert.ok(value.questions.kind);
      setTimeout(() => { reply.writeHead(status); reply.end(typeof response === "string" ? response : JSON.stringify(response)); }, delay);
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => { server.listen(0, "127.0.0.1", resolve); });
  const address = server.address(); assert.ok(address !== null && typeof address !== "string");
  return `http://127.0.0.1:${address.port}`;
}

test("real calibration gradients lower loss, change two checkpoints and replay exactly", () => {
  const config = parseSystemOneLoopConfig(configValue());
  assert.equal(parseLoopProgramme(configValue()).trainer, "systemone");
  assert.equal(parseLoopTrainer({}), "bandit"); refuses(() => parseLoopTrainer({ trainer: "other" }), "loop_invalid_trainer");
  const step = { learningRate: config.learningRate, evaluationSamples: config.evaluationSamples };
  const collection = observations("train"); const heldOut = observations("eval");
  const first = executeSystemOneStep(config, step, 1, config.initial, collection, heldOut, 20);
  const second = executeSystemOneStep(config, step, 2, first.candidate, collection, heldOut, 20);
  assert.ok(first.promoted && second.promoted); assert.ok(first.lossAfter < first.lossBefore);
  assert.notEqual(first.candidate.digest, config.initial.digest); assert.notEqual(second.candidate.digest, first.candidate.digest);
  const storedJson = systemOneGenerationTrainingConfig(config, step, first);
  const stored = parseStoredSystemOneGeneration(storedJson, config.questions, "stored");
  assert.deepEqual(verifyStoredSystemOneGeneration(config, step, config.initial, stored, collection, heldOut), first);
  refuses(() => verifyStoredSystemOneGeneration(config, step, config.initial, { ...stored, trainingScore: 0 }, collection, heldOut), "loop_generation_drift");
  assert.equal(systemOneAccuracy(heldOut, config.evaluation, config.questions, config.initial), 1);
  assert.ok(systemOneCalibrationError(heldOut, config.evaluation, config.questions, first.candidate, 10) < 0.4);
  assert.ok(systemOneEnvironmentSpec(config).task_suite);
  assert.ok(systemOneRunConfig(config, step, 1, config.initial));
  assert.ok(systemOneSeedTrainingConfig(config)); assert.ok(systemOnePromotionScores(config, step, first));
  assert.match(systemOneState(config.training[0]), /Fix export/);
  assert.deepEqual(calibratedProbabilities({ A: 0, B: 1 }, 0, { A: 0, B: 0 }), { A: 9.99999999999001e-13, B: 0.9999999999989999 });
  for (let seed = 0; seed < 30; seed += 1) assert.ok(sampleSystemOneActions(collection[0], config.training[0], config.questions, config.initial, systemOneSampleSeed(seed, 1, 0)).reward >= 0);
  assert.deepEqual(neutralSystemOneHead(config.questions), config.initial.parameters);
});

test("configuration rejects malformed fields, unbounded work and contaminated datasets", () => {
  const cases: Array<[string, JsonValue, string]> = [
    ["environment", null, "systemone_invalid_environment"], ["questions", {}, "systemone_invalid_questions"],
    ["questions", { kind: { instructions: "x", criteria: { A: "a" } } }, "systemone_question_options"],
    ["questions", { kind: { instructions: "x", criteria: { A: 3, B: null } } }, "systemone_question_criteria"],
    ["decision_model", {}, "systemone_decision_model_base_url"],
    ["training", null, "systemone_invalid_datasets"], ["evaluation", [], "systemone_invalid_dataset_size"],
    ["seed", -1, "systemone_invalid_seed"], ["max_generations", 101, "systemone_invalid_max_generations"],
    ["samples_per_generation", 0, "systemone_invalid_samples_per_generation"], ["fit_steps", 0, "systemone_invalid_fit_steps"],
    ["budget", 1, "systemone_invalid_budget"], ["learning_rate", 2, "systemone_invalid_learning_rate"],
    ["minimum_improvement", 0, "systemone_invalid_minimum_improvement"], ["maximum_gap", -1, "systemone_invalid_maximum_gap"],
    ["evaluation_samples", 0, "systemone_invalid_evaluation_samples"], ["confidence", 1, "systemone_invalid_confidence"],
    ["min_samples", 0, "systemone_invalid_min_samples"],
  ];
  for (const [key, value, code] of cases) refuses(() => parseSystemOneLoopConfig({ ...configValue(), [key]: value }), code);
  const config = parseSystemOneLoopConfig(configValue());
  refuses(() => validatedSystemOneDatasets(config.training, config.training, config.questions), "systemone_dataset_overlap");
  refuses(() => validatedSystemOneDatasets(new Array(MAX_SYSTEMONE_EXAMPLES + 1).fill(config.training[0]), config.evaluation, config.questions), "systemone_invalid_dataset_size");
  for (const [field, value, code] of [["description", null, "systemone_example_description"], ["labels", {}, "systemone_example_labels"], ["labels", { kind: "other" }, "systemone_example_label_option"]] as const) {
    refuses(() => validatedSystemOneDatasets([{ ...config.training[0], [field]: value }], config.evaluation, config.questions), code);
  }
  for (const url of ["bad", "ftp://endpoint"]) refuses(() => parseSystemOneLoopConfig({ ...configValue(), decision_model: { base_url: url, model: "tev1:4b", timeout_ms: 10 } }), "systemone_decision_model_base_url");
  refuses(() => parseSystemOneLoopConfig({ ...configValue(), decision_model: { base_url: "http://127.0.0.1", model: "tev1:4b", timeout_ms: 0 } }), "systemone_invalid_timeout_ms");
  refuses(() => parseSystemOneLoopConfig({ ...configValue(), seed: "42" }), "systemone_invalid_seed");
  const head = jsonHeadParameters(config.initial.parameters, config.questions);
  assert.equal(parseSystemOneLoopConfig({ ...configValue(), initial_head: head }).initial.digest, config.initial.digest);
});

test("invalid checkpoint shape, nonfinite parameters and tampered hashes fail closed", () => {
  const config = parseSystemOneLoopConfig(configValue());
  for (const value of [null, {}, { log_temperature: {}, biases: {} }, { log_temperature: { kind: 0 }, biases: {} }, { log_temperature: { kind: NaN }, biases: { kind: { Bug: 0, Feature: 0 } } }, { log_temperature: { kind: 0 }, biases: { kind: { Bug: 0 } } }, { log_temperature: { kind: 0 }, biases: { kind: { Bug: Infinity, Feature: 0 } } }]) {
    assert.throws(() => parseSystemOneHeadParameters(value, config.questions, "head"));
  }
  const step = { learningRate: 0.5, evaluationSamples: 40000 };
  const receipt = executeSystemOneStep(config, step, 1, config.initial, observations("train"), observations("eval"), 20);
  const record = systemOneGenerationTrainingConfig(config, step, receipt) as Record<string, JsonValue>;
  for (const [key, value] of [["format", "wrong"], ["generation", 0], ["samples", 0], ["candidate_checkpoint", "sha256:" + "0".repeat(64)], ["source_checkpoint", "bad"], ["training_score", null]] as const) assert.throws(() => parseStoredSystemOneGeneration({ ...record, [key]: value }, config.questions, "stored"));
  refuses(() => executeSystemOneStep(config, step, 1, { ...config.initial, digest: "tampered" }, observations("train"), observations("eval"), 0), "systemone_invalid_checkpoint");
  refuses(() => fitSystemOneHead([], config.training, config.questions, config.initial.parameters, 0.5, 2), "systemone_empty_batch");
  const unknown = [{ ...observations("train")[0], example: "unknown" }];
  refuses(() => fitSystemOneHead(unknown, config.training, config.questions, config.initial.parameters, 0.5, 2), "systemone_decision_example");
  refuses(() => systemOneAccuracy(unknown, config.training, config.questions, config.initial), "systemone_decision_example");
  refuses(() => systemOneCalibrationError(unknown, config.training, config.questions, config.initial, 10), "systemone_decision_example");
  refuses(() => systemOneCalibrationError(observations("train"), config.training, config.questions, config.initial, 0), "systemone_invalid_bins");
  refuses(() => fitSystemOneHead([{ ...observations("train")[0], answers: {} }], config.training, config.questions, config.initial.parameters, 0.5, 2), "systemone_decision_shape");
  refuses(() => fitSystemOneHead([{ ...observations("train")[0], answers: { kind: { Bug: -1, Feature: 2 } } }], config.training, config.questions, config.initial.parameters, 0.5, 2), "systemone_decision_shape");
});

test("decision metric events round trip and reject corrupted evidence", () => {
  const config = parseSystemOneLoopConfig(configValue()); const observation = observations("train")[0];
  const event = systemOneDecisionEvent(SYSTEMONE_COLLECTION_METRIC, 0, observation, { input_tokens: 10, output_tokens: 1 });
  assert.deepEqual(parseSystemOneDecisionEvent(event, SYSTEMONE_COLLECTION_METRIC, config.questions, "event"), observation);
  assert.ok(systemOneDecisionEvent(SYSTEMONE_HELD_OUT_METRIC, 0, observation, { input_tokens: 10, output_tokens: 1 }));
  refuses(() => systemOneDecisionEvent("other", 0, observation, { input_tokens: 0, output_tokens: 0 }), "systemone_invalid_metric");
  for (const altered of [{ ...event, metric: "other" }, { ...event, tags: undefined }, { ...event, tags: { example: "x" } }, { ...event, tags: { example: "x", answers: "bad" } }, { ...event, tags: { example: "x", answers: "{}" } }, { ...event, tags: { example: "x", answers: '{"kind":{}}' } }, { ...event, tags: { example: "x", answers: '{"kind":{"Bug":-1,"Feature":2}}' } }, { ...event, value: 2 }]) assert.throws(() => parseSystemOneDecisionEvent(altered, SYSTEMONE_COLLECTION_METRIC, config.questions, "event"));
});

test("real HTTP usage rejects fractional and unsafe token accounting", async () => {
  const config = parseSystemOneLoopConfig(configValue());
  const answers = { kind: { probabilities: { Bug: 0.6, Feature: 0.4 } } };
  for (const [input_tokens, output_tokens] of [[10.5, 1], [10, 0.5], [Number.MAX_SAFE_INTEGER + 1, 0],
    [0, Number.MAX_SAFE_INTEGER + 1], [Number.MAX_SAFE_INTEGER, 1], [0, -1], ["10", 1], [10, "1"]]) {
    const baseURL = await endpoint({ answers, usage: { input_tokens, output_tokens } });
    await assert.rejects(requestSystemOneDecision({ ...config.endpoint, baseURL }, "state", config.questions),
      (error: unknown) => isPmCliExpectedError(error) && error.context.code === "systemone_endpoint_usage_invalid");
  }
  for (const usage of [{ input_tokens: 0, output_tokens: 0 }, { input_tokens: Number.MAX_SAFE_INTEGER - 1, output_tokens: 1 }]) {
    const baseURL = await endpoint({ answers, usage });
    const decision = await requestSystemOneDecision({ ...config.endpoint, baseURL }, "state", config.questions);
    assert.equal(decision.usage.input_tokens, usage.input_tokens);
    assert.equal(decision.usage.output_tokens, usage.output_tokens);
  }
});

test("real HTTP requests validate protocol, status, timeout, abort and response shape", async () => {
  const config = parseSystemOneLoopConfig(configValue());
  const good = { answers: { kind: { type: "choice", choice: "Bug", probabilities: { Bug: 0.6, Feature: 0.4 }, confidence: 0.6 } }, usage: { input_tokens: 10, output_tokens: 1 } };
  const baseURL = await endpoint(good);
  const decision = await requestSystemOneDecision({ ...config.endpoint, baseURL }, "state", config.questions);
  assert.deepEqual(decision.answers, { kind: { Bug: 0.6, Feature: 0.4 } });
  assert.ok(decision.usage.latency_ms > 0);
  for (const response of ["bad json", null, {}, { answers: good.answers }, { ...good, usage: { input_tokens: -1, output_tokens: 1 } }, { ...good, answers: {} }, { ...good, answers: { kind: { type: "score" } } }, { ...good, answers: { kind: { probabilities: {} } } }, { ...good, answers: { kind: { probabilities: { Bug: -1, Feature: 2 } } } }]) {
    const url = await endpoint(response);
    await assert.rejects(requestSystemOneDecision({ ...config.endpoint, baseURL: url }, "state", config.questions), isPmCliExpectedError);
  }
  await assert.rejects(requestSystemOneDecision({ ...config.endpoint, baseURL: await endpoint("refused", 503) }, "state", config.questions), isPmCliExpectedError);
  await assert.rejects(requestSystemOneDecision(config.endpoint, "state", config.questions), isPmCliExpectedError);
  await assert.rejects(requestSystemOneDecision({ ...config.endpoint, baseURL: await endpoint(good, 200, 100), timeoutMs: 1 }, "state", config.questions), isPmCliExpectedError);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(requestSystemOneDecision({ ...config.endpoint, baseURL }, "state", config.questions, controller.signal), { name: "AbortError" });
  assert.ok(await requestSystemOneDecision({ ...config.endpoint, baseURL }, "state", config.questions, new AbortController().signal));
  // Trailing slashes are trimmed before the path is appended, so "…//" still reaches /v1/systemone.
  assert.ok(await requestSystemOneDecision({ ...config.endpoint, baseURL: `${baseURL}//` }, "state", config.questions));
});

test("choice heads reject missing records and probability mass drift and score wrong predictions", async () => {
  const value = configValue(); const config = parseSystemOneLoopConfig(value);
  for (const key of ["environment", "questions", "decision_model"]) {
    const missing = { ...value }; delete missing[key]; assert.throws(() => parseSystemOneLoopConfig(missing));
  }
  for (const question of [{ type: "score", instructions: "x", criteria: { A: null, B: "b" } }, { instructions: "x" }]) assert.throws(() => parseSystemOneLoopConfig({ ...value, questions: { kind: question } } as JsonValue));
  assert.throws(() => parseSystemOneHeadParameters({ log_temperature: { kind: 0 } }, config.questions, "head"));
  assert.throws(() => validatedSystemOneDatasets([{ ...config.training[0], labels: undefined }], config.evaluation, config.questions));
  const wrong = systemOneCheckpoint({ logTemperature: { kind: 0 }, biases: { kind: { Bug: -10, Feature: 10 } } }, config.questions);
  assert.equal(systemOneAccuracy([observations("train")[0]], config.training, config.questions, wrong), 0);
  assert.ok(systemOneCalibrationError([observations("train")[0]], config.training, config.questions, wrong, 1) > 0.99);
  assert.throws(() => systemOneAccuracy([], config.training, config.questions, wrong));
  assert.throws(() => systemOneAccuracy([{ ...observations("train")[0], answers: { kind: { Bug: 0, Feature: 0 } } }], config.training, config.questions, wrong));
  const event = systemOneDecisionEvent(SYSTEMONE_COLLECTION_METRIC, 0, observations("train")[0], { input_tokens: 0, output_tokens: 0 });
  assert.throws(() => parseSystemOneDecisionEvent({ ...event, metric: "foreign" }, "foreign", config.questions, "event"));
  const missingAnswer = { answers: { kind: { type: "choice" } }, usage: { input_tokens: 0, output_tokens: 0 } };
  await assert.rejects(requestSystemOneDecision({ ...config.endpoint, baseURL: await endpoint(missingAnswer) }, "state", config.questions));
  const server = createServer((request, reply) => {
    request.resume(); reply.writeHead(503, { "content-length": 10000 }); reply.write("partial"); setTimeout(() => reply.destroy(), 10);
  }); servers.push(server); await new Promise<void>((resolve) => { server.listen(0, "127.0.0.1", resolve); });
  const address = server.address(); assert.ok(address && typeof address !== "string");
  await assert.rejects(requestSystemOneDecision({ ...config.endpoint, baseURL: `http://127.0.0.1:${address.port}` }, "state", config.questions));
  const bodyServer = createServer((request, reply) => { request.resume(); reply.writeHead(200, { "content-type": "application/json" }); reply.write('{"answers":'); });
  servers.push(bodyServer); await new Promise<void>((resolve) => { bodyServer.listen(0, "127.0.0.1", resolve); });
  const bodyAddress = bodyServer.address(); assert.ok(bodyAddress && typeof bodyAddress !== "string");
  const controller = new AbortController();
  const pending = requestSystemOneDecision({ ...config.endpoint, baseURL: `http://127.0.0.1:${bodyAddress.port}` }, "state", config.questions, controller.signal);
  setTimeout(() => controller.abort(), 50);
  await assert.rejects(pending, { name: "AbortError" });
});


test("idempotency protocol validates immutable endpoint receipts and persisted accounting", async () => {
  const config = parseSystemOneLoopConfig({ ...configValue(), decision_model: { base_url: "http://127.0.0.1", model: "tev1:4b", timeout_ms: 10000, receipt_protocol: "idempotency-v1" } });
  const requestId = systemOneDecisionRequestId(config, config.initial, "namespace", SYSTEMONE_COLLECTION_METRIC, 0);
  const good = { request_id: requestId, decision_id: "decision-1", physical_requests: 1,
    answers: { kind: { probabilities: { Bug: 0.6, Feature: 0.4 } } }, usage: { input_tokens: 10, output_tokens: 1, latency_ms: 12 } };
  const baseURL = await endpoint(good);
  const decision = await requestSystemOneDecision({ ...config.endpoint, baseURL }, "state", config.questions, undefined, requestId);
  assert.deepEqual(decision.usage, { input_tokens: 10, output_tokens: 1, latency_ms: 12, receipt: { requestId, decisionId: "decision-1" } });
  for (const id of [undefined, "bad"]) await assert.rejects(requestSystemOneDecision(config.endpoint, "state", config.questions, undefined, id),
    (error: unknown) => isPmCliExpectedError(error) && error.context.code === "systemone_request_id_invalid");
  for (const receipt of [{ ...good, request_id: "foreign" }, { ...good, decision_id: null }, { ...good, decision_id: "" },
    { ...good, decision_id: " padded " }, { ...good, decision_id: "x".repeat(257) }, { ...good, physical_requests: 2 },
    JSON.stringify(good).replace('"latency_ms":12', '"latency_ms":1e309'),
    ...[undefined, "12", -1].map((latency_ms) => ({ ...good, usage: { ...good.usage, latency_ms } }))]) {
    const baseURL = await endpoint(receipt);
    await assert.rejects(requestSystemOneDecision({ ...config.endpoint, baseURL }, "state", config.questions, undefined, requestId),
      (error: unknown) => isPmCliExpectedError(error) && error.context.code === "systemone_endpoint_receipt_invalid");
  }
  refuses(() => parseSystemOneLoopConfig({ ...configValue(), decision_model: { base_url: "http://127.0.0.1", model: "tev1:4b", timeout_ms: 1, receipt_protocol: "other" } }), "systemone_invalid_receipt_protocol");
  const event = systemOneDecisionEvent(SYSTEMONE_COLLECTION_METRIC, 0, observations("train")[0], decision.usage);
  verifySystemOneReceiptEvent(event, requestId);
  refuses(() => verifySystemOneReceiptEvent({ ...event, tags: undefined }, requestId), "loop_generation_drift");
  for (const tags of [{ ...event.tags, decision_id: " padded " },
    { ...event.tags, input_tokens: "010" }, { ...event.tags, output_tokens: "01" }, { ...event.tags, tokens: "011" },
    ...[undefined, "", "-1", "NaN", "12.0"].map((latency_ms) => ({ ...event.tags, latency_ms })),
    { ...event.tags, decision_id: undefined }, { ...event.tags, decision_id: "x".repeat(257) },
    { ...event.tags, input_tokens: undefined }, { ...event.tags, output_tokens: undefined },
    { ...event.tags, input_tokens: "-1" }, { ...event.tags, input_tokens: "0.5" },
    { ...event.tags, output_tokens: "-1" }, { ...event.tags, output_tokens: "0.5" },
    { ...event.tags, input_tokens: String(Number.MAX_SAFE_INTEGER), output_tokens: "1" }]) {
    // Undefined represents an absent tag in the serialized metric event.
    const cleaned: Record<string, string> = {};
    for (const [name, value] of Object.entries(tags)) if (value !== undefined) cleaned[name] = value;
    refuses(() => verifySystemOneReceiptEvent({ ...event, tags: cleaned }, requestId), "loop_generation_drift");
  }
});
