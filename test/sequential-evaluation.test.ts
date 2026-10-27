/** Real SDK state machines, finite-look simulations and adversarial sequential evidence. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, symlinkSync, existsSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { PmClient } from "@unbrained/pm-cli/sdk/core";
import { init, isPmCliExpectedError, locateItem, readLocatedItem, readSettings, resolveItemTypeRegistry } from "@unbrained/pm-cli/sdk/runtime";
import { createExtensionTestHarness } from "@unbrained/pm-cli/sdk/testing";
import extension, { extractGenerationSpec, generationProvenance, hashJson, readCompleteLoopItem, mutateLoopItem, withPromotionEvidence, promoteGenerationCore, reconcileLoopPromotion, withProcessJobFence, type RlCommandResult, type JsonValue } from "../index.ts";
import { parseBoundedJson } from "../tracker-record.ts";
import { evaluatePlan, evaluationComparison, parseEvaluationPlan, registerEvaluationPlan, readEvaluationPlan, enforceEvaluationPlan, recordPlanEvaluation, validateEvaluationOrder, type EvaluationPlan, type EvaluationObservation, type EvaluationPlanReport, validateEvaluationReport } from "../evaluation-plan.ts";
import { evaluateSequentialBoundary, parseSequentialStopping, recordSequentialEvaluation, readSequentialEvaluation, reviewSequentialPlan, withEvaluationLease, type SequentialEvaluationResult } from "../sequential-evaluation.ts";
import type { GenerationSpec, ScoreRecord } from "../lineage.ts";

const roots: string[] = [];
after(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });

test("promotion revision guard covers arbitrary SDK projections, absent slots and every lease boundary", async () => {
  const w = await workspace();
  const peer = new PmClient({ pmRoot: w.pmRoot, cwd: w.root, author: "evidence-peer", noExtensions: true });
  await w.client.create({ id: "rl-target", title: "Unchanged target" });
  await w.client.create({ id: "rl-reference", title: "Reference" });
  const patches: Parameters<PmClient["update"]>[1][] = [
    { body: "Changed body" }, { affectedVersion: "Changed seal" }, { title: "Changed title" },
    { parent: "rl-reference" }, { blockedBy: "rl-reference" }, { tags: "changed" }, { status: "in_progress" },
  ];
  for (let index = 0; index < patches.length; index += 1) {
    const id = `rl-evidence-${index}`; await w.client.create({ id, title: "Evidence", type: "Decision", body: "Original" });
    const before = await readCompleteLoopItem(w.client, "rl-target");
    await assert.rejects(withPromotionEvidence(w.client, async () => {
      await readCompleteLoopItem(w.client, id); await readCompleteLoopItem(w.client, id); // identical reads deduplicate
      await readCompleteLoopItem(w.client, id, "1"); // history is never a current revision
      await peer.update(id, patches[index]);
      return mutateLoopItem(w.client, before, "Guarded write", (document) => { document.body = "Unsafe"; return ["body"]; });
    }), (error: unknown) => isPmCliExpectedError(error) && error.context.code === "loop_write_conflict");
    assert.deepEqual((await readCompleteLoopItem(w.client, "rl-target")).item, before.item);
    await peer.update(id, { title: "Lease released" });
  }
  // Even a missing future look is a dependency: it cannot appear after validation.
  const before = await readCompleteLoopItem(w.client, "rl-target");
  await assert.rejects(withPromotionEvidence(w.client, async () => {
    await assert.rejects(readCompleteLoopItem(w.client, "FuTuRe"));
    await peer.create({ id: "future", title: "Competing checkpoint" });
    return mutateLoopItem(w.client, before, "Guarded write", () => []);
  }), (error: unknown) => isPmCliExpectedError(error) && error.context.code === "loop_write_conflict");
  await w.client.create({ id: "rl-leased", title: "Evidence", affectedVersion: "Original" });
  const get = w.client.get.bind(w.client); let guarded = false; let boundaries = 0;
  w.client.get = (async (...args) => {
    const result = await get(...args);
    if (guarded && args[0] === "rl-leased") {
      boundaries += 1;
      const wait = process.env.PM_LOCK_WAIT_MS; process.env.PM_LOCK_WAIT_MS = "0";
      try { await assert.rejects(peer.update("rl-leased", { affectedVersion: "Peer edit" }), (error: unknown) => isPmCliExpectedError(error) && error.context.code === "lock_conflict"); }
      finally { if (wait === undefined) delete process.env.PM_LOCK_WAIT_MS; else process.env.PM_LOCK_WAIT_MS = wait; }
    }
    return result;
  }) as PmClient["get"];
  await withPromotionEvidence(w.client, async () => {
    await readCompleteLoopItem(w.client, "rl-leased", undefined, "id,affected_version");
    await assert.rejects(readCompleteLoopItem(w.client, "rl-still-absent"));
    guarded = true;
    return mutateLoopItem(w.client, before, "Guarded write", (document) => { document.body = "Safe"; return ["body"]; });
  });
  guarded = false; assert.equal(boundaries, 1);
  await peer.update("rl-leased", { affectedVersion: "Released" });
  assert.equal((await readCompleteLoopItem(w.client, "rl-target")).item.body, "Safe");
  const safe = await readCompleteLoopItem(w.client, "rl-target");
  await assert.rejects(withPromotionEvidence(w.client, async () => {
    await readCompleteLoopItem(w.client, "rl-leased", undefined, "id,notes");
    await peer.notes("rl-leased", { add: "A new native metric note" });
    return mutateLoopItem(w.client, safe, "Projected evidence", () => []);
  }), (error: unknown) => isPmCliExpectedError(error) && error.context.code === "loop_write_conflict");
  let validation = false;
  Object.assign(w.client, { get: (async (...args) => {
    if (validation && args[0] === "rl-leased") throw Object.assign(new Error("Evidence backend failed"), { code: "EIO" });
    return get(...args);
  }) as PmClient["get"] });
  await assert.rejects(withPromotionEvidence(w.client, async () => {
    await readCompleteLoopItem(w.client, "rl-leased"); validation = true;
    return mutateLoopItem(w.client, safe, "Unavailable evidence", () => []);
  }), (error: unknown) => isPmCliExpectedError(error) && error.context.code === "provenance_read_retryable");
  validation = false; Object.assign(w.client, { get });
  assert.deepEqual((await readCompleteLoopItem(w.client, "rl-target")).item, safe.item);
  await peer.update("rl-leased", { title: "Released after backend failure" });
});

test("every promotion guard SDK boundary permits only a current decision or a typed refusal", async () => {
  const w = await workspace(); const peer = new PmClient({ pmRoot: w.pmRoot, cwd: w.root, author: "interleaving-peer", noExtensions: true });
  await w.client.create({ id: "rl-write-target", title: "Target" });
  const get = w.client.get.bind(w.client); const config = w.client.config.bind(w.client);
  let boundaries = 0;
  for (let injectAt = -1; injectAt < boundaries; injectAt += 1) {
    const id = `rl-race-${injectAt + 1}`; await w.client.create({ id, type: "Decision", title: "Evidence", affectedVersion: "original" });
    const before = await readCompleteLoopItem(w.client, "rl-write-target"); let step = 0; let injected = false; let decision = "";
    /** Compete using native SDK writes at every before/after SDK operation boundary. */
    async function boundary(): Promise<void> {
      if (step++ !== injectAt) return;
      injected = true; const wait = process.env.PM_LOCK_WAIT_MS; process.env.PM_LOCK_WAIT_MS = "0";
      try { await peer.update(id, { affectedVersion: "peer" }); }
      catch (error) { assert.ok(isPmCliExpectedError(error) && error.context.code === "lock_conflict"); }
      finally { if (wait === undefined) delete process.env.PM_LOCK_WAIT_MS; else process.env.PM_LOCK_WAIT_MS = wait; }
    }
    Object.assign(w.client, {
      get: (async (...args) => { await boundary(); const value = await get(...args); await boundary(); return value; }) as PmClient["get"],
      config: (async (...args) => { await boundary(); const value = await config(...args); await boundary(); return value; }) as PmClient["config"],
    });
    try {
      const outcome = await withPromotionEvidence(w.client, async () => {
        decision = String((await readCompleteLoopItem(w.client, id)).item.affected_version);
        return mutateLoopItem(w.client, before, "Guarded decision", (document) => { document.body = id; return ["body"]; });
      }).then(() => "applied", (error: unknown) => { assert.ok(isPmCliExpectedError(error) && error.context.code === "loop_write_conflict"); return "refused"; });
      if (injectAt === -1) boundaries = step;
      else assert.ok(injected, `boundary ${injectAt}`);
      if (outcome === "applied") {
        assert.equal((await readCompleteLoopItem(peer, id)).item.affected_version, decision);
        assert.equal((await readCompleteLoopItem(peer, "rl-write-target")).item.body, id);
      } else assert.deepEqual((await readCompleteLoopItem(peer, "rl-write-target")).item, before.item);
      await peer.update(id, { title: "All leases released" });
    } finally { Object.assign(w.client, { get, config }); }
  }
  assert.ok(boundaries > 0); console.log(JSON.stringify({ promotionGuardSdkBoundaries: boundaries }));
});

