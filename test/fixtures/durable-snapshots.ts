/** Immutable execution properties shared by native and packed Node/Bun consumers. */
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { isPmCliExpectedError } from "@unbrained/pm-cli/sdk/runtime";
import { captureDecisionInputs, extractGenerationSpec, DECISION_INPUT_FIELDS, firstDecisionSnapshot, hashJson, generationProvenance, readCompleteLoopItem, withRlController, promoteGenerationCore, verifyDecisionEvidence, verifyDecisionSnapshots, type JsonValue } from "../../index.ts";
import { evaluationInputDigest, evaluationEvidence, decisionSnapshotDigest, readEvaluationDecision, registerEvaluationPlan, evaluationComparison, type EvaluationPlan } from "../../evaluation-plan.ts";
import { exportPolicyCard, replayPolicyCard, type PolicyCard } from "../../policy-card.ts";
import { recordSequentialEvaluation } from "../../sequential-evaluation.ts";
import { decisionFixture } from "./decision-evidence.ts";
import type { EvaluationEvidence, GenerationSpec } from "../../lineage.ts";

/** Generate successive valid promotions, replay every earlier step, and corrupt every snapshot and pair. */
export async function durableSnapshotProperty(cycles = 3) {
  const w = await decisionFixture(false, false);
  const coordinates = { pmRoot: w.pmRoot, author: "decision-test" };
  const request = { id: "snapshots", approval: "rl-approval", recoveryCommand: "pm rl meta resume snapshots" };
  const receipts: { key: string; input: JsonValue; id: string; cards: PolicyCard[] }[] = [];
  let executions = 0; let replays = 0; let corruptions = 0; let snapshotChecks = 0;
  try {
    await w.client.update("rl-approval", { body: `\`\`\`json\n${JSON.stringify({ permitted_promotions: cycles + 1 })}\n\`\`\`` });
    // Pre-fix v1 receipts already carry certified coordinates; they must replay without a format migration.
    const legacyInput = { candidate: w.plan.candidate, legacy: true };
    const captured = await captureDecisionInputs(w.client, () => readEvaluationDecision(w.client, w.plan.candidate));
    const versions = new Map<string, string>();
    for (const item of captured.inputs) versions.set(item.id, (await firstDecisionSnapshot(w.client, item.id, (row) => evaluationInputDigest(row, hashJson(legacyInput)) === evaluationInputDigest(item, hashJson(legacyInput)), DECISION_INPUT_FIELDS)).at);
    const legacyGraph = evaluationEvidence(hashJson(legacyInput), captured.inputs, versions);
    const ref = legacyGraph.inputs[0];
    for (const input of [{ id: ref.id, digest: ref.digest }, { ...ref, at: "9007199254740991" }, { ...ref, id: "rl-missing-snapshot" }]) {
      await assert.rejects(verifyDecisionSnapshots(w.client, { ...legacyGraph, inputs: [input] }), (error: unknown) => isPmCliExpectedError(error) && error.message.includes(input.id));
    }
    const result = { configs: [{ samples: 1 }, { samples: 2 }] };
    const legacy = { format: "pm-rl/loop-step/1", key: "snapshots-step-legacy", input: hashJson(legacyInput), state: "complete", result, digest: hashJson(result), decision_evidence: legacyGraph };
    await w.client.create({ id: `rl-${legacy.key}`, type: "Decision", title: "Pre-fix receipt", body: JSON.stringify(legacy) });
    receipts.push({ key: "legacy", input: legacyInput, id: `rl-${legacy.key}`, cards: [await exportPolicyCard(w.client, `rl-${legacy.key}`)] });
    let plan = w.plan;
    for (let cycle = 0; cycle < cycles; cycle += 1) {
      const input = { candidate: plan.candidate }; const key = `evaluate-${cycle}`; const id = `rl-snapshots-step-${key}`;
      await withRlController(w.client, coordinates, request, new AbortController().signal, (step) => step(key, input, async () => {
        executions += 1; await readEvaluationDecision(w.client, plan.candidate); return result;
      }));
      console.log(JSON.stringify({ snapshot_cycle: cycle, stage: "evaluated" }));
      const cards = [];
      for (const selection of [null, 0, 1]) cards.push(await exportPolicyCard(w.client, id, selection));
      assert.equal(cards[0].decision_evidence?.format, "pm-rl/evaluation-evidence/2");
      await assert.rejects(verifyDecisionEvidence(w.client, cards[0].decision_evidence!), (error: unknown) => isPmCliExpectedError(error) && error.context.code === "eval_plan_evidence");
      receipts.push({ key, input, id, cards });
      const report = (await readEvaluationDecision(w.client, plan.candidate)).report!;
      const score = { ...w.score, seed_set: evaluationComparison(plan), value: report.candidate_mean };
      await promoteGenerationCore(w.client, coordinates, plan.candidate, "rl-approval", { ...score, evaluation_context: "proxy" }, score, "Frozen execution property");
      console.log(JSON.stringify({ snapshot_cycle: cycle, stage: "promoted" }));
      for (const receipt of receipts) {
        await withRlController(w.client, coordinates, request, new AbortController().signal, (step) => step(receipt.key, receipt.input, async () => assert.fail("A completed operation reran")));
        for (const card of receipt.cards) {
          assert.equal((await exportPolicyCard(w.client, receipt.id, card.selection)).digest, card.digest);
          assert.deepEqual((await replayPolicyCard(w.client, card)).card, card); replays += 1;
        }
      }
      if (cycle + 1 === cycles) break;
      const incumbent = w.plan.incumbent; const version = String((await readCompleteLoopItem(w.client, incumbent)).item.affected_version);
      const candidate = `rl-candidate-${cycle + 1}`; const review = `rl-review-${cycle + 1}`; const run = `rl-collection-${cycle + 1}`;
      assert.equal(plan.stopping.kind, "sequential");
      plan = { ...plan, candidate, incumbent, incumbent_version: version, stopping: { ...w.plan.stopping, review } } as EvaluationPlan;
      await w.client.create({ id: review, type: "Decision", title: "Review", body: JSON.stringify({ format: "pm-rl/sequential-review/1", comparison: evaluationComparison(plan) }) });
      await registerEvaluationPlan(w.client, plan);
      await w.client.create({ id: run, type: "Run", title: "Collection", environment: "rl-training" });
      const source = extractGenerationSpec(String(w.native.item.body), "Next candidate source");
      const spec: GenerationSpec = { ...source, parent: incumbent, collection_runs: [run], base_checkpoint: `sha256:${hashJson(candidate)}`, evaluation_plan: evaluationComparison(plan) };
      await w.client.create({ id: candidate, type: "Generation", title: "Next candidate", body: `\`\`\`json\n${JSON.stringify(spec)}\n\`\`\``, affectedVersion: hashJson(generationProvenance(spec)) });
      await recordSequentialEvaluation(w.client, candidate, w.rows.slice(0, 16));
      await recordSequentialEvaluation(w.client, candidate, w.rows);
    }
    // Every immutable input, including pairs, remains integrity checked independently of live state.
    for (const receipt of receipts) {
      const original = String((await readCompleteLoopItem(w.client, receipt.id)).item.body);
      const body = JSON.parse(original) as { decision_evidence: EvaluationEvidence };
      const refs = body.decision_evidence.inputs;
      for (let i = 0; i < refs.length; i += 1) for (let j = i; j < refs.length; j += 1) {
        const damaged = [...new Set([i, j])];
        const inputs = refs.map((ref, index) => damaged.includes(index) ? { ...ref, digest: "0".repeat(64) } : ref);
        const graphBody = { format: body.decision_evidence.format, comparison: body.decision_evidence.comparison, inputs };
        const graph = { ...graphBody, digest: hashJson(graphBody as unknown as JsonValue) };
        const expected = `${refs[i].id}@${refs[i].at}`;
        const named = (error: unknown) => isPmCliExpectedError(error) && error.message.includes(expected);
        await assert.rejects(verifyDecisionSnapshots(w.client, graph), named); snapshotChecks += 1;
        await w.client.update(receipt.id, { body: JSON.stringify({ ...body, decision_evidence: graph }) });
        try {
          await assert.rejects(withRlController(w.client, coordinates, request, new AbortController().signal, (step) => step(receipt.key, receipt.input, async () => assert.fail("Corrupted step reran"))), named);
          for (const card of receipt.cards) {
            await assert.rejects(exportPolicyCard(w.client, receipt.id, card.selection), named);
            await assert.rejects(replayPolicyCard(w.client, card), named); corruptions += 2;
          }
        } finally { await w.client.update(receipt.id, { body: original }); }
        assert.equal((await readCompleteLoopItem(w.client, receipt.id)).item.body, original);
      }
      await verifyDecisionSnapshots(w.client, body.decision_evidence);
      console.log(JSON.stringify({ snapshot_receipt: receipt.key, corruption_checks: corruptions }));
    }
    assert.equal(executions, cycles);
    // Full raw Generation bodies differ at promotion; the recorded earlier fingerprint does not.
    const first = receipts[1].cards[0].decision_evidence!;
    const input = first.inputs.find((ref) => ref.id === w.plan.candidate)!;
    assert.notEqual(decisionSnapshotDigest((await readCompleteLoopItem(w.client, input.id)).item), input.digest);
    return { cycles, executions, replays, receipts: receipts.length, card_variants: receipts.reduce((n, row) => n + row.cards.length, 0), snapshot_checks: snapshotChecks, corrupt_card_checks: corruptions, legacy_receipt: true, non_git: true };
  } finally { rmSync(w.root, { recursive: true, force: true }); }
}
