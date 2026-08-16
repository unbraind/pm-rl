/**
 * @module pm-rl/compare
 *
 * The metric diff and the explanation beside it: `pm rl compare` reduces two
 * runs to per-metric differences over their common step range and pairs that
 * diff with the configuration delta — hyperparameters, environment version and
 * reward specification — recorded when each run started. A metric difference
 * with no configuration difference beside it is not an explanation, so both
 * halves are computed from the same two items and reported together.
 *
 * Comparability is decided by the caller: runs measured under different
 * environment versions are refused before any of this module runs, because a
 * diff across versions launders the version change into an apparent
 * improvement.
 *
 * The functions in this module are pure; the command handler in
 * {@link ./index.ts} resolves tracker items and notes and calls them.
 */

import type { MetricEvent } from "./series.ts";
import type { EnvironmentSpec, JsonValue } from "./index.ts";

/** Inclusive step span of one run's measurements. */
export interface StepRange {
  /** Lowest measured step. */
  readonly first: number;
  /** Highest measured step. */
  readonly last: number;
}

/** One step where both runs measured a metric and the values differ. */
export interface StepDifference {
  /** The step both runs measured. */
  readonly step: number;
  /** Baseline run's value at this step; the later measurement wins on repeats. */
  readonly baseline: number;
  /** Candidate run's value at this step. */
  readonly candidate: number;
  /** Candidate minus baseline. */
  readonly delta: number;
}

/** Per-metric comparison restricted to the two runs' common step range. */
export interface MetricSeriesDiff {
  /** Metric name. */
  readonly metric: string;
  /** Which runs measured this metric at least once. */
  readonly present: "both" | "baseline_only" | "candidate_only";
  /** Sorted steps inside the common range where both runs measured this metric. */
  readonly common_steps: readonly number[];
  /** Steps where both measured and the values differ, in step order. */
  readonly differences: readonly StepDifference[];
  /** Sorted in-range steps where only the baseline run measured this metric. */
  readonly baseline_only_steps: readonly number[];
  /** Sorted in-range steps where only the candidate run measured this metric. */
  readonly candidate_only_steps: readonly number[];
  /** Largest absolute delta among differing steps, or null when none differ. */
  readonly max_abs_delta: number | null;
}

/** The complete metric-level diff between two decoded run series. */
export interface SeriesDiff {
  /** Baseline run's measured step span, or null when it logged no events. */
  readonly baseline_range: StepRange | null;
  /** Candidate run's measured step span, or null when it logged no events. */
  readonly candidate_range: StepRange | null;
  /** The intersection of both spans, or null when the runs share no steps. */
  readonly common_range: StepRange | null;
  /** One entry per metric either run measured, sorted by metric name. */
  readonly metrics: readonly MetricSeriesDiff[];
}

/** One leaf-level difference between two JSON values, addressed by path. */
export interface JsonDelta {
  /**
   * Dotted path from the compared root; nested array positions render as
   * `name[index]`. The empty string addresses the root value itself.
   */
  readonly path: string;
  /** Baseline-side value, or undefined when the path exists only on the candidate side. */
  readonly baseline: JsonValue | undefined;
  /** Candidate-side value, or undefined when the path exists only on the baseline side. */
  readonly candidate: JsonValue | undefined;
}

/** A changed scalar rendered with both sides. */
export interface ChangedPair {
  /** Baseline run's value. */
  readonly baseline: string;
  /** Candidate run's value. */
  readonly candidate: string;
}

/** The configuration delta reported beside a metric diff. */
export interface ConfigDelta {
  /** Algorithm difference, or null when both runs used the same algorithm. */
  readonly algorithm: ChangedPair | null;
  /** Deep difference of the two recorded run configuration objects. */
  readonly hyperparameters: readonly JsonDelta[];
  /** Environment spec version difference, or null when both snapshots agree. */
  readonly environment_version: ChangedPair | null;
  /** Deep difference of the two recorded reward specifications. */
  readonly reward_specification: readonly JsonDelta[];
}

/** Everything `pm rl compare` needs about one run. */
export interface RunCompareInput {
  /** Run item id. */
  readonly id: string;
  /** Algorithm the run recorded (its `component`). */
  readonly algorithm: string;
  /** Resolved environment item id both runs must share. */
  readonly environment: string;
  /** The run's decoded metric events, in series order. */
  readonly events: readonly MetricEvent[];
  /** The environment specification snapshot recorded at start. */
  readonly environmentSpec: EnvironmentSpec;
  /** The run configuration recorded at start. */
  readonly config: JsonValue;
}

