import { identifierClient } from "./state-boundary.ts";
/** Read-only, Git-independent tracker snapshots for the existing durable recursive controller. */
import type { ItemMetadata, PmClient } from "@unbrained/pm-cli/sdk/core";
import { createPmCliExpectedError } from "@unbrained/pm-cli/sdk/runtime";
import { hashJson, type JsonValue } from "./index.ts";
import { parseLoopConfig } from "./loop.ts";

/** A sealed projected item; neither title text nor filesystem coordinates are retained. */
export interface CorpusRow {
  readonly item: string;
  readonly content: string;
  readonly length: number;
  /** Fixed title-only token projection; labels and identities never enter these columns. */
  readonly features?: readonly number[];
  readonly closed: boolean;
}

/** A complete corpus receipt and the JSON accepted by `rl loop run`. */
export interface TrackerLoopCorpus {
  readonly programme: JsonValue;
  readonly snapshot: string;
  readonly rows: readonly CorpusRow[];
  readonly training_items: number;
  readonly held_out_items: number;
  readonly held_out_closed: number;
}

/** Refuse malformed or contaminated corpora with a stable command-level reason. */
function corpusRefusal(code: string): never {
  throw createPmCliExpectedError(`Tracker corpus refused: ${code}.`, { context: { code } });
}

/** Group identical model inputs together, including renamed or differently labelled duplicates. */
export function corpusHeldOut(length: number): boolean {
  return Number.parseInt(hashJson({ length }).slice(-8), 16) % 5 === 0;
}

/** Reconstruct the exact datasets from the sealed receipt; edits and renamed held-out leaks fail closed. */
export function verifyTrackerLoopCorpus(programme: Readonly<Record<string, unknown>>): void {
  const corpus = programme["corpus"];
  if (corpus === null || typeof corpus !== "object" || Array.isArray(corpus)) corpusRefusal("corpus_invalid_seal");
  const record = corpus as Record<string, unknown>;
  if (record["format"] === "pm-rl/intake-corpus/1") { verifyIntakeCorpus(programme, record); return; }
  if (!["pm-rl/tracker-loop-corpus/1", "pm-rl/tracker-loop-corpus/2"].includes(String(record["format"])) || !Array.isArray(record["rows"])) corpusRefusal("corpus_invalid_seal");
  const rows = record["rows"] as CorpusRow[];
  if (rows.length > 10_000 || rows.some((row) => row === null || typeof row !== "object" || !/^[a-f0-9]{64}$/.test(row.item) || !/^[a-f0-9]{64}$/.test(row.content) || !Number.isInteger(row.length) || row.length < 1 || row.length > 256 || typeof row.closed !== "boolean")) corpusRefusal("corpus_invalid_seal");
  if (rows.some((row) => record["format"] === "pm-rl/tracker-loop-corpus/2" ? !Array.isArray(row.features) || row.features.length !== 64 || row.features.some((value) => typeof value !== "number" || !Number.isFinite(value) || Math.abs(value) > 1) : row.features !== undefined)) corpusRefusal("corpus_invalid_seal");
  if (new Set(rows.map((row) => row.item)).size !== rows.length) corpusRefusal("corpus_duplicate_item");
  const snapshot = hashJson(rows as unknown as JsonValue);
  if (record["snapshot"] !== snapshot) corpusRefusal("corpus_snapshot_drift");
  const expected = corpusDatasets(rows, snapshot);
  if (["training", "evaluation", "environment"].some((key) => programme[key] === undefined)) corpusRefusal("corpus_dataset_drift");
  if (hashJson(programme["training"] as JsonValue) !== hashJson(expected.training) || hashJson(programme["evaluation"] as JsonValue) !== hashJson(expected.evaluation) || hashJson(programme["environment"] as JsonValue) !== hashJson({ name: "Tracker snapshot closed-status recognition", version: snapshot })) corpusRefusal("corpus_dataset_drift");
}

/** Project sealed rows; identical lengths share a partition regardless of item identity or target. */
function corpusDatasets(rows: readonly CorpusRow[], snapshot: string): { training: JsonValue[]; evaluation: JsonValue[] } {
  /** Only the sampled rewards of the training partition reach the external trainer. */
  const examples = (heldOut: boolean): JsonValue[] => rows.filter((row) => corpusHeldOut(row.length) === heldOut).map((row) => ({
    id: hashJson({ snapshot, item: row.item }), feature: Math.log1p(row.length) / Math.log(257), ...(row.features === undefined ? {} : { features: [...row.features] }), rewards: row.closed ? [0, 1] : [1, 0],
  }));
  return { training: examples(false), evaluation: examples(true) };
}

