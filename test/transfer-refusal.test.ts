/** Refusal ownership is invariant across adversarial SDK inputs, sealed replay, CLI formats and packed runtimes. */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { createPmCliExpectedError, isPmCliExpectedError } from "@unbrained/pm-cli/sdk/runtime";
import { createExtensionTestHarness } from "@unbrained/pm-cli/sdk/testing";
import extension, { hashJson, type JsonValue } from "../index.ts";
import { parseTransferDesign, transferPower, transferMembers, evaluateTransfer, verifyTransferCorpus, recordTransferPlan, readTransferPlan, archiveTransferCorpus, recordTransferEvaluation, replayTransferCorpus, replayTransferEvaluation, nativeTransferValue, TRANSFER_DESIGN, type TransferDesign, type TransferCorpus } from "../proposer-transfer.ts";
import { parseProposerEvolutionConfig, proposerEvolutionConfiguration, runProposerEvolution } from "../proposer-evolution.ts";
import { ProposerRefusal } from "../proposer-program.ts";
import { processWorkspace } from "./fixtures/process-workspace.ts";
import { transferCorpus } from "./fixtures/transfer-corpus.ts";
import { withTransferScratch } from "./fixtures/transfer-scratch.ts";
import { correction, malformedTransferDesigns } from "./fixtures/transfer-refusal-consumer.ts";

/** Real native records keep malformed persisted context separate from new caller declarations. */
async function native(client: Awaited<ReturnType<typeof processWorkspace>>["client"], value: JsonValue): Promise<string> {
  const digest = hashJson(value); await client.create({ id: `transfer-${digest}`, type: "Decision", title: "Synthetic refusal provenance", body: JSON.stringify(value), affectedVersion: digest, component: "proposer-transfer" }); return digest;
}
/** Every native refusal retains its established code and actionable restoration instruction. */
function restoration(error: unknown, code: string): boolean {
  assert.ok(isPmCliExpectedError(error)); assert.equal(error.context.code, code); assert.match(error.message, /Restore the original native records/); assert.doesNotMatch(error.message, /Invalid transfer input|PAYLOAD_SENTINEL/); return true;
}

test("transfer declaration adversarial corpus corrects every public design entry point before writes", async () => {
  const w = await processWorkspace(); const corpus = transferCorpus(); const pairs = corpus.tasks.meta.map(({ id }) => ({ id, candidate: 1, incumbent: 0 }));
  const before = (await w.client.listAllComplete({ includeBody: true })).items;
  for (const value of malformedTransferDesigns()) {
    for (const operation of [() => parseTransferDesign(value), () => transferPower(0, value as TransferDesign), () => evaluateTransfer(corpus, "meta", pairs, value as TransferDesign)]) assert.throws(operation, (error) => correction(error, "transfer_design"));
    await assert.rejects(recordTransferPlan(w.client, corpus.manifest.digest, value as TransferDesign), (error) => correction(error, "transfer_design"));
  }
  const capacity = { ...TRANSFER_DESIGN, looks: 2, effect: 0.01000001 };
  assert.throws(() => transferPower(0, capacity), (error) => correction(error, "transfer_design_capacity"));
  await assert.rejects(recordTransferPlan(w.client, corpus.manifest.digest, capacity), (error) => correction(error, "transfer_design_capacity"));
  assert.deepEqual((await w.client.listAllComplete({ includeBody: true })).items, before);
});

test("transfer input correction covers all count coordinate corpus pair and score refusal classes", async () => {
  const w = await processWorkspace(); const corpus = transferCorpus(); const design = { ...TRANSFER_DESIGN, looks: 2 }; const pairs = corpus.tasks.meta.map(({ id }) => ({ id, candidate: 1, incumbent: 0 }));
  const cases: readonly [string, () => unknown][] = [
    ["transfer_counts", () => transferPower(-1, design)], ["transfer_counts", () => transferMembers(corpus, "meta", 0)],
    ["transfer_look", () => transferMembers(corpus, "meta", 2, 2)],
    ["transfer_role", () => evaluateTransfer(corpus, "invalid" as "meta", pairs, design)],
    ["transfer_corpus_shape", () => verifyTransferCorpus(null as unknown as TransferCorpus)],
    ["transfer_pairs", () => evaluateTransfer(corpus, "meta", null as unknown as typeof pairs, design)],
    ["transfer_pairs", () => evaluateTransfer(corpus, "meta", [], design)],
    ["transfer_score", () => evaluateTransfer(corpus, "meta", pairs.map((row) => ({ ...row, candidate: NaN })), design)],
  ];
  for (const [code, operation] of cases) assert.throws(operation, (error) => correction(error, code));
  const root = await archiveTransferCorpus(w.client, corpus); const plan = await recordTransferPlan(w.client, "a".repeat(64), design);
  await assert.rejects(recordTransferEvaluation(w.client, root, "meta", pairs, plan), (error) => correction(error, "transfer_plan_corpus"));
  const valid = evaluateTransfer(corpus, "meta", pairs, design); assert.equal(valid.reason, "transfer_underpowered");
});

