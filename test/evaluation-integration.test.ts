/** Decision tracing must preserve controller verdicts, bounded cards and native SDK history. */
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { PmClient } from "@unbrained/pm-cli/sdk/core";
import { init, createPmCliExpectedError, isPmCliExpectedError } from "@unbrained/pm-cli/sdk/runtime";
import { captureDecisionInputs, readCompleteLoopItem, withRlController, hashJson, generationProvenance, reconcileLoopPromotion, withProcessJobFence, verifyCompletedDecisionReceipt, completedDecisionReceipt, sealDecisionEvidence, promoteGenerationCore, promotedGenerationIdsUnderApproval, readApprovalSpec, withPromotionEvidence, mutateLoopItem, type JsonValue } from "../index.ts";
import { exportPolicyCard, replayPolicyCard, parsePolicyCardDecisionEvidence, POLICY_CARD_MAX_BYTES, type PolicyCard } from "../policy-card.ts";
import type { GenerationSpec } from "../lineage.ts";
import { decisionFixture } from "./fixtures/decision-evidence.ts";

/** Isolate every regression in a real tracker outside git. */
async function workspace() {
  const root = mkdtempSync(join(tmpdir(), "rl-evaluation-integration-"));
  const initialized = await init("rl", { defaults: true, author: "integration-test", agentGuidance: "skip" }, { cwd: root, pmRoot: join(root, ".agents/pm") });
  const client = new PmClient({ pmRoot: initialized.path, cwd: root, author: "integration-test", noExtensions: true });
  await client.create({ id: "rl-input", type: "Decision", title: "Input", body: "source" });
  await client.create({ id: "rl-bookkeeping", type: "Decision", title: "Controller state", body: "coordination" });
  return { root, client, pmRoot: initialized.path };
}

test("nested decision annotations preserve exception identity and terminal versus retryable verdicts", async () => {
  const w = await workspace();
  try {
    for (const code of ["budget_exceeded", "budget_undecidable", "loop_write_conflict", "provenance_read_retryable"]) {
      const original = createPmCliExpectedError("Decision verdict", { exitCode: 4, context: { code, required: "Retry or extend the governing approval." } });
      const context = original.context;
      await assert.rejects(captureDecisionInputs(w.client, () => captureDecisionInputs(w.client, async () => {
        await readCompleteLoopItem(w.client, "rl-input"); throw original;
      }), true), (error: unknown) => error === original && original.context === context && original.context.code === code && original.context.item_id === "rl-input");
    }
    const get = w.client.get.bind(w.client);
    const backend = createPmCliExpectedError("Certified read failure", { exitCode: 4, context: { code: "history_drift" } });
    w.client.get = (async (...args) => { await get(...args); throw backend; }) as PmClient["get"];
    await assert.rejects(captureDecisionInputs(w.client, () => readCompleteLoopItem(w.client, "rl-input")), (error: unknown) => error === backend && backend.context.item_id === "rl-input");
  } finally { rmSync(w.root, { recursive: true, force: true }); }
});

test("nested controllers inherit actual evaluator inputs without inheriting controller bookkeeping", async () => {
  const w = await workspace();
  try {
    for (let depth = 1; depth <= 3; depth += 1) {
      const traces: string[][] = [];
      /** Each nested controller reads coordination state; only the leaf evaluator certifies an input. */
      async function controller(remaining: number): Promise<void> {
        const captured = await captureDecisionInputs(w.client, async () => {
          await readCompleteLoopItem(w.client, "rl-bookkeeping");
          if (remaining > 0) await controller(remaining - 1);
          else await captureDecisionInputs(w.client, () => readCompleteLoopItem(w.client, "rl-input"));
        }, true);
        traces.push(captured.inputs.map((item) => item.id));
      }
      await controller(depth);
      assert.equal(traces.length, depth + 1);
      for (const trace of traces) assert.deepEqual(trace, ["rl-input"]);
    }
  } finally { rmSync(w.root, { recursive: true, force: true }); }
});

