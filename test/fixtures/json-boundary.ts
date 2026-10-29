/** Shared adversarial inputs for source and packed-host acceptance. */
import { readFileSync } from "node:fs";
import type { EvaluationPlan } from "../../evaluation-plan.ts";
import { MAX_JSON_BYTES } from "../../tracker-record.ts";
/** Generate the maximal structural cohort domain; cardinality alone cannot bound its encoding. */
export function largePlan(references = 320_000): EvaluationPlan {
  const base = JSON.parse(readFileSync(new URL("../../examples/evaluation-plan.json", import.meta.url), "utf8")) as EvaluationPlan;
  const members = Array.from({ length: 10_000 }, (_, i) => ({ id: String(i).padStart(64, "x"), unit: `unit-${i}` }));
  let extra = references - 32;
  const protected_cohorts = Array.from({ length: 32 }, (_, i) => {
    const count = Math.min(extra, 9999) + 1; extra -= count - 1;
    return { id: `cohort-${String(i).padStart(2, "0")}`, members: members.slice(0, count).map((member) => member.id), min_units: 1, max_regression: 0 };
  });
  return { ...base, members, protected_cohorts, stopping: { kind: "fixed", observations: members.length, independent_units: members.length } };
}
/** Compute the actual immutable wrapper without borrowing production admission logic. */
export function reservation(plan: EvaluationPlan): string { return JSON.stringify({ plan, incumbent_version: plan.incumbent_version }); }
/** An input fits the reader while the immutable reservation wrapper exceeds it. */
export function wrapperOverflowPlan(): EvaluationPlan {
  const baseBytes = Buffer.byteLength(reservation(largePlan(32)));
  return largePlan(32 + Math.floor((MAX_JSON_BYTES - baseBytes) / 67) + 1);
}
