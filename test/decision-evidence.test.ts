/** Adversarial graphs are certified and corrupted through the real SDK in a non-git tracker. */
import assert from "node:assert/strict";
import { rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { PmClient } from "@unbrained/pm-cli/sdk/core";
import { createPmCliExpectedError, isPmCliExpectedError } from "@unbrained/pm-cli/sdk/runtime";
import { captureDecisionInputs, extractGenerationSpec, hashJson, readCompleteLoopItem, generationProvenance, verifyDecisionEvidence, withRlController, recordRefusedPolicyCard, DECISION_INPUT_FIELDS, type JsonValue } from "../index.ts";
import { evaluationEvidence, parseEvaluationEvidence, readEvaluationDecision, validateEvaluationReport } from "../evaluation-plan.ts";
import { exportPolicyCard, replayPolicyCard, type PolicyCard } from "../policy-card.ts";
import { recordSequentialEvaluation } from "../sequential-evaluation.ts";
import { skippedTrackerRecords, decodeTrackerRecord } from "../tracker-record.ts";
import { decisionFixture } from "./fixtures/decision-evidence.ts";

/** Every refusal must name an actual damaged input, never fail accidentally in JSON or filesystem code. */
function names(ids: readonly string[]) { return (error: unknown) => isPmCliExpectedError(error) && ids.includes(String(error.context.item_id)); }

/** Enumerate every actual citation and pair across the supplied card outcomes. */
async function corruptDecisionCards(client: PmClient, cards: readonly PolicyCard[]): Promise<void> {
    const cases: string[][] = cards.some((card) => card.evidence.some((entry) => entry.id.endsWith("-look-2"))) ? [["rl-review", "rl-candidate-evaluation-plan-look-2"]] : [];
    const ids = [...new Set(cards.flatMap((card) => card.evidence.map((input) => input.id)))].sort();
    for (let i = 0; i < ids.length; i += 1) {
      cases.push([ids[i]]);
      for (let j = i + 1; j < ids.length; j += 1) cases.push([ids[i], ids[j]]);
    }
    const originals = new Map(await Promise.all(ids.map(async (id) => [id, (await readCompleteLoopItem(client, id)).item] as const)));
    let checks = 0;
    for (const damaged of cases) {
      for (const id of damaged) {
        const item = originals.get(id)!;
        await client.update(id, item.type === "Generation" ? { affectedVersion: "corrupt" } : { body: `${String(item.body ?? "")}\ncorrupt` });
      }
      for (const card of cards) {
        // Frozen execution cards intentionally ignore later source mutations; only their own receipt is live.
        if ((originals.get(card.subject)!.type === "Decision" && !damaged.includes(card.subject)) || !damaged.some((id) => card.evidence.some((input) => input.id === id))) {
          assert.equal((await exportPolicyCard(client, card.subject, card.selection)).digest, card.digest);
          assert.deepEqual((await replayPolicyCard(client, card)).card, card);
          continue;
        }
        let changed = false;
        try { changed = (await exportPolicyCard(client, card.subject, card.selection)).digest !== card.digest; }
        catch (error) { assert.ok(names(damaged)(error), `Fresh refusal must name ${damaged}: ${String(error)}`); }
        if (!changed) await assert.rejects(replayPolicyCard(client, card), names(damaged));
        checks += 1;
      }
      for (const id of damaged) {
        const item = originals.get(id)!;
        await client.update(id, item.type === "Generation" ? { affectedVersion: String(item.affected_version) } : { body: String(item.body ?? "") });
      }
      if (checks % 40 === 0) console.log(JSON.stringify({ corruption_checks_completed: checks }));
    }
    for (const card of cards) assert.equal((await exportPolicyCard(client, card.subject, card.selection)).digest, card.digest);
    console.log(JSON.stringify({ outcome: cards[0].outcome, inputs: ids.length, mutation_sets: cases.length, cards: cards.length, corruption_checks: checks, non_git: true }));
}

test("decision graph property corrupts every input and every pair for generation recursive and selected cards", async () => {
  const w = await decisionFixture();
  try {
    assert.equal(existsSync(join(w.root, ".git")), false);
    const decided = await readEvaluationDecision(w.client, w.plan.candidate);
    for (const alias of ["CANDIDATE", "#RL-CANDIDATE", " rl-candidate "]) assert.deepEqual((await readEvaluationDecision(w.client, alias)).evidence, decided.evidence);
    const receipt = extractGenerationSpec(String(w.native.item.body), "Promoted receipt").evaluation_evidence!;
    assert.deepEqual(receipt, decided.evidence, "Promotion receipt must seal all evaluation inputs");
    assert.equal(w.report.evidence_digest, receipt.digest);
    const required = ["rl-review", "rl-candidate-evaluation-plan", "rl-candidate-evaluation-plan-look-1", "rl-candidate-evaluation-plan-look-2", "rl-collection", "rl-seed", "rl-candidate"];
    assert.deepEqual(receipt.inputs.map((input) => input.id).sort(), required.sort());
    const stepGraph = JSON.parse(String((await readCompleteLoopItem(w.client, "rl-graph-step-decision")).item.body)) as { decision_evidence: typeof receipt };
    for (const card of w.cards) {
      assert.deepEqual(card.decision_evidence, card.subject === w.plan.candidate ? receipt : stepGraph.decision_evidence, "Card must embed the exact decision input graph");
      assert.ok(card.decision_evidence, "Decision input root missing"); assert.ok(required.every((id) => card.evidence.some((citation) => citation.id === id)));
      assert.deepEqual((await replayPolicyCard(w.client, card)).card, card);
    }
    await corruptDecisionCards(w.client, w.cards);
  } finally { rmSync(w.root, { recursive: true, force: true }); }
});

test("graph boundary and seeded 500 transport sequences retain SDK-read native state and refuse malformed graphs", async () => {
  const w = await decisionFixture(true, false);
  try {
    const spec = extractGenerationSpec(String(w.native.item.body), "Native promotion");
    const graph = spec.evaluation_evidence!;
    const aliasBody = { format: graph.format, comparison: graph.comparison, inputs: graph.inputs.map((input) => input.id === w.plan.candidate ? { ...input, id: "candidate" } : input) };
    await assert.rejects(verifyDecisionEvidence(w.client, parseEvaluationEvidence({ ...aliasBody, digest: hashJson(aliasBody as unknown as JsonValue) })), names(["candidate"]));
    const inner = await captureDecisionInputs(w.client, async () => { await readCompleteLoopItem(w.client, w.plan.candidate); return 1; }, true);
    assert.deepEqual(inner.inputs, []);
    const status = "custom_working"; await w.client.schemaAddStatus(status, { role: ["active"] });
    await w.client.create({ id: "rl-roundtrip", title: "Graph transport", body: JSON.stringify(spec) });
    const model = { graph, parent: "rl-seed", blocked_by: "rl-collection", status };
    let seed = 0x107e71;
    const older: string[] = [];
    for (let sequence = 0; sequence < 500; sequence += 1) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      const serialized = JSON.stringify(spec, null, seed % 2 ? 2 : 0).replaceAll("\n", "\r\n"); older.push(serialized);
      await w.client.update("rl-roundtrip", { body: older[seed % older.length], parent: model.parent, blockedBy: model.blocked_by, status: model.status });
      const actual = (await readCompleteLoopItem(w.client, "rl-roundtrip", undefined, "id,body,parent,blocked_by,status")).item;
      assert.deepEqual(extractGenerationSpec(`\`\`\`json\n${actual.body}\n\`\`\``, "SDK roundtrip").evaluation_evidence, model.graph);
      assert.equal(actual.parent, model.parent); assert.equal(actual.blocked_by, model.blocked_by); assert.equal(actual.status, model.status);
      assert.equal(hashJson(parseEvaluationEvidence(model.graph) as unknown as JsonValue), hashJson(graph as unknown as JsonValue));
    }
    for (const value of [null, {}, { ...graph, inputs: new Array(1) }, { ...graph, inputs: [null] }, { ...graph, inputs: [{ id: "../outside", digest: "x" }] }, { ...graph, inputs: [...graph.inputs, graph.inputs[0]] }, { ...graph, digest: "0".repeat(64) }, { ...graph, inputs: [{ ...graph.inputs[0], at: "Infinity" }] }]) assert.throws(() => parseEvaluationEvidence(value), isPmCliExpectedError);
    assert.throws(() => validateEvaluationReport(w.plan, { ...w.report, evidence_digest: "bad" }), isPmCliExpectedError);
    await assert.rejects(captureDecisionInputs(w.client, async () => { throw createPmCliExpectedError("typed probe", { exitCode: 4, context: { code: "eval_plan_invalid" } }); }), (error: unknown) => isPmCliExpectedError(error) && error.context.item_id === "evaluation-input");
    await assert.rejects(captureDecisionInputs(w.client, async () => { await readCompleteLoopItem(w.client, w.plan.candidate); throw createPmCliExpectedError("typed probe", { exitCode: 4, context: { code: "eval_plan_invalid" } }); }), names([w.plan.candidate]));
    const peer = new PmClient({ pmRoot: w.pmRoot, cwd: w.root, author: "decision-peer", noExtensions: true });
    assert.deepEqual((await captureDecisionInputs(w.client, () => readCompleteLoopItem(peer, w.plan.candidate))).inputs, []);
    const first = graph.inputs[0];
    await assert.rejects(verifyDecisionEvidence(w.client, { ...graph, inputs: [{ ...first, digest: "0".repeat(64) }] }), names([first.id]));
    await assert.rejects(captureDecisionInputs(w.client, async () => { throw new Error("native failure"); }), /native failure/);
    const snapshot = await readCompleteLoopItem(w.client, w.plan.candidate);
    assert.equal(evaluationEvidence(graph.comparison, [snapshot.item]).inputs.length, 1);
    console.log(JSON.stringify({ transport_sequences: 500, model: "immutable SDK-read graph plus explicit native relationships and custom status" }));
  } finally { rmSync(w.root, { recursive: true, force: true }); }
});

