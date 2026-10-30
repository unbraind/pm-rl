/** Fixed-seed sensitivity, strict boundaries and real SDK model/interleaving tests without Git. */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { PmClient } from "@unbrained/pm-cli/sdk/core";
import type { HistoryResult } from "@unbrained/pm-cli/sdk/query";
import { parseTags } from "@unbrained/pm-cli/sdk";
import { init, normalizeItemId, isPmCliExpectedError } from "@unbrained/pm-cli/sdk/runtime";
import { createExtensionTestHarness } from "@unbrained/pm-cli/sdk/testing";
import extension, { createVerifiedItem, orderedHistoryEntries, readLoopRevision, hashJson, generationProvenance, runRlLoop, readCompleteLoopItem, extractGenerationSpec, type JsonValue, type RlCommandResult } from "../index.ts";
import { parseLoopConfig, generationTrainingConfig, seedTrainingConfig, runLoopGeneration } from "../loop.ts";
import { parseTrainingInfluence, measureTrainingInfluence, replayTrainingInfluence, recordTrainingInfluence, readTrainingInfluence, attachTrainingInfluence, summarizeTrainingInfluence, verifyTrainingInfluenceProposal, type TrainingInfluenceRequest } from "../training-influence.ts";
import { recordPolicyCard, recordRecursivePolicyCards, discoverPolicyCards } from "../policy-card.ts";
import type { GenerationSpec } from "../lineage.ts";
import { banditCheckpoint } from "../bandit.ts";

const roots: string[] = [];
after(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });
/** Small but nonzero positive and negative slice effects, with distinct model-input partitions. */
function request(seed = 42): TrainingInfluenceRequest {
  return { format: "pm-rl/training-influence/1", learner: { seed, initial_weight: 0, samples: 32, fit_steps: 2, learning_rate: 0.5 },
    training: [{ id: "a", feature: -1, rewards: [1, 0] }, { id: "b", feature: 1, rewards: [0, 1] }, { id: "c", feature: 0.4, rewards: [1, 0] }],
    held_out: [{ id: "x", feature: -0.8, rewards: [1, 0] }, { id: "y", feature: 0.8, rewards: [0, 1] }],
    slices: [{ id: "omit-positive", members: ["b"], weight: 0 }, { id: "reweight-noisy", members: ["c"], weight: 3 }],
    evaluations: [{ id: "all", members: ["x", "y"] }, { id: "positive", members: ["y"] }], budget: { fits: 3, samples: 96, updates: 6 } };
}
/** All refusals carry a stable recovery code and a concrete remedy. */
function refused(code: string) { return (error: unknown): boolean => isPmCliExpectedError(error) && error.context.code === code && /fresh report/.test(error.message); }
/** Real plain-directory tracker; ceiling prevents Git discovery above it. */
async function workspace(prefix = "rl") {
  const root = mkdtempSync(join(tmpdir(), "rl-influence-")); roots.push(root);
  process.env.GIT_CEILING_DIRECTORIES = dirname(root);
  const tracker = await init(prefix, { defaults: true, author: "influence-test", agentGuidance: "skip" }, { cwd: root });
  const client = new PmClient({ cwd: root, pmRoot: tracker.path, author: "influence-test", noExtensions: true });
  return { root, pmRoot: tracker.path, client };
}
/** Plain loop proposals keep the existing evaluation and promotion bounds. */
function programme(input = request()): JsonValue {
  return { environment: { name: "Measured sensitivity", version: "1" }, training: input.training as unknown as JsonValue, evaluation: input.held_out as unknown as JsonValue, initial_weight: 0, seed: 42, max_generations: 2, samples_per_generation: 100, budget: 200, learning_rate: 0.5, minimum_improvement: 0.00001, maximum_gap: 1, evaluation_samples: 10000, confidence: 0.9, min_samples: 2 };
}
/** Reproducible random operations, including replays against old target identities. */
function random(seed: number): () => number { let state = seed; return () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state; }; }

