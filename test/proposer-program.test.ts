/** Behavioral controls use real SDK trackers, child processes and independent exact-count oracles. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test, before, after } from "node:test";
import { Readable, Writable } from "node:stream";
import { spawnSync, execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, mkdtempSync, symlinkSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PmClient } from "@unbrained/pm-cli/sdk/core";
import { isPmCliExpectedError } from "@unbrained/pm-cli/sdk/runtime";
import { createExtensionTestHarness } from "@unbrained/pm-cli/sdk/testing";
import extension, { hashJson, readCompleteLoopItem, withRlController, type JsonValue, type RlCommandResult } from "../index.ts";
import { initialProposer, proposerArtifact, parseProposerProgram, parseProposalInvocation, parseProposalCode, executeProposal, verifyProposalExecution, mutateProposer, ProposerRefusal, type ProposalInvocation, type ProposalExpression, type ProposerProgram } from "../proposer-program.ts";
import { executeProposer, proposerProcessInput, proposerEvolutionConfiguration, parseProposerEvolutionConfig, proposalLearner, proposerEvaluationPlan, selectProposer, runProposerEvolution, advanceProposer, auditProposer, compareProposerSearch, proposerFitUpdates, PROPOSER_ALLOWANCE } from "../proposer-evolution.ts";
import { proposerWorkerArgv, proposerWorkerMain, runProposerWorker } from "../proposer-worker.ts";
import { evaluatePlan } from "../evaluation-plan.ts";
import { reserveSearchCapacity } from "../meta.ts";
import { IMPROVER_ROLES, type ImproverTask, type ImproverDataset } from "../improver-data.ts";
import { compareImprovers, proposalCurriculum } from "../improver-environment.ts";
import { listProcessJobs, executeProcessTrainer, launchTrainer, processJobId, processStaging, validateProcessCompletion, readProcessJob, verifyCompletedProcessJob, reserveProcessJob, transitionProcessJob, processDigest, RESOURCE_KEYS, verifiedProcessPolicy, type ProcessCompletion, type ProcessInput } from "../process.ts";
import { runRecursiveImprover, improverConfiguration } from "../recursive-improver.ts";
import { processWorkspace } from "./fixtures/process-workspace.ts";

const originalPath = process.env.PATH; const originalCeiling = process.env.GIT_CEILING_DIRECTORIES;
const noGit = mkdtempSync(join(tmpdir(), "proposer-no-git-"));
before(() => {
  symlinkSync(process.execPath, join(noGit, "node")); const clock = process.platform === "linux" ? "getconf" : "ps";
  symlinkSync(execFileSync("/bin/sh", ["-c", `command -v ${clock}`], { encoding: "utf8" }).trim(), join(noGit, clock));
  process.env.PATH = noGit; process.env.GIT_CEILING_DIRECTORIES = tmpdir();
});
after(() => {
  if (originalPath === undefined) delete process.env.PATH; else process.env.PATH = originalPath;
  if (originalCeiling === undefined) delete process.env.GIT_CEILING_DIRECTORIES; else process.env.GIT_CEILING_DIRECTORIES = originalCeiling;
  rmSync(noGit, { recursive: true, force: true });
});

/** Bound both sides of every test to one declared eight-arm domain. */
function invocation(program = initialProposer()): ProposalInvocation { return { program, role: "development", counts: Array.from({ length: 8 }, (_, arm) => ({ arm, wins: 0, trials: 0 })), seed: 0, count: 1 }; }
/** Generous synthetic capacity isolates semantic failures from resource exhaustion. */
async function workspace() {
 const w = await processWorkspace({ training_steps: 10000, wall_ms: 100_000_000, storage_bytes: 100_000_000, compute_units: 100_000_000, tokens: 0 });
 const body = String((await w.client.get(w.approval)).item.body);
 await w.client.update(w.approval, { body: body.replace('"permitted_promotions":2', '"permitted_promotions":10000,"meta_budget":{"training_samples":10000000,"proposal_calls":10000,"recipe_promotions":10000}') });
 return w;
}
/** Construct sealed train/evaluation compartments whose identities cannot overlap. */
function dataset(root: string): string {
  const directory = join(root, "dataset"); mkdirSync(directory);
  const splits: Record<string, { digest: string; tasks: number }> = {};
  for (const role of IMPROVER_ROLES) {
    const rows = Array.from({ length: 8 }, (_, index) => ({ id: `${role}-row-${index}`, prediction_at: index, available_at: index, label: index % 2 as 0 | 1, prefix: { words: [index % 2], events: ["create"], fields: [], elapsed_ms: 0, authors: 1 } }));
    const tasks: ImproverTask[] = [{ id: `${role}-task`, repo: `public-fixture/${role}`, commit: "a".repeat(40), target: "issue-type", cutoff: 4, threshold_ms: null, train: rows.slice(0, 4), evaluation: rows.slice(4) }];
    writeFileSync(join(directory, `${role}.json`), JSON.stringify(tasks)); splits[role] = { digest: hashJson(tasks as unknown as JsonValue), tasks: 1 };
  }
  const record = { format: "pm-rl/improver-dataset/1", seed: 0, sources: IMPROVER_ROLES.map((role) => ({ role, repo: `public-fixture/${role}`, commit: "a".repeat(40) })), splits, omitted: [] };
  writeFileSync(join(directory, "improver-dataset.json"), JSON.stringify({ ...record, digest: hashJson(record as unknown as JsonValue) })); return directory;
}
/** Independent positive-control outcomes: a chosen strategy's real instruction earns bounded utility. */
function controlledComparison(parent: ProposerProgram, before: number, after: number) {
  const members = Array.from({ length: 256 }, (_, index) => ({ id: `task-${index}`, repo: `tracker-${index}`, target: index % 2 ? "kind" : "duration" }));
  const plan = proposerEvaluationPlan("control", parent, members, "control-context", 100);
  return evaluatePlan(plan, members.map(({ id }) => ({ id, candidate: after, incumbent: before })));
}

