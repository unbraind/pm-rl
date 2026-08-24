/**
 * @module pm-rl/sweep
 *
 * Sweep planning: expand a declared search space into independent child runs.
 *
 * A Sweep carries the search space and the selection rule; its children are
 * ordinary Run items. Independence is the design — two agents can take two arms
 * on two branches and merge, because each arm is its own item and each arm's
 * metrics are history appends. `sweep status` reports per-arm progress and the
 * selection rule's current verdict across arms.
 *
 * Status never invents a winner a rule does not support: a rule that declares no
 * winner reports none even with data present, and until an arm has measured the
 * selection metric there is no verdict to state.
 *
 * The functions in this module are pure; the command handlers in
 * {@link ./index.ts} resolve tracker items and call them.
 */

import { Buffer } from "node:buffer";

import { EXIT_CODE } from "@unbrained/pm-cli/sdk/runtime";

import { expectedFail, parseJsonRecord, requiredTrimmedString } from "./refuse.ts";

import type { JsonValue } from "./index.ts";

/** The selection-rule kinds that can ever name a winner. */
export const SELECTION_RULE_KINDS = ["max_final", "min_final"] as const;

/** The upper bound on arms one sweep may expand to; beyond it, planning refuses. */
export const MAX_SWEEP_ARMS = 64;

/** Characters a selection-metric name may use. Authored and stored rules share this rule. */
const METRIC_NAME_PATTERN = /^[A-Za-z0-9_.-]+$/;

/** Whether a value names a selection-rule kind that can pick a winner. */
function isSelectionRuleKind(value: unknown): value is SelectionRuleKind {
  return typeof value === "string" && (SELECTION_RULE_KINDS as readonly string[]).includes(value);
}

/** A kind of selection rule that can name a winner. */
export type SelectionRuleKind = (typeof SELECTION_RULE_KINDS)[number];

/** How a sweep picks a winning arm when its evidence exists. */
export type SelectionRule = { readonly kind: "none" } | { readonly kind: SelectionRuleKind; readonly metric: string };

/** One declared dimension of the search space: hyperparameter name to candidate values. */
export type SearchSpace = Readonly<Record<string, readonly JsonValue[]>>;

/** A stored sweep specification, held as a JSON fence in the Sweep item body. */
export interface SweepSpec {
  /** The declared search space, in authored form. */
  readonly search_space: SearchSpace;
  /** The sweep's selection rule. */
  readonly selection_rule: SelectionRule;
  /** Algorithm every arm runs. */
  readonly algorithm: string;
  /** Content-addressed Environment item id every arm trains under. */
  readonly environment_id: string;
  /** Content identity of that environment's specification at plan time. */
  readonly environment_spec_hash: string;
  /** One child Run per arm, with the arm's expanded hyperparameters. */
  readonly arms: ReadonlyArray<{ id: string; config: JsonValue }>;
}

/** Per-arm progress as reported by status. */
export interface ArmProgress {
  /** Child Run item id. */
  readonly id: string;
  /** The arm's expanded hyperparameters. */
  readonly config: JsonValue;
  /** The child run's lifecycle status. */
  readonly status: string;
  /** Number of metric events the arm has logged. */
  readonly metric_events: number;
  /** Highest measured step, or null when the arm logged nothing yet. */
  readonly last_step: number | null;
  /** The arm's latest value of the selection metric, or null when unmeasured. */
  readonly final_value: number | null;
}

/** A complete sweep-status view. */
export interface SweepStatusView {
  /** The Sweep item id. */
  readonly sweep: string;
  /** The selection rule rendered in command syntax. */
  readonly rule: string;
  /** The metric the rule selects over, or null for a no-winner rule. */
  readonly selection_metric: string | null;
  /** Per-arm progress, in planned arm order. */
  readonly arms: readonly ArmProgress[];
  /** The current verdict, or null when the rule or the data does not support one. */
  readonly winner: string | null;
  /** Why the verdict was reached, or why none could be stated. */
  readonly winner_reason: string;
}

/**
 * Parse a selection rule from its command-syntax string.
 *
 * Supported forms are `none`, `max_final:<metric>`, and `min_final:<metric>`.
 * Anything else is refused at plan time rather than stored and silently treated
 * as decorative text at status time.
 *
 * @param raw - The rule string.
 * @returns The parsed rule.
 * @throws When the rule is not one of the supported forms.
 */
