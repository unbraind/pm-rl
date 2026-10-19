/** Frozen chronological tasks derived only from verified public committed tracker snapshots. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { buildTrackerDataset, historyBlobs, type TrackerBuildOptions } from "./dataset.ts";
import { hashJson, type JsonValue } from "./index.ts";
import { validateHistoryPrefix, type HistoryPrefix } from "./prefix-data.ts";

/** Tracker-disjoint development, proposer validation and untouched audit compartments. */
export const IMPROVER_ROLES = ["development", "meta", "audit"] as const;
/** A label is available only at its recorded timestamp; inputs contain no type field or type value. */
export interface ImproverRow {
  readonly id: string;
  readonly prediction_at: number;
  readonly available_at: number;
  readonly prefix: HistoryPrefix;
  readonly label: 0 | 1;
}
/** One target on one tracker, with earlier fit rows and later frozen balanced evaluation rows. */
export interface ImproverTask {
  readonly id: string;
  readonly repo: string;
  readonly commit: string;
  readonly target: "time-to-close" | "issue-type";
  readonly cutoff: number;
  readonly threshold_ms: number | null;
  readonly train: readonly ImproverRow[];
  readonly evaluation: readonly ImproverRow[];
}
/** Only source pins and split identities are readable before an evaluator opens its role. */
export interface ImproverDataset {
  readonly format: "pm-rl/improver-dataset/1";
  readonly seed: number;
  readonly sources: readonly { readonly repo: string; readonly commit: string; readonly role: typeof IMPROVER_ROLES[number] }[];
  readonly splits: Readonly<Record<typeof IMPROVER_ROLES[number], { readonly digest: string; readonly tasks: number }>>;
  readonly omitted: readonly { readonly repo: string; readonly target: string }[];
  readonly digest: string;
}
/** Raw history is confined to the builder, with no author identifiers surviving projection. */
interface HistoryEvent { readonly ts?: string; readonly op?: string; readonly author?: string; readonly patch?: readonly { readonly path: string; readonly value?: unknown; readonly op?: string }[] }
/** Duration and initial type are targets; neither is an observable. */
export interface ImproverProjection { readonly id: string; readonly prediction_at: number; readonly terminal_at: number; readonly issue: boolean; readonly prefix: HistoryPrefix }

/** Read features strictly before an externally fixed prediction time; future event mutations cannot affect them. */
export function historyBeforePrediction(events: readonly HistoryEvent[], timestamp: number): HistoryPrefix {
  const visible = events.filter((event) => Date.parse(event.ts!) < timestamp);
  assert.ok(visible.length > 0 && Number.isFinite(timestamp), "improver_prediction_time");
  const words: number[] = []; const fields: string[] = [];
  const seen = new Set<string>();
  for (const event of visible) for (const patch of event.patch ?? []) {
    const field = patch.path.split("/")[2];
    if (["status", "tags", "assignee", "files", "docs", "tests", "comments", "description", "title"].includes(field)) fields.push(field);
    if (["title", "description"].includes(field) && patch.op !== "remove" && !seen.has(field)) {
      seen.add(field);
      for (const word of String(patch.value).toLowerCase().match(/[a-z][a-z0-9]{1,31}/g) ?? []) words.push(Number.parseInt(hashJson(word).slice(0, 8), 16));
    }
  }
  const prefix: HistoryPrefix = { events: visible.slice(-512).map((event) => ["create", "update", "claim", "release", "comment", "comment_add"].includes(event.op!) ? event.op! : "other"),
    fields: fields.slice(-2048), words: words.slice(0, 512), elapsed_ms: Date.parse(visible.at(-1)!.ts!) - Date.parse(visible[0].ts!),
    authors: new Set(visible.map((event) => event.author).filter((author) => author !== undefined)).size };
  validateHistoryPrefix(prefix);
  return prefix;
}

