/** Behavioral reversions run only in a disposable copy and restore every changed function in finally. */
import assert from "node:assert/strict";
import { cpSync, existsSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { LEGACY_TRANSFER_ARCHIVE } from "./transfer-legacy.ts";
import { withTransferScratch } from "./transfer-scratch.ts";
import { isMainInvocation } from "../../scripts/script-launcher.ts";

/** Copy runnable source and its installed graph without requiring a Git object database. */
export function copyRevertWorkspace(root: string, scratch: string): void {
  for (const file of readdirSync(root).filter((file) => file.endsWith(".ts") || ["package.json", "README.md", "ARCHITECTURE.md"].includes(file))) cpSync(join(root, file), join(scratch, file));
  for (const directory of ["test", "dist", "examples", "scripts", "docs"].filter((name) => existsSync(join(root, name)))) cpSync(join(root, directory), join(scratch, directory), { recursive: true });
  symlinkSync(resolve(root, "node_modules"), join(scratch, "node_modules"), "dir");
}

/** Each probe restores its source before the disposable workspace is unconditionally removed. */
export async function runTransferReverts(root: string, selection?: string): Promise<void> {
  await withTransferScratch("transfer-revert-", async (scratch) => {
    const cases = [
      { file: "improver-data.ts", pattern: "powered role projections", test: "transfer-review-capacity", transform: (s: string) => s.replace('  const text = JSON.stringify(tasks);', '  return [{ name: `${role}.json`, text: encodeBoundedJson(tasks) }];\n  const text = JSON.stringify(tasks);'), expected: /json_record_limit/ },
      { file: "proposer-evolution.ts", pattern: "powered role projections", test: "transfer-review-capacity", transform: (s: string) => s.replace('...readdirSync(directory).filter((name) => /^(development|meta|audit)-[a-f0-9]{64}\\.json$/.test(name)).sort()', '...[]'), expected: /AssertionError/ },
      { file: "proposer-transfer.ts", pattern: "powered paired evaluations", test: "transfer-review-capacity", transform: (s: string) => s.replace('if (Buffer.byteLength(JSON.stringify(record)) <= MAX_TRACKER_RECORD_BYTES)', 'if (true)'), expected: /json_record_limit/ },
      { file: "proposer-evolution.ts", pattern: "empty planned meta looks", test: "transfer-review-capacity", transform: (s: string) => s.replace(/  for \(let look = 1; look <= config.generations; look \+= 1\) \{[\s\S]*?\n  \}\n(?=  const approval)/, ''), expected: /AssertionError/ },
      ...["README.md", "ARCHITECTURE.md", "docs/proposer-transfer.md"].map((file) => ({ file, pattern: "power documentation consistently", test: "transfer-review-capacity", transform: (s: string) => s.replace('per task at each look', 'per task'), expected: /AssertionError/ })),
      { file: "dataset.ts", pattern: "shared source exclusions", test: "transfer-review-policy", transform: (s: string) => s.replace('"pm-hosted-data", ', ''), expected: /AssertionError/ },
      { file: "dataset.ts", pattern: "shared source exclusions", test: "transfer-review-policy", transform: (s: string) => s.replace('(part !== "pm-cli" || index >= parts.length - 3)', 'true'), expected: /AssertionError/ },
      { file: "index.ts", pattern: "transfer replay CLI refuses", test: "transfer-review-policy", transform: (s: string) => s.replace('    if (!/^[a-f0-9]{64}$/.test(digest)) fail("Use a 64-character lowercase SHA-256 transfer evaluation digest.", "transfer_digest");', ''), expected: /AssertionError/ },
      { file: "proposer-evolution.ts", pattern: "missing prospective transfer plan", test: "transfer-review-policy", transform: (s: string) => s.replace('if (config.transfer === undefined) expectedFail("transfer_plan_required: Declare transfer.effect, transfer.alpha and transfer.power in a new programme before starting a run.", "transfer_plan_required");', 'assert.ok(config.transfer !== undefined, "transfer_plan_required");'), expected: /AssertionError/ },
      { file: "proposer-transfer.ts", pattern: "prospective transfer designs cannot relax", test: "transfer-review-policy", transform: (s: string) => s.replace('row.alpha <= TRANSFER_DESIGN.alpha', 'row.alpha < 1').replace('row.power >= TRANSFER_DESIGN.power', 'row.power > 0'), expected: /AssertionError/ },

      { file: "test/fixtures/transfer-reverts.ts", pattern: "behavioral revert runner works", test: "transfer-review", transform: (s: string) => s.replace(/^\s*assert\.ok\(selected\.length > 0, "transfer_revert_selection"\);$/m, ''), expected: /AssertionError/ },
      { file: "dataset.ts", pattern: "resolved private tracker aliases", test: "transfer-review", transform: (s: string) => s.replace('assert.ok(!forbidden(path), "dataset_forbidden_source");', 'assert.ok(true, "dataset_forbidden_source");'), expected: /AssertionError/ },
      { file: "proposer-evolution.ts", pattern: "malformed transfer declarations", test: "transfer-review", transform: (s: string) => s.replace(/  if \(row.transfer !== undefined\) \{[\s\S]*?\n  \}\n  const initial/, '  if (row.transfer !== undefined) {\n    assert.equal(Object.keys(row.transfer).sort().join(), "alpha,effect,power", "transfer_design");\n    parseTransferDesign({ ...row.transfer, margin: IMPROVER_CRITERION.effectThreshold, looks: row.generations + 1, targets: TRANSFER_DESIGN.targets });\n  }\n  const initial'), expected: /AssertionError/ },
      { file: "proposer-evolution.ts", pattern: "verified corpus cache", test: "transfer-review", transform: (s: string) => s.replace(/export function proposerCorpusReader[\s\S]*?(?=\/\*\* Translate approval)/, 'export function proposerCorpusReader(directory: string): () => TransferCorpus { return () => proposerDatasetRead(() => loadTransferCorpus(directory)); }\n'), expected: /AssertionError/ },
      { file: "test/fixtures/transfer-live.ts", pattern: "bounded live diagnostic", test: "transfer-review", transform: (s: string) => s.replace('assert.equal(eligible.length, 3, "diagnostic_bounded_trackers");', ''), expected: /AssertionError/ },
      { file: "test/fixtures/transfer-scratch.ts", pattern: "disposable transfer fixtures", test: "transfer-review", transform: (s: string) => s.replace('rmSync(scratch, { recursive: true, force: true });', ''), expected: /AssertionError/ },
      { file: "test/fixtures/transfer-reverts.ts", pattern: "behavioral revert runner works", test: "transfer-review", transform: (s: string) => s.replace('export async function runTransferReverts(root: string, selection?: string): Promise<void> {', 'export async function runTransferReverts(root: string, selection?: string): Promise<void> {\nassert.equal(spawnSync("git", ["show", "HEAD:proposer-transfer.ts"], { cwd: root, encoding: "utf8" }).status, 0);'), expected: /AssertionError/ },

      { file: "test/fixtures/transfer-replay.ts", pattern: "diagnostic replay requires", test: "transfer-receipt", transform: (s: string) => s.replace(/export function requireDiagnosticScratch[\s\S]*?(?=\/\*\* Authenticate)/, "export function requireDiagnosticScratch(pmRoot: string): string { return resolve(pmRoot); }\n"), expected: /AssertionError|Missing expected rejection/ },
      { file: "proposer-evolution.ts", pattern: "underpowered real non-git", test: "proposer-transfer", transform: (s: string) => s.slice(0, s.indexOf("export function requireProposerTransfer")) + "export function requireProposerTransfer(comparison: EvaluationPlanReport, transfer: TransferReport): EvaluationPlanReport { return comparison; }\n", expected: /AssertionError/ },
      ...["training tracker in held-out", "split digest mismatch"].map((pattern) => ({ file: "proposer-transfer.ts", pattern, test: "proposer-transfer", transform: (s: string) => s.replace(/export function verifyTransferCorpus[\s\S]*?(?=\/\*\* Open and verify)/, "export function verifyTransferCorpus(corpus: TransferCorpus, expected = corpus.manifest.digest): void {}\n"), expected: /AssertionError|Missing expected rejection/ })),
      { file: "proposer-transfer.ts", pattern: "minimum powered corpus", test: "transfer-archive", transform: (s: string) => s.replace(/export async function archiveTransferCorpus[\s\S]*?(?=\/\*\* Reconstruct frozen projections)/, LEGACY_TRANSFER_ARCHIVE + "\n"), expected: /json_record_limit/ },
      { file: "proposer-transfer.ts", pattern: "native replay refuses missing", test: "transfer-archive", transform: (s: string) => s.replace('assert.equal(shard.index, index, "transfer_shard_order");', ''), expected: /AssertionError|Missing expected rejection/ },
      { file: "proposer-transfer.ts", pattern: "native replay refuses missing", test: "transfer-archive", transform: (s: string) => s.replace(/^  if \(.+\) assertJsonEncoding\(String\(current.body\), MAX_TRACKER_RECORD_BYTES\);$/m, ''), expected: /AssertionError|Missing expected rejection/ },
      { file: "proposer-transfer.ts", pattern: "explicit prospective designs", test: "transfer-archive", transform: (s: string) => s.replace('const { alpha, power, effect, margin, targets, looks } = parseTransferDesign(declaration);', 'const { alpha, power, effect, margin, targets, looks } = parseTransferDesign({ ...TRANSFER_DESIGN, looks: declaration.looks });'), expected: /AssertionError/ },
    ];
    const profiles: Readonly<Record<string, string>> = { "review-round-one": "transfer-review", "owned-review-round-one": "transfer-review-policy", "owned-review-round-two": "transfer-review-capacity" };
    const selected = cases.filter((probe) => selection === undefined || (Object.hasOwn(profiles, selection) ? probe.test === profiles[selection] : probe.pattern === selection));
    assert.ok(selected.length > 0, "transfer_revert_selection");
    copyRevertWorkspace(root, scratch);
    for (const probe of selected) {
      const path = join(scratch, probe.file); const original = readFileSync(path, "utf8"); const changed = probe.transform(original); assert.notEqual(changed, original);
      try {
        writeFileSync(path, changed);
        const result = spawnSync(process.execPath, ["--test", "--test-concurrency=2", `--test-name-pattern=${probe.pattern}`, `test/${probe.test}.test.ts`], { cwd: scratch, env: { PATH: process.env.PATH, HOME: scratch, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" }, encoding: "utf8", timeout: probe.pattern === "powered paired evaluations" ? 600_000 : 180_000 });
        const output = result.stdout + result.stderr; writeFileSync(join(scratch, probe.pattern.replaceAll(" ", "-") + ".log"), output);
        assert.equal(result.status, 1); assert.match(output, probe.expected); assert.doesNotMatch(output, /ERR_MODULE_NOT_FOUND|SyntaxError/);
        console.log(JSON.stringify({ test: probe.pattern, reverted: probe.file, exit: result.status, behavioral_failure: true }));
      } finally { writeFileSync(path, original); }
    }

  });

}

if (isMainInvocation(process.argv, import.meta.url)) await runTransferReverts(process.cwd(), process.argv[2]);
