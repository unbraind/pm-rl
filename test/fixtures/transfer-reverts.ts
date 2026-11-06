/** Behavioral reversions run only in a disposable copy and restore every changed function in finally. */
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync, execFileSync } from "node:child_process";
const root = process.cwd(); const scratch = mkdtempSync(join(root, ".agents/pm/runtime/transfer-revert-"));
for (const file of readdirSync(root).filter((file) => file.endsWith(".ts") || file === "package.json")) cpSync(join(root, file), join(scratch, file));
for (const directory of ["test", "dist", "examples", "scripts", "docs"]) cpSync(join(root, directory), join(scratch, directory), { recursive: true });
symlinkSync(resolve(root, "node_modules"), join(scratch, "node_modules"), "dir");
const old = execFileSync("git", ["show", "d808b64:proposer-transfer.ts"], { cwd: root, encoding: "utf8" });
const archiveStart = old.indexOf("export async function archiveTransferCorpus");
const archiveEnd = old.indexOf("/** Reconstruct frozen projections", archiveStart);
const cases = [
  { file: "proposer-evolution.ts", pattern: "underpowered real non-git", test: "proposer-transfer", transform: (s: string) => s.slice(0, s.indexOf("export function requireProposerTransfer")) + "export function requireProposerTransfer(comparison: EvaluationPlanReport, transfer: TransferReport): EvaluationPlanReport { return comparison; }\n", expected: /AssertionError/ },
  ...["training tracker in held-out", "split digest mismatch"].map((pattern) => ({ file: "proposer-transfer.ts", pattern, test: "proposer-transfer", transform: (s: string) => s.replace(/export function verifyTransferCorpus[\s\S]*?(?=\/\*\* Open and verify)/, "export function verifyTransferCorpus(corpus: TransferCorpus, expected = corpus.manifest.digest): void {}\n"), expected: /AssertionError|Missing expected rejection/ })),
  { file: "proposer-transfer.ts", pattern: "minimum powered corpus", test: "transfer-archive", transform: (s: string) => s.replace(/export async function archiveTransferCorpus[\s\S]*?(?=\/\*\* Reconstruct frozen projections)/, old.slice(archiveStart, archiveEnd)), expected: /json_record_limit/ },
  { file: "proposer-transfer.ts", pattern: "native replay refuses missing", test: "transfer-archive", transform: (s: string) => s.replace('assert.equal(shard.index, index, "transfer_shard_order");', ''), expected: /AssertionError|Missing expected rejection/ },
  { file: "proposer-transfer.ts", pattern: "native replay refuses missing", test: "transfer-archive", transform: (s: string) => s.replace('if (String((value as Record<string, JsonValue>)["format"]).endsWith("/2")) assertJsonEncoding(String(current.body), MAX_TRACKER_RECORD_BYTES);', ''), expected: /AssertionError|Missing expected rejection/ },
  { file: "proposer-transfer.ts", pattern: "explicit prospective designs", test: "transfer-archive", transform: (s: string) => s.replace('const { alpha, power, effect, margin, targets, looks } = parseTransferDesign(declaration);', 'const { alpha, power, effect, margin, targets, looks } = parseTransferDesign({ ...TRANSFER_DESIGN, looks: declaration.looks });'), expected: /AssertionError/ },
];
for (const probe of cases) {
  const path = join(scratch, probe.file); const original = readFileSync(path, "utf8"); const changed = probe.transform(original); assert.notEqual(changed, original);
  try {
    writeFileSync(path, changed);
    const result = spawnSync(process.execPath, ["--test", "--test-concurrency=2", `--test-name-pattern=${probe.pattern}`, `test/${probe.test}.test.ts`], { cwd: scratch, env: { PATH: process.env.PATH, HOME: scratch, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" }, encoding: "utf8", timeout: 180_000 });
    const output = result.stdout + result.stderr; writeFileSync(join(scratch, probe.pattern.replaceAll(" ", "-") + ".log"), output);
    assert.equal(result.status, 1); assert.match(output, probe.expected); assert.doesNotMatch(output, /ERR_MODULE_NOT_FOUND|SyntaxError/);
    console.log(JSON.stringify({ test: probe.pattern, reverted: probe.file, exit: result.status, behavioral_failure: true }));
  } finally { writeFileSync(path, original); }
}
