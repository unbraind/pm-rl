/** Baseline-written identities and terminal evidence recover through real SDK trackers. */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { PmClient } from "@unbrained/pm-cli/sdk/core";
import { isPmCliExpectedError, normalizeItemId } from "@unbrained/pm-cli/sdk/runtime";
import { extractGenerationSpec, recordRefusedPolicyCard, loopProcessIdentityIO, promoteGenerationCore, readCompleteLoopItem, reconcileLoopPromotion, withProcessJobFence, withRlController, type JsonValue } from "../index.ts";
import { readEvaluationDecision } from "../evaluation-plan.ts";
import { recordSequentialEvaluation } from "../sequential-evaluation.ts";
import { discoverPolicyCards, recordPolicyCard, verifyRetainedGenerationEvidence } from "../policy-card.ts";
import { encodeEvent } from "../series.ts";
import { programmeStepName, preservedProgrammeId, programmeRequest, statePath, storedStateComponent } from "../state-boundary.ts";
import { processStaging, processJobBodyId } from "../process.ts";
import { decisionFixture } from "./fixtures/decision-evidence.ts";

/** Explicit allowlist keeps fixture executables independent of inherited SDK focus or credentials. */
function fixtureEnvironment(home: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ["PATH", "LANG", "LC_ALL", "TZ"]) if (process.env[key] !== undefined) env[key] = process.env[key];
  return { ...env, HOME: home, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", NPM_CONFIG_USERCONFIG: "/dev/null", GIT_CEILING_DIRECTORIES: tmpdir(), PM_LOCK_WAIT_MS: "0" };
}
/** Preserve native artifact timestamps exactly; their historical wall accounting is part of the baseline fixture. */
function copyNativeTracker(source: string, destination: string, env: NodeJS.ProcessEnv): void {
  execFileSync("cp", ["-a", source, destination], { env, stdio: "pipe", timeout: 900_000 });
}
/** Run baseline/current code with identical inputs; actual SDK results form the compatibility oracle. */
function drive(code: string, mode: string, corpus: string, env: NodeJS.ProcessEnv, runtime = process.execPath): void {
  execFileSync(runtime, ["test/fixtures/main-controller-compatibility.ts", mode, corpus], { cwd: code, env, stdio: "pipe", timeout: 900_000, maxBuffer: 4_194_304 });
}