export function parseSelectionRule(raw: string): SelectionRule {
  if (raw === "none") return { kind: "none" };
  const separator = raw.indexOf(":");
  if (separator > 0) {
    const kind = raw.slice(0, separator);
    const metric = raw.slice(separator + 1);
    if (isSelectionRuleKind(kind) && METRIC_NAME_PATTERN.test(metric)) {
      return { kind, metric };
    }
  }
  expectedFail(
    `selection_rule must be "none" or one of ${SELECTION_RULE_KINDS.map((kind) => `${kind}:<metric>`).join(" / ")}; got "${raw}".`,
    "invalid_selection_rule",
  );
}

/**
 * Expand a declared search space into one hyperparameter set per arm.
 *
 * The product is taken in sorted key order so the same space always expands to
 * the same arms in the same order on any host — two planners must not disagree
 * about which arm is which.
 *
 * @param searchSpace - Hyperparameter name to candidate values.
 * @returns Every combination, sorted-key order, keys alphabetical within each config.
 * @throws When a declared dimension is missing, empty, or not an array, or when
 *   the product would exceed {@link MAX_SWEEP_ARMS} arms.
 */
export function expandSearchSpace(searchSpace: SearchSpace): Array<Record<string, JsonValue>> {
  if (Object.keys(searchSpace).length === 0) return [];
  let products: Array<Record<string, JsonValue>> = [{}];
  for (const key of Object.keys(searchSpace).sort()) {
    const values = searchSpace[key];
    if (!Array.isArray(values) || values.length === 0) {
      expectedFail(`search_space requires a non-empty array of candidate values for "${key}".`, "invalid_search_space");
    }
    const next: Array<Record<string, JsonValue>> = [];
    // The projected size is known arithmetically, so refuse BEFORE materializing
    // an intermediate product that could itself be enormous: planning writes one
    // arm per host call sequentially, and the cap is what turns "too big to
    // want" into a typed refusal instead of a very long afternoon.
    const projected = products.length * values.length;
    if (projected > MAX_SWEEP_ARMS) {
      expectedFail(`search_space expands to ${projected} arms; the cap is ${MAX_SWEEP_ARMS}. Narrow the space or split it across sweeps.`, "search_space_too_large");
    }
    for (const partial of products) {
      for (const value of values) next.push({ ...partial, [key]: value });
    }
    products = next;
  }
  return products;
}

/**
 * Parse and validate a stored sweep specification from its JSON fence.
 *
 * @param text - The JSON text inside the sweep's specification fence.
 * @param source - Human-readable label naming the source being parsed.
 * @returns The validated specification.
 * @throws When the text is not one JSON object, a required field is absent, the
 *   search space declares nothing, the rule is malformed, or no arm is listed.
 */
export function parseSweepSpec(text: string, source = "Sweep specification"): SweepSpec {
  const record = parseJsonRecord(text, source, "invalid_sweep_json", EXIT_CODE.CONFLICT);
  const stringField = (key: string): string => requiredTrimmedString(record, key, source, "invalid_sweep_", EXIT_CODE.CONFLICT);
  const searchSpaceRaw = record["search_space"];
  if (searchSpaceRaw === null || typeof searchSpaceRaw !== "object" || Array.isArray(searchSpaceRaw)) {
    expectedFail(`${source} requires a declared search space object.`, "invalid_sweep_search_space", EXIT_CODE.CONFLICT);
  }
  const searchSpaceEntries = Object.entries(searchSpaceRaw as Record<string, unknown>);
  if (searchSpaceEntries.length === 0) {
    expectedFail(`${source} requires a non-empty declared search space.`, "invalid_sweep_search_space", EXIT_CODE.CONFLICT);
  }
  const searchSpace: Record<string, JsonValue[]> = {};
  for (const [key, values] of searchSpaceEntries) {
    // Same rule expandSearchSpace enforces at plan time: an empty dimension has
    // no candidate to expand, and storing one would defer the refusal until a
    // re-plan that can never succeed.
    if (!Array.isArray(values) || values.length === 0) {
      expectedFail(`${source} requires a non-empty array of candidate values for "${key}".`, "invalid_sweep_search_space", EXIT_CODE.CONFLICT);
    }
    searchSpace[key] = values;
  }
  const ruleRaw = record["selection_rule"];
  if (ruleRaw === null || typeof ruleRaw !== "object" || Array.isArray(ruleRaw)) {
    expectedFail(`${source} requires a selection_rule object.`, "invalid_selection_rule", EXIT_CODE.CONFLICT);
  }
  const ruleRecord = ruleRaw as Record<string, unknown>;
  const kind = ruleRecord["kind"];
  let rule: SelectionRule;
  if (kind === "none") {
    rule = { kind: "none" };
  } else if (isSelectionRuleKind(kind)) {
    const metric = ruleRecord["metric"];
    if (typeof metric !== "string" || !METRIC_NAME_PATTERN.test(metric)) {
      expectedFail(`${source} requires a valid selection_rule metric name.`, "invalid_selection_rule", EXIT_CODE.CONFLICT);
    }
    rule = { kind, metric };
  } else {
    expectedFail(`${source} requires a selection_rule kind of none, ${SELECTION_RULE_KINDS.join(" or ")}.`, "invalid_selection_rule", EXIT_CODE.CONFLICT);
  }
  const armsRaw = record["arms"];
  if (!Array.isArray(armsRaw) || armsRaw.length === 0) {
    expectedFail(`${source} requires at least one arm.`, "invalid_sweep_arms", EXIT_CODE.CONFLICT);
  }
  const arms: Array<{ id: string; config: JsonValue }> = [];
  for (const entry of armsRaw) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      expectedFail(`${source} requires each arm to be an object with an id and a config.`, "invalid_sweep_arms", EXIT_CODE.CONFLICT);
    }
    const armRecord = entry as Record<string, unknown>;
    const id = armRecord["id"];
    const config = armRecord["config"];
    if (typeof id !== "string" || id.trim().length === 0 || config === null || typeof config !== "object" || Array.isArray(config)) {
      expectedFail(`${source} requires each arm to carry a non-empty id and a configuration object.`, "invalid_sweep_arms", EXIT_CODE.CONFLICT);
    }
    arms.push({ id: id.trim(), config: config as JsonValue });
  }
  return {
    search_space: searchSpace,
    selection_rule: rule,
    algorithm: stringField("algorithm"),
    environment_id: stringField("environment_id"),
    environment_spec_hash: stringField("environment_spec_hash"),
    arms,
  };
}

