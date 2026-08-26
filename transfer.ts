/**
 * @module pm-rl/transfer
 *
 * Sim-to-real transfer measurement and gap reporting.
 *
 * A Transfer links a source Environment (the simulator) to a target Environment
 * (deployment, or a harder benchmark) and records the measured per-metric gap
 * for one checkpoint. `pm rl transfer gap` reports the gap series across a run's
 * checkpoints in recording order, which surfaces the actual failure mode of a
 * sim-heavy programme — sim performance improving while transfer stalls —
 * instead of leaving it to be noticed at deployment.
 *
 * A transfer measured against a superseded environment version is reported as
 * stale rather than plotted: a gap whose provenance no longer holds is not a
 * data point, and plotting it beside fresh ones would manufacture a trend.
 *
 * The functions in this module are pure; the command handlers in
 * {@link ./index.ts} resolve tracker items and call them.
 */

import { Buffer } from "node:buffer";

import { EXIT_CODE } from "@unbrained/pm-cli/sdk/runtime";

import { expectedFail, parseJsonRecord, requiredTrimmedString } from "./refuse.ts";

/** One recorded sim-to-real transfer: both environments, the checkpoint, and the measured gaps. */
export interface TransferSpec {
  /** Content-addressed Environment item id of the simulator side. */
  readonly source_environment_id: string;
  /** Content-addressed Environment item id of the deployment or harder-benchmark side. */
  readonly target_environment_id: string;
  /** Content-addressed checkpoint identity whose policy was measured. */
  readonly checkpoint: string;
  /** Run item id whose checkpoints this transfer series tracks. */
  readonly run_id: string;
  /** The measured per-metric gaps, one entry per measured metric. */
  readonly gaps: readonly MetricGap[];
}

/** Dependency provenance marker for a transfer's simulator-side environment. */
export const TRANSFER_SOURCE_ENVIRONMENT = "pm-rl:transfer:source";

/** Dependency provenance marker for a transfer's deployment-side environment. */
export const TRANSFER_TARGET_ENVIRONMENT = "pm-rl:transfer:target";

/** Dependency provenance marker connecting a transfer to its source run. */
export const TRANSFER_RUN = "pm-rl:transfer:run";

/** Dependency provenance markers connecting a transfer to its two environments and its run. */
export const TRANSFER_EDGE_SOURCES = [TRANSFER_SOURCE_ENVIRONMENT, TRANSFER_TARGET_ENVIRONMENT, TRANSFER_RUN] as const;

/** One measured per-metric gap. */
export interface MetricGap {
  /** What was measured, e.g. `episode_return`. Never empty; unique per transfer. */
  readonly metric: string;
  /** Target minus source on a comparable scale; finite by construction. */
  readonly gap: number;
}

/**
 * Parse and validate a transfer metrics file.
 *
 * @param text - The JSON text of `{ gaps: [{ metric, gap }] }`.
 * @param source - Human-readable label naming the source being parsed.
 * @returns Every measured gap, sorted by metric name for canonical storage.
 * @throws When the text is not one JSON object, a gap list is empty or
 *   duplicated, or any entry lacks a metric name or a finite gap.
 */
export function parseTransferMetrics(text: string, source = "Transfer metrics"): MetricGap[] {
  const gapsRaw = parseJsonRecord(text, source, "invalid_transfer_gaps")["gaps"];
  if (!Array.isArray(gapsRaw)) {
    expectedFail(`${source} requires a gaps array.`, "invalid_transfer_gaps");
  }
  if (gapsRaw.length === 0) {
    expectedFail(`${source} requires at least one measured gap; a transfer that measures nothing records nothing.`, "invalid_transfer_gaps", EXIT_CODE.CONFLICT);
  }
  const seen = new Set<string>();
  const gaps: MetricGap[] = [];
  for (const entry of gapsRaw) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      expectedFail(`${source} requires each gap to be an object with a metric and a gap.`, "invalid_transfer_gaps");
    }
    const record = entry as Record<string, unknown>;
    const metric = record["metric"];
    const gap = record["gap"];
    if (typeof metric !== "string" || metric.trim().length === 0) {
      expectedFail(`${source} requires a non-empty string metric for every gap.`, "invalid_transfer_gaps");
    }
    if (typeof gap !== "number" || !Number.isFinite(gap)) {
      expectedFail(`${source} requires a finite number gap for "${metric}".`, "invalid_transfer_gaps");
    }
    // Normalized BEFORE the uniqueness check: comparing raw spellings lets
    // `"reward"` and `" reward "` both through, and both then store `reward` —
    // two entries for one metric, where the report would silently keep only
    // the first.
    const normalizedMetric = metric.trim();
    if (seen.has(normalizedMetric)) {
      expectedFail(`${source} reports metric "${normalizedMetric}" twice; measure each metric once per transfer.`, "invalid_transfer_gaps", EXIT_CODE.CONFLICT);
    }
    seen.add(normalizedMetric);
    gaps.push({ metric: normalizedMetric, gap });
  }
  // Byte order, not localeCompare: this sequence is stored in an item body
  // hashed into affectedVersion, so two hosts must sort it identically.
  return gaps.sort((left, right) => byByteOrder(left.metric, right.metric));
}

/**
 * Parse and validate one stored transfer specification from its JSON fence.
 *
 * @param text - The JSON text inside the transfer's specification fence.
 * @param source - Human-readable label naming the source being parsed.
 * @returns The validated specification with gaps re-sorted by metric name.
 * @throws When a provenance field is absent or blank, or the stored gaps are
 *   malformed — a hand-authored body is the reachable path for both.
 */
