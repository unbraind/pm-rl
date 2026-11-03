/** Immutable execution properties shared by native and packed Node/Bun consumers. */
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PmClient } from "@unbrained/pm-cli/sdk/core";
import { concurrentCases } from "./concurrent-cases.ts";
import { isPmCliExpectedError } from "@unbrained/pm-cli/sdk/runtime";
import { captureDecisionInputs, extractGenerationSpec, DECISION_INPUT_FIELDS, firstDecisionSnapshot, hashJson, generationProvenance, readCompleteLoopItem, withRlController, promoteGenerationCore, verifyDecisionEvidence, verifyDecisionSnapshots, type JsonValue } from "../../index.ts";
import { evaluationInputDigest, evaluationEvidence, decisionSnapshotDigest, readEvaluationDecision, parseEvaluationEvidence, registerEvaluationPlan, evaluationComparison, type EvaluationPlan } from "../../evaluation-plan.ts";
import { exportPolicyCard, replayPolicyCard, type PolicyCard } from "../../policy-card.ts";
import { recordSequentialEvaluation } from "../../sequential-evaluation.ts";
import { decisionFixture } from "./decision-evidence.ts";
import type { EvaluationEvidence, GenerationSpec } from "../../lineage.ts";

/** Generate successive valid promotions and replays; default all runs every corruption pair, while none isolates the chain regression. */
export async function durableSnapshotProperty(cycles = 3, corruption: "all" | "none" = "all") {
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
      const graph = parseEvaluationEvidence(JSON.parse(String((await readCompleteLoopItem(w.client, id)).item.body)).decision_evidence);
      assert.equal(graph.format, "pm-rl/evaluation-evidence/2");
      // Successive incumbents enlarge the graph; the card may use its documented compact hash reference.
      assert.equal(cards[0].decision_evidence?.digest, graph.digest);
      assert.equal(cards[0].decision_evidence?.comparison, graph.comparison);
      await assert.rejects(verifyDecisionEvidence(w.client, graph), (error: unknown) => isPmCliExpectedError(error) && error.context.code === "eval_plan_evidence");
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
      const incumbent = plan.candidate; const version = String((await readCompleteLoopItem(w.client, incumbent)).item.affected_version);
      const candidate = `rl-candidate-${cycle + 1}`; const review = `rl-review-${cycle + 1}`; const run = `rl-collection-${cycle + 1}`;
      assert.equal(plan.stopping.kind, "sequential");
      plan = { ...plan, candidate, incumbent, incumbent_version: version, stopping: { ...w.plan.stopping, review } } as EvaluationPlan;
      await w.client.create({ id: review, type: "Decision", title: "Review", body: JSON.stringify({ format: "pm-rl/sequential-review/1", comparison: evaluationComparison(plan) }) });
      await registerEvaluationPlan(w.client, plan);
      await w.client.create({ id: run, type: "Run", title: "Collection", environment: "rl-training" });
      const source = extractGenerationSpec(String(w.native.item.body), "Next candidate source");
      const spec: GenerationSpec = { ...source, parent: incumbent, collection_runs: [run], base_checkpoint: `sha256:${hashJson(candidate)}`, evaluation_plan: evaluationComparison(plan) };
      await w.client.create({ id: candidate, type: "Generation", title: "Next candidate", body: `\`\`\`json\n${JSON.stringify(spec)}\n\`\`\``, affectedVersion: hashJson(generationProvenance(spec)) });
      assert.equal(spec.parent, (receipts[receipts.length - 1].input as { candidate: string }).candidate);
      assert.equal(plan.incumbent, spec.parent);
      await recordSequentialEvaluation(w.client, candidate, w.rows.slice(0, 16));
      await recordSequentialEvaluation(w.client, candidate, w.rows);
    }
    // Every immutable input, including pairs, remains integrity checked independently of live state.
    for (const receipt of corruption === "all" ? receipts : []) {
      const original = String((await readCompleteLoopItem(w.client, receipt.id)).item.body);
      const body = JSON.parse(original) as { decision_evidence: EvaluationEvidence };
      const refs = body.decision_evidence.inputs;
      const pairs = refs.flatMap((_ref, i) => refs.slice(i).map((_next, offset) => [i, i + offset] as const));
      // The prepared tracker is immutable throughout the sweep. A private native
      // clone per pair keeps every original pair while preventing append-only
      // corruption/repair events from making later history reads quadratic.
      await concurrentCases(pairs, async ([i, j]) => {
        const root = mkdtempSync(join(tmpdir(), "rl-snapshot-corruption-"));
        try {
          cpSync(w.root, root, { recursive: true });
          const client = new PmClient({ cwd: root, pmRoot: join(root, ".agents/pm"), author: "decision-test", noExtensions: true });
          const damaged = [...new Set([i, j])];
          const inputs = refs.map((ref, index) => damaged.includes(index) ? { ...ref, digest: "0".repeat(64) } : ref);
          const graphBody = { format: body.decision_evidence.format, comparison: body.decision_evidence.comparison, inputs };
          const graph = { ...graphBody, digest: hashJson(graphBody as unknown as JsonValue) };
          const expected = `${refs[i].id}@${refs[i].at}`;
          const named = (error: unknown) => isPmCliExpectedError(error) && error.message.includes(expected);
          await assert.rejects(verifyDecisionSnapshots(client, graph), named); snapshotChecks += 1;
          const corrupted = JSON.stringify({ ...body, decision_evidence: graph });
          await client.update(receipt.id, { body: corrupted });
          await assert.rejects(withRlController(client, { ...coordinates, pmRoot: join(root, ".agents/pm") }, request, new AbortController().signal, (step) => step(receipt.key, receipt.input, async () => assert.fail("Corrupted step reran"))), named);
          for (const card of receipt.cards) {
            await assert.rejects(exportPolicyCard(client, receipt.id, card.selection), named);
            await assert.rejects(replayPolicyCard(client, card), named); corruptions += 2;
          }
          assert.equal((await readCompleteLoopItem(client, receipt.id)).item.body, corrupted, "refusals must preserve the competing native revision");
        } finally { rmSync(root, { recursive: true, force: true }); }
      });
      assert.equal((await readCompleteLoopItem(w.client, receipt.id)).item.body, original);
      await verifyDecisionSnapshots(w.client, body.decision_evidence);
      console.log(JSON.stringify({ snapshot_receipt: receipt.key, corruption_checks: corruptions }));
    }
    assert.equal(executions, cycles);
    // Full raw Generation bodies differ at promotion; the recorded earlier fingerprint does not.
    const first = parseEvaluationEvidence(receipts[1].cards[0].decision_evidence);
    const input = first.inputs.find((ref) => ref.id === w.plan.candidate)!;
    assert.notEqual(decisionSnapshotDigest((await readCompleteLoopItem(w.client, input.id)).item), input.digest);
    return { cycles, executions, replays, receipts: receipts.length, card_variants: receipts.reduce((n, row) => n + row.cards.length, 0), snapshot_checks: snapshotChecks, corrupt_card_checks: corruptions, legacy_receipt: true, non_git: true };
  } finally { rmSync(w.root, { recursive: true, force: true }); }
}
