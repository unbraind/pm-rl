/**
 * @module pm-rl/promotion
 *
 * The fail-closed, statistically bounded promotion gate that closes the
 * recursive self-improvement loop.
 *
 * The recursive generations already run (see {@link ./bandit.ts}): a candidate
 * policy is collected, trained, and measured. What makes that loop recursive
 * *self-improvement* rather than "a loop that runs N times" is that generation
 * N+1 is admitted ONLY because generation N was measured to be better, on
 * evidence that cannot be fabricated by the thing being measured. This module
 * is that decision.
 *
 * The functions here are pure: they validate evidence, compute a bound, and
 * return a verdict without touching a pm tracker. The command handler in
 * {@link ./index.ts} reads the evidence, calls {@link decidePromotion}, records
 * the verdict as attributable lineage, and refuses to advance on any refusal.
 *
 * ## Property and domain
 *
 * The gate enforces ONE property over ONE domain:
 *
 * - **Property.** A candidate is promoted only when its held-out expected
 *   reward exceeds the incumbent's by at least the effect threshold, with
 *   confidence at least `1 - alpha`, using at least `minSamples` evaluation
 *   episodes, AND the held-out evaluation set is not reachable from the
 *   candidate's training data. The default answer is NO: absent, unreadable,
 *   self-referential, incomparable, or statistically insufficient evidence
 *   promotes NOTHING.
 * - **Domain.** Pairs of bounded-reward evaluation evidence records (candidate
 *   and incumbent) carrying a finite empirical mean, a finite sample count, and
 *   declared reward bounds `[lo, hi]`; a configured confidence level in `(0, 1)`,
 *   a minimum sample count `>= 1`, and an effect threshold `>= 0`; and a
 *   contamination verdict (`null` = the held-out set is isolated from training).
 *
 * The bound is the Hoeffding inequality for bounded random variables. It is
 * distribution-free: it needs no assumption on the reward distribution beyond
 * the declared bounds, which makes it valid for any bounded objective a caller
 * pins a range to. It is conservative for small samples, which is the property a
 * fail-closed gate wants — a gate that is tight on small samples would admit
 * noisy single-sample wins, which is exactly the failure mode this gate exists
 * to stop.
 *
 * ## What this buys and what it does not
 *
 * - **Buys.** With probability at least `1 - alpha`, a promoted candidate's
 *   TRUE expected reward on the pinned held-out set exceeds the incumbent's by
 *   at least the effect threshold. A single lucky sample cannot promote, because
 *   the lower confidence bound of a small-sample candidate is far below its
 *   empirical mean. A regressing candidate cannot promote, because its bound lies
 *   below the incumbent's. A candidate measured on the training set cannot
 *   promote, because the contamination verdict is non-null.
 * - **Does not buy.** Protection against a held-out set that is semantically
 *   duplicated under a different name — that is the contamination gate's job
 *   ({@link ./lineage.ts} `findContaminationPath`), which this gate consumes but
 *   does not rebuild. Protection against a non-stationary environment, where the
 *   held-out set and the deployed distribution drift apart. An unbiased estimate
 *   of future performance after repeated selection — repeated promotion
 *   decisions re-use the held-out set, so it is an adaptive validation set, not
 *   a final benchmark; a separate held-out benchmark remains necessary for an
 *   unbiased post-hoc claim. Detection of reward hacking on the held-out set
 *   itself, where the measured objective is gamed without contaminating the data.
 *   A tight bound on small samples — the gate refuses near-threshold candidates
 *   rather than guessing, which is the correct fail-closed behaviour but means a
 *   truly better small-sample candidate is held back until more evidence arrives.
 */

/** Optimization direction shared by comparable evidence. */
export type PromotionDirection = "maximize" | "minimize";

/**
 * Bounded-reward evaluation evidence for one generation on the held-out set.
 *
 * The evidence is the smallest unit a promotion verdict depends on, so it is
 * the unit that must be attributable and unfabricatable. It pins the objective,
 * its content-addressed version, the held-out evaluation context, the direction,
 * the generation it was measured for, the sample count, the empirical mean, and
 * the declared reward bounds the Hoeffding bound uses. A verdict over evidence
 * missing any of these is a verdict over nothing, so the gate refuses rather
 * than guessing.
 */