/** Predict one millisecond after creation, independently of any future close time or history length. */
export function projectImproverHistory(history: string, repo: string, item: string): ImproverProjection | null {
  const events = history.split("\n").filter(Boolean).map((line) => JSON.parse(line) as HistoryEvent);
  const times = events.map((event) => Date.parse(event.ts!));
  if (events.length === 0 || !times.every((time, index) => Number.isFinite(time) && (index === 0 || time >= times[index - 1]))) return null;
  const terminal = events.findIndex((event) => event.patch?.some((patch) => patch.path === "/metadata/status" && patch.op !== "remove" && ["closed", "canceled", "cancelled"].includes(String(patch.value))));
  const type = events[0].patch?.find((patch) => patch.path === "/metadata/type" && patch.op !== "remove");
  const prediction_at = times[0] + 1;
  if (terminal < 1 || times[terminal] <= prediction_at || type === undefined) return null;
  return { id: hashJson({ repo, item }), prediction_at, terminal_at: times[terminal], issue: type.value === "Issue", prefix: historyBeforePrediction(events, prediction_at) };
}

/** A fixed stratification rule balances both targets without moving items across time or tracker boundaries. */
function balancedRows(rows: readonly ImproverRow[]): ImproverRow[] {
  const zero = rows.filter((row) => row.label === 0); const one = rows.filter((row) => row.label === 1);
  const count = Math.min(zero.length, one.length);
  return [...zero.slice(0, count), ...one.slice(0, count)].sort((a, b) => a.prediction_at - b.prediction_at || a.id.localeCompare(b.id));
}

/** Seal a tracker task using training-only median calibration and purge labels unavailable at the evaluation boundary. */
export function chronologicalTask(projections: readonly ImproverProjection[], repo: string, commit: string, target: ImproverTask["target"]): ImproverTask | null {
  const ordered = [...projections].sort((a, b) => a.prediction_at - b.prediction_at || a.id.localeCompare(b.id));
  if (ordered.length < 10) return null;
  const cutoff = ordered[Math.floor(ordered.length * 0.6)].prediction_at;
  const training = ordered.filter((row) => row.prediction_at < cutoff && (target === "issue-type" || row.terminal_at < cutoff));
  if (training.length < 4) return null;
  const durations = training.map((row) => row.terminal_at - row.prediction_at).sort((a, b) => a - b);
  const threshold_ms = target === "time-to-close" ? (durations[Math.floor((durations.length - 1) / 2)] + durations[Math.floor(durations.length / 2)]) / 2 : null;
  /** Bind a binary target while retaining only the history capability and availability proof. */
  const label = (row: ImproverProjection): ImproverRow => ({ id: row.id, prediction_at: row.prediction_at,
    available_at: target === "time-to-close" ? row.terminal_at : row.prediction_at - 1,
    prefix: row.prefix, label: (target === "time-to-close" ? row.terminal_at - row.prediction_at <= threshold_ms! : row.issue) ? 0 : 1 });
  const train = balancedRows(training.map(label));
  const evaluation = balancedRows(ordered.filter((row) => row.prediction_at >= cutoff).map(label));
  if (train.length < 4 || evaluation.length < 4) return null;
  return { id: hashJson({ repo, target }).slice(0, 16), repo, commit, target, cutoff, threshold_ms, train, evaluation };
}