/** One run's identifying summary in a comparison view. */
export interface RunCompareSummary {
  /** Run item id. */
  readonly id: string;
  /** Algorithm the run recorded. */
  readonly algorithm: string;
  /** Environment item id the run measured under. */
  readonly environment: string;
  /** The run's measured step span, or null when it logged no events. */
  readonly step_range: StepRange | null;
}

/** The full comparison view returned by `pm rl compare`. */
export interface CompareView {
  /** Baseline run summary. */
  readonly baseline: RunCompareSummary;
  /** Candidate run summary. */
  readonly candidate: RunCompareSummary;
  /** Shared step span the metric diff is restricted to, or null when empty. */
  readonly common_step_range: StepRange | null;
  /** Per-metric diffs, sorted by metric name. */
  readonly metrics: readonly MetricSeriesDiff[];
  /** The configuration delta reported beside the metric diff. */
  readonly config_delta: ConfigDelta;
}

/**
 * Index one run's events to the last measured value per metric per step.
 *
 * A repeated `(metric, step)` pair is a re-measurement, not an error: the
 * series reader keeps every accepted occurrence, and the later occurrence is
 * the one a comparison should use, so later entries overwrite earlier ones.
 *
 * @param events - The run's decoded metric events, in series order.
 * @returns Metric name to step-value map.
 */
function valuesByMetric(events: readonly MetricEvent[]): Map<string, Map<number, number>> {
  const byMetric = new Map<string, Map<number, number>>();
  for (const event of events) {
    let steps = byMetric.get(event.metric);
    if (steps === undefined) {
      steps = new Map<number, number>();
      byMetric.set(event.metric, steps);
    }
    steps.set(event.step, event.value);
  }
  return byMetric;
}

/**
 * Diff two runs' metric series over their common step range.
 *
 * The common range is the intersection of the two runs' measured step spans,
 * across every metric, so a diff can never read a step one run never reached.
 * Inside that range each metric measured by both runs reports the steps they
 * share, the steps where their values differ, and the steps only one side
 * measured; a metric either run never measured reports presence only. Outside
 * the common range nothing is reported, which the range fields themselves make
 * explicit rather than leaving a reader to wonder what was left out.
 *
 * @param baseline - The baseline run's decoded events.
 * @param candidate - The candidate run's decoded events.
 * @returns The complete metric-level diff.
 */
export function diffMetricSeries(baseline: readonly MetricEvent[], candidate: readonly MetricEvent[]): SeriesDiff {
  const rangeOf = (events: readonly MetricEvent[]): StepRange | null => {
    if (events.length === 0) return null;
    let first = events[0]!.step;
    let last = first;
    for (const event of events) {
      if (event.step < first) first = event.step;
      if (event.step > last) last = event.step;
    }
    return { first, last };
  };
  const baselineRange = rangeOf(baseline);
  const candidateRange = rangeOf(candidate);
  let commonRange: StepRange | null = null;
  if (baselineRange !== null && candidateRange !== null) {
    const first = Math.max(baselineRange.first, candidateRange.first);
    const last = Math.min(baselineRange.last, candidateRange.last);
    if (first <= last) commonRange = { first, last };
  }
  const baselineValues = valuesByMetric(baseline);
  const candidateValues = valuesByMetric(candidate);
  const metrics: MetricSeriesDiff[] = [];
  for (const metric of [...new Set([...baselineValues.keys(), ...candidateValues.keys()])].sort()) {
    const baselineSteps = baselineValues.get(metric);
    const candidateSteps = candidateValues.get(metric);
    if (baselineSteps === undefined || candidateSteps === undefined) {
      metrics.push({
        metric,
        present: baselineSteps === undefined ? "candidate_only" : "baseline_only",
        common_steps: [],
        differences: [],
        baseline_only_steps: [],
        candidate_only_steps: [],
        max_abs_delta: null,
      });
      continue;
    }
    const inRangeSteps = [...new Set([...baselineSteps.keys(), ...candidateSteps.keys()])]
      .sort((left, right) => left - right)
      .filter((step) => commonRange !== null && step >= commonRange.first && step <= commonRange.last);
    const commonSteps: number[] = [];
    const differences: StepDifference[] = [];
    const baselineOnly: number[] = [];
    const candidateOnly: number[] = [];
    for (const step of inRangeSteps) {
      const baselineValue = baselineSteps.get(step);
      const candidateValue = candidateSteps.get(step);
      if (baselineValue !== undefined && candidateValue !== undefined) {
        commonSteps.push(step);
        if (baselineValue !== candidateValue) {
          differences.push({ step, baseline: baselineValue, candidate: candidateValue, delta: candidateValue - baselineValue });
        }
        continue;
      }
      if (baselineValue !== undefined) {
        baselineOnly.push(step);
      } else {
        candidateOnly.push(step);
      }
    }
    metrics.push({
      metric,
      present: "both",
      common_steps: commonSteps,
      differences,
      baseline_only_steps: baselineOnly,
      candidate_only_steps: candidateOnly,
      max_abs_delta: differences.length === 0 ? null : Math.max(...differences.map((difference) => Math.abs(difference.delta))),
    });
  }
  return { baseline_range: baselineRange, candidate_range: candidateRange, common_range: commonRange, metrics };
}