test("origin main corpus: completed and interrupted controllers, loops, receipts and cards retain their identities", { timeout: 1_800_000 }, (t) => {
  const repo = fileURLToPath(new URL("../", import.meta.url));
  const root = mkdtempSync(join(tmpdir(), "rl-main-controller-corpus-")); const writer = join(root, "writer");
  const corpus = join(root, "corpus"); const env = fixtureEnvironment(join(root, "home"));
  let registered = false;
  try {
    if (lstatSync(join(repo, ".git"), { throwIfNoEntry: false }) === undefined) { t.skip("origin/main is absent from this source archive; use a Git checkout to run the baseline corpus"); return; }
    const base = spawnSync("git", ["rev-parse", "--verify", "--quiet", "refs/remotes/origin/main"], { cwd: repo, env, encoding: "utf8" });
    if (base.status === 1 && base.error === undefined && base.stderr === "") { t.skip("origin/main is missing; fetch the base branch to run the baseline corpus"); return; }
    assert.equal(base.status, 0, base.error?.message ?? base.stderr);
    execFileSync("git", ["worktree", "add", "--detach", writer, "origin/main"], { cwd: repo, env, stdio: "pipe" }); registered = true;
    symlinkSync(join(repo, "node_modules"), join(writer, "node_modules"), "dir");
    cpSync(join(repo, "test/fixtures/main-controller-compatibility.ts"), join(writer, "test/fixtures/main-controller-compatibility.ts"));
    // Creation is intentionally performed by origin/main, never the implementation under test.
    drive(writer, "write", corpus, env);
    const authored = JSON.parse(readFileSync(join(corpus, "corpus.json"), "utf8")) as { cases: { root: string }[] };
    assert.equal(authored.cases.length, 15, "the baseline must author every controller and loop case");
    for (const row of authored.cases) assert.equal(isAbsolute(row.root), false, "the oracle authors portable relative roots");
    for (const [name, implementation] of [["baseline", writer], ["current", repo]]) {
      const copy = join(root, name); copyNativeTracker(corpus, copy, env);
      const coverage = name === "current" && process.env.NODE_V8_COVERAGE !== undefined ? { NODE_V8_COVERAGE: process.env.NODE_V8_COVERAGE } : {};
      drive(implementation!, "exercise", copy, { ...env, ...coverage });
    }
    assert.deepEqual(JSON.parse(readFileSync(join(root, "current/results.json"), "utf8")), JSON.parse(readFileSync(join(root, "baseline/results.json"), "utf8")));
    // Bun's historical stat clock truncated fractional milliseconds. Both native
    // writers are compatibility oracles; never rewrite their recorded charges.
    const bun = execFileSync("/bin/sh", ["-c", "command -v bun || true"], { env, encoding: "utf8" }).trim();
    if (bun !== "") {
      const nodeBorn = join(root, "current"); drive(repo, "processes-read", nodeBorn, env, bun);
      const expected = (JSON.parse(readFileSync(join(root, "baseline/results.json"), "utf8")) as Record<string, unknown>[]).filter(row => row.job !== undefined);
      assert.deepEqual(JSON.parse(readFileSync(join(nodeBorn, "process-results.json"), "utf8")), expected);
      const born = join(root, "bun-born"); copyNativeTracker(corpus, born, env);
      drive(writer, "processes-reclock", born, env, bun);
      const baseline = JSON.parse(readFileSync(join(born, "process-results.json"), "utf8"));
      drive(repo, "processes-read", born, env); assert.deepEqual(JSON.parse(readFileSync(join(born, "process-results.json"), "utf8")), baseline);
      drive(repo, "processes-read", born, env, bun); assert.deepEqual(JSON.parse(readFileSync(join(born, "process-results.json"), "utf8")), baseline);
    }
    console.log(JSON.stringify({ main_written_cases: 15, prefixes: ["rl", "fleet", "rl-prefixed"], states: ["completed", "interrupted"], source: "native SDK read-back" }));
  } finally {
    if (registered) execFileSync("git", ["worktree", "remove", "--force", writer], { cwd: repo, env, stdio: "pipe" });
    rmSync(root, { recursive: true, force: true });
  }
});

/** Execute one missing lifecycle transition against its real tracker. */
async function sealedTransition(client: PmClient, pmRoot: string, fixture: Awaited<ReturnType<typeof decisionFixture>>, step: number): Promise<void> {
  const id = fixture.plan.candidate;
  if (step === 0) await recordPolicyCard(client, id);
  else if (step === 1) await client.notes("rl-collection", { add: encodeEvent({ step: 1, metric: "return", value: 0.75 }) });
  else if (step === 2) await recordSequentialEvaluation(client, id, fixture.rows);
  else if (step === 3) {
    const current = await readEvaluationDecision(client, id);
    const score = { ...fixture.score, value: current.report!.candidate_mean };
    await promoteGenerationCore(client, { pmRoot, author: "terminal-recovery-test" }, id, "rl-approval", { ...score, evaluation_context: "proxy" }, score, "Final sealed evaluation");
  } else if (step === 4) {
    await verifyRetainedGenerationEvidence(client, id);
    await reconcileLoopPromotion(client, { author: "terminal-recovery-test", guard: operation => withProcessJobFence({ pmRoot, author: "terminal-recovery-test" }, "terminal-recovery", operation) }, id);
    await recordPolicyCard(client, id);
  } else assert.fail("Unknown lifecycle transition");
}