test("decision tracing retains deleted historical inputs while current storage failures remain retryable", async () => {
  const w = await workspace();
  try {
    await w.client.delete("rl-input", { force: true });
    const historical = await captureDecisionInputs(w.client, () => readCompleteLoopItem(w.client, "rl-input", "1"));
    assert.equal(historical.value.item.body, "source");
    assert.deepEqual(historical.inputs.map((item) => item.id), ["rl-input"]);
    await assert.rejects(w.client.get("rl-input"), (error: unknown) => isPmCliExpectedError(error) && error.exitCode === 3);
    const get = w.client.get.bind(w.client);
    w.client.get = (async (...args) => {
      try { return await get(...args); }
      catch (error) {
        if (args[1]?.at === undefined && isPmCliExpectedError(error) && error.exitCode === 3) throw Object.assign(new Error("Current read unavailable"), { code: "EIO" });
        throw error;
      }
    }) as PmClient["get"];
    await assert.rejects(captureDecisionInputs(w.client, () => readCompleteLoopItem(w.client, "rl-input", "1")), (error: unknown) => isPmCliExpectedError(error) && error.context.code === "provenance_read_retryable");
  } finally { rmSync(w.root, { recursive: true, force: true }); }
});

test("one-document receipt parsing refuses NDJSON and malformed current receipts with the record named", async () => {
  const w = await workspace();
  try {
    await w.client.create({ id: "rl-approval", type: "Decision", title: "Approval", body: '```json\n{"permitted_promotions":1}\n```' });
    await withRlController(w.client, { pmRoot: w.pmRoot, author: "integration-test" }, { id: "typed", approval: "rl-approval", recoveryCommand: "pm rl meta resume typed" }, new AbortController().signal, (step) => step("read", {}, async () => {
      await captureDecisionInputs(w.client, () => readCompleteLoopItem(w.client, "rl-input")); return { samples: 1 };
    }));
    const id = "rl-typed-step-read";
    const original = String((await readCompleteLoopItem(w.client, id)).item.body);
    const card = await exportPolicyCard(w.client, id);
    for (const body of [original + '\n{"foreign":true}', original + "\ncorrupt", '{"format":"pm-rl/loop-step/1"', "[]"]) {
      await w.client.update(id, { body });
      try {
        const named = (error: unknown) => isPmCliExpectedError(error) && error.exitCode === 4 && error.context.item_id === id;
        await assert.rejects(exportPolicyCard(w.client, id), named);
        await assert.rejects(replayPolicyCard(w.client, card), named);
      } finally { await w.client.update(id, { body: original }); }
      assert.equal((await readCompleteLoopItem(w.client, id)).item.body, original);
    }
    assert.deepEqual((await replayPolicyCard(w.client, card)).card, card);
  } finally { rmSync(w.root, { recursive: true, force: true }); }
});

test("compact manifest references preserve every citation, snapshot and selection within the unchanged card bound", async () => {
  const w = await workspace();
  try {
    const ids: string[] = [];
    for (let index = 0; index < 7; index += 1) {
      const created = await w.client.create({ id: `rl-source-${index}-${"a".repeat(170)}`, type: "Decision", title: "Source", body: `value-${index}` });
      ids.push(created.item.id);
    }
    await w.client.create({ id: "rl-approval", type: "Decision", title: "Approval", body: '```json\n{"permitted_promotions":1}\n```' });
    await withRlController(w.client, { pmRoot: w.pmRoot, author: "integration-test" }, { id: "compact", approval: "rl-approval", recoveryCommand: "pm rl meta resume compact" }, new AbortController().signal, (step) => step("read", {}, async () => {
      await captureDecisionInputs(w.client, async () => { for (const id of ids) await readCompleteLoopItem(w.client, id); });
      return { samples: 1, configs: [{ samples: 1 }, { samples: 2 }] };
    }));
    const subject = "rl-compact-step-read";
    const receipt = JSON.parse(String((await readCompleteLoopItem(w.client, subject)).item.body)) as { decision_evidence: { digest: string } };
    for (const selection of [null, 0, 1]) {
      const card = await exportPolicyCard(w.client, subject, selection);
      assert.ok(card.decision_evidence);
      assert.equal(card.decision_evidence?.format, "pm-rl/evaluation-evidence-ref/1");
      assert.equal(card.decision_evidence.digest, receipt.decision_evidence.digest);
      assert.deepEqual(card.evidence.slice(1).map((row) => row.id).sort(), ids.slice().sort());
      assert.ok(Buffer.byteLength(JSON.stringify(card)) <= POLICY_CARD_MAX_BYTES);
      assert.deepEqual((await replayPolicyCard(w.client, card)).card, card);
      /** A forged projection cannot turn an incomplete citation list into a smaller valid card. */
      function rehash(value: PolicyCard): PolicyCard { const { digest: _digest, ...body } = value; return { ...body, digest: hashJson(body as unknown as JsonValue) }; }
      await assert.rejects(replayPolicyCard(w.client, rehash({ ...card, evidence: card.evidence.slice(0, -1) })), isPmCliExpectedError);
      await assert.rejects(replayPolicyCard(w.client, rehash({ ...card, decision_evidence: { ...card.decision_evidence, digest: "0".repeat(64) } })), isPmCliExpectedError);
      await assert.rejects(replayPolicyCard(w.client, { ...card, decision_evidence: { ...card.decision_evidence, extra: true } }), isPmCliExpectedError);
      await w.client.update(ids[0], { body: "Later source state" });
      assert.deepEqual((await replayPolicyCard(w.client, card)).card, card);
    }
  } finally { rmSync(w.root, { recursive: true, force: true }); }
});