test("fixed learner and seed reproduce exact checkpoints and per-evaluation movements; held-out labels never train", () => {
  const p = request(); const report = measureTrainingInfluence(p);
  assert.deepEqual(measureTrainingInfluence(JSON.parse(JSON.stringify(p))), report);
  assert.deepEqual(replayTrainingInfluence(p, JSON.parse(JSON.stringify(report, null, 2))), report);
  assert.equal(report.complete, true); assert.equal(report.interpretation, "association"); assert.equal(report.ranking, null);
  assert.equal(report.comparisons.length, 2); assert.ok(report.comparisons.every((row) => row.delta.some((delta) => delta !== 0)));
  const relabeled = { ...p, held_out: p.held_out.map((row) => ({ ...row, rewards: [row.rewards[1], row.rewards[0]] })) };
  const changed = measureTrainingInfluence(relabeled);
  assert.deepEqual(changed.baseline?.checkpoint, report.baseline?.checkpoint);
  assert.deepEqual(changed.comparisons.map((row) => row.fit.checkpoint), report.comparisons.map((row) => row.fit.checkpoint));
  assert.notDeepEqual(changed.baseline?.scores, report.baseline?.scores);
  assert.throws(() => replayTrainingInfluence(p, { ...report, digest: "0".repeat(64) }), refused("influence_drift"));
  assert.ok(Buffer.byteLength(JSON.stringify(summarizeTrainingInfluence(report))) < 1600);
  const signedZero = { ...p, learner: { ...p.learner, initial_weight: -0 }, training: p.training.map((row, index) => ({ ...row, feature: index === 0 ? -0 : row.feature })) };
  const zeroReport = measureTrainingInfluence(signedZero);
  assert.deepEqual(parseTrainingInfluence(signedZero), JSON.parse(JSON.stringify(parseTrainingInfluence(signedZero))));
  assert.deepEqual(replayTrainingInfluence(signedZero, JSON.parse(JSON.stringify(zeroReport))), zeroReport);
});

test("exact budget boundaries retain partial evidence, including no baseline, without rankings", () => {
  for (const [key, exact] of [["fits", 3], ["samples", 96], ["updates", 6]] as const) {
    for (const allowance of [0, exact - 1, exact, exact + 1]) {
      const p = request(); const report = measureTrainingInfluence({ ...p, budget: { ...p.budget, [key]: allowance } });
      assert.equal(report.complete, allowance >= exact);
      assert.equal(report.ranking, null);
      assert.ok(report.spent[key] <= allowance);
      assert.equal(report.spent.fits, report.comparisons.length + Number(report.baseline !== null));
      for (const row of report.omitted) assert.equal(row.reason, key === "fits" ? "fit_budget" : key === "samples" ? "sample_budget" : "update_budget");
    }
  }
});

test("one strict request schema refuses sparse, nonfinite, ambiguous and contaminated input before side effects", () => {
  const p = request();
  const invalid: unknown[] = [null, [], {}, { ...p, extra: 1 }, { ...p, format: "unknown" }, { ...p, training: [] }, { ...p, slices: [] }, { ...p, evaluations: [] }, { ...p, training: new Array(2) }, { ...p, learner: null }, { ...p, budget: { ...p.budget, extra: 1 } }];
  for (const field of ["seed", "initial_weight", "samples", "fit_steps", "learning_rate"] as const) for (const value of [Infinity, -Infinity, NaN, Number.MAX_VALUE, -Number.MAX_VALUE, "1", null]) invalid.push({ ...p, learner: { ...p.learner, [field]: value } });
  for (const field of ["fits", "samples", "updates"] as const) for (const value of [NaN, -1, 0.5, Infinity, Number.MAX_VALUE]) invalid.push({ ...p, budget: { ...p.budget, [field]: value } });
  for (const key of ["training", "held_out"] as const) {
    for (const field of ["feature", "rewards", "id", "features"]) for (const value of [null, Infinity, new Array(2)]) invalid.push({ ...p, [key]: [{ ...p[key][0], [field]: value }] });
    invalid.push({ ...p, [key]: [{ ...p[key][0], id: "  a\r\n" }] });
  }
  invalid.push({ ...p, slices: [{ ...p.slices[0], weight: 1 }] }, { ...p, slices: [{ ...p.slices[0], weight: 1.5 }] }, { ...p, slices: [{ ...p.slices[0], members: ["x"] }] }, { ...p, slices: [{ ...p.slices[0], members: ["a", "a"] }] }, { ...p, slices: [p.slices[0], p.slices[0]] }, { ...p, evaluations: [p.evaluations[0], p.evaluations[0]] }, { ...p, slices: [{ ...p.slices[0], members: ["a", "b", "c"] }] }, { ...p, evaluations: [{ ...p.evaluations[0], members: ["a"] }] }, { ...p, training: [{ ...p.training[0], unexpected: 1 }] }, { ...p, learner: { ...p.learner, samples: 10000, fit_steps: 256 }, budget: { ...p.budget, fits: 17 } });
  for (const input of invalid) assert.throws(() => parseTrainingInfluence(input), (error: unknown) => isPmCliExpectedError(error));
  for (const training of [[...p.training, p.held_out[0]], [{ ...p.training[0], id: "x" }], [{ ...p.training[0], feature: p.held_out[0].feature }]]) assert.throws(() => parseTrainingInfluence({ ...p, training }), refused("influence_overlap"));
  const vector = { ...p, training: p.training.map((row) => ({ ...row, features: [row.feature, 1] })), held_out: p.held_out.map((row) => ({ ...row, features: [row.feature, 1] })) };
  assert.ok(measureTrainingInfluence(vector).baseline?.checkpoint.coefficients);
  for (const feature of [NaN, Infinity, -2, 2]) assert.throws(() => parseTrainingInfluence({ ...vector, training: [{ ...vector.training[0], features: [feature, 1] }] }));
  for (const value of [-1, 2, Infinity]) assert.throws(() => parseTrainingInfluence({ ...p, training: [{ ...p.training[0], rewards: [value, 0] }] }));
  const report = measureTrainingInfluence(p);
  for (const value of [NaN, Infinity, -Infinity, Number.MAX_VALUE]) {
    assert.throws(() => replayTrainingInfluence(p, { ...report, spent: { ...report.spent, fits: value } }), refused("influence_drift"));
    assert.throws(() => replayTrainingInfluence(p, { ...report, comparisons: [{ ...report.comparisons[0], delta: [value] }] }), refused("influence_drift"));
    assert.throws(() => summarizeTrainingInfluence({ ...report, spent: { ...report.spent, fits: value } }), refused("influence_invalid"));
    assert.throws(() => summarizeTrainingInfluence({ ...report, comparisons: [{ ...report.comparisons[0], delta: [value] }] }), refused("influence_invalid"));
  }
  for (const patch of [{ ranking: Infinity }, { digest: Infinity }, { evaluations: [Infinity] }, { omitted: [{ slice: "valid", reason: Infinity }] }, { omitted: [{ slice: "valid", reason: { toString: "fit_budget" } }] }, { complete: 1 }, { interpretation: "causal" }]) assert.throws(() => summarizeTrainingInfluence({ ...report, ...patch } as unknown as typeof report), refused("influence_invalid"));
  assert.equal(summarizeTrainingInfluence(measureTrainingInfluence({ ...p, budget: { fits: 0, samples: 0, updates: 0 } })).baseline, null);
});

