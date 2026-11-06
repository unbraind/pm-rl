/** Behavioral guard removals run only in a disposable copy and restore every changed function in finally. */
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
const root = process.cwd(); const scratch = mkdtempSync(join(root, ".agents/pm/runtime/transfer-revert-"));
for (const file of readdirSync(root).filter((file) => file.endsWith(".ts") || file === "package.json")) cpSync(join(root, file), join(scratch, file));
for (const directory of ["test", "dist", "examples", "scripts", "docs"]) cpSync(join(root, directory), join(scratch, directory), { recursive: true });
symlinkSync(resolve(root, "node_modules"), join(scratch, "node_modules"), "dir");
const cases = [
  { file: "proposer-evolution.ts", start: "export function requireProposerTransfer", end: null, pattern: "underpowered real non-git", body: "return comparison;" },
  { file: "proposer-transfer.ts", start: "export function verifyTransferCorpus", end: "/** Open and verify", pattern: "training tracker in held-out", body: "" },
  { file: "proposer-transfer.ts", start: "export function verifyTransferCorpus", end: "/** Open and verify", pattern: "split digest mismatch", body: "" },
];
for (const probe of cases) {
  const path = join(scratch, probe.file); const original = readFileSync(path, "utf8");
  const start = original.indexOf(probe.start); const signature = original.indexOf(" {", original.indexOf("):", start));
  const end = probe.end === null ? original.length : original.indexOf(probe.end, start);
  assert.ok(start >= 0 && signature > start && end > signature);
  try {
    writeFileSync(path, original.slice(0, signature + 2) + "\n  " + probe.body + "\n}\n" + original.slice(end));
    const result = spawnSync(process.execPath, ["--test", "--test-concurrency=2", `--test-name-pattern=${probe.pattern}`, "test/proposer-transfer.test.ts"], { cwd: scratch, env: { PATH: process.env.PATH, HOME: scratch, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" }, encoding: "utf8", timeout: 90_000 });
    const output = result.stdout + result.stderr; writeFileSync(join(scratch, probe.pattern.replaceAll(" ", "-") + ".log"), output);
    assert.equal(result.status, 1); assert.match(output, /AssertionError|Missing expected rejection/);
    console.log(JSON.stringify({ test: probe.pattern, reverted: probe.file, exit: result.status, assertion_failure: true }));
  } finally { writeFileSync(path, original); }
}