export interface PromotionEvidence {
  /** Generation item id this evidence was measured for; never empty. */
  readonly generation: string;
  /** Objective identifier, e.g. `episode_return`; never empty. */
  readonly objective: string;
  /** Content-addressed objective definition version; never empty. */
  readonly objective_version: string;
  /** Content-addressed held-out evaluation context the mean was measured on; never empty. */
  readonly evaluation_context: string;
  /** Whether a higher value is better or a lower one is. */
  readonly direction: PromotionDirection;
  /** Number of evaluation episodes that produced the mean; a positive integer. */
  readonly samples: number;
  /** Empirical mean reward over the episodes; finite. */
  readonly mean: number;
  /** Declared reward bounds `[lo, hi]` with `lo <= hi`, both finite; the bound's range. */
  readonly rewardBounds: readonly [number, number];
}

/** The statistical criterion a promotion is measured against. */
export interface PromotionCriterion {
  /** Confidence level `1 - alpha` in `(0, 1)`; higher is stricter. */
  readonly confidence: number;
  /** Minimum sample count each side must carry; a positive integer. */
  readonly minSamples: number;
  /** Minimum true-improvement margin required to promote; `>= 0`. */
  readonly effectThreshold: number;
}

/** One promotion gate verdict, promote or refuse. */
export type PromotionDecision =
  | {
    readonly decision: "promote";
    /** Human-readable summary of the bound that admitted the candidate. */
    readonly reason: string;
    /** Candidate lower bound minus incumbent upper bound minus the effect threshold. */
    readonly margin: number;
    /** The conservative (worst-case) bound used for the candidate. */
    readonly candidateBound: number;
    /** The conservative (worst-case) bound used for the incumbent. */
    readonly incumbentBound: number;
    /** The half-width of the Hoeffding bound at the candidate's sample count. */
    readonly candidateEpsilon: number;
    /** The half-width of the Hoeffding bound at the incumbent's sample count. */
    readonly incumbentEpsilon: number;
  }
  | {
    readonly decision: "refuse";
    /** Human-readable explanation an operator can act on. */
    readonly reason: string;
    /** Stable machine-readable refusal code a recursive loop branches on. */
    readonly code: string;
  };

/** Input bundle for {@link decidePromotion}. */
export interface PromotionGateInput {
  /** Candidate evidence, or `null` when absent or unreadable (fail-closed). */
  readonly candidate: PromotionEvidence | null;
  /** Incumbent evidence, or `null` when absent or unreadable (fail-closed). */
  readonly incumbent: PromotionEvidence | null;
  /** The statistical criterion; assumed valid (see {@link parsePromotionCriterion}). */
  readonly criterion: PromotionCriterion;
  /** Contamination path string when the held-out set is reachable from training; `null` when isolated. */
  readonly contaminationPath: string | null;
  /** The generation id the caller is trying to promote; the candidate must match it. */
  readonly expectedGeneration: string;
}

/**
 * Compute the half-width of the Hoeffding bound for bounded rewards.
 *
 * For `n` independent samples of a variable bounded in `[lo, hi]`, with
 * confidence `1 - alpha`, the empirical mean deviates from the true mean by at
 * most `epsilon` with probability at least `1 - alpha`:
 *
 * ```
 * epsilon = (hi - lo) * sqrt(ln(2 / alpha) / (2 * n))
 * ```
 *
 * Distribution-free and valid for any bounded reward; conservative for small
 * `n`, which is the property a fail-closed gate wants. The range is taken from
 * the evidence's declared bounds, not inferred, so a caller cannot tighten the
 * bound by lying about the reward range — a wider declared range widens the
 * bound, refusing more, never less.
 *
 * @param samples - Sample count; a positive integer.
 * @param range - Reward range `hi - lo`, finite and non-negative.
 * @param alpha - Significance level `1 - confidence` in `(0, 1)`.
 * @returns The half-width of the two-sided bound.
 */
export function hoeffdingEpsilon(samples: number, range: number, alpha: number): number {
  return range * Math.sqrt(Math.log(2 / alpha) / (2 * samples));
}

