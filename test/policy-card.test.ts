/** Portable explanation regressions exercise real SDK histories in plain-directory trackers. */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, symlinkSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { after, test } from "node:test";
import { PmClient, type CloseResult } from "@unbrained/pm-cli/sdk/core";
import { init, isPmCliExpectedError, createPmCliExpectedError, type CloseTaskResult, type PmClientCloseActionOptions } from "@unbrained/pm-cli/sdk/runtime";
import { createExtensionTestHarness } from "@unbrained/pm-cli/sdk/testing";
import extension, { generationProvenance, extractGenerationSpec, hashJson, canonicalJson, runRlLoop, resumeRlLoop, withRlController, type JsonValue, type RlCommandResult } from "../index.ts";
import { exportPolicyCard, replayPolicyCard, adoptPolicyCard, recordRecursivePolicyCards, recordPolicyCard, POLICY_CARD_MAX_BYTES, type PolicyCard } from "../policy-card.ts";
import type { GenerationSpec } from "../lineage.ts";

const roots: string[] = [];
after(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });
/** Initialize an actual tracker with generation and collection types. */
async function workspace() {
  const root = mkdtempSync(join(tmpdir(), "rl-cards-")); roots.push(root);
  const { path } = await init("rl", { defaults: true, agentGuidance: "skip", author: "card-test" }, { cwd: root });
  const client = new PmClient({ pmRoot: path, cwd: root, author: "card-test", noExtensions: true });
  for (const type of ["Generation", "Run", "Environment"]) await client.schemaAddType(type, { folder: `${type.toLowerCase()}s`, defaultStatus: "open" });
  return { root, client, pmRoot: path };
}
/** A compact, independently replayable provenance contract. */
function spec(overrides: Partial<GenerationSpec> = {}): GenerationSpec {
  return { base_checkpoint: "checkpoint", policy: "", collection_runs: [], training_config: { samples: 10, credential: "SECRET_SENTINEL", training: ["EXAMPLE_SENTINEL"] }, environment_version: "", reward_spec_version: "", parent: null, seed: true, promoted: false, approval: null, proxy_score: null, held_out_score: null, gap: null, promotion_evidence: null, ...overrides };
}
/** Persist the generation's actual immutable identity. */
async function generation(client: PmClient, value = spec(), id = "rl-seed") {
  await client.create({ id, type: "Generation", title: "Private title", body: `\`\`\`json\n${JSON.stringify(value)}\n\`\`\``, affectedVersion: hashJson(generationProvenance(value)) });
  return id;
}
/** Match actionable typed refusals, never incidental parser errors. */
function refused(code: string) { return (error: unknown) => isPmCliExpectedError(error) && error.context.code === code && /Restore complete original provenance/.test(error.message) && error.exitCode === 4; }
/** Re-address a deliberately forged card to prove replay does not trust its hash. */
function rehash(card: PolicyCard): PolicyCard { const { digest: _digest, ...body } = card; return { ...body, digest: hashJson(body as unknown as JsonValue) }; }

