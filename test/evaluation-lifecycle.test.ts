/** Clock-independent lifecycle acceptance on real plain-directory trackers, without SDK mocks. */
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { join } from "node:path";
import { existsSync, rmSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { test } from "node:test";
import type { PmClient } from "@unbrained/pm-cli/sdk/core";
import { Hash } from "node:crypto";
import { canonicalJson } from "../json-identity.ts";
import { readSequentialEvaluation } from "../sequential-evaluation.ts";
import { approveEvaluationPlan, createCausalEvaluationArtifact, validateCausalEvaluationOrder, verifyCausalEvaluationRetry } from "../evaluation-lifecycle.ts";
import { isPmCliExpectedError } from "@unbrained/pm-cli/sdk/runtime";
import { promoteGenerationCore, registerGenerationCore, readCompleteLoopItem, startRunCore, type JsonValue, type RlCommandResult } from "../index.ts";
import { enforceEvaluationPlan, validateEvaluationOrder, evaluationLifecycleArtifacts, parseEvaluationPlan, readEvaluationPlan, registerEvaluationPlan } from "../evaluation-plan.ts";
import { causalWorkspace, causalStep, withCausalClock } from "./fixtures/causal-evaluation.ts";

const testCwd = process.cwd();

test("causal birth witnesses permit equal clocks, skew and rollback through collection candidate and looks", async () => {
  // Exercise dispatch directly so a reverted timestamp validator fails on ordering,
  // before higher-level publication fences can translate that refusal.
  const dispatch = await causalWorkspace();
  try {
    const artifacts = [{ id: "rl-clock-review", stage: 0 }, { id: "rl-clock-plan", stage: 1 }];
    for (const [i, entry] of artifacts.entries()) await withCausalClock(`${2030 - i}-01-01T00:00:00.000Z`, () => createCausalEvaluationArtifact(dispatch.client, dispatch.plan, { id: entry.id, type: "Decision", title: "Clock-independent dispatch" }, artifacts.slice(0, i + 1)));
    assert.equal(String((await readCompleteLoopItem(dispatch.client, artifacts[0].id, "1")).item.created_at), "2030-01-01T00:00:00.000Z");
    assert.equal(String((await readCompleteLoopItem(dispatch.client, artifacts[1].id, "1")).item.created_at), "2029-01-01T00:00:00.000Z");
    await validateEvaluationOrder(dispatch.client, artifacts, 1000, undefined, dispatch.plan);
  } finally { process.chdir(testCwd); rmSync(dispatch.root, { recursive: true, force: true }); }
  for (const clocks of [[2030, 2029, 2032, 2027, 2026, 2025], [2030, 2030, 2030, 2030, 2030, 2030]]) {
    const w = await causalWorkspace();
    try {
      for (const [i, step] of ["review", "plan", "run", "candidate", "first", "last"].entries()) {
        const clock = `${clocks[i]}-01-01T00:00:00.000Z`;
        await withCausalClock(clock, () => causalStep(w, step));
        const id = ["rl-review", "rl-candidate-evaluation-plan", w.request.id, w.plan.candidate, "rl-candidate-evaluation-plan-look-1", "rl-candidate-evaluation-plan-look-2"][i];
        assert.equal(String((await readCompleteLoopItem(w.client, id, "1")).item.created_at), clock);
      }
      const report = await readSequentialEvaluation(w.client, w.plan.candidate);
      assert.ok(report !== null && !("status" in report));
      assert.equal(report.sequential?.state, "sufficient");
      assert.equal(report.sequential.look, 2);
      await enforceEvaluationPlan(w.client, w.plan.candidate, { objective: w.plan.objective, objective_version: w.plan.objective_version, evaluation_context: w.plan.evaluation_context, direction: w.plan.direction, seed_set: w.comparison, scale: 1, value: report.candidate_mean });
    } finally { process.chdir(testCwd); rmSync(w.root, { recursive: true, force: true }); }
  }
});

test("causal creation is shared across OS processes and killed acknowledgements replay the same births", async () => {
  const w = await causalWorkspace();
  try {
    const file = join(w.root, "worker.json");
    writeFileSync(file, JSON.stringify({ root: w.root, pmRoot: w.pmRoot, plan: w.plan, request: w.request, generation: w.generation, rows: w.rows }));
    for (const step of ["review", "plan"]) await causalStep(w, step);
    const peers = [worker(file, "run", "2035-01-01T00:00:00.000Z"), worker(file, "run", "2020-01-01T00:00:00.000Z")];
    try {
      await Promise.all(peers.map(peer => peer.ready)); peers.forEach(peer => peer.child.send("go"));
      const receipts = await Promise.all(peers.map(peer => peer.committed));
      assert.deepEqual(receipts.map(receipt => receipt.result.created).sort(), [false, true]);
      await Promise.all(peers.map(peer => peer.exit));
    } finally { for (const peer of peers) if (peer.child.exitCode === null) peer.child.kill("SIGKILL"); await Promise.all(peers.map(peer => peer.exit)); }
    for (const step of ["candidate", "first", "last"]) {
      const peer = worker(file, step, "2010-01-01T00:00:00.000Z", true);
      try {
        await peer.ready; peer.child.send("go"); await peer.committed;
        peer.child.kill("SIGKILL"); await peer.exit;
        const before = trackerHistory(w.pmRoot);
        await causalStep(w, step);
        assert.deepEqual(trackerHistory(w.pmRoot), before, `${step} must not rewrite a committed birth`);
      } finally { if (peer.child.exitCode === null) peer.child.kill("SIGKILL"); await peer.exit; }
    }
    const report = await readSequentialEvaluation(w.client, w.plan.candidate);
    assert.ok(report !== null && !("status" in report)); assert.equal(report.sequential?.look, 2);
  } finally { process.chdir(testCwd); rmSync(w.root, { recursive: true, force: true }); }
});

/** Observe actual history bytes so retries cannot hide a duplicate write behind equal projected values. */
function trackerHistory(root: string): string[] { return readdirSync(join(root, "history")).sort().map(file => readFileSync(join(root, "history", file), "utf8")); }
/** A bounded child and IPC barriers let two native writers contend on exactly one tracker. */
function worker(file: string, step: string, clock: string, hold = false) {
  const childEnv: NodeJS.ProcessEnv = { ...process.env, PM_LOCK_WAIT_MS: "30000" };
  for (const key of Object.keys(childEnv)) if (/TOKEN|SECRET|PASSWORD|CREDENTIAL|NPM_MEDIA_SERVER/i.test(key)) delete childEnv[key];
  const child = fork(new URL("./fixtures/causal-worker.ts", import.meta.url), [file, step, clock, hold ? "hold" : "exit"], { env: childEnv, stdio: ["ignore", "pipe", "pipe", "ipc"] });
  let stderr = ""; child.stderr!.on("data", chunk => { stderr += String(chunk); });
  const wait = (state: string): Promise<{ result: { created?: boolean } }> => new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error(`Worker ${step} timed out: ${stderr}`)); }, 120_000);
    child.on("message", message => { const value = message as { state: string; result: { created?: boolean } }; if (value.state === state) { clearTimeout(timer); resolve(value); } });
    child.once("exit", code => { clearTimeout(timer); if (code !== 0) reject(new Error(`Worker ${step} exited: ${stderr}`)); });
  });
  const exit = new Promise<void>(resolve => { child.once("exit", () => { resolve(); }); });
  return { child, ready: wait("ready"), committed: wait("committed"), exit };
}