test("strict program schema permits canonical producer outputs and refuses undeclared capabilities before effects", () => {
  const original = initialProposer(); assert.deepEqual(parseProposerProgram(original), original);
  for (const value of [null, [], {}, { ...original, format: "other" }, { ...original, generation: 0 }, { ...original, parent: "wrong" }, { ...original, digest: "bad" }, { ...original, evaluation: [] }]) assert.throws(() => parseProposerProgram(value), ProposerRefusal);
  for (const value of [NaN, Infinity, -Infinity, "1", 0, 4, 0.5, Number.MAX_VALUE]) assert.throws(() => parseProposalCode({ ...original.code, order: value }), ProposerRefusal);
  for (const field of ["score", "select", "feature", "curriculum"]) assert.throws(() => parseProposalCode({ ...original.code, [field]: "host-code" }), ProposerRefusal);
  let expression: ProposalExpression = { op: "rate" }; for (let i = 0; i < 4; i++) expression = { op: "multiply", left: expression, right: { op: "novelty" } };
  assert.throws(() => proposerArtifact({ ...original.code, score: expression }), ProposerRefusal);
  assert.throws(() => proposerArtifact(original.code, 2, "bad"), ProposerRefusal);
  const base = invocation();
  for (const value of [{ ...base, role: "audit" }, { ...base, counts: [] }, { ...base, counts: new Array(8) }, { ...base, counts: base.counts.map((row) => ({ ...row, arm: 0 })) }, { ...base, counts: base.counts.map((row) => ({ ...row, wins: 1 })) }, { ...base, count: 9 }, { ...base, seed: -1 }]) assert.throws(() => parseProposalInvocation(value), ProposerRefusal);
  assert.throws(() => mutateProposer(base), ProposerRefusal);
  const execution = executeProposal(base);
  assert.deepEqual(verifyProposalExecution(execution, base), execution);
  for (const output of [{ ...execution, digest: "bad" }, { ...execution, instructions: new Array(1) }, { ...execution, instructions: [] }, { ...execution, instructions: [{ ...execution.instructions[0], arm: Infinity }] }, { ...execution, instructions: [{ ...execution.instructions[0], arm: 2 }] }]) assert.throws(() => verifyProposalExecution(output, base), ProposerRefusal);
  const config = proposerEvolutionConfiguration(); assert.deepEqual(parseProposerEvolutionConfig(config), config);
  for (const value of [null, [], {}, { ...config, extra: true }, { ...config, initial: proposerArtifact(original.code, 100, original.digest) }, ...["generations", "candidates", "updates", "seed", "timeout_ms"].flatMap((key) => [NaN, Infinity, -1, 1.1, Number.MAX_SAFE_INTEGER].map((value) => ({ ...config, [key]: value })))]) assert.throws(() => parseProposerEvolutionConfig(value), ProposerRefusal);
  assert.equal(parseProposerEvolutionConfig({ ...config, seed: 0 }).seed, 0);
});

test("500 seeded sequences round-trip programs, replay old inputs and compare native SDK read-back against the reference model", { timeout: 600_000 }, async () => {
  const w = await workspace(); let seed = 0x41c0ffee;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed; };
  const focus = await w.client.create({ id: "ambient", type: "Task", title: "Ambient focus", unset: ["parent", "sprint", "release", "assignee"] }); await w.client.focus(focus.item.id);
  const model = new Map<string, { program: ProposerProgram; native: Awaited<ReturnType<typeof readCompleteLoopItem>>["item"] }>();
  for (let index = 0; index < 8; index++) await w.client.schemaAddStatus(`custom-${index}`, { role: [index % 2 ? "active" : "blocked"] });
  for (let sequence = 0; sequence < 500; sequence++) {
    const initial = initialProposer(); const snapshots: ProposerProgram[] = [initial];
    for (let operation = 0; operation < 4; operation++) {
      const old = snapshots[random() % snapshots.length];
      const code = { ...old.code, score: ({ op: ["rate", "novelty", "zero"][random() % 3] } as ProposalExpression), select: random() % 2 ? "rank" as const : "cycle" as const };
      const next = proposerArtifact(code, old.generation + 1, old.digest); snapshots.push(next);
      const text = JSON.stringify(next, null, random() % 3).replaceAll("\n", "\r\n"); assert.deepEqual(parseProposerProgram(JSON.parse(` \r\n${text}\n `)), next);
      const counts = invocation(next).counts.map((row) => { const trials = random() % 1_000_001; return { arm: row.arm, trials, wins: random() % (trials + 1) }; });
      const request = { ...invocation(next), counts, seed: random(), count: 1 + random() % 8 }; const out = executeProposal(request); verifyProposalExecution(JSON.parse(JSON.stringify(out)), request);
      if (next.code.score.op === "rate" && next.code.select === "rank") {
        const ordered = [...counts].sort((a,b) => { const d = BigInt(a.wins) * BigInt(Math.max(1,b.trials)) - BigInt(b.wins) * BigInt(Math.max(1,a.trials)); return d > 0 ? -1 : d < 0 ? 1 : (a.arm + 8 - request.seed % 8) % 8 - (b.arm + 8 - request.seed % 8) % 8; });
        assert.equal(out.instructions[0].arm, ordered[0].arm);
      }
    }
    const selected = snapshots[random() % snapshots.length]; const identity = `model-${sequence % 8}`;
    const replay = async (artifact: ProposerProgram) => withRlController(w.client, w.coordinates, { id: identity, approval: w.approval, recoveryCommand: "resume" }, AbortSignal.timeout(60_000), async (step) => step("programme", artifact as unknown as JsonValue, async () => artifact as unknown as JsonValue));
    if (!model.has(identity)) {
      await replay(selected); const read = await readCompleteLoopItem(w.client, `${identity}-step-programme`);
      assert.equal(read.item.parent, undefined); assert.deepEqual(JSON.parse(String(read.item.body)).result, selected);
      model.set(identity, { program: selected, native: structuredClone(read.item) });
    }
    const reference = model.get(identity)!;
    // Model applies external native mutations through the SDK's own normalizer, then package replay must preserve them.
    if (sequence % 25 === 0) {
      await w.client.update(reference.native.id, { title: ` Sequence ${sequence}\r\nannotation `, description: ` description ${random()} `, tags: `seed-${random()%4}`, status: `custom-${random()%8}`, parent: focus.item.id, goal: `goal-${random()%3}`, objective: `objective-${random()%3}`, sprint: `sprint-${random()%3}`, release: `release-${random()%3}`, assignee: "synthetic-agent", reviewer: "synthetic-reviewer" });
      await w.client.update(reference.native.id, { dep: [`id=${focus.item.id},kind=related`] });
      reference.native = structuredClone((await readCompleteLoopItem(w.client, reference.native.id)).item);
    }
    await replay(reference.program); assert.deepEqual((await readCompleteLoopItem(w.client, reference.native.id)).item, reference.native);
    if (selected.digest !== reference.program.digest) await assert.rejects(replay(selected), /disagrees|drift/);
    assert.deepEqual((await readCompleteLoopItem(w.client, reference.native.id)).item, reference.native);
  }
  console.log(JSON.stringify({ sequences: 500, randomized_operations: 2000, sdk_state_replays: 500, ambient_focus: true }));
});

