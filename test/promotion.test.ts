/** Adversarial tests for the fail-closed, statistically bounded promotion gate. */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  decidePromotion,
  hoeffdingEpsilon,
  parsePromotionCriterion,
  parsePromotionEvidence,
  type PromotionCriterion,
  type PromotionEvidence,
  type PromotionGateInput,
} from "../promotion.ts";
import { buildLineageAncestry, DEFAULT_GAP_WINDOW, type AncestryEntry, type GenerationSpec } from "../lineage.ts";

/** A held-out evidence record with overridable fields, attributed to one standard. */
function evidence(overrides: Partial<PromotionEvidence> = {}): PromotionEvidence {
  return {
    generation: "gen-c1",
    objective: "episode_return",
    objective_version: "obj-v1",
    evaluation_context: "held-out-ctx",
    direction: "maximize",
    samples: 1000,
    mean: 0.55,
    rewardBounds: [0, 1],
    ...overrides,
  };
}

/** A permissive criterion for positive controls, overridable per test. */
function criterion(overrides: Partial<PromotionCriterion> = {}): PromotionCriterion {
  return { confidence: 0.95, minSamples: 10, effectThreshold: 0, ...overrides };
}

/** Build a gate input from overridable sides, keeping contamination isolated by default. */
function gateInput(overrides: Partial<PromotionGateInput> = {}): PromotionGateInput {
  return {
    candidate: evidence(),
    incumbent: evidence({ generation: "gen-seed", mean: 0.5 }),
    criterion: criterion(),
    contaminationPath: null,
    expectedGeneration: "gen-c1",
    ...overrides,
  };
}

test("promotion with NO candidate evaluation evidence is refused (fail-closed default is no)", () => {
  const verdict = decidePromotion(gateInput({ candidate: null }));
  assert.equal(verdict.decision, "refuse");
  if (verdict.decision === "refuse") assert.equal(verdict.code, "no_candidate_evidence");
});

test("promotion with NO incumbent evaluation evidence is refused (no baseline to beat)", () => {
  const verdict = decidePromotion(gateInput({ incumbent: null }));
  assert.equal(verdict.decision, "refuse");
  if (verdict.decision === "refuse") assert.equal(verdict.code, "no_incumbent_evidence");
});

test("promotion with unreadable candidate evidence (parse returns null) is refused as absent", () => {
  // A non-object, a missing generation, a non-integer sample count and an out-of-range mean all parse to null.
  for (const bad of [undefined, null, "text", 5, [], { generation: "  " }, { generation: "g", objective: "" }, { generation: "gen-c1", objective: "o", samples: "x" }, { generation: "g", objective: "o", objective_version: "v", evaluation_context: "  " }, { generation: "g", objective: "o", objective_version: "v", evaluation_context: "c", direction: "sideways", samples: 1, mean: 0.5, rewardBounds: [0, 1] }, { generation: "g", objective: "o", objective_version: "v", evaluation_context: "c", direction: "maximize", samples: 1, mean: NaN, rewardBounds: [0, 1] }, { generation: "g", objective: "o", objective_version: "v", evaluation_context: "c", direction: "maximize", samples: 1, mean: 0.5, rewardBounds: [1, 0] }]) {
    assert.equal(parsePromotionEvidence(bad), null, `expected null for ${JSON.stringify(bad)}`);
  }
  const verdict = decidePromotion(gateInput({ candidate: parsePromotionEvidence({ generation: "gen-c1", objective: "o", samples: "x" }) }));
  assert.equal(verdict.decision, "refuse");
  if (verdict.decision === "refuse") assert.equal(verdict.code, "no_candidate_evidence");
});

test("promotion with evidence for the WRONG generation is refused", () => {
  const verdict = decidePromotion(gateInput({
    candidate: evidence({ generation: "gen-other" }),
    expectedGeneration: "gen-c1",
  }));
  assert.equal(verdict.decision, "refuse");
  if (verdict.decision === "refuse") {
    assert.equal(verdict.code, "wrong_generation_evidence");
    assert.match(verdict.reason, /gen-other/);
  }
});

test("promotion where the incumbent is the candidate itself is refused (cannot beat itself)", () => {
  const verdict = decidePromotion(gateInput({
    candidate: evidence({ generation: "gen-c1" }),
    incumbent: evidence({ generation: "gen-c1", mean: 0.5 }),
  }));
  assert.equal(verdict.decision, "refuse");
  if (verdict.decision === "refuse") assert.equal(verdict.code, "incumbent_is_candidate");
});