/** Match stable typed refusals without depending on the wording of SDK diagnostics. */
function refused(code: string) { return (error: unknown): boolean => isPmCliExpectedError(error) && error.context.code === code; }

test("causal collection retries reject configuration-hash drift", async () => {
  const w = await causalWorkspace();
  try {
    for (const step of ["review", "plan", "run"]) await causalStep(w, step);
    await w.client.update(w.request.id, { fixedVersion: "different-configuration" });
    const before = trackerHistory(w.pmRoot);
    await assert.rejects(startRunCore(w.client, w.request), refused("eval_plan_drift"));
    assert.deepEqual(trackerHistory(w.pmRoot), before);
  } finally { process.chdir(testCwd); rmSync(w.root, { recursive: true, force: true }); }
});

test("causal candidate retries and preflight reject checkpoint drift without writing", async () => {
  const w = await causalWorkspace();
  try {
    for (const step of ["review", "plan", "run", "candidate"]) await causalStep(w, step);
    await w.client.update(w.plan.candidate, { fixedVersion: "different-checkpoint" });
    const before = trackerHistory(w.pmRoot);
    for (const preflight of [true, false]) await assert.rejects(registerGenerationCore(w.client, { ...w.generation, preflight }), refused("eval_plan_drift"));
    assert.deepEqual(trackerHistory(w.pmRoot), before);
    await w.client.update(w.plan.candidate, { fixedVersion: w.generation.baseCheckpoint });
    assert.equal((await registerGenerationCore(w.client, w.generation)).created, false);
  } finally { process.chdir(testCwd); rmSync(w.root, { recursive: true, force: true }); }
});