test("native records, compact CLI packets and historical evidence feed the next recursive proposal", async () => {
  const { client, root, pmRoot } = await workspace(); const p = request();
  const retained = await recordTrainingInfluence(client, p);
  assert.equal(retained.created, true); assert.equal((await recordTrainingInfluence(client, p)).created, false);
  const read = await readTrainingInfluence(client, retained.id); assert.deepEqual(read.report, retained.report);
  const proposal = await attachTrainingInfluence(client, programme(), retained.id);
  const config = parseLoopConfig(proposal); assert.ok(config.influenceEvidence);
  assert.ok((seedTrainingConfig(config) as Record<string, JsonValue>).configuration);
  const receipt = runLoopGeneration(config, { learningRate: 0.5, evaluationSamples: 10000 }, 1, banditCheckpoint(0));
  assert.deepEqual((generationTrainingConfig(config, { learningRate: 0.5, evaluationSamples: 10000 }, 1, receipt) as Record<string, JsonValue>).influence_evidence, config.influenceEvidence);
  await verifyTrainingInfluenceProposal(client, programme());
  for (const invalid of [null, [], 1, "invalid"]) await assert.rejects(verifyTrainingInfluenceProposal(client, invalid), refused("influence_invalid"));
  await verifyTrainingInfluenceProposal(client, proposal);
  await client.update(retained.id, { body: "Foreign new revision", title: "Changed by peer" });
  await verifyTrainingInfluenceProposal(client, proposal); // immutable historical citation, not a stale current read
  await assert.rejects(recordTrainingInfluence(client, p), refused("influence_foreign"));
  await assert.rejects(attachTrainingInfluence(client, { ...programme() as Record<string, JsonValue>, training: [] }, retained.id));
  const evidence = config.influenceEvidence as Record<string, JsonValue>;
  await assert.rejects(verifyTrainingInfluenceProposal(client, { ...programme() as Record<string, JsonValue>, influence_evidence: { ...evidence, report: "changed" } }), refused("influence_drift"));
  for (const supplied of [null, {}, { id: retained.id, at: "invalid" }]) await assert.rejects(verifyTrainingInfluenceProposal(client, { ...programme() as Record<string, JsonValue>, influence_evidence: supplied as JsonValue }));
  for (const patch of [{ training: [] }, { trainer: "lm" }, { evaluation: p.training }]) await assert.rejects(verifyTrainingInfluenceProposal(client, { ...proposal as Record<string, JsonValue>, ...patch } as unknown as JsonValue), refused("training" in patch ? "influence_invalid" : "influence_overlap"));
  const p2 = request(12); const second = await recordTrainingInfluence(client, p2);
  const harness = await createExtensionTestHarness(extension, { name: "pm-rl", capabilities: ["commands", "hooks", "schema"] });
  const input = join(root, "experiment.json"); const next = join(root, "proposal.json"); writeFileSync(input, JSON.stringify(p2)); writeFileSync(next, JSON.stringify(programme(p2)));
  const run = (await harness.runCommand({ command: "rl influence run", pmRoot, options: { file: input }, global: { json: true } })).result as RlCommandResult;
  assert.equal(run.details?.created, false);
  const show = (await harness.runCommand({ command: "rl influence show", pmRoot, args: [second.id] })).result as RlCommandResult;
  assert.equal(show.details?.digest, second.report.digest);
  const output = join(root, "evidenced.json");
  const proposed = (await harness.runCommand({ command: "rl influence propose", pmRoot, args: [second.id], options: { file: next, output } })).result as RlCommandResult;
  assert.ok(proposed.details?.programme);
  assert.ok((JSON.parse(readFileSync(output, "utf8")) as Record<string, unknown>).influence_evidence);
  await assert.rejects(harness.runCommand({ command: "rl influence propose", pmRoot, args: [second.id], options: { file: next, output } }), (error: unknown) => isPmCliExpectedError(error) && error.context.code === "influence_output_exists");
  await assert.rejects(harness.runCommand({ command: "rl influence propose", pmRoot, args: [second.id], options: { file: next, output: join(root, "missing", "proposal.json") } }));
  await client.create({ id: "approval", type: "Decision", title: "Bounded promotion approval", body: '```json\n{"permitted_promotions":2}\n```', unset: ["parent"] });
  const loop = await runRlLoop(client, { pmRoot, author: "influence-test" }, { id: "influence", approval: "approval", config: await attachTrainingInfluence(client, programme(p2), second.id) });
  assert.ok(loop.generations.length >= 1);
  for (const generation of loop.generations) {
    const native = (await client.get(generation.item, { full: true })).item;
    assert.ok((extractGenerationSpec(String(native.body), "Measured proposal").training_config as Record<string, JsonValue>).influence_evidence);
  }
});

