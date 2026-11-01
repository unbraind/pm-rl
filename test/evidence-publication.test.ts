/** Evidence publishing refuses cooperating writers and preserves saved bases after failed certification. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs, { copyFileSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mock, test } from "node:test";
import { syncBuiltinESMExports } from "node:module";
import { isPmCliExpectedError } from "@unbrained/pm-cli/sdk/runtime";
import { acceptanceLog, publishEvidence } from "./fixtures/evidence-publication.ts";
import { identityExecutable, identityPath } from "./fixtures/identity-path.ts";

test("cubic: evidence publishers serialize, preserve peer bases and converge on rerun", () => {
  const root = mkdtempSync(join(tmpdir(), "rl-evidence-publish-"));
  try {
    const base = new Map([["one.json", "original one"], ["two.json", "original two"]]);
    for (const [file, text] of base) writeFileSync(join(root, file), text);
    const documents = new Map([["one.json", "certified one"], ["two.json", "certified two"]]);
    const conflict = (error: unknown): boolean => isPmCliExpectedError(error) && error.context.code === "evidence_write_conflict" && error.exitCode === 4;
    writeFileSync(join(root, ".public-evidence-refresh.lock"), "peer publisher");
    assert.throws(() => publishEvidence(root, base, documents), conflict);
    assert.equal(readFileSync(join(root, "one.json"), "utf8"), base.get("one.json"));
    rmSync(join(root, ".public-evidence-refresh.lock"));
    writeFileSync(join(root, "two.json"), "peer edit");
    assert.throws(() => publishEvidence(root, base, documents), conflict);
    assert.equal(readFileSync(join(root, "one.json"), "utf8"), base.get("one.json"));
    assert.equal(readFileSync(join(root, "two.json"), "utf8"), "peer edit");
    base.set("two.json", "peer edit");
    publishEvidence(root, base, documents); publishEvidence(root, base, documents);
    for (const [file, text] of documents) assert.equal(readFileSync(join(root, file), "utf8"), text);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("cubic: failed acceptance keeps complete stdout and stderr diagnostics", () => {
  const root = mkdtempSync(join(tmpdir(), "rl-evidence-log-"));
  try {
    const log = join(root, "acceptance.log");
    acceptanceLog(log, () => "successful output\n"); assert.equal(readFileSync(log, "utf8"), "successful output\n");
    assert.throws(() => acceptanceLog(log, () => execFileSync(process.execPath, ["-e", "process.stdout.write('partial output');process.stderr.write('failure diagnostic');process.exitCode=7"], { encoding: "utf8", stdio: "pipe" })));
    assert.equal(readFileSync(log, "utf8"), "partial outputfailure diagnostic");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("cubic: restricted identity PATH needs no shell and retains the actual native executable", () => {
  const root = mkdtempSync(join(tmpdir(), "rl-identity-path-"));
  try {
    mkdirSync(join(root, "empty"));
    assert.throws(() => identityExecutable("missing-native-tool", join(root, "empty")), /Required process identity executable/);
    const bin = identityPath(root);
    const node = join(bin, process.platform === "win32" ? "node.exe" : "node");
    assert.equal(execFileSync(node, ["-e", "process.stdout.write('native node')"], { encoding: "utf8", env: { PATH: bin } }), "native node");
  } finally { rmSync(root, { recursive: true, force: true }); }
});


test("cubic: Windows identity setup copies node and powershell without POSIX links or a shell", () => {
  const root = mkdtempSync(join(tmpdir(), "rl-windows-identity-"));
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!; const previousPath = process.env.PATH;
  try {
    const tools = join(root, "tools"); mkdirSync(tools); copyFileSync(process.execPath, join(tools, "powershell.exe"));
    process.env.PATH = tools; Object.defineProperty(process, "platform", { ...platform, value: "win32" });
    const bin = identityPath(root);
    assert.deepEqual(readdirSync(bin).sort(), ["node.exe", "powershell.exe"]);
    assert.deepEqual(readFileSync(join(bin, "node.exe")), readFileSync(process.execPath));
    assert.deepEqual(readFileSync(join(bin, "powershell.exe")), readFileSync(join(tools, "powershell.exe")));
  } finally {
    Object.defineProperty(process, "platform", platform); if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath;
    rmSync(root, { recursive: true, force: true });
  }
});


test("cubic: publication rereads each field, preserves partial progress and retains a successor lock", () => {
  const root = mkdtempSync(join(tmpdir(), "rl-evidence-forward-"));
  const base = new Map([["one.json", "one"], ["two.json", "two"]]); const documents = new Map([["one.json", "certified one"], ["two.json", "certified two"]]);
  const nativeWrite = fs.writeFileSync; let injected = false;
  for (const [file, text] of base) nativeWrite(join(root, file), text);
  const write = mock.method(fs, "writeFileSync", (...args: Parameters<typeof fs.writeFileSync>) => {
    nativeWrite(...args);
    if (!injected && String(args[0]) === join(root, "one.json")) {
      injected = true; nativeWrite(join(root, "two.json"), "peer two");
      rmSync(join(root, ".public-evidence-refresh.lock")); nativeWrite(join(root, ".public-evidence-refresh.lock"), "successor lock");
    }
  }); syncBuiltinESMExports();
  try {
    assert.throws(() => publishEvidence(root, base, documents), (error: unknown) => isPmCliExpectedError(error) && error.context.code === "evidence_write_conflict" && error.exitCode === 4);
    assert.ok(injected); assert.equal(readFileSync(join(root, "one.json"), "utf8"), "certified one");
    assert.equal(readFileSync(join(root, "two.json"), "utf8"), "peer two");
    assert.equal(readFileSync(join(root, ".public-evidence-refresh.lock"), "utf8"), "successor lock");
    rmSync(join(root, ".public-evidence-refresh.lock")); base.set("two.json", "peer two");
    publishEvidence(root, base, documents);
    assert.equal(readFileSync(join(root, "two.json"), "utf8"), "certified two");
  } finally { write.mock.restore(); syncBuiltinESMExports(); rmSync(root, { recursive: true, force: true }); }
});
