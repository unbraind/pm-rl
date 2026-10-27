/** Frozen execution receipts survive later promotions while every recorded snapshot remains sealed. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PmClient } from "@unbrained/pm-cli/sdk/core";
import { init, isPmCliExpectedError } from "@unbrained/pm-cli/sdk/runtime";
import { hashJson, readCompleteLoopItem, sealDecisionEvidence, verifyDecisionEvidence, verifyDecisionSnapshots, verifyCompletedDecisionReceipt, type JsonValue } from "../index.ts";
import { parseEvaluationEvidence } from "../evaluation-plan.ts";
import { durableSnapshotProperty } from "./fixtures/durable-snapshots.ts";

test("immutable snapshots survive repeated evaluate/promote cycles and reject every snapshot corruption pair", async () => {
  console.log(JSON.stringify(await durableSnapshotProperty()));
});

test("snapshot corruption refuses by immutable locator while later source changes remain allowed", async () => {
  const root = mkdtempSync(join(tmpdir(), "rl-frozen-input-"));
  try {
    const initialized = await init("rl", { defaults: true, author: "snapshot-test", agentGuidance: "skip" }, { cwd: root, pmRoot: join(root, ".agents/pm") });
    const client = new PmClient({ cwd: root, pmRoot: initialized.path, author: "snapshot-test", noExtensions: true });
    await client.create({ id: "rl-input", type: "Decision", title: "Input", body: "original" });
    const source = (await readCompleteLoopItem(client, "rl-input")).item;
    const graph = await sealDecisionEvidence(client, hashJson("step"), [source]);
    await verifyDecisionSnapshots(client, graph);
    await client.update("rl-input", { body: "later valid state" });
    await verifyDecisionSnapshots(client, graph);
    await assert.rejects(verifyDecisionEvidence(client, graph), isPmCliExpectedError);
    const ref = graph.inputs[0];
    const { digest: _digest, ...body } = graph;
    const corrupt = { ...body, inputs: [{ ...ref, digest: "0".repeat(64) }] };
    await assert.rejects(verifyDecisionSnapshots(client, parseEvaluationEvidence({ ...corrupt, digest: hashJson(corrupt as unknown as JsonValue) })), (error: unknown) => isPmCliExpectedError(error) && error.message.includes(`${ref.id}@${ref.at}`));
    for (const input of [{ id: ref.id, digest: ref.digest }, { ...ref, at: "9007199254740991" }, { ...ref, id: "rl-missing" }, { ...ref, id: "INPUT" }]) {
      await assert.rejects(verifyDecisionSnapshots(client, { ...graph, format: "pm-rl/evaluation-evidence/1", inputs: [input] }), (error: unknown) => isPmCliExpectedError(error) && error.message.includes(input.id));
    }
    const receipt = { format: "pm-rl/loop-step/1", key: "legacy-step", state: "complete", input: graph.comparison, result: { samples: 1 }, digest: hashJson({ samples: 1 }) };
    await client.create({ id: "rl-legacy-step", type: "Decision", title: "Pre-graph receipt", body: JSON.stringify(receipt) });
    const graft = { ...receipt, decision_evidence: graph };
    await client.update("rl-legacy-step", { body: JSON.stringify(graft) });
    await assert.rejects(verifyCompletedDecisionReceipt(client, "rl-legacy-step", graft), (error: unknown) => isPmCliExpectedError(error) && error.context.item_id === "rl-legacy-step");
    await client.update("rl-legacy-step", { body: JSON.stringify(receipt) });
    assert.deepEqual(JSON.parse(String((await readCompleteLoopItem(client, "rl-legacy-step")).item.body)), receipt);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