test("500 seeded operation sequences model replay, native fields and relationship preservation through SDK read-back", { timeout: 600000 }, async (context) => {
  const { client } = await workspace(); const rng = random(0x57a1ce);
  const model = new Map<string, { body: string; title: string; version: string; status: string; parent: string | undefined; dependencies: { id: string; kind: string }[]; tags: string[] }>();
  const statuses: string[] = [];
  for (let i = 0; i < 8; i += 1) { const status = `custom-${rng()}`; const added = await client.schemaAddStatus(status, { role: ["active"] }); statuses.push(added.status.id); }
  await client.create({ id: "related", type: "Task", title: "Related native item", unset: ["parent"] });
  const inputs = Array.from({ length: 12 }, (_, index) => request(index));
  for (let sequence = 0; sequence < 500; sequence += 1) {
    context.signal.throwIfAborted();
    if (sequence % 25 === 0) await client.focus("related");
    const input = inputs[(rng() >>> 16) % inputs.length];
    const transported = JSON.parse(JSON.stringify(input, null, rng() % 3).replaceAll("\n", sequence % 2 === 0 ? "\r\n" : "\n")) as unknown;
    const report = measureTrainingInfluence(transported); const id = `rl-training-influence-${report.digest}`;
    const current = model.get(id);
    const result = await recordTrainingInfluence(client, transported);
    assert.equal(result.created, current === undefined);
    const expectedBody = JSON.stringify({ format: "pm-rl/training-influence-record/1", id: `training-influence-${report.digest}`, request: parseTrainingInfluence(input), report });
    if (current === undefined) model.set(id, { body: expectedBody, title: "Measured training-slice associations", version: report.digest, status: "open", parent: undefined, dependencies: [], tags: ["rl-training-influence"] });
    const expected = model.get(id)!;
    if (rng() % 4 === 0) {
      expected.title = `Peer title ${sequence}`; expected.status = statuses[rng() % statuses.length]; expected.parent = "rl-related";
      expected.body = JSON.stringify(JSON.parse(expectedBody), null, 2).replaceAll("\n", "\r\n");
      expected.dependencies = [{ id: "rl-related", kind: "related" }]; expected.tags = parseTags("rl-training-influence,peer-annotation");
      await client.update(id, { title: expected.title, status: expected.status, parent: expected.parent, body: expected.body, tags: expected.tags.join(","), dep: ["id=rl-related,kind=related"] });
      if (sequence % 9 === 0) assert.equal((await recordTrainingInfluence(client, transported)).created, false);
    }
    const item = (await readCompleteLoopItem(client, id, undefined, "id,type,body,title,affected_version,status,parent,goal,objective,sprint,release,assignee,reviewer,blocked_by,dependencies,tags")).item;
    assert.equal(item.body, expected.body); assert.equal(item.title, expected.title); assert.equal(item.affected_version, expected.version);
    assert.equal(item.status, expected.status); assert.equal(item.parent, expected.parent);
    assert.deepEqual((item.dependencies ?? []).map(({ id: target, kind }) => ({ id: target, kind })), expected.dependencies);
    for (const key of ["goal", "objective", "sprint", "release", "assignee", "reviewer", "blocked_by"] as const) assert.equal(item[key], undefined);
    assert.deepEqual(item.tags, expected.tags);
    if (sequence % 5 === 0) assert.deepEqual((await readTrainingInfluence(client, id)).report, report);
    const exported = JSON.parse(JSON.stringify(report, null, 2).replaceAll("\n", "\r\n")) as unknown;
    assert.deepEqual(replayTrainingInfluence(input, exported), report);
    if (sequence % 17 === 0) await verifyTrainingInfluenceProposal(client, await attachTrainingInfluence(client, programme(input), id));
  }
  assert.equal(model.size, 12);
});

