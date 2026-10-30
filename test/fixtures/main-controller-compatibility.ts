/** Main-written lifecycle corpus shared verbatim by the baseline writer and current reader. */
import assert from "node:assert/strict";
import { existsSync, lstatSync, readdirSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { Readable, Writable } from "node:stream";
import { join, relative, resolve } from "node:path";
import { PmClient } from "@unbrained/pm-cli/sdk/core";
import { init, normalizeItemId, isPmCliExpectedError } from "@unbrained/pm-cli/sdk/runtime";
import { withRlController, runRlLoop, resumeRlLoop, rlLoopStatus, readCompleteLoopItem, extractGenerationSpec, generationProvenance, hashJson, promoteGenerationCore, type JsonValue } from "../../index.ts";
import { registerEvaluationPlan, recordPlanEvaluation, evaluationComparison, type EvaluationPlan } from "../../evaluation-plan.ts";
import type { ScoreRecord } from "../../lineage.ts";
import { reserveProcessJob, readProcessJob, processJobBodyId, processStaging, transitionProcessJob, validateProcessCompletion, verifiedProcessPolicy } from "../../process.ts";
import { parseLoopConfig, banditProcessInput, runLoopGeneration } from "../../loop.ts";
import { runReferenceTrainer } from "../../process-bandit.ts";
import { banditCheckpoint } from "../../bandit.ts";
import { discoverPolicyCards, replayPolicyCard, adoptPolicyCard, recordPolicyCard, verifyRetainedGenerationEvidence } from "../../policy-card.ts";

/** The stored-read option is ignored by older baseline signatures without replacing their behavior. */
const storedProcessId: (body: string, stored?: boolean) => string | null = processJobBodyId;

interface CorpusCase { readonly root: string; readonly prefix: string; readonly id: string; readonly kind: "controller" | "loop"; readonly interrupted: boolean; readonly running: boolean }
interface Corpus { readonly cases: readonly CorpusCase[] }
/** Load the authored corpus and resolve each tracker root against the corpus directory (absolute legacy roots stay as they are). */
function loadCorpus(directory: string): Corpus {
  const corpus = JSON.parse(readFileSync(join(directory, "corpus.json"), "utf8")) as Corpus;
  return { cases: corpus.cases.map(row => ({ ...row, root: resolve(directory, row.root) })) };
}
/** Bound each tracker independently; fixtures and all SDK writes remain outside Git. */
function clientFor(row: CorpusCase): PmClient { return new PmClient({ cwd: row.root, pmRoot: join(row.root, ".agents/pm"), author: "main-compatibility", noExtensions: true }); }
/** Read durable SDK identity fields without hand-written value normalization. */
async function identities(client: PmClient) {
  return (await client.listAllComplete({ includeBody: true })).items.map(item => ({ id: item.id, type: item.type, body: item.body, affected_version: item.affected_version })).sort((a, b) => a.id.localeCompare(b.id));
}
/** Create completed and interrupted controllers and loops using only baseline-public APIs. */
async function writeCorpus(directory: string, onlyRunning = false): Promise<void> {
  const cases: CorpusCase[] = [];
  for (const prefix of ["rl", "fleet", "rl-prefixed"]) for (const kind of ["controller", "loop"] as const) for (const variant of (kind === "loop" ? ["complete", "interrupted", "running"] : ["complete", "interrupted"])) {
    const interrupted = variant !== "complete"; const running = variant === "running";
    if (onlyRunning && !running) continue;
    const id = kind === "controller" ? "rl-prefixed" : `${prefix}-loop`;
    const root = join(directory, `${prefix}-${kind}-${variant}`); mkdirSync(root, { recursive: true });
    const row: CorpusCase = { root, prefix, id, kind, interrupted, running }; cases.push(row);
    await init(prefix, { defaults: true, author: "main-compatibility", agentGuidance: "skip" }, { cwd: root, pmRoot: join(root, ".agents/pm") });
    const client = clientFor(row); await client.create({ id: "approval", title: "Consent", type: "Decision", body: '```json\n{"permitted_promotions":8}\n```' });
    const coordinates = { pmRoot: join(root, ".agents/pm"), author: "main-compatibility" };
    if (kind === "controller") {
      try {
        await withRlController(client, coordinates, { id, approval: "approval", recoveryCommand: "resume compatibility controller" }, new AbortController().signal, async step => {
          await step("Evaluate", { trial: id }, async () => ({ configs: [{ samples: 1 }, { samples: 2 }], value: 7 }));
          if (interrupted) throw new Error("compatibility interruption");
          await step("finish", { trial: id }, async () => ({ value: 11 }));
        });
      } catch (error) { assert.ok(interrupted && error instanceof Error && error.message === "compatibility interruption"); }
    } else {
      const config = { ...JSON.parse(readFileSync(new URL("../../examples/loop-bandit.json", import.meta.url), "utf8")) as Record<string, JsonValue>, max_generations: 1 };
      const create = client.create.bind(client);
      if (running) client.create = (async options => {
        const result = await create(options);
        if (typeof options?.body === "string" && options.body.startsWith("{")) {
          const receipt = JSON.parse(options.body) as { format?: string; state?: string; key?: string };
          if (receipt.format === "pm-rl/loop-step/1" && receipt.state === "running" && receipt.key?.endsWith("-step-train")) throw new Error("compatibility interruption");
        }
        return result;
      }) as PmClient["create"];
      try { await runRlLoop(client, coordinates, { id, config, approval: "approval", onPhase(phase) { if (interrupted && !running && phase === "evaluate") throw new Error("compatibility interruption"); } }); }
      catch (error) { assert.ok(interrupted && error instanceof Error && error.message === "compatibility interruption"); }
    }
    writeFileSync(join(root, "birth-identities.json"), JSON.stringify(await identities(client)));
  }
  // Store tracker roots relative to the corpus, so a copied corpus reads its own trackers.
  writeFileSync(join(directory, "corpus.json"), JSON.stringify({ cases: cases.map(row => ({ ...row, root: relative(directory, row.root) })) }));
  await augmentCorpus(directory);
  await augmentProcesses(directory);
}
/** Include old fixed-plan promotion cards so adoption also follows the baseline projection. */
async function augmentCorpus(directory: string): Promise<void> {
  const corpus = loadCorpus(directory);
  for (const row of corpus.cases.filter(row => row.kind === "loop" && !row.interrupted)) {
    const client = clientFor(row); const pmRoot = join(row.root, ".agents/pm");
    const status = await rlLoopStatus(client, row.id, pmRoot);
    const seed = (await readCompleteLoopItem(client, `${row.id}-seed`)).item;
    const original = extractGenerationSpec(String(seed.body), "Baseline seed");
    for (const budgeted of [false, true]) {
    const id = normalizeItemId(`${row.id}-${budgeted ? "planned-budget" : "planned"}`, row.prefix);
    const exists = await client.get(id).catch((error: unknown) => { if (isPmCliExpectedError(error) && error.exitCode === 3) return null; throw error; });
    if (exists !== null) continue;
    const members = Array.from({ length: 64 }, (_, index) => ({ id: `case-${index}`, unit: `session-${index}` }));
    const plan: EvaluationPlan = { format: "pm-rl/evaluation-plan/1", candidate: id, incumbent: seed.id, incumbent_version: String(seed.affected_version), population: "Frozen baseline", selection: "all", correlation_unit: "session", members, objective: "reward", objective_version: "v1", evaluation_context: "compat-held-out", direction: "maximize", reward_bounds: [0, 1], criterion: { confidence: 0.95, minSamples: 8, effectThreshold: 0 }, stopping: { kind: "fixed", observations: 64, independent_units: 64 } };
    await registerEvaluationPlan(client, plan);
    const run = normalizeItemId(`${row.id}-${budgeted ? "planned-budget" : "planned"}-run`, row.prefix);
    await client.create({ id: run, type: "Run", title: "Baseline evidence", environment: status.environment, component: original.policy });
    const candidate = { ...original, ...(budgeted ? { training_config: { samples: 64, allowance: { tokens: 0 } } } : {}), seed: false, parent: seed.id, policy: "compat-policy", collection_runs: [run], environment_version: status.environment, reward_spec_version: "v1", evaluation_plan: evaluationComparison(plan) };
    await client.create({ id, type: "Generation", title: "Baseline planned candidate", body: `\`\`\`json\n${JSON.stringify(candidate)}\n\`\`\``, affectedVersion: hashJson(generationProvenance(candidate)) });
    const report = await recordPlanEvaluation(client, id, members.map(member => ({ id: member.id, candidate: 1, incumbent: 0 })));
    const score: ScoreRecord = { objective: plan.objective, objective_version: plan.objective_version, evaluation_context: plan.evaluation_context, direction: plan.direction, seed_set: evaluationComparison(plan), scale: 1, value: report.candidate_mean };
    await promoteGenerationCore(client, { pmRoot, author: "main-compatibility" }, id, "approval", { ...score, evaluation_context: "compat-proxy" }, score, "Baseline fixed promotion");
    await recordPolicyCard(client, id);
    }
    writeFileSync(join(row.root, "birth-identities.json"), JSON.stringify(await identities(client)));
  }
}
/** Persist legacy process names and their exact state directories using baseline package APIs. */
async function augmentProcesses(directory: string): Promise<void> {
  const corpus = loadCorpus(directory);
  const row = corpus.cases.find(row => row.prefix === "rl" && row.kind === "controller" && !row.interrupted);
  if (row === undefined) return;
  const client = clientFor(row); const pmRoot = join(row.root, ".agents/pm");
  const allowance = { training_steps: 1, wall_ms: 5000, storage_bytes: 65536, compute_units: 1000, tokens: 0 };
  if (await client.get("process-approval").catch((error: unknown) => { if (isPmCliExpectedError(error) && error.exitCode === 3) return null; throw error; }) === null) await client.create({ id: "process-approval", type: "Decision", title: "Legacy process approval", body: '```json\n' + JSON.stringify({ permitted_promotions: 2, resource_budget: { training_steps: 4, wall_ms: 20000, storage_bytes: 262144, compute_units: 4000, tokens: 0 } }) + '\n```' });
  const config = parseLoopConfig(JSON.parse(readFileSync(new URL("../../examples/loop-bandit.json", import.meta.url), "utf8")));
  const step = { learningRate: config.learningRate, evaluationSamples: config.evaluationSamples }; const source = banditCheckpoint(config.initialWeight);
  const input = banditProcessInput(config, step, 1, runLoopGeneration(config, step, 1, source));
  const ids = [`PROCESS-${hashJson("uppercase legacy job").toUpperCase()}`];
  for (const id of ids) {
    const coordinates = { pmRoot, author: "main-compatibility" };
    let job = await reserveProcessJob(client, coordinates, id, input, "process-approval", allowance);
    const staging = processStaging(pmRoot, id); mkdirSync(staging, { recursive: true }); writeFileSync(join(staging, "legacy-state.txt"), "Retained baseline state");
    if (job.state === "planned") {
      job = await transitionProcessJob(client, coordinates, job, "running", "Baseline trainer started");
      writeFileSync(join(staging, "runner.json"), JSON.stringify({ started_at: Date.now() }));
      const output = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
      await runReferenceTrainer(Readable.from([JSON.stringify({ job: id, input })]), output, staging);
      const completion = validateProcessCompletion(staging, id, input, allowance);
      await transitionProcessJob(client, coordinates, job, "materialized", "Baseline completion", completion, completion.usage);
    }
  }
  writeFileSync(join(row.root, "process-compatibility.json"), JSON.stringify(ids));
  writeFileSync(join(row.root, "birth-identities.json"), JSON.stringify(await identities(client)));
}
/** Read the complete native process projection using the same validator as the full corpus. */
async function processRecords(client: PmClient, row: CorpusCase): Promise<unknown[]> {
  const results: unknown[] = []; const coordinates = { pmRoot: join(row.root, ".agents/pm") };
    if (existsSync(join(row.root, "process-compatibility.json"))) for (const id of JSON.parse(readFileSync(join(row.root, "process-compatibility.json"), "utf8")) as string[]) {
      const job = await readProcessJob(client, id); assert.ok(job);
      const body = (await readCompleteLoopItem(client, id)).item.body;
      const staging = processStaging(coordinates.pmRoot, job.id);
      assert.equal(readFileSync(join(staging, "legacy-state.txt"), "utf8"), "Retained baseline state");
      assert.ok(["materialized", "evaluated"].includes(job.state));
      const config = parseLoopConfig(JSON.parse(readFileSync(new URL("../../examples/loop-bandit.json", import.meta.url), "utf8")));
      const step = { learningRate: config.learningRate, evaluationSamples: config.evaluationSamples }; const source = banditCheckpoint(config.initialWeight);
      const input = banditProcessInput(config, step, 1, runLoopGeneration(config, step, 1, source));
      const policy = verifiedProcessPolicy(job, coordinates.pmRoot, input);
      results.push({ prefix: row.prefix, job, policy, body_id: storedProcessId(String(body), true), directory: relative(coordinates.pmRoot, staging), completion: JSON.parse(readFileSync(join(staging, "completion.json"), "utf8")) });
    }
  return results;
}
/** Exercise the historical runtime's own accounting writer, without normalizing SDK state in the oracle. */
async function processCorpus(directory: string, reclock = false): Promise<void> {
  const corpus = loadCorpus(directory);
  const results: unknown[] = [];
  for (const row of corpus.cases) {
    const client = clientFor(row); const pmRoot = join(row.root, ".agents/pm");
    if (reclock && existsSync(join(row.root, "process-compatibility.json"))) for (const id of JSON.parse(readFileSync(join(row.root, "process-compatibility.json"), "utf8")) as string[]) {
      const job = (await readProcessJob(client, id))!;
      const config = parseLoopConfig(JSON.parse(readFileSync(new URL("../../examples/loop-bandit.json", import.meta.url), "utf8")));
      const step = { learningRate: config.learningRate, evaluationSamples: config.evaluationSamples }; const source = banditCheckpoint(config.initialWeight);
      const input = banditProcessInput(config, step, 1, runLoopGeneration(config, step, 1, source));
      const completion = validateProcessCompletion(processStaging(pmRoot, job.id), job.id, input, job.allowance, pmRoot);
      await transitionProcessJob(client, { pmRoot, author: "main-compatibility" }, job, "evaluated", "Baseline runtime accounting", completion, completion.usage);
    }
    results.push(...await processRecords(client, row));
  }
  writeFileSync(join(directory, "process-results.json"), JSON.stringify(results));
}
/** Capture actual baseline SDK projections and retained bytes for a small, runtime-independent regression fixture. */
async function captureProcesses(directory: string): Promise<void> {
  const corpus = loadCorpus(directory);
  const row = corpus.cases.find(row => existsSync(join(row.root, "process-compatibility.json")))!;
  const client = clientFor(row); const pmRoot = join(row.root, ".agents/pm");
  const id = (JSON.parse(readFileSync(join(row.root, "process-compatibility.json"), "utf8")) as string[])[0]!;
  const job = (await readProcessJob(client, id))!; const staging = processStaging(pmRoot, job.id);
  const config = parseLoopConfig(JSON.parse(readFileSync(new URL("../../examples/loop-bandit.json", import.meta.url), "utf8")));
  const step = { learningRate: config.learningRate, evaluationSamples: config.evaluationSamples }; const source = banditCheckpoint(config.initialWeight);
  const input = banditProcessInput(config, step, 1, runLoopGeneration(config, step, 1, source));
  const result = { job, body: String((await readCompleteLoopItem(client, id)).item.body), approval: String((await readCompleteLoopItem(client, job.approval)).item.body), input,
    files: Object.fromEntries(readdirSync(staging).sort().map(name => [name, readFileSync(join(staging, name), "utf8")])), mtime_ns: String(lstatSync(join(staging, "completion.json"), { bigint: true }).mtimeNs), clock_ms: lstatSync(join(staging, "completion.json")).mtimeMs, policy: verifiedProcessPolicy(job, pmRoot, input) };
  writeFileSync(join(directory, "process-capture.json"), JSON.stringify(result));
}
/** Resume every baseline tracker and check stored receipts/cards through the real SDK. */
async function exerciseCorpus(directory: string): Promise<void> {
  const corpus = loadCorpus(directory);
  const results: unknown[] = [];
  for (const row of corpus.cases) {
    const client = clientFor(row); const coordinates = { pmRoot: join(row.root, ".agents/pm"), author: "main-compatibility" };
    const before = JSON.parse(readFileSync(join(row.root, "birth-identities.json"), "utf8")) as Awaited<ReturnType<typeof identities>>;
    results.push(...await processRecords(client, row));
    let executions = 0;
    if (row.kind === "controller") {
      const result = await withRlController(client, coordinates, { id: row.id, approval: "approval", recoveryCommand: "resume compatibility controller" }, new AbortController().signal, async step => {
        const evaluated = await step("Evaluate", { trial: row.id }, async () => { executions += 1; return { value: -1 }; });
        const finished = await step("finish", { trial: row.id }, async () => { executions += 1; return { value: 11 }; });
        return { evaluated, finished };
      });
      assert.equal(executions, row.interrupted ? 1 : 0); results.push({ prefix: row.prefix, id: row.id, kind: row.kind, interrupted: row.interrupted, running: row.running, result, executions });
    } else {
      const report = await resumeRlLoop(client, coordinates, { id: row.id, approval: "approval" });
      const status = await rlLoopStatus(client, row.id, coordinates.pmRoot);
      assert.equal(report.promoted, 1); assert.equal(status.stop_reason, "generation_limit");
      for (const generation of report.generations) await verifyRetainedGenerationEvidence(client, generation.item);
      results.push({ prefix: row.prefix, id: row.id, kind: row.kind, interrupted: row.interrupted, running: row.running, promoted: report.promoted, samples: report.samples_consumed, final: report.final_checkpoint, stop: status.stop_reason });
    }
    const after = await identities(client);
    const receipts = after.filter(item => item.type === "Decision" && item.id.includes("step-"));
    results.push({ prefix: row.prefix, kind: row.kind, interrupted: row.interrupted, running: row.running, receipts: row.kind === "controller" ? receipts : receipts.map(item => { const record = JSON.parse(String(item.body)) as { key: string; input: string; state: string; digest: string; result: JsonValue }; return { id: item.id, key: record.key, input: record.input, state: record.state, digest: record.digest, result: record.result }; }) });
    const existing = new Map(after.map(item => [item.id, item]));
    for (const original of before) {
      const current = existing.get(original.id); assert.ok(current, original.id);
      if (original.type === "Decision" && original.id.includes("step-")) {
        const birth = JSON.parse(String(original.body)) as { state: string; key: string; input: string };
        if (birth.state === "running") {
          const complete = JSON.parse(String(current.body)) as typeof birth;
          assert.equal(complete.state, "complete"); assert.equal(complete.key, birth.key); assert.equal(complete.input, birth.input);
        } else assert.equal(current.body, original.body);
      }
      if (original.id.includes("policy-card-")) for (const field of ["id", "type", "body", "affected_version"] as const) assert.equal(current[field], original[field], `${original.id}:${field}`);
      assert.equal((await readCompleteLoopItem(client, original.id)).item.id, original.id);
    }
    results.push(...await cardDecisions(client, row.prefix));
  }
  writeFileSync(join(directory, "results.json"), JSON.stringify(results));
  console.log(JSON.stringify({ compatibility_cases: corpus.cases.length, source: "SDK read-back" }));
}
/** The same SDK admission oracle is reusable for focused single-function controls. */
async function cardDecisions(client: PmClient, prefix: string): Promise<unknown[]> {
  const results: unknown[] = [];
  for (const card of await discoverPolicyCards(client)) {
    await replayPolicyCard(client, card);
    if (card.outcome !== "promoted") continue;
    let adopted: string;
    try { adopted = (await adoptPolicyCard(client, card)).digest; }
    catch (error) { assert.ok(isPmCliExpectedError(error)); adopted = String(error.context.code); }
    results.push({ prefix, subject: card.subject, adoption: adopted });
  }
  return results;
}
/** Focus only the baseline's completed rl tracker when proving the legacy card admission contract. */
async function exerciseCards(directory: string): Promise<void> {
  const corpus = loadCorpus(directory);
  const row = corpus.cases.find(row => row.prefix === "rl" && row.kind === "loop" && !row.interrupted)!;
  writeFileSync(join(directory, "cards.json"), JSON.stringify(await cardDecisions(clientFor(row), row.prefix)));
}
const [mode, directory] = process.argv.slice(2);
try {
if (mode === "write") await writeCorpus(directory!); else if (mode === "exercise") await exerciseCorpus(directory!); else if (mode === "augment") await augmentCorpus(directory!); else if (mode === "running") await writeCorpus(directory!, true); else if (mode === "cards") await exerciseCards(directory!); else if (mode === "processes") await augmentProcesses(directory!); else if (mode === "processes-capture") await captureProcesses(directory!); else if (mode === "processes-read") await processCorpus(directory!); else if (mode === "processes-reclock") await processCorpus(directory!, true); else throw new Error("compatibility driver mode");

} catch (error) { console.error(isPmCliExpectedError(error) ? JSON.stringify({ code: error.context.code, message: error.message }) : error); process.exitCode = 1; }