test("causal artifacts reject every cross-stage inversion and malformed or retrospectively added witnesses", async () => {
  const w = await causalWorkspace();
  try {
    for (const step of ["review", "plan", "run"]) await causalStep(w, step);
    await startRunCore(w.client, { ...w.request, id: "rl-extra" }); w.generation.collectionRuns.push("rl-extra");
    for (const step of ["candidate", "first", "last"]) await causalStep(w, step);
    const registered = (await readEvaluationPlan(w.client, w.plan.candidate))!;
    const artifacts = evaluationLifecycleArtifacts(registered, w.generation.collectionRuns, 2);
    await validateCausalEvaluationOrder(w.client, w.plan, artifacts);
    let inversions = 0;
    for (let a = 0; a < artifacts.length; a++) for (let b = a + 1; b < artifacts.length; b++) {
      const swapped = artifacts.map(entry => ({ ...entry }));
      [swapped[a].stage, swapped[b].stage] = [swapped[b].stage, swapped[a].stage];
      if (artifacts[a].stage === artifacts[b].stage) await validateCausalEvaluationOrder(w.client, w.plan, swapped);
      else { await assert.rejects(validateCausalEvaluationOrder(w.client, w.plan, swapped), refused("eval_plan_late")); inversions++; }
    }
    assert.equal(inversions, 20);
    await assert.rejects(causalStep({ ...w, request: { ...w.request, id: "rl-too-late" } }, "run"), refused("eval_plan_late"));
    await assert.rejects(causalStep({ ...w, request: { ...w.request, config: { changed: true } } }, "run"), refused("eval_plan_drift"));
    // Unrelated notes and metric appends are allowed; the single original causal note is immutable.
    await w.client.notes(w.request.id, { add: "Ordinary collection annotation" });
    const aliasRetry = await startRunCore(w.client, { ...w.request, id: w.request.id.toUpperCase(), evaluationCandidate: w.plan.candidate.toUpperCase() });
    assert.equal(aliasRetry.created, false);
    const originalRun = (await readCompleteLoopItem(w.client, w.request.id)).item;
    await w.client.update(w.request.id, { body: "Changed collection" });
    await assert.rejects(causalStep(w, "run"), refused("eval_plan_drift"));
    await w.client.update(w.request.id, { body: String(originalRun.body) });
    await validateCausalEvaluationOrder(w.client, w.plan, artifacts);
    const prefix = "pm-rl/evaluation-birth/1 ";
    const good = { comparison: w.comparison, nonce: "00000000-0000-4000-8000-000000000000", request: "0".repeat(64), stage: 0, predecessors: [] };
    const invalid = ["{", "null", "42", "[]", JSON.stringify({ ...good, extra: 1 }), JSON.stringify({ ...good, comparison: "bad" }), JSON.stringify({ ...good, request: "bad" }), JSON.stringify({ ...good, nonce: 1 }), JSON.stringify({ ...good, nonce: "bad" }), JSON.stringify({ ...good, stage: 0.5 }), JSON.stringify({ ...good, stage: -1 }), JSON.stringify({ ...good, predecessors: null })];
    for (const [i, text] of invalid.entries()) {
      const id = `rl-invalid-${i}`;
      await w.client.create({ id, type: "Decision", title: "Malformed witness", note: [prefix + text] });
      await assert.rejects(validateCausalEvaluationOrder(w.client, w.plan, [{ id, stage: 0 }]), refused("eval_plan_evidence"));
    }
    await w.client.create({ id: "rl-retroactive", type: "Decision", title: "Old evidence" });
    await w.client.notes("rl-retroactive", { add: prefix + JSON.stringify(good) });
    await assert.rejects(validateCausalEvaluationOrder(w.client, w.plan, [{ id: "rl-retroactive", stage: 0 }]), refused("eval_plan_evidence"));
    await w.client.notes("rl-review", { add: prefix + JSON.stringify(good) });
    await assert.rejects(readEvaluationPlan(w.client, w.plan.candidate), refused("eval_plan_evidence"));
  } finally { process.chdir(testCwd); rmSync(w.root, { recursive: true, force: true }); }
});