test("peer creation and edits are reconciled at every native SDK read/write boundary on one non-git tracker", async () => {
  const w = await workspace(); const peer = new PmClient({ cwd: w.root, pmRoot: w.pmRoot, author: "influence-peer", noExtensions: true });
  const boundary = { count: 0 }; let injectAt = -1; let inject: (() => Promise<void>) | null = null;
  /** A synchronous increment records completed SDK calls before yielding to the competing writer. */
  function advanceBoundary(): number { boundary.count += 1; return boundary.count; }
  /** Reset only after the preceding SDK invocation and injected writer have settled. */
  function resetBoundary(): void { boundary.count = 0; }
  for (const method of ["get", "create", "run", "config"] as const) {
    const original = w.client[method].bind(w.client);
    Reflect.set(w.client, method, async (...args: Parameters<typeof original>) => {
      let value: unknown;
      try { value = await Reflect.apply(original, w.client, args); }
      finally { if (advanceBoundary() === injectAt) await inject!(); }
      return value;
    });
  }
  await recordTrainingInfluence(w.client, request(987)); const writeSteps = boundary.count;
  const recorded = await recordTrainingInfluence(w.client, request(986)); resetBoundary();
  await attachTrainingInfluence(w.client, programme(request(986)), recorded.id); const readSteps = boundary.count;
  for (const kind of ["write", "feedback"] as const) for (let step = 1; step <= (kind === "write" ? writeSteps : readSteps); step += 1) {
    const p = request(1000 + step + (kind === "write" ? 0 : 100));
    const report = measureTrainingInfluence(p); const id = `rl-training-influence-${report.digest}`;
    if (kind === "feedback") await recordTrainingInfluence(peer, p);
    resetBoundary(); injectAt = step;
    inject = async () => {
      if (kind === "write") {
        await recordTrainingInfluence(peer, p);
        await peer.update(id, { title: "Peer succeeded", parent: "none" });
      } else await peer.update(id, { body: "Foreign replacement" });
    };
    const outcome = await (kind === "write" ? recordTrainingInfluence(w.client, p) : attachTrainingInfluence(w.client, programme(p), id)).then((value) => ({ value }), (error: unknown) => ({ error }));
    assert.ok(boundary.count >= step); injectAt = -1;
    if ("error" in outcome) assert.ok(isPmCliExpectedError(outcome.error));
    if (kind === "write") {
      const native = (await peer.get(id, { full: true })).item;
      assert.equal(native.title, "Peer succeeded");
      assert.deepEqual((await readTrainingInfluence(peer, id)).report, report);
    } else if ("value" in outcome) await verifyTrainingInfluenceProposal(peer, outcome.value as JsonValue);
  }
});

