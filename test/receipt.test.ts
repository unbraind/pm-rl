/** Determinism receipts: recorded at run start, re-derived on demand by run verify. */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { PmClient } from "@unbrained/pm-cli/sdk/core";
import { EXIT_CODE, init, isPmCliExpectedError } from "@unbrained/pm-cli/sdk/runtime";
import { createExtensionTestHarness, type ExtensionTestHarness } from "@unbrained/pm-cli/sdk/testing";

import extension, { RL_ITEM_TYPES, type RlCommandResult } from "../index.ts";
import {
  compareReceipts,
  parseReceipt,
  RECEIPT_FIELDS,
  renderReceiptDifferences,
  type ReceiptSpec,
} from "../receipt.ts";

const roots: string[] = [];

after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

/** Extract a successful structured command result, failing loudly on an unhandled command. */
function resultOf(run: { result?: unknown; handled: boolean }): RlCommandResult {
  assert.equal(run.handled, true, JSON.stringify(run));
  return run.result as RlCommandResult;
}

/** Assert a refusal carries an explicit typed code and conflict exit. */
function typedRefusal(code: string) {
  return (error: unknown): boolean => isPmCliExpectedError(error) && error.exitCode === EXIT_CODE.CONFLICT && String((error as { context?: { code?: string } }).context?.code) === code;
}

/** Representative determinism receipt shared across tests. */
export const RECEIPT: ReceiptSpec = {
  seed_policy: "derived-from-seed-7",
  library_versions: { torch: "2.4.0", numpy: "2.1.1", gymnasium: "0.29.1" },
  device: "cuda:0",
  environment_version: "grid-world-3",
};

/** Representative environment fixture; its resolved id segment names grid-world. */
const ENV_SPEC = {
  name: "Grid World",
  version: "3",
  task_suite: ["reach-goal"],
  reward_specification: { goal: 10 },
};

/** Write one receipt file, optionally overridden field-wise. */
function writeReceipt(root: string, overrides: Partial<Record<string, unknown>> = {}, filename = "receipt.json"): string {
  const path = join(root, filename);
  writeFileSync(path, JSON.stringify({ ...RECEIPT, ...overrides }));
  return path;
}

/** Create a real initialized tracker and activate the extension through the host. */
async function workspace(): Promise<{
  root: string;
  pmRoot: string;
  harness: Awaited<ReturnType<typeof createExtensionTestHarness>>;
  client: PmClient;
}> {
  const root = mkdtempSync(join(tmpdir(), "pm-rl-receipt-"));
  roots.push(root);
  const initialized = await init("rl", { defaults: true, author: "pm-rl-test", agentGuidance: "skip" }, { cwd: root });
  const client = new PmClient({ pmRoot: initialized.path, author: "pm-rl-test" });
  for (const itemType of RL_ITEM_TYPES) {
    await client.schemaAddType(itemType.name, {
      folder: itemType.folder,
      alias: [...(itemType.aliases ?? [])],
      description: itemType.description,
      defaultStatus: itemType.default_status,
    });
  }
  const harness = await createExtensionTestHarness(extension, { name: "pm-rl", capabilities: ["commands", "schema"] });
  assert.deepEqual(harness.activation.failed, []);
  return { root, pmRoot: initialized.path, harness, client };
}

/** Register one shared environment and return its resolved id. */
async function registerEnv(root: string, pmRoot: string, harness: ExtensionTestHarness): Promise<string> {
  const envFile = join(root, "environment.json");
  writeFileSync(envFile, JSON.stringify(ENV_SPEC));
  return resultOf(await harness.runCommand({ command: "rl env register", pmRoot, options: { file: envFile } })).id!;
}

/** Start one run against the given environment, optionally carrying a receipt. */
async function startRun(pmRoot: string, harness: ExtensionTestHarness, environment: string, options: { runId?: string; receiptFile?: string } = {}): Promise<string> {
  return resultOf(await harness.runCommand({
    command: "rl run start",
    pmRoot,
    args: [options.runId ?? "run-a"],
    options: { environment, algorithm: "PPO", ...(options.receiptFile ? { receiptFile: options.receiptFile } : {}) },
  })).id!;
}