test("causal schema refuses unsupported protocols and approval retries retain a single native birth", async () => {
  const w = await causalWorkspace();
  try {
    assert.throws(() => parseEvaluationPlan({ ...w.plan, ordering: "future" }), refused("eval_plan_invalid"));
    assert.throws(() => parseEvaluationPlan({ ...w.plan, stopping: { ...w.plan.stopping, review: w.plan.candidate } }), refused("eval_plan_invalid"));
    await assert.rejects(createCausalEvaluationArtifact(w.client, w.plan, { id: "rl-not-scheduled" }, []), refused("eval_plan_invalid"));
    const fixed = { ...w.plan, stopping: { kind: "fixed", observations: 64, independent_units: 64 } };
    assert.throws(() => parseEvaluationPlan(fixed), refused("eval_plan_invalid"));
    const { ordering: _ordering, ...legacy } = w.plan;
    await assert.rejects(approveEvaluationPlan(w.client, legacy), refused("eval_plan_stopping"));
    await assert.rejects(registerEvaluationPlan(w.client, w.plan), refused("eval_plan_evidence"));
    await causalStep(w, "review"); const history = trackerHistory(w.pmRoot);
    await causalStep(w, "review"); assert.deepEqual(trackerHistory(w.pmRoot), history);
    await approveEvaluationPlan(w.client, { ...w.plan, candidate: "RL-CANDIDATE", incumbent: "RL-SEED", stopping: { ...w.plan.stopping, review: "RL-REVIEW" } });
    assert.deepEqual(trackerHistory(w.pmRoot), history);
    await causalStep(w, "plan");
    // A caller cannot adopt a native pre-existing Run into the new chronology.
    await w.client.create({ id: w.request.id, type: "Run", title: "Unwitnessed collection" });
    await assert.rejects(causalStep(w, "run"), refused("eval_plan_evidence"));
    await assert.rejects(causalStep({ ...w, request: { ...w.request, evaluationCandidate: "rl-no-plan" } }, "run"), refused("eval_plan_missing"));
    const options = { id: "rl-independent", title: "Wrong comparison", type: "Decision", note: ["Ordinary birth annotation"] };
    await createCausalEvaluationArtifact(w.client, w.plan, options, [{ id: options.id, stage: 0 }]);
    await assert.rejects(validateCausalEvaluationOrder(w.client, { ...w.plan, population: "Different" }, [{ id: options.id, stage: 0 }]), refused("eval_plan_late"));
    const future = { ...w.plan, candidate: "rl-already-born", stopping: { ...w.plan.stopping, review: "rl-late-review" } };
    await w.client.create({ id: future.candidate, type: "Generation", title: "Already exists" });
    await assert.rejects(approveEvaluationPlan(w.client, future), refused("eval_plan_late"));
    await w.client.delete(future.candidate, { force: true });
    await assert.rejects(approveEvaluationPlan(w.client, future), refused("eval_plan_late"));
    const next = { ...w.plan, candidate: "rl-next", stopping: { ...w.plan.stopping, review: "rl-next-review" } };
    await approveEvaluationPlan(w.client, next); await registerEvaluationPlan(w.client, next);
    await w.client.create({ id: "rl-next-evaluation-plan-look-1", type: "Decision", title: "Premature look" });
    await w.client.delete("rl-next-evaluation-plan-look-1", { force: true });
    await assert.rejects(startRunCore(w.client, { ...w.request, id: "rl-next-run", evaluationCandidate: next.candidate }), refused("eval_plan_late"));
  } finally { process.chdir(testCwd); rmSync(w.root, { recursive: true, force: true }); }
});

