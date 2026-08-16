/**
 * @module pm-rl/invalidate
 *
 * Transitive result invalidation over the dependency graph pm already stores.
 *
 * The question — "I changed this environment or benchmark version; which of my
 * results are now meaningless?" — is reverse reachability over edges the host
 * already records: a Run depends on its Environment, an EvalResult on its Run
 * and its Benchmark, a Transfer on both of its environments. pm-rl declares
 * those edges and asks the host's graph impact walk to traverse them, so this
 * module re-implements no graph; it classifies the walk's affected rows into
 * the tracked result types and renders the path that reaches each one.
 *
 * The functions in this module are pure; the command handler in
 * {@link ./index.ts} runs the host query and calls them, keeping the
 * classification testable without standing up a workspace.
 */

/** Item types whose recorded change invalidates downstream results. */
export const INVALIDATION_ROOT_TYPES = ["Environment", "Benchmark"] as const;

/** Result item types `pm rl invalidate` reports as invalidated. */
export const INVALIDATED_RESULT_TYPES = ["EvalResult", "Transfer", "Run"] as const;

/**
 * One affected row consumed from the host graph impact projection.
 *
 * The SDK types the `graph` result as a union over every subcommand envelope
 * without exporting the impact member, so the slice this command consumes is
 * named here; its fields are exactly the host's own affected-row contract.
 */
export interface ImpactAffectedRow {
  /** Affected item id. */
  readonly id: string;
  /** Shortest dependency distance from the invalidation root. */
  readonly distance: number;
  /** Exact item-id path from the root to this item, inclusive. */
  readonly path: readonly string[];
}

/** One invalidated result together with the dependency path that reaches it. */
export interface InvalidationEntry {
  /** Item id of the invalidated result. */
  readonly id: string;
  /** Which tracked result type this item is. */
  readonly type: (typeof INVALIDATED_RESULT_TYPES)[number];
  /** Shortest dependency distance from the invalidation root. */
  readonly distance: number;
  /** Exact item-id path from the root to this result, inclusive. */
  readonly path: readonly string[];
}

/**
 * Keep exactly the result rows from a host impact walk.
 *
 * The host walk returns every affected item, including intermediates whose
 * type carries no result (a generation or an ordinary tracker item between the
 * changed version and a result). Only `EvalResult`, `Transfer` and `Run` are
 * results pm-rl reports as invalidated, and only rows that resolve to a known
 * item type can be classified at all — an id the inventory does not know names
 * no result. Rows are returned sorted by id so the report is stable and
 * diffable across runs of the same query.
 *
 * @param affected - Affected rows from the host graph impact walk.
 * @param typesById - Item-type lookup over the workspace inventory.
 * @returns The invalidated result entries, sorted by item id.
 */
export function classifyInvalidated(
  affected: readonly ImpactAffectedRow[],
  typesById: ReadonlyMap<string, string>,
): readonly InvalidationEntry[] {
  const entries: InvalidationEntry[] = [];
  for (const row of affected) {
    const type = typesById.get(row.id);
    if (type !== "EvalResult" && type !== "Transfer" && type !== "Run") continue;
    entries.push({ id: row.id, type, distance: row.distance, path: [...row.path] });
  }
  return entries.sort((left, right) => left.id.localeCompare(right.id));
}

/**
 * Render an invalidation report as stable, diffable text.
 *
 * One line names the root and the count; one line per invalidated result names
 * its type, its hop distance, and the exact dependency path by which changing
 * the root reaches it — because "this eval is stale" and "this eval is stale
 * because its run used the environment you just changed" are different
 * statements to an operator deciding what to re-run.
 *
 * @param root - The invalidation root item id.
 * @param rootType - The root's item type name.
 * @param entries - Classified invalidation entries, as produced by
 *   {@link classifyInvalidated}.
 * @returns The rendered report, one line per row plus a header.
 */
export function renderInvalidateReport(root: string, rootType: string, entries: readonly InvalidationEntry[]): string {
  const lines = [`${root} (${rootType}) invalidates ${entries.length} tracked result(s):`];
  for (const entry of entries) {
    lines.push(`${entry.id} | ${entry.type} | ${entry.distance} hop(s) | reached by ${entry.path.join(" → ")}`);
  }
  return lines.join("\n");
}
