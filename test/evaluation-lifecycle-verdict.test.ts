/** Birth verdict integrity through real SDK, CLI, replay and checkpoint consumers on non-Git trackers. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { extractGenerationSpec, hashJson, readCompleteLoopItem, recordRefusedPolicyCard, registerGenerationCore, type JsonValue } from "../index.ts";
import { createCausalEvaluationArtifact, validateCausalEvaluationOrder, verifyCausalEvaluationRetry } from "../evaluation-lifecycle.ts";
import { evaluationLifecycleArtifacts, readEvaluationPlan } from "../evaluation-plan.ts";
import { readSequentialEvaluation, recordSequentialEvaluation } from "../sequential-evaluation.ts";
import { causalWorkspace, causalStep } from "./fixtures/causal-evaluation.ts";
import { isolatedChildEnv } from "./fixtures/child-env.ts";
import { refused } from "./fixtures/refused.ts";

const repository = process.cwd();
/** The installed pm CLI's JavaScript entry, read from its package manifest rather than npm's platform-specific shim. */
const pmCliPackage = join(repository, "node_modules/@unbrained/pm-cli");
const pmCliEntry = join(pmCliPackage, (JSON.parse(readFileSync(join(pmCliPackage, "package.json"), "utf8")) as { bin: { pm: string } }).bin.pm);
const verdict = { decision: "refuse" as const, reason_digest: hashJson("Birth refusal"), detail: { samples: 16, cohort: "sealed" } };
type Workspace = Awaited<ReturnType<typeof causalWorkspace>>;

/** Register an actual causal candidate, optionally with its evaluator verdict present at birth. */
async function withCandidate(evaluation: Parameters<typeof registerGenerationCore>[1]["evaluation"], check: (w: Workspace) => Promise<void>): Promise<void> {
  const w = await causalWorkspace();
  try {
    assert.equal(existsSync(join(w.root, ".git")), false);
    for (const step of ["review", "plan", "run"]) await causalStep(w, step);
    await registerGenerationCore(w.client, { ...w.generation, ...(evaluation === undefined ? {} : { evaluation }) });
    const born = extractGenerationSpec(String((await readCompleteLoopItem(w.client, w.plan.candidate, "1")).item.body), "Native birth");
    assert.deepEqual(born.policy_evaluation, evaluation);
    await check(w);
  } finally { process.chdir(repository); rmSync(w.root, { recursive: true, force: true }); }
}
/** Rewrite a verdict through native storage without changing the provenance or witness. */
async function rewrittenBody(w: Workspace, evaluation: JsonValue | undefined): Promise<string> {
  const spec = extractGenerationSpec(String((await readCompleteLoopItem(w.client, w.plan.candidate)).item.body), "Current candidate");
  const { policy_evaluation: _previous, ...rest } = spec;
  return `\`\`\`json\n${JSON.stringify({ ...rest, ...(evaluation === undefined ? {} : { policy_evaluation: evaluation }) })}\n\`\`\``;
}
/** Compare complete native history bytes around refused readers and publishers. */
function history(w: Workspace): string[] {
  return readdirSync(join(w.pmRoot, "history")).sort().map(file => readFileSync(join(w.pmRoot, "history", file), "utf8"));
}
/** Match the shared causal drift refusal, with its conflict exit code, rather than an unrelated card or process error. */
const drift = refused("eval_plan_drift");
/** Exercise the same sealed-birth validator used by causal creation, retries and reads. */
async function validate(w: Workspace): Promise<void> {
  const registered = (await readEvaluationPlan(w.client, w.plan.candidate))!;
  await validateCausalEvaluationOrder(w.client, w.plan, evaluationLifecycleArtifacts(registered, w.generation.collectionRuns, 0));
}

const mutations: { name: string; value: JsonValue | undefined }[] = [
  { name: "decision", value: { ...verdict, decision: "promote" } },
  { name: "reason", value: { ...verdict, reason_digest: hashJson("Changed reason") } },
  { name: "nested field", value: { ...verdict, detail: { ...verdict.detail, samples: 64 } } },
  { name: "added field", value: { ...verdict, extra: "unsealed" } },
  { name: "removed field", value: { decision: verdict.decision, detail: verdict.detail } },
  { name: "removed verdict", value: undefined },
  { name: "null verdict", value: null },
];
for (const mutation of mutations) test(`causal birth verdict rejects SDK ${mutation.name} tamper`, async () => {
  await withCandidate(verdict, async w => {
    await w.client.update(w.plan.candidate, { body: await rewrittenBody(w, mutation.value) });
    const before = history(w);
    await assert.rejects(validate(w), drift);
    assert.deepEqual(history(w), before, "Refusal must not write native history");
  });
});