test("isolated positive control promotes changed executable strategies through two recursive generations", { timeout: 180_000 }, async () => {
  const w = await workspace(); let retained = initialProposer(); const receipts = [];
  const utility = (arm: number) => arm === 4 ? 1 : arm === 2 ? 0.5 : 0;
  for (let generation = 1; generation <= 2; generation++) {
    const counts = invocation().counts.map((row) => ({ ...row, trials: generation === 2 && row.arm === 4 ? 0 : 100, wins: row.arm === 2 ? generation === 1 ? 100 : 2 : 0 }));
    const input = { ...invocation(retained), counts }; const candidate = mutateProposer(input);
    const before = await executeProposer(w.client, w.coordinates, w.approval, `control-${generation}-before`, input);
    const after = await executeProposer(w.client, w.coordinates, w.approval, `control-${generation}-after`, { ...input, program: candidate });
    const comparison = controlledComparison(retained, utility(before.instructions[0].arm), utility(after.instructions[0].arm));
    assert.equal(compareImprovers(candidate.digest, retained.digest, utility(after.instructions[0].arm), utility(before.instructions[0].arm), 256, "inner-control").verdict.decision, "promote");
    const selected = selectProposer(retained, candidate, before, after, comparison); assert.equal(selected.promoted, true);
    const metadata = proposerArtifact(retained.code, retained.generation + 1, retained.digest);
    assert.equal(selectProposer(retained, metadata, before, after, comparison).promoted, false);
    assert.equal(selectProposer(retained, candidate, before, before, comparison).promoted, false);
    assert.throws(() => selectProposer(candidate, retained, before, after, comparison), ProposerRefusal);
    receipts.push({ generation, before: before.instructions[0].arm, after: after.instructions[0].arm, parent: retained.digest, candidate: candidate.digest, promoted: selected.promoted }); retained = selected.retained;
  }
  const jobs = await listProcessJobs(w.client); assert.equal(jobs.length, 4); assert.ok(jobs.every((job) => job.charge.training_steps === 0 && job.charge.tokens === 0 && job.settled));
  assert.equal(proposerFitUpdates({ ...jobs[0], binding: { recovery_attempt: 1 } }, 64), 128);
  assert.throws(() => proposerFitUpdates(null, 64), /recovery accounting/); assert.throws(() => proposerFitUpdates({ ...jobs[0], binding: {} }, 64), /recovery accounting/);
  const initial = initialProposer(); const rejected = controlledComparison(initial, 1, 0); const accepted = controlledComparison(initial, 0, 1);
  const lineage = advanceProposer([initial, initial], retained); assert.equal(lineage[0], initial); assert.deepEqual(advanceProposer(lineage, retained), lineage);
  assert.deepEqual(auditProposer(lineage, rejected), { retained: initial, rollback: true }); assert.deepEqual(auditProposer(lineage, accepted), { retained, rollback: false }); assert.equal(auditProposer([initial,initial], rejected).rollback, false);
  const plan = proposerEvaluationPlan("budget", initial, [{ id: "a", repo: "r", target: "t" }], "ctx", 2);
  const search = { execution: executeProposal(invocation()), scores: [{ id: "a", mean: 0 }], counts: invocation().counts, jobs: [], optimizer_updates: 1 };
  assert.equal(compareProposerSearch(plan, search, { ...search, optimizer_updates: 2 }).verdict.decision, "refuse");
  console.log(JSON.stringify({ recursive_positive_control: receipts, proposal_processes: jobs.length, independent_units_per_generation: 256, optimizer_updates_per_contender: 0, inference_tokens: 0 }));
});

test("cohort limits, cross-role contamination, approval and dataset drift refuse before dependent effects", { timeout: 180_000 }, async () => {
  const w = await workspace(); const directory = dataset(w.root); const config = { ...proposerEvolutionConfiguration(), generations: 1, candidates: 1, updates: 1 };
  const request = { id: "guards", approval: w.approval, dataset: directory, config };
  await assert.rejects(reserveSearchCapacity(w.client, w.coordinates, request, "binding", { training_samples: Infinity, proposal_calls: 1, recipe_promotions: 1 }, 1), /nonnegative safe integer/);
  await assert.rejects(executeProposer(w.client, w.coordinates, w.approval, "invalid", { ...invocation(), role: "audit" } as unknown as ProposalInvocation), ProposerRefusal);
  const original = JSON.parse(readFileSync(join(directory, "improver-dataset.json"), "utf8")) as ImproverDataset;
  const tasks = JSON.parse(readFileSync(join(directory, "meta.json"), "utf8")) as ImproverTask[];
  const reseal = (rows: ImproverTask[]) => { const { digest: _, ...record } = original; const updated = { ...record, splits: { ...record.splits, meta: { tasks: rows.length, digest: hashJson(rows as unknown as JsonValue) } } }; writeFileSync(join(directory, "meta.json"), JSON.stringify(rows)); writeFileSync(join(directory, "improver-dataset.json"), JSON.stringify({ ...updated, digest: hashJson(updated as unknown as JsonValue) })); };
  reseal(Array.from({ length: 257 }, (_, index) => ({ ...tasks[0], id: `meta-${index}` })));
  await assert.rejects(runProposerEvolution(w.client, w.coordinates, request), /256 tasks/); assert.equal((await listProcessJobs(w.client)).length, 0);
  reseal([{ ...tasks[0], train: tasks[0].train.map((row, index) => index === 0 ? { ...row, id: "development-row-0" } : row) }]);
  await assert.rejects(runProposerEvolution(w.client, w.coordinates, request), /occurs across compartments/);
  reseal(tasks);
  const empty = await w.client.create({ id: "empty-capacity", type: "Decision", title: "No promotion capacity", unset: ["parent"], body: String((await w.client.get(w.approval)).item.body).replace('"permitted_promotions":10000', '"permitted_promotions":0') });
  await assert.rejects(runProposerEvolution(w.client, w.coordinates, { ...request, approval: empty.item.id }), /meta_promotion_budget_exhausted/);
  const task = await w.client.create({ id: "not-approval", type: "Task", title: "Wrong approval type", unset: ["parent"] });
  await assert.rejects(runProposerEvolution(w.client, w.coordinates, { ...request, approval: task.item.id }), /resource budget in a Decision/);
  await assert.rejects(runProposerEvolution(w.client, w.coordinates, { ...request, signal: AbortSignal.abort(new Error("cancelled")) }), /cancelled/);
  await assert.rejects(runProposerEvolution(w.client, w.coordinates, { ...request, onStep(key) { if (key === "programme") { const { digest: _, ...record } = original; const next = { ...record, seed: 1 }; writeFileSync(join(directory, "improver-dataset.json"), JSON.stringify({ ...next, digest: hashJson(next as unknown as JsonValue) })); } } }), /Approval or dataset changed/);
  assert.equal((await listProcessJobs(w.client)).length, 0);
});

