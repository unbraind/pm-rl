/** Public, commit-pinned tracker histories projected to a small redistributable lifecycle task. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { hashJson, type JsonValue } from "./index.ts";
import { calibratePrefixTarget, prefixInnerExample, projectHistoryPrefix, validateHistoryPrefix, validateLifecyclePrefix, type HistoryPrefix, type PrefixProjection, type TargetDistribution } from "./prefix-data.ts";

/** Repository isolation roles; inner held-out items come only from the training repositories. */
export const TRACKER_SPLITS = ["train", "inner-held-out", "meta-validation", "final-test"] as const;
/** One sealed dataset compartment. */
export type TrackerSplit = typeof TRACKER_SPLITS[number];
/** A prefix contains only normalized lifecycle states, never titles, comments, identities or free text. */
export interface TrackerExample {
  readonly id: string;
  readonly repo: string;
  readonly commit: string;
  readonly prefix: readonly string[];
  readonly label: "completed" | "cancelled" | "fast" | "slow";
  readonly history?: HistoryPrefix;
}
/** Snapshot manifest binds split content, repository roles and source license declarations. */
export interface TrackerDataset {
  readonly format: "pm-rl/tracker-dataset/1";
  readonly task: "terminal-disposition" | "history-prefix";
  readonly calibration?: { readonly threshold_ms: number; readonly candidates: readonly TargetDistribution[] };
  readonly seed: number;
  readonly omitted_sources: readonly { readonly repo: string; readonly commit: string; readonly reason: "no_prefixed_terminal_transition" }[];
  readonly sources: readonly { readonly repo: string; readonly commit: string; readonly license: "MIT"; readonly role: "train" | "meta-validation" | "final-test" }[];
  readonly splits: Readonly<Record<TrackerSplit, { readonly digest: string; readonly count: number }>>;
  readonly digest: string;
}

