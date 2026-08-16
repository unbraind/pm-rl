/**
 * @module pm-rl/invalidate
 *
 * Transitive result invalidation over the dependency edges pm already stores.
 *
 * The question — "I changed this environment or benchmark version; which of my
 * results are now meaningless?" — is reverse reachability over edges the host
 * already records: a Run depends on its Environment, an EvalResult on its Run
 * and its Benchmark, a Transfer on both of its environments. Those edges are
 * the `dependencies` entries on each item, read once from the tracker and
 * walked here — pm-rl declares the edges and stores no graph of its own.
 *
 * The walk is DIRECTIONAL, from each item toward the items that depend on it,
 * because invalidation is a data-flow question: a result derives from its
 * dependencies, so changing a dependency invalidates the dependent and never
 * the other way around. The host's own `pm graph impact` blast-radius query
 * cannot express that here: the `related` kind that `--dep` records is
 * registered as an undirected relationship, so the host walk crosses a
 * Transfer's second environment into another version's runs and reports them
 * as affected when their provenance does not derive from the changed version
 * at all. Directional reachability over the stored `dependencies` arrays is
 * the exact transitive set, and each invalidated result carries the exact
 * dependency path that reaches it, because "this eval is stale" and "this eval
 * is stale because its run used the environment you just changed" are
 * different statements to an operator deciding what to re-run.
 *
 * The functions in this module are pure; the command handler in
 * {@link ./index.ts} reads the inventory and calls them, keeping the walk
 * testable without standing up a workspace.
 */

/** Item types whose recorded change invalidates downstream results. */
export const INVALIDATION_ROOT_TYPES = ["Environment", "Benchmark"] as const;

/** Result item types `pm rl invalidate` reports as invalidated. */
export const INVALIDATED_RESULT_TYPES = ["EvalResult", "Transfer", "Run"] as const;

/**
 * One workspace item's identity, type, and stored dependency targets.
 *
 * This is the read surface of `pm list --fields id,type,dependencies`: the
 * `dependencies` array pm itself stores and merges, narrowed to what the walk
 * consumes. An item with no dependencies carries an empty target list.
 */
export interface ItemDependencyEdge {
  /** Item id. */
  readonly id: string;
  /** Item type name. */
  readonly type: string;
  /** Ids this item depends on, as stored on the item. */
  readonly targets: readonly string[];
}

/** One invalidated result together with the dependency path that reaches it. */
export interface InvalidationEntry {
  /** Item id of the invalidated result. */
  readonly id: string;
  /** Which tracked result type this item is. */
  readonly type: (typeof INVALIDATED_RESULT_TYPES)[number];
  /** Number of dependency edges from the invalidation root to this result. */
  readonly distance: number;
  /** Exact item-id path from the root to this result, inclusive. */
  readonly path: readonly string[];
}

/**
 * Walk stored dependency edges from a changed version to every invalidated
 * result.
 *
 * Starting at `root`, the walk follows the reverse of every stored dependency
 * edge — from each item to the items that named it as a dependency — so it
 * reaches exactly the items whose provenance transitively derives from the
 * root. A cycle terminates because each item is visited once. A dependency id
 * that resolves to no item is never followed outward (no stored item sits at
 * the far end to depend on anything further), so it cannot create a path
 * through itself; as a root it is the caller's to refuse, which the command
 * does at its item read before the walk runs. An item that is not one of the
 * tracked result types may lie on a path but is never reported. Entries are
 * returned sorted by id with the shortest discovered path to each, so the
 * report is stable and diffable across runs of the same query.
 *
 * @param root - The changed item's id; it is never reported as invalidating
 *   itself.
 * @param items - The workspace inventory's ids, types and dependency targets.
 * @returns The invalidated result entries, sorted by item id.
 */
export function transitiveInvalidation(root: string, items: readonly ItemDependencyEdge[]): readonly InvalidationEntry[] {
  const byId = new Map(items.map((item) => [item.id, item]));
  const dependentsOf = new Map<string, string[]>();
  for (const item of items) {
    for (const target of item.targets) {
      const dependents = dependentsOf.get(target);
      if (dependents === undefined) {
        dependentsOf.set(target, [item.id]);
        continue;
      }
      if (!dependents.includes(item.id)) dependents.push(item.id);
    }
  }
  for (const dependents of dependentsOf.values()) dependents.sort();
  const parentOf = new Map<string, string>();
  const queue = [root];
  for (let index = 0; index < queue.length; index += 1) {
    const current = queue[index]!;
    for (const dependent of dependentsOf.get(current) ?? []) {
      if (parentOf.has(dependent) || dependent === root) continue;
      parentOf.set(dependent, current);
      queue.push(dependent);
    }
  }
  const entries: InvalidationEntry[] = [];
  for (const id of parentOf.keys()) {
    const type = byId.get(id)!.type;
    if (type !== "EvalResult" && type !== "Transfer" && type !== "Run") continue;
    const path = [id];
    for (let walk = id; walk !== root; ) {
      walk = parentOf.get(walk)!;
      path.unshift(walk);
    }
    entries.push({ id, type, distance: path.length - 1, path });
  }
  return entries.sort((left, right) => left.id.localeCompare(right.id));
}

/**
 * Render an invalidation report as stable, diffable text.
 *
 * One line names the root and the count; one line per invalidated result names
 * its type, its hop distance, and the exact dependency path by which changing
 * the root reaches it.
 *
 * @param root - The invalidation root item id.
 * @param rootType - The root's item type name.
 * @param entries - Invalidation entries, as produced by
 *   {@link transitiveInvalidation}.
 * @returns The rendered report, one line per row plus a header.
 */
export function renderInvalidateReport(root: string, rootType: string, entries: readonly InvalidationEntry[]): string {
  const lines = [`${root} (${rootType}) invalidates ${entries.length} tracked result(s):`];
  for (const entry of entries) {
    lines.push(`${entry.id} | ${entry.type} | ${entry.distance} hop(s) | reached by ${entry.path.join(" → ")}`);
  }
  return lines.join("\n");
}
