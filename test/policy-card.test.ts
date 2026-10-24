/** Portable explanation regressions exercise real SDK histories in plain-directory trackers. */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, symlinkSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, relative } from "node:path";
import { after, test } from "node:test";
import { PmClient, type CloseResult } from "@unbrained/pm-cli/sdk/core";
import { init, isPmCliExpectedError, createPmCliExpectedError, type CloseTaskResult, type PmClientCloseActionOptions } from "@unbrained/pm-cli/sdk/runtime";
import { createExtensionTestHarness } from "@unbrained/pm-cli/sdk/testing";
import extension, { generationProvenance, extractGenerationSpec, hashJson, canonicalJson, readCompleteLoopItem, runRlLoop, resumeRlLoop, withRlController, recordRefusedPolicyCard, mutateLoopItem, promoteGenerationCore, appendCommentOnce, type JsonValue, type RlCommandResult } from "../index.ts";
import { exportPolicyCard, replayPolicyCard, adoptPolicyCard, recordRecursivePolicyCards, recordPolicyCard, POLICY_CARD_MAX_BYTES, validatePolicyCardWrite, generationEvidence, verifyRetainedGenerationEvidence, type PolicyCard } from "../policy-card.ts";
import { encodeEvent, encodeEventSegments } from "../series.ts";
import { prefixCheckpoint } from "../prefix.ts";
import type { GenerationSpec } from "../lineage.ts";

const roots: string[] = [];
after(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });
/** Snapshot every durable tracker file; SDK usage observations and renewable locks are derived coordination state. */
function trackerBytes(root: string): Record<string, string> {
  const files: Record<string, string> = {};
  /** Traverse only the explicitly created disposable tracker. */
  function visit(directory: string): void {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(directory, entry.name);
      if (relative(root, path) === "locks" || relative(root, path) === join("runtime", "context-usage.jsonl")) continue;
      if (entry.isDirectory()) visit(path);
      else files[relative(root, path)] = readFileSync(path).toString("base64");
    }
  }
  visit(root); return files;
}
/** Every deterministic refusal must preserve the complete tracker file inventory and exact bytes. */
async function unchanged(root: string, run: () => Promise<unknown>, code: string): Promise<void> {
  const before = trackerBytes(root);
  await assert.rejects(run(), refused(code));
  const after = trackerBytes(root);
  assert.deepEqual(Object.keys({ ...before, ...after }).filter((path) => before[path] !== after[path]), [], "durable tracker files changed on refusal");
}
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

test("citation reads require complete verified history and preserve durable compacted version addresses", async () => {
  const w = await workspace(); const id = await generation(w.client);
  /** Exercise real bounded and unverified SDK responses, rather than synthetic history records. */
  class ProjectedHistoryClient extends PmClient {
    projection: "bounded" | "unverified" | "full" = "bounded";
    /** Deliberately request an insufficient native history projection from the same real tracker. */
    override run(action: Parameters<PmClient["run"]>[0], args?: Parameters<PmClient["run"]>[1]): Promise<unknown> {
      return super.run(action, action === "history" ? { ...args, options: { ...(args?.options as Readonly<Record<string, unknown>>), ...(this.projection === "bounded" ? { limit: "1" } : this.projection === "unverified" ? { verify: false } : { compact: false }) } } : args);
    }
  }
  const projected = new ProjectedHistoryClient({ pmRoot: w.pmRoot, cwd: w.root, author: "card-test", noExtensions: true });
  for (const projection of ["bounded", "unverified", "full"] as const) {
    projected.projection = projection;
    await assert.rejects(exportPolicyCard(projected, id), refused("card_missing_provenance"));
  }
  await w.client.comments(id, { add: "Before compaction" });
  await w.client.historyCompact(id, { force: true });
  const card = await exportPolicyCard(w.client, id);
  assert.ok(Number(card.evidence[0].at) > 1);
  assert.equal((await replayPolicyCard(w.client, card)).card.digest, card.digest);
  await w.client.notes(id, { add: "After compaction" });
  assert.equal((await exportPolicyCard(w.client, id)).digest, card.digest);
});

test("operational history enumeration errors remain retryable without changing policy evidence", async () => {
  const w = await workspace(); const id = await generation(w.client);
  const run = w.client.run.bind(w.client);
  let failure: unknown = null;
  // Successful data always comes from the real SDK; inject native failures only after its history read.
  w.client.run = (async (action, args) => {
    const result = await run(action, args);
    if (action === "history" && failure !== null) throw failure;
    return result;
  }) as PmClient["run"];
  const before = trackerBytes(w.pmRoot);
  for (const error of [
    createPmCliExpectedError("History backend unavailable", { exitCode: 4, context: { code: "backend_unavailable" } }),
    createPmCliExpectedError("History request timed out", { exitCode: 4, context: { code: "storage_timeout" } }),
    Object.assign(new Error("Storage read failed"), { code: "EIO" }),
    new DOMException("History request timed out", "TimeoutError"),
  ]) {
    failure = error;
    await assert.rejects(exportPolicyCard(w.client, id), (caught: unknown) => isPmCliExpectedError(caught) && caught.context.code === "provenance_read_retryable");
    assert.deepEqual(trackerBytes(w.pmRoot), before);
  }
  const native = new TypeError("Native history read failure"); failure = native;
  await assert.rejects(exportPolicyCard(w.client, id), (error: unknown) => error === native);
  failure = createPmCliExpectedError("Certified history missing", { exitCode: 4, context: { code: "history_drift" } });
  await assert.rejects(exportPolicyCard(w.client, id), refused("card_missing_provenance"));
  failure = null;
  assert.equal((await exportPolicyCard(w.client, id)).outcome, "seed");
});

