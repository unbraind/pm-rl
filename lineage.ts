/**
 * @module pm-rl/lineage
 *
 * Recursive self-improvement support: generation lineage, approved promotion
 * budget, direction-aware proxy-to-held-out gap, contamination refusal, and the
 * lineage view that answers the questions the loop cannot answer about itself.
 *
 * pm-rl never runs the trainer. It records what happened, refuses to let a
 * result look valid when its provenance says otherwise, and answers the
 * questions the loop cannot answer about itself. Every artifact a verdict
 * depends on carries an immutable content-addressed identity, and every
 * generation declares typed edges to its parent, its collection runs, and the
 * exact environment and reward-spec versions those runs used, so reverse
 * reachability from an environment edit reaches every downstream generation.
 *
 * The functions in this module are pure: they validate, compute, and render
 * without touching a pm tracker. The command handlers in {@link ./index.ts}
 * resolve tracker items and call these functions, keeping the logic testable
 * without standing up a real workspace for every branch.
 */

import { createPmCliExpectedError, EXIT_CODE } from "@unbrained/pm-cli/sdk/runtime";

import type { JsonValue } from "./index.ts";

/** Direction an objective optimizes: a higher value is better or a lower one is. */
export type ObjectiveDirection = "maximize" | "minimize";

/**
 * Provenance edge types a generation declares.
 *
 * Enumerated in the specification rather than inferred, so reverse reachability
 * from an environment edit follows a known set of edge types and never crosses
 * annotation edges that carry no data flow.
 */
export const GENERATION_EDGE_TYPES = [
  "parent",
  "collection_run",
  "environment_version",
  "reward_spec_version",
  "base_checkpoint",
] as const;

/** Default number of consecutive promotions the gap widening window spans. */
export const DEFAULT_GAP_WINDOW = 3;

/** One recorded score with full provenance, attributed to the same standard. */
export interface ScoreRecord {
  /** Objective identifier, e.g. `episode_return`. Never empty. */
  readonly objective: string;
  /** Content-addressed version of the objective definition. Never empty. */
  readonly objective_version: string;
  /** Content-addressed Environment item id used for evaluation, pinning the env version. Never empty. */
  readonly evaluation_context: string;
  /** Content-addressed seed set identity that produced the score. Never empty. */
  readonly seed_set: string;
  /** Whether a higher value is better or a lower one is. */
  readonly direction: ObjectiveDirection;
  /** Declared scale for normalization; must be positive and finite. */
  readonly scale: number;
  /** The measured score value, finite. */
  readonly value: number;
}

/** A policy generation and its provenance, stored as a JSON fence in the item body. */
export interface GenerationSpec {
  /** Content-addressed identity of the base checkpoint the generation started from. */
  readonly base_checkpoint: string;
  /** Content-addressed identity of the policy that collected the training data; empty for the seed. */
  readonly policy: string;
  /** Item ids of the collection runs that produced the training data; empty for the seed. */
  readonly collection_runs: readonly string[];
  /** Training configuration that turned the collected data into a successor policy. */
  readonly training_config: JsonValue;
  /** Content-addressed Environment item id whose version the collection runs used; empty for the seed. */
  readonly environment_version: string;
  /** Content-addressed hash of the reward specification the collection runs used; empty for the seed. */
  readonly reward_spec_version: string;
  /** Parent generation id, or null for the seed generation. */
  readonly parent: string | null;
  /** Whether this generation is the seed (no parent). */
  readonly seed: boolean;
  /** Whether this generation has been promoted. */
  readonly promoted: boolean;
  /** Approval item id that authorized the promotion, or null if not promoted. */
  readonly approval: string | null;
  /** Proxy score recorded at promotion, or null if not promoted. */
  readonly proxy_score: ScoreRecord | null;
  /** Held-out score recorded at promotion, or null if not promoted. */
  readonly held_out_score: ScoreRecord | null;
  /** Direction-aware proxy-to-held-out gap, or null if not promoted. */
  readonly gap: number | null;
  /** Human-readable promotion evidence, or null if not promoted. */
  readonly promotion_evidence: string | null;
}