test("promotion holds final checkpoints through the generation write and never spends stale approval", async () => {
  const base = await workspace();
  await base.client.schemaAddType("Environment", { folder: "environments", defaultStatus: "open" });
  await base.client.create({ id: "training", type: "Environment", title: "Training environment" });
  const p = await prepared(base.client);
  await base.client.update(`${p.candidate}-run`, { environment: "training" });
  await base.client.create({ id: "rl-approval", type: "Decision", title: "One promotion", body: '```json\n{"permitted_promotions":1}\n```' });
  await recordSequentialEvaluation(base.client, p.candidate, observations(p));
  const final = report(await recordSequentialEvaluation(base.client, p.candidate, observations(p, 64, true)));
  const checkpoint = `${p.candidate}-evaluation-plan-look-2`;
  const score: ScoreRecord = { objective: p.objective, objective_version: p.objective_version, evaluation_context: p.evaluation_context, direction: p.direction, seed_set: evaluationComparison(p), scale: 1, value: final.candidate_mean };
  for (const mode of ["after-validation", "while-leased", "cli", "recovery", "missing-score", "manual-recovery", "completed-recovery", "manual-race", "manual-while-leased", "manual-withdrawn", "completed-while-leased", "recovery-while-leased"] as const) {
    const root = mkdtempSync(join(tmpdir(), "rl-promotion-proof-")); roots.push(root); cpSync(base.root, root, { recursive: true });
    const pmRoot = join(root, ".agents/pm");
    const client = new PmClient({ pmRoot, cwd: root, author: "promotion-test", noExtensions: true });
    const peer = new PmClient({ pmRoot, cwd: root, author: "peer", noExtensions: true });
    const manual = ["manual-recovery", "manual-race", "manual-while-leased", "manual-withdrawn"].includes(mode);
    const recovering = mode === "recovery" || mode === "missing-score" || manual || mode === "completed-recovery" || mode === "completed-while-leased" || mode === "recovery-while-leased";
    const leased = ["while-leased", "manual-while-leased", "completed-while-leased", "recovery-while-leased"].includes(mode);
    if (recovering) {
      await promoteGenerationCore(client, { pmRoot, author: "promotion-test" }, p.candidate, "rl-approval", { ...score, evaluation_context: "proxy" }, score, "Reviewed evaluation");
      if (!manual && mode !== "completed-recovery" && mode !== "completed-while-leased") await peer.update(p.candidate, { status: "in_progress" });
      if (mode === "missing-score") {
        const current = extractGenerationSpec(String((await readCompleteLoopItem(peer, p.candidate)).item.body), "Incomplete promotion");
        await peer.update(p.candidate, { body: `\`\`\`json\n${JSON.stringify({ ...current, held_out_score: null })}\n\`\`\`` });
      }
    }
    const before = await readCompleteLoopItem(peer, p.candidate);
    let expected = before;
    const get = client.get.bind(client); let sawFinal = false; let injected = false;
    if (mode === "manual-recovery" || mode === "completed-recovery") { await peer.update(checkpoint, { affectedVersion: "Corrupted before publication repair" }); injected = true; }
    Object.assign(client, { get: (async (...args) => {
      const result = await get(...args);
      if (mode === "manual-withdrawn" && !injected && args[0] === p.candidate) {
        injected = true;
        const withdrawn = { ...extractGenerationSpec(String(before.item.body), "Withdrawn promotion"), promoted: false, approval: null, proxy_score: null, held_out_score: null, gap: null, promotion_evidence: null };
        await peer.update(p.candidate, { body: `\`\`\`json\n${JSON.stringify(withdrawn)}\n\`\`\`` });
        expected = await readCompleteLoopItem(peer, p.candidate);
      }
      if (args[0] === checkpoint && args[1]?.at === undefined) sawFinal = true;
      const locked = existsSync(join(pmRoot, "locks", `${checkpoint}.lock`));
      if (!injected && (leased ? args[0] === checkpoint && locked : sawFinal && args[0] === "rl-approval")) {
        injected = true;
        const wait = process.env.PM_LOCK_WAIT_MS; process.env.PM_LOCK_WAIT_MS = "0";
        try {
          const edit = peer.update(checkpoint, { affectedVersion: "Raced final seal" });
          if (leased) await assert.rejects(edit, (error: unknown) => isPmCliExpectedError(error) && error.context.code === "lock_conflict");
          else await edit;
        } finally { if (wait === undefined) delete process.env.PM_LOCK_WAIT_MS; else process.env.PM_LOCK_WAIT_MS = wait; }
      }
      return result;
    }) as PmClient["get"] });
    /** Exercise the public command and the core shared by every recursive controller. */
    async function promote(): Promise<unknown> {
      if (mode === "recovery" || mode === "missing-score" || mode === "completed-recovery" || mode === "completed-while-leased" || mode === "recovery-while-leased") return reconcileLoopPromotion(client, { author: "promotion-test", guard: (operation) => withProcessJobFence({ pmRoot, author: "promotion-test" }, "recovery-proof", operation) }, p.candidate);
      if (mode !== "cli" && !manual) return promoteGenerationCore(client, { pmRoot, author: "promotion-test" }, p.candidate, "rl-approval", { ...score, evaluation_context: "proxy" }, score, "Reviewed evaluation");
      const harness = await createExtensionTestHarness(extension, { name: "pm-rl", capabilities: ["commands", "hooks", "schema"] });
      type HostSdk = NonNullable<Parameters<typeof harness.runCommand>[0]["sdk"]>;
      const scores = join(root, "scores.json"); writeFileSync(scores, JSON.stringify({ proxy_score: { ...score, evaluation_context: "proxy" }, held_out_score: score }));
      return harness.runCommand({ command: "rl generation promote", pmRoot, args: [p.candidate], options: { approval: "rl-approval", scores, evidence: "Reviewed evaluation" }, sdk: { client } as unknown as HostSdk });
    }
    if (leased) await promote();
    else await assert.rejects(promote(), (error: unknown) => isPmCliExpectedError(error) && error.context.code === (mode === "missing-score" ? "promoted_missing_evidence" : mode === "manual-recovery" || mode === "completed-recovery" ? "eval_plan_drift" : "loop_write_conflict"), mode);
    if (mode !== "missing-score") assert.ok(injected, mode);
    if (mode === "missing-score") {
      assert.deepEqual((await readCompleteLoopItem(peer, p.candidate)).item, before.item);
      continue;
    }
    if (mode === "manual-withdrawn") { assert.deepEqual((await readCompleteLoopItem(peer, p.candidate)).item, expected.item); continue; }
    const live = extractGenerationSpec(String((await readCompleteLoopItem(peer, p.candidate)).item.body), "SDK promotion readback");
    assert.equal(live.promoted, mode === "while-leased" || recovering); assert.equal(live.approval, mode === "while-leased" || recovering ? "rl-approval" : null);
    if (mode !== "while-leased" && mode !== "recovery-while-leased") assert.deepEqual((await readCompleteLoopItem(peer, p.candidate)).item, before.item);
    await peer.update(checkpoint, { title: "Lease released after the terminal decision" });
  }
});

