/** The same adversarial declarations exercise source and packed Node/Bun consumers. */
import assert from "node:assert/strict";
import { join } from "node:path";
import { PmClient } from "@unbrained/pm-cli/sdk/core";
import { EXIT_CODE, init, isPmCliExpectedError } from "@unbrained/pm-cli/sdk/runtime";
import { parseTransferDesign, transferPower, recordTransferPlan, readTransferPlan, parseProposerEvolutionConfig, proposerEvolutionConfiguration, runProposerEvolution, ProposerRefusal, TRANSFER_DESIGN, type TransferDesign } from "../../index.ts";

/** Include every declaration guard and numeric boundary without relying on private operator content. */
export function malformedTransferDesigns(): readonly unknown[] {
  const valid = { ...TRANSFER_DESIGN, looks: 2 };
  return [null, [], true, 1, {}, { ...valid, extra: "PAYLOAD_SENTINEL" }, ...["effect", "margin", "alpha", "power", "looks", "targets"].map((field) => { const copy: Record<string, unknown> = { ...valid }; delete copy[field]; return copy; }),
    ...[NaN, Infinity, -Infinity, 0, -1, "PAYLOAD_SENTINEL"].flatMap((value) => ["effect", "alpha", "power", "looks"].map((field) => ({ ...valid, [field]: value }))),
    { ...valid, effect: 0.01 }, { ...valid, margin: 0 }, { ...valid, effect: 1.01 }, { ...valid, alpha: 0.051 }, { ...valid, power: 0.79 }, { ...valid, power: 1 }, { ...valid, looks: 65 }, { ...valid, looks: 1.5 },
    ...[null, [], ["wrong", "time-to-close"], [...valid.targets].reverse()].map((targets) => ({ ...valid, targets }))];
}
/** Operator corrections retain stable codes and never prescribe native-record recovery or echo payloads. */
export function correction(error: unknown, code: string): boolean {
  assert.ok(isPmCliExpectedError(error)); assert.equal(error.exitCode, EXIT_CODE.USAGE); assert.equal(error.context.code, code);
  assert.match(error.message, new RegExp(code)); assert.match(error.message, /Correct/);
  assert.doesNotMatch(error.message, /Restore|Malformed sealed|fresh evaluation identity|PAYLOAD_SENTINEL|undefined/);
  return true;
}
/** Execute the public packed SDK in a real non-Git tracker; print counts only. */
export async function runTransferRefusalConsumer(): Promise<void> {
  const cwd = process.cwd(); const { path: pmRoot } = await init("consumer", { defaults: true, agentGuidance: "skip", author: "refusal-test" }, { cwd, pmRoot: join(cwd, ".agents/pm") });
  const client = new PmClient({ cwd, pmRoot, noExtensions: true, author: "refusal-test" }); let checks = 0;
  for (const value of malformedTransferDesigns()) {
    assert.throws(() => parseTransferDesign(value), (error) => correction(error, "transfer_design")); checks++;
    assert.throws(() => transferPower(0, value as TransferDesign), (error) => correction(error, "transfer_design")); checks++;
    await assert.rejects(recordTransferPlan(client, "a".repeat(64), value as TransferDesign), (error) => correction(error, "transfer_design")); checks++;
  }
  const config = proposerEvolutionConfiguration();
  const before = (await client.listAllComplete({ includeBody: true })).items;
  for (const value of [{ ...config, transfer: { effect: 0.1, alpha: 0.05, power: 0.8 } }, { ...config, generations: 1, transfer: { effect: 0.08, alpha: 0.05, power: 0.8 } }]) {
    assert.deepEqual(parseProposerEvolutionConfig(value), value);
    await assert.rejects(runProposerEvolution(client, { pmRoot, author: "refusal-test" }, { id: "capacity", config: value, dataset: process.argv[2], approval: "unopened" }), (error) => {
      assert.ok(isPmCliExpectedError(error)); assert.equal(error.context.code, "transfer_underpowered");
      assert.match(error.message, /independent trackers.*meta tasks.*audit tasks.*10000 tasks/); return true;
    });
  }
  assert.deepEqual((await client.listAllComplete({ includeBody: true })).items, before);
  assert.throws(() => parseProposerEvolutionConfig({ ...config, transfer: { ...config.transfer, alpha: 1 } }), (error) => {
    assert.ok(error instanceof ProposerRefusal); assert.match(error.message, /transfer_design.*Correct.*effect.*alpha.*looks/); assert.match(error.remedy, /transfer_design.*Correct/); return true;
  }); checks++;
  assert.equal((await client.listAllComplete({ includeBody: true })).items.length, 0);
  const design = { ...TRANSFER_DESIGN, looks: 2 }; assert.deepEqual(parseTransferDesign(design), design);
  const plan = await recordTransferPlan(client, "a".repeat(64), design); assert.deepEqual((await readTransferPlan(client, plan)).design, design); checks++;
  console.log(JSON.stringify({ sdk_refusal_checks: checks, capacity_refusal_checks: 2, non_git: true, valid_plan_replayed: true }));
}