test("committed promotion recovery refuses each missing scored field before any close or publication", async () => {
  const w = await workspace();
  try {
    await w.client.schemaAddType("Generation", { folder: "generations", defaultStatus: "open" });
    const score = { objective: "reward", objective_version: "v1", evaluation_context: "held-out", direction: "maximize" as const, seed_set: "frozen", scale: 1, value: 1 };
    const complete: GenerationSpec = { base_checkpoint: "checkpoint", policy: "policy", collection_runs: ["rl-run"], training_config: {}, environment_version: "training", reward_spec_version: "v1", parent: "rl-seed", seed: false, promoted: true, approval: "rl-approval", proxy_score: score, held_out_score: score, gap: 0, promotion_evidence: "Committed outcome" };
    for (const field of ["approval", "proxy_score", "held_out_score", "gap", "promotion_evidence"] as const) {
      const value = { ...complete, [field]: null };
      const created = await w.client.create({ id: `rl-missing-${field.replaceAll("_", "-")}`, type: "Generation", title: "Incomplete promotion", body: `\`\`\`json\n${JSON.stringify(value)}\n\`\`\``, affectedVersion: hashJson(generationProvenance(value)) });
      const id = created.item.id; const before = await readCompleteLoopItem(w.client, id);
      await assert.rejects(reconcileLoopPromotion(w.client, { author: "integration-test", guard: (operation) => withProcessJobFence({ pmRoot: w.pmRoot, author: "integration-test" }, "recovery-proof", operation) }, id), (error: unknown) => isPmCliExpectedError(error) && error.context.code === "promoted_missing_evidence");
      assert.deepEqual((await readCompleteLoopItem(w.client, id)).item, before.item);
    }
  } finally { rmSync(w.root, { recursive: true, force: true }); }
});

test("compact manifest schema has 500 seeded must-allow and must-refuse transports", () => {
  let seed = 0x10728;
  for (let index = 0; index < 500; index += 1) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const value = { format: "pm-rl/evaluation-evidence-ref/1" as const, comparison: hashJson(index), digest: hashJson(seed) };
    assert.deepEqual(parsePolicyCardDecisionEvidence(JSON.parse(JSON.stringify(value, null, index % 2 ? 2 : 0).replaceAll("\n", "\r\n"))), value);
    const invalid = [null, [], { ...value, comparison: null }, { ...value, comparison: "bad" }, { ...value, digest: Infinity }, { ...value, digest: "0".repeat(65) }, { ...value, extra: [] }, { format: value.format, comparison: value.comparison }, { ...value, digest: "x".repeat(1_048_576) }];
    assert.throws(() => parsePolicyCardDecisionEvidence(invalid[index < invalid.length ? index : seed % invalid.length]), isPmCliExpectedError);
  }
});