test("worst-case process budget refuses every underfunded dimension before the controller lease", { timeout: 180_000 }, async () => {
  const w = await workspace(); const directory = dataset(w.root);
  const config = { ...proposerEvolutionConfiguration(), generations: 1, candidates: 1, updates: 64 };
  // Independent oracle: five fits, each with two attempts, plus five interpreters.
  // Process steps count fits, whereas meta training_samples count optimizer updates.
  const required = { training_steps: 10, wall_ms: 450_000, storage_bytes: 122_880, compute_units: 450_000, tokens: 0 };
  const original = String((await w.client.get(w.approval)).item.body);
  for (const key of RESOURCE_KEYS.filter((key) => key !== "tokens")) {
    const spec = JSON.parse(/```json\n([\s\S]+?)\n```/u.exec(original)![1]);
    spec.resource_budget = { ...required, [key]: required[key] - 1 };
    await w.client.update(w.approval, { body: `\`\`\`json\n${JSON.stringify(spec)}\n\`\`\`` });
    const request = { id: `underfunded-${key}`, approval: w.approval, dataset: directory, config, onStep() { throw new Error("Underfunded run reached execution"); } };
    // A real live lease proves refusal precedence even though a released lease leaves no item.
    await withRlController(w.client, w.coordinates, { ...request, recoveryCommand: "inspect retained controller" }, new AbortController().signal, async () => {
      const before = (await w.client.listAllComplete({ includeBody: true })).items;
      let transitions = 0;
      await assert.rejects(runProposerEvolution(w.client, { ...w.coordinates, onTransition() { transitions++; } }, request),
        (error) => isPmCliExpectedError(error) && error.context.code === "process_budget_exhausted" && error.message.includes(key));
      assert.deepEqual((await w.client.listAllComplete({ includeBody: true })).items, before, "refusal must not create a controller, reservation or job");
      assert.equal(transitions, 0);
      assert.equal((await listProcessJobs(w.client)).length, 0);
    });
  }
});

test("approval documentation declares the shared headroom formula and retained lifetime", () => {
  const documentation = readFileSync(new URL("../docs/proposer-programs.md", import.meta.url), "utf8");
  assert.match(documentation, /`permitted_promotions` must cover `fits \+ config\.generations`/);
  assert.match(documentation, /fits = config\.candidates \* \(config\.generations \* \(development\.tasks \+ 2 \* meta\.tasks\) \+ 2 \* audit\.tasks\)/);
  assert.match(documentation, /reservation remains held after completion,\nrefusal, interruption and replay; the search never refunds it/);
});

test("retained proposal checkpoint and receipt failures are actionable typed process refusals", { timeout: 180_000 }, async () => {
  const w = await workspace(); const request = invocation(); const input = proposerProcessInput("receipt-replay", request);
  await executeProposer(w.client, w.coordinates, w.approval, "receipt-replay", request);
  const job = (await listProcessJobs(w.client))[0]; const directory = processStaging(w.pmRoot, job.id, true);
  const checkpoint = join(directory, "checkpoint.json"); const receipt = join(directory, "completion.json"); const runner = join(directory, "runner.json");
  const originalCheckpoint = readFileSync(checkpoint); const originalReceipt = readFileSync(receipt); const originalRunner = readFileSync(runner);
  const refusal = (error: unknown) => isPmCliExpectedError(error) && error.context.code === "process_checkpoint_invalid" && /Restore the original retained files/.test(error.message);
  const completionTime = (JSON.parse(originalRunner.toString()).started_at + job.completion!.usage.wall_ms) / 1000;
  const restore = () => { writeFileSync(checkpoint, originalCheckpoint); writeFileSync(receipt, originalReceipt); writeFileSync(runner, originalRunner); utimesSync(receipt, completionTime, completionTime); };
  try {
    // Keep the outer byte digest valid so only deterministic proposal replay can reject the altered checkpoint.
    const damaged = JSON.stringify({ ...executeProposal(request), digest: "sha256:" + "0".repeat(64) });
    const saved = JSON.parse(originalReceipt.toString()) as ProcessCompletion;
    writeFileSync(checkpoint, damaged);
    writeFileSync(receipt, JSON.stringify({ ...saved, digest: `sha256:${createHash("sha256").update(damaged).digest("hex")}` }));
    assert.throws(() => verifiedProcessPolicy(job, w.pmRoot, input), refusal);
    restore();
    writeFileSync(receipt, JSON.stringify({ ...saved, policy: { ...saved.policy, digest: "sha256:" + "0".repeat(64) } }));
    await assert.rejects(executeProposer(w.client, w.coordinates, w.approval, "receipt-replay", request), refusal);
    restore();
    for (const file of [checkpoint, runner]) {
      rmSync(file); assert.throws(() => verifiedProcessPolicy(job, w.pmRoot, input), refusal); restore();
    }
    writeFileSync(receipt, "{"); assert.throws(() => verifiedProcessPolicy(job, w.pmRoot, input), refusal); restore();
    // Existing typed failures keep their classification, including a missing completion and byte corruption.
    rmSync(receipt);
    assert.throws(() => verifiedProcessPolicy(job, w.pmRoot, input), (error) => isPmCliExpectedError(error) && error.context.code === "process_receipt_required"); restore();
    writeFileSync(checkpoint, "{}");
    assert.throws(() => verifiedProcessPolicy(job, w.pmRoot, input), (error) => isPmCliExpectedError(error) && error.context.code === "process_checkpoint_invalid" && /content digest/.test(error.message));
  } finally { restore(); }
  assert.deepEqual(validateProcessCompletion(directory, job.id, input, job.allowance, w.pmRoot).policy, executeProposal(request));
  assert.deepEqual(await executeProposer(w.client, w.coordinates, w.approval, "receipt-replay", request), executeProposal(request));
  assert.equal((await listProcessJobs(w.client)).length, 1, "receipt failures must not launch another proposal job");
});