/**
 * Compute the leaf-level difference between two JSON values.
 *
 * Object keys are compared over their sorted union so an added or removed key
 * is one delta naming the side it disappeared from; arrays are compared
 * index-wise with any length excess reported per index. A position where the
 * two values are of different kinds (an object against a number, an array
 * against an object) reports one delta at that path rather than attempting a
 * structural comparison that would mislead.
 *
 * @param baseline - The baseline-side JSON value.
 * @param candidate - The candidate-side JSON value.
 * @returns Every differing leaf path, in deterministic walk order.
 */
export function diffJsonValues(baseline: JsonValue, candidate: JsonValue): readonly JsonDelta[] {
  const deltas: JsonDelta[] = [];
  const isObject = (value: JsonValue): value is { readonly [key: string]: JsonValue } =>
    value !== null && typeof value === "object" && !Array.isArray(value);
  const walk = (path: string, left: JsonValue, right: JsonValue): void => {
    if (isObject(left) && isObject(right)) {
      for (const key of [...new Set([...Object.keys(left), ...Object.keys(right)])].sort()) {
        const childPath = path.length === 0 ? key : `${path}.${key}`;
        if (!(key in left)) {
          deltas.push({ path: childPath, baseline: undefined, candidate: right[key] });
          continue;
        }
        if (!(key in right)) {
          deltas.push({ path: childPath, baseline: left[key], candidate: undefined });
          continue;
        }
        walk(childPath, left[key]!, right[key]!);
      }
      return;
    }
    if (Array.isArray(left) && Array.isArray(right)) {
      const shared = Math.min(left.length, right.length);
      for (let index = 0; index < shared; index += 1) walk(`${path}[${index}]`, left[index]!, right[index]!);
      for (let index = shared; index < left.length; index += 1) deltas.push({ path: `${path}[${index}]`, baseline: left[index]!, candidate: undefined });
      for (let index = shared; index < right.length; index += 1) deltas.push({ path: `${path}[${index}]`, baseline: undefined, candidate: right[index]! });
      return;
    }
    if (left !== right) deltas.push({ path, baseline: left, candidate: right });
  };
  walk("", baseline, candidate);
  return deltas;
}

/**
 * Build the configuration delta that explains a metric diff.
 *
 * Every field is computed from what each run actually recorded rather than
 * assumed equal because the runs share an environment: the environment is
 * content-addressed, so in practice two runs under one environment record the
 * same version and reward specification — but the delta says so because it was
 * measured, not because it was assumed.
 *
 * @param baseline - The baseline run's recorded configuration.
 * @param candidate - The candidate run's recorded configuration.
 * @returns The algorithm, hyperparameter, environment-version and reward-spec delta.
 */
export function buildConfigDelta(baseline: RunCompareInput, candidate: RunCompareInput): ConfigDelta {
  return {
    algorithm: baseline.algorithm === candidate.algorithm ? null : { baseline: baseline.algorithm, candidate: candidate.algorithm },
    hyperparameters: diffJsonValues(baseline.config, candidate.config),
    environment_version: baseline.environmentSpec.version === candidate.environmentSpec.version
      ? null
      : { baseline: baseline.environmentSpec.version, candidate: candidate.environmentSpec.version },
    reward_specification: diffJsonValues(baseline.environmentSpec.reward_specification, candidate.environmentSpec.reward_specification),
  };
}