test("SDK-sealed plans require review before declaration before every collection and candidate", async () => {
  const w = await workspace();
  const harness = await createExtensionTestHarness(extension, { name: "pm-rl", capabilities: ["commands", "hooks", "schema"] });
  /** Enumerate the complete creation-order model, independent of package validation. */
  function permutations(values: readonly string[]): string[][] { return values.length === 0 ? [[]] : values.flatMap((value) => permutations(values.filter((entry) => entry !== value)).map((rest) => [value, ...rest])); }
  let allowed = 0; let refused = 0;
  for (const [index, order] of permutations(["review", "plan", "run", "candidate"]).entries()) {
    const p = plan(`rl-order-${index}`); if (p.stopping.kind !== "sequential") throw new Error("fixture");
    const comparison = evaluationComparison(p); const id = `${p.candidate}-evaluation-plan`; const run = `${p.candidate}-run`;
    for (const action of order) {
      if (action === "review") await w.client.create({ id: p.stopping.review, type: "Decision", title: "Review", body: JSON.stringify({ format: "pm-rl/sequential-review/1", comparison }) });
      if (action === "plan") await w.client.create({ id, type: "Plan", title: "SDK sealed plan", body: JSON.stringify({ plan: p, incumbent_version: p.incumbent_version }), affectedVersion: hashJson({ comparison, incumbent_version: p.incumbent_version }) });
      if (action === "run") await w.client.create({ id: run, type: "Run", title: "Collection" });
      if (action === "candidate") await generation(w.client, p.candidate, { ...spec("rl-seed", comparison), collection_runs: [run] });
    }
    // Correct SDK seals alone must not confer legitimacy on post-data review.
    let previous: string | null = null;
    for (const look of [16, 64]) {
      const body = { format: "pm-rl/sequential-checkpoint/1", comparison, previous, observations: observations(p, look, true) };
      const digest = hashJson(body as unknown as JsonValue); const slot = look === 16 ? 1 : 2;
      await w.client.create({ id: `${id}-look-${slot}`, type: "Decision", title: "SDK checkpoint", tags: "pm-rl:sequential-checkpoint", body: JSON.stringify(body), affectedVersion: digest });
      previous = digest;
    }
    const score: ScoreRecord = { objective: p.objective, objective_version: p.objective_version, evaluation_context: p.evaluation_context, direction: p.direction, seed_set: comparison, scale: 1, value: evaluatePlan(p, observations(p, 64, true)).candidate_mean };
    const valid = order.indexOf("review") < order.indexOf("plan") && order.indexOf("plan") < order.indexOf("run") && order.indexOf("plan") < order.indexOf("candidate");
    const operations = [() => enforceEvaluationPlan(w.client, p.candidate, score), () => readSequentialEvaluation(w.client, p.candidate), () => harness.runCommand({ command: "rl eval plan resume", pmRoot: w.pmRoot, args: [p.candidate] })];
    for (const operation of operations) if (valid) await operation(); else await assert.rejects(operation(), refusal("eval_plan_late"));
    if (valid) allowed += 1; else refused += 1;
  }
  assert.equal(allowed, 2); assert.equal(refused, 22);
  console.log(JSON.stringify({ chronologicalOrders: 24, validOrders: allowed, refusedOrders: refused, surfaces: 3 }));
});

test("every artifact-pair inversion and checkpoints sealed before the reviewed Plan refuse through SDK and CLI", async () => {
  const w = await workspace();
  const harness = await createExtensionTestHarness(extension, { name: "pm-rl", capabilities: ["commands", "hooks", "schema"] });
  const baseline = ["review", "plan", "run", "candidate", "look-1", "look-2"];
  const orders = [baseline, ["look-1", "look-2", "review", "plan", "run", "candidate"]];
  for (let left = 0; left < baseline.length; left += 1) for (let right = left + 1; right < baseline.length; right += 1) {
    const order = [...baseline]; [order[left], order[right]] = [order[right], order[left]]; orders.push(order);
  }
  let refused = 0; let allowed = 0;
  for (const [index, order] of orders.entries()) {
    const p = plan(`rl-artifact-order-${index}`); if (p.stopping.kind !== "sequential") throw new Error("fixture");
    const comparison = evaluationComparison(p); const id = `${p.candidate}-evaluation-plan`; const run = `${p.candidate}-run`;
    const first = { format: "pm-rl/sequential-checkpoint/1", comparison, previous: null, observations: observations(p) };
    const final = { format: "pm-rl/sequential-checkpoint/1", comparison, previous: hashJson(first as unknown as JsonValue), observations: observations(p, 64, true) };
    for (const action of order) {
      if (action === "review") await w.client.create({ id: p.stopping.review, type: "Decision", title: "Review", body: JSON.stringify({ format: "pm-rl/sequential-review/1", comparison }) });
      if (action === "plan") await w.client.create({ id, type: "Plan", title: "SDK declaration", body: JSON.stringify({ plan: p, incumbent_version: p.incumbent_version }), affectedVersion: hashJson({ comparison, incumbent_version: p.incumbent_version }) });
      if (action === "run") await w.client.create({ id: run, type: "Run", title: "Collection" });
      if (action === "candidate") await generation(w.client, p.candidate, { ...spec("rl-seed", comparison), collection_runs: [run] });
      if (action.startsWith("look-")) { const raw = action === "look-1" ? first : final; await w.client.create({ id: `${id}-${action}`, type: "Decision", title: "SDK sealed look", tags: "pm-rl:sequential-checkpoint", body: JSON.stringify(raw), affectedVersion: hashJson(raw as unknown as JsonValue) }); }
    }
    const valid = order.indexOf("review") < order.indexOf("plan") && Math.max(order.indexOf("plan"), order.indexOf("run"), order.indexOf("candidate")) < order.indexOf("look-1") && order.indexOf("plan") < Math.min(order.indexOf("run"), order.indexOf("candidate")) && order.indexOf("look-1") < order.indexOf("look-2");
    const score: ScoreRecord = { objective: p.objective, objective_version: p.objective_version, evaluation_context: p.evaluation_context, direction: p.direction, seed_set: comparison, scale: 1, value: evaluatePlan(p, final.observations).candidate_mean };
    const operations = [() => enforceEvaluationPlan(w.client, p.candidate, score), () => readSequentialEvaluation(w.client, p.candidate), ...[false, true].map((json) => () => harness.runCommand({ command: "rl eval plan resume", pmRoot: w.pmRoot, args: [p.candidate], options: { json } }))];
    for (const operation of operations) if (valid) await operation(); else await assert.rejects(operation(), refusal("eval_plan_late"));
    if (valid) allowed += 1; else refused += 1;
  }
  assert.equal(allowed, 2); assert.equal(refused, 15);
  console.log(JSON.stringify({ artifactPairs: 15, orders: orders.length, valid: allowed, refused, surfaces: 4, prePlanLooksFixedCase: true }));
});

test("chronology consumes every SDK history page without imposing a 1000-artifact truncation", async () => {
  const w = await workspace(); const p = await prepared(w.client); if (p.stopping.kind !== "sequential") throw new Error("fixture");
  const artifacts = [{ id: p.stopping.review, stage: 0 }, { id: `${p.candidate}-evaluation-plan`, stage: 1 }, { id: `${p.candidate}-run`, stage: 2 }, { id: p.candidate, stage: 2 }];
  await validateEvaluationOrder(w.client, artifacts, 1);
  await validateEvaluationOrder(w.client, artifacts, 2);
  await assert.rejects(validateEvaluationOrder(w.client, artifacts.map((entry) => ({ ...entry, stage: 3 - entry.stage })), 1), refusal("eval_plan_late"));
});