test("minimized cards replay exact evidence, reject forgery and refuse seed adoption without provenance", async () => {
  const w = await workspace(); const id = await generation(w.client);
  const card = await exportPolicyCard(w.client, id);
  assert.equal((await exportPolicyCard(w.client, id.toUpperCase())).digest, card.digest);
  assert.equal(card.outcome, "seed"); assert.deepEqual(card.allowed_actions, ["inspect", "evaluate"]);
  assert.equal(card.resource_limits.samples, 10);
  await w.client.claim(id);
  await w.client.comments(id, { add: "Bookkeeping must not republish a policy" });
  assert.equal((await exportPolicyCard(w.client, id)).digest, card.digest);
  assert.doesNotMatch(JSON.stringify(card), /SECRET_SENTINEL|EXAMPLE_SENTINEL|Private title|training_config/);
  assert.equal((await replayPolicyCard(w.client, card)).results.length, 1);
  assert.deepEqual(await recordPolicyCard(w.client, id), await recordPolicyCard(w.client, id));
  await assert.rejects(adoptPolicyCard(w.client, card), refused("card_missing_provenance"));
  await assert.rejects(replayPolicyCard(w.client, rehash({ ...card, allowed_actions: ["execute"] } as unknown as PolicyCard)), refused("card_drift"));
  await assert.rejects(replayPolicyCard(w.client, { ...card, evidence: [{ ...card.evidence[0], digest: "forged" }] }), refused("card_drift"));
  await assert.rejects(replayPolicyCard(w.client, { ...card, evidence: [] }), refused("card_missing_provenance"));
  await assert.rejects(replayPolicyCard(w.client, { ...card, evidence: Array(33).fill({}) }), refused("card_limit"));
  await assert.rejects(replayPolicyCard(w.client, { ...card, extra: "x".repeat(POLICY_CARD_MAX_BYTES) }), refused("card_limit"));
  for (const value of [null, [], 1]) await assert.rejects(replayPolicyCard(w.client, value), refused("card_invalid"));
  await assert.rejects(exportPolicyCard(w.client, "missing"), refused("card_missing_provenance"));
  await assert.rejects(exportPolicyCard(w.client, "credential/token"), refused("card_invalid"));
  await assert.rejects(replayPolicyCard(w.client, { ...card, subject: "bad/id" }), refused("card_invalid"));
  await assert.rejects(replayPolicyCard(w.client, { ...card, evidence: [{ ...card.evidence[0], at: 1 }] }), refused("card_invalid"));
  await assert.rejects(replayPolicyCard(w.client, { ...card, evidence: [{ ...card.evidence[0], at: "invalid" }] }), refused("card_missing_provenance"));
  await assert.rejects(replayPolicyCard(w.client, { ...card, subject: "rl-other" }), refused("card_invalid"));
  await assert.rejects(replayPolicyCard(w.client, { ...card, evidence: [card.evidence[0], card.evidence[0]] }), refused("card_invalid"));
});

/** Create a certified three-generation ancestry with evidence unique to its root. */
async function ancestryFixture() {
  const w = await workspace();
  await w.client.create({ id: "rl-env", type: "Environment", title: "Environment" });
  await w.client.create({ id: "rl-approval", type: "Decision", title: "Approval" });
  const score = { objective: "return", objective_version: "1", evaluation_context: "held-out", seed_set: "fixed", direction: "maximize" as const, scale: 1, value: 0.8 };
  for (let index = 0; index < 3; index += 1) {
    await w.client.create({ id: `rl-run-${index}`, type: "Run", title: "Collection" });
    await generation(w.client, spec({ base_checkpoint: `sha256:${hashJson(index - 1)}`, policy: `sha256:${hashJson(index)}`, seed: index === 0, promoted: index > 0,
      parent: index === 0 ? null : `rl-g${index - 1}`, collection_runs: [`rl-run-${index}`], environment_version: "rl-env", reward_spec_version: "reward",
      approval: index === 0 ? null : "rl-approval", proxy_score: index === 0 ? null : score, held_out_score: index === 0 ? null : score, gap: index === 0 ? null : 0 }), `rl-g${index}`);
    await recordPolicyCard(w.client, `rl-g${index}`);
  }
  return w;
}

test("adoption requires every ancestor generation, retained card and cited result through the root", async () => {
  for (const missing of ["generation", "card", "evidence", "corrupt-card", "card-version", "card-type", "unaddressed", "unpromoted", "cycle"] as const) {
    const w = await ancestryFixture(); const leaf = await exportPolicyCard(w.client, "rl-g2");
    assert.equal((await adoptPolicyCard(w.client, leaf)).digest, leaf.digest);
    const root = await exportPolicyCard(w.client, "rl-g0");
    let candidate = leaf;
    if (missing === "corrupt-card") await w.client.update(`policy-card-${root.digest}`, { body: "{}" });
    else if (missing === "card-version") await w.client.update(`policy-card-${root.digest}`, { affectedVersion: "different" });
    else if (missing === "card-type") await w.client.update(`policy-card-${root.digest}`, { type: "Task" });
    else if (["unaddressed", "unpromoted", "cycle"].includes(missing)) {
      const value = extractGenerationSpec(String((await w.client.get("rl-g1")).item.body), "Fixture generation");
      const target = missing === "unpromoted" ? "rl-g1" : "rl-g0";
      const changed = missing === "unpromoted" ? { ...value, promoted: false, approval: null, proxy_score: null, held_out_score: null, gap: null }
        : missing === "cycle" ? { ...value, parent: "rl-g1" } : spec({ base_checkpoint: "opaque-legacy-reference" });
      await w.client.update(target, { body: `\`\`\`json\n${JSON.stringify(changed)}\n\`\`\``, affectedVersion: hashJson(generationProvenance(changed)) });
      await recordPolicyCard(w.client, target); await recordPolicyCard(w.client, "rl-g1"); candidate = await recordPolicyCard(w.client, "rl-g2");
    } else await w.client.delete(missing === "generation" ? "rl-g0" : missing === "evidence" ? "rl-run-0" : `policy-card-${root.digest}`);
    await assert.rejects(adoptPolicyCard(w.client, candidate), refused(["corrupt-card", "card-version", "card-type"].includes(missing) ? "card_drift" : "card_missing_provenance"));
  }
});