/** Seal projected input groups together so identical inputs cannot cross the held-out boundary. */
export function sealTrackerLoopCorpus(items: readonly Pick<ItemMetadata, "id" | "title" | "status">[], bounds: JsonValue): TrackerLoopCorpus {
  if (bounds === null || typeof bounds !== "object" || Array.isArray(bounds)) corpusRefusal("corpus_invalid_bounds");
  if (bounds["feature_mode"] !== undefined && bounds["feature_mode"] !== "title-tokens-v1") corpusRefusal("corpus_invalid_bounds");
  if (bounds["trainer"] !== undefined && bounds["trainer"] !== "bandit") corpusRefusal("corpus_invalid_bounds");
  if (["training", "evaluation", "environment", "corpus"].some((key) => Object.hasOwn(bounds, key))) corpusRefusal("corpus_external_datasets");
  if (items.length > 10_000) corpusRefusal("corpus_item_limit");
  const seen = new Set<string>();
  const rows = items.map((item): CorpusRow => {
    if (typeof item.id !== "string" || typeof item.title !== "string" || typeof item.status !== "string") corpusRefusal("corpus_invalid_item");
    const title = item.title.normalize("NFKC").trim().replaceAll(/\s+/g, " ").toLowerCase();
    if (!item.id.trim() || !title || !item.status.trim()) corpusRefusal("corpus_invalid_item");
    if (seen.has(item.id)) corpusRefusal("corpus_duplicate_item");
    seen.add(item.id);
    return { item: hashJson(item.id), content: hashJson({ title, status: item.status }), length: Math.min(256, [...title].length), ...(bounds["feature_mode"] === undefined ? {} : { features: titleFeatures(title) }), closed: item.status === "closed" };
  }).sort((left, right) => left.item < right.item ? -1 : 1);
  const snapshot = hashJson(rows as unknown as JsonValue);
  const { training, evaluation } = corpusDatasets(rows, snapshot);
  if (training.length < 2 || evaluation.length < 2) corpusRefusal("corpus_insufficient_split");
  const programme: JsonValue = { ...bounds, corpus: { format: bounds["feature_mode"] === undefined ? "pm-rl/tracker-loop-corpus/1" : "pm-rl/tracker-loop-corpus/2", snapshot, rows: rows as unknown as JsonValue },
    environment: { name: "Tracker snapshot closed-status recognition", version: snapshot }, training, evaluation };
  parseLoopConfig(programme);
  return { programme, snapshot, rows, training_items: training.length, held_out_items: evaluation.length,
    held_out_closed: rows.filter((row) => corpusHeldOut(row.length) && row.closed).length };
}

/** Read a certified complete local SDK inventory without executing extensions, Git, or source mutations. */
export async function buildTrackerLoopCorpus(client: PmClient, bounds: JsonValue): Promise<TrackerLoopCorpus> {
  const inventory = await identifierClient(client).listAllComplete({ includeBody: false });
  return sealTrackerLoopCorpus(inventory.items, bounds);
}

/** Fixed hashing is fitted without labels, vocabulary selection, item identity or held-out statistics. */
export function titleFeatures(title: string): number[] {
  const values = new Array<number>(64).fill(0);
  values[0] = 1;
  values[1] = (Math.min(256, [...title].length) - 128) / 128;
  const words = [...new Set(title.match(/[\p{L}\p{N}]+/gu) ?? [])].slice(0, 64);
  for (const word of words) {
    const hash = hashJson(word);
    const column = 2 + Number.parseInt(hash.slice(0, 8), 16) % 62;
    values[column] += (Number.parseInt(hash.slice(-1), 16) % 2 === 0 ? 1 : -1) / Math.sqrt(words.length);
  }
  return values.map((value) => Math.max(-1, Math.min(1, value)));
}

/** Creation-time inputs retain only title projections, an intake target and a frozen heuristic action. */
export interface IntakeRow {
  readonly item: string;
  readonly content: string;
  readonly length: number;
  readonly features: readonly number[];
  readonly label: boolean;
  readonly heuristic: 0 | 1;
}

/** Fixed keyword router, declared before learning and independent of corpus frequencies. */
export function intakeHeuristic(title: string): 0 | 1 {
  return /\b(bug|fix|fail\w*|error|regression|security|refus\w*|reject\w*|corrupt\w*|broken|crash\w*)\b/u.test(title) ? 1 : 0;
}

/** Read only the first creation event; later edits, outcomes, authors and timestamps are unavailable inputs. */
export function projectIntakeHistory(history: string): Pick<ItemMetadata, "id" | "title" | "type"> {
  const first = JSON.parse(history.split("\n")[0]) as { op?: string; patch?: readonly { op: string; path: string; value?: unknown }[] };
  if (first.op !== "create" || !Array.isArray(first.patch)) corpusRefusal("intake_missing_creation");
  const fields = ["id", "title", "type"].map((field) => first.patch!.find((patch) => patch.path === `/metadata/${field}` && patch.op === "add")?.value);
  if (fields.some((field) => typeof field !== "string" || !field.trim())) corpusRefusal("intake_missing_creation");
  return { id: fields[0] as string, title: fields[1] as string, type: fields[2] as string };
}