/** Invoke bounded read-only Git/GitHub operations without shell evaluation of tracker content. */
function sourceCommand(command: string, args: string[], cwd: string): string {
  return execFileSync(command, args, { cwd, encoding: "utf8", timeout: 30_000, maxBuffer: 8 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/** Read selected committed blobs in one bounded Git process, preserving byte lengths for Unicode history. */
function historyBlobs(root: string, commit: string, paths: readonly string[]): string[] {
  const bytes = execFileSync("git", ["cat-file", "--batch"], { cwd: root, input: paths.map((path) => `${commit}:${path}\n`).join(""),
    timeout: 30_000, maxBuffer: 64 * 1024 * 1024, stdio: ["pipe", "pipe", "pipe"] });
  let offset = 0;
  return paths.map(() => {
    const end = bytes.indexOf(10, offset);
    const header = bytes.subarray(offset, end).toString("ascii");
    assert.match(header, /^[a-f0-9]{40} blob \d+$/, "dataset_history_blob");
    const length = Number(header.slice(header.lastIndexOf(" ") + 1));
    assert.ok(length <= 8 * 1024 * 1024, "dataset_history_bytes");
    offset = end + 1 + length + 1;
    return bytes.subarray(end + 1, offset - 1).toString("utf8");
  });
}

/** Extract the first terminal outcome from append-only history, excluding that outcome from its prefix. */
export function trackerHistoryExample(history: string, repo: string, commit: string, item: string): TrackerExample | null {
  const prefix: string[] = [];
  for (const line of history.split("\n").filter(Boolean)) {
    const event = JSON.parse(line) as { patch?: readonly { path: string; value?: unknown; op?: string }[] };
    for (const patch of event.patch ?? []) {
      if (patch.path !== "/metadata/status" || patch.op === "remove") continue;
      const status = String(patch.value);
      if (["closed", "canceled", "cancelled"].includes(status)) {
        if (prefix.length === 0) return null; // Imported terminal snapshots carry no predictive prefix.
        return { id: hashJson({ repo, item }), repo, commit, prefix,
          label: status === "closed" ? "completed" : "cancelled" };
      }
      validateLifecyclePrefix([status]);
      prefix.push(status);
    }
  }
  return null;
}

/** Explicit task and sealed public commit pins; default builds preserve the original environment. */
export interface TrackerBuildOptions {
  readonly task?: "terminal-disposition" | "history-prefix";
  readonly pins?: readonly { readonly repo: string; readonly commit: string; readonly role: "train" | "meta-validation" | "final-test" }[];
}

/** Build only from committed public MIT tracker histories; explicitly deny hosted and excluded repositories. */
export function buildTrackerDataset(directories: readonly string[], output: string, seed = 42, options: TrackerBuildOptions = {}): TrackerDataset {
  assert.ok(directories.length >= 3 && directories.length <= 64 && Number.isInteger(seed) && seed >= 0 && seed <= 0xffff_ffff, "dataset_bounds");
  assert.ok(options.task === undefined || ["terminal-disposition", "history-prefix"].includes(options.task), "dataset_task");
  const inspected = directories.map((directory) => {
    const path = realpathSync(directory);
    assert.ok(!path.split("/").some((part) => ["pm-hosted-data", "pm-web", "pm-gpt"].includes(part)), "dataset_forbidden_source");
    const root = dirname(dirname(path));
    assert.equal(path, join(root, ".agents", "pm"), "dataset_tracker_directory");
    const remote = sourceCommand("git", ["remote", "get-url", "origin"], root);
    const match = /^(?:https:\/\/github\.com\/|git@github\.com:)([\w-]+\/pm-[\w-]+?)(?:\.git)?$/.exec(remote);
    assert.ok(match !== null, "dataset_github_source");
    const repo = match[1];
    assert.ok(!["pm-web", "pm-gpt", "pm-cli"].includes(repo.split("/")[1].toLowerCase()), "dataset_excluded_repo");
    const metadata = JSON.parse(sourceCommand("gh", ["repo", "view", repo, "--json", "visibility,licenseInfo,nameWithOwner"], root)) as { visibility: string; licenseInfo: { key: string } | null; nameWithOwner: string };
    assert.ok(metadata.visibility === "PUBLIC" && metadata.licenseInfo?.key === "mit" && metadata.nameWithOwner.toLowerCase() === repo.toLowerCase(), "dataset_public_mit_required");
    const pin = options.pins?.find((source) => source.repo === repo);
    assert.ok(options.pins === undefined || pin !== undefined, "dataset_pin_missing");
    const commit = pin?.commit ?? sourceCommand("git", ["rev-parse", "HEAD"], root);
    assert.match(commit, /^[a-f0-9]{40}$/, "dataset_commit");
    assert.equal(sourceCommand("gh", ["api", `repos/${repo}/commits/${commit}`, "--jq", ".sha"], root), commit, "dataset_public_commit_required");
    const paths = sourceCommand("git", ["ls-tree", "-r", "--name-only", commit, "--", ".agents/pm/history"], root).split("\n");
    assert.ok(paths.length <= 10_000, "dataset_history_limit");
    const examples: TrackerExample[] = [];
    const projections: PrefixProjection[] = [];
    const selected = paths.filter((name) => /^\.agents\/pm\/history\/[\w.-]+\.jsonl$/.test(name));
    const histories = historyBlobs(root, commit, selected);
    for (const [index, file] of selected.entries()) {
      const projection = options.task === "history-prefix" ? projectHistoryPrefix(histories[index], repo, commit, file, seed) : null;
      if (projection !== null) projections.push(projection);
      const example = options.task === "history-prefix" ? projection?.example ?? null : trackerHistoryExample(histories[index], repo, commit, file);
      if (example !== null) examples.push(example);
    }
    return { repo, commit, examples, projections, role: pin?.role };
  });
  assert.equal(new Set(inspected.map((source) => source.repo.toLowerCase())).size, inspected.length, "dataset_duplicate_repo");
  const snapshots = inspected.filter((source) => source.examples.length > 0);
  const omitted_sources = inspected.filter((source) => source.examples.length === 0).map((source) => ({ repo: source.repo, commit: source.commit, reason: "no_prefixed_terminal_transition" as const }));
  assert.ok(snapshots.length >= 3, "dataset_eligible_sources");
  snapshots.sort((a, b) => hashJson({ repo: a.repo, seed }).localeCompare(hashJson({ repo: b.repo, seed })));
  const data: Record<TrackerSplit, TrackerExample[]> = { train: [], "inner-held-out": [], "meta-validation": [], "final-test": [] };
  const trainCount = Math.max(1, Math.floor(snapshots.length * 0.6));
  const validationEnd = Math.max(trainCount + 1, Math.floor(snapshots.length * 0.8));
  // Identical observable prefixes stay together, even across training repositories. This also preserves
  // the process adapter's stricter refusal of duplicate feature/reward content across its inner split.
  const groups = [...new Set(snapshots.slice(0, trainCount).flatMap((source) => source.examples.map((example) => hashJson([...example.prefix]))))].sort();
  const innerGroups = new Set(groups.filter((_group, index) => index % 5 === 0));
  const calibration = options.task === "history-prefix" ? calibratePrefixTarget(snapshots.flatMap((source, index) => (source.role ?? (index < trainCount ? "train" : "other")) === "train" ? source.projections.filter((row) => !prefixInnerExample(row.example.id)) : [])) : undefined;
  const sources = snapshots.map((source, index) => {
    const role: "train" | "meta-validation" | "final-test" = source.role ?? (index < trainCount ? "train" : index < validationEnd ? "meta-validation" : "final-test");
    for (const [index, original] of source.examples.entries()) {
      const example = calibration === undefined ? original : { ...original, label: source.projections[index].remaining_ms <= calibration.threshold_ms ? "fast" as const : "slow" as const };
      const inner = calibration === undefined ? innerGroups.has(hashJson([...example.prefix])) : prefixInnerExample(example.id);
      const split = role === "train" && inner ? "inner-held-out" : role;
      data[split].push(example);
    }
    return { repo: source.repo, commit: source.commit, license: "MIT" as const, role };
  });
  const splits = {} as Record<TrackerSplit, { digest: string; count: number }>;
  for (const split of TRACKER_SPLITS) {
    const examples = data[split].sort((a, b) => a.id.localeCompare(b.id));
    assert.ok(examples.length > 0 && examples.length <= 10_000, "dataset_split_size");
    splits[split] = { digest: hashJson(examples as unknown as JsonValue), count: examples.length };
  }
  const record = { format: "pm-rl/tracker-dataset/1" as const, task: options.task ?? "terminal-disposition", seed, sources, omitted_sources, splits, ...(calibration === undefined ? {} : { calibration }) };
  const manifest = { ...record, digest: hashJson(record as unknown as JsonValue) };
  mkdirSync(output, { recursive: true });
  for (const split of TRACKER_SPLITS) writeFileSync(join(output, `${split}.json`), JSON.stringify(data[split]), { flag: "wx" });
  writeFileSync(join(output, "dataset.json"), JSON.stringify(manifest, null, 2), { flag: "wx" });
  return manifest;
}

/** Verify a dataset manifest without opening held-out or final-test compartments. */
export function readTrackerDataset(directory: string): TrackerDataset {
  const { digest, ...record } = JSON.parse(readFileSync(join(directory, "dataset.json"), "utf8")) as TrackerDataset;
  assert.equal(hashJson(record as unknown as JsonValue), digest, "dataset_manifest_identity");
  assert.ok(record.format === "pm-rl/tracker-dataset/1" && ["terminal-disposition", "history-prefix"].includes(record.task), "dataset_format");
  assert.equal(new Set(record.sources.map((source) => source.repo)).size, record.sources.length, "dataset_duplicate_repo");
  return { ...record, digest };
}

/** Open exactly one compartment, verifying content identity, provenance, bounds and repository isolation. */
export function readTrackerSplit(directory: string, manifest: TrackerDataset, split: TrackerSplit): readonly TrackerExample[] {
  const examples = JSON.parse(readFileSync(resolve(directory, `${split}.json`), "utf8")) as TrackerExample[];
  const spec = manifest.splits[split];
  assert.equal(hashJson(examples as unknown as JsonValue), spec.digest, "dataset_split_identity");
  assert.ok(examples.length > 0 && examples.length <= 10_000 && examples.length === spec.count, "dataset_split_size");
  assert.equal(new Set(examples.map((example) => example.id)).size, examples.length, "dataset_duplicate_example");
  for (const example of examples) {
    const source = manifest.sources.find((entry) => entry.repo === example.repo);
    const role = split === "inner-held-out" ? "train" : split;
    assert.ok(source !== undefined && source.role === role && source.commit === example.commit && source.license === "MIT", "dataset_repo_leakage");
    assert.ok((manifest.task === "history-prefix" ? ["fast", "slow"] : ["completed", "cancelled"]).includes(example.label), "dataset_label");
    if (manifest.task === "history-prefix") validateHistoryPrefix(example.history!);
    assert.ok(validateLifecyclePrefix(example.prefix), "dataset_prefix");
  }
  return examples;
}

/** A bounded prefix signature with blocked-state sign; neither labels nor repository identity enter the feature. */
export function trackerFeature(example: TrackerExample): number {
  const signature = Number.parseInt(hashJson([...example.prefix]).slice(0, 12), 16) / 0x1000000000000;
  return (0.25 + signature / 4) * (example.prefix.at(-1) === "blocked" ? -1 : 1);
}