test("policy identity binds checkpoint content and configuration independently of evaluation notes", async () => {
  const w = await workspace();
  const first = spec({ base_checkpoint: `sha256:${hashJson({ weights: [0, 1] })}`, policy: `sha256:${hashJson({ weights: [1, 0] })}`, training_config: { samples: 10 } });
  await generation(w.client, first, "rl-policy-a");
  await generation(w.client, { ...first, base_checkpoint: `sha256:${hashJson({ weights: [2, 3] })}` }, "rl-checkpoint-b");
  await generation(w.client, { ...first, policy: `sha256:${hashJson({ weights: [3, 2] })}` }, "rl-policy-b");
  await generation(w.client, { ...first, training_config: { samples: 20 } }, "rl-config-b");
  const card = await exportPolicyCard(w.client, "rl-policy-a");
  assert.ok(card.policy_digest !== null);
  for (const id of ["rl-checkpoint-b", "rl-policy-b", "rl-config-b"]) assert.notEqual((await exportPolicyCard(w.client, id)).policy_digest, card.policy_digest);
  await w.client.notes("rl-policy-a", { add: `pm-rl/policy-evaluation/1 ${JSON.stringify({ decision: "promote", reason_digest: hashJson("evaluation") })}` });
  assert.equal((await exportPolicyCard(w.client, "rl-policy-a")).policy_digest, card.policy_digest);
  assert.equal((await replayPolicyCard(w.client, card)).card.policy_digest, card.policy_digest);
  /** Retain a real completed phase result, including its verified result digest. */
  const phase = async (id: string, result: JsonValue) => w.client.create({ id, type: "Decision", title: "Fit result", body: JSON.stringify({ format: "pm-rl/loop-step/1", state: "complete", input: hashJson("fit"), result, digest: hashJson(result) }) });
  await phase("rl-fit-a", { checkpoint: first.policy, config: { samples: 10 }, candidate_mean: 0.8 });
  await phase("rl-fit-b", { checkpoint: `sha256:${hashJson("other-checkpoint")}`, config: { samples: 10 }, candidate_mean: 0.8 });
  await phase("rl-score-a", { candidate: { checkpoint: first.policy, config: { samples: 10 } }, candidate_mean: 0.1 });
  assert.notEqual((await exportPolicyCard(w.client, "rl-fit-a")).policy_digest, (await exportPolicyCard(w.client, "rl-fit-b")).policy_digest);
  assert.equal((await exportPolicyCard(w.client, "rl-fit-a")).policy_digest, (await exportPolicyCard(w.client, "rl-score-a")).policy_digest);
  await phase("rl-unaddressed-fit", { checkpoint: "opaque-policy-reference", config: { samples: 10 } });
  assert.equal((await exportPolicyCard(w.client, "rl-unaddressed-fit")).policy_digest, null);
  await phase("rl-unfitted", { configs: [{ samples: 10 }] });
  const unfitted = await exportPolicyCard(w.client, "rl-unfitted", 0);
  assert.equal(unfitted.policy_digest, null); assert.equal(unfitted.proposal_digest, hashJson({ samples: 10 }));
});