test("fixed and sequential provenance resolve SDK aliases after checking the original raw seal", async () => {
  for (const kind of ["fixed", "sequential"] as const) {
    const w = await workspace(); const declared = plan(`rl-alias-${kind}`);
    const p: EvaluationPlan = kind === "fixed" ? { ...declared, stopping: { kind, observations: 64, independent_units: 64 } } : declared;
    if (p.stopping.kind === "sequential") await w.client.create({ id: p.stopping.review, type: "Decision", title: "Review", body: JSON.stringify({ format: "pm-rl/sequential-review/1", comparison: evaluationComparison(p) }) });
    await registerEvaluationPlan(w.client, p);
    const run = `${p.candidate}-run`; await w.client.create({ id: run, type: "Run", title: "Collection" });
    const raw = { ...spec("RL-SEED", evaluationComparison(p)), collection_runs: [run.toUpperCase()] };
    await generation(w.client, p.candidate, raw);
    const original = await readCompleteLoopItem(w.client, p.candidate);
    // Use native SDK readback as the identity oracle; the package must preserve its raw historical hash.
    assert.equal((await readCompleteLoopItem(w.client, raw.parent!)).item.id, p.incumbent);
    assert.equal((await readCompleteLoopItem(w.client, raw.collection_runs[0])).item.id, run);
    const rows = observations(p, 64, true);
    let result: EvaluationPlanReport;
    if (kind === "fixed") result = await recordPlanEvaluation(w.client, p.candidate, rows);
    else { await recordSequentialEvaluation(w.client, p.candidate, observations(p)); result = report(await recordSequentialEvaluation(w.client, p.candidate, rows)); }
    await enforceEvaluationPlan(w.client, p.candidate, { objective: p.objective, objective_version: p.objective_version, evaluation_context: p.evaluation_context, direction: p.direction, seed_set: evaluationComparison(p), scale: 1, value: result.candidate_mean });
    assert.deepEqual((await readCompleteLoopItem(w.client, p.candidate)).item, original.item);
  }
});
/** A deterministic independent generator for reproducible model and simulation traces. */
function random(seed: number): () => number { let state = seed; return () => { state = (Math.imul(1664525, state) + 1013904223) >>> 0; return state / 2 ** 32; }; }
/** Fixed provenance independent of evaluation outcomes. */
function spec(parent: string | null = null, comparison?: string): GenerationSpec {
  return { base_checkpoint: "checkpoint", policy: parent === null ? "" : "policy", collection_runs: parent === null ? [] : ["rl-collection"], training_config: {}, environment_version: parent === null ? "" : "training", reward_spec_version: parent === null ? "" : "v1", parent, seed: parent === null, promoted: false, approval: null, proxy_score: null, held_out_score: null, gap: null, promotion_evidence: null, ...(comparison === undefined ? {} : { evaluation_plan: comparison }) };
}
/** A frozen 64-unit, two-look plan with reviewed order, including unequal cluster sizes. */
function plan(candidate = "rl-candidate", count = 64): EvaluationPlan {
  const members = Array.from({ length: count }, (_, index) => ({ id: `m${String(index).padStart(3, "0")}`, unit: `u${index}` }));
  return { format: "pm-rl/evaluation-plan/1", candidate, incumbent: "rl-seed", incumbent_version: hashJson(generationProvenance(spec())), population: "Frozen benchmark", selection: "all members", correlation_unit: "independent session", members, objective: "reward", objective_version: "v1", evaluation_context: "held-out", direction: "maximize", reward_bounds: [0, 1], criterion: { confidence: 0.95, minSamples: 8, effectThreshold: 0 }, stopping: { kind: "sequential", method: "hoeffding-alpha-spending/1", observations: count, independent_units: count, unit_order: members.map((m) => m.unit), looks: [16, count], review: `${candidate}-review` } };
}
/** Cumulative independent paired outcomes; initial ties permit a second look. */
function observations(p: EvaluationPlan, count = 16, benefit = false): EvaluationObservation[] { return p.members.slice(0, count).map((member, index) => ({ id: member.id, candidate: benefit && index >= 16 ? 1 : 0, incumbent: 0 })); }
/** Require a stable conflict code and actionable remedy. */
function refusal(code: string) { return (error: unknown): boolean => isPmCliExpectedError(error) && error.context.code === code && error.exitCode === 4 && /new plan|fresh candidate/.test(error.message); }
/** Narrow a successful report while preserving foreign-record refusals in the public result type. */
function report(result: SequentialEvaluationResult): EvaluationPlanReport { assert.ok(!("status" in result)); return result; }
/** Use an actual standalone SDK tracker with no Git ancestry. */
async function workspace() {
  const root = mkdtempSync(join(tmpdir(), "rl-sequential-")); roots.push(root);
  const initialized = await init("rl", { defaults: true, author: "sequential-test", agentGuidance: "skip" }, { cwd: root, pmRoot: join(root, ".agents/pm") });
  const client = new PmClient({ pmRoot: initialized.path, cwd: root, author: "sequential-test", noExtensions: true });
  for (const type of ["Generation", "Run"]) await client.schemaAddType(type, { folder: `${type.toLowerCase()}s`, defaultStatus: "open" });
  await generation(client, "rl-seed", spec());
  return { root, pmRoot: initialized.path, client };
}
/** Create provenance through the SDK, preserving the package's native generation body format. */
async function generation(client: PmClient, id: string, value: GenerationSpec): Promise<void> { await client.create({ id, type: "Generation", title: "Sequential fixture", body: `\`\`\`json\n${JSON.stringify(value)}\n\`\`\``, affectedVersion: hashJson(generationProvenance(value)) }); }
/** Review the exact comparison, register it before collection, and then create the pinned candidate. */
async function prepared(client: PmClient, p = plan()): Promise<EvaluationPlan> {
  assert.equal(p.stopping.kind, "sequential"); if (p.stopping.kind !== "sequential") throw new Error("fixture");
  await client.create({ id: p.stopping.review, type: "Decision", title: "Reviewed statistical protocol", body: JSON.stringify({ format: "pm-rl/sequential-review/1", comparison: evaluationComparison(p) }) });
  await registerEvaluationPlan(client, p);
  try { await client.get("rl-collection"); } catch { await client.create({ id: "rl-collection", type: "Run", title: "Post-declaration collection" }); }
  // Each later candidate needs a collection created after its own sealed plan.
  const run = `${p.candidate}-run`;
  await client.create({ id: run, type: "Run", title: "Post-declaration collection" });
  await generation(client, p.candidate, { ...spec("rl-seed", evaluationComparison(p)), collection_runs: [run] });
  return p;
}
/** Finite bounds on every numeric output, recursively including the promotion verdict. */
function finite(value: unknown): void {
  if (typeof value === "number") assert.ok(Number.isFinite(value));
  if (value !== null && typeof value === "object") for (const field of Object.values(value)) finite(field);
}

test("strict sequential schemas reject sparse arrays, unknown choices, nonfinite values and changed order", () => {
  const p = plan(); assert.equal(p.stopping.kind, "sequential"); if (p.stopping.kind !== "sequential") return;
  const rule = p.stopping; const identity = evaluationComparison(p);
  for (const patch of [{ method: "adaptive" }, { surprise: true }, { review: " " }, { review: 1 }, { review: " padded " }, { review: "x".repeat(1025) }, { unit_order: null }, { unit_order: new Array(64) }, { unit_order: Array(64).fill("u0") }, { looks: new Array(2) }, { looks: [] }, { looks: null }, { looks: Array(65).fill(64) }, { looks: [16, NaN, 64] }, { looks: [16, Infinity] }, { looks: [0, 64] }, { looks: [16.5, 64] }, { looks: [64, 16] }, { looks: [16, 16, 64] }, { looks: [16, 63] }, { observations: 63 }, { independent_units: 63 }]) assert.throws(() => parseEvaluationPlan({ ...p, stopping: { ...rule, ...patch } }), refusal("eval_plan_invalid"));
  assert.throws(() => parseEvaluationPlan({ ...p, members: new Array(64) }), refusal("eval_plan_invalid"));
  assert.throws(() => parseEvaluationPlan({ ...p, reward_bounds: new Array(2) }), refusal("eval_plan_invalid"));
  assert.notEqual(evaluationComparison({ ...p, stopping: { ...rule, unit_order: [...rule.unit_order].reverse() } }), identity);
  assert.notEqual(evaluationComparison({ ...p, stopping: { ...rule, looks: [8, 16, 64] } }), identity);
  assert.throws(() => parseSequentialStopping({ ...rule, method: "wrong" }, p.members), refusal("eval_plan_invalid"));
  for (const field of ["id", "unit"] as const) {
    const large = plan("rl-large", 1000);
    const members = large.members.map((member, index) => ({ ...member, [field]: `${index}`.padStart(1024, "x") }));
    assert.throws(() => parseEvaluationPlan({ ...large, members, stopping: { ...large.stopping, kind: "sequential", unit_order: members.map((member) => member.unit) } }), (error) => isPmCliExpectedError(error) && error.context.code === "rl_identifier_invalid");
  }
  for (const field of ["id", "unit"] as const) {
    const large = plan("rl-byte-bound", 5000);
    const members = large.members.map((member, index) => ({ ...member, [field]: `${index}`.padStart(200, "x") }));
    assert.throws(() => parseEvaluationPlan({ ...large, members, stopping: { ...large.stopping, unit_order: members.map((member) => member.unit) } }), refusal("eval_plan_invalid"));
  }
  assert.throws(() => evaluateSequentialBoundary({ ...p, stopping: { kind: "fixed", observations: 64, independent_units: 64 } }, 16, 1, 0), refusal("eval_plan_stopping"));
});

test("only complete frozen unit prefixes at declared looks are admissible", () => {
  const p = plan(); const rows = observations(p);
  assert.equal(evaluatePlan(p, rows).sequential?.state, "continue");
  for (const invalid of [[], rows.slice(1), [...rows, rows[0]], new Array(16), observations(p, 17), [...rows.slice(0, 15), { ...rows[15], id: "m063" }]]) assert.throws(() => evaluatePlan(p, invalid));
  const clustered = { ...p, members: [...p.members, { id: "extra", unit: "u0" }], stopping: { ...p.stopping, observations: 65 } };
  assert.throws(() => evaluatePlan(clustered, rows), refusal("eval_plan_stopping"));
  const result = evaluatePlan(clustered, [...rows, { id: "extra", candidate: 1, incumbent: 0 }]);
  assert.equal(result.independent_units, 16); assert.ok(Math.abs(result.candidate_mean - 1 / 32) < 1e-15);
  const strong = observations(p, 64, true);
  assert.equal(evaluatePlan(p, strong).sequential?.state, "sufficient");
  assert.equal(evaluatePlan(p, strong.map((row) => ({ ...row, candidate: 0, incumbent: row.candidate }))).verdict.decision, "refuse");
});