/** Approval spec stored as a JSON fence in a Decision item body. */
export interface ApprovalSpec {
  /** Number of permitted promotions; the seed consumes none. Must be a non-negative integer. */
  readonly permitted_promotions: number;
}

/** One hop in a contamination path, naming the artifact and the edge type that reached it. */
export interface ContaminationHop {
  /** Artifact identity at this position in the path. */
  readonly artifact: string;
  /** Edge type traversed to reach this artifact, or `start` for the first hop. */
  readonly via: string;
}

/** A contamination path from a candidate's training data to the evaluation set. */
export interface ContaminationPath {
  /** Ordered hops from the candidate to the contaminated artifact. */
  readonly hops: readonly ContaminationHop[];
  /** Content-addressed identity that overlapped between training data and eval set. */
  readonly overlap: string;
}

/** One generation's entry in an ancestry, with the run environments resolved. */
export interface AncestryEntry {
  /** Generation item id. */
  readonly id: string;
  /** Parsed generation spec. */
  readonly spec: GenerationSpec;
  /** Map from collection run id to the environment item id that run used. */
  readonly runEnvironments: ReadonlyMap<string, string>;
}

/** One row in a rendered lineage view. */
export interface LineageRow {
  /** Generation item id. */
  readonly id: string;
  /** Whether this is the seed generation. */
  readonly seed: boolean;
  /** Base checkpoint identity. */
  readonly base_checkpoint: string;
  /** Collection run ids. */
  readonly collection_runs: readonly string[];
  /** Proxy score value, or null if not promoted. */
  readonly proxy_score: number | null;
  /** Held-out score value, or null if not promoted. */
  readonly held_out_score: number | null;
  /** Direction-aware gap, or null if not promoted. */
  readonly gap: number | null;
  /** Per-generation gap delta from the previous promoted generation, or null. */
  readonly gap_delta: number | null;
  /** Approval item id, or null if not promoted. */
  readonly approval: string | null;
  /** Promotion evidence, or null if not promoted. */
  readonly promotion_evidence: string | null;
  /** Invalidation reason, or null if the generation is still valid. */
  readonly invalidated: string | null;
}

/** A complete lineage view for one ancestry, from seed to head. */
export interface LineageAncestry {
  /** Head generation id. */
  readonly head: string;
  /** Rows from seed to head, one per generation. */
  readonly rows: readonly LineageRow[];
  /** Named findings, e.g. a widening gap over the configured window. */
  readonly findings: readonly string[];
}

/** Machine-readable lineage view containing every rendered ancestry. */
export interface LineageView {
  /** All rendered ancestries, one per head. */
  readonly ancestries: readonly LineageAncestry[];
}

/** Throw an expected command error with stable machine context. */
function lineageFail(message: string, code: string, exitCode: number = EXIT_CODE.USAGE): never {
  throw createPmCliExpectedError(message, { exitCode, context: { code } });
}

/** Narrow a parsed value to a JSON object record. */
function asObject(value: unknown, source: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    lineageFail(`${source} must contain one JSON object.`, "invalid_json_object");
  }
  return value as Record<string, unknown>;
}

/**
 * Require a string field to be present and, when checked, non-empty, and return
 * it **trimmed**.
 *
 * Returning the trimmed value is a correctness requirement, not a convenience.
 * The fields read through this helper are identities — environment ids,
 * evaluation contexts, seed sets — and every consumer compares them by strict
 * equality. {@link findContaminationPath} in particular decides whether a
 * candidate's training data reaches the held-out environment by comparing those
 * strings directly. Returning the raw value let `" env-eval "` parse and then
 * never match `"env-eval"`, so the contamination refusal passed for a candidate
 * it was supposed to stop. An identity comparison must not depend on
 * surrounding whitespace.
 *
 * @param record - The parsed JSON object to read from.
 * @param key - Field name to read.
 * @param source - Human-readable label naming the document, used in errors.
 * @param required - When true, a missing or blank value is refused.
 * @returns The trimmed value, or `""` when absent and not required.
 * @throws When the field is required and is absent, non-string, or blank.
 */
function asString(record: Record<string, unknown>, key: string, source: string, required = true): string {
  const value = record[key];
  if (typeof value !== "string") {
    if (required) lineageFail(`${source} requires a string ${key}.`, `missing_${key}`);
    return "";
  }
  const normalized = value.trim();
  if (required && normalized.length === 0) lineageFail(`${source} requires a non-empty ${key}.`, `empty_${key}`);
  return normalized;
}