export function parseTransferSpec(text: string, source = "Transfer specification"): TransferSpec {
  const record = parseJsonRecord(text, source, "invalid_transfer_json", EXIT_CODE.CONFLICT);
  const stringField = (key: string): string => requiredTrimmedString(record, key, source, "invalid_transfer_", EXIT_CODE.CONFLICT);
  return {
    source_environment_id: stringField("source_environment_id"),
    target_environment_id: stringField("target_environment_id"),
    checkpoint: stringField("checkpoint"),
    run_id: stringField("run_id"),
    gaps: parseTransferMetrics(JSON.stringify({ gaps: record["gaps"] ?? [] }), `${source} gaps`),
  };
}

/** One plotted transfer: identity, checkpoint, and its measured gaps in metric order. */
export interface PlottedTransfer {
  /** Transfer item id. */
  readonly id: string;
  /** Content-addressed checkpoint identity the transfer measured. */
  readonly checkpoint: string;
  /** The transfer's recording instant, defining series order. */
  readonly created_at: string;
  /** Measured gaps, sorted by metric name. */
  readonly gaps: readonly MetricGap[];
}

/** One stale transfer, reported separately from the series. */
export interface StaleTransfer {
  /** Transfer item id. */
  readonly id: string;
  /** Why its provenance no longer holds, verbatim from the invalidation check. */
  readonly reason: string;
}

/** A complete transfer-gap report over one run's transfers. */
export interface TransferGapReport {
  /** Plotted transfers in recording order. */
  readonly plotted: readonly PlottedTransfer[];
  /**
   * Per-metric gap series aligned with `plotted` order.
   *
   * A metric a plotted transfer never measured appears as `Number.NaN`: the
   * table renderer prints it verbatim as the hole, while the JSON path serializes
   * that same value as `null` (JSON has no NaN) — consumers of either output must
   * treat absent as missing, not zero.
   */
  readonly per_metric: Readonly<Record<string, readonly number[]>>;
  /** Transfers held out of the series because their provenance went stale. */
  readonly stale: readonly StaleTransfer[];
}

/**
 * Compare two strings by their UTF-8 bytes.
 *
 * Every ordering this module records ends up in an item body that is hashed and
 * compared across hosts, so the comparator must not depend on locale or on
 * JavaScript's UTF-16 code-unit ordering. Those two disagree in practice: `Ａ`
 * (U+FF21) sorts after `𝐀` (U+1D400) by UTF-16 code unit and before it by UTF-8
 * byte, so a metric name outside the BMP would order differently on two hosts
 * that ran the same code.
 *
 * @param left - First string to compare.
 * @param right - Second string to compare.
 * @returns Negative, zero or positive, per `Array.prototype.sort`.
 */
function byByteOrder(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left), Buffer.from(right));
}

/**
 * Assemble the gap report: plotted transfers in recording order plus everything
 * held out as stale.
 *
 * Ordering follows `created_at` with item id as the tie-break within one
 * instant, so the series reads as the checkpoints were actually measured. A
 * transfer carrying ANY staleness reason is excluded from every series — half of
 * a broken measurement is still broken.
 *
 * @param entries - Each transfer's id, recording instant, parsed spec, and the
 *   staleness reason computed by the caller (null when still valid).
 * @returns The report the command returns and the renderer prints.
 */
export function buildTransferGapReport(
  entries: ReadonlyArray<{ id: string; created_at: string; spec: TransferSpec; stale_reason: string | null }>,
): TransferGapReport {
  const ordered = [...entries].sort((left, right) =>
    left.created_at === right.created_at
      ? byByteOrder(left.id, right.id)
      : byByteOrder(left.created_at, right.created_at),
  );
  const plotted: PlottedTransfer[] = [];
  const stale: StaleTransfer[] = [];
  for (const entry of ordered) {
    if (entry.stale_reason !== null) {
      stale.push({ id: entry.id, reason: entry.stale_reason });
      continue;
    }
    plotted.push({ id: entry.id, checkpoint: entry.spec.checkpoint, created_at: entry.created_at, gaps: entry.spec.gaps });
  }
  const metrics = [...new Set(plotted.flatMap((transfer) => transfer.gaps.map((gap) => gap.metric)))].sort(byByteOrder);
  const perMetric: Record<string, number[]> = {};
  for (const metric of metrics) {
    perMetric[metric] = plotted
      .map((transfer) => transfer.gaps.find((gap) => gap.metric === metric))
      .map((gap) => (gap === undefined ? Number.NaN : gap.gap));
  }
  return { plotted, per_metric: perMetric, stale };
}

/**
 * Render a transfer-gap report as stable, diffable text.
 *
 * One line names the plotted/stale split, one line per plotted transfer gives
 * its checkpoint and gaps, one line per metric gives the aligned series, and
 * every stale transfer is named with its reason so exclusion is auditable.
 *
 * @param runId - The run whose checkpoints the series spans.
 * @param report - The computed report.
 * @returns The rendered report text.
 */
export function renderTransferGapReport(runId: string, report: TransferGapReport): string {
  const lines = [`transfer gap series for ${runId}: ${report.plotted.length} plotted, ${report.stale.length} stale`];
  for (const transfer of report.plotted) {
    const gaps = transfer.gaps.map((gap) => `${gap.metric}=${Number(gap.gap.toFixed(6))}`).join(" ");
    lines.push(`${transfer.id} | ${transfer.checkpoint} | ${gaps}`);
  }
  for (const [metric, series] of Object.entries(report.per_metric)) {
    lines.push(`series ${metric}: ${series.map((value) => Number(value.toFixed(6))).join(" -> ")}`);
  }
  for (const entry of report.stale) {
    lines.push(`stale (excluded from the series): ${entry.id} — ${entry.reason}`);
  }
  return lines.join("\n");
}