test("CLI approval collection and promotion use the causal SDK validator and preserve fixed plans", async () => {
  const w = await causalWorkspace();
  try {
    const file = join(w.root, "plan.json"); writeFileSync(file, JSON.stringify(w.plan));
    const approved = await w.harness.runCommand({ command: "rl eval plan approve", pmRoot: w.pmRoot, options: { file } });
    assert.equal((approved.result as RlCommandResult).id, "rl-review");
    await causalStep(w, "plan");
    const shown = await w.harness.runCommand({ command: "rl eval plan show", pmRoot: w.pmRoot, args: [w.plan.candidate] });
    assert.equal((shown.result as RlCommandResult).details!.ordering, "causal/1");
    await w.harness.runCommand({ command: "rl run start", pmRoot: w.pmRoot, args: [w.request.id], options: { environment: w.request.environmentId, algorithm: w.request.algorithm, evaluation_candidate: w.plan.candidate } });
    await causalStep(w, "candidate");
    for (const step of ["first", "last"]) await causalStep(w, step);
    const report = await readSequentialEvaluation(w.client, w.plan.candidate);
    assert.ok(report !== null && !("status" in report));
    const score = { objective: w.plan.objective, objective_version: w.plan.objective_version, evaluation_context: w.plan.evaluation_context, direction: w.plan.direction, seed_set: w.comparison, scale: 1, value: report.candidate_mean };
    await w.client.create({ id: "rl-budget", type: "Decision", title: "Promotion allowance", body: '```json\n{"permitted_promotions":1}\n```' });
    await promoteGenerationCore(w.client, { pmRoot: w.pmRoot, author: "lifecycle-test" }, w.plan.candidate, "rl-budget", { ...score, evaluation_context: "proxy" }, score, "Causal evaluation");
    assert.equal((await registerGenerationCore(w.client, { ...w.generation, preflight: true })).created, false);
    assert.equal((await registerGenerationCore(w.client, w.generation)).created, false);
    await w.client.notes("rl-review", { add: 'pm-rl/evaluation-birth/1 {}' });
    await assert.rejects(promoteGenerationCore(w.client, { pmRoot: w.pmRoot, author: "lifecycle-test" }, w.plan.candidate, "rl-budget", { ...score, evaluation_context: "proxy" }, score, "Retry"), refused("card_drift"));
    // The historical format still registers and collects through its original API.
    const { ordering: _ordering, ...legacy } = w.plan;
    const fixed = { ...legacy, candidate: "rl-fixed", stopping: { kind: "fixed", observations: 64, independent_units: 64 } };
    await registerEvaluationPlan(w.client, fixed);
    await assert.rejects(startRunCore(w.client, { ...w.request, id: "rl-fixed-run", evaluationCandidate: fixed.candidate }), refused("eval_plan_stopping"));
    await startRunCore(w.client, { ...w.request, id: "rl-fixed-run", evaluationCandidate: undefined });
    await registerGenerationCore(w.client, { ...w.generation, id: fixed.candidate, collectionRuns: ["rl-fixed-run"] });
    assert.equal((await readEvaluationPlan(w.client, fixed.candidate))!.plan.ordering, undefined);
    // The birth fields remain readable independently of a later promotion rewrite.
    assert.equal((await readCompleteLoopItem(w.client, w.plan.candidate, "1")).item.type, "Generation");
  } finally { process.chdir(testCwd); rmSync(w.root, { recursive: true, force: true }); }
});

test("causal validation hashes each birth once per call and never caches across validations", async (t) => {
  const w = await causalWorkspace();
  try {
    const artifacts = Array.from({ length: 8 }, (_, stage) => ({ id: `rl-digest-${stage}`, stage }));
    for (const [stage, entry] of artifacts.entries()) await createCausalEvaluationArtifact(w.client, w.plan, { id: entry.id, type: "Decision", title: "Cumulative checkpoint", body: "x".repeat(4096 * stage) }, artifacts.slice(0, stage + 1));
    const encodings: string[] = [];
    for (const entry of artifacts) encodings.push(canonicalJson((await readCompleteLoopItem(w.client, entry.id, "1", "id,type,body,affected_version,fixed_version,created_at,component,environment,notes")).item as unknown as JsonValue));
    const counts = new Map(encodings.map(text => [text, 0]));
    const update = Hash.prototype.update;
    const probe = t.mock.method(Hash.prototype, "update", function (this: Hash, ...args: Parameters<Hash["update"]>): Hash {
      const text = args[0];
      if (typeof text === "string" && counts.has(text)) counts.set(text, counts.get(text)! + 1);
      return update.apply(this, args);
    });
    try {
      for (const validation of [1, 2]) {
        await validateCausalEvaluationOrder(w.client, w.plan, artifacts);
        assert.deepEqual(encodings.map(text => counts.get(text)), artifacts.map((_, i) => i === artifacts.length - 1 ? 0 : validation), "Every predecessor birth must be hashed once per validation");
      }
    } finally { probe.mock.restore(); }
    await w.client.notes(artifacts[0].id, { add: 'pm-rl/evaluation-birth/1 {}' });
    await assert.rejects(validateCausalEvaluationOrder(w.client, w.plan, artifacts), refused("eval_plan_evidence"));
  } finally { process.chdir(testCwd); rmSync(w.root, { recursive: true, force: true }); }
});


