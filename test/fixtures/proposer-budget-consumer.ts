/** Exercise executed-work accounting through real non-git source and packed SDK consumers. */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { PmClient } from "@unbrained/pm-cli/sdk/core";
import { init, isPmCliExpectedError } from "@unbrained/pm-cli/sdk/runtime";
import { hashJson } from "../../json-identity.ts";
import { runProposerEvolution, proposerEvolutionConfiguration } from "../../index.ts";
import { proposerProcessInput, PROPOSER_ALLOWANCE } from "../../proposer-evolution.ts";
import { loadTransferCorpus, transferMembers } from "../../proposer-transfer.ts";
import { IMPROVER_ADAPTER, IMPROVER_MAX_ATTEMPTS } from "../../improver-environment.ts";
import { RESOURCE_KEYS, reserveProcessJob, type Resources } from "../../process.ts";

/** Exact logical and process limits expose both over-reservation and credit for unexecuted meta slots. */
export async function checkProposerBudgets(root: string, dataset: string): Promise<number> {
  assert.equal(existsSync(join(root, ".git")), false);
  const { path: pmRoot } = await init("budget", { defaults: true, agentGuidance: "skip", author: "budget-test" }, { cwd: root, pmRoot: join(root, ".agents/pm") });
  const client = new PmClient({ pmRoot, cwd: root, author: "budget-test", noExtensions: true });
  const coordinates = { pmRoot, author: "budget-test" }; const corpus = loadTransferCorpus(dataset);
  let checks = 0;
  for (const generations of [1, 2, 3, 4]) for (const candidates of [1, 3]) {
    const config = { ...proposerEvolutionConfiguration(), generations, candidates, updates: 2, transfer: { effect: 0.5, alpha: 0.05, power: 0.8 } };
    const looks = Array.from({ length: generations }, (_, index) => transferMembers(corpus, "meta", generations + 1, index + 1));
    assert.ok(looks.every((look) => look.length > 0));
    assert.deepEqual(looks.flat().map((task) => task.id).sort(), corpus.tasks.meta.map((task) => task.id).sort());
    // Independent oracle: a complete, disjoint partition executes every meta task exactly once.
    const fits = candidates * (generations * corpus.tasks.development.length + 2 * corpus.tasks.meta.length + 2 * corpus.tasks.audit.length);
    const calls = generations * 3 + 2;
    const resource_budget = Object.fromEntries(RESOURCE_KEYS.map((key) => [key, fits * IMPROVER_MAX_ATTEMPTS * IMPROVER_ADAPTER.allowance[key] + calls * PROPOSER_ALLOWANCE[key]])) as unknown as Resources;
    const spec = { permitted_promotions: fits + generations, meta_budget: { training_samples: fits * config.updates * IMPROVER_MAX_ATTEMPTS, proposal_calls: calls, recipe_promotions: generations }, resource_budget };
    const approval = (await client.create({ id: `approval-${generations}-${candidates}`, type: "Decision", title: "Exact executed-work approval", body: "```json\n" + JSON.stringify(spec) + "\n```" })).item.id;
    const id = `budget-${generations}-${candidates}`;
    const request = { id, approval, dataset, config, onStep() { throw new Error("executed-budget-preflight-passed"); } };
    await assert.rejects(runProposerEvolution(client, coordinates, request), /executed-budget-preflight-passed/);
    const reservation = await client.get(`${id}-reservation`);
    const record = JSON.parse(String(reservation.item.body));
    assert.deepEqual(record.charge, spec.meta_budget);
    assert.equal(record.promotion_headroom, fits + generations);
    await assert.rejects(runProposerEvolution(client, coordinates, request), /executed-budget-preflight-passed/);
    if (generations > 1) {
      // A job whose task belongs to a different look is additional work, even with an otherwise exact slot binding.
      const selected = new Set(looks[0].map((task) => task.id));
      const index = corpus.tasks.meta.findIndex((task) => !selected.has(task.id)); assert.ok(index >= 0);
      const programme = `${id}-j${hashJson(`g1-b-t${index}-c0`).slice(0, 12)}`;
      const base = proposerProcessInput("unused", { program: config.initial, counts: Array.from({ length: 8 }, (_, arm) => ({ arm, wins: 0, trials: 0 })), role: "development", seed: config.seed, count: candidates });
      const input = { ...base, identity: { proposal: { programme_id: programme, dataset: corpus.manifest.digest }, recovery_attempt: 0 } };
      await reserveProcessJob(client, coordinates, `process-${hashJson(id)}`, input, approval, IMPROVER_ADAPTER.allowance);
      const before = (await client.listAllComplete({ includeBody: true })).items;
      await assert.rejects(runProposerEvolution(client, coordinates, request), (error) => isPmCliExpectedError(error) && error.context.code === "process_budget_exhausted");
      assert.deepEqual((await client.listAllComplete({ includeBody: true })).items, before);
      // Historical whole-split reservations remain immutable and refuse before any effects; never silently rebind a plan.
      const legacyFits = fits + candidates * 2 * (generations - 1) * corpus.tasks.meta.length;
      await client.update(reservation.item.id, { body: JSON.stringify({ ...record, charge: { ...record.charge, training_samples: legacyFits * config.updates * IMPROVER_MAX_ATTEMPTS }, promotion_headroom: legacyFits + generations }) });
      const historical = (await client.listAllComplete({ includeBody: true })).items;
      await assert.rejects(runProposerEvolution(client, coordinates, request), (error) => isPmCliExpectedError(error) && error.context.code === "meta_reservation_drift");
      assert.deepEqual((await client.listAllComplete({ includeBody: true })).items, historical);
    }
    checks++;
  }
  return checks;
}