test("concurrent policy replacement and history compaction cannot certify a vanished content snapshot", async () => {
  const w = await workspace(); const id = await generation(w.client);
  /** A real peer change prunes the old content between the current read and history enumeration. */
  class CompactingPeerClient extends PmClient {
    /** Complete the peer's legitimate operations before reading the resulting verified history. */
    override async run(action: Parameters<PmClient["run"]>[0], args?: Parameters<PmClient["run"]>[1]): Promise<unknown> {
      if (action === "history") {
        const changed = spec({ training_config: { samples: 20 } });
        await w.client.update(id, { body: `\`\`\`json\n${JSON.stringify(changed)}\n\`\`\``, affectedVersion: hashJson(generationProvenance(changed)) });
        await w.client.historyCompact(id, { force: true });
      }
      return super.run(action, args);
    }
  }
  const peer = new CompactingPeerClient({ pmRoot: w.pmRoot, cwd: w.root, author: "card-test", noExtensions: true });
  await assert.rejects(exportPolicyCard(peer, id), refused("card_missing_provenance"));
  assert.equal((await exportPolicyCard(w.client, id)).resource_limits.samples, 20);
});

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
async function ancestryFixture(direction: "maximize" | "minimize" = "maximize", candidate = 0.8, incumbent = 0.8) {
  const w = await workspace();
  await w.client.create({ id: "rl-env", type: "Environment", title: "Environment" });
  await w.client.create({ id: "rl-approval", type: "Decision", title: "Approval" });
  const score = { objective: "return", objective_version: "1", evaluation_context: "held-out", seed_set: "fixed", direction, scale: 1, value: candidate };
  for (let index = 0; index < 3; index += 1) {
    await w.client.create({ id: `rl-run-${index}`, type: "Run", title: "Collection" });
    await generation(w.client, spec({ base_checkpoint: `sha256:${hashJson(index - 1)}`, policy: `sha256:${hashJson(index)}`, seed: index === 0, promoted: index > 0,
      parent: index === 0 ? null : `rl-g${index - 1}`, collection_runs: [`rl-run-${index}`], environment_version: "rl-env", reward_spec_version: "reward",
      training_config: { samples: 10, candidate_held_out_mean: candidate, incumbent_held_out_mean: incumbent },
      approval: index === 0 ? null : "rl-approval", proxy_score: index === 0 ? null : score, held_out_score: index === 0 ? null : score, gap: index === 0 ? null : 0 }), `rl-g${index}`);
    await recordPolicyCard(w.client, `rl-g${index}`);
  }
  return w;
}

test("policy regressions respect minimizing and maximizing score directions during replay and adoption", async () => {
  for (const direction of ["minimize", "maximize"] as const) for (const candidate of [0.2, 0.5, 0.8]) {
    const w = await ancestryFixture(direction, candidate, 0.5);
    const card = await exportPolicyCard(w.client, "rl-g2");
    const regression = direction === "minimize" ? candidate > 0.5 : candidate < 0.5;
    assert.equal(card.outcome, "promoted");
    assert.deepEqual(card.known_regressions, regression ? ["reward_regression"] : []);
    assert.equal((await replayPolicyCard(w.client, card)).card.digest, card.digest);
    if (regression) await assert.rejects(adoptPolicyCard(w.client, card), refused("card_not_adoptable"));
    else assert.equal((await adoptPolicyCard(w.client, card)).digest, card.digest);
  }
});

test("prospective promoted card overflow refuses before history changes or approval budget is spent", async () => {
  const w = await workspace(); await generation(w.client);
  await w.client.create({ id: "rl-env", type: "Environment", title: "Environment" });
  const approval = `rl-approval-${"a".repeat(170)}`;
  await w.client.create({ id: approval, type: "Decision", title: "One promotion", body: '```json\n{"permitted_promotions":1,"resource_budget":{"wall_ms":100,"tokens":0}}\n```' });
  const runs: string[] = [];
  let card: PolicyCard;
  for (let index = 0; ; index += 1) {
    const run = `rl-run-${index}-${"r".repeat(20)}`; runs.push(run);
    await w.client.create({ id: run, type: "Run", title: "Collection", environment: "rl-env" });
    const value = spec({ seed: false, policy: "candidate", parent: "rl-seed", collection_runs: runs, environment_version: "rl-env", reward_spec_version: "reward" });
    if (index === 0) await generation(w.client, value, "rl-candidate");
    else await w.client.update("rl-candidate", { body: `\`\`\`json\n${JSON.stringify(value)}\n\`\`\``, affectedVersion: hashJson(generationProvenance(value)) });
    card = await exportPolicyCard(w.client, "rl-candidate");
    if (Buffer.byteLength(canonicalJson(card as unknown as JsonValue)) > POLICY_CARD_MAX_BYTES - 150) break;
    assert.ok(index < 30);
  }
  await recordPolicyCard(w.client, "rl-candidate");
  const score = { objective: "return", objective_version: "1", evaluation_context: "held-out", seed_set: "fixed", direction: "maximize", scale: 1, value: 0.8 };
  const scores = join(w.root, "scores.json"); writeFileSync(scores, JSON.stringify({ proxy_score: score, held_out_score: score }));
  const harness = await createExtensionTestHarness(extension, { name: "pm-rl", capabilities: ["commands", "schema", "hooks"] });
  const before = await w.client.get("rl-candidate");
  const bytes = trackerBytes(w.pmRoot);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await assert.rejects(harness.runCommand({ command: "rl generation promote", pmRoot: w.pmRoot, args: ["rl-candidate"], options: { approval, scores, evidence: "Evaluated" } }), refused("card_limit"));
    const refusedBytes = trackerBytes(w.pmRoot);
    assert.deepEqual(Object.keys({ ...bytes, ...refusedBytes }).filter((path) => bytes[path] !== refusedBytes[path]), [], "all durable tracker bytes, including history, budgets and transaction receipts");
    const after = await w.client.get("rl-candidate");
    assert.equal(after.item.body, before.item.body); assert.equal(after.item.status, before.item.status);
    assert.equal(after.item.updated_at, before.item.updated_at);
    assert.equal((await exportPolicyCard(w.client, "rl-candidate")).digest, card.digest);
  }
  // Free explanation space, then consume the same one-unit approval successfully.
  const value = extractGenerationSpec(String(before.item.body), "Candidate");
  const smaller = { ...value, collection_runs: [runs[0]] };
  await w.client.update("rl-candidate", { body: `\`\`\`json\n${JSON.stringify(smaller)}\n\`\`\``, affectedVersion: hashJson(generationProvenance(smaller)) });
  const promoted = (await harness.runCommand({ command: "rl generation promote", pmRoot: w.pmRoot, args: ["rl-candidate"], options: { approval, scores, evidence: "Evaluated" } })).result as RlCommandResult;
  assert.equal(promoted.details?.budget_consumed, 1);
  const retained = await recordPolicyCard(w.client, "rl-candidate");
  assert.equal(retained.outcome, "promoted"); assert.equal(retained.resource_limits.wall_ms, 100);
  assert.equal((await replayPolicyCard(w.client, retained)).card.digest, retained.digest);
});

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
    if (fault !== null && options?.fields?.includes("body")) {
      const code = fault; fault = null;
      if (code === "storage_timeout") throw createPmCliExpectedError("Storage request timed out", { exitCode: 4, context: { code } });
      if (code === "unclassified_read") throw createPmCliExpectedError("Storage unavailable", { exitCode: 4, context: { code: "backend_unavailable" } });
      if (code === "native_timeout") throw new DOMException("Storage request timed out", "TimeoutError");
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
  for (const code of ["EIO", "EAGAIN", "EBUSY", "ENOENT", "ETIMEDOUT", "storage_timeout", "unclassified_read", "native_timeout"]) {
    fault = code; await assert.rejects(exportPolicyCard(w.client, "rl-seed"), retryable);
    assert.equal((await exportPolicyCard(w.client, "rl-seed")).outcome, "seed");
  }
});