test("promotion with evidence from the training set (contaminated held-out) is refused", () => {
  const verdict = decidePromotion(gateInput({ contaminationPath: "gen-c1 →[environment_version]→ env-train" }));
  assert.equal(verdict.decision, "refuse");
  if (verdict.decision === "refuse") {
    assert.equal(verdict.code, "contaminated_held_out");
    assert.match(verdict.reason, /reachable from the candidate's training data/);
  }
});

test("promotion with incomparable evidence (differing objective, version, direction, context) is refused", () => {
  for (const [field, override] of [
    ["objective", { objective: "loss" }],
    ["objective_version", { objective_version: "obj-v2" }],
    ["direction", { direction: "minimize" as const }],
    ["evaluation_context", { evaluation_context: "other-ctx" }],
  ] as Array<[string, Partial<PromotionEvidence>]>) {
    const verdict = decidePromotion(gateInput({ candidate: evidence(override) }));
    assert.equal(verdict.decision, "refuse", `expected refuse for differing ${field}`);
    if (verdict.decision === "refuse") assert.equal(verdict.code, "incomparable_evidence");
  }
});

test("promotion with a single lucky sample above threshold but below the sample-count requirement is refused", () => {
  // One sample with a high mean: by chance it beats the incumbent, but minSamples rejects it.
  const verdict = decidePromotion(gateInput({
    candidate: evidence({ samples: 1, mean: 0.9 }),
    criterion: criterion({ minSamples: 100 }),
  }));
  assert.equal(verdict.decision, "refuse");
  if (verdict.decision === "refuse") {
    assert.equal(verdict.code, "insufficient_samples");
    assert.match(verdict.reason, /1 sample/);
  }
  // An incumbent with insufficient samples is refused on the same basis: the baseline must be as well measured as the candidate.
  const incumbentShort = decidePromotion(gateInput({
    incumbent: evidence({ generation: "gen-seed", samples: 1, mean: 0.5 }),
    criterion: criterion({ minSamples: 100 }),
  }));
  assert.equal(incumbentShort.decision, "refuse");
  if (incumbentShort.decision === "refuse") {
    assert.equal(incumbentShort.code, "insufficient_samples");
    assert.match(incumbentShort.reason, /incumbent evidence carries 1 sample/);
  }
  // Even with minSamples met, a single sample's Hoeffding bound is too wide to promote over a small effect.
  const wideBound = decidePromotion(gateInput({
    candidate: evidence({ samples: 1, mean: 0.55 }),
    incumbent: evidence({ generation: "gen-seed", mean: 0.5, samples: 1000 }),
    criterion: criterion({ minSamples: 1 }),
  }));
  assert.equal(wideBound.decision, "refuse");
  if (wideBound.decision === "refuse") assert.equal(wideBound.code, "no_statistical_improvement");
});

test("promotion with a genuine statistically sound improvement is promoted (positive control)", () => {
  const verdict = decidePromotion(gateInput({
    candidate: evidence({ samples: 10000, mean: 0.6 }),
    incumbent: evidence({ generation: "gen-seed", mean: 0.5, samples: 10000 }),
  }));
  assert.equal(verdict.decision, "promote");
  if (verdict.decision === "promote") {
    assert.ok(verdict.margin > 0);
    assert.ok(verdict.candidateBound > verdict.incumbentBound);
  }
  // A minimize objective with a genuine decrease is also promoted.
  const minimized = decidePromotion(gateInput({
    candidate: evidence({ direction: "minimize", samples: 10000, mean: 0.4 }),
    incumbent: evidence({ generation: "gen-seed", direction: "minimize", mean: 0.5, samples: 10000 }),
  }));
  assert.equal(minimized.decision, "promote");
});

test("a regressing generation is not promoted and the refusal records the regression", () => {
  const verdict = decidePromotion(gateInput({
    candidate: evidence({ samples: 10000, mean: 0.45 }),
    incumbent: evidence({ generation: "gen-seed", mean: 0.5, samples: 10000 }),
  }));
  assert.equal(verdict.decision, "refuse");
  if (verdict.decision === "refuse") {
    assert.equal(verdict.code, "no_statistical_improvement");
    assert.match(verdict.reason, /regressed/);
  }
});

test("evidence whose mean lies outside its declared reward bounds is refused", () => {
  const verdict = decidePromotion(gateInput({
    candidate: evidence({ mean: 1.5, rewardBounds: [0, 1] }),
  }));
  assert.equal(verdict.decision, "refuse");
  if (verdict.decision === "refuse") assert.equal(verdict.code, "invalid_evidence");
});

test("parsePromotionCriterion validates the configuration and throws on misconfiguration", () => {
  assert.deepEqual(parsePromotionCriterion({ confidence: 0.9, minSamples: 5, effectThreshold: 0.01 }), { confidence: 0.9, minSamples: 5, effectThreshold: 0.01 });
  for (const bad of [
    null, [], "x", 5,
    { confidence: 0.95, minSamples: 5 },
    { confidence: 0, minSamples: 5, effectThreshold: 0 },
    { confidence: 1, minSamples: 5, effectThreshold: 0 },
    { confidence: 0.95, minSamples: 0, effectThreshold: 0 },
    { confidence: 0.95, minSamples: 1.5, effectThreshold: 0 },
    { confidence: 0.95, minSamples: 5, effectThreshold: -1 },
    { confidence: NaN, minSamples: 5, effectThreshold: 0 },
  ]) {
    assert.throws(() => parsePromotionCriterion(bad), /promotion_criterion requires/);
  }
});

test("hoeffdingEpsilon is distribution-free and shrinks with more samples", () => {
  const wide = hoeffdingEpsilon(1, 1, 0.05);
  const narrow = hoeffdingEpsilon(10000, 1, 0.05);
  assert.ok(wide > 0.9);
  assert.ok(narrow < 0.02);
  // The bound scales with the declared range, so a wider range widens the bound.
  assert.ok(hoeffdingEpsilon(1000, 2, 0.05) > hoeffdingEpsilon(1000, 1, 0.05));
  // Higher confidence (smaller alpha) widens the bound.
  assert.ok(hoeffdingEpsilon(1000, 1, 0.01) > hoeffdingEpsilon(1000, 1, 0.05));
});

test("parsePromotionEvidence returns trimmed, validated evidence for a complete record", () => {
  const parsed = parsePromotionEvidence({
    generation: "  gen-c1  ", objective: "  episode_return  ", objective_version: "  obj-v1  ",
    evaluation_context: "  held-out-ctx  ", direction: "maximize", samples: 1000, mean: 0.55, rewardBounds: [0, 1],
  });
  assert.deepEqual(parsed, {
    generation: "gen-c1", objective: "episode_return", objective_version: "obj-v1",
    evaluation_context: "held-out-ctx", direction: "maximize", samples: 1000, mean: 0.55, rewardBounds: [0, 1],
  });
  // A minimize record parses the same way.
  const minimized = parsePromotionEvidence({ generation: "g", objective: "o", objective_version: "v", evaluation_context: "c", direction: "minimize", samples: 1, mean: 0.5, rewardBounds: [0, 2] });
  assert.equal(minimized?.direction, "minimize");
  assert.deepEqual(minimized?.rewardBounds, [0, 2]);
  // Reward bounds where lo equals hi (a constant reward) are valid.
  assert.deepEqual(parsePromotionEvidence({ generation: "g", objective: "o", objective_version: "v", evaluation_context: "c", direction: "maximize", samples: 1, mean: 0.5, rewardBounds: [0.5, 0.5] })?.rewardBounds, [0.5, 0.5]);
  // Every malformed reward-bounds shape parses to null.
  for (const badBounds of ["x", [0], [0, 1, 2], ["x", 1], [0, "y"], [0, NaN], [Infinity, 1], [1, 0]] as unknown[]) {
    assert.equal(parsePromotionEvidence({ generation: "g", objective: "o", objective_version: "v", evaluation_context: "c", direction: "maximize", samples: 1, mean: 0.5, rewardBounds: badBounds }), null, `expected null for bounds ${JSON.stringify(badBounds)}`);
  }
  // A non-integer or non-positive sample count is unreadable.
  for (const samples of [0, -1, 0.5, "x", NaN]) {
    assert.equal(parsePromotionEvidence({ generation: "g", objective: "o", objective_version: "v", evaluation_context: "c", direction: "maximize", samples, mean: 0.5, rewardBounds: [0, 1] }), null);
  }
});

test("evidence whose incumbent mean lies outside its declared reward bounds is refused", () => {
  // Above the upper bound.
  const above = decidePromotion(gateInput({
    incumbent: evidence({ generation: "gen-seed", mean: 1.5, rewardBounds: [0, 1] }),
  }));
  assert.equal(above.decision, "refuse");
  if (above.decision === "refuse") assert.equal(above.code, "invalid_evidence");
  // Below the lower bound.
  const below = decidePromotion(gateInput({
    incumbent: evidence({ generation: "gen-seed", mean: -0.5, rewardBounds: [0, 1] }),
  }));
  assert.equal(below.decision, "refuse");
  if (below.decision === "refuse") assert.equal(below.code, "invalid_evidence");
  // The candidate below its lower bound is also refused.
  const candidateBelow = decidePromotion(gateInput({
    candidate: evidence({ mean: -0.5, rewardBounds: [0, 1] }),
  }));
  assert.equal(candidateBelow.decision, "refuse");
  if (candidateBelow.decision === "refuse") assert.equal(candidateBelow.code, "invalid_evidence");
});

test("a regressing minimize candidate is refused with the minimize bound wording", () => {
  // Lower is better: the candidate's mean rose, so it regressed. The refuse path
  // exercises the minimize branches of the bound ternaries.
  const verdict = decidePromotion(gateInput({
    candidate: evidence({ direction: "minimize", samples: 100000, mean: 0.55 }),
    incumbent: evidence({ generation: "gen-seed", direction: "minimize", mean: 0.5, samples: 100000 }),
  }));
  assert.equal(verdict.decision, "refuse");
  if (verdict.decision === "refuse") assert.equal(verdict.code, "no_statistical_improvement");
});

test("the gate is deterministic: identical inputs reproduce an identical verdict byte-for-byte", () => {
  const input = gateInput({ candidate: evidence({ samples: 5000, mean: 0.58 }), incumbent: evidence({ generation: "gen-seed", mean: 0.5, samples: 5000 }) });
  const first = decidePromotion(input);
  const second = decidePromotion(input);
  assert.deepEqual(first, second);
  assert.equal(JSON.stringify(first), JSON.stringify(second));
});

test("the effect threshold is enforced: a sub-threshold improvement is refused", () => {
  // A small true improvement that does not clear a large effect threshold is refused.
  const verdict = decidePromotion(gateInput({
    candidate: evidence({ samples: 100000, mean: 0.505 }),
    incumbent: evidence({ generation: "gen-seed", mean: 0.5, samples: 100000 }),
    criterion: criterion({ effectThreshold: 0.05 }),
  }));
  assert.equal(verdict.decision, "refuse");
  if (verdict.decision === "refuse") assert.equal(verdict.code, "no_statistical_improvement");
});

/** A generation spec builder for the transitive-invalidation lineage test. */
function genSpec(overrides: Partial<GenerationSpec> = {}): GenerationSpec {
  return {
    base_checkpoint: "ckpt",
    policy: "",
    collection_runs: [],
    training_config: {},
    environment_version: "",
    reward_spec_version: "",
    parent: null,
    seed: true,
    promoted: false,
    approval: null,
    proxy_score: null,
    held_out_score: null,
    gap: null,
    promotion_evidence: null,
    ...overrides,
  };
}

test("an ancestor invalidated after the gate promoted it transitively invalidates its descendants", () => {
  // The gate promoted gen-a and gen-b (each was measured to beat its incumbent).
  // Later, gen-a's recorded environment is edited. The existing transitive
  // invalidation (buildLineageAncestry) must reach gen-b, because gen-b's
  // training data derives from gen-a. The gate does not rebuild this; it relies
  // on the existing lineage walk, so this test asserts the two compose.
  const promoteA = decidePromotion(gateInput({
    candidate: evidence({ generation: "gen-a", samples: 100000, mean: 0.6 }),
    incumbent: evidence({ generation: "gen-seed", mean: 0.5, samples: 100000 }),
    expectedGeneration: "gen-a",
  }));
  assert.equal(promoteA.decision, "promote");
  const promoteB = decidePromotion(gateInput({
    candidate: evidence({ generation: "gen-b", samples: 100000, mean: 0.62 }),
    incumbent: evidence({ generation: "gen-a", mean: 0.6, samples: 100000 }),
    expectedGeneration: "gen-b",
  }));
  assert.equal(promoteB.decision, "promote");
  const entries: AncestryEntry[] = [
    { id: "gen-seed", spec: genSpec({ base_checkpoint: "ckpt-0", gap: null }), runEnvironments: new Map() },
    { id: "gen-a", spec: genSpec({ base_checkpoint: "ckpt-a", environment_version: "env-edited", gap: 1, promoted: true, approval: "approval-1", promotion_evidence: "gate promoted gen-a", parent: "gen-seed", seed: false, policy: "pa", collection_runs: ["run-a"], reward_spec_version: "r" }), runEnvironments: new Map() },
    { id: "gen-b", spec: genSpec({ base_checkpoint: "ckpt-b", environment_version: "env-other", gap: 2, promoted: true, approval: "approval-1", promotion_evidence: "gate promoted gen-b", parent: "gen-a", seed: false, policy: "pb", collection_runs: ["run-b"], reward_spec_version: "r" }), runEnvironments: new Map() },
  ];
  // gen-a's own environment is the one edited; gen-b recorded a different, still-valid environment.
  const ancestry = buildLineageAncestry(entries, new Map([["gen-a", "environment was edited"]]), DEFAULT_GAP_WINDOW);
  assert.equal(ancestry.rows[1]!.invalidated, "environment was edited");
  assert.equal(ancestry.rows[2]!.invalidated, "invalidated by ancestor gen-a");
});