test("proposal staging setup IO failures retain settled evidence and give a typed remedy", async () => {
  const w = await workspace(); const request = invocation(); const input = proposerProcessInput("blocked-staging", request);
  const id = processJobId(input, proposerWorkerArgv("."), { kind: "process-bandit", allowance: PROPOSER_ALLOWANCE });
  const directory = processStaging(w.pmRoot, id); mkdirSync(dirname(directory), { recursive: true }); writeFileSync(directory, "blocked staging");
  await assert.rejects(executeProposer(w.client, w.coordinates, w.approval, "blocked-staging", request),
    (error) => isPmCliExpectedError(error) && error.context.code === "process_callback_failed" && /Restore tracker and staging access/.test(error.message));
  const job = await readProcessJob(w.client, id); assert.equal(job!.state, "failed"); assert.equal(job!.settled, true);
  assert.equal(readFileSync(directory, "utf8"), "blocked staging");
});

test("proposer dataset verification and IO failures give typed recovery instructions before dependent work", { timeout: 180_000 }, async () => {
  const w = await workspace(); const directory = dataset(w.root); const manifest = join(directory, "improver-dataset.json"); const tasks = join(directory, "meta.json");
  const originalManifest = readFileSync(manifest); const originalTasks = readFileSync(tasks);
  const request = { id: "dataset-io", approval: w.approval, dataset: directory, config: { ...proposerEvolutionConfiguration(), generations: 1, candidates: 1, updates: 1 } };
  const refusal = (error: unknown) => isPmCliExpectedError(error) && error.context.code === "proposer_dataset_invalid" && /Restore the original sealed dataset/.test(error.message);
  const before = (await w.client.listAllComplete({ includeBody: true })).items;
  for (const file of [manifest, tasks]) {
    const original = readFileSync(file);
    try {
      rmSync(file); await assert.rejects(runProposerEvolution(w.client, w.coordinates, request), refusal);
      writeFileSync(file, "{}"); await assert.rejects(runProposerEvolution(w.client, w.coordinates, request), refusal);
    } finally { writeFileSync(file, original); }
    assert.deepEqual((await w.client.listAllComplete({ includeBody: true })).items, before);
  }
  try {
    rmSync(manifest); symlinkSync(tasks, manifest);
    await assert.rejects(runProposerEvolution(w.client, w.coordinates, request), (error) => isPmCliExpectedError(error) && error.context.code === "rl_state_path_invalid");
  } finally { rmSync(manifest); writeFileSync(manifest, originalManifest); }
  for (const file of [manifest, tasks]) {
    try {
      await assert.rejects(runProposerEvolution(w.client, w.coordinates, { ...request, id: file === manifest ? "manifest-recheck" : "tasks-recheck", onStep(key) { if (key === "programme") rmSync(file); } }), refusal);
    } finally { writeFileSync(manifest, originalManifest); writeFileSync(tasks, originalTasks); }
  }
  assert.equal((await listProcessJobs(w.client)).length, 0);
});

test("proposer approval verification failures are typed before reservation or process effects", { timeout: 180_000 }, async () => {
  const w = await workspace(); const directory = dataset(w.root);
  const original = String((await w.client.get(w.approval)).item.body);
  const spec = JSON.parse(/```json\n([\s\S]+?)\n```/u.exec(original)![1]) as Record<string, unknown>;
  const request = { id: "approval-invalid", approval: w.approval, dataset: directory, config: { ...proposerEvolutionConfiguration(), generations: 1, candidates: 1, updates: 1 } };
  for (const body of ["not an approval", "```json\n{\n```", "```json\n{}\n```", "```json\n" + JSON.stringify({ ...spec, meta_budget: { training_samples: -1, proposal_calls: 1, recipe_promotions: 1 } }) + "\n```" ]) {
    await w.client.update(w.approval, { body });
    const before = (await w.client.listAllComplete({ includeBody: true })).items;
    await assert.rejects(runProposerEvolution(w.client, w.coordinates, request),
      (error) => isPmCliExpectedError(error) && error.context.code === "proposer_approval" && /restore the original approved Decision/.test(error.message));
    assert.deepEqual((await w.client.listAllComplete({ includeBody: true })).items, before);
  }
  await w.client.update(w.approval, { body: original });
  // Existing typed capacity refusals still pass through the same wrapper unchanged.
  await w.client.update(w.approval, { body: original.replace('"permitted_promotions":10000', '"permitted_promotions":0') });
  await assert.rejects(runProposerEvolution(w.client, w.coordinates, request),
    (error) => isPmCliExpectedError(error) && error.context.code === "meta_promotion_budget_exhausted");
  assert.equal((await listProcessJobs(w.client)).length, 0);
});

