/** Synthetic chronological projections shared by native SDK transfer regressions. */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { hashJson, type JsonValue } from "../../json-identity.ts";
import { IMPROVER_ROLES, type ImproverTask } from "../../improver-data.ts";
import { TRANSFER_DESIGN, type TransferCorpus } from "../../proposer-transfer.ts";
/** Eight real-format chronological rows carry no raw text, authors or machine coordinates. */
export function transferTask(role: string, index: number, target: ImproverTask["target"]): ImproverTask {
  const rows = Array.from({ length: 8 }, (_, n) => ({ id: `${role}-${index}-${n}`, prediction_at: n, available_at: n, label: n % 2 as 0 | 1, prefix: { events: ["create"], fields: [], words: [n % 2], authors: 1, elapsed_ms: 0 } }));
  return { id: `${role}-${index}-${target}`, repo: `public-fixture/${role}-${index}`, commit: "a".repeat(40), target, cutoff: 4, threshold_ms: target === "issue-type" ? null : 10, train: rows.slice(0, 4), evaluation: rows.slice(4) };
}
/** Use the released dataset envelope so old persisted input remains a supported positive control. */
export function transferCorpus(counts: number | Readonly<Record<typeof IMPROVER_ROLES[number], number>> = 1): TransferCorpus {
  const tasks = Object.fromEntries(IMPROVER_ROLES.map((role) => [role, Array.from({ length: typeof counts === "number" ? counts : counts[role] }, (_, index) => TRANSFER_DESIGN.targets.map((target) => transferTask(role, index, target))).flat()])) as unknown as TransferCorpus["tasks"];
  const record = { format: "pm-rl/improver-dataset/1" as const, seed: 42, sources: IMPROVER_ROLES.flatMap((role) => Array.from({ length: typeof counts === "number" ? counts : counts[role] }, (_, index) => ({ repo: `public-fixture/${role}-${index}`, commit: "a".repeat(40), role }))), splits: Object.fromEntries(IMPROVER_ROLES.map((role) => [role, { tasks: tasks[role].length, digest: hashJson(tasks[role] as unknown as JsonValue) }])) as TransferCorpus["manifest"]["splits"], omitted: [] };
  return { tasks, manifest: { ...record, digest: hashJson(record as unknown as JsonValue) } };
}
/** Rehash deliberate invalid fixtures so structural protection, rather than a stale outer hash, must detect them. */
export function sealTransferCorpus(value: TransferCorpus): TransferCorpus {
  const { digest: _, ...old } = value.manifest;
  const record = { ...old, splits: Object.fromEntries(IMPROVER_ROLES.map((role) => [role, { tasks: value.tasks[role].length, digest: hashJson(value.tasks[role] as unknown as JsonValue) }])) as TransferCorpus["manifest"]["splits"] };
  return { ...value, manifest: { ...record, digest: hashJson(record as unknown as JsonValue) } };
}
/** Persist only synthetic projected input files needed to enter the existing full controller path. */
export function writeTransferDataset(root: string, value: TransferCorpus): string {
  const directory = join(root, "dataset"); mkdirSync(directory);
  for (const role of IMPROVER_ROLES) writeFileSync(join(directory, `${role}.json`), JSON.stringify(value.tasks[role]));
  writeFileSync(join(directory, "improver-dataset.json"), JSON.stringify(value.manifest)); return directory;
}

