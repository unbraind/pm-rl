/** Gate-simulator environments, episodes with candidate-tree identity, replay, and the paired-cohort gap. */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { PmClient } from "@unbrained/pm-cli/sdk/core";
import { EXIT_CODE, init, isPmCliExpectedError } from "@unbrained/pm-cli/sdk/runtime";
import { createExtensionTestHarness, type ExtensionTestHarness } from "@unbrained/pm-cli/sdk/testing";

import extension, { hashJson, idSegment, RL_ITEM_TYPES, type JsonValue, type RlCommandResult } from "../index.ts";
import {
  assertNoCredentials,
  buildSimRealGap,
  deriveVerdict,
  parseEpisodeSpec,
  parseGateEnvironmentSpec,
  parseGateResults,
  parseOutcomeSpec,
  renderSimRealGap,
  type EpisodeSpec,
  type GateEnvironmentSpec,
  type OutcomeSpec,
} from "../gatesim.ts";

const roots: string[] = [];

after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

/** Extract a successful structured command result, failing loudly on an unhandled command. */
function resultOf(run: { result?: unknown; handled: boolean }): RlCommandResult {
  assert.equal(run.handled, true, JSON.stringify(run));
  return run.result as RlCommandResult;
}

/** A host SDK whose client is the given real client; the production commands read only `context.sdk.client`. */
type HostSdk = NonNullable<Parameters<ExtensionTestHarness["runCommand"]>[0]["sdk"]>;
function sdkWith(client: PmClient): HostSdk {
  return { client } as unknown as HostSdk;
}

/**
 * Assert a command refusal carries an explicit typed code and conflict exit.
 *
 * The package's contract is that its refusals are typed, not prose: the code is
 * what a recursive loop branches on, so a test that only matched the message
 * would let a refactor rename the code silently.
 */
function typedRefusal(code: string) {
  return (error: unknown): boolean => isPmCliExpectedError(error) && error.exitCode === EXIT_CODE.CONFLICT && String((error as { context?: { code?: string } }).context?.code) === code;
}

/** Assert a pure-module refusal carries its typed code. */
function pureRefusal(code: string) {
  return (error: unknown): boolean =>
    isPmCliExpectedError(error) && String((error as { context?: { code?: string } }).context?.code) === code;
}

/** Representative gate-environment fixture shared across tests. */
export const GATES_SPEC: GateEnvironmentSpec = {
  name: "fleet-gates",
  version: "1",
  repository: "unbraind/pm-rl",
  commit: "d3f1840abc1234567890abcdef1234567890abcd",
  gates: [
    { name: "coverage", command: "npm run coverage" },
    { name: "docstring", command: "npm run docstring" },
  ],
  verdict_extraction: { rule: "all_exit_zero" },
};

/** Write one gate-environment specification file, optionally overridden field-wise. */
function writeGatesEnv(root: string, overrides: Partial<Record<string, unknown>> = {}): string {
  const path = join(root, "gates-env.json");
  writeFileSync(path, JSON.stringify({ ...GATES_SPEC, ...overrides }));
  return path;
}

/** Write one gate-results file from `[name, exitCode]` pairs. */
function writeGateResults(root: string, entries: Array<[string, number]>, filename = "gate-results.json"): string {
  const path = join(root, filename);
  writeFileSync(path, JSON.stringify({ gates: entries.map(([name, exit_code]) => ({ name, exit_code })) }));
  return path;
}

/** Write one patch file with the given text. */
function writePatch(root: string, text: string, filename = "candidate.patch"): string {
  const path = join(root, filename);
  writeFileSync(path, text);
  return path;
}

/** Register the shared gate environment and return its resolved item id. */
async function gatesEnv(root: string, pmRoot: string, harness: ExtensionTestHarness): Promise<string> {
  return resultOf(await harness.runCommand({
    command: "rl episode env register",
    pmRoot,
    options: { file: writeGatesEnv(root) },
  })).id!;
}