test("worker IO, feature transforms and curricula use the shipped schema and process protocol", { timeout: 180_000 }, async () => {
  const w = await workspace(); const request = invocation(); let output = "";
  const input: ProcessInput = { identity: {}, source: { digest: request.program.digest, weight: 0 }, training: [], observations: [], training_config: { learning_rate: 0, steps: 0 }, lineage: {}, proposal: request };
  const directory = join(w.root, "worker"); mkdirSync(directory);
  const stream = new Writable({ write(chunk, _encoding, callback) { output += String(chunk); callback(); } });
  await runProposerWorker(Readable.from([JSON.stringify({ job: "fixture", input })]), stream, directory); assert.equal(JSON.parse(output).type, "complete");
  await proposerWorkerMain([process.execPath, "absent-entry"], import.meta.url);
  const second = join(w.root, "worker-two"); mkdirSync(second);
  await proposerWorkerMain([process.execPath, import.meta.filename], import.meta.url, Readable.from([JSON.stringify({ job: "fixture", input })]), stream, second);
  await assert.rejects(runProposerWorker(Readable.from(["x".repeat(65_537)]), stream, second), /input_limit/);
  assert.ok(proposerWorkerArgv(".").includes("--permission")); assert.ok(proposerWorkerArgv(".", new URL("../dist/proposer-worker.js", import.meta.url).href).at(-1)!.endsWith(".js"));
  for (const feature of ["inherit", "events", "words", "timing"] as const) assert.equal(proposalLearner({ arm: 2, feature, order: 3, curriculum: "balanced" }).prefix.ngram_order, 3);
  const rows = (JSON.parse(readFileSync(join(dataset(w.root), "development.json"), "utf8")) as ImproverTask[])[0].train;
  assert.deepEqual(proposalCurriculum(rows, "reverse"), [...rows].reverse()); assert.deepEqual(proposalCurriculum(rows, "seeded"), rows);
  assert.equal(proposalCurriculum(rows.filter((row) => row.label === 0), "balanced").length, 2);
  assert.equal(proposalCurriculum(rows, "balanced").length, 4);
  const mult = proposerArtifact({ ...initialProposer().code, select: "rank", score: { op: "multiply", left: { op: "rate" }, right: { op: "novelty" } } }); executeProposal({ ...invocation(mult), counts: request.counts.map((row) => ({ ...row, wins: row.arm, trials: 10 })) });
  for (const invalid of [{ ...input, prefix: {} }, { ...input, lm: {} }, { ...input, training: [{}] }, { ...input, observations: [{}] }, { ...input, training_config: { learning_rate: 0, steps: 1 } }]) await assert.rejects(executeProcessTrainer(w.client, w.coordinates, invalid as ProcessInput, w.approval, { kind: "process-bandit", allowance: PROPOSER_ALLOWANCE }), /capabilit|development counts/);
  await assert.rejects(executeProcessTrainer(w.client, w.coordinates, input, w.approval, { kind: "compose-bandit", image: `sha256:${"a".repeat(64)}`, allowance: PROPOSER_ALLOWANCE }), /capabilit|development counts/);
  const malformed = join(w.root, "malformed-worker"); mkdirSync(malformed);
  const wire = { type: "complete", job: "fixture", receipt: { policy: executeProposal(request), usage: PROPOSER_ALLOWANCE, forbidden: true } };
  await assert.rejects(launchTrainer(malformed, "fixture", input, PROPOSER_ALLOWANCE, [process.execPath, "-e", `process.stdout.write(${JSON.stringify(JSON.stringify(wire)+"\n")})`]), /sealed capability/);
  const permissions = proposerWorkerArgv(".").slice(1, -1);
  const outside = join(w.root, "evaluation-sentinel"); writeFileSync(outside, "synthetic evaluation data");
  for (const source of [`require('node:fs').readFileSync(${JSON.stringify(outside)})`, `require('node:fs').writeFileSync('forbidden','data')`, "require('node:child_process').spawnSync(process.execPath,['-e','0'])"]) {
    const result = spawnSync(process.execPath, [...permissions, "-e", source], { cwd: malformed, env: {}, encoding: "utf8" }); assert.notEqual(result.status, 0); assert.match(result.stderr, /ERR_ACCESS_DENIED/);
  }
});

test("full non-git controller refuses unsupported evidence, retains programs, resumes and exposes compact CLI output", { timeout: 300_000 }, async () => {
  const w = await workspace(); const directory = dataset(w.root); const config = { ...proposerEvolutionConfiguration(), generations: 1, candidates: 1, updates: 1 };
  const approval = String((await w.client.get(w.approval)).item.body);
  const spec = JSON.parse(/```json\n([\s\S]+?)\n```/u.exec(approval)![1]);
  spec.permitted_promotions = 6;
  spec.resource_budget = { training_steps: 10, wall_ms: 450_000, storage_bytes: 122_880, compute_units: 450_000, tokens: 0 };
  await w.client.update(w.approval, { body: `\`\`\`json\n${JSON.stringify(spec)}\n\`\`\`` });
  const steps: string[] = []; const request = { id: "evolve", approval: w.approval, dataset: directory, config, onStep(key: string) { steps.push(key); } };
  const report = await runProposerEvolution(w.client, w.coordinates, request);
  assert.equal(report.retained.digest, config.initial.digest); assert.equal(report.generations[0].promoted, false); assert.equal(report.audit.verdict.decision, "refuse"); assert.equal(report.budget.fits, 5);
  assert.deepEqual(await runProposerEvolution(w.client, w.coordinates, request), report);
  assert.equal((await listProcessJobs(w.client)).length, 10);
  const reservation = JSON.parse(String((await w.client.get("evolve-reservation")).item.body));
  assert.equal(reservation.promotion_headroom, report.budget.fits + config.generations);
  await assert.rejects(reserveSearchCapacity(w.client, w.coordinates, { id: "competing-search", approval: w.approval }, "other", { training_samples: 0, proposal_calls: 0, recipe_promotions: 0 }, 1, false, true), /meta_promotion_budget_exhausted/);
  const harness = await createExtensionTestHarness(extension, { name: "pm-rl", capabilities: ["commands", "hooks", "schema"] });
  const file = join(w.root, "program.json"); writeFileSync(file, JSON.stringify(config));
  const result = await harness.runCommand({ pmRoot: w.pmRoot, command: "rl proposer run", args: ["evolve"], options: { file, dataset: directory, approval: w.approval }, global: { json: true } }).then((r) => r.result) as RlCommandResult;
  assert.ok(Buffer.byteLength(JSON.stringify(result)) < 2000);
  const validated = await harness.runCommand({ pmRoot: w.pmRoot, command: "rl proposer validate", options: { file } }).then((r) => r.result) as RlCommandResult; assert.equal(validated.details!.valid, true);
  writeFileSync(file, "{}"); await assert.rejects(harness.runCommand({ pmRoot: w.pmRoot, command: "rl proposer validate", options: { file } }), /proposer_invalid/);
  await assert.rejects(harness.runCommand({ pmRoot: w.pmRoot, command: "rl proposer run", args: ["invalid"], options: { file, dataset: directory, approval: w.approval } }), /proposer_invalid/);
  await assert.rejects(harness.runCommand({ pmRoot: w.pmRoot, command: "rl proposer validate", options: { file: join(w.root, "missing") } }));
  await assert.rejects(harness.runCommand({ pmRoot: w.pmRoot, command: "rl proposer run", args: ["invalid"], options: { file: join(w.root, "missing"), dataset: directory, approval: w.approval } }));
  const peer = new PmClient({ cwd: w.root, pmRoot: w.pmRoot, author: "peer", noExtensions: true });
  await assert.rejects(runProposerEvolution(w.client, w.coordinates, { ...request, onStep: async () => { await peer.update(w.approval, { body: "changed approval" }); } }), /proposer_drift|Approval or dataset changed/);
  console.log(JSON.stringify({ controller_steps: steps.length, fits: report.budget.fits, process_jobs: 10, promotions: 0, non_git: true, compact_json_bytes: Buffer.byteLength(JSON.stringify(result)) }));
});