/**
 * Compute the selection rule's current verdict across arm progress.
 *
 * A winner is named only when the rule supports one AND at least one arm has
 * measured the selection metric; ties break deterministically by byte-order arm
 * id and the tie is stated. A rule that declares no winner reports none even
 * with data present — status describes progress, it does not manufacture a
 * verdict the plan never authorized.
 *
 * @param rule - The sweep's parsed selection rule.
 * @param arms - Per-arm progress, including each arm's final selection-metric value.
 * @returns The status view fields shared by every caller.
 */
export function buildSweepStatus(rule: SelectionRule, arms: readonly ArmProgress[]): Omit<SweepStatusView, "sweep"> {
  const ruleText = rule.kind === "none" ? "none" : `${rule.kind}:${rule.metric}`;
  const selectionMetric = rule.kind === "none" ? null : rule.metric;
  let winner: string | null = null;
  let winnerReason: string;
  if (rule.kind === "none") {
    winnerReason = "the selection rule declares no winner";
  } else {
    const measured = arms.filter((arm) => arm.final_value !== null);
    if (measured.length === 0) {
      winnerReason = `no arm has measured "${rule.metric}" yet`;
    } else {
      const best = [...measured].sort((left, right) => {
        const order = rule.kind === "max_final" ? right.final_value! - left.final_value! : left.final_value! - right.final_value!;
        return order !== 0 ? order : Buffer.compare(Buffer.from(left.id), Buffer.from(right.id));
      })[0]!;
      const tied = measured.filter((arm) => arm.final_value === best.final_value).map((arm) => arm.id);
      winner = best.id;
      winnerReason = tied.length > 1
        ? `best ${rule.kind === "max_final" ? "highest" : "lowest"} ${rule.metric} (${String(best.final_value)}), tied across ${tied.join(", ")}, broken by item order`
        : `best ${rule.kind === "max_final" ? "highest" : "lowest"} ${rule.metric} (${String(best.final_value)})`;
    }
  }
  return { rule: ruleText, selection_metric: selectionMetric, arms, winner, winner_reason: winnerReason };
}

/**
 * Render a sweep status view as stable, diffable text.
 *
 * @param view - The computed view, including the sweep id.
 * @returns The rendered report text.
 */
export function renderSweepStatus(view: SweepStatusView): string {
  const lines = [
    `${view.sweep} | rule: ${view.rule} | ${view.arms.length} arm(s)`,
  ];
  for (const arm of view.arms) {
    const lastStep = arm.last_step === null ? "-" : String(arm.last_step);
    const finalValue = arm.final_value === null ? "-" : String(arm.final_value);
    lines.push(`${arm.id} | ${arm.status} | events=${arm.metric_events} | last_step=${lastStep} | ${view.selection_metric ?? "selection"}=${finalValue}`);
  }
  lines.push(view.winner === null ? `winner: none (${view.winner_reason})` : `winner: ${view.winner} (${view.winner_reason})`);
  return lines.join("\n");
}