test("operational card reads are typed retryable errors and promotion remains resumable", async () => {
  const w = await workspace(); const get = w.client.get.bind(w.client);
  let fault: string | null = null;
  // Every successful result comes from the real SDK; only native-shaped failures are injected.
  w.client.get = (async (id, options) => {
    const result = await get(id, options);
    if (fault !== null && options?.fields?.includes("notes")) {
      const code = fault; fault = null;
      if (code === "storage_timeout") throw createPmCliExpectedError("Storage request timed out", { exitCode: 4, context: { code } });
      if (code === "unclassified_read") throw createPmCliExpectedError("Storage unavailable", { exitCode: 4, context: { code: "backend_unavailable" } });
      throw Object.assign(new Error("Temporary storage read failure"), { code });
    }
    return result;
  }) as PmClient["get"];
  /** Retryable reads must never be rendered as permanent provenance refusals. */
  const retryable = (error: unknown) => isPmCliExpectedError(error) && error.context.code === "provenance_read_retryable" && /resume.*storage recovers/.test(error.message);
  await generation(w.client);
  await w.client.create({ id: "rl-approval", type: "Decision", title: "Promotion", body: '```json\n{"permitted_promotions":1}\n```' });
  const config = { ...JSON.parse(readFileSync(new URL("../examples/loop-bandit.json", import.meta.url), "utf8")) as Record<string, JsonValue>, max_generations: 1 };
  const coordinates = { pmRoot: w.pmRoot, author: "card-test" };
  await assert.rejects(runRlLoop(w.client, coordinates, { id: "read-retry", config, approval: "rl-approval", onPhase(phase) { if (phase === "evaluate") fault = "EIO"; } }), retryable);
  fault = "EAGAIN";
  await assert.rejects(resumeRlLoop(w.client, coordinates, { id: "read-retry", approval: "rl-approval" }), retryable);
  const resumed = await resumeRlLoop(w.client, coordinates, { id: "read-retry", approval: "rl-approval" });
  assert.equal(resumed.promoted, 1); assert.equal(resumed.stop_reason, "generation_limit");
  const generationItem = (await get("rl-read-retry-g1", { depth: "standard" })).item;
  assert.ok(!generationItem.notes?.some((note) => note.text.includes('"decision":"refuse"')));
  for (const code of ["EIO", "EAGAIN", "EBUSY", "ENOENT", "ETIMEDOUT", "storage_timeout", "unclassified_read"]) {
    fault = code; await assert.rejects(exportPolicyCard(w.client, "rl-seed"), retryable);
    assert.equal((await exportPolicyCard(w.client, "rl-seed")).outcome, "seed");
  }
});

test("certified old explanations survive later edits while adoption rejects stale or missing sources", async () => {
  const w = await workspace(); const id = await generation(w.client);
  const card = await exportPolicyCard(w.client, id);
  await w.client.update(id, { body: `\`\`\`json\n${JSON.stringify(spec({ training_config: { samples: 20 } }))}\n\`\`\`` });
  assert.equal((await replayPolicyCard(w.client, card)).card.digest, card.digest);
  await assert.rejects(exportPolicyCard(w.client, id), refused("card_drift"));
  await w.client.update(id, { affectedVersion: hashJson(generationProvenance(spec({ training_config: { samples: 20 } }))) });
  await assert.rejects(adoptPolicyCard(w.client, card), refused("card_drift"));
  await w.client.delete(id);
  await assert.rejects(adoptPolicyCard(w.client, card), refused("card_missing_provenance"));
});