/**
 * Parse and validate a promotion criterion, throwing on any misconfiguration.
 *
 * A misconfigured criterion is a programmer error, not a promotion attempt, so
 * it throws rather than returning a refusal: the gate must be fail-closed about
 * EVIDENCE, but a criterion that is not a valid criterion cannot produce any
 * verdict and must be fixed before the loop runs.
 *
 * @param value - The parsed JSON value for the criterion.
 * @returns The validated criterion.
 * @throws When `confidence`, `minSamples`, or `effectThreshold` is absent, the
 *   wrong kind, or out of range.
 */
export function parsePromotionCriterion(value: unknown): PromotionCriterion {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("promotion_criterion requires one JSON object with confidence, minSamples and effectThreshold.");
  }
  const record = value as Record<string, unknown>;
  const confidence = record["confidence"];
  if (typeof confidence !== "number" || !Number.isFinite(confidence) || confidence <= 0 || confidence >= 1) {
    throw new Error("promotion_criterion requires confidence in (0, 1).");
  }
  const minSamples = record["minSamples"];
  if (typeof minSamples !== "number" || !Number.isInteger(minSamples) || minSamples < 1) {
    throw new Error("promotion_criterion requires a positive integer minSamples.");
  }
  const effectThreshold = record["effectThreshold"];
  if (typeof effectThreshold !== "number" || !Number.isFinite(effectThreshold) || effectThreshold < 0) {
    throw new Error("promotion_criterion requires a non-negative finite effectThreshold.");
  }
  return { confidence, minSamples, effectThreshold };
}

/**
 * Parse one promotion evidence record, returning `null` on any unreadable input.
 *
 * Returning `null` — not throwing — is the fail-closed contract: the gate treats
 * `null` evidence as absent evidence and refuses. A caller that cannot read or
 * validate a side's evidence passes `null` and the default answer (NO) holds
 * without the gate having to distinguish "unreadable" from "missing". The
 * generation, objective, version, evaluation context and direction are
 * trimmed because they are identities compared by strict equality in the gate.
 *
 * @param value - The parsed JSON value for one evidence record, or
 *   `null`/`undefined` when the field was absent.
 * @returns The validated evidence, or `null` when the input is not usable.
 */
export function parsePromotionEvidence(value: unknown): PromotionEvidence | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const generation = record["generation"];
  const objective = record["objective"];
  const objectiveVersion = record["objective_version"];
  const evaluationContext = record["evaluation_context"];
  const direction = record["direction"];
  const samples = record["samples"];
  const mean = record["mean"];
  const rewardBounds = record["rewardBounds"];
  if (typeof generation !== "string" || generation.trim().length === 0) return null;
  if (typeof objective !== "string" || objective.trim().length === 0) return null;
  if (typeof objectiveVersion !== "string" || objectiveVersion.trim().length === 0) return null;
  if (typeof evaluationContext !== "string" || evaluationContext.trim().length === 0) return null;
  if (direction !== "maximize" && direction !== "minimize") return null;
  if (typeof samples !== "number" || !Number.isInteger(samples) || samples < 1) return null;
  if (typeof mean !== "number" || !Number.isFinite(mean)) return null;
  if (!Array.isArray(rewardBounds) || rewardBounds.length !== 2) return null;
  const [lo, hi] = rewardBounds;
  if (typeof lo !== "number" || typeof hi !== "number" || !Number.isFinite(lo) || !Number.isFinite(hi) || lo > hi) return null;
  return {
    generation: generation.trim(),
    objective: objective.trim(),
    objective_version: objectiveVersion.trim(),
    evaluation_context: evaluationContext.trim(),
    direction,
    samples,
    mean,
    rewardBounds: [lo, hi],
  };
}