/**
 * Parse and validate a score record from a parsed JSON object.
 *
 * Both scores carry objective id, objective version, evaluation context and seed
 * set, attributed to the same standard. Every objective declares a direction and
 * a positive finite scale; objectives with no declared scale are refused rather
 * than silently compared.
 *
 * @param value - The parsed JSON value for one score.
 * @param label - Human-readable label naming which score is being parsed.
 * @returns The validated score record.
 * @throws When a field is absent, of the wrong kind, or holds a value that
 *   cannot be compared — a non-finite value, a non-positive scale, or an unknown
 *   direction.
 */
export function parseScoreRecord(value: unknown, label: string): ScoreRecord {
  const record = asObject(value, label);
  const objective = asString(record, "objective", label);
  const objectiveVersion = asString(record, "objective_version", label);
  const evaluationContext = asString(record, "evaluation_context", label);
  const seedSet = asString(record, "seed_set", label);
  const direction = record["direction"];
  if (direction !== "maximize" && direction !== "minimize") {
    lineageFail(`${label} requires a direction of "maximize" or "minimize".`, "invalid_direction");
  }
  const scale = record["scale"];
  if (typeof scale !== "number" || !Number.isFinite(scale) || scale <= 0) {
    lineageFail(`${label} requires a positive finite scale for normalization; objectives with no comparable scale are refused.`, "invalid_scale");
  }
  const scoreValue = record["value"];
  if (typeof scoreValue !== "number" || !Number.isFinite(scoreValue)) {
    lineageFail(`${label} requires a finite value.`, "invalid_value");
  }
  return { objective, objective_version: objectiveVersion, evaluation_context: evaluationContext, seed_set: seedSet, direction, scale, value: scoreValue };
}

/**
 * Parse and validate a generation spec from its JSON text.
 *
 * A generation with no parent is the seed and reports itself as such; every later
 * generation requires a parent, a policy, at least one collection run, an
 * environment version and a reward-spec version. Promotion fields are optional
 * and defaults to null/false when absent, so a newly registered candidate parses
 * the same as one loaded from a stored item.
 *
 * @param text - The JSON text of the generation spec.
 * @param source - Human-readable label naming the source being parsed.
 * @returns The validated generation spec with promotion defaults applied.
 * @throws When the text is not valid JSON, a required field is absent or of the
 *   wrong kind, or a non-seed generation is missing its parent or provenance.
 */