test("malformed historical completions cannot seal a step while the first valid execution remains immutable", async () => {
  const w = await workspace();
  try {
    const id = "rl-historical-step";
    const running = { format: "pm-rl/loop-step/1", key: id, input: hashJson({}), state: "running" };
    await w.client.create({ id, type: "Decision", title: "Historical execution", body: JSON.stringify(running) });
    const result = { samples: 1 };
    const graph = await sealDecisionEvidence(w.client, running.input, [(await readCompleteLoopItem(w.client, "rl-input")).item]);
    const complete = { ...running, state: "complete", result, digest: hashJson(result), decision_evidence: graph };
    assert.equal(completedDecisionReceipt(complete), true);
    for (const body of [{ ...complete, format: "foreign" }, { ...complete, state: "foreign" }, { ...complete, input: 17 }]) assert.equal(completedDecisionReceipt(body), false);
    const invalid = [
      ...[undefined, null, 17, []].map((result) => ({ ...complete, result })),
      { ...complete, digest: "foreign-checksum" }, { ...complete, input: "foreign-input" },
      { ...complete, decision_evidence: { format: "foreign" } },
    ];
    for (const body of invalid) {
      assert.equal(completedDecisionReceipt(body), false);
      await w.client.update(id, { body: JSON.stringify(body) });
      assert.deepEqual(JSON.parse(String((await readCompleteLoopItem(w.client, id)).item.body)), JSON.parse(JSON.stringify(body)));
      await verifyCompletedDecisionReceipt(w.client, id, running, true);
    }
    await w.client.update(id, { body: JSON.stringify(complete) });
    await verifyCompletedDecisionReceipt(w.client, id, complete);
    await w.client.update(id, { body: JSON.stringify(running) });
    await assert.rejects(verifyCompletedDecisionReceipt(w.client, id, running, true), (error: unknown) => isPmCliExpectedError(error) && error.context.code === "loop_step_drift" && error.context.item_id === id);
  } finally { rmSync(w.root, { recursive: true, force: true }); }
});

test("locked promotion precedence matrix honours current capacity before changed evaluation evidence", async (t) => {
  const base = await decisionFixture(false, false);
  try {
    await base.client.update("rl-approval", { body: '```json\n{"permitted_promotions":1}\n```' });
    for (const budget of ["unchanged", "lowered", "raised"] as const) for (const evidenceChanged of [false, true]) await t.test(`${budget}; evidence ${evidenceChanged ? "changed" : "unchanged"}`, async () => {
      const root = mkdtempSync(join(tmpdir(), "rl-locked-precedence-"));
      try {
        cpSync(base.root, root, { recursive: true });
        const pmRoot = join(root, ".agents/pm");
        const client = new PmClient({ cwd: root, pmRoot, author: "integration-test", noExtensions: true });
        const peer = new PmClient({ cwd: root, pmRoot, author: "peer", noExtensions: true });
        const candidate = base.plan.candidate; const checkpoint = `${candidate}-evaluation-plan-look-2`;
        const before = (await readCompleteLoopItem(client, candidate)).item;
        const capacity = budget === "lowered" ? 0 : budget === "raised" ? 2 : 1;
        let injected = 0;
        const result = promoteGenerationCore(client, { pmRoot, author: "integration-test" }, candidate, "rl-approval", { ...base.score, evaluation_context: "proxy" }, base.score, "Locked precedence", async (event) => {
          if (event.transition !== "prepared") return;
          injected += 1;
          // The SDK invokes prepared while its workspace writer lease is held.
          if (budget !== "unchanged") await peer.update("rl-approval", { body: `\`\`\`json\n${JSON.stringify({ permitted_promotions: capacity })}\n\`\`\`` });
          if (evidenceChanged) await peer.update(checkpoint, { affectedVersion: hashJson("Changed sealed evidence") });
          assert.equal((await readApprovalSpec(peer, "rl-approval")).permitted_promotions, capacity);
        });
        const refusal = budget === "lowered" ? "budget_exceeded" : evidenceChanged ? "eval_plan_drift" : null;
        if (refusal === null) {
          const outcome = await result;
          assert.equal(outcome.permittedPromotions, capacity); assert.equal(outcome.promotedCount, 0);
          assert.deepEqual(await promotedGenerationIdsUnderApproval(peer, "rl-approval"), [candidate]);
        } else {
          await assert.rejects(result, (error: unknown) => {
            assert.ok(isPmCliExpectedError(error)); assert.equal(error.exitCode, 4); assert.equal(error.context.code, refusal);
            if (refusal === "budget_exceeded") assert.match(error.message, /Advancing past the approved promotion budget is refused.*permits 0/);
            else assert.equal(error.context.item_id, checkpoint);
            return true;
          });
          assert.deepEqual((await readCompleteLoopItem(peer, candidate)).item, before);
          assert.deepEqual(await promotedGenerationIdsUnderApproval(peer, "rl-approval"), []);
        }
        assert.equal(injected, 1);
        // Both outcomes release every native dependency lease.
        await peer.update(checkpoint, { title: "Lease released" });
        await peer.update("rl-approval", { title: "Authorization lease released" });
      } finally { rmSync(root, { recursive: true, force: true }); }
    });
  } finally { rmSync(base.root, { recursive: true, force: true }); }
});