/** Verify public visibility and commit reachability before projecting the copied tracker histories. */
export function buildImproverDataset(directories: readonly string[], output: string, seed = 42, options: TrackerBuildOptions = {}): ImproverDataset {
  const verification = buildTrackerDataset(directories, join(output, "verification"), seed, { pins: options.pins });
  const sources = [...verification.sources].sort((a, b) => hashJson({ repo: a.repo, seed }).localeCompare(hashJson({ repo: b.repo, seed }))).map((source, index, all) => ({ repo: source.repo, commit: source.commit,
    role: IMPROVER_ROLES[index < Math.floor(all.length * 0.4) ? 0 : index < Math.floor(all.length * 0.8) ? 1 : 2] }));
  const splits: Record<typeof IMPROVER_ROLES[number], ImproverTask[]> = { development: [], meta: [], audit: [] };
  const omitted: { repo: string; target: string }[] = [];
  for (const directory of directories) {
    const root = dirname(dirname(directory));
    const remote = execFileSync("git", ["remote", "get-url", "origin"], { cwd: root, encoding: "utf8" }).trim();
    const source = sources.find((entry) => remote.endsWith(`${entry.repo}.git`) || remote.endsWith(entry.repo));
    if (source === undefined) continue;
    const paths = execFileSync("git", ["ls-tree", "-r", "--name-only", source.commit, "--", ".agents/pm/history"], { cwd: root, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 }).trim().split("\n").filter((path) => path.endsWith(".jsonl"));
    const rows = historyBlobs(root, source.commit, paths).flatMap((history, index) => {
      const row = projectImproverHistory(history, source.repo, paths[index]);
      return row === null ? [] : [row];
    });
    for (const target of ["time-to-close", "issue-type"] as const) {
      const task = chronologicalTask(rows, source.repo, source.commit, target);
      if (task === null) omitted.push({ repo: source.repo, target }); else splits[source.role].push(task);
    }
  }
  const identities = {} as ImproverDataset["splits"];
  for (const role of IMPROVER_ROLES) {
    assert.ok(splits[role].length > 0, "improver_empty_role");
    splits[role].sort((a, b) => a.id.localeCompare(b.id));
    Object.assign(identities, { [role]: { digest: hashJson(splits[role] as unknown as JsonValue), tasks: splits[role].length } });
    writeFileSync(join(output, `${role}.json`), JSON.stringify(splits[role]), { flag: "wx" });
  }
  const record = { format: "pm-rl/improver-dataset/1" as const, seed, sources, splits: identities, omitted };
  const manifest = { ...record, digest: hashJson(record as unknown as JsonValue) };
  mkdirSync(output, { recursive: true });
  writeFileSync(join(output, "improver-dataset.json"), JSON.stringify(manifest, null, 2), { flag: "wx" });
  return manifest;
}

/** A manifest read does not open task examples from any role. */
export function readImproverDataset(directory: string): ImproverDataset {
  const { digest, ...record } = JSON.parse(readFileSync(join(directory, "improver-dataset.json"), "utf8")) as ImproverDataset;
  assert.ok(record.format === "pm-rl/improver-dataset/1" && hashJson(record as unknown as JsonValue) === digest, "improver_dataset_identity");
  assert.equal(new Set(record.sources.map((source) => source.repo.toLowerCase())).size, record.sources.length, "improver_source_overlap");
  return { ...record, digest };
}

/** Verify role, identity, chronology, label availability and item isolation before exposing rows to the evaluator. */
export function readImproverTasks(directory: string, manifest: ImproverDataset, role: typeof IMPROVER_ROLES[number]): ImproverTask[] {
  const tasks = JSON.parse(readFileSync(join(directory, `${role}.json`), "utf8")) as ImproverTask[];
  assert.ok(tasks.length > 0 && tasks.length === manifest.splits[role].tasks && hashJson(tasks as unknown as JsonValue) === manifest.splits[role].digest, "improver_split_identity");
  assert.equal(new Set(tasks.map((task) => task.id)).size, tasks.length, "improver_task_duplicate");
  for (const task of tasks) {
    assert.ok(manifest.sources.some((source) => source.repo === task.repo && source.commit === task.commit && source.role === role), "improver_role_leakage");
    assert.ok(["time-to-close", "issue-type"].includes(task.target) && (task.target === "issue-type" ? task.threshold_ms === null : Number.isFinite(task.threshold_ms)), "improver_task_target");
    assert.ok(task.train.length >= 4 && task.evaluation.length >= 4 && task.train.length + task.evaluation.length <= 10_000, "improver_task_size");
    assert.equal(new Set([...task.train, ...task.evaluation].map((row) => row.id)).size, task.train.length + task.evaluation.length, "improver_item_overlap");
    for (const [rows, training] of [[task.train, true], [task.evaluation, false]] as const) for (const row of rows) {
      assert.ok((row.label === 0 || row.label === 1) && Number.isFinite(row.prediction_at) && Number.isFinite(row.available_at) && (training ? row.prediction_at < task.cutoff && row.available_at < task.cutoff : row.prediction_at >= task.cutoff), "improver_time_leakage");
      validateHistoryPrefix(row.prefix);
    }
    assert.ok([task.train, task.evaluation].every((rows) => rows.filter((row) => row.label === 0).length * 2 === rows.length), "improver_balance");
  }
  return tasks;
}