export function parseGenerationSpec(text: string, source: string): GenerationSpec {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    lineageFail(`${source} is not valid JSON.`, "invalid_generation_json");
  }
  const record = asObject(parsed, source);
  const baseCheckpoint = asString(record, "base_checkpoint", source);
  const policy = asString(record, "policy", source, false);
  const collectionRuns = record["collection_runs"];
  if (!Array.isArray(collectionRuns) || !collectionRuns.every((run) => typeof run === "string")) {
    lineageFail(`${source} requires a collection_runs array of strings.`, "invalid_collection_runs");
  }
  const trainingConfig = record["training_config"] ?? {};
  const environmentVersion = asString(record, "environment_version", source, false);
  const rewardSpecVersion = asString(record, "reward_spec_version", source, false);
  const parent = record["parent"];
  if (parent !== null && typeof parent !== "string") {
    lineageFail(`${source} requires parent to be a string or null.`, "invalid_parent");
  }
  const seed = record["seed"] === true;
  if (seed && parent !== null) {
    lineageFail(`${source} declares seed but has a parent.`, "seed_with_parent");
  }
  if (!seed) {
    if (typeof parent !== "string" || parent.trim().length === 0) {
      lineageFail(`${source} requires a non-empty parent for a non-seed generation.`, "missing_parent");
    }
    if (policy.trim().length === 0) lineageFail(`${source} requires a non-empty policy for a non-seed generation.`, "missing_policy");
    if (environmentVersion.trim().length === 0) lineageFail(`${source} requires a non-empty environment_version for a non-seed generation.`, "missing_environment");
    if (rewardSpecVersion.trim().length === 0) lineageFail(`${source} requires a non-empty reward_spec_version for a non-seed generation.`, "missing_reward_spec");
    if (collectionRuns.length === 0) lineageFail(`${source} requires at least one collection run for a non-seed generation.`, "missing_collection_runs");
  }
  const promoted = record["promoted"] === true;
  const approval = record["approval"];
  if (approval !== null && typeof approval !== "string") {
    lineageFail(`${source} requires approval to be a string or null.`, "invalid_approval");
  }
  const proxyScore = record["proxy_score"] === null || record["proxy_score"] === undefined ? null : parseScoreRecord(record["proxy_score"], `${source} proxy_score`);
  const heldOutScore = record["held_out_score"] === null || record["held_out_score"] === undefined ? null : parseScoreRecord(record["held_out_score"], `${source} held_out_score`);
  const gap = record["gap"];
  if (gap !== null && gap !== undefined && typeof gap !== "number") {
    lineageFail(`${source} requires gap to be a number or null.`, "invalid_gap");
  }
  const promotionEvidence = record["promotion_evidence"];
  if (promotionEvidence !== null && promotionEvidence !== undefined && typeof promotionEvidence !== "string") {
    lineageFail(`${source} requires promotion_evidence to be a string or null.`, "invalid_promotion_evidence");
  }
  return {
    base_checkpoint: baseCheckpoint,
    policy,
    collection_runs: collectionRuns as string[],
    training_config: trainingConfig as JsonValue,
    environment_version: environmentVersion,
    reward_spec_version: rewardSpecVersion,
    parent: parent as string | null,
    seed,
    promoted,
    approval: approval as string | null,
    proxy_score: proxyScore,
    held_out_score: heldOutScore,
    gap: gap as number | null,
    promotion_evidence: promotionEvidence as string | null,
  };
}

/**
 * Parse and validate an approval spec from its JSON text.
 *
 * The approved number is a count of permitted promotions, not a maximum
 * generation ordinal. It must be a non-negative integer: zero permits nothing,
 * and the seed generation consumes no unit regardless.
 *
 * @param text - The JSON text of the approval spec.
 * @param source - Human-readable label naming the source being parsed.
 * @returns The validated approval spec.
 * @throws When the text is not valid JSON or `permitted_promotions` is absent,
 *   not an integer, or negative.
 */
export function parseApprovalSpec(text: string, source: string): ApprovalSpec {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    lineageFail(`${source} is not valid JSON.`, "invalid_approval_json");
  }
  const record = asObject(parsed, source);
  const permitted = record["permitted_promotions"];
  if (typeof permitted !== "number" || !Number.isInteger(permitted) || permitted < 0) {
    lineageFail(`${source} requires a non-negative integer permitted_promotions.`, "invalid_permitted_promotions");
  }
  return { permitted_promotions: permitted };
}

/**
 * Compute the direction-aware proxy-to-held-out gap.
 *
 * Both scores are normalized to their declared scales before subtraction, and
 * the direction is applied so that a positive gap always means the proxy is
 * ahead of held-out capability regardless of which way the underlying metric
 * points. A `maximize` objective's capability is its normalized value; a
 * `minimize` objective's capability is its negation, so lower is better maps to
 * higher capability.
 *
 * @param proxy - The proxy score (the quantity training optimized).
 * @param heldOut - The held-out score on the pinned evaluation set.
 * @returns The direction-aware gap, positive when the proxy is ahead.
 */
export function directionAwareGap(proxy: ScoreRecord, heldOut: ScoreRecord): number {
  const proxyCapability = proxy.direction === "maximize" ? proxy.value / proxy.scale : -(proxy.value / proxy.scale);
  const heldOutCapability = heldOut.direction === "maximize" ? heldOut.value / heldOut.scale : -(heldOut.value / heldOut.scale);
  return proxyCapability - heldOutCapability;
}

/**
 * Compute per-generation gap deltas along one ancestry.
 *
 * Each delta is the difference between consecutive promoted generations' gaps.
 * The first promoted generation has no predecessor and receives a delta of null.
 * The result is aligned by index with the input gaps array, so a caller can
 * pair each delta with its generation without a second lookup.
 *
 * @param gaps - One gap per promoted generation, in ancestry order (seed to head).
 * @returns One delta per gap, null for the first promoted generation.
 */