test("strict input graph schema has 500 seeded must-allow and must-refuse transports", () => {
  const envelope = { id: "rl-large-plan", type: "Plan", body: JSON.stringify({ plan: { format: "pm-rl/evaluation-plan/1" }, padding: " ".repeat(1_048_576) }) };
  assert.equal(decodeTrackerRecord(null, envelope, { type: "Plan" }), null);
  assert.ok(decodeTrackerRecord(null, envelope, { type: "Plan", maxBytes: 16_777_216 }));
  let seed = 0x5e17;
  for (let index = 0; index < 500; index += 1) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const body = { format: index % 2 ? "pm-rl/evaluation-evidence/2" as const : "pm-rl/evaluation-evidence/1" as const, comparison: hashJson(index), inputs: [{ id: `rl-input-${seed}`, digest: hashJson(seed), ...(index % 2 ? { at: String(index + 1) } : {}) }] };
    const valid = { ...body, digest: hashJson(body as unknown as JsonValue) };
    assert.deepEqual(parseEvaluationEvidence(JSON.parse(` \r\n${JSON.stringify(valid, null, index % 3 ? 2 : 0).replaceAll("\n", "\r\n")}\r\n`)), valid);
    const malformed = [
      { ...valid, format: "foreign" }, { ...valid, comparison: null }, { ...valid, inputs: [] }, { ...valid, inputs: new Array(1) },
      { ...valid, inputs: Array(10001).fill(body.inputs[0]) }, { ...valid, inputs: [{ id: 1, digest: "a".repeat(64) }] },
      { ...valid, inputs: [{ id: "rl-input", digest: Infinity }] }, { ...valid, inputs: [{ id: "rl-input", digest: "bad" }] },
      { ...valid, inputs: [{ ...body.inputs[0], at: 1 }] }, { ...valid, inputs: [{ ...body.inputs[0], at: "9007199254740992" }] },
      { ...valid, inputs: [{ ...body.inputs[0], at: "0" }] }, { ...valid, inputs: [{ ...body.inputs[0], id: "RL-input" }] },
      { ...valid, format: "pm-rl/evaluation-evidence/2", inputs: [{ id: "rl-input", digest: hashJson(seed) }] },
    ];
    assert.throws(() => parseEvaluationEvidence(malformed[index < malformed.length ? index : seed % malformed.length]), isPmCliExpectedError);
  }
});

