/**
 * Orchestrate existing acceptance scripts: prepare native fixtures, generate documents, repack, then run all
 * six Node/Bun scenarios against the final archive. Sequential replay retains native timestamps so the
 * shipped receipt can certify that archive without a self-referential hash. Evaluation and refusal logic
 * stay in the acceptance scripts; this module joins their output and verifies final shipped bytes.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const [publicSource, sourceCommit, destination] = process.argv.slice(2);
assert.match(sourceCommit, /^[a-f0-9]{40}$/);
const out = resolve(destination), source = resolve(publicSource);
mkdirSync(out, { recursive: true });
const sequentialPath = "docs/sequential-evaluation-evidence.json", decisionPath = "docs/decision-evidence-validation.json", compatibilityPath = "docs/evaluation-compatibility-evidence.json";
const initialTexts = new Map([sequentialPath, decisionPath, compatibilityPath].map((file) => [file, readFileSync(file, "utf8")]));
/** Refuse concurrent evidence edits and retain peer bytes rather than overwriting them. */
function publish(file: string, value: object): void {
  const previous = initialTexts.get(file)!;
  assert.equal(readFileSync(file, "utf8"), previous, `evidence_write_conflict: ${file}`);
  const text = JSON.stringify(value, null, 2) + "\n";
  writeFileSync(file, text); initialTexts.set(file, text);
}
/** Run one acceptance process, retaining its complete local log and stopping on any failure. */
function run(runtime: string, script: string, args: string[], label: string): void {
  try {
    const log = execFileSync(runtime, [script, ...args], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
    writeFileSync(join(out, `${label}.log`), log);
  } catch (error) {
    throw new Error(`Acceptance failed: ${label}; stop without runtime changes.`, { cause: error });
  }
  console.log(`${label}: PASS`);
}
/** Build a fresh archive and verify every shipped file against the working tree. */
function pack(name: string): { archive: string; sha256: string; files: string[]; runtime: Map<string, Buffer> } {
  const directory = join(out, name); mkdirSync(directory);
  const result = JSON.parse(execFileSync("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", directory], { encoding: "utf8" })) as { filename: string; files: { path: string }[] }[];
  assert.equal(result.length, 1);
  const archive = join(directory, result[0].filename), extracted = join(directory, "unpacked"); mkdirSync(extracted);
  execFileSync("tar", ["-xzf", archive, "-C", extracted]);
  const files = result[0].files.map((file) => file.path), runtime = new Map<string, Buffer>();
  for (const file of files) {
    assert.ok(!file.startsWith("/") && !file.split("/").includes(".."));
    const bytes = readFileSync(join(extracted, "package", file)); assert.deepEqual(bytes, readFileSync(file), file);
    if (file.startsWith("dist/")) runtime.set(file, bytes);
  }
  return { archive, sha256: createHash("sha256").update(readFileSync(archive)).digest("hex"), files, runtime };
}
/** Decode generated acceptance JSON without manufacturing public replay values. */
function receipt(file: string): Record<string, unknown> { return JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>; }