test("causal birth verdict rejects checkpoint publication after refuse to promote tamper", async () => {
  await withCandidate(verdict, async w => {
    await w.client.update(w.plan.candidate, { body: await rewrittenBody(w, { ...verdict, decision: "promote" }) });
    const before = history(w);
    await assert.rejects(recordSequentialEvaluation(w.client, w.plan.candidate, w.rows.slice(0, 16)), drift);
    assert.deepEqual(history(w), before, "Refused appendSequentialLook must not publish a checkpoint");
    assert.equal(existsSync(join(w.pmRoot, "history", `${w.plan.candidate}-evaluation-plan-look-1.jsonl`)), false);
  });
});

for (const replay of ["SDK", "CLI"]) test(`causal birth verdict rejects CLI body tamper on ${replay} replay`, async () => {
  await withCandidate({ ...verdict, decision: "promote" }, async w => {
    // Replay an owned checkpoint, so a missing-checkpoint refusal cannot mask verdict drift.
    await recordSequentialEvaluation(w.client, w.plan.candidate, w.rows.slice(0, 16));
    // Launch the CLI's JavaScript entry with this Node: npm's extensionless .bin shim is not executable on Windows.
    const update = spawnSync(process.execPath, [pmCliEntry, "--no-extensions", "--pm-path", w.pmRoot, "update", w.plan.candidate, "--body", await rewrittenBody(w, { ...verdict, decision: "promote", reason_digest: hashJson("CLI changed reason") }), "--json"], { cwd: w.root, encoding: "utf8", env: isolatedChildEnv(), timeout: 60_000 });
    assert.equal(update.error, undefined);
    assert.equal(update.status, 0, update.stdout + update.stderr);
    const before = history(w);
    const operation = () => replay === "SDK" ? readSequentialEvaluation(w.client, w.plan.candidate)
      : w.harness.runCommand({ command: "rl eval plan resume", pmRoot: w.pmRoot, args: [w.plan.candidate] });
    await assert.rejects(operation, drift);
    assert.deepEqual(history(w), before, "Replay must refuse without rewriting evidence");
  });
});

test("causal birth verdict permits an idempotent rewrite and registration retry", async () => {
  await withCandidate(verdict, async w => {
    await w.client.update(w.plan.candidate, { body: await rewrittenBody(w, { detail: { cohort: "sealed", samples: 16 }, reason_digest: verdict.reason_digest, decision: "refuse" }) });
    await validate(w);
    for (const preflight of [true, false]) assert.equal((await registerGenerationCore(w.client, { ...w.generation, evaluation: verdict, preflight })).created, false);
    assert.deepEqual(extractGenerationSpec(String((await readCompleteLoopItem(w.client, w.plan.candidate)).item.body), "Idempotent verdict").policy_evaluation, verdict);
  });
});

test("causal birth verdict permits the real post-birth rejection addition and retry", async () => {
  await withCandidate(undefined, async w => {
    const reason = "Post-birth evaluator refusal";
    assert.equal(await recordRefusedPolicyCard(w.client, w.plan.candidate, reason), "refused");
    const spec = extractGenerationSpec(String((await readCompleteLoopItem(w.client, w.plan.candidate)).item.body), "Sealed rejection");
    assert.deepEqual(spec.policy_evaluation, { decision: "refuse", reason_digest: hashJson(reason) });
    await validate(w);
    assert.equal(await recordRefusedPolicyCard(w.client, w.plan.candidate, "Different retry reason"), "refused");
    assert.equal((await registerGenerationCore(w.client, w.generation)).created, false);
    await validate(w);
    assert.deepEqual(extractGenerationSpec(String((await readCompleteLoopItem(w.client, w.plan.candidate)).item.body), "Retained verdict").policy_evaluation, spec.policy_evaluation);
  });
});

for (const tamper of ["SDK promote", "CLI promote", "SDK removal"]) {
  for (const consumer of ["validation", "SDK replay", "CLI replay", "append"]) test(`causal write-once verdict rejects ${tamper} through ${consumer}`, async () => {
    await withCandidate(undefined, async w => {
      await recordSequentialEvaluation(w.client, w.plan.candidate, w.rows.slice(0, 16));
      assert.equal(await recordRefusedPolicyCard(w.client, w.plan.candidate, "Stop after first look"), "refused");
      const spec = extractGenerationSpec(String((await readCompleteLoopItem(w.client, w.plan.candidate)).item.body), "First stored verdict");
      const changed = tamper === "SDK removal" ? undefined : { ...(spec.policy_evaluation as Record<string, JsonValue>), decision: "promote" };
      const body = await rewrittenBody(w, changed);
      if (tamper === "CLI promote") {
        const update = spawnSync(process.execPath, [pmCliEntry, "--no-extensions", "--pm-path", w.pmRoot, "update", w.plan.candidate, "--body", body, "--json"], { cwd: w.root, encoding: "utf8", env: isolatedChildEnv(), timeout: 60_000 });
        assert.equal(update.error, undefined);
        assert.equal(update.status, 0, update.stdout + update.stderr);
      } else await w.client.update(w.plan.candidate, { body });
      const before = history(w);
      const operations: Record<string, () => Promise<unknown>> = {
        validation: () => validate(w),
        "SDK replay": () => readSequentialEvaluation(w.client, w.plan.candidate),
        "CLI replay": () => w.harness.runCommand({ command: "rl eval plan resume", pmRoot: w.pmRoot, args: [w.plan.candidate] }),
        append: () => recordSequentialEvaluation(w.client, w.plan.candidate, w.rows),
      };
      await assert.rejects(operations[consumer], drift);
      assert.deepEqual(history(w), before, "A tampered first verdict must refuse before every publication");
      assert.equal(existsSync(join(w.pmRoot, "history", `${w.plan.candidate}-evaluation-plan-look-2.jsonl`)), false);
    });
  });
}