test("receipt parsing requires exactly the four provenance fields, fully populated", () => {
  assert.deepEqual(parseReceipt(JSON.stringify(RECEIPT)), RECEIPT);
  assert.deepEqual([...RECEIPT_FIELDS].sort(), ["device", "environment_version", "library_versions", "seed_policy"].sort());
  for (const [overrides, message] of [
    [{ seed_policy: "" }, /non-empty string seed_policy/],
    [{ seed_policy: 7 }, /non-empty string seed_policy/],
    [{ device: "" }, /non-empty string device/],
    [{ environment_version: "" }, /non-empty string environment_version/],
    [{ library_versions: [] }, /object of library name to version/],
    [{ library_versions: { torch: 2 } }, /string version for library "torch"/],
    [{ library_versions: { "": "1.0" } }, /non-empty library name/],
  ] as Array<[Partial<Record<string, unknown>>, RegExp]>) {
    assert.throws(() => parseReceipt(JSON.stringify({ ...RECEIPT, ...overrides })), message);
  }
  // A receipt that omits library_versions entirely is no receipt at all.
  const { library_versions: _omitted, ...withoutLibraries } = RECEIPT;
  void _omitted;
  assert.throws(() => parseReceipt(JSON.stringify(withoutLibraries)), /requires library_versions/);
  // An unexpected extra key would let untracked state claim provenance weight.
  assert.throws(() => parseReceipt(JSON.stringify({ ...RECEIPT, extra: "x" })), /unknown receipt field "extra"/);
  assert.throws(() => parseReceipt("not-json"), /not valid JSON/);
  assert.throws(() => parseReceipt("[]"), /one JSON object/);
});

test("comparison names every differing field, including added and removed libraries", () => {
  assert.deepEqual(compareReceipts(RECEIPT, RECEIPT), []);
  const drifted = compareReceipts(RECEIPT, {
    seed_policy: "derived-from-seed-8",
    library_versions: { torch: "2.5.0", gymnasium: "0.29.1" },
    device: "cuda:0",
    environment_version: "grid-world-3",
  });
  // One difference per drifted field: the seed policy moved, one library was
  // upgraded, one library vanished entirely.
  assert.deepEqual(drifted.map((difference) => `${difference.field}: recorded ${difference.recorded}, now ${difference.now}`).sort(), [
    'library_versions "numpy": recorded "2.1.1", now absent',
    'library_versions "torch": recorded "2.4.0", now "2.5.0"',
    'seed_policy: recorded "derived-from-seed-7", now "derived-from-seed-8"',
  ].sort());
  // A library the re-derived receipt gained is named on its own too.
  const [gained] = compareReceipts(RECEIPT, { ...RECEIPT, library_versions: { ...RECEIPT.library_versions, triton: "3.0.0" } });
  assert.deepEqual(gained, { field: 'library_versions "triton"', recorded: "absent", now: '"3.0.0"' });

  const rendered = renderReceiptDifferences(drifted);
  assert.match(rendered, /seed_policy: recorded "derived-from-seed-7", now "derived-from-seed-8"/);
  assert.equal(renderReceiptDifferences([]), "");
});

test("a matching receipt verifies without mutating the run; a drifted one refuses naming the fields", async () => {
  const { root, pmRoot, harness, client } = await workspace();
  const environment = await registerEnv(root, pmRoot, harness);
  // The receipt pins the exact resolved environment item id the run trains under.
  const receiptFile = writeReceipt(root, { environment_version: environment });
  const run = await startRun(pmRoot, harness, environment, { runId: "verified-run", receiptFile });
  const before = await client.get(run, { depth: "deep" });

  const verified = resultOf(await harness.runCommand({
    command: "rl run verify",
    pmRoot,
    args: [run],
    options: { receiptFile },
  }));
  assert.equal(verified.action, "rl-run-verify");
  assert.equal(verified.details?.verified, true);
  assert.deepEqual(verified.details?.differences, []);

  const after = await client.get(run, { depth: "deep" });
  assert.equal(after.item.body, before.item.body);
  assert.equal(after.item.updated_at, before.item.updated_at);

  // Every drifted field is named: seed policy, library versions, device, env version.
  const driftedFile = writeReceipt(root, {
    seed_policy: "other-policy",
    device: "cpu",
    library_versions: { ...RECEIPT.library_versions, numpy: "2.2.0" },
    environment_version: environment,
  }, "drifted.json");
  await assert.rejects(
    harness.runCommand({ command: "rl run verify", pmRoot, args: [run], options: { receiptFile: driftedFile } }),
    (error: unknown): boolean => {
      if (!isPmCliExpectedError(error) || String((error as { context?: { code?: string } }).context?.code) !== "receipt_mismatch") return false;
      const message = String(error.message ?? error);
      for (const fragment of ['seed_policy: recorded "derived-from-seed-7"', 'device: recorded "cuda:0", now "cpu"', 'library_versions "numpy": recorded "2.1.1", now "2.2.0"']) {
        assert.ok(message.includes(fragment), `missing ${fragment} in: ${message}`);
      }
      return true;
    },
  );
});