/**
 * Decide a promotion from bounded-reward evidence.
 *
 * The decision is taken in a fixed order so a refusal names the FIRST property
 * that failed, which is the one an operator or a recursive loop must act on:
 *
 * 1. The candidate evidence is present (fail-closed: absent promotes nothing).
 * 2. The candidate evidence is for the generation being promoted.
 * 3. The incumbent evidence is present (a candidate cannot promote without a
 *    baseline to beat).
 * 4. The incumbent is a different generation (a generation cannot beat itself).
 * 5. The held-out set is isolated from training (the contamination verdict is
 *    `null`); a non-null path is the structural refusal.
 * 6. The two sides are comparable: same objective, version, direction and
 *    evaluation context.
 * 7. Both sides meet the minimum sample count.
 * 8. Each side's mean lies within its declared reward bounds (the bounds are the
 *    gate's input, so a mean outside them means the evidence is not what the
 *    bounds describe).
 * 9. The conservative margin — candidate lower bound minus incumbent upper bound
 *    minus the effect threshold — is non-negative.
 *
 * Steps 5 and 6-9 are ordered so a structural refusal (contamination) precedes
 * a statistical one: a contaminated candidate is refused regardless of its
 * numbers, and a candidate that would have been admitted by memorising the
 * held-out set is refused before its score is even compared.
 *
 * @param input - The evidence, criterion, contamination verdict and expected
 *   generation id.
 * @returns A promote verdict with the bound that admitted the candidate, or a
 *   refuse verdict with a stable code and a human-readable reason.
 */