test("CLI recovery guards reject unusable identities for both flag spellings before effects", async () => {
  const w = await workspace(); const directory = dataset(w.root);
  const file = join(w.root, "program.json"); writeFileSync(file, JSON.stringify(proposerEvolutionConfiguration()));
  const harness = await createExtensionTestHarness(extension, { name: "pm-rl", capabilities: ["commands", "hooks", "schema"] });
  for (const flag of ["force_takeover", "forceTakeover"]) {
    await assert.rejects(harness.runCommand({ pmRoot: w.pmRoot, command: "rl proposer run", args: ["../invalid"], options: { file, dataset: directory, approval: w.approval, [flag]: true } }), (error) => isPmCliExpectedError(error) && error.context.code === "rl_identifier_invalid");
  }
  assert.equal((await listProcessJobs(w.client)).length, 0);
});

test("proposal reservation and publication interleave ordinary peers at every transaction step boundary", { timeout: 180_000 }, async () => {
  const w = await workspace(); const peer = new PmClient({ pmRoot: w.pmRoot, cwd: w.root, author: "competing-agent", noExtensions: true }); let cases = 0;
  for (const phase of ["reserve", "advance"] as const) for (const boundary of ["prepared", "step_applied", "step_recorded", "committing", "committed"] as const) {
    const input = proposerProcessInput(`race-${cases++}`, invocation()); const adapter = { kind: "process-bandit" as const, allowance: PROPOSER_ALLOWANCE };
    const id = processJobId(input, proposerWorkerArgv("."), adapter); const nativeId = `rl-${id}`;
    const job = phase === "advance" ? await reserveProcessJob(w.client, w.coordinates, id, input, w.approval, PROPOSER_ALLOWANCE) : null;
    let injected = false; let retained = "";
    // Use the real coordinator seam; no SDK method is replaced or mocked.
    const operationCoordinates = { ...w.coordinates, async onTransition(context: { transition: string }) {
      if (context.transition !== boundary || injected) return; injected = true;
      let current; try { current = await readCompleteLoopItem(peer, nativeId); } catch (error) { if (!isPmCliExpectedError(error)) throw error; }
      if (current === undefined) await peer.create({ id: nativeId, type: "Task", title: "Foreign reservation", body: "Foreign evidence", unset: ["parent"] });
      else { const body = JSON.parse(String(current.item.body)); await peer.update(nativeId, { body: JSON.stringify({ ...body, input: processDigest({ peer: boundary }) }) }); }
      retained = String((await readCompleteLoopItem(peer, nativeId)).item.body);
    } };
    await assert.rejects(phase === "reserve" ? reserveProcessJob(w.client, operationCoordinates, id, input, w.approval, PROPOSER_ALLOWANCE) : transitionProcessJob(w.client, operationCoordinates, job!, "running", "launch"));
    assert.equal(injected, true); assert.equal((await readCompleteLoopItem(peer, nativeId)).item.body, retained);
  }
  await peer.create({ id: "foreign", type: "Task", tags: "rl-process-job", title: "Foreign tagged record", body: "not a package receipt", unset: ["parent"] });
  assert.equal(await readProcessJob(peer, "foreign"), null);
  for (const boundary of ["prepared", "step_applied", "step_recorded", "committing", "committed"] as const) {
    const id = `search-race-${cases++}`; const key = `rl-${id}-reservation`; let injected = false; let retained = "";
    await assert.rejects(reserveSearchCapacity(w.client, { ...w.coordinates, async onTransition(context) {
      if (context.transition !== boundary || injected) return; injected = true;
      let current; try { current = await readCompleteLoopItem(peer, key); } catch (error) { if (!isPmCliExpectedError(error)) throw error; }
      if (current === undefined) await peer.create({ id: key, type: "Decision", title: "Foreign search reservation", body: "Peer evidence", unset: ["parent"] });
      else { const body = JSON.parse(String(current.item.body)); await peer.update(key, { body: JSON.stringify({ ...body, binding: "peer" }) }); }
      retained = String((await readCompleteLoopItem(peer, key)).item.body);
    } }, { id, approval: w.approval }, "bound-program", { training_samples: 10, proposal_calls: 5, recipe_promotions: 1 }, 6));
    assert.equal(injected, true); assert.equal((await readCompleteLoopItem(peer, key)).item.body, retained);
  }
  console.log(JSON.stringify({ interleaving_cases: cases, boundaries_per_path: 5, paths: ["reservation", "publication", "search-capacity"], ordinary_sdk_peer: true, non_git: true }));
});


test("controller crash/resume revalidates every retained proposal evidence field before dependent work", { timeout: 600_000 }, async (t) => {
  for (const field of ["checkpoint", "checkpoint-digest", "receipt-json", "receipt-policy", "receipt-lineage", "receipt-usage", "runner", "durable-digest", "durable-charge"] as const) await t.test(field, async () => {
    const w = await workspace(); const directory = dataset(w.root);
    const request = { id: "replay", approval: w.approval, dataset: directory, config: { ...proposerEvolutionConfiguration(), generations: 1, candidates: 1, updates: 1 } };
    await assert.rejects(runProposerEvolution(w.client, w.coordinates, { ...request, onStep(key) { if (key === "g1-d-propose") throw new Error("simulated interruption"); } }), /simulated interruption/);
    const [job] = await listProcessJobs(w.client); assert.ok(job.completion);
    const staging = processStaging(w.pmRoot, job.id, true); const checkpoint = join(staging, "checkpoint.json"); const receipt = join(staging, "completion.json");
    const saved = JSON.parse(readFileSync(receipt, "utf8")) as ProcessCompletion;
    if (field === "checkpoint") writeFileSync(checkpoint, "damaged checkpoint");
    if (field === "checkpoint-digest") {
      const damaged = JSON.stringify({ ...saved.policy, digest: "sha256:" + "0".repeat(64) });
      writeFileSync(checkpoint, damaged); writeFileSync(receipt, JSON.stringify({ ...saved, digest: `sha256:${createHash("sha256").update(damaged).digest("hex")}` }));
    }
    if (field === "receipt-json") writeFileSync(receipt, "{");
    if (field === "receipt-policy") writeFileSync(receipt, JSON.stringify({ ...saved, policy: { ...saved.policy, digest: "stale" } }));
    if (field === "receipt-lineage") writeFileSync(receipt, JSON.stringify({ ...saved, lineage: {} }));
    if (field === "receipt-usage") writeFileSync(receipt, JSON.stringify({ ...saved, usage: { ...saved.usage, tokens: 1 } }));
    if (field === "runner") writeFileSync(join(staging, "runner.json"), JSON.stringify({ started_at: 0 }));
    if (field.startsWith("durable-")) {
      const item = await readCompleteLoopItem(w.client, job.id); const record = JSON.parse(String(item.item.body));
      if (field === "durable-digest") record.completion.digest = "sha256:" + "0".repeat(64);
      else record.charge.compute_units += 1;
      await w.client.update(item.item.id, { body: JSON.stringify(record) });
    }
    const steps: string[] = [];
    await assert.rejects(runProposerEvolution(w.client, w.coordinates, { ...request, onStep(key) { steps.push(key); if (key === "g1-d-propose") throw new Error("unverified proposal replay passed"); } }), (error) => isPmCliExpectedError(error));
    assert.ok(!steps.includes("g1-d-t0-c0"), "damaged evidence must refuse before a dependent fit");
    assert.equal((await w.client.listAllComplete({ includeBody: true })).items.filter((item) => item.tags?.includes("rl-process-job")).length, 1, "replay must never reserve replacement work");
  });
});