test("causal operations read each validated birth once across creation validation and retry", async (t) => {
  const w = await causalWorkspace();
  try {
    const artifacts = Array.from({ length: 6 }, (_, stage) => ({ id: `rl-reads-${stage}`, stage }));
    const counts = new Map<string, number>();
    const get = w.client.get;
    // Observe calls while retaining every real SDK read and its native result.
    const probe = t.mock.method(w.client, "get", function (this: PmClient, ...args: Parameters<PmClient["get"]>) {
      if (args[1]?.fields === "id,type,body,affected_version,fixed_version,created_at,component,environment,notes") {
        const key = `${args[0]}:${args[1]?.at ?? "current"}`;
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
      return get.apply(this, args);
    });
    try {
      for (const [stage, entry] of artifacts.entries()) {
        const options = { id: entry.id, type: "Decision", title: "Observed native birth", body: "x".repeat(4096 * stage) };
        const chain = artifacts.slice(0, stage + 1);
        for (const operation of ["create", "validate", "retry", "verify"] as const) {
          counts.clear();
          if (operation === "validate") assert.equal(await validateCausalEvaluationOrder(w.client, w.plan, chain), undefined);
          else if (operation === "verify") await verifyCausalEvaluationRetry(w.client, w.plan, options, chain);
          else await createCausalEvaluationArtifact(w.client, w.plan, options, chain);
          const expected = operation === "create" ? chain.slice(0, -1) : chain;
          assert.deepEqual([...counts].sort(), expected.flatMap(row => [[`${row.id}:1`, 1], [`${row.id}:current`, 1]]).sort(), "Every native birth must be read once per causal operation");
        }
        // The internal retry surface also supports a target omitted from the ancestry list.
        await verifyCausalEvaluationRetry(w.client, w.plan, options, chain.slice(0, -1));
      }
      const prospective = (await readCompleteLoopItem(w.client, artifacts.at(-1)!.id)).item;
      counts.clear();
      await validateCausalEvaluationOrder(w.client, w.plan, artifacts, prospective);
      assert.equal(counts.has(`${prospective.id}:1`), false);
      await w.client.notes(artifacts[0].id, { add: "pm-rl/evaluation-birth/1 {}" });
      for (const operation of [() => validateCausalEvaluationOrder(w.client, w.plan, artifacts), () => createCausalEvaluationArtifact(w.client, w.plan, { id: "rl-next-birth" }, [...artifacts, { id: "rl-next-birth", stage: 7 }])]) await assert.rejects(operation, refused("eval_plan_evidence"));
    } finally { probe.mock.restore(); }
  } finally { process.chdir(testCwd); rmSync(w.root, { recursive: true, force: true }); }
});

for (const slot of ["candidate", "candidate-evaluation-plan-look-1", "candidate-evaluation-plan-look-2"]) {
  for (const alias of [false, true]) {
    test(`causal collection refuses reserved ${slot} ID (${alias ? "alias" : "canonical"}) without writes`, async () => {
      const w = await causalWorkspace();
      try {
        assert.equal(existsSync(join(w.root, ".git")), false, "Exercise the real SDK without Git");
        for (const step of ["review", "plan"]) await causalStep(w, step);
        const items = (await w.client.listAllComplete({ includeBody: true })).items;
        const history = trackerHistory(w.pmRoot);
        const id = alias ? slot.toUpperCase() : `rl-${slot}`;
        await assert.rejects(startRunCore(w.client, {
          ...w.request, id, evaluationCandidate: alias ? "CANDIDATE" : w.plan.candidate,
        }), refused("eval_plan_late"));
        assert.deepEqual((await w.client.listAllComplete({ includeBody: true })).items, items, "Refusal must preserve all item fields");
        assert.deepEqual(trackerHistory(w.pmRoot), history, "Refusal must precede every item/history write");
        // A nearby ID is not reserved, and its normalized retry keeps the same birth.
        const request = { ...w.request, id: `rl-${slot}-collection` };
        assert.equal((await startRunCore(w.client, request)).created, true);
        const admitted = trackerHistory(w.pmRoot);
        assert.equal((await startRunCore(w.client, { ...request, id: request.id.slice(3).toUpperCase() })).created, false);
        assert.deepEqual(trackerHistory(w.pmRoot), admitted);
        // The rejected request must leave both the candidate and all looks usable.
        const generation = { ...w.generation, collectionRuns: [request.id] };
        for (const step of ["candidate", "first", "last"]) await causalStep({ ...w, generation }, step);
        const report = await readSequentialEvaluation(w.client, w.plan.candidate);
        assert.ok(report !== null && !("status" in report));
        assert.equal(report.sequential?.look, 2);
      } finally { process.chdir(testCwd); rmSync(w.root, { recursive: true, force: true }); }
    });
  }
}
