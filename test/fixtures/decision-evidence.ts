/** Real non-git evaluation inputs shared by provenance properties and packed consumers. */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PmClient } from "@unbrained/pm-cli/sdk/core";
import { init } from "@unbrained/pm-cli/sdk/runtime";
import { generationProvenance, hashJson, promoteGenerationCore, readCompleteLoopItem, withRlController } from "../../index.ts";
import { evaluationComparison, registerEvaluationPlan, readEvaluationDecision, type EvaluationPlan } from "../../evaluation-plan.ts";
import { recordSequentialEvaluation } from "../../sequential-evaluation.ts";
import { exportPolicyCard, recordPolicyCard, type PolicyCard } from "../../policy-card.ts";
import { encodeEvent } from "../../series.ts";
import type { GenerationSpec, ScoreRecord } from "../../lineage.ts";

/** Seal two looks, optionally promote, and create all recursive card selections through the actual controller. */
export async function decisionFixture(promote = true, recursive = true, complete = true) {
  const root = mkdtempSync(join(tmpdir(), "rl-decision-graph-"));
  const initialized = await init("rl", { defaults: true, author: "decision-test", agentGuidance: "skip" }, { cwd: root, pmRoot: join(root, ".agents/pm") });
  const client = new PmClient({ cwd: root, pmRoot: initialized.path, author: "decision-test", noExtensions: true });
  for (const type of ["Generation", "Run", "Environment"]) await client.schemaAddType(type, { folder: `${type.toLowerCase()}s`, defaultStatus: "open" });
  const seed: GenerationSpec = { base_checkpoint: `sha256:${hashJson("seed")}`, policy: "", collection_runs: [], training_config: { samples: 64 }, environment_version: "", reward_spec_version: "", parent: null, seed: true, promoted: false, approval: null, proxy_score: null, held_out_score: null, gap: null, promotion_evidence: null };
  await client.create({ id: "rl-seed", type: "Generation", title: "Seed", body: `\`\`\`json\n${JSON.stringify(seed)}\n\`\`\``, affectedVersion: hashJson(generationProvenance(seed)) });
  await recordPolicyCard(client, "rl-seed");
  await client.create({ id: "rl-training", type: "Environment", title: "Training" });
  const members = Array.from({ length: 64 }, (_, index) => ({ id: `m${index}`, unit: `u${index}` }));
  const plan: EvaluationPlan = { format: "pm-rl/evaluation-plan/1", candidate: "rl-candidate", incumbent: "rl-seed", incumbent_version: hashJson(generationProvenance(seed)), population: "Frozen", selection: "all", correlation_unit: "session", members, objective: "reward", objective_version: "v1", evaluation_context: "held-out", direction: "maximize", reward_bounds: [0, 1], criterion: { confidence: 0.95, minSamples: 8, effectThreshold: 0 }, stopping: { kind: "sequential", method: "hoeffding-alpha-spending/1", observations: 64, independent_units: 64, unit_order: members.map((member) => member.unit), looks: [16, 64], review: "rl-review" } };
  await client.create({ id: "rl-review", type: "Decision", title: "Review", body: JSON.stringify({ format: "pm-rl/sequential-review/1", comparison: evaluationComparison(plan) }) });
  await registerEvaluationPlan(client, plan);
  await client.create({ id: "rl-collection", type: "Run", title: "Collection", environment: "rl-training" });
  await client.notes("rl-collection", { add: encodeEvent({ step: 0, metric: "return", value: 0.25 }) });
  const candidate: GenerationSpec = { ...seed, evaluation_plan: evaluationComparison(plan), base_checkpoint: `sha256:${hashJson("candidate")}`, policy: `sha256:${hashJson("policy")}`, parent: "rl-seed", seed: false, collection_runs: ["rl-collection"], environment_version: "rl-training", reward_spec_version: "v1" };
  await client.create({ id: plan.candidate, type: "Generation", title: "Candidate", body: `\`\`\`json\n${JSON.stringify(candidate)}\n\`\`\``, affectedVersion: hashJson(generationProvenance(candidate)) });
  const rows = plan.members.map((member, index) => ({ id: member.id, candidate: index < 16 ? 0 : 1, incumbent: 0 }));
  const first = await recordSequentialEvaluation(client, plan.candidate, rows.slice(0, 16));
  const report = complete ? await recordSequentialEvaluation(client, plan.candidate, rows) : first;
  if ("status" in report) throw new Error("Foreign fixture evidence");
  const candidateCard = await exportPolicyCard(client, plan.candidate);
  const score: ScoreRecord = { objective: plan.objective, objective_version: plan.objective_version, evaluation_context: plan.evaluation_context, direction: plan.direction, seed_set: evaluationComparison(plan), scale: 1, value: report.candidate_mean };
  await client.create({ id: "rl-approval", type: "Decision", title: "Consent", body: '```json\n{"permitted_promotions":2}\n```' });
  if (promote) await promoteGenerationCore(client, { pmRoot: initialized.path, author: "decision-test" }, plan.candidate, "rl-approval", { ...score, evaluation_context: "proxy" }, score, "Complete stopping evidence");
  const cards: PolicyCard[] = [await exportPolicyCard(client, plan.candidate)];
  if (recursive) {
    await withRlController(client, { pmRoot: initialized.path, author: "decision-test" }, { id: "graph", approval: "rl-approval", recoveryCommand: "pm rl meta resume graph" }, new AbortController().signal, async (step) => {
      await step("decision", { candidate: plan.candidate }, async () => { await readEvaluationDecision(client, plan.candidate); return { configs: [{ samples: 1 }, { samples: 2 }], promoted: promote }; });
    });
    for (const selection of [null, 0, 1]) cards.push(await exportPolicyCard(client, "rl-graph-step-decision", selection));
  }
  return { root, pmRoot: initialized.path, client, plan, rows, report, score, candidateCard, cards, native: await readCompleteLoopItem(client, plan.candidate) };
}