test("generation citations include parents, collection, environments and evaluation records without copying content", async () => {
  const w = await workspace(); await generation(w.client);
  for (const [id, type, body] of [["rl-run", "Run", "private non-JSON"], ["rl-env", "Environment", "{}"], ["rl-approval", "Decision", '```json\n{"resource_budget":{"tokens":0,"wall_ms":100}}\n```']] as const) await w.client.create({ id, type, title: id, body });
  const value = spec({ seed: false, policy: "collection-policy", parent: "rl-seed", collection_runs: ["rl-run"], environment_version: "rl-env", reward_spec_version: "reward", training_config: { candidate_held_out_mean: 0.2, incumbent_held_out_mean: 0.5, samples: 2, budget: { tokens: 0 }, adapter: { allowance: { wall_ms: 10 } } } });
  const id = await generation(w.client, value, "rl-candidate");
  const card = await exportPolicyCard(w.client, id);
  assert.equal(card.outcome, "refused"); assert.deepEqual(card.known_regressions, ["reward_regression"]); assert.equal(card.resource_limits.wall_ms, 10);
  assert.equal((await replayPolicyCard(w.client, card)).results.length, 4);
  await assert.rejects(replayPolicyCard(w.client, rehash({ ...card, evidence: card.evidence.filter((row) => row.id !== "rl-run") })), refused("card_missing_provenance"));
  await w.client.create({ id: `${id}-evaluation-plan`, type: "Plan", title: "Pinned plan", body: '{"budget":{"active_calls":2,"candidate_calls":2}}' });
  for (const suffix of ["-result", "-shadow", "-shadow-comparison"]) await w.client.create({ id: `${id}-evaluation-plan${suffix}`, type: "Decision", title: "Result", body: "{}" });
  const planned = { ...value, evaluation_plan: hashJson("pinned-comparison") };
  await w.client.update(id, { body: `\`\`\`json\n${JSON.stringify(planned)}\n\`\`\``, affectedVersion: hashJson(generationProvenance(planned)) });
  assert.equal((await exportPolicyCard(w.client, id)).evidence.length, 8);
  assert.equal((await replayPolicyCard(w.client, await exportPolicyCard(w.client, id))).results.length, 8);
  await assert.rejects(adoptPolicyCard(w.client, await exportPolicyCard(w.client, id)), refused("card_missing_provenance"));
  const many = spec({ collection_runs: Array.from({ length: 33 }, (_, i) => `rl-run-${i}`) });
  await generation(w.client, many, "rl-many"); await assert.rejects(exportPolicyCard(w.client, "rl-many"), refused("card_limit"));
  await generation(w.client, { ...value, training_config: { policy_card_evaluation: { decision: "refuse" } } }, "rl-rejected");
  await w.client.notes("rl-rejected", { add: 'pm-rl/policy-evaluation/1 {"decision":"refuse"}' });
  assert.deepEqual((await exportPolicyCard(w.client, "rl-rejected")).known_regressions, ["promotion_refused"]);
  await generation(w.client, spec({ training_config: [] }), "rl-null"); assert.deepEqual((await exportPolicyCard(w.client, "rl-null")).resource_limits, {});
});

test("durable recursive phase cards are automatic and retry-safe and retain rejection explanations", async () => {
  const w = await workspace(); await w.client.create({ id: "rl-approval", type: "Decision", title: "Consent" });
  const coordinates = { pmRoot: w.pmRoot, author: "card-test" };
  const execute = () => withRlController(w.client, coordinates, { id: "cards", approval: "rl-approval", recoveryCommand: "resume programme" }, AbortSignal.timeout(60000), async (step) => {
    await step("programme", {}, async () => ({ config: { generations: 2, updates: 2 } }));
    await step("proposals", {}, async () => ({ configs: [{ rate: 1 }, { rate: 2 }] }));
    await step("g1-candidate", {}, async () => ({ promoted: true, samples: 2 }));
    await step("g2-candidate", {}, async () => ({ promoted: false, gain: -0.1 }));
    return true;
  });
  await execute(); await execute();
  const inventory = await w.client.listAllComplete({ includeBody: true });
  const cards = inventory.items.filter((item) => String(item.id).includes("-policy-card-")); assert.equal(cards.length, 6);
  for (const row of cards) assert.ok((await replayPolicyCard(w.client, JSON.parse(String(row.body)))).results.length > 0);
  assert.equal((await exportPolicyCard(w.client, "rl-cards-step-g2-candidate")).outcome, "refused");
  await assert.rejects(adoptPolicyCard(w.client, await exportPolicyCard(w.client, "rl-cards-step-g1-candidate")), refused("card_not_adoptable"));
});