test("null, benefit and futility simulations obey declared simultaneous error bounds deterministically", () => {
  const next = random(0x51eaa1); const p = plan("rl-simulation", 256);
  const design: EvaluationPlan = { ...p, stopping: { ...p.stopping, kind: "sequential", method: "hoeffding-alpha-spending/1", unit_order: p.members.map((m) => m.unit), review: "rl-review", looks: [16, 32, 64, 128, 256] } };
  let nullErrors = 0; let benefitSuccesses = 0; let benefitEarly = 0; let falseFutility = 0;
  for (let trial = 0; trial < 10_000; trial += 1) {
    let nullMean = 0; let benefitMean = 0; let nullStop = false; let benefitStop = false;
    for (let n = 1; n <= 256; n += 1) {
      nullMean += ((next() < 0.5 ? 1 : 0) - nullMean) / n;
      benefitMean += ((next() < 0.85 ? 1 : 0) - benefitMean) / n;
      if (![16, 32, 64, 128, 256].includes(n)) continue;
      const nullResult = evaluateSequentialBoundary(design, n, nullMean, 0.5);
      const benefit = evaluateSequentialBoundary(design, n, benefitMean, 0.15);
      finite(nullResult); finite(benefit);
      if (!nullStop && nullResult.sequential.state !== "continue") { if (nullResult.sequential.state === "sufficient") nullErrors += 1; nullStop = true; }
      if (!benefitStop && benefit.sequential.state !== "continue") { if (benefit.sequential.state === "sufficient") { benefitSuccesses += 1; if (n < 256) benefitEarly += 1; } if (benefit.sequential.state === "futile") falseFutility += 1; benefitStop = true; }
    }
  }
  assert.ok(nullErrors / 10_000 <= 0.05); assert.ok(falseFutility / 10_000 <= 0.05);
  assert.equal(benefitSuccesses, 10_000); assert.equal(benefitEarly, 10_000);
  const futile = evaluatePlan(design, observations(design, 64).map((row) => ({ ...row, incumbent: 1 })));
  assert.equal(futile.sequential?.state, "futile");
  const exhausted = evaluatePlan(design, observations(design, 256)); assert.equal(exhausted.sequential?.state, "exhausted");
  console.log(JSON.stringify({ simulations: 10_000, seed: "51eaa1", nullErrors, benefitSuccesses, benefitEarly, falseFutility, declaredError: 0.05 }));
});

test("boundary input and output fuzzing stays finite across extreme representable reward scales", () => {
  const next = random(9941); const p = plan();
  const bounds: readonly (readonly [number, number])[] = [[0, Number.MIN_VALUE], [1e16, 1e16 + 2], [-Number.MAX_VALUE, -Number.MAX_VALUE * 0.5], [0, Number.MAX_VALUE], [-1, 1]];
  for (let trial = 0; trial < 500; trial += 1) {
    const reward_bounds = bounds[trial % bounds.length]; const [lo, hi] = reward_bounds;
    const q: EvaluationPlan = { ...p, reward_bounds, direction: next() < 0.5 ? "maximize" : "minimize", criterion: { confidence: next() < 0.5 ? Number.MIN_VALUE : 1 - Number.EPSILON, minSamples: next() < 0.5 ? 1 : Number.MAX_SAFE_INTEGER, effectThreshold: next() < 0.5 ? 0 : Number.MAX_VALUE } };
    const rows = observations(q, 64).map((row) => ({ ...row, candidate: next() < 0.5 ? lo : hi, incumbent: next() < 0.5 ? lo : hi }));
    const result = evaluatePlan(q, rows); finite(result);
    assert.ok(result.candidate_mean >= lo && result.candidate_mean <= hi);
    assert.ok(result.incumbent_mean >= lo && result.incumbent_mean <= hi);
    assert.ok(result.sequential!.lower >= -1 && result.sequential!.upper <= 1);
    const extreme = [NaN, Infinity, -Infinity, undefined, null, "1"][trial % 6];
    assert.throws(() => evaluatePlan(q, [{ ...rows[0], candidate: extreme }, ...rows.slice(1)]));
  }
});

test("review, sealing, restart, old snapshot replay and promotion gate use live SDK state", async () => {
  const w = await workspace(); const p = plan();
  await assert.rejects(registerEvaluationPlan(w.client, p), refusal("eval_plan_evidence"));
  await prepared(w.client, p);
  assert.equal((await registerEvaluationPlan(w.client, p)).comparison, evaluationComparison(p));
  assert.equal(await readSequentialEvaluation(w.client, p.candidate), null);
  const missingScore: ScoreRecord = { objective: p.objective, objective_version: p.objective_version, evaluation_context: p.evaluation_context, direction: p.direction, seed_set: evaluationComparison(p), scale: 1, value: 0 };
  await assert.rejects(enforceEvaluationPlan(w.client, p.candidate, missingScore), refusal("eval_plan_missing"));
  const first = report(await recordSequentialEvaluation(w.client, p.candidate, observations(p)));
  assert.equal(first.observations, 16); assert.equal(first.sequential?.state, "continue");
  const restarted = new PmClient({ pmRoot: w.pmRoot, cwd: w.root, author: "restarted-agent", noExtensions: true });
  assert.deepEqual(await readSequentialEvaluation(restarted, p.candidate), first);
  const final = report(await recordSequentialEvaluation(restarted, p.candidate, observations(p, 64, true)));
  assert.equal(final.observations, 64); assert.equal(final.sequential?.state, "sufficient");
  assert.deepEqual(await recordSequentialEvaluation(w.client, p.candidate, [...observations(p)].reverse()), final);
  assert.deepEqual(await recordSequentialEvaluation(w.client, p.candidate, [...observations(p, 64, true)].reverse()), final);
  await assert.rejects(recordSequentialEvaluation(w.client, p.candidate, observations(p, 64)), refusal("eval_plan_drift"));
  const score: ScoreRecord = { objective: p.objective, objective_version: p.objective_version, evaluation_context: p.evaluation_context, direction: p.direction, seed_set: evaluationComparison(p), scale: 1, value: final.candidate_mean };
  await enforceEvaluationPlan(w.client, p.candidate, score);
  await assert.rejects(enforceEvaluationPlan(w.client, p.candidate, { ...score, value: 0 }), refusal("eval_plan_evidence"));
  await w.client.update(p.candidate, { affectedVersion: "changed" });
  await assert.rejects(recordSequentialEvaluation(w.client, p.candidate, observations(p)), refusal("eval_plan_drift"));
  await assert.rejects(readSequentialEvaluation(w.client, p.candidate), refusal("eval_plan_drift"));
});

test("futile and exhausted checkpoints refuse additional looks and never authorize promotion", async () => {
  for (const outcome of ["futile", "exhausted"] as const) {
    const w = await workspace(); const p = await prepared(w.client);
    const firstRows = observations(p).map((row) => ({ ...row, incumbent: outcome === "futile" ? 1 : 0 }));
    await recordSequentialEvaluation(w.client, p.candidate, firstRows);
    if (outcome === "futile") await assert.rejects(recordSequentialEvaluation(w.client, p.candidate, observations(p, 64)), refusal("eval_plan_stopping"));
    else assert.equal(report(await recordSequentialEvaluation(w.client, p.candidate, observations(p, 64))).sequential?.state, "exhausted");
    const score: ScoreRecord = { objective: p.objective, objective_version: p.objective_version, evaluation_context: p.evaluation_context, direction: p.direction, seed_set: evaluationComparison(p), scale: 1, value: 0 };
    await assert.rejects(enforceEvaluationPlan(w.client, p.candidate, score), refusal("eval_plan_refused"));
  }
});