export function gapDeltas(gaps: readonly (number | null)[]): (number | null)[] {
  const deltas: (number | null)[] = [];
  let previous: number | null = null;
  for (const gap of gaps) {
    if (gap === null || previous === null) {
      deltas.push(null);
    } else {
      deltas.push(gap - previous);
    }
    if (gap !== null) previous = gap;
  }
  return deltas;
}

/**
 * Check whether the gap is widening over a configured window of consecutive gaps.
 *
 * The widening rule is a comparison of the gap across a window of consecutive
 * promotions along one explicitly selected ancestry, never across a mixture of
 * branches. A gap is widening when the last `window` promoted generations' gaps
 * are strictly increasing. If fewer than `window` gaps exist, there is not yet
 * enough data to call the trend, and the function returns false.
 *
 * @param gaps - One gap per promoted generation, in ancestry order (seed to head).
 * @param window - Number of consecutive gaps to compare.
 * @returns True when the last `window` gaps are strictly increasing.
 */
export function isGapWidening(gaps: readonly (number | null)[], window: number): boolean {
  const promoted = gaps.filter((gap): gap is number => gap !== null);
  if (promoted.length < window) return false;
  const recent = promoted.slice(-window);
  for (let index = 1; index < recent.length; index += 1) {
    if (recent[index]! <= recent[index - 1]!) return false;
  }
  return true;
}

/**
 * Find a contamination path from a candidate's training data to the evaluation set.
 *
 * Contamination is forward reachability from the candidate's training data to
 * the evaluation set, following only the declared provenance edge types:
 * collection run, environment version, and parent generation. Overlap is decided
 * on content-addressed identity rather than on labels, so the same environment
 * reached by two different names is one environment. The traversal walks the
 * ancestry from the candidate toward the seed, checking each generation's own
 * environment version and then each collection run's environment (in sorted run
 * id order for determinism), so the first and nearest match produces the path.
 *
 * @param ancestry - Generations from candidate (index 0) to seed (last), with
 *   each collection run's environment resolved.
 * @param heldOutEnvironment - The evaluation set's pinned environment item id.
 * @returns The contamination path, or null when no training-data artifact
 *   reaches the evaluation set.
 */
export function findContaminationPath(
  ancestry: readonly AncestryEntry[],
  heldOutEnvironment: string,
): ContaminationPath | null {
  for (let index = 0; index < ancestry.length; index += 1) {
    const entry = ancestry[index]!;
    if (entry.spec.environment_version === heldOutEnvironment && heldOutEnvironment.length > 0) {
      return { hops: buildHops(ancestry, index, heldOutEnvironment, null), overlap: heldOutEnvironment };
    }
    const sortedRuns = [...entry.spec.collection_runs].sort();
    for (const runId of sortedRuns) {
      const runEnv = entry.runEnvironments.get(runId);
      if (runEnv === heldOutEnvironment) {
        return { hops: buildHops(ancestry, index, runId, heldOutEnvironment), overlap: heldOutEnvironment };
      }
    }
  }
  return null;
}

/** Build the ordered hop list from the candidate to a matched artifact. */
function buildHops(
  ancestry: readonly AncestryEntry[],
  matchIndex: number,
  matchedArtifact: string,
  envArtifact: string | null,
): ContaminationHop[] {
  const hops: ContaminationHop[] = [];
  for (let index = 0; index <= matchIndex; index += 1) {
    hops.push({ artifact: ancestry[index]!.id, via: index === 0 ? "start" : "parent" });
  }
  if (envArtifact !== null) {
    hops.push({ artifact: matchedArtifact, via: "collection_run" });
    hops.push({ artifact: envArtifact, via: "environment_version" });
  } else {
    hops.push({ artifact: matchedArtifact, via: "environment_version" });
  }
  return hops;
}

/**
 * Render a contamination path as a stable, diffable string.
 *
 * The printed path is an ordered list of artifact identities and edge types,
 * stable across runs for the same graph, so it can be attached to the item that
 * records the refusal.
 *
 * @param path - The contamination path.
 * @returns A string like `gen-1 →[environment_version]→ env-eval-v1` or with
 *   intermediate collection-run hops.
 */