test("every producer certifies native type and provenance after creation through SDK birth read-back", async () => {
  const w = await workspace(); const peer = new PmClient({ cwd: w.root, pmRoot: w.pmRoot, author: "native-peer", noExtensions: true });
  const original = w.client.create.bind(w.client);
  const changes = [{ type: "Task" }, { body: "Peer body" }, { affectedVersion: "peer" }, { tags: "foreign" }, { parent: "rl-parent" }, { dep: ["id=rl-parent,kind=related"] }];
  await peer.create({ id: "parent", type: "Task", title: "Peer parent", unset: ["parent"] });
  for (const [index, change] of changes.entries()) {
    Reflect.set(w.client, "create", async (...args: Parameters<typeof original>) => {
      const created = await original(...args); await peer.update(created.item.id, change); return created;
    });
    await assert.rejects(createVerifiedItem(w.client, { id: `native-${index}`, type: "Decision", title: "Immutable producer", body: "Original", affectedVersion: "original", tags: "owned", unset: ["parent"] }), (error: unknown) => isPmCliExpectedError(error) && error.context.code === "record_write_drift");
    const current = (await peer.get(`native-${index}`, { full: true })).item;
    assert.equal(current.type, change.type ?? "Decision");
    assert.equal(current.body, change.body ?? "Original");
  }
  Reflect.set(w.client, "create", original);
  // Guard every production entry point, including CLI-only/native plan writers, against bypassing the tested contract.
  for (const file of readdirSync(new URL("..", import.meta.url)).filter((name) => name.endsWith(".ts"))) {
    const source = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
    let callers = source;
    if (file === "index.ts") for (const name of ["createVerifiedItem", "orderedHistoryEntries"]) {
      const start = callers.indexOf(`export ${name === "createVerifiedItem" ? "async " : ""}function ${name}(`);
      assert.ok(start >= 0);
      const end = callers.indexOf("\n}\n", start); assert.ok(end > start);
      callers = callers.slice(0, start) + callers.slice(end + 3);
    }
    assert.doesNotMatch(callers, /await \w+\.create\(/, `${file}: native producers must use SDK read-back`);
    assert.doesNotMatch(callers, /\.compact_history\b/, `${file}: history consumers must use certified durable ordering`);
  }
});

test("history order is irrelevant across 500 seeded native revision permutations", async () => {
  const { client } = await workspace(); const saved = await recordTrainingInfluence(client, request(4001));
  for (let revision = 0; revision < 6; revision += 1) await client.update(saved.id, { title: `Annotation ${revision}` });
  const history = await client.run("history", { id: saved.id, options: { compact: true, verify: true, outputLimit: "unbounded", outputBudget: "unbounded" } }) as HistoryResult;
  const entries = history.compact_history!; const rng = random(0x7e51);
  const expected = Array.from({ length: 7 }, (_, index) => index + 1);
  for (let seed = 0; seed < 500; seed += 1) {
    const rows = [...entries];
    for (let index = rows.length - 1; index > 0; index -= 1) { const other = rng() % (index + 1); [rows[index], rows[other]] = [rows[other], rows[index]]; }
    assert.deepEqual(orderedHistoryEntries({ ...history, compact_history: rows }, "influence_drift").map((row) => row.version ?? row.index), expected);
  }
  // Legacy checkpoints carry no durable version; their physical index orders them, and the latest index is the revision.
  const legacy = entries.map((row) => ({ ...row, version: null }));
  assert.deepEqual(orderedHistoryEntries({ ...history, compact_history: [...legacy].reverse() }, "influence_drift").map((row) => row.index), legacy.map((row) => row.index).sort((left, right) => left - right));
  const legacyRun = client.run.bind(client);
  Reflect.set(client, "run", async (...args: Parameters<typeof legacyRun>) => {
    const result = await legacyRun(...args);
    return args[0] === "history" ? { ...result as HistoryResult, compact_history: (result as HistoryResult).compact_history!.map((row) => ({ ...row, version: null })) } : result;
  });
  assert.equal(await readLoopRevision(client, saved.id), Math.max(...legacy.map((row) => row.index)));
  Reflect.set(client, "run", legacyRun);
  for (const rows of [[], [entries[0], entries[0]], [undefined], [{ ...entries[0], version: Infinity }], [{ ...entries[0], version: 0 }]]) {
    await assert.rejects(async () => orderedHistoryEntries({ ...history, count: rows.length, compact_history: rows } as HistoryResult, "influence_drift"), refused("influence_drift"));
  }
  const run = client.run.bind(client);
  Reflect.set(client, "run", async (...args: Parameters<typeof run>) => {
    const result = await run(...args);
    return args[0] === "history" ? { ...result as HistoryResult, compact_history: [...(result as HistoryResult).compact_history!].reverse() } : result;
  });
  const replayed = await readTrainingInfluence(client, saved.id);
  assert.equal(replayed.at, "7"); assert.deepEqual(replayed.report, saved.report);
  assert.equal((await readTrainingInfluence(client, saved.id, "1")).at, "1");
  const get = client.get.bind(client); let changed = false;
  Reflect.set(client, "get", async (...args: Parameters<typeof get>) => {
    const result = await get(...args);
    if (args[1]?.at === "7" && !changed) { changed = true; await client.update(saved.id, { type: "Task" }); }
    return result;
  });
  await assert.rejects(readTrainingInfluence(client, saved.id), refused("influence_foreign"));
  assert.equal((await get(saved.id, { full: true })).item.type, "Task");
});

test("retained policy-card ownership agrees across producers, preflights and consumers", async () => {
  const { client } = await workspace(); await client.schemaAddType("Generation", { folder: "generations", defaultStatus: "open" });
  const spec: GenerationSpec = { base_checkpoint: "checkpoint", policy: "", collection_runs: [], training_config: { samples: 10 }, environment_version: "", reward_spec_version: "", parent: null, seed: true, promoted: false, approval: null, proxy_score: null, held_out_score: null, gap: null, promotion_evidence: null };
  await client.create({ id: "card-seed", type: "Generation", title: "Owned source", body: `\`\`\`json\n${JSON.stringify(spec)}\n\`\`\``, affectedVersion: hashJson(generationProvenance(spec)), unset: ["parent"] });
  const card = await recordPolicyCard(client, "card-seed"); const id = `policy-card-${card.digest}`;
  const native = (await client.get(id, { full: true })).item;
  for (const change of [{ type: "Task" }, { tags: "foreign" }, { affectedVersion: "foreign" }, { body: "Foreign body" }]) {
    await client.update(id, change);
    assert.equal((await discoverPolicyCards(client)).length, 0);
    const typed = (error: unknown): boolean => isPmCliExpectedError(error) && error.context.code === "card_drift";
    await assert.rejects(recordPolicyCard(client, "card-seed"), typed);
    await assert.rejects(recordRecursivePolicyCards(client, "card-seed"), typed);
    await client.update(id, { type: "Decision", tags: "rl-policy-card", affectedVersion: card.digest, body: String(native.body) });
  }
  assert.equal((await discoverPolicyCards(client)).length, 1);
  assert.equal((await recordPolicyCard(client, "card-seed")).digest, card.digest);
});

test("influence ownership stays consistent after a peer changes every persistence boundary", async () => {
  const w = await workspace(); const peer = new PmClient({ cwd: w.root, pmRoot: w.pmRoot, author: "influence-peer", noExtensions: true });
  const originalCreate = w.client.create.bind(w.client); const originalGet = w.client.get.bind(w.client);
  let calls = 0; let injectAt = -1; let inject: (() => Promise<void>) | undefined;
  // Check before every SDK read and immediately after native creation, including the originally missed race.
  Reflect.set(w.client, "create", async (...args: Parameters<typeof originalCreate>) => {
    const result = await originalCreate(...args); if (++calls === injectAt) await inject!(); return result;
  });
  Reflect.set(w.client, "get", async (...args: Parameters<typeof originalGet>) => {
    if (++calls === injectAt) await inject!(); return originalGet(...args);
  });
  await recordTrainingInfluence(w.client, request(3999)); const boundaries = calls;
  for (let boundary = 1; boundary <= boundaries; boundary += 1) for (const field of ["type", "body", "tags", "affectedVersion"] as const) {
    const input = request(3000 + boundary * 10 + ["type", "body", "tags", "affectedVersion"].indexOf(field));
    const id = `rl-training-influence-${measureTrainingInfluence(input).digest}`;
    const change = field === "type" ? { type: "Task" } : field === "body" ? { body: "Foreign body" } : field === "tags" ? { tags: "foreign" } : { affectedVersion: "foreign" };
    inject = async () => { await recordTrainingInfluence(peer, input); await peer.update(id, change); };
    calls = 0; injectAt = boundary;
    await assert.rejects(recordTrainingInfluence(w.client, input), refused("influence_foreign"), `${boundary}/${field}`);
    assert.ok(calls >= boundary); injectAt = -1;
    const foreign = (await peer.get(id, { full: true })).item;
    assert.equal(foreign.type, field === "type" ? "Task" : "Decision");
    assert.equal(foreign.body === "Foreign body", field === "body");
    await assert.rejects(readTrainingInfluence(peer, id));
    await assert.rejects(attachTrainingInfluence(peer, programme(input), id));
  }
});

test("native project prefixes round-trip through SDK identity even when they overlap the report name", async () => {
  for (const [index, project] of ["rl", "training", "training-influence", "slice"].entries()) {
    const { client } = await workspace(project); const input = request(6100 + index);
    const saved = await recordTrainingInfluence(client, input);
    const prefix = String((await client.config("project", "get", "id_prefix")).nested_setting!.value);
    assert.equal(saved.id, normalizeItemId(`training-influence-${saved.report.digest}`, prefix));
    assert.deepEqual((await readTrainingInfluence(client, saved.id)).report, saved.report);
    assert.equal((await recordTrainingInfluence(client, input)).created, false);
    await verifyTrainingInfluenceProposal(client, await attachTrainingInfluence(client, programme(input), saved.id));
    const native = (await client.get(saved.id, { full: true })).item;
    const foreign = await client.create({ id: `unexpected-training-influence-${saved.report.digest}`, type: "Decision", title: "Foreign native identity", body: String(native.body), tags: "rl-training-influence", affectedVersion: saved.report.digest, unset: ["parent"] });
    await assert.rejects(readTrainingInfluence(client, foreign.item.id), refused("influence_foreign"));
  }
});

test("foreign or corrupted named records refuse alone and cannot alter unrelated evidence", async () => {
  const { client, pmRoot } = await workspace(); const p = request(8675309);
  const saved = await recordTrainingInfluence(client, p); const native = (await client.get(saved.id, { full: true })).item;
  const row = JSON.parse(String(native.body)) as Record<string, unknown>;
  await client.create({ id: "foreign-task", type: "Task", title: "Foreign task", unset: ["parent"] });
  await assert.rejects(readTrainingInfluence(client, "foreign-task"), refused("influence_foreign"));
  await client.create({ id: "foreign-decision", type: "Decision", title: "Unowned decision", body: String(native.body), affectedVersion: saved.report.digest, unset: ["parent"] });
  await assert.rejects(readTrainingInfluence(client, "foreign-decision"), refused("influence_foreign"));
  for (const patch of [{ format: "foreign" }, { id: "foreign" }, { report: { digest: "wrong" } }]) {
    await client.update(saved.id, { body: JSON.stringify({ ...row, ...patch }) });
    await assert.rejects(readTrainingInfluence(client, saved.id), (error: unknown) => isPmCliExpectedError(error));
  }
  await client.update(saved.id, { body: "broken JSON" });
  await assert.rejects(readTrainingInfluence(client, saved.id), refused("influence_foreign"));
  await client.update(saved.id, { body: String(native.body), affectedVersion: "other" });
  await assert.rejects(readTrainingInfluence(client, saved.id), refused("influence_foreign"));
  await assert.rejects(recordTrainingInfluence(client, p), refused("influence_foreign"));
  await client.update(saved.id, { affectedVersion: saved.report.digest, tags: "foreign" });
  await assert.rejects(readTrainingInfluence(client, saved.id), refused("influence_foreign"));
  await assert.rejects(recordTrainingInfluence(client, p), refused("influence_foreign"));
  await client.update(saved.id, { tags: "rl-training-influence" });
  assert.deepEqual((await recordTrainingInfluence(client, p)).report, saved.report); // ABA uses current target, no stale cache
  await client.create({ id: "foreign-identity", type: "Decision", title: "Foreign identity", body: String(native.body), tags: "rl-training-influence", affectedVersion: saved.report.digest, unset: ["parent"] });
  await assert.rejects(readTrainingInfluence(client, "foreign-identity"), refused("influence_foreign"));
  const other = await recordTrainingInfluence(client, request(1234567));
  rmSync(join(pmRoot, "history", `${other.id}.jsonl`)); // only a disposable corruption fixture, never tracked history
  await assert.rejects(readTrainingInfluence(client, other.id));
  assert.deepEqual((await readTrainingInfluence(client, saved.id)).report, saved.report);
});

test("compacted disposable histories use durable SDK versions rather than physical row positions", async () => {
  const { client } = await workspace(); const p = request(801); const saved = await recordTrainingInfluence(client, p);
  for (let index = 0; index < 5; index += 1) await client.update(saved.id, { title: `Annotation ${index}` });
  // Compaction is exercised only on this new disposable fixture; tracked histories are never rewritten.
  const compacted = await client.historyCompact(saved.id, { before: "5" });
  assert.equal(compacted.changed, true);
  const read = await readTrainingInfluence(client, saved.id);
  const history = await client.run("history", { id: saved.id, options: { compact: true, verify: true, outputLimit: "unbounded", outputBudget: "unbounded" } }) as HistoryResult;
  assert.equal(read.at, String(history.version_addressing!.last_version));
  assert.deepEqual(read.report, saved.report);
  const proposal = await attachTrainingInfluence(client, programme(p), saved.id);
  await verifyTrainingInfluenceProposal(client, proposal);
  const historical = await readTrainingInfluence(client, saved.id, read.at);
  assert.deepEqual(historical.report, saved.report);
});
