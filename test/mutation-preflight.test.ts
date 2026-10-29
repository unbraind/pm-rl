/** Expected refusals cannot allocate tracker identities, history, capacity or journals. */
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { test } from "node:test";
import { PmClient } from "@unbrained/pm-cli/sdk/core";
import { init, isPmCliExpectedError } from "@unbrained/pm-cli/sdk/runtime";
import { createExtensionTestHarness } from "@unbrained/pm-cli/sdk/testing";
import { listMutationEvents } from "@unbrained/pm-cli/sdk";
import extension, { hashJson, generationProvenance, promoteGenerationCore, readCompleteLoopItem, runRlLoop, withValidatedMutation, type JsonValue, type RlCommandResult } from "../index.ts";
import { evaluationComparison, registerEvaluationPlan, recordPlanEvaluation, type EvaluationPlan } from "../evaluation-plan.ts";
import { recordSequentialEvaluation } from "../sequential-evaluation.ts";
import { recordPolicyCard, recordRecursivePolicyCards } from "../policy-card.ts";
import { decisionFixture } from "./fixtures/decision-evidence.ts";
import { allowance, processWorkspace, trainingInput } from "./fixtures/process-workspace.ts";
import { reserveProcessJob, processJobId, transitionProcessJob } from "../process.ts";
import { metaWorkspace, metaConfig, metaSpec } from "./fixtures/meta-workspace.ts";
import { runRlMeta } from "../meta.ts";
import { registerShadowDeployment, observeShadow, compareShadow, shadowInputDigest, type ShadowDeployment } from "../shadow.ts";
import type { GenerationSpec } from "../lineage.ts";
import { collectCheckpointArtifacts } from "../checkpoint-artifacts.ts";

/** Exact file bytes, including all native histories, counters, reservations and transaction journals. */
function durableBytes(root: string): Record<string, string> {
  const result: Record<string, string> = {};
  /** Read this disposable tracker only; SDK read-delivery observations and renewable leases are not domain writes. */
  function visit(directory: string): void {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(directory, entry.name); const name = relative(root, path);
      if (name === "locks" || name === join("runtime", "context-usage.jsonl") || /^runtime[/\\](?:metadata-cache(?:[.-]|$)|history-event-index\.sqlite(?:-|$))/.test(name)) continue;
      if (entry.isDirectory()) visit(path);
      else result[name] = readFileSync(path).toString("base64");
    }
  }
  visit(root); return result;
}
/** Compare actual bytes, with no parsing, normalization, compensation or history deletion. */
async function refusesUnchanged(root: string, execute: () => Promise<unknown>, code?: string): Promise<void> {
  // Materialize SDK read indexes before the baseline. No expected state is
  // derived from handwritten parsing or normalization of the native documents.
  const client = new PmClient({ pmRoot: root, author: "preflight-test", noExtensions: true });
  const listed = await client.listAllComplete({ includeBody: true });
  for (const item of listed.items) await client.get(item.id, { full: true, outputBudget: "unbounded", outputLimit: "unbounded" });
  await listMutationEvents({ pmRoot: root, limit: 1000 });
  const before = durableBytes(root);
  let refused = false;
  let failure: unknown;
  try {
    const result = await execute();
    // The public harness returns structured handler failures for released
    // assertion-based commands; new evaluation APIs throw typed SDK errors.
    if (code === undefined && result !== null && typeof result === "object" && "handled" in result && result.handled === false && "errorMessage" in result && typeof result.errorMessage === "string" && result.errorMessage.length > 0) refused = true;
  } catch (error) {
    failure = error; refused = true;
  }
  const after = durableBytes(root);
  assert.deepEqual(Object.keys({ ...before, ...after }).filter(path => before[path] !== after[path]), [], "refusal wrote durable tracker bytes");
  assert.ok(refused, "operation must refuse invalid input");
  if (failure !== undefined) {
    assert.ok(isPmCliExpectedError(failure), String(failure));
    if (code !== undefined) assert.equal(failure.context.code, code);
  }
}