export function renderContaminationPath(path: ContaminationPath): string {
  return path.hops.map((hop, index) => {
    if (index === 0) return hop.artifact;
    return `→[${hop.via}]→ ${hop.artifact}`;
  }).join(" ");
}

/**
 * Render a lineage view as a human-readable table.
 *
 * One ancestry per head, one row per generation from seed to head. Each row
 * names the base checkpoint, collection runs, proxy and held-out scores with
 * their gap, the gap delta from the previous promoted generation, the approval
 * item and promotion evidence, and whether anything upstream has since
 * invalidated it. Findings are listed after each ancestry.
 *
 * @param view - The lineage view to render.
 * @returns The rendered table text.
 */
export function renderLineageTable(view: LineageView): string {
  const blocks: string[] = [];
  for (const ancestry of view.ancestries) {
    blocks.push(`head: ${ancestry.head}`);
    for (const row of ancestry.rows) {
      const kind = row.seed ? "seed" : "generation";
      const proxy = row.proxy_score === null ? "-" : row.proxy_score.toFixed(4);
      const heldOut = row.held_out_score === null ? "-" : row.held_out_score.toFixed(4);
      const gap = row.gap === null ? "-" : row.gap.toFixed(4);
      const delta = row.gap_delta === null ? "-" : (row.gap_delta >= 0 ? `+${row.gap_delta.toFixed(4)}` : row.gap_delta.toFixed(4));
      const approval = row.approval ?? "-";
      const evidence = row.promotion_evidence ?? "-";
      const status = row.invalidated ?? (row.promotion_evidence !== null ? "promoted" : "candidate");
      blocks.push(`${row.id} | ${kind} | base=${row.base_checkpoint} | proxy=${proxy} | held_out=${heldOut} | gap=${gap} | delta=${delta} | approval=${approval} | evidence=${evidence} | ${status}`);
    }
    if (ancestry.findings.length > 0) {
      blocks.push(`findings: ${ancestry.findings.join("; ")}`);
    }
  }
  return blocks.join("\n");
}

/**
 * Build lineage rows from an ancestry, computing gap deltas and invalidation.
 *
 * Reward-gap deltas and trends are computed only along the selected ancestry and
 * never across branches. Each row names the promotion evidence and its approval
 * item. A generation whose own recorded environment is invalid is marked with the
 * reason returned by {@link environmentInvalidationReason} — a distinct wording
 * per condition rather than one fixed phrase, so an operator is told "edited",
 * "unreadable", "no recorded identity" or "could not be resolved" as appropriate.
 *
 * @param ancestry - Generations from seed to head, with run environments resolved.
 * @param ownInvalidated - Map from generation id to the invalidation reason for
 *   that generation's OWN recorded environment. Descendants of an invalidated
 *   ancestor are not yet added here; forward propagation is a separate concern.
 * @param gapWindow - Number of consecutive gaps for the widening check.
 * @returns One ancestry with rows, findings, and the head id.
 */
export function buildLineageAncestry(
  ancestry: readonly AncestryEntry[],
  ownInvalidated: ReadonlyMap<string, string>,
  gapWindow: number,
): LineageAncestry {
  const gaps = ancestry.map((entry) => entry.spec.gap);
  const deltas = gapDeltas(gaps);
  const rows: LineageRow[] = ancestry.map((entry, index) => ({
    id: entry.id,
    seed: entry.spec.seed,
    base_checkpoint: entry.spec.base_checkpoint,
    collection_runs: entry.spec.collection_runs,
    proxy_score: entry.spec.proxy_score?.value ?? null,
    held_out_score: entry.spec.held_out_score?.value ?? null,
    gap: entry.spec.gap,
    gap_delta: deltas[index]!,
    approval: entry.spec.approval,
    promotion_evidence: entry.spec.promotion_evidence,
    invalidated: ownInvalidated.get(entry.id) ?? null,
  }));
  const findings: string[] = [];
  if (isGapWidening(gaps, gapWindow)) {
    findings.push(`gap widening over last ${gapWindow} promotions`);
  }
  const head = ancestry[ancestry.length - 1]!.id;
  return { head, rows, findings };
}