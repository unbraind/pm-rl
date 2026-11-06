/** Reproduce the real native measurement through one locally packed artifact and the pinned CLI host. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PmClient } from "@unbrained/pm-cli/sdk/core";
import { init } from "@unbrained/pm-cli/sdk/runtime";
import { loadTransferCorpus } from "../../proposer-transfer.ts";
import { readDiagnosticReceipt, rebuildDiagnosticCorpus, restoreDiagnosticReceipt } from "./transfer-replay.ts";
const root = process.cwd(); const scratch = mkdtempSync(join(tmpdir(), "transfer-cli-"));
const attributes = readFileSync(join(root, ".gitattributes"), "utf8");
const environment = { PATH: process.env.PATH, HOME: scratch, NPM_CONFIG_USERCONFIG: "/dev/null", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
const packed = JSON.parse(execFileSync("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", scratch], { cwd: root, env: environment, encoding: "utf8" })) as { filename: string }[];
const project = join(scratch, "project"); mkdirSync(project);
const initialized = await init("replay", { defaults: true, agentGuidance: "skip", author: "codex-sol" }, { cwd: project, pmRoot: join(project, ".agents/pm") });
const target = new PmClient({ cwd: project, pmRoot: initialized.path, noExtensions: true, author: "codex-sol" });
const receipt = readDiagnosticReceipt(join(root, "docs/proposer-transfer-receipt.json"));
const corpus = process.argv[2] === undefined ? rebuildDiagnosticCorpus(receipt, scratch) : loadTransferCorpus(process.argv[2]);
const evaluations = await restoreDiagnosticReceipt(target, receipt, corpus);
const cli = join(root, "node_modules/@unbrained/pm-cli/dist/cli.js");
const invocation = { cwd: project, env: { ...environment, PM_PATH: initialized.path, PM_AUTHOR: "codex-sol" }, encoding: "utf8" as const, timeout: 120_000 };
execFileSync(process.execPath, [cli, "package", "install", join(scratch, packed[0].filename), "--project", "--json"], invocation);
for (const digest of evaluations) {
  const result = JSON.parse(execFileSync(process.execPath, [cli, "rl", "proposer", "transfer", "replay", digest, "--json"], invocation)) as { details: unknown };
  assert.deepEqual(result.details, receipt.evaluations.find((row) => row.digest === digest)!.report);
  console.log(JSON.stringify({ digest, packed_cli_replay: true, task_count: 2, development_tracker_required: false }));
}

assert.equal(readFileSync(join(root, ".gitattributes"), "utf8"), attributes);