execFileSync("npm", ["run", "build"], { stdio: "inherit" });
const prepared = pack("prepare"), publicReceipts = new Map<string, Record<string, unknown>>();
for (const runtime of ["node", "bun"]) {
  const output = join(out, `${runtime}-sequential.json`), fixture = join(out, `${runtime}-fixture.json`);
  run(runtime, "test/sequential-evaluation.acceptance.ts", [source, output, sourceCommit, prepared.archive, fixture], `${runtime}-prepare`);
  publicReceipts.set(runtime, receipt(output));
}
const nodePublic = publicReceipts.get("node")!, bunPublic = publicReceipts.get("bun")!;
for (const key of Object.keys(nodePublic).filter((key) => key !== "evidence_digest")) assert.deepEqual(bunPublic[key], nodePublic[key], `public runtime mismatch: ${key}`);
publish(sequentialPath, nodePublic);
const decision = JSON.parse(initialTexts.get(decisionPath)!) as Record<string, unknown>;
const compatibility = JSON.parse(initialTexts.get(compatibilityPath)!) as Record<string, unknown>;
const { evidence_digest: nodeRoot, ...publicMetrics } = nodePublic;
decision.public_metrics = publicMetrics;
decision.public_input_roots = { node: nodeRoot, bun: bunPublic.evidence_digest };
compatibility.public_node_and_bun = {
  recorded_in: [sequentialPath, decisionPath], source: nodePublic.source, commit: nodePublic.commit,
  snapshot: nodePublic.snapshot, source_digest: nodePublic.source_digest, comparison: nodePublic.comparison,
  items: nodePublic.items, done_role_items: nodePublic.done_role_items,
  evidence_digests: decision.public_input_roots,
  note: "One final public acceptance cohort; runtime-specific roots remain distinct and refer to the generated receipts."
};
publish(decisionPath, decision); publish(compatibilityPath, compatibility);
const final = pack("final"); assert.deepEqual(final.runtime, prepared.runtime, "Final archive changed runtime bytes");
assert.ok(!final.files.includes(decisionPath) && !final.files.includes(compatibilityPath), "Archive digest receipts must remain outside the archive they identify");
const packed = new Map<string, Record<string, unknown>>();
for (const runtime of ["node", "bun"]) {
  for (const [kind, script] of [["compatibility", "test/evaluation-compatibility.acceptance.ts"], ["decision", "test/decision-evidence.acceptance.ts"]]) {
    const output = join(out, `${runtime}-${kind}.json`);
    run(runtime, script, [final.archive, output], `${runtime}-${kind}`); packed.set(`${runtime}-${kind}`, receipt(output));
  }
  const output = join(out, `${runtime}-sequential.json`);
  run(runtime, "test/sequential-evaluation.acceptance.ts", [source, output, sourceCommit, final.archive, join(out, `${runtime}-fixture.json`), "replay"], `${runtime}-sequential`);
  assert.deepEqual(receipt(output), publicReceipts.get(runtime));
}
assert.deepEqual(packed.get("node-compatibility"), packed.get("bun-compatibility"));
decision.node = packed.get("node-decision"); decision.bun = packed.get("bun-decision");
decision.published_native_node = packed.get("node-compatibility"); decision.published_native_bun = packed.get("bun-compatibility");
compatibility.packed_node_and_bun = packed.get("node-compatibility");
const artifact = { runtime_source_commit: execFileSync("git", ["log", "-1", "--format=%H", "--", ":(top,glob)*.ts"], { encoding: "utf8" }).trim(), public_source_commit: sourceCommit, archive_sha256: final.sha256, shipped_files: final.files.length, runtime_files: final.runtime.size, final_acceptance_passes: 6, native_fixture_preparations: 2, public_source_read_only_and_unchanged: true, native_fixture_replayed_after_evidence_repack: true };
decision.current_packed_acceptance = artifact; compatibility.current_packed_acceptance = artifact;
decision.historical_receipts_note = "source_commit, earlier static/property counters and immutable_execution_round_6 describe historical runs. Current Node/Bun public replay and packed acceptance are public_metrics, public_input_roots and current_packed_acceptance; no historical archive is the current artifact.";
compatibility.historical_receipts_note = "implementation, earlier native/boundary regression counters and release_ci describe historical runs. Current packed/public results are packed_node_and_bun, public_node_and_bun and current_packed_acceptance.";
publish(decisionPath, decision); publish(compatibilityPath, compatibility);
for (const file of final.files) assert.deepEqual(readFileSync(join(out, "final", "unpacked", "package", file)), readFileSync(file), `Final shipped bytes changed: ${file}`);
writeFileSync(join(out, "receipt.json"), JSON.stringify({ ...artifact, archive: final.archive }, null, 2) + "\n");
console.log(JSON.stringify(artifact));