test("completed promotion and recursive receipts refuse graph removal and rehashed subsets", async () => {
  const w = await decisionFixture();
  try {
    for (const card of w.cards) {
      const { digest: _cardDigest, decision_evidence: _graph, ...remaining } = card;
      await assert.rejects(replayPolicyCard(w.client, { ...remaining, digest: hashJson(remaining as unknown as JsonValue) }), names([card.subject]));
    }
    for (const id of [w.plan.candidate, "rl-graph-step-decision"]) {
      const original = (await readCompleteLoopItem(w.client, id)).item;
      const generation = id === w.plan.candidate;
      const payload = generation ? extractGenerationSpec(String(original.body), "Receipt") : JSON.parse(String(original.body)) as Record<string, JsonValue>;
      const field = generation ? "evaluation_evidence" : "decision_evidence";
      const graph = parseEvaluationEvidence((payload as unknown as Record<string, unknown>)[field]);
      const { digest: _digest, ...body } = graph;
      const subset = { ...body, inputs: graph.inputs.slice(0, 1) };
      for (const replacement of [undefined, { ...subset, digest: hashJson(subset as unknown as JsonValue) }]) {
        const changed = { ...payload, [field]: replacement };
        await w.client.update(id, { body: generation ? `\`\`\`json\n${JSON.stringify(changed)}\n\`\`\`` : JSON.stringify(changed) });
        await assert.rejects(exportPolicyCard(w.client, id), names([id]));
        if (generation) for (const alias of [id, "CANDIDATE", "#RL-CANDIDATE", " rl-candidate "]) await assert.rejects(readEvaluationDecision(w.client, alias), names([id]));
        else await assert.rejects(withRlController(w.client, { pmRoot: w.pmRoot, author: "decision-test" }, { id: "graph", approval: "rl-approval", recoveryCommand: "pm rl meta resume graph" }, new AbortController().signal,
          (step) => step("decision", { candidate: w.plan.candidate }, async () => assert.fail("A completed decision must never be rerun"))), names([id]));
        await w.client.update(id, { body: String(original.body) });
      }
      if (!generation) {
        await w.client.update(id, { body: JSON.stringify({ ...payload, state: "running", decision_evidence: undefined, result: undefined, digest: undefined }) });
        await assert.rejects(withRlController(w.client, { pmRoot: w.pmRoot, author: "decision-test" }, { id: "graph", approval: "rl-approval", recoveryCommand: "pm rl meta resume graph" }, new AbortController().signal,
          (step) => step("decision", { candidate: w.plan.candidate }, async () => assert.fail("A completed decision must never be downgraded"))), names([id]));
        await w.client.update(id, { body: String(original.body) });
      }
    }
  } finally { rmSync(w.root, { recursive: true, force: true }); }
});