test("evolution transfer corrections survive SDK and both CLI commands and output modes", async () => {
  const w = await processWorkspace(); const config = proposerEvolutionConfiguration(); const file = join(w.root, "declaration.json");
  const harness = await createExtensionTestHarness(extension, { name: "pm-rl", capabilities: ["commands", "hooks", "schema"] });
  const before = (await w.client.listAllComplete({ includeBody: true })).items;
  for (const transfer of [null, [], 1, {}, { ...config.transfer, alpha: 1 }, { ...config.transfer, effect: 0.01000001 }, { ...config.transfer, extra: "PAYLOAD_SENTINEL" }]) {
    const value = { ...config, transfer }; writeFileSync(file, JSON.stringify(value));
    assert.throws(() => parseProposerEvolutionConfig(value), (error) => { assert.ok(error instanceof ProposerRefusal); assert.match(error.message, /transfer_design.*Correct.*effect.*alpha.*looks/); assert.match(error.remedy, /transfer_design.*Correct/); return true; });
    await assert.rejects(runProposerEvolution(w.client, w.coordinates, { id: "refused", approval: w.approval, dataset: "unopened", config: value as typeof config }), ProposerRefusal);
    for (const json of [false, true]) for (const command of ["rl proposer validate", "rl proposer run"]) await assert.rejects(harness.runCommand({ command, pmRoot: w.pmRoot, args: command.endsWith("run") ? ["refused"] : [], options: { file, dataset: "unopened", approval: w.approval }, global: { json } }), (error) => { assert.ok(isPmCliExpectedError(error)); assert.equal(error.context.code, "proposer_invalid"); assert.match(error.message, /transfer_design.*Correct/); assert.doesNotMatch(error.message, /Restore|PAYLOAD_SENTINEL/); return true; });
  }
  assert.deepEqual((await w.client.listAllComplete({ includeBody: true })).items, before);
  assert.deepEqual(parseProposerEvolutionConfig(config), config);
});

test("native transfer declarations corpus and scores retain restoration advice in every receipt version", async () => {
  const w = await processWorkspace(); const corpus = transferCorpus(); const design = { ...TRANSFER_DESIGN, looks: 2 };
  const root = await archiveTransferCorpus(w.client, corpus); const plan = await recordTransferPlan(w.client, corpus.manifest.digest, design);
  const pairs = corpus.tasks.meta.map(({ id }) => ({ id, candidate: 0.5, incumbent: 0.5 })); const good = await recordTransferEvaluation(w.client, root, "meta", pairs, plan);
  for (const value of [null, { ...design, alpha: 1 }, { ...design, effect: 0.01000001 }]) {
    const bad = await native(w.client, { format: "pm-rl/proposer-transfer-plan/2", corpus: corpus.manifest.digest, design: value } as JsonValue);
    await assert.rejects(readTransferPlan(w.client, bad), (error) => restoration(error, value?.effect === 0.01000001 ? "transfer_design_capacity" : "transfer_design"));
  }
  const badPairs = pairs.map((row) => ({ ...row, candidate: 2 }));
  const shard = await native(w.client, { format: "pm-rl/proposer-transfer-pairs/2", index: 0, pairs: badPairs });
  for (const version of [1, 2, 3]) {
    const digest = await native(w.client, { format: `pm-rl/proposer-transfer-evaluation/${version}`, corpus: root, plan, role: "meta", look: 1, comparisons: 2, pairs: badPairs, report: good.report as unknown as JsonValue, pair_count: pairs.length, shards: [shard] });
    await assert.rejects(replayTransferEvaluation(w.client, digest), (error) => restoration(error, "transfer_score"));
  }
  const envelope = JSON.parse(String((await w.client.get(`transfer-${root}`)).item.body)) as Record<string, JsonValue>;
  await assert.rejects(replayTransferCorpus(w.client, await native(w.client, { ...envelope, manifest: null })), (error) => restoration(error, "transfer_corpus_shape"));
  const legacy = await native(w.client, { format: "pm-rl/proposer-transfer-corpus/1", manifest: null, tasks: [] });
  await assert.rejects(replayTransferCorpus(w.client, legacy), (error) => restoration(error, "transfer_corpus_shape"));
  assert.deepEqual(await replayTransferEvaluation(w.client, good.digest), good.report);
});