test("500 seeded model-based operation sequences read canonical state through the SDK", async () => {
  const w = await workspace(); const p = await prepared(w.client); const next = random(0x5eed1025);
  const model = new Map<number, readonly EvaluationObservation[]>();
  await w.client.create({ id: "rl-context", title: "Relationship preserved by replay" });
  await w.client.update(`${p.candidate}-evaluation-plan`, { parent: "rl-context", blockedBy: "rl-context" });
  await w.client.update(p.candidate, { parent: "rl-context", blockedBy: "rl-context" });
  const statuses: string[] = [];
  for (let index = 0; index < 3; index += 1) {
    const status = `stage_${Math.floor(next() * 2 ** 32)}`;
    await w.client.schemaAddStatus(status, { role: ["active"] }); statuses.push(status);
  }
  const settings = await readSettings(w.pmRoot); const registry = resolveItemTypeRegistry(settings);
  /** Read complete native documents through the SDK, with its schema and normalization rather than a hand-written projection. */
  async function nativeDocument(id: string) {
    const located = await locateItem(w.pmRoot, id, settings.id_prefix, settings.item_format, registry.type_to_folder);
    assert.ok(located); return (await readLocatedItem(located, { schema: settings.schema })).document;
  }
  const nativePlan = await nativeDocument(`${p.candidate}-evaluation-plan`);
  let nativeCandidate = await nativeDocument(p.candidate);
  const nativeCheckpoints = new Map<number, Awaited<ReturnType<typeof nativeDocument>>>();
  const canonical = await readCompleteLoopItem(w.client, `${p.candidate}-evaluation-plan`);
  const candidate = await readCompleteLoopItem(w.client, p.candidate);
  for (let sequence = 0; sequence < 500; sequence += 1) {
    // Every sequence transports a seeded prior/next input through whitespace/CRLF, imports it, and exports live SDK state.
    if (sequence % 100 === 0) { await w.client.update(p.candidate, { status: statuses[Math.floor(next() * statuses.length)] }); nativeCandidate = await nativeDocument(p.candidate); }
    const count = sequence === 1 || (sequence > 1 && next() < 0.55) ? 64 : 16;
    const input = observations(p, count, true);
    const transported = input.map((row) => ({ ...row }));
    const serialized = JSON.stringify(next() < 0.5 ? [...transported].reverse() : transported, null, next() < 0.5 ? 2 : 0).replaceAll("\n", "\r\n");
    if (next() < 0.5) await assert.rejects(recordSequentialEvaluation(w.client, p.candidate, transported.map((row) => ({ ...row, id: ` \r\n${row.id} ` }))), (error) => isPmCliExpectedError(error) && error.context.code === "rl_identifier_invalid");
    const rewrite = sequence > 1 && next() < 0.35;
    const payload = parseBoundedJson(` \r\n${serialized}\r\n `) as EvaluationObservation[];
    if (rewrite) {
      const changed = payload.map((row, index) => index === 0 ? { ...row, candidate: 0.375 } : row);
      await assert.rejects(recordSequentialEvaluation(w.client, p.candidate, changed), refusal("eval_plan_drift"));
    } else {
      const result = report(await recordSequentialEvaluation(w.client, p.candidate, payload));
      model.set(count, input);
      assert.equal(result.observations, model.has(64) ? 64 : 16);
    }
    if (sequence % 50 === 0) {
      const live = report((await readSequentialEvaluation(w.client, p.candidate))!);
      assert.equal(live.observations, model.has(64) ? 64 : 16);
    }
    assert.deepEqual(await nativeDocument(`${p.candidate}-evaluation-plan`), nativePlan);
    assert.deepEqual(await nativeDocument(p.candidate), nativeCandidate);
    const planItem = await readCompleteLoopItem(w.client, `${p.candidate}-evaluation-plan`);
    for (const key of ["id", "type", "body", "affected_version", "title", "parent", "blocked_by", "tags"] as const) assert.deepEqual(planItem.item[key], canonical.item[key]);
    const liveCandidate = await readCompleteLoopItem(w.client, p.candidate);
    for (const key of ["body", "affected_version", "type", "parent", "blocked_by"] as const) assert.deepEqual(liveCandidate.item[key], candidate.item[key]);
    for (const [n, expected] of model) {
      const item = (await readCompleteLoopItem(w.client, `${p.candidate}-evaluation-plan-look-${n === 16 ? 1 : 2}`)).item;
      const nativeCheckpoint = await nativeDocument(item.id);
      if (!nativeCheckpoints.has(n)) nativeCheckpoints.set(n, nativeCheckpoint);
      assert.deepEqual(nativeCheckpoint, nativeCheckpoints.get(n));
      const stored = parseBoundedJson(String(item.body)) as { observations: EvaluationObservation[]; comparison: string; previous: string | null; format: string };
      assert.deepEqual(stored.observations, expected); assert.equal(stored.comparison, evaluationComparison(p));
      assert.equal(stored.format, "pm-rl/sequential-checkpoint/1"); assert.equal(item.type, "Decision");
      assert.equal(item.id, `${p.candidate}-evaluation-plan-look-${n === 16 ? 1 : 2}`);
      assert.equal(item.title, "Sealed sequential evaluation checkpoint");
      assert.deepEqual(item.tags, ["pm-rl:sequential-checkpoint"]);
      assert.equal(item.affected_version, hashJson(stored as unknown as JsonValue));
      if (n === 64) assert.equal(stored.previous, (await readCompleteLoopItem(w.client, `${p.candidate}-evaluation-plan-look-1`)).item.affected_version);
    }
  }
  assert.equal((await w.client.listAllComplete({ includeBody: false })).items.filter((item) => item.type === "Decision").length, 3);
  console.log(JSON.stringify({ modelSequences: 500, seed: "5eed1025", operationKinds: ["transport", "advance", "old-snapshot-replay", "refused-rewrite", "SDK-export", "custom-status", "relationships", "refused-id-padding"], checkpointRecords: 2 }));
});

test("foreign reserved records are skipped with a reason and retained intact", async () => {
  const w = await workspace(); const p = await prepared(w.client);
  const id = `${p.candidate}-evaluation-plan-look-1`;
  await w.client.create({ id, type: "Task", title: "Foreign record", body: "unrelated" });
  const before = await readCompleteLoopItem(w.client, id);
  const result = await recordSequentialEvaluation(w.client, p.candidate, observations(p));
  assert.ok("status" in result); assert.equal(result.status, "skipped"); assert.equal(result.skipped[0].reason, "foreign_type");
  assert.deepEqual(await readCompleteLoopItem(w.client, id), before);
  assert.equal((await readSequentialEvaluation(w.client, p.candidate) as { status: string }).status, "skipped");
  const score: ScoreRecord = { objective: p.objective, objective_version: p.objective_version, evaluation_context: p.evaluation_context, direction: p.direction, seed_set: evaluationComparison(p), scale: 1, value: 0 };
  await assert.rejects(enforceEvaluationPlan(w.client, p.candidate, score), refusal("eval_plan_missing"));
});

test("CLI advance and resume use the SDK protocol in a tracker with git absent from PATH", async () => {
  const w = await workspace(); const p = await prepared(w.client); const bin = join(w.root, "bin"); mkdirSync(bin); symlinkSync(process.execPath, join(bin, "node"));
  const identityTool = process.platform === "linux" ? "getconf" : "ps";
  symlinkSync(execFileSync("/bin/sh", ["-c", `command -v ${identityTool}`], { encoding: "utf8" }).trim(), join(bin, identityTool));
  const previousPath = process.env.PATH; const previousCeiling = process.env.GIT_CEILING_DIRECTORIES;
  process.env.PATH = bin; process.env.GIT_CEILING_DIRECTORIES = dirname(w.root);
  try {
    const harness = await createExtensionTestHarness(extension, { name: "pm-rl", capabilities: ["commands", "hooks", "schema"] });
    const file = join(w.root, "rows.json"); writeFileSync(file, JSON.stringify(observations(p)));
    await assert.rejects(harness.runCommand({ command: "rl eval plan resume", pmRoot: w.pmRoot, args: [p.candidate] }), refusal("eval_plan_missing"));
    const advanced = (await harness.runCommand({ command: "rl eval plan advance", pmRoot: w.pmRoot, args: [p.candidate], options: { file } })).result as RlCommandResult;
    const resumed = (await harness.runCommand({ command: "rl eval plan resume", pmRoot: w.pmRoot, args: [p.candidate] })).result as RlCommandResult;
    assert.deepEqual(advanced.details, resumed.details); assert.ok(JSON.stringify(advanced).length < 1800);
    await assert.rejects(recordPlanEvaluation(w.client, p.candidate, observations(p)), refusal("eval_plan_stopping"));
  } finally {
    if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath;
    if (previousCeiling === undefined) delete process.env.GIT_CEILING_DIRECTORIES; else process.env.GIT_CEILING_DIRECTORIES = previousCeiling;
  }
});