test("terminal recovery ignores superseded candidate Run digests at every crash boundary but rejects final seal corruption", { timeout: 600_000 }, async () => {
  const fixture = await decisionFixture(false, false, false);
  const root = mkdtempSync(join(tmpdir(), "rl-terminal-crashes-"));
  try {
    let early: Awaited<ReturnType<typeof recordPolicyCard>> | undefined;
    // One durable workflow loses its process after every transition. A fresh SDK
    // client reads the actual preceding state before the next recovery action.
    for (let boundary = 0; boundary <= 5; boundary += 1) {
      const client = new PmClient({ cwd: fixture.root, pmRoot: fixture.pmRoot, author: "terminal-recovery-test", noExtensions: true });
      const decision = await readEvaluationDecision(client, fixture.plan.candidate);
      assert.equal(decision.report?.observations, boundary < 3 ? 16 : 64);
      if (boundary < 5) await sealedTransition(client, fixture.pmRoot, fixture, boundary);
      if (boundary === 0) early = (await discoverPolicyCards(client)).find(card => card.subject === fixture.plan.candidate && card.outcome === "candidate");
      if (boundary >= 4) await verifyRetainedGenerationEvidence(client, fixture.plan.candidate);
    }
    assert.ok(early);
    const client = new PmClient({ cwd: fixture.root, pmRoot: fixture.pmRoot, author: "terminal-recovery-test", noExtensions: true });
    const decision = await readEvaluationDecision(client, fixture.plan.candidate); assert.equal(decision.report?.sequential?.state, "sufficient");
    const generation = extractGenerationSpec(String((await readCompleteLoopItem(client, fixture.plan.candidate)).item.body), "Recovered terminal seal");
    assert.equal(generation.promoted, true); assert.equal(generation.evaluation_evidence?.digest, decision.evidence?.digest);
    const cards = (await discoverPolicyCards(client)).filter(card => card.subject === fixture.plan.candidate);
    assert.ok(cards.some(card => card.digest === early.digest)); assert.ok(cards.some(card => card.outcome === "promoted"));
    const before = (await readCompleteLoopItem(client, fixture.plan.candidate)).item.body;
    await sealedTransition(client, fixture.pmRoot, fixture, 4);
    assert.equal((await readCompleteLoopItem(client, fixture.plan.candidate)).item.body, before);
    assert.equal((await client.listAllComplete({ includeBody: true })).items.filter(item => item.type === "Generation" && extractGenerationSpec(String(item.body), "Promotion count").promoted).length, 1);
    for (const [name, target] of [["metrics", "rl-collection"], ["checkpoint", `${fixture.plan.candidate}-evaluation-plan-look-2`]]) {
      const copy = join(root, name!); cpSync(fixture.root, copy, { recursive: true });
      const peer = new PmClient({ cwd: copy, pmRoot: join(copy, ".agents/pm"), author: "terminal-corruption", noExtensions: true });
      if (name === "metrics") await peer.notes(target!, { add: encodeEvent({ step: 2, metric: "return", value: 0.25 }) });
      else await peer.update(target!, { affectedVersion: "damaged terminal dependency" });
      await assert.rejects(verifyRetainedGenerationEvidence(peer, fixture.plan.candidate), (error: unknown) => isPmCliExpectedError(error) && ["card_drift", "eval_plan_drift", "loop_generation_drift"].includes(String(error.context.code)) && error.context.item_id === target);
    }
    console.log(JSON.stringify({ durable_restart_boundaries: 6, corrupted_final_dependencies: 2, consumed_promotions: 1 }));
  } finally { rmSync(fixture.root, { recursive: true, force: true }); rmSync(root, { recursive: true, force: true }); }
});