test("approval capacity refresh before the writer lock never becomes statistical evidence drift", async (t) => {
  const base = await decisionFixture(false, false);
  try {
    for (const [initial, capacity] of [[1, 0], [0, 1]]) await t.test(`${initial} to ${capacity}`, async () => {
      const root = mkdtempSync(join(tmpdir(), "rl-approval-refresh-"));
      try {
        cpSync(base.root, root, { recursive: true }); const pmRoot = join(root, ".agents/pm");
        const client = new PmClient({ cwd: root, pmRoot, author: "integration-test", noExtensions: true });
        const peer = new PmClient({ cwd: root, pmRoot, author: "peer", noExtensions: true });
        await peer.update("rl-approval", { body: `\`\`\`json\n${JSON.stringify({ permitted_promotions: initial })}\n\`\`\`` });
        const get = client.get.bind(client); let injected = false;
        client.get = (async (...args) => {
          const result = await get(...args);
          if (!injected && args[0] === "rl-approval") { injected = true; await peer.update("rl-approval", { body: `\`\`\`json\n${JSON.stringify({ permitted_promotions: capacity })}\n\`\`\`` }); }
          return result;
        }) as PmClient["get"];
        const operation = promoteGenerationCore(client, { pmRoot, author: "integration-test" }, base.plan.candidate, "rl-approval", { ...base.score, evaluation_context: "proxy" }, base.score, "Current approval");
        if (capacity === 0) await assert.rejects(operation, (error: unknown) => isPmCliExpectedError(error) && error.context.code === "budget_exceeded");
        else { const result = await operation; assert.equal(result.permittedPromotions, 1); }
        assert.ok(injected); assert.equal((await promotedGenerationIdsUnderApproval(peer, "rl-approval")).length, capacity);
      } finally { rmSync(root, { recursive: true, force: true }); }
    });
  } finally { rmSync(base.root, { recursive: true, force: true }); }
});

test("authorization refresh retains native revision fences and statistical projections", async () => {
  const w = await workspace();
  try {
    const peer = new PmClient({ cwd: w.root, pmRoot: w.pmRoot, author: "peer", noExtensions: true });
    await peer.create({ id: "rl-approval", type: "Decision", title: "Authorization", body: '```json\n{"permitted_promotions":1}\n```' });
    const before = await readCompleteLoopItem(w.client, "rl-input");
    await withPromotionEvidence(w.client, async () => {
      await readApprovalSpec(w.client, "rl-approval");
      await peer.update("rl-approval", { body: '```json\n{"permitted_promotions":2}\n```' });
      assert.equal((await readApprovalSpec(w.client, "rl-approval")).permitted_promotions, 2);
      await mutateLoopItem(w.client, before, "Current authorization", (document) => { document.body = "Current capacity"; return ["body"]; });
    }, true);
    const current = await readCompleteLoopItem(w.client, "rl-input");
    await assert.rejects(withPromotionEvidence(w.client, async () => {
      await readApprovalSpec(w.client, "rl-approval");
      await peer.update("rl-approval", { body: '```json\n{"permitted_promotions":0}\n```' });
      return mutateLoopItem(w.client, current, "Stale authorization", (document) => { document.body = "Must not write"; return ["body"]; });
    }), (error: unknown) => isPmCliExpectedError(error) && error.context.code === "loop_write_conflict" && /authorization changed/.test(error.message));
    assert.deepEqual((await readCompleteLoopItem(peer, "rl-input")).item, current.item);
    await assert.rejects(withPromotionEvidence(w.client, async () => {
      await readCompleteLoopItem(w.client, "rl-approval");
      await peer.update("rl-approval", { body: '```json\n{"permitted_promotions":1}\n```' });
      await readApprovalSpec(w.client, "rl-approval");
      return readCompleteLoopItem(w.client, "rl-approval");
    }, true), (error: unknown) => isPmCliExpectedError(error) && error.context.code === "loop_write_conflict" && /evidence changed/.test(error.message));
  } finally { rmSync(w.root, { recursive: true, force: true }); }
});