/** Create a real initialized tracker and activate the extension through the host. */
async function workspace(): Promise<{
  root: string;
  pmRoot: string;
  harness: Awaited<ReturnType<typeof createExtensionTestHarness>>;
  client: PmClient;
}> {
  const root = mkdtempSync(join(tmpdir(), "pm-rl-gatesim-"));
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

test("gate environment parsing pins the commit, gate set and verdict extraction, and refuses everything else", () => {
  assert.deepEqual(parseGateEnvironmentSpec(JSON.stringify(GATES_SPEC), "spec"), GATES_SPEC);
  for (const [overrides, message] of [
    [{ name: "" }, /non-empty string name/],
    [{ version: 2 }, /non-empty string version/],
    [{ repository: "" }, /non-empty string repository/],
    [{ commit: "not-a-commit" }, /hex git commit/],
    [{ gates: [] }, /at least one gate/],
    [{ gates: [{ name: "coverage", command: "" }] }, /non-empty string command/],
    [{ gates: [{ name: "", command: "x" }] }, /non-empty string name/],
    [{ gates: [{ name: "a", command: "x" }, { name: "a", command: "y" }] }, /unique gate names/],
    [{ verdict_extraction: { rule: "any_exit_zero" } }, /must declare the rule "all_exit_zero"/],
    [{ verdict_extraction: {} }, /must declare the rule "all_exit_zero"/],
    [{ verdict_extraction: "all_exit_zero" }, /requires a verdict_extraction object/],
  ] as Array<[Partial<Record<string, unknown>>, RegExp]>) {
    assert.throws(() => parseGateEnvironmentSpec(JSON.stringify({ ...GATES_SPEC, ...overrides }), "spec"), message);
  }
  assert.throws(() => parseGateEnvironmentSpec("not-json", "spec"), /not valid JSON/);
  assert.throws(() => parseGateEnvironmentSpec("[]", "spec"), /one JSON object/);
});

test("verdict extraction follows the pinned rule over complete, known gate results", () => {
  const results = parseGateResults(JSON.stringify({ gates: [{ name: "coverage", exit_code: 0 }, { name: "docstring", exit_code: 0 }] }), "results", GATES_SPEC);
  assert.deepEqual(deriveVerdict(results), "pass");
  assert.equal(deriveVerdict(parseGateResults(JSON.stringify({ gates: [{ name: "docstring", exit_code: 0 }, { name: "coverage", exit_code: 1 }] }), "results", GATES_SPEC)), "fail");

  for (const [text, message] of [
    [JSON.stringify({ gates: [{ name: "lint", exit_code: 0 }] }), /undeclared gate .*lint/],
    [JSON.stringify({ gates: [{ name: "coverage", exit_code: 0 }] }), /missing a result for declared gate .*docstring/],
    [JSON.stringify({ gates: [{ name: "coverage", exit_code: 0.5 }, { name: "docstring", exit_code: 0 }] }), /integer exit_code/],
    [JSON.stringify({ gates: [{ name: "coverage", exit_code: 0 }, { exit_code: 0 }] }), /non-empty string name/],
  ] as Array<[string, RegExp]>) {
    assert.throws(() => parseGateResults(text, "results", GATES_SPEC), message);
  }
  assert.throws(() => parseGateResults("not-json", "results", GATES_SPEC), /not valid JSON/);
  assert.throws(() => parseGateResults("[]", "results", GATES_SPEC), /one JSON object/);
  assert.throws(() => parseGateResults(JSON.stringify({}), "results", GATES_SPEC), /requires a gates array/);
});

test("credential scanning refuses tokens, userinfo URLs, private keys and keyed secret literals, and passes ordinary diffs", () => {
  for (const secret of [
    "clone https://x-access-token:ghp_Abcdef12345678901234@github.com/unbraind/pm-rl",
    "export GH_TOKEN=github_pat_ABCDEFGHIJKLMNOPQRSTUVWXYZ_12345",
    'config.password = "hunter22secret"',
    "-----BEGIN RSA PRIVATE KEY-----",
    "AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE",
  ]) {
    assert.throws(() => assertNoCredentials("patch", secret), /appears to capture .*; episodes must never capture repository credentials/, secret.slice(0, 30));
  }
  assert.doesNotThrow(() => assertNoCredentials("pull_request", "https://github.com/unbraind/pm-rl/pull/42"));
  assert.doesNotThrow(() => assertNoCredentials("patch", "+const tokenLimit = config.maxTokens;\n+password_field.setAttribute('type', 'password');\n-contextual line"));
});

test("an episode records the candidate tree identity, links the pull request, and derives the verdict from the pinned extraction", async () => {
  const { root, pmRoot, harness } = await workspace();
  const environment = await gatesEnv(root, pmRoot, harness);
  const resultsFile = writeGateResults(root, [["coverage", 0], ["docstring", 0]]);
  const recorded = resultOf(await harness.runCommand({
    command: "rl episode record",
    pmRoot,
    options: {
      environment,
      candidateTree: "tree_abc123",
      baseCommit: GATES_SPEC.commit,
      pullRequest: "https://github.com/unbraind/pm-rl/pull/42",
      gatesResults: resultsFile,
    },
  }));
  assert.equal(recorded.action, "rl-episode-record");
  assert.equal(recorded.created, true);
  // The host scopes created ids under the extension alias, so the resolved id
  // carries an "rl-" prefix over the content-addressed segment.
  assert.match(recorded.id!, /episode-/);
  assert.equal(recorded.details?.verdict, "pass");
  assert.equal(recorded.details?.candidate_tree, "tree_abc123");
  assert.equal(recorded.details?.pull_request, "https://github.com/unbraind/pm-rl/pull/42");
  assert.equal(recorded.details?.environment_id, environment);

  // The stored body carries the full provenance fence including the PR link.
  const stored = await new PmClient({ pmRoot, author: "pm-rl-test" }).get(recorded.id!, { depth: "deep" });
  assert.match(String(stored.item.body), /pull\/42/);
  assert.match(String(stored.item.body), /tree_abc123/);
  assert.equal(stored.item.environment, environment);

  // A failing gate flips the derived verdict.
  const failing = resultOf(await harness.runCommand({
    command: "rl episode record",
    pmRoot,
    options: {
      environment,
      candidateTree: "tree_def456",
      baseCommit: GATES_SPEC.commit,
      pullRequest: "https://github.com/unbraind/pm-rl/pull/43",
      gatesResults: writeGateResults(root, [["coverage", 0], ["docstring", 2]], "failing.json"),
    },
  }));
  assert.equal(failing.details?.verdict, "fail");
});

test("episode registration is idempotent by full provenance and refuses a mutated environment", async () => {
  const { root, pmRoot, harness, client } = await workspace();
  const environment = await gatesEnv(root, pmRoot, harness);
  const options = {
    environment,
    candidateTree: "tree_abc123",
    baseCommit: GATES_SPEC.commit,
    pullRequest: "https://github.com/unbraind/pm-rl/pull/42",
    gatesResults: writeGateResults(root, [["coverage", 0], ["docstring", 0]]),
  };
  const first = resultOf(await harness.runCommand({ command: "rl episode record", pmRoot, options }));
  const second = resultOf(await harness.runCommand({ command: "rl episode record", pmRoot, options }));
  assert.equal(second.created, false);
  assert.equal(second.id, first.id);

  // A different candidate tree under the same environment is a different episode.
  const third = resultOf(await harness.runCommand({ command: "rl episode record", pmRoot, options: { ...options, candidateTree: "tree_other" } }));
  assert.notEqual(third.id, first.id);

  // Editing the environment's stored body breaks its content identity; recording
  // against it must refuse rather than attribute an episode to a mutated spec.
  // Editing the environment's stored body breaks its content identity; a valid
  // but different gate set (a moved commit) is the realistic edit. Recording
  // against it must refuse rather than attribute an episode to a mutated spec.
  const mutated = { ...GATES_SPEC, commit: "aaaaaaaaabcdef1234567890abcdef1234567890" };
  await client.update(environment, { body: `# mutated\n\n\`\`\`json\n${JSON.stringify(mutated, null, 2)}\n\`\`\``, message: "mutate environment" });
  await assert.rejects(
    harness.runCommand({ command: "rl episode record", pmRoot, options }),
    typedRefusal("environment_was_mutated"),
  );
});

test("recording refuses an episode with neither a candidate tree nor a patch, and unknown or incomplete gate results", async () => {
  const { root, pmRoot, harness } = await workspace();
  const environment = await gatesEnv(root, pmRoot, harness);
  const base = {
    environment,
    baseCommit: GATES_SPEC.commit,
    pullRequest: "https://github.com/unbraind/pm-rl/pull/42",
    gatesResults: writeGateResults(root, [["coverage", 0], ["docstring", 0]]),
  };
  await assert.rejects(
    harness.runCommand({ command: "rl episode record", pmRoot, options: base }),
    typedRefusal("candidate_tree_unrecorded"),
  );

  // Unknown and missing gates are refused at record time, not discovered at replay.
  await assert.rejects(
    harness.runCommand({
      command: "rl episode record",
      pmRoot,
      options: { ...base, candidateTree: "tree_x", gatesResults: writeGateResults(root, [["lint", 0]], "unknown.json") },
    }),
    typedRefusal("unknown_gate_result"),
  );
  await assert.rejects(
    harness.runCommand({
      command: "rl episode record",
      pmRoot,
      options: { ...base, candidateTree: "tree_x", gatesResults: writeGateResults(root, [["coverage", 0]], "partial.json") },
    }),
    typedRefusal("missing_gate_result"),
  );
});

test("recording refuses credentials in the pull request link or the patch content", async () => {
  const { root, pmRoot, harness } = await workspace();
  const environment = await gatesEnv(root, pmRoot, harness);
  const base = {
    environment,
    candidateTree: "tree_abc123",
    baseCommit: GATES_SPEC.commit,
    gatesResults: writeGateResults(root, [["coverage", 0], ["docstring", 0]]),
  };
  await assert.rejects(
    harness.runCommand({
      command: "rl episode record",
      pmRoot,
      options: { ...base, pullRequest: "https://token:ghp_Abcdef12345678901234@github.com/unbraind/pm-rl/pull/42" },
    }),
    typedRefusal("credential_detected"),
  );
  await assert.rejects(
    harness.runCommand({
      command: "rl episode record",
      pmRoot,
      options: { ...base, pullRequest: "https://github.com/unbraind/pm-rl/pull/42", patchFile: writePatch(root, "git fetch https://user:secretPW1@github.com/o/r") },
    }),
    typedRefusal("credential_detected"),
  );
});

test("replay resolves the exact candidate artifact and reproduces the verdict without mutating the episode", async () => {
  const { root, pmRoot, harness, client } = await workspace();
  const environment = await gatesEnv(root, pmRoot, harness);
  const recorded = resultOf(await harness.runCommand({
    command: "rl episode record",
    pmRoot,
    options: {
      environment,
      candidateTree: "tree_abc123",
      baseCommit: GATES_SPEC.commit,
      pullRequest: "https://github.com/unbraind/pm-rl/pull/42",
      gatesResults: writeGateResults(root, [["coverage", 0], ["docstring", 0]]),
    },
  })) as { id: string };
  const before = await client.get(recorded.id, { depth: "deep" });

  const replayed = resultOf(await harness.runCommand({
    command: "rl episode replay",
    pmRoot,
    args: [recorded.id],
    options: {
      candidateTree: "tree_abc123",
      gatesResults: writeGateResults(root, [["docstring", 0], ["coverage", 0]], "replayed.json"),
    },
  }));
  assert.equal(replayed.action, "rl-episode-replay");
  assert.equal(replayed.details?.verdict, "pass");
  assert.equal(replayed.details?.reproduced, true);
  assert.equal(replayed.details?.candidate_tree, "tree_abc123");

  const after = await client.get(recorded.id, { depth: "deep" });
  assert.equal(after.item.body, before.item.body);
  assert.equal(after.item.updated_at, before.item.updated_at);
});

test("replay refuses a foreign candidate tree, a foreign patch, and a changed verdict", async () => {
  const { root, pmRoot, harness } = await workspace();
  const environment = await gatesEnv(root, pmRoot, harness);
  const options = {
    environment,
    baseCommit: GATES_SPEC.commit,
    pullRequest: "https://github.com/unbraind/pm-rl/pull/42",
    gatesResults: writeGateResults(root, [["coverage", 0], ["docstring", 0]]),
  };
  const treeEpisode = resultOf(await harness.runCommand({
    command: "rl episode record", pmRoot, options: { ...options, candidateTree: "tree_abc123" },
  })).id!;
  await assert.rejects(
    harness.runCommand({
      command: "rl episode replay", pmRoot, args: [treeEpisode],
      options: { candidateTree: "tree_other", gatesResults: options.gatesResults },
    }),
    typedRefusal("candidate_tree_mismatch"),
  );

  // A patch-only episode replays through the patch's content hash.
  const patchText = "diff --git a/index.ts b/index.ts\n+export {};";
  const patchEpisode = resultOf(await harness.runCommand({
    command: "rl episode record", pmRoot, options: { ...options, patchFile: writePatch(root, patchText) },
  })).id!;
  const patched = resultOf(await harness.runCommand({
    command: "rl episode replay", pmRoot, args: [patchEpisode],
    options: { patchFile: writePatch(root, patchText, "same.patch"), gatesResults: options.gatesResults },
  }));
  assert.equal(patched.details?.reproduced, true);
  await assert.rejects(
    harness.runCommand({
      command: "rl episode replay", pmRoot, args: [patchEpisode],
      options: { patchFile: writePatch(root, `${patchText}\nmore`, "other.patch"), gatesResults: options.gatesResults },
    }),
    typedRefusal("candidate_patch_mismatch"),
  );

  // Same artifact, different gate outcomes: the verdict does not reproduce.
  await assert.rejects(
    harness.runCommand({
      command: "rl episode replay", pmRoot, args: [treeEpisode],
      options: { candidateTree: "tree_abc123", gatesResults: writeGateResults(root, [["coverage", 1], ["docstring", 0]], "changed.json") },
    }),
    typedRefusal("verdict_changed"),
  );

  // Supplying neither half of the artifact identity is undecidable.
  await assert.rejects(
    harness.runCommand({
      command: "rl episode replay", pmRoot, args: [treeEpisode],
      options: { gatesResults: options.gatesResults },
    }),
    typedRefusal("candidate_tree_unresolved"),
  );
});

test("replay refuses an episode whose stored body carries no candidate-tree identity", async () => {
  const { root, pmRoot, harness, client } = await workspace();
  const environment = await gatesEnv(root, pmRoot, harness);
  // A hand-authored episode body — the reachable path for a malformed record,
  // exactly as for generation specs — stores no tree and no patch.
  const bare = String((await client.create({
    id: "episode-bare",
    title: "hand authored",
    type: "GateEpisode",
    status: "closed",
    closeReason: "hand-authored fixture",
    environment,
    affectedVersion: "0".repeat(64),
    fixedVersion: GATES_SPEC.commit,
    component: GATES_SPEC.repository,
    body: `# episode-bare\n\n\`\`\`json\n${JSON.stringify({
      environment_id: environment,
      environment_spec_hash: "0".repeat(64),
      repository: GATES_SPEC.repository,
      base_commit: GATES_SPEC.commit,
      candidate_tree: null,
      patch_hash: null,
      gate_results: [],
      verdict: "pass",
      pull_request: "https://github.com/unbraind/pm-rl/pull/7",
    }, null, 2)}\n\`\`\``,
  })).item.id);
  await assert.rejects(
    harness.runCommand({
      command: "rl episode replay", pmRoot, args: [bare],
      options: { gatesResults: writeGateResults(root, [["coverage", 0], ["docstring", 0]]) },
    }),
    typedRefusal("candidate_tree_unrecorded"),
  );
});

test("the sim-to-real gap is computed over the paired cohort with denominators stated, and unpaired sides reported as coverage", async () => {
  const { root, pmRoot, harness } = await workspace();
  const environment = await gatesEnv(root, pmRoot, harness);
  const episode = async (tree: string, pr: string, docExit: number): Promise<string> =>
    resultOf(await harness.runCommand({
      command: "rl episode record",
      pmRoot,
      options: {
        environment,
        candidateTree: tree,
        baseCommit: GATES_SPEC.commit,
        pullRequest: `https://github.com/unbraind/pm-rl/pull/${pr}`,
        gatesResults: writeGateResults(root, [["coverage", 0], ["docstring", docExit]], `${tree}-results.json`),
      },
    })).id!;
  const epPassPaired = await episode("t1", "1", 0);
  const epFailPaired = await episode("t2", "2", 3);
  const epUnpaired = await episode("t3", "3", 0);
  const outcome = async (pr: string, merged: boolean): Promise<string> =>
    resultOf(await harness.runCommand({
      command: "rl outcome record",
      pmRoot,
      options: {
        pullRequest: `https://github.com/unbraind/pm-rl/pull/${pr}`,
        merged,
      },
    })).id!;
  const outMerged = await outcome("1", true);
  const outClosed = await outcome("2", false);
  const outUnpaired = await outcome("9", true);
  assert.match(outMerged, /outcome-/);
  assert.match(outClosed, /outcome-/);
  assert.match(outUnpaired, /outcome-/);

  const report = resultOf(await harness.runCommand({ command: "rl simreal gap", pmRoot }));
  assert.equal(report.action, "rl-simreal-gap");
  const paired = report.details?.paired as Record<string, unknown>;
  // Denominators are stated explicitly: two paired episodes, two paired PRs.
  assert.equal(paired.pull_requests, 2);
  assert.equal(paired.episodes, 2);
  assert.equal(paired.sandbox_passes, 1);
  assert.equal(paired.sandbox_pass_rate, 0.5);
  assert.equal(paired.merged_pull_requests, 1);
  assert.equal(paired.merge_rate, 0.5);
  assert.equal(paired.gap, 0);
  // Unpaired candidates are coverage, never folded into a rate.
  assert.deepEqual((report.details?.unpaired_episodes as Array<{ id: string }>).map((row) => row.id), [epUnpaired]);
  assert.deepEqual((report.details?.unpaired_outcomes as Array<{ id: string }>).map((row) => row.id), [outUnpaired]);

  const table = resultOf(await harness.runCommand({ command: "rl simreal gap", pmRoot, global: { json: false } }));
  const output = String(table.details?.output);
  assert.match(output, /sandbox gate-pass rate: 1\/2/);
  assert.match(output, /real merge rate: 1\/2/);
  assert.match(output, /sim-to-real gap: 0\.5000 - 0\.5000 = 0\.0000/);
  assert.match(output, /unpaired episodes \(coverage, excluded from the rate\): 1/);
  assert.match(output, /unpaired outcomes \(coverage, excluded from the rate\): 1/);
});

test("pure gap pairing folds duplicates honestly and renders every denominator", () => {
  const episode = (id: string, pr: string, verdict: "pass" | "fail"): { id: string; spec: EpisodeSpec } => ({
    id,
    spec: {
      environment_id: "env", environment_spec_hash: "h", repository: "r", base_commit: "c",
      candidate_tree: "t", patch_hash: null, gate_results: [], verdict, pull_request: pr,
    },
  });
  const outcome = (id: string, pr: string, merged: boolean): { id: string; spec: OutcomeSpec } => ({
    id, spec: { pull_request: pr, merged },
  });
  const report = buildSimRealGap(
    [episode("e1", "pr-1", "pass"), episode("e2", "pr-1", "pass"), episode("e3", "pr-2", "fail")],
    [outcome("o1", "pr-1", true), outcome("o2", "pr-2", false)],
  );
  // One PR with two paired episodes: the sandbox side counts EPISODES, the real
  // side counts DISTINCT pull requests, and both denominators are stated.
  assert.equal(report.paired.episodes, 3);
  assert.equal(report.paired.pull_requests, 2);
  assert.equal(report.paired.sandbox_passes, 2);
  assert.equal(report.paired.sandbox_pass_rate, 2 / 3);
  assert.equal(report.paired.merged_pull_requests, 1);
  assert.equal(report.paired.merge_rate, 0.5);
  assert.ok(Math.abs((report.paired.gap as number) - (2 / 3 - 0.5)) < 1e-12);
  assert.equal(report.unpaired_episodes.length, 0);
  assert.equal(report.unpaired_outcomes.length, 0);

  const rendered = renderSimRealGap(report);
  assert.match(rendered, /sandbox gate-pass rate: 2\/3 episodes paired/);
  assert.match(rendered, /real merge rate: 1\/2 pull requests paired/);

  // Nothing paired at all: rates stay null instead of pretending zero means measured.
  const empty = buildSimRealGap([episode("e1", "pr-x", "pass")], [outcome("o1", "pr-y", true)]);
  assert.equal(empty.paired.episodes, 0);
  assert.equal(empty.paired.sandbox_pass_rate, null);
  assert.equal(empty.paired.merge_rate, null);
  assert.equal(empty.paired.gap, null);
  assert.deepEqual(empty.unpaired_episodes.map((row) => row.id), ["e1"]);
  assert.deepEqual(empty.unpaired_outcomes.map((row) => row.id), ["o1"]);
});

test("the gap refuses contradictory outcomes for one pull request and unreadable episodes", async () => {
  const { root, pmRoot, harness, client } = await workspace();
  const environment = await gatesEnv(root, pmRoot, harness);
  const options = {
    environment,
    candidateTree: "tree_1",
    baseCommit: GATES_SPEC.commit,
    pullRequest: "https://github.com/unbraind/pm-rl/pull/1",
    gatesResults: writeGateResults(root, [["coverage", 0], ["docstring", 0]]),
  };
  await harness.runCommand({ command: "rl episode record", pmRoot, options });
  await harness.runCommand({ command: "rl outcome record", pmRoot, options: { pullRequest: options.pullRequest, merged: true } });

  // Two outcomes for one PR disagreeing about reality make the merge rate
  // undecidable; the report refuses rather than picking one.
  await harness.runCommand({ command: "rl outcome record", pmRoot, options: { pullRequest: options.pullRequest, merged: false } });
  await assert.rejects(harness.runCommand({ command: "rl simreal gap", pmRoot }), typedRefusal("outcome_conflict"));

  // An episode whose body was never written by pm-rl cannot enter a measurement.
  await client.create({
    id: "episode-unreadable",
    title: "hand authored",
    type: "GateEpisode",
    status: "closed",
    closeReason: "hand-authored fixture",
    body: "no fence here",
  });
  await harness.runCommand({ command: "rl outcome record", pmRoot, options: { pullRequest: "https://github.com/unbraind/pm-rl/pull/2", merged: true } });
  await assert.rejects(harness.runCommand({ command: "rl simreal gap", pmRoot }), typedRefusal("episode_unreadable"));
});

test("gate result parsing refuses a duplicated gate report", () => {
  assert.throws(
    () => parseGateResults(JSON.stringify({ gates: [{ name: "coverage", exit_code: 0 }, { name: "coverage", exit_code: 1 }, { name: "docstring", exit_code: 0 }] }), "results", GATES_SPEC),
    /reports gate "coverage" twice/,
  );
});

test("episode and outcome specification parsing refuses malformed stored bodies", () => {
  const episode = {
    environment_id: "env-1",
    environment_spec_hash: "h",
    repository: "unbraind/pm-rl",
    base_commit: "c",
    candidate_tree: "tree_1",
    patch_hash: null,
    gate_results: [{ name: "docstring", exit_code: 1 }, { name: "coverage", exit_code: 0 }],
    verdict: "fail",
    pull_request: "https://github.com/unbraind/pm-rl/pull/5",
  };
  const parsed = parseEpisodeSpec(JSON.stringify(episode), "e");
  // Results are canonicalized sorted by gate name for stable hashing.
  assert.deepEqual(parsed.gate_results.map((entry) => entry.name), ["coverage", "docstring"]);
  for (const [override, message] of [
    [{ environment_id: "" }, /non-empty string environment_id/],
    [{ candidate_tree: 5 }, /non-empty identity or null/],
    [{ patch_hash: "   " }, /non-empty identity or null/],
    [{ gate_results: {} }, /requires a gate_results array/],
    [{ gate_results: [{ name: "coverage" }] }, /named integer exit codes/],
    [{ verdict: "maybe" }, /verdict of "pass" or "fail"/],
    [{ pull_request: "" }, /non-empty string pull_request/],
  ] as Array<[Partial<Record<string, unknown>>, RegExp]>) {
    assert.throws(() => parseEpisodeSpec(JSON.stringify({ ...episode, ...override }), "e"), message);
  }
  assert.throws(() => parseEpisodeSpec("not-json", "e"), /not valid JSON/);
  assert.throws(() => parseEpisodeSpec("[]", "e"), /one JSON object/);

  assert.deepEqual(parseOutcomeSpec(JSON.stringify({ pull_request: "pr-1", merged: true }), "o"), { pull_request: "pr-1", merged: true });
  for (const [override, message] of [
    [{ merged: "yes" }, /boolean merged/],
    [{ pull_request: "" }, /non-empty string pull_request/],
  ] as Array<[Partial<Record<string, unknown>>, RegExp]>) {
    assert.throws(() => parseOutcomeSpec(JSON.stringify({ pull_request: "pr-1", merged: true, ...override }), "o"), message);
  }
  assert.throws(() => parseOutcomeSpec("not-json", "o"), /not valid JSON/);
  assert.throws(() => parseOutcomeSpec("[]", "o"), /one JSON object/);
});

test("pure gap pairing refuses contradictory outcomes for one pull request", () => {
  assert.throws(
    () => buildSimRealGap([], [
      { id: "o1", spec: { pull_request: "pr-1", merged: true } },
      { id: "o2", spec: { pull_request: "pr-1", merged: false } },
    ]),
    pureRefusal("outcome_conflict"),
  );

  // Two outcomes agreeing on one pull request are one real-side fact recorded
  // twice: no conflict, counted once.
  const agreed = buildSimRealGap(
    [{ id: "e1", spec: { ...episodeSpec(), pull_request: "pr-1" } }],
    [
      { id: "o1", spec: { pull_request: "pr-1", merged: true } },
      { id: "o2", spec: { pull_request: "pr-1", merged: true } },
    ],
  );
  assert.equal(agreed.paired.pull_requests, 1);
  assert.equal(agreed.paired.merge_rate, 1);
});

/** One fully populated episode spec, overridable field-wise. */
function episodeSpec(overrides: Partial<EpisodeSpec> = {}): EpisodeSpec {
  return {
    environment_id: "env",
    environment_spec_hash: "h",
    repository: "r",
    base_commit: "c",
    candidate_tree: "t",
    patch_hash: null,
    gate_results: [],
    verdict: "pass",
    pull_request: "pr",
    ...overrides,
  };
}

test("the rendered gap states when no cohort is paired instead of printing zero rates", () => {
  const rendered = renderSimRealGap(buildSimRealGap([], []));
  assert.match(rendered, /sandbox gate-pass rate: n\/a \(0\/0 episodes paired\)/);
  assert.match(rendered, /real merge rate: n\/a \(0\/0 pull requests paired\)/);
  assert.match(rendered, /sim-to-real gap: undefined \(no paired cohort\)/);
});

test("gate environment registration is idempotent and refuses identity collisions and unreadable environments", async () => {
  const { root, pmRoot, harness, client } = await workspace();
  const options = { file: writeGatesEnv(root) };
  const first = resultOf(await harness.runCommand({ command: "rl episode env register", pmRoot, options }));
  const second = resultOf(await harness.runCommand({ command: "rl episode env register", pmRoot, options }));
  assert.equal(second.created, false);
  assert.equal(second.id, first.id);

  // An Environment squatting on the derived content id with a different hash is
  // an identity collision: registration refuses rather than trusting the id.
  // A fresh workspace, because in this one the genuine environment owns the id.
  const squatted = await workspace();
  const requestedId = `env-${idSegment(GATES_SPEC.name)}-${idSegment(GATES_SPEC.version)}-${hashJson(GATES_SPEC as unknown as JsonValue).slice(0, 12)}`;
  await squatted.client.create({
    id: requestedId,
    title: "squatter",
    type: "Environment",
    status: "open",
    affectedVersion: "tampered-hash",
    fixedVersion: "1",
  });
  await assert.rejects(
    squatted.harness.runCommand({ command: "rl episode env register", pmRoot: squatted.pmRoot, options: { file: writeGatesEnv(squatted.root) } }),
    typedRefusal("environment_identity_collision"),
  );

  // An environment without a recorded identity cannot support episodes.
  const noHash = String((await client.create({
    title: "no hash",
    type: "Environment",
    status: "open",
    affectedVersion: "",
    fixedVersion: "1",
  })).item.id);
  await assert.rejects(
    harness.runCommand({
      command: "rl episode record",
      pmRoot,
      options: {
        environment: noHash,
        candidateTree: "tree_x",
        baseCommit: GATES_SPEC.commit,
        pullRequest: "https://github.com/unbraind/pm-rl/pull/8",
        gatesResults: writeGateResults(root, [["coverage", 0], ["docstring", 0]], "nh.json"),
      },
    }),
    typedRefusal("environment_missing_hash"),
  );

  // An environment whose body has no specification fence is likewise refused.
  const noFence = String((await client.create({
    id: "env-nofence",
    title: "no fence",
    type: "Environment",
    status: "open",
    affectedVersion: "somehash",
    fixedVersion: "1",
    body: "# no specification here",
  })).item.id);
  await assert.rejects(
    harness.runCommand({
      command: "rl episode record",
      pmRoot,
      options: {
        environment: noFence,
        candidateTree: "tree_x",
        baseCommit: GATES_SPEC.commit,
        pullRequest: "https://github.com/unbraind/pm-rl/pull/8",
        gatesResults: writeGateResults(root, [["coverage", 0], ["docstring", 0]], "nf.json"),
      },
    }),
    typedRefusal("environment_missing_spec"),
  );
});

test("episodes and outcomes refuse identity collisions, and outcomes are idempotent and unreadable-proof", async () => {
  const { root, pmRoot, harness, client } = await workspace();
  const environment = await gatesEnv(root, pmRoot, harness);
  const options = {
    environment,
    candidateTree: "tree_abc123",
    baseCommit: GATES_SPEC.commit,
    pullRequest: "https://github.com/unbraind/pm-rl/pull/42",
    gatesResults: writeGateResults(root, [["coverage", 0], ["docstring", 0]]),
  };
  const recorded = resultOf(await harness.runCommand({ command: "rl episode record", pmRoot, options }));
  // Tamper with the stored identity, then re-record: the same content id now
  // carries different provenance, which is a collision, not a replay.
  await client.update(recorded.id!, { affectedVersion: "tampered" });
  await assert.rejects(
    harness.runCommand({ command: "rl episode record", pmRoot, options }),
    typedRefusal("episode_identity_collision"),
  );

  const outcomeOptions = { pullRequest: "https://github.com/unbraind/pm-rl/pull/42", merged: true };
  const outcomeFirst = resultOf(await harness.runCommand({ command: "rl outcome record", pmRoot, options: outcomeOptions }));
  const outcomeSecond = resultOf(await harness.runCommand({ command: "rl outcome record", pmRoot, options: outcomeOptions }));
  assert.equal(outcomeSecond.created, false);
  assert.equal(outcomeSecond.id, outcomeFirst.id);
  await client.update(outcomeFirst.id!, { affectedVersion: "tampered" });
  await assert.rejects(
    harness.runCommand({ command: "rl outcome record", pmRoot, options: outcomeOptions }),
    typedRefusal("outcome_identity_collision"),
  );

  // An outcome whose body was never written by pm-rl cannot enter the cohort.
  await client.create({
    id: "outcome-unreadable",
    title: "hand authored",
    type: "MergeOutcome",
    status: "closed",
    closeReason: "hand-authored fixture",
    body: "no fence",
  });
  await assert.rejects(harness.runCommand({ command: "rl simreal gap", pmRoot }), typedRefusal("outcome_unreadable"));
});