/** V1 logical names retain their spelling; only SDK equality decides whether two references address one record. */
test("500 stored step-name variants preserve birth identities and refuse ambiguous or damaged native receipts", async () => {
  assert.equal(loopProcessIdentityIO.exec(process.execPath, ["-p", "1 + 1"]).trim(), "2");
  let seed = 0x107c0de;
  for (let index = 0; index < 500; index += 1) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const root = ["rl-prefixed", "Mixed", "outer-step-inner", "Évaluation", "e\u0301valuation"][seed % 5]!;
    const phase = index % 2 === 0 ? "Evaluate" : "record-step-Result";
    const key = `${root}-step-${phase}`;
    assert.equal(programmeStepName(key, "rl", root, phase), root);
    assert.equal(programmeStepName(key, "rl", root), root);
    for (const alias of [root.toUpperCase(), `#${root}`, root.normalize("NFC"), root.normalize("NFD"), ` ${root} `]) {
      const same = normalizeItemId(root, "rl") === normalizeItemId(alias, "rl");
      assert.equal(programmeStepName(key, "rl", alias, phase.toLowerCase()), same ? root : null);
    }
    assert.equal(programmeStepName(key, "rl", `${root}-other`, phase), null);
    assert.equal(programmeStepName(key, "rl", root, `${phase}-other`), null);
  }
  for (const key of ["unrelated", "-step-end", "parent-step-child-STEP-Evaluate"]) assert.equal(programmeStepName(key, "rl", "parent-step-child", "Evaluate"), null);
  const w = await decisionFixture(false, false, false);
  try {
    for (const legacy of ["UPPER-job", " padded-job "]) {
      const path = statePath(w.pmRoot, "runtime", "pm-rl", "jobs", storedStateComponent(legacy)); mkdirSync(path, { recursive: true });
      assert.equal(processStaging(w.pmRoot, legacy), path);
      assert.equal(processJobBodyId(JSON.stringify({ format: "pm-rl/process-job/1", id: legacy })), legacy);
    }
    for (const value of [null, undefined, 2, [], { value: ".." }]) assert.throws(() => statePath(w.pmRoot, value as never), isPmCliExpectedError);
    assert.throws(() => storedStateComponent(`${" ".repeat(256)}x`), isPmCliExpectedError);
    const raw = { id: "rl-new-controller", approval: "approval" };
    assert.deepEqual(await programmeRequest(w.client, raw), raw);
    const coordinates = { pmRoot: w.pmRoot, author: "compatibility-test" }; const input = { stable: 1 };
    await withRlController(w.client, coordinates, { id: "Mixed", approval: "rl-approval", recoveryCommand: "resume compatibility controller" }, new AbortController().signal, async step => step("Programme", input, async () => ({ value: 7 })));
    assert.equal(await preservedProgrammeId(w.client, "rl-mixed"), "Mixed");
    const id = "rl-mixed-step-programme"; const original = (await readCompleteLoopItem(w.client, id)).item;
    assert.equal((JSON.parse(String(original.body)) as { key: string }).key, "Mixed-step-Programme");
    for (const alias of ["#MIXED", " rl-MIXED "]) {
      assert.equal(await preservedProgrammeId(w.client, alias), "Mixed");
      await withRlController(w.client, coordinates, { id: alias, approval: "rl-approval", recoveryCommand: "resume compatibility controller" }, new AbortController().signal, async step => step("Programme", input, async () => assert.fail("SDK alias re-executed a completed operation")));
      assert.equal((await readCompleteLoopItem(w.client, id)).item.body, original.body);
    }
    const changed = JSON.parse(String(original.body)) as Record<string, JsonValue>;
    changed.key = "Mixed-step-programme"; await w.client.update(id, { body: JSON.stringify(changed) });
    assert.equal(await preservedProgrammeId(w.client, "rl-mixed"), "Mixed");
    await assert.rejects(withRlController(w.client, coordinates, { id: "mixed", approval: "rl-approval", recoveryCommand: "resume compatibility controller" }, new AbortController().signal, async step => step("programme", input, async () => assert.fail("completed operation ran"))), (error: unknown) => isPmCliExpectedError(error) && error.context.code === "loop_step_drift");
    await w.client.update(id, { body: String(original.body) });
    const get = w.client.get.bind(w.client);
    w.client.get = ((id, options) => get(id, { ...options, outputBudget: "1", outputLimit: "1" })) as PmClient["get"];
    try { await assert.rejects(preservedProgrammeId(w.client, "mixed"), (error: unknown) => isPmCliExpectedError(error) && error.context.code === "provenance_read_retryable"); }
    finally { Object.assign(w.client, { get }); }
    w.client.get = ((id, options) => get(id, { ...options, at: "-1" })) as PmClient["get"];
    try { await assert.rejects(preservedProgrammeId(w.client, "mixed"), (error: unknown) => isPmCliExpectedError(error) && error.exitCode !== 3); }
    finally { Object.assign(w.client, { get }); }
    for (const [name, body] of [["foreign", "not a package record"], ["wrong-key", JSON.stringify({ format: "pm-rl/loop-step/1", key: "another-step-programme" })]]) {
      await w.client.create({ id: `${name}-step-programme`, title: "Foreign receipt slot", type: "Decision", body });
      assert.equal(await preservedProgrammeId(w.client, name!), name);
      assert.equal((await readCompleteLoopItem(w.client, `${name}-step-programme`)).item.body, body);
    }
  } finally { rmSync(w.root, { recursive: true, force: true }); }
});