test("CLI card export, replay and adoption checks work with no Git executable and never mutate on refusal", async () => {
  const w = await workspace(); const id = await generation(w.client);
  const harness = await createExtensionTestHarness(extension, { name: "pm-rl", capabilities: ["commands", "schema", "hooks"] });
  const bin = join(w.root, "bin"); mkdirSync(bin); symlinkSync(process.execPath, join(bin, "node"));
  const oldPath = process.env.PATH; const oldCeiling = process.env.GIT_CEILING_DIRECTORIES;
  process.env.PATH = bin; process.env.GIT_CEILING_DIRECTORIES = dirname(w.root);
  try {
    const result = (await harness.runCommand({ command: "rl policy-card export", pmRoot: w.pmRoot, args: [id], options: {} })).result as RlCommandResult;
    const file = join(w.root, "card.json"); writeFileSync(file, JSON.stringify(result.details));
    const replay = (await harness.runCommand({ command: "rl policy-card replay", pmRoot: w.pmRoot, args: [], options: { file } })).result as RlCommandResult;
    assert.equal(replay.details?.digest, result.details?.digest);
    await assert.rejects(harness.runCommand({ command: "rl policy-card adopt", pmRoot: w.pmRoot, args: [], options: { file } }), refused("card_missing_provenance"));
  } finally { process.env.PATH = oldPath; if (oldCeiling === undefined) delete process.env.GIT_CEILING_DIRECTORIES; else process.env.GIT_CEILING_DIRECTORIES = oldCeiling; }
});


test("real recursive generations retain candidate and promotion cards and pass suitability only after all gates", async () => {
  const w = await workspace();
  const config = JSON.parse(readFileSync(new URL("../examples/loop-bandit.json", import.meta.url), "utf8")) as Record<string, JsonValue>;
  config.max_generations = 2;
  await w.client.create({ id: "rl-approval", type: "Decision", title: "Bounded promotion consent", body: '```json\n{"permitted_promotions":2}\n```' });
  const report = await runRlLoop(w.client, { pmRoot: w.pmRoot, author: "card-test" }, { id: "loop-cards", config, approval: "rl-approval" });
  assert.equal(report.promoted, 2);
  for (const row of report.generations) {
    const card = await exportPolicyCard(w.client, row.item);
    assert.equal((await adoptPolicyCard(w.client, card)).digest, card.digest);
  }
  const inventory = await w.client.listAllComplete({ includeBody: true });
  const cards = inventory.items.filter((item) => String(item.id).includes("-policy-card-")).map((item) => JSON.parse(String(item.body)) as PolicyCard);
  for (const row of report.generations) {
    assert.ok(cards.some((card) => card.subject === row.item && card.outcome === "candidate"));
    assert.ok(cards.some((card) => card.subject === row.item && card.outcome === "promoted"));
  }
  const harness = await createExtensionTestHarness(extension, { name: "pm-rl", capabilities: ["commands", "schema", "hooks"] });
  const card = await exportPolicyCard(w.client, report.generations[0].item);
  const file = join(w.root, "suitable.json"); writeFileSync(file, JSON.stringify(card));
  assert.equal(((await harness.runCommand({ command: "rl policy-card adopt", pmRoot: w.pmRoot, args: [], options: { file } })).result as RlCommandResult).details?.suitable, true);
  await w.client.update(report.generations[0].run, { component: "changed-collection-policy" });
  assert.equal((await replayPolicyCard(w.client, card)).card.digest, card.digest);
  await assert.rejects(adoptPolicyCard(w.client, card), refused("card_drift"));
});