test("native transfer classification preserves foreign typed refusals and real filesystem failures", async () => {
  for (const code of ["provenance_read_retryable", "transfer_retry", "constructor", "__proto__"]) {
    const foreign = createPmCliExpectedError("Retry storage", { context: { code } });
    assert.throws(() => nativeTransferValue(() => { throw foreign; }), (error) => error === foreign);
  }
  await withTransferScratch("transfer-refusal-io-", async (scratch) => {
    let failure: unknown; try { readFileSync(join(scratch, "missing")); } catch (error) { failure = error; }
    assert.throws(() => nativeTransferValue(() => { throw failure; }), (error) => error === failure);
  });
});

test("packed npm and Bun consumers preserve transfer correction codes in SDK JSON and TOON", { timeout: 180_000 }, async (t) => {
  await withTransferScratch("transfer-refusal-pack-", async (scratch) => {
    const root = resolve(import.meta.dirname, ".."); const environment = { PATH: process.env.PATH, HOME: scratch, NPM_CONFIG_USERCONFIG: "/dev/null", npm_config_userconfig: "/dev/null", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
    const packed = JSON.parse(execFileSync("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", scratch], { cwd: root, env: environment, encoding: "utf8", timeout: 60_000 })) as { filename: string }[];
    execFileSync("tar", ["-xf", join(scratch, packed[0].filename), "-C", scratch]); symlinkSync(join(root, "node_modules"), join(scratch, "node_modules"), "dir");
    const consumer = readFileSync(join(import.meta.dirname, "fixtures/transfer-refusal-consumer.ts"), "utf8").replace('"../../index.ts"', '"./package/dist/index.js"') + "\nawait runTransferRefusalConsumer();\n";
    writeFileSync(join(scratch, "consumer.ts"), consumer);
    const cli = join(root, "node_modules/@unbrained/pm-cli/dist/cli.js");
    for (const runtime of [process.execPath, "bun"]) {
      const project = join(scratch, runtime === "bun" ? "bun" : "npm"); mkdirSync(project);
      const sdk = spawnSync(runtime, [join(scratch, "consumer.ts")], { cwd: project, env: environment, encoding: "utf8", timeout: 60_000 });
      if (runtime === "bun" && (sdk.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") { t.diagnostic("Bun unavailable (ENOENT); packed Node checks remain mandatory."); continue; }
      assert.ifError(sdk.error); assert.equal(sdk.status, 0, sdk.stdout + sdk.stderr); assert.deepEqual(JSON.parse(sdk.stdout), { sdk_refusal_checks: malformedTransferDesigns().length * 3 + 2, non_git: true, valid_plan_replayed: true });
      const pmRoot = join(project, ".agents/pm");
      execFileSync(process.execPath, [cli, "--pm-path", pmRoot, "package", "install", join(scratch, packed[0].filename), "--project", "--json"], { cwd: project, env: environment, stdio: "pipe", timeout: 60_000 });
      const config = proposerEvolutionConfiguration(); const file = join(project, "invalid.json"); writeFileSync(file, JSON.stringify({ ...config, transfer: { ...config.transfer, alpha: 1 } }));
      for (const json of [false, true]) for (const command of ["validate", "run"]) {
        const args = [cli, "--pm-path", pmRoot, "rl", "proposer", command, ...(command === "run" ? ["refused", "--dataset", "unopened", "--approval", "unopened"] : []), "--file", file, ...(json ? ["--json"] : [])];
        const result = spawnSync(runtime, args, { cwd: project, env: environment, encoding: "utf8", timeout: 30_000 });
        assert.equal(result.status, 2, result.stdout + result.stderr); assert.match(result.stdout + result.stderr, /transfer_design.*Correct/); assert.doesNotMatch(result.stdout + result.stderr, /Restore the original native records/);
      }
      t.diagnostic(`Packed runtime ${runtime === "bun" ? "bun" : "node"}: SDK=${malformedTransferDesigns().length * 3 + 2} CLI=4 verified.`);
    }
  });
});