test("causal write-once verdict rejects a changed post-birth reason", async () => {
  await withCandidate(undefined, async w => {
    await recordRefusedPolicyCard(w.client, w.plan.candidate, "First reason");
    await w.client.update(w.plan.candidate, { body: await rewrittenBody(w, { decision: "refuse", reason_digest: hashJson("Changed reason") }) });
    const before = history(w);
    await assert.rejects(validate(w), drift);
    assert.deepEqual(history(w), before);
  });
});

test("causal write-once verdict rejects a historical tamper after the current value is restored", async () => {
  await withCandidate(undefined, async w => {
    await recordRefusedPolicyCard(w.client, w.plan.candidate, "First reason");
    const original = String((await readCompleteLoopItem(w.client, w.plan.candidate)).item.body);
    await w.client.update(w.plan.candidate, { body: await rewrittenBody(w, { decision: "promote", reason_digest: hashJson("First reason") }) });
    await w.client.update(w.plan.candidate, { body: original });
    const before = history(w);
    await assert.rejects(validate(w), drift);
    assert.deepEqual(history(w), before, "Restoring current state cannot erase a native history violation");
  });
});

test("causal write-once verdict rejects a changed post-birth verdict on native retry verification", async () => {
  await withCandidate(undefined, async w => {
    const spec = extractGenerationSpec(String((await readCompleteLoopItem(w.client, "rl-seed")).item.body), "Native retry seed");
    const options = { id: "rl-native-retry", type: "Generation", title: "Native retry verdict", body: `\`\`\`json\n${JSON.stringify(spec)}\n\`\`\`` };
    const artifacts = [{ id: options.id, stage: 0 }];
    await createCausalEvaluationArtifact(w.client, w.plan, options, artifacts);
    const evaluation = { decision: "refuse", reason_digest: hashJson("Retry verdict") };
    await w.client.update(options.id, { body: `\`\`\`json\n${JSON.stringify({ ...spec, policy_evaluation: evaluation })}\n\`\`\`` });
    await verifyCausalEvaluationRetry(w.client, w.plan, options, artifacts);
    await verifyCausalEvaluationRetry(w.client, w.plan, options, []);
    await w.client.update(options.id, { body: `\`\`\`json\n${JSON.stringify({ ...spec, policy_evaluation: { ...evaluation, decision: "promote" } })}\n\`\`\`` });
    const before = history(w);
    await assert.rejects(verifyCausalEvaluationRetry(w.client, w.plan, options, artifacts), drift);
    assert.deepEqual(history(w), before);
  });
});

test("causal write-once verdict permits its first addition and an idempotent rewrite", async () => {
  await withCandidate(undefined, async w => {
    const reason = "First stored verdict";
    await recordSequentialEvaluation(w.client, w.plan.candidate, w.rows.slice(0, 16));
    await recordRefusedPolicyCard(w.client, w.plan.candidate, reason);
    await w.client.update(w.plan.candidate, { body: await rewrittenBody(w, { reason_digest: hashJson(reason), decision: "refuse" }) });
    await w.client.notes(w.plan.candidate, { add: "Unrelated post-verdict annotation" });
    await validate(w);
    const report = await readSequentialEvaluation(w.client, w.plan.candidate);
    assert.ok(report !== null && !("status" in report));
    assert.equal(report.sequential?.look, 1);
    assert.equal((await registerGenerationCore(w.client, w.generation)).created, false);
  });
});

test("causal write-once verdict permits a candidate that never gets a verdict", async () => {
  await withCandidate(undefined, async w => {
    await w.client.notes(w.plan.candidate, { add: "No evaluator verdict" });
    for (const rows of [w.rows.slice(0, 16), w.rows]) await recordSequentialEvaluation(w.client, w.plan.candidate, rows);
    await validate(w);
    assert.equal((await registerGenerationCore(w.client, w.generation)).created, false);
    assert.equal(extractGenerationSpec(String((await readCompleteLoopItem(w.client, w.plan.candidate)).item.body), "No verdict").policy_evaluation, undefined);
  });
});