/**
 * Assemble the full comparison view for two comparable runs.
 *
 * @param baseline - The baseline run's summary, events and recorded configuration.
 * @param candidate - The candidate run's summary, events and recorded configuration.
 * @returns The view the command returns and the renderer prints.
 */
export function buildCompareView(baseline: RunCompareInput, candidate: RunCompareInput): CompareView {
  const seriesDiff = diffMetricSeries(baseline.events, candidate.events);
  return {
    baseline: { id: baseline.id, algorithm: baseline.algorithm, environment: baseline.environment, step_range: seriesDiff.baseline_range },
    candidate: { id: candidate.id, algorithm: candidate.algorithm, environment: candidate.environment, step_range: seriesDiff.candidate_range },
    common_step_range: seriesDiff.common_range,
    metrics: seriesDiff.metrics,
    config_delta: buildConfigDelta(baseline, candidate),
  };
}

/**
 * Render one configuration difference as a stable, diffable line.
 *
 * @param change - The JSON delta to render.
 * @returns A line like `optimizer.lr: 0.1 -> 0.01`, with `(absent)` marking a
 *   side the path does not exist on.
 */
function renderJsonDelta(change: JsonDelta): string {
  const path = change.path.length === 0 ? "(root)" : change.path;
  const from = change.baseline === undefined ? "(absent)" : JSON.stringify(change.baseline);
  const to = change.candidate === undefined ? "(absent)" : JSON.stringify(change.candidate);
  return `${path}: ${from} -> ${to}`;
}

/**
 * Render a comparison view as stable, diffable text.
 *
 * The header names both runs and their shared environment, the range line
 * states whether the runs share any steps at all, each metric reports its
 * shared and differing steps, and the configuration delta closes the report so
 * the metric diff and its explanation are read as one statement.
 *
 * @param view - The comparison view to render.
 * @returns The rendered report text.
 */
export function renderCompareReport(view: CompareView): string {
  const lines: string[] = [
    `compare ${view.baseline.id} (baseline) with ${view.candidate.id} (candidate)`,
    `environment: ${view.baseline.environment}`,
  ];
  lines.push(view.common_step_range === null
    ? "common step range: none (the runs measured no overlapping steps)"
    : `common step range: ${view.common_step_range.first}..${view.common_step_range.last}`);
  for (const metric of view.metrics) {
    if (metric.present === "baseline_only") {
      lines.push(`${metric.metric}: only the baseline run measured this metric`);
      continue;
    }
    if (metric.present === "candidate_only") {
      lines.push(`${metric.metric}: only the candidate run measured this metric`);
      continue;
    }
    const head = `${metric.metric}: ${metric.common_steps.length} common step(s), ${metric.differences.length} differing`;
    lines.push(metric.max_abs_delta === null ? head : `${head}, max |delta| ${metric.max_abs_delta}`);
    for (const difference of metric.differences) {
      const sign = difference.delta >= 0 ? "+" : "";
      lines.push(`  step ${difference.step}: ${difference.baseline} -> ${difference.candidate} (${sign}${difference.delta})`);
    }
    if (metric.baseline_only_steps.length > 0) lines.push(`  only the baseline measured steps: ${metric.baseline_only_steps.join(",")}`);
    if (metric.candidate_only_steps.length > 0) lines.push(`  only the candidate measured steps: ${metric.candidate_only_steps.join(",")}`);
  }
  const delta = view.config_delta;
  lines.push(delta.algorithm === null ? "algorithm: unchanged" : `algorithm: ${delta.algorithm.baseline} -> ${delta.algorithm.candidate}`);
  lines.push(delta.hyperparameters.length === 0 ? "hyperparameters: unchanged" : "hyperparameters:");
  for (const change of delta.hyperparameters) lines.push(`  ${renderJsonDelta(change)}`);
  lines.push(delta.environment_version === null
    ? "environment version: unchanged"
    : `environment version: ${delta.environment_version.baseline} -> ${delta.environment_version.candidate}`);
  lines.push(delta.reward_specification.length === 0 ? "reward specification: unchanged" : "reward specification:");
  for (const change of delta.reward_specification) lines.push(`  ${renderJsonDelta(change)}`);
  return lines.join("\n");
}
