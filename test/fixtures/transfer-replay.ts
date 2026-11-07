/** Rebuild the compact public diagnostic receipt into an explicitly isolated native tracker. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { PmClient } from "@unbrained/pm-cli/sdk/core";
import { init } from "@unbrained/pm-cli/sdk/runtime";
import { hashJson, type JsonValue } from "../../json-identity.ts";
import { buildImproverDataset, IMPROVER_ROLES, readImproverTasks, type ImproverDataset } from "../../improver-data.ts";
import { archiveTransferCorpus, evaluateTransfer, parseTransferDesign, planTransferArchive, recordTransferEvaluation, recordTransferPlan, replayTransferEvaluation, verifyTransferCorpus, type TransferCorpus, type TransferDesign, type TransferPair, type TransferReport } from "../../proposer-transfer.ts";
import { copyImproverSources } from "../../scripts/live-improver.ts";
import { isMainInvocation } from "../../scripts/script-launcher.ts";
import { excludedTrackerName, verifyPublicTrackerSource } from "../../dataset.ts";
import { parseBoundedJson } from "../../tracker-record.ts";

/** Digests pin native reconstruction while scores remain the original historical measurements. */
export interface DiagnosticReceipt {
  readonly format: "pm-rl/proposer-diagnostic-receipt/1";
  readonly digest: string;
  readonly provenance?: { readonly kind: "historical-paired-measurement-replay"; readonly measurement_commit: string; readonly historical_native_root: string; readonly plan_note: string };
  readonly run?: { readonly generations: number; readonly controller_ms: number; readonly elapsed_ms: number; readonly fits: number; readonly optimizer_updates: number; readonly proposal_processes: number; readonly inference_tokens: number; readonly promotions: number; readonly retained: string; readonly decision: string };
  readonly replay_command?: string;
  readonly full_manifest: ImproverDataset;
  readonly manifest: ImproverDataset;
  readonly task_ids: Readonly<Record<typeof IMPROVER_ROLES[number], readonly string[]>>;
  readonly archive: { readonly root: string; readonly shards: readonly string[]; readonly plan: string };
  readonly design: TransferDesign;
  readonly evaluations: readonly { readonly historical_digest?: string; readonly digest: string; readonly role: "meta" | "audit"; readonly look: number; readonly pairs: readonly TransferPair[]; readonly report: TransferReport }[];
}

/** Resolve existing ancestors so symlinks cannot redirect a scratch output into a Git worktree. */
export function requireDiagnosticScratch(pmRoot: string): string {
  const requested = resolve(pmRoot); let parent = requested;
  while (!existsSync(parent)) parent = dirname(parent);
  const physical = resolve(realpathSync(parent), relative(parent, requested));
  for (let cursor = physical; ; cursor = dirname(cursor)) {
    assert.ok(!existsSync(join(cursor, ".git")), "diagnostic_requires_non_git_scratch_tracker");
    if (cursor === dirname(cursor)) break;
  }
  assert.ok(isAbsolute(physical)); return physical;
}