test("candidate and rejected cards seal the same decision graph and reject collection after a sealed refusal", async () => {
  const w = await decisionFixture(false, false, false);
  try {
    const before = w.candidateCard;
    assert.deepEqual(before.decision_evidence, (await readEvaluationDecision(w.client, w.plan.candidate, true)).evidence);
    assert.equal(before.outcome, "candidate");
    await corruptDecisionCards(w.client, [before]);
    assert.equal(await recordRefusedPolicyCard(w.client, w.plan.candidate, "Bounded evaluator rejected the candidate"), "refused");
    const item = await readCompleteLoopItem(w.client, w.plan.candidate);
    const spec = extractGenerationSpec(String(item.item.body), "Rejected receipt");
    const card = await exportPolicyCard(w.client, w.plan.candidate);
    assert.equal(card.outcome, "refused"); assert.deepEqual(card.decision_evidence, spec.evaluation_evidence);
    await corruptDecisionCards(w.client, [card]);
    const restored = await readCompleteLoopItem(w.client, w.plan.candidate);
    assert.equal(restored.item.body, item.item.body); assert.equal(restored.item.affected_version, item.item.affected_version);
    assert.deepEqual((await replayPolicyCard(w.client, before)).card, before);
    assert.deepEqual((await replayPolicyCard(w.client, card)).card, card);
    await assert.rejects(recordSequentialEvaluation(w.client, w.plan.candidate, w.rows), (error: unknown) => isPmCliExpectedError(error) && error.context.code === "eval_plan_stopping");
    assert.deepEqual(await readCompleteLoopItem(w.client, w.plan.candidate), restored);
    const changed = { ...spec, evaluation_evidence: undefined };
    await w.client.update(w.plan.candidate, { body: `\`\`\`json\n${JSON.stringify(changed)}\n\`\`\`` });
    await assert.rejects(exportPolicyCard(w.client, w.plan.candidate), names([w.plan.candidate]));
    await w.client.update(w.plan.candidate, { body: String(item.item.body) });
    assert.equal(await recordRefusedPolicyCard(w.client, w.plan.candidate, "A different retry reason"), "refused");
    assert.deepEqual(extractGenerationSpec(String((await readCompleteLoopItem(w.client, w.plan.candidate)).item.body), "Retry").policy_evaluation, spec.policy_evaluation);
  } finally { rmSync(w.root, { recursive: true, force: true }); }
});