test("malformed completed receipts, proposal selectors, numeric diagnostics and concurrent publication stay fail closed", async () => {
  const w = await workspace();
  const receipts: readonly [string, string, string][] = [
    ["bad-json", "not json", "card_invalid"],
    ["bad-object", "[]", "card_invalid"],
    ["bad-format", "{}", "card_missing_provenance"],
    ["bad-result", JSON.stringify({ format: "pm-rl/loop-step/1", state: "complete", input: hashJson("binding"), result: [], digest: hashJson([]) }), "card_invalid"],
  ];
  for (const [id, body, code] of receipts) {
    await w.client.create({ id: `rl-${id}`, type: "Decision", title: id, body });
    await assert.rejects(exportPolicyCard(w.client, `rl-${id}`), refused(code));
  }
  await generation(w.client, spec({ training_config: { samples: -1, budget: [], config: null, adapter: 1 } }), "rl-limits");
  assert.deepEqual((await exportPolicyCard(w.client, "rl-limits")).resource_limits, {});
  const result = { recipes: [{ digest: "private-artifact-a" }, { digest: "private-artifact-b" }], promoted: "private-policy", verdict: { decision: "promote", margin: 0.1, uncertainty: 0.2, gain_lower_bound: 0.3, gain: -0.1 }, meta: { verdict: { decision: "refuse" }, trial: { gain: -0.5, samples: 2 }, outcome: null }, config: { samples: 3 }, budget: { samples: 9, tokens: 0 } };
  await w.client.create({ id: "rl-proposals", type: "Decision", title: "Recipes", body: JSON.stringify({ format: "pm-rl/loop-step/1", state: "complete", input: hashJson("binding"), result, digest: hashJson(result) }) });
  await w.client.notes("rl-limits", { add: "unrelated private note" });
  await w.client.notes("rl-limits", { add: "pm-rl/policy-evaluation/1 invalid-json" });
  await assert.rejects(exportPolicyCard(w.client, "rl-limits"), refused("card_invalid"));
  const card = await exportPolicyCard(w.client, "rl-proposals", 1);
  assert.equal(card.selection, 1); assert.equal(card.evaluation.decision, "refuse"); assert.equal(card.evaluation.gain, -0.5); assert.equal(card.resource_limits.samples, 9);
  assert.doesNotMatch(JSON.stringify(card), /private-artifact|private-policy/);
  assert.equal((await replayPolicyCard(w.client, card)).card.policy_digest, card.policy_digest);
  for (const selection of [-1, 0.5, 2, NaN]) await assert.rejects(exportPolicyCard(w.client, "rl-proposals", selection), refused("card_invalid"));
  await generation(w.client);
  await recordRecursivePolicyCards(w.client, "rl-seed");
  await assert.rejects(exportPolicyCard(w.client, "rl-seed", 0), refused("card_invalid"));
  await assert.rejects(replayPolicyCard(w.client, { ...card, invalid: 1n }), refused("card_invalid"));
  const oversized = { configs: Array(33).fill({ rate: 1 }) };
  await w.client.create({ id: "rl-many-proposals", type: "Decision", title: "Oversized proposal batch", body: JSON.stringify({ format: "pm-rl/loop-step/1", state: "complete", input: hashJson("binding"), result: oversized, digest: hashJson(oversized) }) });
  await assert.rejects(recordRecursivePolicyCards(w.client, "rl-many-proposals"), refused("card_limit"));
  await assert.rejects(replayPolicyCard(w.client, { ...card, selection: "1" }), refused("card_invalid"));
  await assert.rejects(replayPolicyCard(w.client, { ...card, evidence: [null] }), refused("card_invalid"));
  const harness = await createExtensionTestHarness(extension, { name: "pm-rl", capabilities: ["commands", "schema", "hooks"] });
  assert.equal(((await harness.runCommand({ command: "rl policy-card export", pmRoot: w.pmRoot, args: ["rl-proposals"], options: { selection: "0" } })).result as RlCommandResult).details?.selection, 0);
  const concurrent = await Promise.all(Array.from({ length: 4 }, () => recordPolicyCard(w.client, "rl-proposals", 1)));
  assert.ok(concurrent.every((entry) => entry.digest === card.digest));
  const stored = (await w.client.listAllComplete({ includeBody: false })).items.find((item) => item.id.includes(card.digest))!;
  await w.client.update(stored.id, { body: "{}" });
  await assert.rejects(recordPolicyCard(w.client, "rl-proposals", 1), refused("card_drift"));
});