export function decidePromotion(input: PromotionGateInput): PromotionDecision {
  const { candidate, incumbent, criterion, contaminationPath, expectedGeneration } = input;
  // Fail-closed ordering: evidence existence before identity before isolation
  // before comparability before statistics. Each refusal names the property it
  // enforces, so the code is what a loop branches on and the reason is what an
  // operator reads.
  if (candidate === null) {
    return { decision: "refuse", code: "no_candidate_evidence", reason: "Promotion refused: no readable candidate evaluation evidence was supplied. Absent evidence promotes nothing." };
  }
  if (candidate.generation !== expectedGeneration) {
    return { decision: "refuse", code: "wrong_generation_evidence", reason: `Promotion refused: the candidate evidence was measured for generation ${candidate.generation}, not the generation ${expectedGeneration} being promoted. Evidence for the wrong generation cannot admit this candidate.` };
  }
  if (incumbent === null) {
    return { decision: "refuse", code: "no_incumbent_evidence", reason: "Promotion refused: no readable incumbent evaluation evidence was supplied. A candidate cannot be promoted without a baseline it was measured to beat." };
  }
  if (incumbent.generation === candidate.generation) {
    return { decision: "refuse", code: "incumbent_is_candidate", reason: `Promotion refused: the incumbent evidence names the same generation ${candidate.generation} as the candidate. A generation cannot be measured to beat itself.` };
  }
  if (contaminationPath !== null) {
    return { decision: "refuse", code: "contaminated_held_out", reason: `Promotion refused: the held-out evaluation set is reachable from the candidate's training data, so the score measures memorisation. Path: ${contaminationPath}` };
  }
  // Comparability before statistics: comparing scores that name different
  // objectives, versions, directions or evaluation contexts yields a number that
  // is not an improvement, and the bound over mismatched bounds is meaningless.
  const differences: string[] = [];
  if (candidate.objective !== incumbent.objective) {
    differences.push(`objective (candidate "${candidate.objective}" vs incumbent "${incumbent.objective}")`);
  }
  if (candidate.objective_version !== incumbent.objective_version) {
    differences.push(`objective_version (candidate "${candidate.objective_version}" vs incumbent "${incumbent.objective_version}")`);
  }
  if (candidate.direction !== incumbent.direction) {
    differences.push(`direction (candidate "${candidate.direction}" vs incumbent "${incumbent.direction}")`);
  }
  if (candidate.evaluation_context !== incumbent.evaluation_context) {
    differences.push(`evaluation_context (candidate "${candidate.evaluation_context}" vs incumbent "${incumbent.evaluation_context}")`);
  }
  if (differences.length > 0) {
    return { decision: "refuse", code: "incomparable_evidence", reason: `Promotion refused: the candidate and incumbent evidence are not comparable. ${differences.join("; ")}. Both sides must share the same objective, version, direction and held-out evaluation context.` };
  }
  if (candidate.samples < criterion.minSamples) {
    return { decision: "refuse", code: "insufficient_samples", reason: `Promotion refused: the candidate evidence carries ${candidate.samples} sample(s), below the required minimum of ${criterion.minSamples}. A noisy sample below the minimum count is not statistically bounded improvement.` };
  }
  if (incumbent.samples < criterion.minSamples) {
    return { decision: "refuse", code: "insufficient_samples", reason: `Promotion refused: the incumbent evidence carries ${incumbent.samples} sample(s), below the required minimum of ${criterion.minSamples}. The baseline must be as well measured as the candidate.` };
  }
  const [candLo, candHi] = candidate.rewardBounds;
  const [incLo, incHi] = incumbent.rewardBounds;
  // The mean must lie within the declared bounds: a mean outside them means the
  // bounds do not describe the evidence the gate is bounding, so the bound is
  // not valid for that evidence.
  if (candidate.mean < candLo || candidate.mean > candHi) {
    return { decision: "refuse", code: "invalid_evidence", reason: `Promotion refused: the candidate mean ${candidate.mean} lies outside its declared reward bounds [${candLo}, ${candHi}]. The bounds must describe the evidence the gate is bounding.` };
  }
  if (incumbent.mean < incLo || incumbent.mean > incHi) {
    return { decision: "refuse", code: "invalid_evidence", reason: `Promotion refused: the incumbent mean ${incumbent.mean} lies outside its declared reward bounds [${incLo}, ${incHi}]. The bounds must describe the evidence the gate is bounding.` };
  }
  const alpha = 1 - criterion.confidence;
  // The candidate and incumbent may declare different reward ranges (e.g. a
  // rescaled objective), so each side's epsilon uses its OWN bounds, never the
  // other's. A wider declared range widens that side's bound, refusing more.
  const candidateEpsilon = hoeffdingEpsilon(candidate.samples, candHi - candLo, alpha);
  const incumbentEpsilon = hoeffdingEpsilon(incumbent.samples, incHi - incLo, alpha);
  // For "maximize", promote when the candidate's WORST case still beats the
  // incumbent's BEST case by the effect threshold: the lower confidence bound
  // of the candidate exceeds the upper confidence bound of the incumbent.
  // For "minimize", lower is better, so the roles invert: promote when the
  // incumbent's best (lowest) case is still above the candidate's worst (highest)
  // case by the effect threshold.
  const promote = candidate.direction === "maximize"
    ? candidate.mean - candidateEpsilon - (incumbent.mean + incumbentEpsilon) >= criterion.effectThreshold
    : incumbent.mean - incumbentEpsilon - (candidate.mean + candidateEpsilon) >= criterion.effectThreshold;
  const margin = candidate.direction === "maximize"
    ? candidate.mean - candidateEpsilon - (incumbent.mean + incumbentEpsilon) - criterion.effectThreshold
    : incumbent.mean - incumbentEpsilon - (candidate.mean + candidateEpsilon) - criterion.effectThreshold;
  if (!promote) {
    const candidateBound = candidate.direction === "maximize" ? candidate.mean - candidateEpsilon : candidate.mean + candidateEpsilon;
    const incumbentBound = candidate.direction === "maximize" ? incumbent.mean + incumbentEpsilon : incumbent.mean - incumbentEpsilon;
    return {
      decision: "refuse",
      code: "no_statistical_improvement",
      reason: `Promotion refused: the candidate is not statistically better than the incumbent. Candidate ${candidate.direction === "maximize" ? "lower" : "upper"} bound ${candidateBound.toFixed(6)} does not beat incumbent ${candidate.direction === "maximize" ? "upper" : "lower"} bound ${incumbentBound.toFixed(6)} by the effect threshold ${criterion.effectThreshold} (margin ${margin.toFixed(6)}).${candidate.direction === "maximize" && candidate.mean <= incumbent.mean ? " The candidate regressed: its mean is not above the incumbent's mean." : ""}`,
    };
  }
  const candidateBound = candidate.direction === "maximize" ? candidate.mean - candidateEpsilon : candidate.mean + candidateEpsilon;
  const incumbentBound = candidate.direction === "maximize" ? incumbent.mean + incumbentEpsilon : incumbent.mean - incumbentEpsilon;
  return {
    decision: "promote",
    margin,
    candidateBound,
    incumbentBound,
    candidateEpsilon,
    incumbentEpsilon,
    reason: `Promoted: candidate ${candidate.direction === "maximize" ? "lower" : "upper"} bound ${candidateBound.toFixed(6)} beats incumbent ${candidate.direction === "maximize" ? "upper" : "lower"} bound ${incumbentBound.toFixed(6)} by ${margin.toFixed(6)} above the effect threshold, with confidence ${criterion.confidence} over ${candidate.samples} candidate and ${incumbent.samples} incumbent samples.`,
  };
}