/** A decoded record must be an object before any property access or nested iteration. */
function receiptObject(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
/** Check only structural prerequisites here; content digests and statistical validation remain authoritative. */
function receiptManifest(value: unknown): boolean {
  if (!receiptObject(value) || !Array.isArray(value.sources) || !Array.isArray(value.omitted) || !receiptObject(value.splits)) return false;
  const splits = value.splits;
  return typeof value.digest === "string" && Number.isSafeInteger(value.seed) && value.sources.every((source: unknown) => receiptObject(source) && typeof source.repo === "string" && typeof source.commit === "string" && typeof source.role === "string" && IMPROVER_ROLES.includes(source.role as typeof IMPROVER_ROLES[number]))
    && value.omitted.every((row: unknown) => receiptObject(row) && typeof row.repo === "string" && typeof row.target === "string")
    && IMPROVER_ROLES.every((role) => receiptObject(splits[role]) && typeof splits[role].digest === "string" && Number.isSafeInteger(splits[role].tasks));
}
/** Refuse malformed user-supplied receipt structures before replay opens sources or writes scratch context. */
function diagnosticReceiptShape(value: unknown): asserts value is DiagnosticReceipt {
  assert.ok(receiptObject(value), "diagnostic_receipt_shape");
  assert.ok(typeof value.digest === "string" && receiptManifest(value.full_manifest) && receiptManifest(value.manifest) && receiptObject(value.design) && receiptObject(value.task_ids) && receiptObject(value.archive) && Array.isArray(value.evaluations), "diagnostic_receipt_shape");
  const archive = value.archive; const ids = value.task_ids;
  assert.ok(receiptObject(archive) && typeof archive.root === "string" && typeof archive.plan === "string" && Array.isArray(archive.shards) && archive.shards.every((digest: unknown) => typeof digest === "string"), "diagnostic_receipt_shape");
  assert.ok(receiptObject(ids) && IMPROVER_ROLES.every((role) => Array.isArray(ids[role]) && ids[role].every((id: unknown) => typeof id === "string")), "diagnostic_receipt_shape");
  assert.ok(value.evaluations.every((row: unknown) => receiptObject(row) && typeof row.digest === "string" && typeof row.role === "string" && ["meta", "audit"].includes(row.role) && Number.isSafeInteger(row.look) && Array.isArray(row.pairs) && row.pairs.every((pair: unknown) => receiptObject(pair) && typeof pair.id === "string" && typeof pair.candidate === "number" && typeof pair.incumbent === "number") && receiptObject(row.report)), "diagnostic_receipt_shape");
}

/** Authenticate every receipt field before using its public source declarations or scores. */
export function readDiagnosticReceipt(file: string): DiagnosticReceipt {
  const value: unknown = parseBoundedJson(readFileSync(file, "utf8"));
  diagnosticReceiptShape(value);
  const { digest, ...record } = value;
  assert.equal(value.format, "pm-rl/proposer-diagnostic-receipt/1");
  assert.equal(hashJson(record as unknown as JsonValue), digest, "diagnostic_receipt_digest");
  parseTransferDesign(value.design);
  for (const source of value.full_manifest.sources) {
    assert.match(source.repo, /^[\w-]+\/pm-[\w-]+$/); assert.match(source.commit, /^[a-f0-9]{40}$/);
    assert.ok(!excludedTrackerName(source.repo.split("/")[1]), "diagnostic_private_source");
  }
  return value;
}

/** Fetch only public pinned snapshots into scratch; optional fleet mirrors are read-only clone sources. */
export function rebuildDiagnosticCorpus(receipt: DiagnosticReceipt, scratch: string, fleet?: string): TransferCorpus {
  const sources = receipt.full_manifest.sources;
  const copies = join(scratch, "sources");
  let directories: string[];
  if (fleet !== undefined) directories = copyImproverSources(fleet, copies, sources);
  else {
    for (const source of sources) verifyPublicTrackerSource(source.repo, source.commit, process.cwd());
    mkdirSync(copies, { recursive: true });
    directories = sources.map((source) => {
      const copy = join(copies, source.repo.split("/")[1]);
      execFileSync("git", ["clone", "--quiet", "--filter=blob:none", "--no-checkout", `https://github.com/${source.repo}.git`, copy], { timeout: 120_000, stdio: "pipe" });
      execFileSync("git", ["fetch", "--quiet", "--depth=1", "origin", source.commit], { cwd: copy, timeout: 120_000, stdio: "pipe" });
      execFileSync("git", ["checkout", "--quiet", source.commit, "--", ".agents/pm"], { cwd: copy, timeout: 60_000, stdio: "pipe" });
      return join(copy, ".agents/pm");
    });
  }
  const dataset = join(scratch, "dataset");
  // Original build visited directories by repository name; omission order is part of its digest.
  directories.sort();
  const manifest = buildImproverDataset(directories, dataset, receipt.full_manifest.seed, { pins: sources.map((source) => ({ ...source, role: source.role === "development" ? "train" : source.role === "meta" ? "meta-validation" : "final-test" })) });
  assert.deepEqual(manifest, receipt.full_manifest, "diagnostic_full_corpus_drift");
  const tasks = Object.fromEntries(IMPROVER_ROLES.map((role) => [role, readImproverTasks(dataset, manifest, role).filter((task) => receipt.task_ids[role].includes(task.id))])) as unknown as TransferCorpus["tasks"];
  const corpus = { manifest: receipt.manifest, tasks }; verifyTransferCorpus(corpus);
  return corpus;
}

/** Recompute reports before writes, then verify native root, shard, plan and evaluation addresses. */
export async function restoreDiagnosticReceipt(client: PmClient, receipt: DiagnosticReceipt, corpus: TransferCorpus): Promise<readonly string[]> {
  assert.deepEqual(corpus.manifest, receipt.manifest, "diagnostic_manifest_drift");
  const planned = planTransferArchive(corpus);
  assert.deepEqual(planned.root.shards, receipt.archive.shards, "diagnostic_shard_drift");
  assert.equal(hashJson(planned.root as unknown as JsonValue), receipt.archive.root, "diagnostic_root_drift");
  assert.equal(hashJson({ format: "pm-rl/proposer-transfer-plan/2", corpus: corpus.manifest.digest, design: receipt.design } as unknown as JsonValue), receipt.archive.plan, "diagnostic_plan_drift");
  for (const row of receipt.evaluations) {
    const report = evaluateTransfer(corpus, row.role, row.pairs, receipt.design, row.look);
    assert.deepEqual(report, row.report, "diagnostic_measurement_drift");
    assert.equal(hashJson({ format: "pm-rl/proposer-transfer-evaluation/2", corpus: receipt.archive.root, plan: receipt.archive.plan, role: row.role, look: row.look, pairs: row.pairs, report } as unknown as JsonValue), row.digest, "diagnostic_evaluation_drift");
  }
  const root = await archiveTransferCorpus(client, corpus);
  const plan = await recordTransferPlan(client, corpus.manifest.digest, receipt.design);
  const evaluations: string[] = [];
  for (const row of receipt.evaluations) {
    const measured = await recordTransferEvaluation(client, root, row.role, row.pairs, plan, row.look);
    assert.equal(measured.digest, row.digest, "diagnostic_evaluation_drift");
    assert.deepEqual(await replayTransferEvaluation(client, measured.digest), row.report);
    evaluations.push(measured.digest);
  }
  return evaluations;
}

/** A fresh explicit non-Git root is mandatory; this entry point never discovers the package tracker. */
export async function replayDiagnosticMain(argv: readonly string[]): Promise<void> {
  const options = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index]; const value = argv[index + 1];
    assert.ok(["--receipt", "--pm-root", "--fleet"].includes(key) && value !== undefined && !options.has(key), "diagnostic_arguments");
    options.set(key, value);
  }
  assert.ok(options.has("--pm-root"), "diagnostic_explicit_pm_root_required");
  const pmRoot = requireDiagnosticScratch(options.get("--pm-root")!);
  assert.ok(basename(pmRoot) === "pm" && basename(dirname(pmRoot)) === ".agents", "diagnostic_scratch_layout");
  const receipt = readDiagnosticReceipt(options.get("--receipt") ?? "docs/proposer-transfer-receipt.json");
  const project = dirname(dirname(pmRoot));
  const corpus = rebuildDiagnosticCorpus(receipt, project, options.get("--fleet"));
  const initialized = await init("diagnostic", { defaults: true, agentGuidance: "skip", author: "codex-sol" }, { cwd: project, pmRoot });
  const client = new PmClient({ cwd: project, pmRoot: initialized.path, noExtensions: true, author: "codex-sol" });
  const evaluations = await restoreDiagnosticReceipt(client, receipt, corpus);
  console.log(JSON.stringify({ receipt: receipt.digest, corpus: corpus.manifest.digest, archive: receipt.archive, evaluations, native_replay: true, new_fits: 0 }));
}

if (isMainInvocation(process.argv, import.meta.url)) await replayDiagnosticMain(process.argv.slice(2));