test("all protocol IO boundaries on one non-git tracker interleave a real competing writer", async () => {
  const previousWait = process.env.PM_LOCK_WAIT_MS; process.env.PM_LOCK_WAIT_MS = "0";
  const w = await workspace(); const p = await prepared(w.client);
  const peer = new PmClient({ pmRoot: w.pmRoot, cwd: w.root, author: "peer-agent", noExtensions: true });
  const rows = observations(p); let boundary = 0; let injectAt = -1; let injected = false; const trace: string[] = [];
  /** Run one independent package writer after a real SDK call returns, never mocking SDK results. */
  async function step(name: string): Promise<void> {
    trace.push(name);
    if (boundary++ !== injectAt) return;
    injected = true;
    try { const result = report(await recordSequentialEvaluation(peer, p.candidate, rows)); assert.equal(result.observations, 16); }
    catch (error) { assert.ok(isPmCliExpectedError(error)); assert.equal(error.context.code, "lock_conflict"); }
  }
  const get = w.client.get.bind(w.client); const config = w.client.config.bind(w.client); const create = w.client.create.bind(w.client);
  w.client.get = (async (...args) => { await step("get:before"); try { return await get(...args); } finally { await step("get:after"); } }) as PmClient["get"];
  w.client.config = (async (...args) => { await step("config:before"); try { return await config(...args); } finally { await step("config:after"); } }) as PmClient["config"];
  w.client.create = (async (...args) => { await step("create:before"); try { return await create(...args); } finally { await step("create:after"); } }) as PmClient["create"];
  await recordSequentialEvaluation(w.client, p.candidate, rows);
  const createPosition = trace.indexOf("create:after"); assert.ok(createPosition > 0);
  boundary = 0; trace.length = 0; await recordSequentialEvaluation(w.client, p.candidate, rows);
  const boundaries = trace.length;
  for (let index = 0; index < boundaries; index += 1) {
    boundary = 0; injectAt = index; injected = false;
    const result = report(await recordSequentialEvaluation(w.client, p.candidate, rows));
    assert.ok(injected); assert.equal(result.observations, 16);
    assert.equal(report((await readSequentialEvaluation(peer, p.candidate))!).observations, 16);
  }
  injectAt = -1;
  assert.equal((await peer.listAllComplete({ includeBody: false })).items.filter((item) => String(item.id).includes("-look-")).length, 1);
  console.log(JSON.stringify({ interleavedSdkBoundaries: boundaries, creationBoundary: createPosition, checkpointRecords: 1 }));
  if (previousWait === undefined) delete process.env.PM_LOCK_WAIT_MS; else process.env.PM_LOCK_WAIT_MS = previousWait;
});

test("SDK provenance locks reject ordinary writers until the outer evaluation lease releases last", async () => {
  const w = await workspace(); const p = await prepared(w.client);
  await withEvaluationLease(w.client, p.candidate, [p.candidate, p.incumbent, p.candidate], async () => {
    await assert.rejects(w.client.update(p.candidate, { affectedVersion: "racing" }), (error: unknown) => isPmCliExpectedError(error) && error.context.code === "lock_conflict");
    await assert.rejects(withEvaluationLease(w.client, p.candidate, [], async () => true), (error: unknown) => isPmCliExpectedError(error) && error.context.code === "lock_conflict");
  });
  await assert.rejects(withEvaluationLease(w.client, p.candidate, [], async () => { throw new Error("disconnect"); }), /disconnect/);
  assert.equal(await withEvaluationLease(w.client, p.candidate, [], async () => "released"), "released");
});

test("checkpoint publication survives a lost response and refuses a changed predecessor on recovery", async () => {
  const w = await workspace(); const p = await prepared(w.client); const create = w.client.create.bind(w.client);
  let fail = true;
  w.client.create = (async (...args) => {
    const result = await create(...args);
    if (fail && args[0]?.id === `${p.candidate}-evaluation-plan-look-1`) { fail = false; throw new Error("response lost after durable create"); }
    return result;
  }) as PmClient["create"];
  assert.equal(report(await recordSequentialEvaluation(w.client, p.candidate, observations(p))).observations, 16);
  const id = `${p.candidate}-evaluation-plan-look-1`; const before = await readCompleteLoopItem(w.client, id);
  await w.client.update(id, { affectedVersion: "new-target-revision" });
  await assert.rejects(recordSequentialEvaluation(w.client, p.candidate, observations(p, 64, true)), refusal("eval_plan_drift"));
  await w.client.update(id, { affectedVersion: String(before.item.affected_version) });
  assert.equal(report(await recordSequentialEvaluation(w.client, p.candidate, observations(p))).observations, 16);
  await w.client.delete(id, { force: true });
  await assert.rejects(recordSequentialEvaluation(w.client, p.candidate, observations(p)), refusal("eval_plan_missing"));
});

test("late, missing, fixed and skipped-look protocols refuse before checkpoint writes", async () => {
  const w = await workspace();
  await assert.rejects(recordSequentialEvaluation(w.client, "rl-missing", []), refusal("eval_plan_missing"));
  await assert.rejects(readSequentialEvaluation(w.client, "rl-missing"), refusal("eval_plan_missing"));
  await assert.rejects(reviewSequentialPlan(w.client, { ...plan(), stopping: { kind: "fixed", observations: 64, independent_units: 64 } }), refusal("eval_plan_stopping"));
  const p = await prepared(w.client);
  await assert.rejects(recordSequentialEvaluation(w.client, p.candidate, observations(p, 64, true)), refusal("eval_plan_stopping"));
  const changed = { ...p, population: "Changed after collection" };
  await assert.rejects(registerEvaluationPlan(w.client, changed), refusal("eval_plan_evidence"));
  const fixed = plan("rl-fixed"); const f: EvaluationPlan = { ...fixed, stopping: { kind: "fixed", observations: 64, independent_units: 64 } };
  await registerEvaluationPlan(w.client, f); await generation(w.client, f.candidate, { ...spec("rl-seed"), collection_runs: [`${p.candidate}-run`] });
  await assert.rejects(recordSequentialEvaluation(w.client, f.candidate, observations(f)), refusal("eval_plan_stopping"));
  await assert.rejects(readSequentialEvaluation(w.client, f.candidate), refusal("eval_plan_stopping"));
});

test("output validation rejects every nonfinite or out-of-domain report field", () => {
  const p = plan(); const base = evaluatePlan(p, observations(p));
  for (const patch of [{ candidate_mean: Infinity }, { incumbent_mean: NaN }, { observations: 0 }, { observations: 1.5 }, { observations: 65 }, { independent_units: -1 }, { candidate_mean: 2 }, { incumbent_mean: -1 }, { sequential: { ...base.sequential!, lower: -2 } }, { sequential: { ...base.sequential!, upper: 2 } }, { sequential: { ...base.sequential!, lower: 0.9, upper: 0.1 } }, { sequential: { ...base.sequential!, error_bound: 0 } }, { sequential: { ...base.sequential!, error_bound: 2 } }, { sequential: { ...base.sequential!, look: 0 } }, { sequential: { ...base.sequential!, look: 65 } }, { sequential: { ...base.sequential!, look: 1.5 } }]) assert.throws(() => validateEvaluationReport(p, { ...base, ...patch }), refusal("eval_plan_evidence"));
  assert.throws(() => parseEvaluationPlan({ ...p, shadow: "online-shadow" }), refusal("eval_plan_invalid"));
});

test("review receipts accept JSON transport whitespace and reject malformed or changed design reviews", async () => {
  const w = await workspace(); const p = plan(); if (p.stopping.kind !== "sequential") return;
  for (const body of ["invalid", "null", "[]", "1", "{}", '{"format":"wrong","comparison":"wrong"}', '{"format":"pm-rl/sequential-review/1","comparison":"wrong"}']) {
    const id = `rl-review-${hashJson(body).slice(0, 8)}`; const q: EvaluationPlan = { ...p, stopping: { ...p.stopping, review: id } };
    await w.client.create({ id, type: "Decision", title: "Invalid review", body });
    await assert.rejects(reviewSequentialPlan(w.client, q), refusal("eval_plan_evidence"));
  }
  const body = JSON.stringify({ format: "pm-rl/sequential-review/1", comparison: evaluationComparison(p) }, null, 2).replaceAll("\n", "\r\n");
  await w.client.create({ id: p.stopping.review, type: "Decision", title: "Transported review", body });
  await registerEvaluationPlan(w.client, p);
});

