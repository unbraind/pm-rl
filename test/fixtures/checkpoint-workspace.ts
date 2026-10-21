/** Real plain-directory trackers and sealed synthetic tasks for checkpoint acceptance. */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after } from "node:test";
import { PmClient } from "@unbrained/pm-cli/sdk/core";
import { init } from "@unbrained/pm-cli/sdk/runtime";
import { hashJson, type JsonValue } from "../../index.ts";
import { IMPROVER_ROLES, type ImproverDataset, type ImproverRow, type ImproverTask } from "../../improver-data.ts";
import { initialImprover, improverArtifact } from "../../improver.ts";
import { improverConfiguration } from "../../recursive-improver.ts";

const roots: string[] = [];
after(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });
/** Initialize through the real SDK and give every fit an explicit expanded storage approval. */
export async function checkpointWorkspace() {
  const root = mkdtempSync(join(tmpdir(), "rl-checkpoint-")); roots.push(root);
  const { path: pmRoot } = await init("rl", { defaults: true, agentGuidance: "skip", author: "checkpoint-test" }, { cwd: root, pmRoot: join(root, ".agents/pm") });
  const coordinates = { pmRoot, author: "checkpoint-test" };
  const client = new PmClient({ ...coordinates, cwd: root, noExtensions: true });
  const approval = (await client.create({ id: "approval", type: "Decision", title: "Synthetic artifact storage and fixed compute approval", body: '```json\n' + JSON.stringify({ permitted_promotions: 100, resource_budget: { training_steps: 100, wall_ms: 3_000_000, compute_units: 3_000_000, storage_bytes: 104_857_600, tokens: 0 } }) + '\n```' })).item.id;
  const dataset = join(root, "dataset"); mkdirSync(dataset);
  /** Both labels have a known observable word signal, with independent chronological item identities. */
  const rows = (role: string, count: number, training: boolean): ImproverRow[] => Array.from({ length: count }, (_, index) => ({
    id: `${role}-${training ? "train" : "eval"}-${index}`, label: index % 2 as 0 | 1,
    prediction_at: training ? index : 10_000 + index, available_at: training ? index + 1 : 10_001 + index,
    prefix: { events: ["create"], fields: ["title"], words: index % 2 === 0 ? [100, 101, 102] : [200, 201, 202], authors: 1, elapsed_ms: 0 },
  }));
  const sources = IMPROVER_ROLES.map((role) => ({ repo: `public-fixture/${role}`, commit: "a".repeat(40), role }));
  const splits = Object.fromEntries(IMPROVER_ROLES.map((role) => {
    const tasks: ImproverTask[] = [{ id: `${role}-task`, repo: `public-fixture/${role}`, commit: "a".repeat(40), target: "issue-type", threshold_ms: null, cutoff: 10_000,
      train: rows(role, 64, true), evaluation: rows(role, 2000, false) }];
    writeFileSync(join(dataset, `${role}.json`), JSON.stringify(tasks));
    return [role, { digest: hashJson(tasks as unknown as JsonValue), tasks: 1 }];
  })) as ImproverDataset["splits"];
  const record = { format: "pm-rl/improver-dataset/1" as const, seed: 42, sources, splits, omitted: [] };
  const manifest = { ...record, digest: hashJson(record as unknown as JsonValue) };
  writeFileSync(join(dataset, "improver-dataset.json"), JSON.stringify(manifest));
  const { digest: _digest, ...initial } = initialImprover();
  const policy = improverArtifact({ ...initial, arms: initial.arms.slice(0, 2).map((arm) => ({ ...arm, config: { ...arm.config, learning_rate: arm.config.learning_rate, prefix: { ...arm.config.prefix, hashing_width: 4096 } } })) });
  const config = { ...improverConfiguration(), initial: policy, generations: 1, candidates: 1, updates: 256, timeout_ms: 900_000 };
  return { root, pmRoot, coordinates, client, approval, dataset, manifest, config };
}