test("rejection pins every graph revision through its SDK write and releases its leases on a competing input edit", async () => {
  const w = await decisionFixture(false, false, false);
  try {
    const original = await readCompleteLoopItem(w.client, w.plan.candidate);
    const peer = new PmClient({ pmRoot: w.pmRoot, cwd: w.root, author: "decision-peer", noExtensions: true });
    const get = w.client.get.bind(w.client); let armed = true;
    w.client.get = (async (...args) => {
      const result = await get(...args);
      if ("item" in result && armed && args[0] === "rl-candidate-evaluation-plan-look-1" && args[1]?.fields === DECISION_INPUT_FIELDS) {
        armed = false; await peer.update(args[0], { body: `${String(result.item.body)}\ncorrupt` });
      }
      return result;
    }) as PmClient["get"];
    await assert.rejects(recordRefusedPolicyCard(w.client, w.plan.candidate, "Never seal stale inputs"), (error: unknown) => isPmCliExpectedError(error) && ["loop_write_conflict", "card_drift"].includes(String(error.context.code)));
    assert.equal(armed, false); assert.deepEqual(await readCompleteLoopItem(w.client, w.plan.candidate), original);
    await peer.update(w.plan.candidate, { priority: 3 });
  } finally { rmSync(w.root, { recursive: true, force: true }); }
});

test("fixed review and final look corruption refuses fresh cards and replay from all SDK aliases", async () => {
  const w = await decisionFixture(true, false);
  try {
    const card = await exportPolicyCard(w.client, w.plan.candidate);
    assert.deepEqual(card.decision_evidence, (await readEvaluationDecision(w.client, w.plan.candidate)).evidence);
    const parent = extractGenerationSpec(String((await readCompleteLoopItem(w.client, w.plan.candidate)).item.body), "Parent");
    await w.client.create({ id: "rl-child-run", title: "Child collection", type: "Run", environment: "rl-training" });
    const child = { ...parent, parent: w.plan.candidate, promoted: false, approval: null, proxy_score: null, held_out_score: null, gap: null, promotion_evidence: null, evaluation_plan: undefined, evaluation_evidence: undefined, collection_runs: ["rl-child-run"] };
    await w.client.create({ id: "rl-child", title: "Child policy", type: "Generation", body: `\`\`\`json\n${JSON.stringify(child)}\n\`\`\``, affectedVersion: hashJson(generationProvenance(child)) });
    await w.client.create({ id: "rl-child-evaluation-plan", type: "Plan", title: "Foreign plan slot", body: "foreign record" });
    const childCard = await exportPolicyCard(w.client, "rl-child");
    assert.deepEqual((await replayPolicyCard(w.client, childCard)).card, childCard);
    assert.ok(skippedTrackerRecords(w.client).some((entry) => entry.id === "rl-child-evaluation-plan" && entry.reason === "invalid_json"));
    for (const foreign of [{}, { plan: null }, { plan: false }, { plan: [] }, { plan: { format: "foreign" } }]) {
      await w.client.update("rl-child-evaluation-plan", { body: JSON.stringify(foreign) });
      assert.equal((await exportPolicyCard(w.client, "rl-child")).digest, childCard.digest);
      assert.ok(skippedTrackerRecords(w.client).some((entry) => entry.id === "rl-child-evaluation-plan" && entry.reason === "invalid_shape"));
    }
    const orphan = { ...parent, evaluation_plan: undefined };
    await w.client.create({ id: "rl-orphan", type: "Generation", title: "Retained graph requires its plan", body: `\`\`\`json\n${JSON.stringify(orphan)}\n\`\`\``, affectedVersion: hashJson(generationProvenance(orphan)) });
    for (const pending of [true, false]) await assert.rejects(readEvaluationDecision(w.client, "rl-orphan", pending), names(["rl-orphan-evaluation-plan"]));

    await w.client.update("rl-review", { body: "corrupt review" });
    await w.client.update("rl-candidate-evaluation-plan-look-2", { affectedVersion: "corrupt checkpoint" });
    for (const alias of [w.plan.candidate, "CANDIDATE", "#RL-CANDIDATE", " rl-candidate "]) {
      await assert.rejects(exportPolicyCard(w.client, alias), names(["rl-review", "rl-candidate-evaluation-plan-look-2"]));
      await assert.rejects(readEvaluationDecision(w.client, alias), names(["rl-review", "rl-candidate-evaluation-plan-look-2"]));
    }
    await assert.rejects(replayPolicyCard(w.client, card), names(["rl-review", "rl-candidate-evaluation-plan-look-2"]));
    await assert.rejects(exportPolicyCard(w.client, "rl-child"), names(["rl-review", "rl-candidate-evaluation-plan-look-2"]));
    await assert.rejects(replayPolicyCard(w.client, childCard), names(["rl-review", "rl-candidate-evaluation-plan-look-2"]));
  } finally { rmSync(w.root, { recursive: true, force: true }); }
});
