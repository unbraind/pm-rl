/** Public-history projections whose observables stop at one seeded event cut. */
import assert from "node:assert/strict";
import { hashJson } from "./index.ts";
import type { TrackerExample } from "./dataset.ts";

/** Bounded, identity-free inputs available before the future close event. */
export interface HistoryPrefix {
  readonly events: readonly string[];
  readonly fields: readonly string[];
  readonly words: readonly number[];
  readonly elapsed_ms: number;
  readonly authors: number;
}
/** Unlabelled duration is sealed by the builder after training-only calibration. */
export interface PrefixProjection {
  readonly example: TrackerExample;
  readonly remaining_ms: number;
  readonly next_lifecycle: string;
  readonly reopened: string;
  readonly item_type: string;
}
/** Candidate frequencies describe only training examples, never either outer holdout. */
export interface TargetDistribution {
  readonly target: string;
  readonly counts: Readonly<Record<string, number>>;
  readonly samples: number;
  readonly majority: number;
}
/** Stable item assignment preserves one item per compartment, independent of its features and target. */
export function prefixInnerExample(id: string): boolean { return Number.parseInt(id.slice(0, 8), 16) % 5 === 0; }

/** Empty lifecycle prefixes are ineligible; unknown nonterminal statuses refuse before sealing or reading. */
export function validateLifecyclePrefix(prefix: readonly string[]): boolean {
  for (const status of prefix) assert.ok(["open", "in_progress", "blocked"].includes(status), `dataset_unknown_status: ${status.slice(0, 32)}`);
  return prefix.length > 0;
}

/** Extract lifecycle and content changes without retaining author identities or raw public text. */
export function projectHistoryPrefix(history: string, repo: string, commit: string, item: string, seed: number): PrefixProjection | null {
  const events = history.split("\n").filter(Boolean).map((line) => JSON.parse(line) as {
    ts?: string; author?: string; op?: string; patch?: readonly { path: string; value?: unknown; op?: string }[];
  });
  const states = events.flatMap((event, index) => (event.patch ?? []).filter((patch) => patch.path === "/metadata/status" && patch.op !== "remove")
    .map((patch) => ({ index, status: String(patch.value) })));
  const terminal = states.find((state) => ["closed", "canceled", "cancelled"].includes(state.status));
  validateLifecyclePrefix((terminal === undefined ? states : states.slice(0, states.indexOf(terminal))).map((state) => state.status));
  if (terminal === undefined || terminal.index === 0) return null;
  const id = hashJson({ repo, item });
  const cut = Number.parseInt(hashJson({ id, seed }).slice(0, 8), 16) % terminal.index;
  const lifecycle = states.filter((state) => state.index <= cut).map((state) => state.status);
  if (!validateLifecyclePrefix(lifecycle)) return null;
  const visible = events.slice(0, cut + 1);
  const first = Date.parse(events[0].ts ?? "");
  const now = Date.parse(events[cut].ts ?? "");
  const end = Date.parse(events[terminal.index].ts ?? "");
  if (![first, now, end].every(Number.isFinite) || now < first || end < now) return null;
  const fields: string[] = []; const words: number[] = []; let titleSeen = false; let descriptionSeen = false;
  for (const event of visible) for (const patch of event.patch ?? []) {
    const field = patch.path.split("/")[2];
    if (["status", "priority", "type", "tags", "assignee", "files", "docs", "tests", "comments", "description", "title"].includes(field)) fields.push(field);
    if (patch.op === "remove") continue;
    if ((field === "title" && !titleSeen) || (field === "description" && !descriptionSeen)) {
      if (field === "title") titleSeen = true; else descriptionSeen = true;
      for (const word of String(patch.value).toLowerCase().match(/[a-z][a-z0-9]{1,31}/g) ?? []) words.push(Number.parseInt(hashJson(word).slice(0, 8), 16));
    }
  }
  const prefix: HistoryPrefix = {
    events: visible.slice(-512).map((event) => ["create", "update", "claim", "release", "comment", "comment_add", "files_add", "docs_add", "test_add"].includes(event.op ?? "") ? event.op! : "other"),
    fields: fields.slice(-2048), words: words.slice(0, 512), elapsed_ms: now - first,
    authors: new Set(visible.map((event) => event.author).filter((author) => author !== undefined)).size,
  };
  return { example: { id, repo, commit, prefix: lifecycle, label: "fast", history: prefix },
    remaining_ms: end - now, next_lifecycle: states.find((state) => state.index > cut)!.status,
    reopened: String(states.some((state) => state.index > terminal.index && state.status === "open")),
    item_type: String(events.flatMap((event) => event.patch ?? []).find((patch) => patch.path === "/metadata/type")?.value ?? "unknown") };
}

/** Freeze a median boundary and measure four predeclared targets using the fit compartment alone. */
export function calibratePrefixTarget(rows: readonly PrefixProjection[]): { threshold_ms: number; candidates: TargetDistribution[] } {
  assert.ok(rows.length >= 10, "prefix_calibration_samples");
  const durations = rows.map((row) => row.remaining_ms).sort((a, b) => a - b);
  const threshold_ms = durations[Math.floor(durations.length / 2)];
  const candidates = ["next_lifecycle", "reopened", "item_type", "time_to_close"].map((target) => {
    const counts: Record<string, number> = {};
    for (const row of rows) {
      const label = target === "time_to_close" ? (row.remaining_ms <= threshold_ms ? "fast" : "slow") : String(row[target as "next_lifecycle" | "reopened" | "item_type"]);
      counts[label] = (counts[label] ?? 0) + 1;
    }
    return { target, counts, samples: rows.length, majority: Math.max(...Object.values(counts)) / rows.length };
  });
  assert.ok(candidates[3].majority <= 0.6, "prefix_unbalanced_target");
  return { threshold_ms, candidates };
}

/** Refuse malformed observables before they enter a trainer or sealed evaluator. */
export function validateHistoryPrefix(prefix: HistoryPrefix): void {
  assert.ok(prefix.events.length > 0 && prefix.events.length <= 512 && prefix.events.every((event) => /^[a-z_]{1,24}$/.test(event)), "prefix_events");
  assert.ok(prefix.fields.length <= 2048 && prefix.fields.every((field) => /^[a-z_]{1,24}$/.test(field)), "prefix_fields");
  assert.ok(prefix.words.length <= 512 && prefix.words.every((word) => Number.isInteger(word) && word >= 0 && word <= 0xffff_ffff), "prefix_words");
  assert.ok(Number.isFinite(prefix.elapsed_ms) && prefix.elapsed_ms >= 0 && Number.isSafeInteger(prefix.authors) && prefix.authors >= 0, "prefix_scalars");
}
