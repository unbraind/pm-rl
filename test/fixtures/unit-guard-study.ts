/** Deterministic comparison inputs for the downstream workflow regression example. */
import { readFileSync } from "node:fs";
import { evaluatePlan, parseEvaluationPlan, type EvaluationPlan } from "../../index.ts";

/** Two observations per workflow, with a single failing workflow chosen before scoring. */
export function unitGuardStudy(incumbentVersion: string) {
  const example = JSON.parse(readFileSync(new URL("../../examples/evaluation-plan.json", import.meta.url), "utf8"));
  const workflows = Array.from({ length: 32 }, (_, i) => `workflow-${i}`);
  const members = workflows.flatMap((unit) => ["intake", "handoff"].map((step) => ({ id: `${unit}-${step}`, unit })));
  const aggregate: EvaluationPlan = parseEvaluationPlan({
    ...example, incumbent_version: incumbentVersion, population: "Synthetic PM workflows", correlation_unit: "workflow",
    selection: "All 32 workflows, two observations each", members, stopping: { kind: "fixed", independent_units: workflows.length, observations: members.length },
  });
  const seed = 42;
  const regressed = workflows[((Math.imul(seed, 1664525) + 1013904223) >>> 0) % workflows.length];
  const observations = members.map(({ id, unit }) => ({ id, candidate: Number(unit !== regressed), incumbent: Number(unit === regressed) }));
  const expanded = parseEvaluationPlan({ ...aggregate, protected_cohorts: workflows.map((unit) => ({
    id: unit, members: members.filter((member) => member.unit === unit).map((member) => member.id), min_units: 1, max_regression: 0,
  })) });
  const guarded = parseEvaluationPlan({ ...aggregate, max_unit_regression: 0 });
  return { aggregate, expanded, guarded, observations, regressed };
}

if (import.meta.main) {
  const example = JSON.parse(readFileSync(new URL("../../examples/evaluation-plan.json", import.meta.url), "utf8"));
  const { aggregate, expanded, guarded, observations } = unitGuardStudy(example.incumbent_version);
  // Serialize each complete SDK input and output exactly once, as consumed by the tokenizer.
  console.log(JSON.stringify([aggregate, expanded, guarded].map((plan) => ({ plan, report: evaluatePlan(plan, observations) }))));
}