/** Reconstruct all intake examples with class labels confined to reward, sampling and evaluator metadata. */
function intakeDatasets(rows: readonly IntakeRow[], snapshot: string): { training: JsonValue[]; evaluation: JsonValue[] } {
  const examples = (heldOut: boolean): JsonValue[] => rows.filter((row) => corpusHeldOut(row.length) === heldOut).map((row) => ({
    id: hashJson({ snapshot, item: row.item }), feature: Math.log1p(row.length) / Math.log(257), features: [...row.features],
    rewards: row.label ? [0, 1] : [1, 0], balance: { label: row.label, heuristic: row.heuristic },
  }));
  return { training: examples(false), evaluation: examples(true) };
}

/** Reject altered objective, projections, partition, heuristic actions or reconstructed datasets before collection. */
function verifyIntakeCorpus(programme: Readonly<Record<string, unknown>>, record: Readonly<Record<string, unknown>>): void {
  if (programme["objective"] !== "intake-issue-balanced-v1" || !Array.isArray(record["rows"])) corpusRefusal("intake_invalid_seal");
  const rows = record["rows"] as IntakeRow[];
  if (rows.length > 10_000 || rows.some((row) => row === null || typeof row !== "object" || !/^[a-f0-9]{64}$/.test(row.item) || !/^[a-f0-9]{64}$/.test(row.content) || !Number.isInteger(row.length) || row.length < 1 || row.length > 256 || typeof row.label !== "boolean" || ![0, 1].includes(row.heuristic) || !Array.isArray(row.features) || row.features.length !== 64 || row.features.some((value) => typeof value !== "number" || !Number.isFinite(value) || Math.abs(value) > 1))) corpusRefusal("intake_invalid_seal");
  if (new Set(rows.map((row) => row.item)).size !== rows.length) corpusRefusal("corpus_duplicate_item");
  const snapshot = hashJson(rows as unknown as JsonValue);
  if (record["snapshot"] !== snapshot) corpusRefusal("corpus_snapshot_drift");
  const datasets = intakeDatasets(rows, snapshot);
  for (const key of ["training", "evaluation"] as const) {
    const partition = rows.filter((row) => corpusHeldOut(row.length) === (key === "evaluation"));
    if ([false, true].some((label) => !partition.some((row) => row.label === label))) corpusRefusal("intake_missing_class");
    if (programme[key] === undefined || hashJson(programme[key] as JsonValue) !== hashJson(datasets[key])) corpusRefusal("corpus_dataset_drift");
  }
  if (programme["environment"] === undefined || hashJson(programme["environment"] as JsonValue) !== hashJson({ name: "Creation-title Issue routing with balanced accuracy", version: snapshot })) corpusRefusal("corpus_dataset_drift");
}

/** Seal a real creation-history corpus without Git, label-fitted features or majority subsampling. */
export function sealIntakeCorpus(items: readonly Pick<ItemMetadata, "id" | "title" | "type">[], bounds: JsonValue): JsonValue {
  if (bounds === null || typeof bounds !== "object" || Array.isArray(bounds) || bounds["objective"] !== "intake-issue-balanced-v1" || bounds["feature_mode"] !== "title-tokens-v1" || ["training", "evaluation", "environment", "corpus"].some((key) => Object.hasOwn(bounds, key))) corpusRefusal("corpus_invalid_bounds");
  const rows = items.map((item): IntakeRow => {
    if (typeof item.id !== "string" || !item.id.trim() || typeof item.title !== "string" || typeof item.type !== "string" || !item.type.trim()) corpusRefusal("corpus_invalid_item");
    const title = item.title.normalize("NFKC").trim().replaceAll(/\s+/g, " ").toLowerCase();
    return { item: hashJson(item.id), content: hashJson({ title, type: item.type }), length: Math.min(256, [...title].length), features: titleFeatures(title), label: item.type === "Issue", heuristic: intakeHeuristic(title) };
  }).sort((left, right) => left.item < right.item ? -1 : 1);
  const snapshot = hashJson(rows as unknown as JsonValue);
  const programme: JsonValue = { ...bounds, corpus: { format: "pm-rl/intake-corpus/1", snapshot, rows: rows as unknown as JsonValue },
    environment: { name: "Creation-title Issue routing with balanced accuracy", version: snapshot }, ...intakeDatasets(rows, snapshot) };
  parseLoopConfig(programme);
  return programme;
}

/** Read a complete SDK inventory and creation histories through a caller-supplied backend reader, without Git. */
export async function buildIntakeLoopCorpus(client: PmClient, bounds: JsonValue, readHistory: (id: string) => string | Promise<string>): Promise<{ programme: JsonValue; snapshot: string; training_items: number; held_out_items: number; held_out_positive: number }> {
  const inventory = await identifierClient(client).listAllComplete({ includeBody: false });
  const items = await Promise.all(inventory.items.map(async (item) => projectIntakeHistory(await readHistory(item.id))));
  const programme = sealIntakeCorpus(items, bounds);
  const config = parseLoopConfig(programme);
  return { programme, snapshot: (config.corpus as Record<string, JsonValue>).snapshot as string, training_items: config.training.length,
    held_out_items: config.evaluation.length, held_out_positive: config.evaluation.filter((row) => row.balance!.label).length };
}