test("checkpoint chain validation refuses forged versions, gaps, changed pairs and terminal extensions", async () => {
  for (const variant of ["shape", "comparison", "previous", "array", "gap", "look", "version", "terminal", "prefix"] as const) {
    const w = await workspace(); const p = await prepared(w.client);
    let index = 1; let previous: string | null = null;
    if (variant === "terminal" || variant === "prefix") {
      const first = variant === "terminal" ? observations(p).map((row) => ({ ...row, candidate: 1 })) : observations(p);
      await recordSequentialEvaluation(w.client, p.candidate, first);
      index = 2; previous = String((await readCompleteLoopItem(w.client, `${p.candidate}-evaluation-plan-look-1`)).item.affected_version);
    }
    if (variant === "gap") index = 2;
    const rows = variant === "look" || index === 2 ? observations(p, 64, true) : observations(p);
    if (variant === "prefix") rows[0] = { ...rows[0], candidate: 1 };
    const raw: Record<string, JsonValue> = { format: "pm-rl/sequential-checkpoint/1", comparison: variant === "comparison" ? "wrong" : evaluationComparison(p), previous: variant === "previous" ? "wrong" : previous, observations: rows as unknown as JsonValue };
    if (variant === "shape") raw.extra = true;
    if (variant === "array") raw.observations = null;
    await w.client.create({ id: `${p.candidate}-evaluation-plan-look-${index}`, type: "Decision", title: "Adversarial checkpoint", tags: "pm-rl:sequential-checkpoint", body: JSON.stringify(raw), affectedVersion: variant === "version" ? "wrong" : hashJson(raw) });
    await assert.rejects(readSequentialEvaluation(w.client, p.candidate), refusal("eval_plan_drift"));
  }
});

test("create failures re-read current ownership and preserve foreign winners", async () => {
  for (const mode of ["unavailable", "foreign-before", "foreign-after"] as const) {
    const w = await workspace(); const p = await prepared(w.client); const create = w.client.create.bind(w.client); let once = true;
    w.client.create = (async (...args) => {
      if (!once || args[0]?.id !== `${p.candidate}-evaluation-plan-look-1`) return create(...args);
      once = false;
      if (mode === "unavailable") throw new Error("temporarily unavailable");
      if (mode === "foreign-before") { await create({ id: args[0].id, type: "Task", title: "Foreign winner" }); throw new Error("peer won"); }
      const result = await create(...args); await w.client.update(String(result.item.id), { tags: "foreign" }); return result;
    }) as PmClient["create"];
    if (mode === "unavailable") {
      await assert.rejects(recordSequentialEvaluation(w.client, p.candidate, observations(p)), /temporarily unavailable/);
      assert.equal(report(await recordSequentialEvaluation(w.client, p.candidate, observations(p))).observations, 16);
    } else {
      const result = await recordSequentialEvaluation(w.client, p.candidate, observations(p)); assert.ok("status" in result); assert.equal(result.status, "skipped");
    }
  }
});

test("registration interleavings and both publication boundaries preserve one reviewed winner", async () => {
  const previousWait = process.env.PM_LOCK_WAIT_MS; process.env.PM_LOCK_WAIT_MS = "0";
  const w = await workspace(); const peer = new PmClient({ pmRoot: w.pmRoot, cwd: w.root, author: "peer-agent", noExtensions: true });
  const state = { current: plan("rl-registration-baseline"), boundary: 0, injectAt: -1, injected: false };
  /** Create each exact review before the registration under test. */
  async function review(p: EvaluationPlan): Promise<void> { if (p.stopping.kind !== "sequential") throw new Error("fixture"); await peer.create({ id: p.stopping.review, type: "Decision", title: "Reviewed protocol", body: JSON.stringify({ format: "pm-rl/sequential-review/1", comparison: evaluationComparison(p) }) }); }
  /** Let a real SDK peer attempt the same reviewed reservation at every observed boundary. */
  async function step(): Promise<void> {
    if (state.boundary++ !== state.injectAt) return;
    state.injected = true;
    try { assert.equal((await registerEvaluationPlan(peer, state.current)).comparison, evaluationComparison(state.current)); }
    catch (error) { assert.ok(isPmCliExpectedError(error)); assert.equal(error.context.code, "lock_conflict"); }
  }
  const get = w.client.get.bind(w.client); const config = w.client.config.bind(w.client); const create = w.client.create.bind(w.client);
  w.client.get = (async (...args) => { await step(); try { return await get(...args); } finally { await step(); } }) as PmClient["get"];
  w.client.config = (async (...args) => { await step(); try { return await config(...args); } finally { await step(); } }) as PmClient["config"];
  w.client.create = (async (...args) => { await step(); try { return await create(...args); } finally { await step(); } }) as PmClient["create"];
  try {
    await review(state.current); await registerEvaluationPlan(w.client, state.current); const boundaries = state.boundary;
    for (let index = 0; index < boundaries; index += 1) {
      state.current = plan(`rl-registration-${index}`); state.boundary = 0; state.injectAt = index; state.injected = false;
      await review(state.current);
      assert.equal((await registerEvaluationPlan(w.client, state.current)).comparison, evaluationComparison(state.current)); assert.ok(state.injected);
      assert.equal((await readEvaluationPlan(peer, state.current.candidate))?.comparison, evaluationComparison(state.current));
    }
    state.injectAt = -1;
    const p = await prepared(peer, plan("rl-publication")); const peerCreate = peer.create.bind(peer); let attempts = 0;
    /** Compete immediately before and after the only durable checkpoint write. */
    async function compete(): Promise<void> { attempts += 1; await assert.rejects(recordSequentialEvaluation(w.client, p.candidate, observations(p)), (error: unknown) => isPmCliExpectedError(error) && error.context.code === "lock_conflict"); }
    peer.create = (async (...args) => { await compete(); const result = await peerCreate(...args); await compete(); return result; }) as PmClient["create"];
    assert.equal(report(await recordSequentialEvaluation(peer, p.candidate, observations(p))).observations, 16); assert.equal(attempts, 2);
    console.log(JSON.stringify({ registrationBoundaries: boundaries, publicationBoundaries: attempts }));
  } finally { if (previousWait === undefined) delete process.env.PM_LOCK_WAIT_MS; else process.env.PM_LOCK_WAIT_MS = previousWait; }
});

test("a predecessor cannot become foreign between validation and dependent checkpoint publication", async () => {
  const previousWait = process.env.PM_LOCK_WAIT_MS; process.env.PM_LOCK_WAIT_MS = "0";
  const w = await workspace(); const p = await prepared(w.client);
  const peer = new PmClient({ pmRoot: w.pmRoot, cwd: w.root, author: "ordinary-sdk-peer", noExtensions: true });
  await recordSequentialEvaluation(w.client, p.candidate, observations(p));
  const before = await readCompleteLoopItem(peer, `${p.candidate}-evaluation-plan-look-1`); const create = w.client.create.bind(w.client); let attempted = 0;
  /** Race the ordinary SDK writer on both sides of the dependent checkpoint creation. */
  async function compete(): Promise<void> { attempted += 1; await assert.rejects(peer.update(before.item.id, { tags: "foreign" }), (error: unknown) => isPmCliExpectedError(error) && error.context.code === "lock_conflict"); }
  w.client.create = (async (...args) => { await compete(); const result = await create(...args); await compete(); return result; }) as PmClient["create"];
  try {
    assert.equal(report(await recordSequentialEvaluation(w.client, p.candidate, observations(p, 64, true))).sequential?.state, "sufficient");
    assert.equal(attempted, 2); assert.deepEqual(await readCompleteLoopItem(peer, before.item.id), before);
    await peer.update(before.item.id, { tags: "foreign" });
    assert.ok("status" in (await recordSequentialEvaluation(w.client, p.candidate, observations(p, 64, true))));
  } finally { if (previousWait === undefined) delete process.env.PM_LOCK_WAIT_MS; else process.env.PM_LOCK_WAIT_MS = previousWait; }
});

test("SDK intake snapshots observations before asynchronous provenance and checkpoint reads", async () => {
  const w = await workspace(); const p = await prepared(w.client); const input = observations(p); const config = w.client.config.bind(w.client); let calls = 0;
  w.client.config = (async (...args) => {
    const result = await config(...args);
    if (++calls === 2) input.push(...observations(p, 64, true).slice(16));
    return result;
  }) as PmClient["config"];
  assert.equal(report(await recordSequentialEvaluation(w.client, p.candidate, input)).observations, 16);
  assert.equal(input.length, 64);
  assert.equal(report((await readSequentialEvaluation(w.client, p.candidate))!).observations, 16);
  assert.equal(report(await recordSequentialEvaluation(w.client, p.candidate, input)).observations, 64);
  await assert.rejects(recordSequentialEvaluation(w.client, p.candidate, null), refusal("eval_plan_stopping"));
  await assert.rejects(recordSequentialEvaluation(w.client, p.candidate, Array(65).fill({ id: "x", candidate: 0, incumbent: 0 })), refusal("eval_plan_stopping"));
  await assert.rejects(recordSequentialEvaluation(w.client, p.candidate, Array(10001).fill({ id: "x", candidate: 0, incumbent: 0 })), refusal("eval_plan_stopping"));
});