test("prospective fixed and sequential chronology refuses before consuming the candidate identity", async () => {
  const root = mkdtempSync(join(tmpdir(), "rl-prospective-refusal-"));
  try {
    const { path: pmRoot } = await init("rl", { defaults: true, author: "preflight-test", agentGuidance: "skip" }, { cwd: root });
    const client = new PmClient({ cwd: root, pmRoot, author: "preflight-test", noExtensions: true });
    const harness = await createExtensionTestHarness(extension, { name: "pm-rl", capabilities: ["commands", "schema", "hooks"] });
    const file = join(root, "environment.json");
    writeFileSync(file, JSON.stringify({ name: "preflight", version: "1", task_suite: ["task"], reward_specification: { goal: 1 } }));
    const environment = ((await harness.runCommand({ command: "rl env register", pmRoot, options: { file } })).result as RlCommandResult).id!;
    await harness.runCommand({ command: "rl generation register", pmRoot, args: ["rl-seed"], options: { baseCheckpoint: "checkpoint" } });
    const incumbent = (await readCompleteLoopItem(client, "rl-seed")).item;
    await client.create({ id: "rl-old-run", type: "Run", title: "Collected before declaration", environment });
    for (const sequential of [false, true]) {
      const candidate = sequential ? "rl-sequential" : "rl-fixed";
      const members = Array.from({ length: 16 }, (_, index) => ({ id: `m${index}`, unit: `u${index}` }));
      const plan: EvaluationPlan = { format: "pm-rl/evaluation-plan/1", candidate, incumbent: incumbent.id, incumbent_version: String(incumbent.affected_version), population: "Frozen", selection: "all", correlation_unit: "session", members, objective: "reward", objective_version: "1", evaluation_context: "held-out", direction: "maximize", reward_bounds: [0, 1], criterion: { confidence: 0.95, minSamples: 1, effectThreshold: 0 }, stopping: sequential ? { kind: "sequential", method: "hoeffding-alpha-spending/1", observations: 16, independent_units: 16, unit_order: members.map(member => member.unit), looks: [8, 16], review: "rl-review" } : { kind: "fixed", observations: 16, independent_units: 16 } };
      if (sequential) await client.create({ id: "rl-review", type: "Decision", title: "Review", body: JSON.stringify({ format: "pm-rl/sequential-review/1", comparison: evaluationComparison(plan) }) });
      await registerEvaluationPlan(client, plan);
      const options = { baseCheckpoint: "checkpoint", parent: incumbent.id, policy: "policy", environment, collectionRuns: "rl-old-run" };
      for (const json of [false, true]) await refusesUnchanged(pmRoot, () => harness.runCommand({ command: "rl generation register", pmRoot, args: [candidate], options, global: { json } }), "card_drift");
      await assert.rejects(client.get(candidate), (error: unknown) => isPmCliExpectedError(error) && error.exitCode === 3);
      // The exact refused identity must still be usable, rather than merely absent with a reserved history stream.
      const run = `${candidate}-fresh-run`; await client.create({ id: run, type: "Run", title: "Post-plan collection", environment });
      const accepted = (await harness.runCommand({ command: "rl generation register", pmRoot, args: [candidate], options: { ...options, collectionRuns: run } })).result as RlCommandResult;
      assert.equal(accepted.created, true); assert.equal(accepted.id, candidate);
      const reserved = `${candidate}-presealed`;
      const declaration: EvaluationPlan = { ...plan, candidate: reserved, stopping: plan.stopping.kind === "sequential" ? { ...plan.stopping, review: `${reserved}-review` } : plan.stopping };
      if (declaration.stopping.kind === "sequential") await client.create({ id: declaration.stopping.review, type: "Decision", title: "Review", body: JSON.stringify({ format: "pm-rl/sequential-review/1", comparison: evaluationComparison(declaration) }) });
      const registered = await registerEvaluationPlan(client, declaration);
      const fresh = `${reserved}-run`; await client.create({ id: fresh, type: "Run", title: "Fresh collection", environment });
      const rows = declaration.members.map(member => ({ id: member.id, candidate: 1, incumbent: 0 }));
      const value: JsonValue = sequential ? { format: "pm-rl/sequential-checkpoint/1", comparison: registered.comparison, previous: null, observations: rows.slice(0, 8) } : { comparison: registered.comparison, observations: rows };
      await client.create({ id: `${registered.id}-${sequential ? "look-1" : "result"}`, type: "Decision", title: "Evidence before candidate", body: JSON.stringify(value), affectedVersion: hashJson(value), ...(sequential ? { tags: "pm-rl:sequential-checkpoint" } : {}) });
      await refusesUnchanged(pmRoot, () => harness.runCommand({ command: "rl generation register", pmRoot, args: [reserved], options: { ...options, collectionRuns: fresh } }), "card_drift");
    }
    console.log(JSON.stringify({ chronology_modes: 2, refusal_outputs: 2, identities_reused: 2, non_git: true }));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("seeded mutation-command boundary property leaves every native file unchanged on invalid input", async () => {
  const root = mkdtempSync(join(tmpdir(), "rl-command-refusal-"));
  try {
    const { path: pmRoot } = await init("rl", { defaults: true, author: "preflight-test", agentGuidance: "skip" }, { cwd: root });
    const harness = await createExtensionTestHarness(extension, { name: "pm-rl", capabilities: ["commands", "schema", "hooks"] });
    const reads = new Set(["rl compare", "rl eval plan resume"]);
    const commands = harness.activation.registrations.commands.map(row => row.command).filter(name => !reads.has(name) && / (?:register|record|start|log|finish|promote|advance|evaluate|observe|compare|run|resume|build|plan)$/.test(name));
    assert.ok(commands.includes("rl generation register")); assert.ok(commands.includes("rl sweep plan"));
    const file = join(root, "invalid.json"); const identifiers = ["../outside", ".", "", "rl-absent", "#RL-ABSENT", " ", "C:\\outside", "a".repeat(300)];
    let seed = 0x1070f11; const covered = new Set<string>();
    for (let index = 0; index < 500; index += 1) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      const command = commands[index % commands.length]; covered.add(command);
      writeFileSync(file, ((seed >>> 8) & 1) ? "{broken" : JSON.stringify({ invalid: seed }));
      const id = identifiers[(seed >>> 16) % identifiers.length];
      try { await refusesUnchanged(pmRoot, () => harness.runCommand({ command, pmRoot, args: index % 3 ? [id] : [], options: { file, configFile: file, receiptFile: file, scores: file, metrics: file, gatesResults: file, environment: id, approval: id, source: id, target: id, run: id, benchmark: id, checkpoint: id, baseCheckpoint: "../invalid-artifact", algorithm: "test", reason: "Refusal property", evidence: "Refusal property" }, global: { json: Boolean((seed >>> 20) & 1) } })); }
      catch (error) { throw new Error(`operation ${index}, command ${command}`, { cause: error }); }
    }
    assert.equal(covered.size, commands.length);
    console.log(JSON.stringify({ seed: "0x1070f11", operations: 500, mutating_commands: covered.size, compared: "items/history/reservations/counters/schema/journals" }));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("decision mutation refusal classes preserve bytes including exhausted promotion budgets", async () => {
  const w = await decisionFixture(false, false);
  try {
    const candidate = w.plan.candidate;
    for (const operation of [
      () => registerEvaluationPlan(w.client, { ...w.plan, population: "Different sealed declaration" }),
      () => recordPlanEvaluation(w.client, candidate, w.rows),
      () => recordSequentialEvaluation(w.client, candidate, w.rows.map(row => ({ ...row, candidate: Infinity }))),
      () => recordSequentialEvaluation(w.client, candidate, w.rows.slice(1)),
      () => recordPolicyCard(w.client, "rl-missing"),
      () => recordRecursivePolicyCards(w.client, "rl-missing"),
    ]) await refusesUnchanged(w.pmRoot, operation);
    await w.client.update("rl-approval", { body: '```json\n{"permitted_promotions":0}\n```' });
    await refusesUnchanged(w.pmRoot, () => promoteGenerationCore(w.client, { pmRoot: w.pmRoot, author: "preflight-test" }, candidate, "rl-approval", { ...w.score, evaluation_context: "proxy" }, w.score, "Budget must refuse before journal"), "budget_exceeded");
    await w.client.update("rl-approval", { body: '```json\n{"permitted_promotions":1}\n```' });
    const checkpoint = `${candidate}-evaluation-plan-look-2`;
    await w.client.update(checkpoint, { affectedVersion: hashJson("damaged") });
    await refusesUnchanged(w.pmRoot, () => promoteGenerationCore(w.client, { pmRoot: w.pmRoot, author: "preflight-test" }, candidate, "rl-approval", { ...w.score, evaluation_context: "proxy" }, w.score, "Damaged seal"), "card_drift");
  } finally { rmSync(w.root, { recursive: true, force: true }); }
});

test("resource reservation and transition refusal classes precede journals and artifact writes", async () => {
  const w = await processWorkspace(allowance); const input = trainingInput(); const id = processJobId(input);
  try {
    const job = await reserveProcessJob(w.client, w.coordinates, id, input, w.approval, allowance);
    const other = { ...input, identity: { other: true } };
    for (const [operation, code] of [
      [() => reserveProcessJob(w.client, w.coordinates, processJobId(other), other, w.approval, allowance), "process_budget_exhausted"],
      [() => reserveProcessJob(w.client, w.coordinates, id, other, w.approval, allowance), "process_job_drift"],
      [() => reserveProcessJob(w.client, w.coordinates, id, input, w.approval, { ...allowance, tokens: 1 }), "process_job_drift"],
      [() => transitionProcessJob(w.client, w.coordinates, job, "promoted", "Illegal transition"), "process_job_drift"],
      [() => transitionProcessJob(w.client, w.coordinates, job, "running", "Wrong held charge", null, { ...allowance, tokens: 1 }), "process_job_drift"],
      [() => transitionProcessJob(w.client, w.coordinates, job, "running", "Nonfinite charge", null, { ...allowance, tokens: Infinity }), "process_invalid_resources"],
    ] as const) await refusesUnchanged(w.pmRoot, operation, code);
    await w.client.update(w.approval, { body: `\`\`\`json\n${JSON.stringify({ permitted_promotions: 1, resource_budget: { ...allowance, tokens: 1 } })}\n\`\`\`` });
    await refusesUnchanged(w.pmRoot, () => reserveProcessJob(w.client, w.coordinates, id, input, w.approval, allowance), "process_budget_drift");
  } finally { rmSync(w.root, { recursive: true, force: true }); }
});

test("meta resource and promotion budgets refuse before controller intents or reservations", async () => {
  const w = await metaWorkspace();
  try {
    for (const [id, body, code] of [
      ["preflight-promotions", { ...metaSpec, permitted_promotions: 0 }, "meta_promotion_budget_exhausted"],
      ["preflight-resources", { ...metaSpec, meta_budget: { ...metaSpec.meta_budget, training_samples: 0 } }, "meta_budget_exhausted"],
    ] as const) {
      await w.client.update(w.approval, { body: `\`\`\`json\n${JSON.stringify(body)}\n\`\`\`` });
      await refusesUnchanged(w.coordinates.pmRoot, () => runRlMeta(w.client, w.coordinates, { id, config: metaConfig, dataset: w.dataset, approval: w.approval, proposer: "seeded" }), code);
    }
  } finally { rmSync(w.root, { recursive: true, force: true }); }
});

test("shadow dependent receipt conflicts refuse before allocating a Plan or fixed evaluation result", async () => {
  const root = mkdtempSync(join(tmpdir(), "rl-shadow-preflight-"));
  try {
    const { path: pmRoot } = await init("rl", { defaults: true, author: "preflight-test", agentGuidance: "skip" }, { cwd: root });
    const client = new PmClient({ cwd: root, pmRoot, author: "preflight-test", noExtensions: true });
    for (const type of ["Generation", "Environment", "Run"]) await client.schemaAddType(type, { folder: `${type.toLowerCase()}s`, defaultStatus: "open" });
    const active = { event: "hold" }; const policy = { event: "accept" };
    const seed: GenerationSpec = { base_checkpoint: "checkpoint", policy: "", collection_runs: [], training_config: { shadow_policy: hashJson(active) }, environment_version: "", reward_spec_version: "", parent: null, seed: true, promoted: false, approval: null, proxy_score: null, held_out_score: null, gap: null, promotion_evidence: null };
    await client.create({ id: "rl-seed", title: "Seed", type: "Generation", body: `\`\`\`json\n${JSON.stringify(seed)}\n\`\`\``, affectedVersion: hashJson(generationProvenance(seed)) });
    await client.create({ id: "rl-training", title: "Training", type: "Environment" });
    for (const conflict of ["deployment", "comparison"] as const) {
      const candidate = `rl-shadow-${conflict}`;
      const deployment: ShadowDeployment = { format: "pm-rl/shadow/1", generation: candidate, incumbent: "rl-seed", consent: `${candidate}-consent`, active, candidate: policy, inputs: { member: shadowInputDigest("event") }, budget: { active_calls: 1, candidate_calls: 1 } };
      const plan: EvaluationPlan = { format: "pm-rl/evaluation-plan/1", candidate, incumbent: "rl-seed", incumbent_version: hashJson(generationProvenance(seed)), population: "Consented", selection: "all", correlation_unit: "event", members: [{ id: "member", unit: "event" }], objective: "reward", objective_version: "1", evaluation_context: "held-out", direction: "maximize", reward_bounds: [0, 1], criterion: { confidence: 0.5, minSamples: 1, effectThreshold: 0 }, stopping: { kind: "fixed", observations: 1, independent_units: 1 } };
      await client.create({ id: deployment.consent, title: "Consent", type: "Decision", body: JSON.stringify({ format: "pm-rl/shadow-consent/1", deployment: hashJson(deployment as unknown as JsonValue) }) });
      const id = `${candidate}-evaluation-plan-shadow`;
      if (conflict === "deployment") {
        await client.create({ id, type: "Decision", title: "Foreign deployment slot", body: "{}" });
        await refusesUnchanged(pmRoot, () => registerShadowDeployment(client, deployment, plan), "shadow_drift");
      } else {
        const registered = await registerShadowDeployment(client, deployment, plan);
        const run = `${candidate}-run`; await client.create({ id: run, title: "Collection", type: "Run", environment: "rl-training" });
        const spec: GenerationSpec = { ...seed, seed: false, parent: "rl-seed", policy: "policy", collection_runs: [run], environment_version: "rl-training", reward_spec_version: "1", training_config: { shadow_policy: hashJson(policy) }, evaluation_plan: registered.comparison };
        await client.create({ id: candidate, type: "Generation", title: "Candidate", body: `\`\`\`json\n${JSON.stringify(spec)}\n\`\`\``, affectedVersion: hashJson(generationProvenance(spec)) });
        await refusesUnchanged(pmRoot, () => observeShadow(client, candidate, { id: "member", input: "event", rewards: { hold: 0, accept: Infinity } }), "shadow_invalid");
        await observeShadow(client, candidate, { id: "member", input: "event", rewards: { hold: 0, accept: 1 } });
        await client.create({ id: `${id}-comparison`, type: "Decision", title: "Foreign comparison slot", body: "{}" });
        await refusesUnchanged(pmRoot, () => compareShadow(client, candidate), "shadow_drift");
      }
    }
    const candidate = `rl-${"x".repeat(178)}`;
    const deployment: ShadowDeployment = { format: "pm-rl/shadow/1", generation: candidate, incumbent: "rl-seed", consent: "rl-long-consent", active, candidate: policy, inputs: { member: shadowInputDigest("event") }, budget: { active_calls: 1, candidate_calls: 1 } };
    await client.create({ id: deployment.consent, title: "Long identity consent", type: "Decision", body: JSON.stringify({ format: "pm-rl/shadow-consent/1", deployment: hashJson(deployment as unknown as JsonValue) }) });
    const plan: EvaluationPlan = { format: "pm-rl/evaluation-plan/1", candidate, incumbent: "rl-seed", incumbent_version: hashJson(generationProvenance(seed)), population: "Consented", selection: "all", correlation_unit: "event", members: [{ id: "member", unit: "event" }], objective: "reward", objective_version: "1", evaluation_context: "held-out", direction: "maximize", reward_bounds: [0, 1], criterion: { confidence: 0.5, minSamples: 1, effectThreshold: 0 }, stopping: { kind: "fixed", observations: 1, independent_units: 1 } };
    await refusesUnchanged(pmRoot, () => registerShadowDeployment(client, deployment, plan), "rl_identifier_invalid");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("compound sweep and controller validation precedes child, environment and artifact publication", async () => {
  const root = mkdtempSync(join(tmpdir(), "rl-compound-preflight-"));
  try {
    const { path: pmRoot } = await init("rl", { defaults: true, author: "preflight-test", agentGuidance: "skip" }, { cwd: root });
    const client = new PmClient({ cwd: root, pmRoot, author: "preflight-test", noExtensions: true });
    const harness = await createExtensionTestHarness(extension, { name: "pm-rl", capabilities: ["commands", "schema", "hooks"] });
    const file = join(root, "environment.json");
    writeFileSync(file, JSON.stringify({ name: "compound", version: "1", task_suite: ["task"], reward_specification: { goal: 1 } }));
    const environment = ((await harness.runCommand({ command: "rl env register", pmRoot, options: { file } })).result as RlCommandResult).id!;
    const space = join(root, "space.json");
    writeFileSync(space, JSON.stringify({ search_space: { payload: ["x".repeat(9_000_000)] }, selection_rule: "none" }));
    await refusesUnchanged(pmRoot, () => harness.runCommand({ command: "rl sweep plan", pmRoot, args: ["rl-oversized-sweep"], options: { file: space, environment, algorithm: "test" } }), "json_record_limit");
    writeFileSync(space, JSON.stringify({ search_space: { rate: Array.from({ length: 10 }, (_, index) => index) }, selection_rule: "none" }));
    await refusesUnchanged(pmRoot, () => harness.runCommand({ command: "rl sweep plan", pmRoot, args: [`rl-${"s".repeat(191)}`], options: { file: space, environment, algorithm: "test" } }), "rl_identifier_invalid");
    await client.create({ id: "rl-approval", title: "Approval", type: "Decision", body: '```json\n{"permitted_promotions":1}\n```' });
    await harness.runCommand({ command: "rl generation register", pmRoot, args: ["rl-compound-seed"], options: { baseCheckpoint: "foreign" } });
    const config = JSON.parse(readFileSync(new URL("../examples/loop-bandit.json", import.meta.url), "utf8")) as JsonValue;
    await refusesUnchanged(pmRoot, () => runRlLoop(client, { pmRoot, author: "preflight-test" }, { id: "compound", config, approval: "rl-approval" }), "generation_identity_collision");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("checkpoint GC validates every deletion target before removing its first artifact", async () => {
  const root = mkdtempSync(join(tmpdir(), "rl-gc-preflight-"));
  try {
    const { path: pmRoot } = await init("rl", { defaults: true, author: "preflight-test", agentGuidance: "skip" }, { cwd: root });
    const directory = join(pmRoot, "artifacts", "pm-rl", "sha256"); mkdirSync(directory, { recursive: true });
    mkdirSync(join(pmRoot, "artifacts", "pm-rl", "ledger"), { recursive: true });
    const first = join(directory, `${"a".repeat(64)}.json`); writeFileSync(first, "unreachable");
    const second = join(directory, `${"b".repeat(64)}.json`);
    const tripwire = join(root, "tripwire.txt"); writeFileSync(tripwire, "outside sentinel");
    symlinkSync(tripwire, second);
    await refusesUnchanged(pmRoot, () => collectCheckpointArtifacts(pmRoot), "rl_state_path_invalid");
    assert.equal(readFileSync(tripwire, "utf8"), "outside sentinel");
    rmSync(second); mkdirSync(second);
    await refusesUnchanged(pmRoot, () => collectCheckpointArtifacts(pmRoot), "checkpoint_artifact_corrupt");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("preflight source conflicts retry current SDK snapshots and never retry after publication begins", async () => {
  const root = mkdtempSync(join(tmpdir(), "rl-preflight-retry-"));
  try {
    const { path: pmRoot } = await init("rl", { defaults: true, author: "preflight-test", agentGuidance: "skip" }, { cwd: root });
    const client = new PmClient({ cwd: root, pmRoot, author: "preflight-test", noExtensions: true });
    const peer = new PmClient({ cwd: root, pmRoot, author: "peer", noExtensions: true });
    const config = client.config.bind(client); let reads = 0;
    client.config = ((...args) => { reads += 1; return config(...args); }) as PmClient["config"];
    try {
      for (const id of ["..", ".", "/outside", "C:\\outside", "\0", "x".repeat(300)]) {
        await assert.rejects(async () => withValidatedMutation(client, id, async () => assert.fail("invalid identity reached validation"), async () => assert.fail("invalid identity reached publication")), (error: unknown) => isPmCliExpectedError(error) && error.context.code === "rl_identifier_invalid");
      }
      assert.equal(reads, 0, "invalid identities must refuse before even a read-only SDK operation");
    } finally { client.config = config; }
    await client.create({ id: "rl-source", title: "Source", body: "initial" });
    await client.create({ id: "rl-target", title: "Target", body: "original" });
    for (const compete of ["once", "always"] as const) {
      let validations = 0; let publications = 0; const before = await readCompleteLoopItem(client, "rl-target");
      const operation = withValidatedMutation(client, "target", async () => {
        const item = await readCompleteLoopItem(client, "rl-source"); validations += 1;
        if (compete === "always" || validations === 1) await peer.update("rl-source", { body: `${compete}-${validations}` });
        return String(item.item.body);
      }, async (body) => { publications += 1; await client.update("rl-target", { body }); });
      if (compete === "always") {
        await assert.rejects(operation, (error: unknown) => isPmCliExpectedError(error) && error.context.code === "loop_write_conflict");
        assert.equal(validations, 3); assert.equal(publications, 0);
        assert.deepEqual((await readCompleteLoopItem(client, "rl-target")).item, before.item);
      } else {
        await operation; assert.equal(validations, 2); assert.equal(publications, 1);
        assert.equal((await readCompleteLoopItem(client, "rl-target")).item.body, "once-1");
      }
    }
    let publications = 0;
    await assert.rejects(withValidatedMutation(client, "target", () => readCompleteLoopItem(client, "rl-source"), async () => { publications += 1; throw new Error("publish interrupted"); }), /publish interrupted/);
    assert.equal(publications, 1);
    await peer.update("rl-source", { body: "Every owned source lease released" });
  } finally { rmSync(root, { recursive: true, force: true }); }
});
