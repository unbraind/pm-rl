/** Reproduce the real native measurement through one locally packed artifact and the pinned CLI host. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PmClient } from "@unbrained/pm-cli/sdk/core";
import { init } from "@unbrained/pm-cli/sdk/runtime";
import { archiveTransferCorpus, replayTransferCorpus, recordTransferEvaluation, recordTransferPlan, replayTransferEvaluation, TRANSFER_DESIGN, type TransferReport, type TransferPair } from "../../proposer-transfer.ts";
const root = process.cwd(); const scratch = mkdtempSync(join(tmpdir(), "transfer-cli-"));
const attributes = readFileSync(join(root, ".gitattributes"), "utf8");
const environment = { PATH: process.env.PATH, HOME: scratch, NPM_CONFIG_USERCONFIG: "/dev/null", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
const packed = JSON.parse(execFileSync("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", scratch], { cwd: root, env: environment, encoding: "utf8" })) as { filename: string }[];
const project = join(scratch, "project"); mkdirSync(project);
const initialized = await init("replay", { defaults: true, agentGuidance: "skip", author: "codex-sol" }, { cwd: project, pmRoot: join(project, ".agents/pm") });
const source = new PmClient({ cwd: root, pmRoot: join(root, ".agents/pm"), noExtensions: true, author: "codex-sol" });
const target = new PmClient({ cwd: project, pmRoot: initialized.path, noExtensions: true, author: "codex-sol" });
const corpus = await replayTransferCorpus(source, "89aa1ae2c8eef8ab784d83f6d4bd8bff2638ed7259af5f2a50fbfff7b7893c2e");
const address = await archiveTransferCorpus(target, corpus);
const cli = join(root, "node_modules/@unbrained/pm-cli/dist/cli.js");
const invocation = { cwd: project, env: { ...environment, PM_PATH: initialized.path, PM_AUTHOR: "codex-sol" }, encoding: "utf8" as const, timeout: 120_000 };
execFileSync(process.execPath, [cli, "package", "install", join(scratch, packed[0].filename), "--project", "--json"], invocation);
for (const digest of ["f5962dbe9114770b1e8e426beb980f626c1d02978c8792aefc79ff0678e3d759", "7f767f0ef02f4c822df577a2a5a31d99e05db4fdd272150294ffb74df8f6eb7b"]) {
  const envelope = JSON.parse(String((await source.get(`transfer-${digest}`)).item.body)) as { role: "meta" | "audit"; pairs: TransferPair[]; comparisons: number; report: TransferReport };
  assert.deepEqual(await replayTransferEvaluation(source, digest), envelope.report);
  const plan = await recordTransferPlan(target, corpus.manifest.digest, { ...TRANSFER_DESIGN, looks: envelope.comparisons });
  const copied = await recordTransferEvaluation(target, address, envelope.role, envelope.pairs, plan);
  assert.deepEqual(copied.report.tasks, envelope.report.tasks);
  const result = JSON.parse(execFileSync(process.execPath, [cli, "rl", "proposer", "transfer", "replay", copied.digest, "--json"], invocation)) as { details: unknown };
  assert.deepEqual(result.details, copied.report);
  console.log(JSON.stringify({ digest, packed_cli_replay: true, task_count: 2, source_checkout_required: false }));
}

assert.equal(readFileSync(join(root, ".gitattributes"), "utf8"), attributes);
