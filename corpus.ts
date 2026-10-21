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
  if (record["format"] !== "pm-rl/tracker-loop-corpus/1" || !Array.isArray(record["rows"])) corpusRefusal("corpus_invalid_seal");
  const rows = record["rows"] as CorpusRow[];
  if (rows.length > 10_000 || rows.some((row) => row === null || typeof row !== "object" || !/^[a-f0-9]{64}$/.test(row.item) || !/^[a-f0-9]{64}$/.test(row.content) || !Number.isInteger(row.length) || row.length < 1 || row.length > 256 || typeof row.closed !== "boolean")) corpusRefusal("corpus_invalid_seal");
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
    id: hashJson({ snapshot, item: row.item }), feature: Math.log1p(row.length) / Math.log(257), rewards: row.closed ? [0, 1] : [1, 0],
  }));
  return { training: examples(false), evaluation: examples(true) };
}

/** Seal projected input groups together so identical inputs cannot cross the held-out boundary. */
export function sealTrackerLoopCorpus(items: readonly Pick<ItemMetadata, "id" | "title" | "status">[], bounds: JsonValue): TrackerLoopCorpus {
  if (bounds === null || typeof bounds !== "object" || Array.isArray(bounds)) corpusRefusal("corpus_invalid_bounds");
  if (["training", "evaluation", "environment", "corpus"].some((key) => Object.hasOwn(bounds, key))) corpusRefusal("corpus_external_datasets");
  if (items.length > 10_000) corpusRefusal("corpus_item_limit");
  const seen = new Set<string>();
  const rows = items.map((item): CorpusRow => {
    if (typeof item.id !== "string" || typeof item.title !== "string" || typeof item.status !== "string") corpusRefusal("corpus_invalid_item");
    const title = item.title.normalize("NFKC").trim().replaceAll(/\s+/g, " ").toLowerCase();
    if (!item.id.trim() || !title || !item.status.trim()) corpusRefusal("corpus_invalid_item");
    if (seen.has(item.id)) corpusRefusal("corpus_duplicate_item");
    seen.add(item.id);
    return { item: hashJson(item.id), content: hashJson({ title, status: item.status }), length: Math.min(256, [...title].length), closed: item.status === "closed" };
  }).sort((left, right) => left.item.localeCompare(right.item));
  const snapshot = hashJson(rows as unknown as JsonValue);
  const { training, evaluation } = corpusDatasets(rows, snapshot);
  if (training.length < 2 || evaluation.length < 2) corpusRefusal("corpus_insufficient_split");
  const programme: JsonValue = { ...bounds, corpus: { format: "pm-rl/tracker-loop-corpus/1", snapshot, rows: rows as unknown as JsonValue },
    environment: { name: "Tracker snapshot closed-status recognition", version: snapshot }, training, evaluation };
  parseLoopConfig(programme);
  return { programme, snapshot, rows, training_items: training.length, held_out_items: evaluation.length,
    held_out_closed: rows.filter((row) => corpusHeldOut(row.length) && row.closed).length };
}

/** Read a certified complete local SDK inventory without executing extensions, Git, or source mutations. */
export async function buildTrackerLoopCorpus(client: PmClient, bounds: JsonValue): Promise<TrackerLoopCorpus> {
  const inventory = await client.listAllComplete({ includeBody: false });
  return sealTrackerLoopCorpus(inventory.items, bounds);
}