test("materialized evidence drift and oversized complete exports refuse without trimming citations", async () => {
  const w = await workspace(); const id = await generation(w.client);
  const path = join(w.pmRoot, "generations", `${id}.toon`); const original = readFileSync(path, "utf8");
  writeFileSync(path, original.replace(/updated_at: [^\n]+/, 'updated_at: invalid'));
  await assert.rejects(exportPolicyCard(w.client, id), refused("card_missing_provenance"));
  writeFileSync(path, original.replace('status: open', 'status: in_progress'));
  await assert.rejects(exportPolicyCard(w.client, id), refused("card_missing_provenance"));
  writeFileSync(path, original);
  const runs = Array.from({ length: 30 }, (_, i) => `rl-run-${i}`);
  for (const run of runs) await w.client.create({ id: run, type: "Run", title: run });
  await generation(w.client, spec({ collection_runs: runs }), "rl-oversize");
  await assert.rejects(exportPolicyCard(w.client, "rl-oversize"), refused("card_limit"));
});


test("resume repairs card publication interrupted after a committed promotion", async (context) => {
  for (const fault of ["storage", "collision"] as const) await context.test(fault, async () => {
    const w = await workspace();
    /** Delegate real SDK closes, then obstruct only the not-yet-published explanation. */
    class InterruptedPublisher extends PmClient {
      repair: (() => Promise<void>) | null = null;
      /** Create a native failure after the real promotion close commits. */
      override close(id: string, reason: string, options: PmClientCloseActionOptions & { releaseAssignment: true }): Promise<CloseTaskResult>;
      override close(id: string, reason: string, options?: PmClientCloseActionOptions & { releaseAssignment?: false }): Promise<CloseResult>;
      override close(id: string, reason: string, options?: PmClientCloseActionOptions & { releaseAssignment?: boolean }): Promise<CloseResult | CloseTaskResult>;
      override async close(id: string, reason: string, options?: PmClientCloseActionOptions & { releaseAssignment?: boolean }): Promise<CloseResult | CloseTaskResult> {
        const result = await super.close(id, reason, options);
        const item = "item" in result ? result.item : result.close.item;
        if (item.type === "Generation" && this.repair === null) {
          const card = await exportPolicyCard(this, String(item.id));
          const cardId = `rl-policy-card-${card.digest}`;
          if (fault === "storage") {
            const obstruction = join(w.pmRoot, "decisions", `${cardId}.toon`); mkdirSync(obstruction);
            this.repair = async () => { rmSync(obstruction, { recursive: true }); };
          } else {
            await super.create({ id: cardId, type: "Decision", title: "Publication obstruction", body: "{}" });
            this.repair = async () => { await super.update(cardId, { body: canonicalJson(card as unknown as JsonValue), affectedVersion: card.digest }); };
          }
        }
        return result;
      }
    }
    const client = new InterruptedPublisher({ pmRoot: w.pmRoot, cwd: w.root, author: "card-test", noExtensions: true });
    await client.create({ id: "rl-approval", type: "Decision", title: "One bounded promotion", body: '```json\n{"permitted_promotions":1}\n```' });
    const config = { ...JSON.parse(readFileSync(new URL("../examples/loop-bandit.json", import.meta.url), "utf8")) as Record<string, JsonValue>, max_generations: 1 };
    await assert.rejects(runRlLoop(client, { pmRoot: w.pmRoot, author: "card-test" }, { id: "repair", config, approval: "rl-approval" }), fault === "collision" ? refused("card_drift") : (error: unknown) => error instanceof Error);
    assert.ok(client.repair !== null); await client.repair();
    const committed = await exportPolicyCard(client, "rl-repair-g1"); assert.equal(committed.outcome, "promoted");
    const before = (await client.listAllComplete({ includeBody: true })).items;
    assert.equal(before.filter((item) => item.id.includes("-policy-card-")).map((item) => JSON.parse(String(item.body)) as PolicyCard).filter((card) => card.outcome === "promoted").length, fault === "collision" ? 1 : 0);
    const resumed = await resumeRlLoop(client, { pmRoot: w.pmRoot, author: "card-test" }, { id: "repair", approval: "rl-approval" });
    assert.equal(resumed.resumed_generations, 1); assert.equal(resumed.promoted, 1);
    const after = (await client.listAllComplete({ includeBody: true })).items;
    const promoted = after.filter((item) => item.id.includes("-policy-card-")).map((item) => JSON.parse(String(item.body)) as PolicyCard).filter((card) => card.outcome === "promoted");
    assert.equal(promoted.length, 1);
    assert.equal((await replayPolicyCard(client, promoted[0])).card.digest, committed.digest);
  });
});