test("both RSI controllers revalidate learner checkpoints on crash/resume and allow unchanged evidence", { timeout: 600_000 }, async (t) => {
  for (const controller of ["proposer", "improver"] as const) for (const damaged of [true, false]) await t.test(`${controller}-${damaged ? "damaged" : "unchanged"}`, async () => {
    const w = await workspace(); const directory = dataset(w.root); const id = "resume";
    const run = (onStep?: (key: string) => void) => controller === "proposer"
      ? runProposerEvolution(w.client, w.coordinates, { id, approval: w.approval, dataset: directory, config: { ...proposerEvolutionConfiguration(), generations: 1, candidates: 1, updates: 1 }, onStep })
      : runRecursiveImprover(w.client, w.coordinates, { id, approval: w.approval, dataset: directory, config: { ...improverConfiguration(), generations: 1, candidates: 1, updates: 1 }, onStep });
    await assert.rejects(run((key) => { if (key === "g1-d-t0-c0") throw new Error("simulated interruption"); }), /simulated interruption/);
    const jobs = await listProcessJobs(w.client); const fit = jobs.find((job) => job.completion?.artifact !== undefined)!; assert.ok(fit);
    if (damaged) {
      writeFileSync(join(processStaging(w.pmRoot, fit.id, true), "checkpoint.json"), "damaged checkpoint");
      await assert.rejects(run((key) => { if (key === "g1-d-t0-c0") throw new Error("unverified fit replay passed"); }), (error) => isPmCliExpectedError(error));
      assert.equal((await listProcessJobs(w.client)).length, jobs.length);
    } else {
      const next = controller === "proposer" ? "g1-mutation" : "g1-update";
      await assert.rejects(run((key) => { if (key === next) throw new Error("unchanged evidence verified"); }), /unchanged evidence verified/);
      assert.deepEqual(await listProcessJobs(w.client), jobs, "unchanged replay preserves every job and charge");
    }
  });
});

test("read-only process replay refuses missing or incomplete jobs without launching replacements", { timeout: 180_000 }, async () => {
  const w = await workspace(); const input = proposerProcessInput("read-only", invocation()); const argv = proposerWorkerArgv("."); const adapter = { kind: "process-bandit" as const, allowance: PROPOSER_ALLOWANCE };
  const verify = () => verifyCompletedProcessJob(w.client, w.pmRoot, input, w.approval, adapter, argv);
  await assert.rejects(verify(), (error) => isPmCliExpectedError(error) && error.context.code === "process_job_drift");
  assert.equal((await listProcessJobs(w.client)).length, 0);
  await reserveProcessJob(w.client, w.coordinates, processJobId(input, argv, adapter), input, w.approval, PROPOSER_ALLOWANCE);
  await assert.rejects(verify(), (error) => isPmCliExpectedError(error) && error.context.code === "process_job_drift");
  assert.equal((await listProcessJobs(w.client))[0].state, "planned");
  await executeProposer(w.client, w.coordinates, w.approval, "read-only", invocation());
  const job = (await listProcessJobs(w.client))[0]; const item = await w.client.get(job.id); const original = String(item.item.body);
  try {
    await w.client.update(item.item.id, { body: JSON.stringify({ ...job, state: "planned" }) });
    await assert.rejects(verify(), (error) => isPmCliExpectedError(error) && error.context.code === "process_job_drift");
    await w.client.update(item.item.id, { body: JSON.stringify({ ...job, settled: false, allowance: job.charge }) });
    await assert.rejects(verifyCompletedProcessJob(w.client, w.pmRoot, input, w.approval, { ...adapter, allowance: job.charge }, argv),
      (error) => isPmCliExpectedError(error) && error.context.code === "process_job_drift");
  } finally { await w.client.update(item.item.id, { body: original }); }
});


test("controller refuses a sealed cached proposal that disagrees with the verified execution", { timeout: 180_000 }, async () => {
  const w = await workspace(); const directory = dataset(w.root); const config = { ...proposerEvolutionConfiguration(), generations: 1, candidates: 1, updates: 1 };
  const request = { id: "cached", approval: w.approval, dataset: directory, config };
  await assert.rejects(runProposerEvolution(w.client, w.coordinates, { ...request, onStep(key) { if (key === "programme") throw new Error("simulated interruption"); } }), /simulated interruption/);
  const manifest = JSON.parse(readFileSync(join(directory, "improver-dataset.json"), "utf8")) as ImproverDataset;
  const binding = hashJson({ config: config as unknown as JsonValue, dataset: manifest.digest, approval: String((await w.client.get(w.approval)).item.body) });
  const input = { ...invocation(config.initial), seed: config.seed };
  await withRlController(w.client, w.coordinates, { ...request, recoveryCommand: "resume" }, AbortSignal.timeout(60_000), (step) => step("g1-d-propose", { binding, input: input as unknown as JsonValue }, async () => {
    const execution = await executeProposer(w.client, w.coordinates, w.approval, "cached-g1-d", input);
    return { ...execution, digest: "stale" } as unknown as JsonValue;
  }));
  await assert.rejects(runProposerEvolution(w.client, w.coordinates, { ...request, onStep(key) { if (key === "g1-d-propose") throw new Error("unverified cached proposal replay passed"); } }),
    (error) => isPmCliExpectedError(error) && error.context.code === "process_job_drift" && /Cached proposal/.test(error.message));
  assert.equal((await listProcessJobs(w.client)).length, 1);
});