test("unrelated native read errors retain their identity and never become provenance verdicts", async () => {
  const w = await workspace(); await generation(w.client);
  const get = w.client.get.bind(w.client);
  for (const failure of [new TypeError("Transaction author required"), Object.assign(new Error("Unreadable storage"), { code: "EISDIR" }), {}, null, "native failure"]) {
    w.client.get = (async (id, options) => { await get(id, options); throw failure; }) as PmClient["get"];
    await assert.rejects(readCompleteLoopItem(w.client, "rl-seed"), (error: unknown) => error === failure);
    await assert.rejects(exportPolicyCard(w.client, "rl-seed"), (error: unknown) => error === failure);
  }
  w.client.get = get;
  assert.equal((await exportPolicyCard(w.client, "rl-seed")).outcome, "seed");
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
  const shadow = { generation: id, budget: { active_calls: 2, candidate_calls: 2 } };
  const plan = { candidate: id, incumbent: "rl-seed", incumbent_version: "original", shadow: hashJson(shadow) };
  const comparison = hashJson(plan);
  await w.client.create({ id: `${id}-evaluation-plan`, type: "Plan", title: "Pinned plan", body: JSON.stringify({ plan, incumbent_version: "original" }), affectedVersion: hashJson({ comparison, incumbent_version: "original" }) });
  for (const suffix of ["-result", "-shadow", "-shadow-comparison"]) await w.client.create({ id: `${id}-evaluation-plan${suffix}`, type: "Decision", title: "Result", body: JSON.stringify(suffix === "-shadow" ? shadow : { comparison: suffix === "-result" ? comparison : plan.shadow }), affectedVersion: suffix === "-shadow" ? plan.shadow : "" });
  const planned = { ...value, evaluation_plan: comparison };
  await w.client.update(id, { body: `\`\`\`json\n${JSON.stringify(planned)}\n\`\`\``, affectedVersion: hashJson(generationProvenance(planned)) });
  assert.equal((await exportPolicyCard(w.client, id)).evidence.length, 8);
  assert.equal((await replayPolicyCard(w.client, await exportPolicyCard(w.client, id))).results.length, 8);
  const plannedCard = await recordPolicyCard(w.client, id);
  await w.client.notes(`${id}-evaluation-plan`, { add: "Routine plan annotation" });
  await verifyRetainedGenerationEvidence(w.client, id);
  const planId = `${id}-evaluation-plan`;
  const originalResult = String((await w.client.get(`${planId}-result`)).item.body);
  await w.client.update(`${planId}-result`, { body: JSON.stringify({ comparison, observations: [], budget: { tokens: 999999 } }) });
  const bounded = await exportPolicyCard(w.client, id);
  assert.notEqual(bounded.digest, plannedCard.digest);
  await assert.rejects(verifyRetainedGenerationEvidence(w.client, id), (error: unknown) => isPmCliExpectedError(error) && error.context.code === "loop_generation_drift");
  assert.equal(bounded.resource_limits.tokens, 0, "comparison evidence cannot introduce resource declarations");
  assert.equal((await replayPolicyCard(w.client, bounded)).card.digest, bounded.digest);
  await w.client.update(`${planId}-result`, { body: originalResult });
  const mutations: readonly [string, Parameters<PmClient["update"]>[1], string][] = [
    [planId, { type: "Task" }, "card_drift"],
    [planId, { body: "{" }, "card_drift"],
    [planId, { body: "[]" }, "card_drift"],
    [planId, { body: JSON.stringify({ plan: null }) }, "card_invalid"],
    ...[
      { ...plan, candidate: "rl-other" }, { ...plan, incumbent: "rl-other" },
      { ...plan, incumbent_version: "other" }, { ...plan, extra: 1 },
    ].map((changed): [string, Parameters<PmClient["update"]>[1], string] => [planId, { body: JSON.stringify({ plan: changed, incumbent_version: "original" }) }, "card_drift"]),
    [planId, { body: JSON.stringify({ plan, incumbent_version: "original", budget: { tokens: 999999 } }) }, "card_drift"],
    [planId, { affectedVersion: "wrong" }, "card_drift"],
    [`${planId}-result`, { type: "Task" }, "card_drift"],
    [`${planId}-result`, { body: JSON.stringify({ comparison: "foreign" }) }, "card_drift"],
    [`${planId}-shadow`, { body: JSON.stringify({ ...shadow, generation: "rl-other" }) }, "card_drift"],
    [`${planId}-shadow`, { body: JSON.stringify({ ...shadow, extra: 1 }) }, "card_drift"],
    [`${planId}-shadow`, { affectedVersion: "wrong" }, "card_drift"],
    [`${planId}-shadow-comparison`, { body: JSON.stringify({ comparison: "foreign" }) }, "card_drift"],
  ];
  for (const [target, update, code] of mutations) {
    const original = (await w.client.get(target)).item;
    await w.client.update(target, update);
    await unchanged(w.pmRoot, () => exportPolicyCard(w.client, id), code);
    await unchanged(w.pmRoot, () => verifyRetainedGenerationEvidence(w.client, id), code);
    await w.client.update(target, { body: String(original.body), type: original.type, affectedVersion: String(original.affected_version ?? "") });
  }
  assert.equal((await replayPolicyCard(w.client, plannedCard)).card.digest, plannedCard.digest);
  const { shadow: _shadow, ...offlinePlan } = { ...plan, candidate: "rl-offline" };
  const offlineComparison = hashJson(offlinePlan);
  await w.client.create({ id: "rl-offline-evaluation-plan", type: "Plan", title: "Offline comparison", body: JSON.stringify({ plan: offlinePlan, incumbent_version: "original" }), affectedVersion: hashJson({ comparison: offlineComparison, incumbent_version: "original" }) });
  await generation(w.client, { ...value, evaluation_plan: offlineComparison }, "rl-offline");
  const offlineCard = await exportPolicyCard(w.client, "rl-offline");
  const foreignResult = { samples: 1 };
  const foreignId = "rl-offline-evaluation-plan-shadow-comparison";
  await w.client.create({ id: foreignId, type: "Decision", title: "Unrelated certified result", body: JSON.stringify({ format: "pm-rl/loop-step/1", state: "complete", input: hashJson("foreign"), result: foreignResult, digest: hashJson(foreignResult) }) });
  const foreignCitation = (await exportPolicyCard(w.client, foreignId)).evidence[0];
  await unchanged(w.pmRoot, () => exportPolicyCard(w.client, "rl-offline"), "card_drift");
  await unchanged(w.pmRoot, () => replayPolicyCard(w.client, rehash({ ...offlineCard, evidence: [...offlineCard.evidence, foreignCitation] })), "card_drift");
  await assert.rejects(adoptPolicyCard(w.client, await exportPolicyCard(w.client, id)), refused("card_missing_provenance"));
  const many = spec({ collection_runs: Array.from({ length: 33 }, (_, i) => `rl-run-${i}`) });
  await generation(w.client, many, "rl-many"); await assert.rejects(exportPolicyCard(w.client, "rl-many"), refused("card_limit"));
  await generation(w.client, { ...value, policy_evaluation: { decision: "refuse" }, training_config: {} }, "rl-rejected");
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


/** Produce a genuinely promoted policy whose body differs from its creation snapshot. */
async function promotedFixture() {
  const w = await workspace();
  const config = { ...JSON.parse(readFileSync(new URL("../examples/loop-bandit.json", import.meta.url), "utf8")) as Record<string, JsonValue>, max_generations: 1 };
  await w.client.create({ id: "rl-approval", type: "Decision", title: "Consent", body: '```json\n{"permitted_promotions":1}\n```' });
  const report = await runRlLoop(w.client, { pmRoot: w.pmRoot, author: "card-test" }, { id: "stable-card", config, approval: "rl-approval" });
  assert.equal(report.promoted, 1);
  return { ...w, subject: report.generations[0].item };
}

test("promoted cards survive every routine tracker mutation throughout the certified ancestry", async () => {
  const w = await promotedFixture();
  const original = await exportPolicyCard(w.client, w.subject);
  const ids = new Set([w.subject, ...original.evidence.map((entry) => entry.id), `rl-policy-card-${original.digest}`]);
  for (const id of ids) {
    const mutations: readonly [string, () => Promise<unknown>][] = [
      ["comment", () => w.client.comments(id, { add: "Routine progress comment" })],
      ["note", () => w.client.notes(id, { add: "Routine private note" })],
      ["reserved-looking note", () => w.client.notes(id, { add: 'pm-rl/policy-evaluation/1 {"decision":"refuse"}' })],
      ["tag", () => w.client.update(id, { addTags: ["reviewed"] })],
      ["claim", () => w.client.claim(id, { force: true })],
      ["release", () => w.client.release(id)],
      ["status note", () => w.client.update(id, { status: "in_progress", message: "Routine status note" })],
      ["unrelated field", () => w.client.update(id, { title: "Annotated result", priority: 3 })],
    ];
    for (const [name, mutate] of mutations) {
      await mutate();
      const fresh = await exportPolicyCard(w.client, w.subject);
      assert.deepEqual(fresh, original, `${id}: ${name} must preserve all digests and citations`);
      assert.equal((await adoptPolicyCard(w.client, fresh)).digest, original.digest, `${id}: ${name} fresh adoption`);
      assert.equal((await adoptPolicyCard(w.client, original)).digest, original.digest, `${id}: ${name} retained adoption`);
    }
  }
});

test("policy relevant changes invalidate retained promoted cards while preserving historical replay", async () => {
  const w = await promotedFixture();
  const original = await exportPolicyCard(w.client, w.subject);
  const value = extractGenerationSpec(String((await w.client.get(w.subject)).item.body), "Promoted policy");
  await w.client.create({ id: "rl-other-approval", type: "Decision", title: "Other consent" });
  await w.client.create({ id: "rl-other-run", type: "Run", title: "Other evidence" });
  for (const changed of [
    { ...value, policy: `sha256:${hashJson("changed artifact")}` },
    { ...value, training_config: { samples: 99 } },
    { ...value, collection_runs: ["rl-other-run"] },
    { ...value, approval: "rl-other-approval" },
    { ...value, policy_evaluation: { decision: "refuse" } },
  ]) {
    await w.client.update(w.subject, { body: `\`\`\`json\n${JSON.stringify(changed)}\n\`\`\``, affectedVersion: hashJson(generationProvenance(changed)) });
    assert.equal((await replayPolicyCard(w.client, original)).card.digest, original.digest);
    await assert.rejects(adoptPolicyCard(w.client, original), refused("card_drift"));
    await w.client.update(w.subject, { body: `\`\`\`json\n${JSON.stringify(value)}\n\`\`\``, affectedVersion: hashJson(generationProvenance(value)) });
    assert.equal((await adoptPolicyCard(w.client, await exportPolicyCard(w.client, w.subject))).digest, original.digest);
  }
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
  assert.deepEqual((await exportPolicyCard(w.client, "rl-limits")).resource_limits, {});
  await generation(w.client, spec({ policy_evaluation: null }), "rl-invalid-evaluation");
  await assert.rejects(exportPolicyCard(w.client, "rl-invalid-evaluation"), refused("card_invalid"));
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
  const runs = Array.from({ length: 30 }, (_, i) => `rl-run-${i}-${"r".repeat(30)}`);
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
      /** Obstruct the real promoted-card create after the atomic promotion commits. */
      override async create(options: Parameters<PmClient["create"]>[0]): ReturnType<PmClient["create"]> {
        if (options?.id?.startsWith("policy-card-") && this.repair === null && options.body !== undefined && (JSON.parse(options.body) as PolicyCard).outcome === "promoted") {
          const card = JSON.parse(options.body) as PolicyCard;
          const cardId = `rl-${options.id}`;
          if (fault === "storage") {
            const obstruction = join(w.pmRoot, "decisions", `${cardId}.toon`); mkdirSync(obstruction);
            this.repair = async () => { rmSync(obstruction, { recursive: true }); };
          } else {
            await super.create({ id: cardId, type: "Decision", title: "Publication obstruction", body: "{}" });
            this.repair = async () => { await super.update(cardId, { body: canonicalJson(card as unknown as JsonValue), affectedVersion: card.digest }); };
          }
        }
        return super.create(options);
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


test("replay refuses unrelated certified Decisions and foreign lineage citations without any tracker write", async () => {
  const w = await workspace(); const id = await generation(w.client);
  const card = await exportPolicyCard(w.client, id);
  const result = { budget: { tokens: 999999 } };
  await w.client.create({ id: "rl-unrelated", type: "Decision", title: "Certified unrelated result", body: JSON.stringify({ format: "pm-rl/loop-step/1", state: "complete", input: hashJson("foreign-candidate"), result, digest: hashJson(result), budget: result.budget }) });
  const unrelated = await exportPolicyCard(w.client, "rl-unrelated");
  const forged = rehash({ ...card, evidence: [...card.evidence, unrelated.evidence[0]], resource_limits: { ...card.resource_limits, tokens: 999999 } });
  await unchanged(w.pmRoot, () => replayPolicyCard(w.client, forged), "card_invalid");
  // A derived name alone cannot make an evaluation result belong to an unplanned generation.
  await w.client.create({ id: `${id}-evaluation-plan-result`, type: "Decision", title: "Foreign result", body: String((await w.client.get("rl-unrelated")).item.body) });
  const foreign = await exportPolicyCard(w.client, `${id}-evaluation-plan-result`);
  await unchanged(w.pmRoot, () => replayPolicyCard(w.client, rehash({ ...card, evidence: [...card.evidence, foreign.evidence[0]], resource_limits: { ...card.resource_limits, tokens: 999999 } })), "card_invalid");
  assert.deepEqual((await replayPolicyCard(w.client, card)).card, card);
  await unchanged(w.pmRoot, () => replayPolicyCard(w.client, rehash({ ...card, policy_digest: hashJson("another-policy") })), "card_drift");
});

test("registration refuses every card limit before generation, history or card writes", async () => {
  const w = await workspace();
  const harness = await createExtensionTestHarness(extension, { name: "pm-rl", capabilities: ["commands", "schema", "hooks"] });
  const envFile = join(w.root, "env.json");
  writeFileSync(envFile, JSON.stringify({ name: "bounded", version: "1", task_suite: ["task"], reward_specification: { goal: 1 } }));
  const env = ((await harness.runCommand({ command: "rl env register", pmRoot: w.pmRoot, args: [], options: { file: envFile } })).result as RlCommandResult).id!;
  await harness.runCommand({ command: "rl generation register", pmRoot: w.pmRoot, args: ["rl-seed"], options: { baseCheckpoint: "checkpoint" } });
  const runs = Array.from({ length: 32 }, (_, index) => `rl-run-${index}-${"r".repeat(110)}`);
  for (const id of runs) await w.client.create({ id, type: "Run", title: "Collection", environment: env });
  for (const count of [32, 18]) {
    const options = { baseCheckpoint: "checkpoint", policy: "policy", parent: "rl-seed", environment: env, collectionRuns: runs.slice(0, count).join(",") };
    for (let attempt = 0; attempt < 2; attempt += 1) await unchanged(w.pmRoot, () => harness.runCommand({ command: "rl generation register", pmRoot: w.pmRoot, args: [`rl-oversized-${count}`], options }), "card_limit");
  }
  const valid = (await harness.runCommand({ command: "rl generation register", pmRoot: w.pmRoot, args: ["rl-bounded"], options: { baseCheckpoint: "checkpoint", policy: "policy", parent: "rl-seed", environment: env, collectionRuns: runs[0] } })).result as RlCommandResult;
  assert.equal((await exportPolicyCard(w.client, valid.id!)).evidence.length, 4);
});

test("recursive card batch refuses collision before publishing any card", async () => {
  const w = await workspace();
  const result = { configs: [{ samples: 1 }, { samples: 2 }] };
  await w.client.create({ id: "rl-batch", type: "Decision", title: "Batch", body: JSON.stringify({ format: "pm-rl/loop-step/1", state: "complete", input: hashJson("batch"), result, digest: hashJson(result) }) });
  const card = await exportPolicyCard(w.client, "rl-batch", 1);
  await w.client.create({ id: `policy-card-${card.digest}`, type: "Decision", title: "Collision", body: "{}" });
  for (const update of [{ body: "{}" }, { body: canonicalJson(card as unknown as JsonValue), type: "Task" }, { type: "Decision", affectedVersion: "different" }]) {
    await w.client.update(`policy-card-${card.digest}`, update);
    await unchanged(w.pmRoot, () => recordRecursivePolicyCards(w.client, "rl-batch"), "card_drift");
  }
  await generation(w.client, spec({ collection_runs: Array.from({ length: 32 }, (_, index) => `rl-missing-${index}`) }), "rl-large");
  await unchanged(w.pmRoot, () => recordPolicyCard(w.client, "rl-large"), "card_limit");
});

test("recursive receipt card limits refuse before receipt and history writes", async () => {
  const w = await workspace();
  await w.client.create({ id: "rl-approval", type: "Decision", title: "Consent" });
  await withRlController(w.client, { pmRoot: w.pmRoot, author: "card-test" }, { id: "limits", approval: "rl-approval", recoveryCommand: "resume programme" }, AbortSignal.timeout(60000), async (step) => {
    await step("programme", {}, async () => ({ config: { samples: 1 } }));
    await unchanged(w.pmRoot, () => step("proposals", {}, async () => ({ configs: Array(33).fill({ samples: 1 }), checkpoint: prefixCheckpoint(Array<number>(16).fill(0), { regularisation: 0.1, ngram_order: 1, hashing_width: 16 }) as unknown as JsonValue })), "card_limit");
    assert.deepEqual(await step("proposals", {}, async () => ({ configs: [{ samples: 1 }] })), { configs: [{ samples: 1 }] });
  });
});

test("sealed rejection outcomes retain one immutable card and retry without tracker writes", async () => {
  const w = await workspace(); await generation(w.client);
  await w.client.create({ id: "rl-env", type: "Environment", title: "Environment" });
  await w.client.create({ id: "rl-run", type: "Run", title: "Collection" });
  const candidate = spec({ seed: false, policy: "candidate", parent: "rl-seed", collection_runs: ["rl-run"], environment_version: "rl-env", reward_spec_version: "reward" });
  const id = await generation(w.client, candidate, "rl-rejection");
  await recordRefusedPolicyCard(w.client, id, "Policy gate refused");
  const card = await exportPolicyCard(w.client, id);
  assert.equal(card.outcome, "refused");
  assert.deepEqual(card.known_regressions, ["promotion_refused"]);
  assert.equal(card.evaluation.reason_digest, hashJson("Policy gate refused"));
  assert.equal((await w.client.get(id)).item.affected_version, hashJson(generationProvenance(candidate)));
  const before = trackerBytes(w.pmRoot);
  await recordRefusedPolicyCard(w.client, id, "Policy gate refused");
  assert.deepEqual(trackerBytes(w.pmRoot), before, "retry must not append another policy event or card");
  assert.equal((await replayPolicyCard(w.client, card)).card.digest, card.digest);
});

test("prospective rejection notes and oversized proposed sources refuse without history writes", async () => {
  const w = await workspace();
  await generation(w.client, spec({ collection_runs: Array.from({ length: 32 }, (_, index) => `rl-missing-${index}`) }));
  await unchanged(w.pmRoot, () => recordRefusedPolicyCard(w.client, "rl-seed", "Rejected"), "card_limit");
  await unchanged(w.pmRoot, () => validatePolicyCardWrite(w.client, { id: "rl-empty-source", type: "Decision" }), "card_invalid");
  await unchanged(w.pmRoot, () => validatePolicyCardWrite(w.client, { id: "rl-unsupported-source", type: "Run" }), "card_invalid");
  const result = { configs: Array(33).fill({ samples: 1 }) };
  await unchanged(w.pmRoot, () => validatePolicyCardWrite(w.client, { id: "rl-unwritten", type: "Decision", title: "Proposals", body: JSON.stringify({ format: "pm-rl/loop-step/1", state: "complete", input: hashJson("proposals"), result, digest: hashJson(result) }) }, true), "card_limit");
});


test("one generation evidence set binds card identity and normal resume for every evidence mutation", { timeout: 600_000 }, async () => {
  const w = await workspace();
  await w.client.create({ id: "rl-approval", type: "Decision", title: "Consent", body: '```json\n{"permitted_promotions":1}\n```' });
  const config = { ...JSON.parse(readFileSync(new URL("../examples/loop-bandit.json", import.meta.url), "utf8")) as Record<string, JsonValue>, max_generations: 1 };
  const request = { id: "evidence", config, approval: "rl-approval" };
  const coordinates = { pmRoot: w.pmRoot, author: "card-test" };
  const report = await runRlLoop(w.client, coordinates, request);
  const row = report.generations[0]; const original = await exportPolicyCard(w.client, row.item);
  const baseline = hashJson((await generationEvidence(w.client, row.item)).evidence as unknown as JsonValue);
  const mutations: { id: string; options: Parameters<PmClient["update"]>[1]; changes: boolean }[] = [];
  for (const ref of original.evidence) {
    const item = (await readCompleteLoopItem(w.client, ref.id)).item;
    mutations.push({ id: ref.id, options: { title: "Routine annotation", comment: ["Routine comment"], note: ["Routine private note"], addTags: ["bookkeeping"] }, changes: false });
    mutations.push({ id: ref.id, options: { type: "Task" }, changes: true });
    mutations.push({ id: ref.id, options: { status: "in_progress" }, changes: false });
    mutations.push({ id: ref.id, options: { affectedVersion: "changed-version" }, changes: true });
    if (item.type === "Generation") {
      const value = extractGenerationSpec(String(item.body), "Fixture");
      const changed = { ...value, training_config: { ...value.training_config as Record<string, JsonValue>, samples: 20 } };
      if (value.approval !== null) for (const approval of [value.approval.toUpperCase(), value.approval.replace(/^rl-/, "")]) mutations.push({ id: ref.id, options: { body: `\`\`\`json\n${JSON.stringify({ ...value, approval })}\n\`\`\`` }, changes: false });
      mutations.push({ id: ref.id, options: { note: [encodeEvent({ step: 1, metric: "unrelated", value: 1 })] }, changes: false });
      mutations.push({ id: ref.id, options: { body: `\`\`\`json\n${JSON.stringify(changed)}\n\`\`\``, affectedVersion: hashJson(generationProvenance(changed)) }, changes: true });
    } else mutations.push({ id: ref.id, options: { body: String(item.body) + "\nChanged evidence." }, changes: true });
    if (item.type === "Run") {
      for (const options of [{ component: "peer-policy" }, { environment: "peer-environment" }, { note: [encodeEvent({ step: 999, metric: "return", value: 1 })] }, { note: encodeEventSegments([{ step: 1000, metric: "return", value: 2 }]) }]) mutations.push({ id: ref.id, options, changes: true });
      mutations.push({ id: ref.id, options: { fixedVersion: "routine-version" }, changes: false });
    }
  }
  for (const mutation of mutations) {
    const before = (await w.client.get(mutation.id, { fields: "type,status,body,affected_version,component,environment,notes,fixed_version" })).item;
    await w.client.update(mutation.id, mutation.options);
    const probe = async () => hashJson((await generationEvidence(w.client, row.item)).evidence as unknown as JsonValue);
    if (mutation.changes) {
      await assert.rejects(verifyRetainedGenerationEvidence(w.client, row.item), (error: unknown) => error instanceof Error, JSON.stringify(mutation));
      await assert.rejects(resumeRlLoop(w.client, coordinates, { id: request.id, approval: request.approval }));
      const fresh = await exportPolicyCard(w.client, row.item).catch(() => null);
      assert.ok(fresh === null || fresh.digest !== original.digest, JSON.stringify(mutation));
      assert.ok(await probe().then((digest) => digest !== baseline, () => true));
    } else {
      assert.equal(await probe(), baseline, JSON.stringify(mutation));
      assert.equal((await exportPolicyCard(w.client, row.item)).digest, original.digest);
      assert.equal((await resumeRlLoop(w.client, coordinates, { id: request.id, approval: request.approval })).promoted, 1);
    }
    const live = await w.client.get(mutation.id);
    await w.client.update(mutation.id, { message: "Restore fixture state", type: before.type, ...(live.item.status === before.status ? {} : { status: String(before.status) }), body: String(before.body), affectedVersion: String(before.affected_version), component: String(before.component), environment: String(before.environment), fixedVersion: String(before.fixed_version), clearNotes: true });
    for (const note of before.notes ?? []) await w.client.notes(mutation.id, { add: note.text });
    assert.equal((await exportPolicyCard(w.client, row.item)).digest, original.digest);
  }
});

test("rejection publication refuses a peer body written between validation and commit", async () => {
  const w = await workspace(); await generation(w.client);
  const peer = new PmClient({ pmRoot: w.pmRoot, author: "peer", noExtensions: true });
  const config = w.client.config.bind(w.client); let armed = true; let peerWritten = false;
  // Configuration resolution happens after all rejection reads, immediately before the SDK item transaction.
  w.client.config = (async (...args: Parameters<PmClient["config"]>) => {
    if (armed && !peerWritten) { armed = false; peerWritten = true; const value = spec({ training_config: { samples: 20 } }); await peer.update("rl-seed", { body: `\`\`\`json\n${JSON.stringify(value)}\n\`\`\``, affectedVersion: hashJson(generationProvenance(value)) }); }
    return config(...args);
  }) as PmClient["config"];
  // Arm only when resolving the write coordinates, rather than a projection's id-prefix read.
  let reads = 0; const get = w.client.get.bind(w.client);
  w.client.get = (async (...args: Parameters<PmClient["get"]>) => { const result = await get(...args); if (args[0] === "rl-seed") reads++; return result; }) as PmClient["get"];
  armed = false;
  const originalConfig = w.client.config.bind(w.client);
  w.client.config = (async (...args: Parameters<PmClient["config"]>) => { if (reads > 1) armed = true; return originalConfig(...args); }) as PmClient["config"];
  await assert.rejects(recordRefusedPolicyCard(w.client, "rl-seed", "Refused"), (error: unknown) => isPmCliExpectedError(error) && error.context.code === "loop_write_conflict");
  assert.equal((extractGenerationSpec(String((await peer.get("rl-seed")).item.body), "Peer").training_config as Record<string, JsonValue>).samples, 20);
  assert.equal((await peer.listAllComplete({ includeBody: false })).items.filter((item) => item.id.includes("policy-card-")).length, 0);
});

test("SDK item transactions reject peer changes even when a writer captured a valid body", async () => {
  const w = await workspace(); await generation(w.client);
  await verifyRetainedGenerationEvidence(w.client, "rl-seed");
  const before = await readCompleteLoopItem(w.client, "rl-seed");
  await w.client.update("rl-seed", { body: "peer body" });
  await assert.rejects(mutateLoopItem(w.client, before, "Guarded body", (document) => { document.body = "stale body"; return ["body"]; }), /loop_write_conflict|changed after it was read/);
  assert.equal((await w.client.get("rl-seed")).item.body, "peer body");
});


/** Interleave a real peer write at coordinate resolution after the caller has captured its revision. */
function peerAtCommit(client: PmClient, change: () => Promise<void>): void {
  const config = client.config.bind(client); let armed = true;
  client.config = (async (...args: Parameters<PmClient["config"]>) => {
    if (armed && new Error().stack?.includes("mutateLoopItem")) { armed = false; await change(); }
    return config(...args);
  }) as PmClient["config"];
}

test("every receipt write preserves a peer winner between read and publication", async (context) => {
  for (const exists of [true, false]) await context.test(exists ? "running receipt revision" : "deferred receipt creation", async () => {
    const w = await workspace(); await w.client.create({ id: "rl-approval", type: "Decision", title: "Consent" });
    const peer = new PmClient({ pmRoot: w.pmRoot, author: "peer", noExtensions: true });
    const running = JSON.stringify({ format: "pm-rl/loop-step/1", key: "receipt-step-work", input: hashJson({}), state: "running" });
    if (exists) await peer.create({ id: "receipt-step-work", type: "Decision", title: "Running", body: running });
    await assert.rejects(withRlController(w.client, { pmRoot: w.pmRoot, author: "card-test" }, { id: "receipt", approval: "rl-approval", recoveryCommand: "resume programme" }, AbortSignal.timeout(60000), async (step) => {
      await step("programme", {}, async () => ({}));
      return step("work", {}, async () => {
        if (exists) await peer.update("receipt-step-work", { body: "peer receipt" });
        else await peer.create({ id: "receipt-step-work", type: "Decision", title: "Peer", body: "peer receipt" });
        return { samples: 1 };
      });
    }));
    assert.equal((await peer.get("receipt-step-work")).item.body, "peer receipt");
  });
});

test("card creation verifies and preserves a peer collision at the native create boundary", async () => {
  const w = await workspace(); await generation(w.client);
  const peer = new PmClient({ pmRoot: w.pmRoot, author: "peer", noExtensions: true });
  const create = w.client.create.bind(w.client); let armed = true;
  w.client.create = async (options) => {
    if (armed) { armed = false; await peer.create({ id: options?.id, type: "Decision", title: "Peer", body: "peer card" }); }
    return create(options);
  };
  await assert.rejects(recordPolicyCard(w.client, "rl-seed"), refused("card_drift"));
  const card = await exportPolicyCard(w.client, "rl-seed");
  assert.equal((await peer.get(`policy-card-${card.digest}`)).item.body, "peer card");
});

test("promotion, approval budget and recovery closure refuse peer changes after their reads", { timeout: 600_000 }, async (context) => {
  for (const path of ["promotion", "budget", "recovery", "journal"] as const) await context.test(path, async () => {
    const w = await workspace(); const coordinates = { pmRoot: w.pmRoot, author: "card-test" };
    await w.client.create({ id: "rl-approval", type: "Decision", title: "Consent", body: '```json\n{"permitted_promotions":1}\n```' });
    const config = { ...JSON.parse(readFileSync(new URL("../examples/loop-bandit.json", import.meta.url), "utf8")) as Record<string, JsonValue>, max_generations: 1 };
    const report = await runRlLoop(w.client, coordinates, { id: "race", config, approval: "rl-approval" }); const row = report.generations[0];
    const current = extractGenerationSpec(String((await w.client.get(row.item)).item.body), "Promoted fixture");
    const candidate = path === "recovery" ? current : { ...current, promoted: false, approval: null, proxy_score: null, held_out_score: null, gap: null, promotion_evidence: null };
    await w.client.update(row.item, { status: "in_progress", body: `\`\`\`json\n${JSON.stringify(candidate)}\n\`\`\`` });
    const peer = new PmClient({ pmRoot: w.pmRoot, author: "peer", noExtensions: true });
    if (path !== "journal") peerAtCommit(w.client, async () => {
      if (path === "budget") await peer.update("rl-approval", { body: '```json\n{"permitted_promotions":0}\n```' });
      else await peer.update(row.item, { body: `\`\`\`json\n${JSON.stringify({ ...candidate, training_config: { ...candidate.training_config as Record<string, JsonValue>, samples: 20 } })}\n\`\`\``, affectedVersion: hashJson(generationProvenance({ ...candidate, training_config: { ...candidate.training_config as Record<string, JsonValue>, samples: 20 } })) });
    });
    const execute = path === "recovery" ? resumeRlLoop(w.client, coordinates, { id: "race", approval: "rl-approval" })
      : promoteGenerationCore(w.client, coordinates, row.item, "rl-approval", current.proxy_score!, current.held_out_score!, "Race drill", path !== "journal" ? undefined : async (event) => {
          if (event.transition === "committing") {
            const committed = extractGenerationSpec(String((await peer.get(row.item)).item.body), "Committed fixture");
            const changed = { ...committed, training_config: { samples: 20 } };
            await peer.update(row.item, { body: `\`\`\`json\n${JSON.stringify(changed)}\n\`\`\``, affectedVersion: hashJson(generationProvenance(changed)) });
            throw new Error("Journal commit failure after atomic promotion");
          }
        });
    await assert.rejects(execute, (error: unknown) => path === "journal" ? error instanceof Error && /Journal commit failure/.test(error.message) : isPmCliExpectedError(error) && error.context.code === "loop_write_conflict");
    const stored = (await peer.get(row.item)).item;
    assert.equal(stored.status, path === "journal" ? "closed" : "in_progress");
    if (path !== "budget") assert.equal((extractGenerationSpec(String(stored.body), "Peer winner").training_config as Record<string, JsonValue>).samples, 20);
    else assert.match(String((await peer.get("rl-approval")).item.body), /"permitted_promotions":0/);
  });
});

test("comment receipts use SDK lock-scoped idempotency under two writers", async () => {
  const w = await workspace(); await generation(w.client);
  const comments = w.client.comments.bind(w.client); let readers = 0; let release!: () => void;
  const barrier = new Promise<void>((resolve) => { release = resolve; });
  w.client.comments = (async (...args: Parameters<PmClient["comments"]>) => {
    const result = await comments(...args);
    if (args[1]?.add === undefined) { readers++; if (readers === 2) release(); await barrier; }
    return result;
  }) as PmClient["comments"];
  await Promise.all([appendCommentOnce(w.client, "rl-seed", "Same receipt"), appendCommentOnce(w.client, "rl-seed", "Same receipt")]);
  const result = await comments("rl-seed", { outputBudget: "unbounded", outputLimit: "unbounded" });
  assert.ok("comments" in result); assert.equal(result.comments.length, 1);
});

test("guarded SDK transactions order multiple read dependencies and release their locks after conflict", async () => {
  const w = await workspace(); await generation(w.client);
  for (const id of ["rl-guard-a", "rl-guard-b"]) await w.client.create({ id, type: "Decision", title: "Read dependency", body: "original" });
  const before = await readCompleteLoopItem(w.client, "rl-seed");
  const dependencies = await Promise.all(["rl-guard-b", "rl-guard-a"].map((id) => readCompleteLoopItem(w.client, id)));
  await w.client.update("rl-guard-b", { body: "peer evidence" });
  await assert.rejects(mutateLoopItem(w.client, before, "Guarded dependencies", () => [], dependencies), /changed after it was read/);
  const fresh = await Promise.all(["rl-guard-b", "rl-guard-a"].map((id) => readCompleteLoopItem(w.client, id)));
  await mutateLoopItem(w.client, before, "Unchanged dependencies", () => [], fresh);
  assert.equal((await w.client.get("rl-guard-b")).item.body, "peer evidence");
});

test("retained evidence cannot authorize changed seed content or a changed candidate disguised as interrupted promotion", async () => {
  const w = await ancestryFixture();
  const original = extractGenerationSpec(String((await w.client.get("rl-g2")).item.body), "Fixture");
  const candidate = { ...original, parent: "rl-g2", promoted: false, approval: null, proxy_score: null, held_out_score: null, gap: null, promotion_evidence: null };
  await generation(w.client, candidate, "rl-candidate-drift"); await recordPolicyCard(w.client, "rl-candidate-drift");
  const interrupted = { ...original, parent: "rl-g2" };
  await w.client.update("rl-candidate-drift", { body: `\`\`\`json\n${JSON.stringify(interrupted)}\n\`\`\``, affectedVersion: hashJson(generationProvenance(interrupted)) });
  const run = await w.client.get("rl-run-2");
  await w.client.update("rl-run-2", { component: "peer collection policy" });
  await assert.rejects(verifyRetainedGenerationEvidence(w.client, "rl-candidate-drift"), /Generation evidence changed/);
  await w.client.update("rl-run-2", { component: String(run.item.component) });
  await verifyRetainedGenerationEvidence(w.client, "rl-candidate-drift");
  const changed = { ...original, parent: "rl-g2", training_config: { samples: 999 } };
  await w.client.update("rl-candidate-drift", { body: `\`\`\`json\n${JSON.stringify(changed)}\n\`\`\``, affectedVersion: hashJson(generationProvenance(changed)) });
  await assert.rejects(verifyRetainedGenerationEvidence(w.client, "rl-candidate-drift"), /Generation evidence changed/);
  const seed = spec({ training_config: { samples: 999 } });
  await w.client.update("rl-g0", { body: `\`\`\`json\n${JSON.stringify(seed)}\n\`\`\``, affectedVersion: hashJson(generationProvenance(seed)) });
  await assert.rejects(verifyRetainedGenerationEvidence(w.client, "rl-g0"), /Generation evidence changed/);
});


test("resume preserves native evidence-backend errors instead of sealing a policy refusal", async () => {
  const w = await workspace(); const coordinates = { pmRoot: w.pmRoot, author: "card-test" };
  await w.client.create({ id: "rl-approval", type: "Decision", title: "Consent", body: '```json\n{"permitted_promotions":1}\n```' });
  const config = { ...JSON.parse(readFileSync(new URL("../examples/loop-bandit.json", import.meta.url), "utf8")) as Record<string, JsonValue>, max_generations: 1 };
  const report = await runRlLoop(w.client, coordinates, { id: "native-evidence", config, approval: "rl-approval" });
  const list = w.client.listAllComplete.bind(w.client); const native = new TypeError("Evidence backend unavailable");
  w.client.listAllComplete = async (options) => { await list(options); throw native; };
  await assert.rejects(resumeRlLoop(w.client, coordinates, { id: "native-evidence", approval: "rl-approval" }), (error: unknown) => error === native);
  w.client.listAllComplete = list;
  const current = extractGenerationSpec(String((await w.client.get(report.generations[0].item)).item.body), "Fixture");
  const changed = { ...current, promoted: false, approval: null, proxy_score: null, held_out_score: null, gap: null, promotion_evidence: null };
  await w.client.update(report.generations[0].item, { body: `\`\`\`json\n${JSON.stringify(changed)}\n\`\`\`` });
  await assert.rejects(resumeRlLoop(w.client, coordinates, { id: "native-evidence", approval: "rl-approval" }), (error: unknown) => isPmCliExpectedError(error) && error.context.code === "loop_step_drift");
});


test("retained generation evidence compares the whole citation set including later optional results", async () => {
  const w = await workspace(); await generation(w.client);
  await w.client.create({ id: "rl-run", type: "Run", title: "Collection" });
  await w.client.create({ id: "rl-env", type: "Environment", title: "Environment" });
  const id = "rl-plan-addition";
  const plan = { candidate: id, incumbent: "rl-seed", incumbent_version: "original" }; const comparison = hashJson(plan);
  await w.client.create({ id: `${id}-evaluation-plan`, type: "Plan", title: "Pinned plan", body: JSON.stringify({ plan, incumbent_version: "original" }), affectedVersion: hashJson({ comparison, incumbent_version: "original" }) });
  await generation(w.client, spec({ seed: false, policy: "candidate", parent: "rl-seed", collection_runs: ["rl-run"], environment_version: "rl-env", reward_spec_version: "reward", evaluation_plan: comparison }), id);
  const before = await recordPolicyCard(w.client, id);
  await w.client.create({ id: `${id}-evaluation-plan-result`, type: "Decision", title: "Later result", body: JSON.stringify({ comparison }) });
  const fresh = await exportPolicyCard(w.client, id);
  assert.equal(fresh.evidence.length, before.evidence.length + 1); assert.notEqual(fresh.digest, before.digest);
  await assert.rejects(verifyRetainedGenerationEvidence(w.client, id), /Generation evidence changed/);
  await recordPolicyCard(w.client, id);
  await verifyRetainedGenerationEvidence(w.client, id);
});