test("a run configuration that embeds the receipt heading does not fool verify", async () => {
  const { root, pmRoot, harness, client } = await workspace();
  const environment = await registerEnv(root, pmRoot, harness);
  // The configuration value contains the literal heading text; an unanchored
  // search would find this impostor first and return the CONFIGURATION fence.
  const configFile = join(root, "tricky-config.json");
  writeFileSync(configFile, JSON.stringify({ note: "Determinism receipt: nothing to see here" }));
  const environmentId = environment;
  const receiptFile = writeReceipt(root, { environment_version: environmentId });
  const run = await (async () => {
    const started = resultOf(await harness.runCommand({
      command: "rl run start",
      pmRoot,
      args: ["tricky-run"],
      options: { environment: environmentId, algorithm: "PPO", configFile, receiptFile },
    }));
    return started.id!;
  })();
  const verified = resultOf(await harness.runCommand({
    command: "rl run verify",
    pmRoot,
    args: [run],
    options: { receiptFile },
  }));
  assert.equal(verified.details?.verified, true);
  void client;
});

test("verify re-derives against the run itself: an environment the run never used cannot verify", async () => {
  const { root, pmRoot, harness, client } = await workspace();
  const environment = await registerEnv(root, pmRoot, harness);
  const receiptFile = writeReceipt(root, { environment_version: environment });
  const run = await startRun(pmRoot, harness, environment, { receiptFile });
  // A hand-edited body whose stored receipt names some OTHER environment is
  // internally consistent but no longer describes this run; verify must catch it.
  const stored = await client.get(run, { depth: "deep" });
  const forged = String(stored.item.body).replace(`"${environment}"`, "\"env-some-other\"");
  assert.notEqual(forged, String(stored.item.body));
  await client.update(run, { body: forged, message: "hand-edit receipt environment" });
  await assert.rejects(
    harness.runCommand({ command: "rl run verify", pmRoot, args: [run], options: { receiptFile } }),
    typedRefusal("receipt_mismatch"),
  );
});

test("starting with a receipt that names a foreign environment is refused at the write", async () => {
  const { root, pmRoot, harness } = await workspace();
  const environment = await registerEnv(root, pmRoot, harness);
  const misnamed = writeReceipt(root, { environment_version: "env-somewhere-else" }, "misnamed.json");
  await assert.rejects(
    harness.runCommand({
      command: "rl run start",
      pmRoot,
      args: ["misnamed-receipt"],
      options: { environment, algorithm: "PPO", receiptFile: misnamed },
    }),
    typedRefusal("receipt_environment_mismatch"),
  );
});

test("verify refuses a run with no stored receipt, and starting with a malformed receipt fails closed", async () => {
  const { root, pmRoot, harness } = await workspace();
  const environment = await registerEnv(root, pmRoot, harness);
  const run = await startRun(pmRoot, harness, environment, { runId: "no-receipt" });
  await assert.rejects(
    harness.runCommand({ command: "rl run verify", pmRoot, args: [run], options: { receiptFile: writeReceipt(root) } }),
    typedRefusal("receipt_unrecorded"),
  );

  const badFile = join(root, "bad-receipt.json");
  writeFileSync(badFile, "{not json");
  await assert.rejects(
    harness.runCommand({
      command: "rl run start",
      pmRoot,
      args: ["bad-receipt"],
      options: { environment, algorithm: "PPO", receiptFile: badFile },
    }),
    /not valid JSON/,
  );
});