/** A preflight reader must attribute a committed peer promotion instead of relabeling it as statistical drift. */
test("promotion preflight reports a peer winner truthfully without charging a second promotion", async () => {
  const w = await decisionFixture(false, false);
  const peer = new PmClient({ cwd: w.root, pmRoot: w.pmRoot, author: "promotion-peer", noExtensions: true });
  const get = w.client.get.bind(w.client); let injected = false; let approvalRead = false;
  const proxy = { ...w.score, evaluation_context: "proxy" };
  w.client.get = (async (...args) => {
    const result = await get(...args);
    if (args[0] === "rl-approval") approvalRead = true;
    if (!injected && approvalRead && args[0] === w.plan.candidate && args[1]?.at === undefined) {
      injected = true;
      await promoteGenerationCore(peer, { pmRoot: w.pmRoot, author: "promotion-peer" }, w.plan.candidate, "rl-approval", proxy, w.score, "Peer promotion");
    }
    return result;
  }) as PmClient["get"];
  try {
    await assert.rejects(promoteGenerationCore(w.client, { pmRoot: w.pmRoot, author: "promotion-writer" }, w.plan.candidate, "rl-approval", proxy, w.score, "Losing request"), (error: unknown) => isPmCliExpectedError(error) && error.context.code === "already_promoted");
    assert.ok(injected);
    const promoted = extractGenerationSpec(String((await readCompleteLoopItem(peer, w.plan.candidate)).item.body), "Peer outcome");
    assert.equal(promoted.promoted, true); assert.equal(promoted.promotion_evidence, "Peer promotion");
    assert.equal((await peer.listAllComplete({ includeBody: true })).items.filter(item => item.type === "Generation" && extractGenerationSpec(String(item.body), "Promotion count").promoted).length, 1);
  } finally { Object.assign(w.client, { get }); rmSync(w.root, { recursive: true, force: true }); }
});

/** A current snapshot can become stale immediately before its certified terminal history is read. */
test("terminal history race preserves a peer rejection during preflight", async () => {
  const base = await decisionFixture(false, false, false); const root = mkdtempSync(join(tmpdir(), "rl-terminal-history-race-"));
  try {
    const sealedRoot = join(root, "sealed"); cpSync(base.root, sealedRoot, { recursive: true });
    const sealer = new PmClient({ cwd: sealedRoot, pmRoot: join(sealedRoot, ".agents/pm"), author: "history-peer", noExtensions: true });
    await recordRefusedPolicyCard(sealer, base.plan.candidate, "Peer terminal rejection");
    const sealed = String((await readCompleteLoopItem(sealer, base.plan.candidate)).item.body);
    for (const edge of ["before", "after"]) {
      const copy = join(root, edge); cpSync(base.root, copy, { recursive: true });
      const coordinates = { cwd: copy, pmRoot: join(copy, ".agents/pm"), noExtensions: true };
      const client = new PmClient({ ...coordinates, author: "history-writer" }); const peer = new PmClient({ ...coordinates, author: "history-peer" });
      const run = client.run.bind(client); let injected = false;
      client.run = (async (...args) => {
        const options = args[1] as { id?: string } | undefined;
        const inject = !injected && args[0] === "history" && options?.id === base.plan.candidate && new Error().stack?.includes("verifyTerminalEvaluationReceipt");
        if (inject) injected = true;
        if (inject && edge === "before") await peer.update(base.plan.candidate, { body: sealed });
        const result = await run(...args);
        if (inject && edge === "after") await peer.update(base.plan.candidate, { body: sealed });
        return result;
      }) as PmClient["run"];
      try { assert.equal(await recordRefusedPolicyCard(client, base.plan.candidate, "Stale local rejection"), "refused"); }
      finally { Object.assign(client, { run }); }
      assert.ok(injected, edge); assert.equal(String((await readCompleteLoopItem(peer, base.plan.candidate)).item.body), sealed);
      await verifyRetainedGenerationEvidence(peer, base.plan.candidate);
      assert.equal((await readEvaluationDecision(peer, base.plan.candidate)).report?.observations, 16);
    }
  } finally { rmSync(base.root, { recursive: true, force: true }); rmSync(root, { recursive: true, force: true }); }
});
