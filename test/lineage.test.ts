/** Recursive-self-improvement lineage: pure provenance math and the generation/lineage commands. */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { PmClient, type GetResult } from "@unbrained/pm-cli/sdk/core";
import { init } from "@unbrained/pm-cli/sdk/runtime";
import { createExtensionTestHarness, type ExtensionTestHarness } from "@unbrained/pm-cli/sdk/testing";

import extension, {
  environmentInvalidationReason,
  hashJson,
  RL_ITEM_TYPES,
  type JsonValue,
  type RlCommandResult,
} from "../index.ts";
import {
  buildLineageAncestry,
  DEFAULT_GAP_WINDOW,
  directionAwareGap,
  findContaminationPath,
  GENERATION_EDGE_TYPES,
  gapDeltas,
  isGapWidening,
  parseApprovalSpec,
  parseGenerationSpec,
  parseScoreRecord,
  renderContaminationPath,
  renderLineageTable,
  type AncestryEntry,
  type GenerationSpec,
  type LineageView,
  type ScoreRecord,
} from "../lineage.ts";

const roots: string[] = [];

after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

/** A score record attributed to one standard, used as a fixture across score tests. */
function score(value: number, direction: "maximize" | "minimize" = "maximize", scale = 1, evaluationContext = "eval-ctx"): ScoreRecord {
  return {
    objective: "episode_return",
    objective_version: "obj-v1",
    evaluation_context: evaluationContext,
    seed_set: "seed-set-1",
    direction,
    scale,
    value,
  };
}

/** A full generation spec with seeded defaults, overridden only where a pure test varies a field. */
function spec(overrides: Partial<GenerationSpec> = {}): GenerationSpec {
  return {
    base_checkpoint: "ckpt",
    policy: "",
    collection_runs: [],
    training_config: {},
    environment_version: "",
    reward_spec_version: "",
    parent: null,
    seed: true,
    promoted: false,
    approval: null,
    proxy_score: null,
    held_out_score: null,
    gap: null,
    promotion_evidence: null,
    ...overrides,
  };
}

/** Extract a successful structured command result, failing loudly on an unhandled command. */
function resultOf(run: { result?: unknown; handled: boolean }): RlCommandResult {
  assert.equal(run.handled, true, JSON.stringify(run));
  return run.result as RlCommandResult;
}

/** A complete generation spec body fence plus its content hash, for direct tracker seeding. */
function generationBody(spec: object): { body: string; hash: string } {
  return { body: `# generation\n\n\`\`\`json\n${JSON.stringify(spec, null, 2)}\n\`\`\``, hash: hashJson(spec as unknown as JsonValue) };
}

/** The seed's policy is empty by registration; a real seed model has an identity its children's runs reference. */
function seedSpec(baseCheckpoint: string, policy: string): Record<string, unknown> {
  return {
    base_checkpoint: baseCheckpoint,
    policy,
    collection_runs: [],
    training_config: {},
    environment_version: "",
    reward_spec_version: "",
    parent: null,
    seed: true,
    promoted: false,
    approval: null,
    proxy_score: null,
    held_out_score: null,
    gap: null,
    promotion_evidence: null,
  };
}

/** Create a real initialized tracker and activate the extension through the host. */
async function workspace(): Promise<{
  root: string;
  pmRoot: string;
  client: PmClient;
  harness: ExtensionTestHarness;
}> {
  const root = mkdtempSync(join(tmpdir(), "pm-rl-lineage-"));
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
  return { root, pmRoot: initialized.path, client, harness };
}

/** Register an environment and return its content-addressed id. */
async function registerEnv(
  harness: ExtensionTestHarness,
  pmRoot: string,
  root: string,
  name: string,
  version = "1",
  reward: JsonValue = { goal: 10 },
): Promise<string> {
  const file = join(root, `${name}.json`);
  writeFileSync(file, JSON.stringify({ name, version, task_suite: ["reach-goal"], reward_specification: reward }));
  return resultOf(await harness.runCommand({ command: "rl env register", pmRoot, options: { file } })).id!;
}

/**
 * Register the seed generation and return its id. An optional policy is passed
 * through the published `--policy` flag rather than written behind the command
 * surface, so the seed's children's collection runs can reference it.
 */
async function registerSeed(harness: ExtensionTestHarness, pmRoot: string, id: string, baseCheckpoint: string, policy?: string): Promise<string> {
  return resultOf(await harness.runCommand({ command: "rl generation register", pmRoot, args: [id], options: policy === undefined ? { baseCheckpoint } : { baseCheckpoint, policy } })).id!;
}

/** Write a promotion scores file with proxy and held-out records. */
function writeScores(root: string, proxyValue: number, heldOutContext: string, heldOutValue: number): string {
  const path = join(root, "scores.json");
  writeFileSync(path, JSON.stringify({
    proxy_score: { objective: "episode_return", objective_version: "obj-v1", evaluation_context: "proxy-ctx", seed_set: "seed-set-1", direction: "maximize", scale: 1, value: proxyValue },
    held_out_score: { objective: "episode_return", objective_version: "obj-v1", evaluation_context: heldOutContext, seed_set: "seed-set-1", direction: "maximize", scale: 1, value: heldOutValue },
  }));
  return path;
}

/**
 * The SDK types a listed item's `id` as optional; a real tracker always fills it under the
 * default projection, so the production guard that skips id-less rows cannot be reached by
 * any real item. This proxy delegates every operation to a real client and only appends one
 * id-less Generation row to Generation list results, so that guard runs for real against the
 * exact shape it exists to defend — never faking the lineage logic under test.
 */
function clientWithIdlessGenerationRow(real: PmClient): PmClient {
  return new Proxy(real, {
    get(target, property, receiver) {
      if (property === "list") {
        const delegated = target.list.bind(target) as (options?: unknown) => ReturnType<PmClient["list"]>;
        return (options?: unknown) => {
          const result = delegated(options);
          if ((options as { type?: string } | undefined)?.type !== "Generation") return result;
          const augmented = result.then((value) => {
            const record = value as { items?: readonly unknown[] };
            return { ...value, items: [...(record.items ?? []), { title: "idless-generation", type: "Generation", status: "open" }] };
          });
          return augmented as ReturnType<PmClient["list"]>;
        };
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? (value as (...arguments_: unknown[]) => unknown).bind(target) : value;
    },
  }) as PmClient;
}

/**
 * Wrap a real client so `close` fails, leaving the promoting body write applied.
 *
 * This reproduces the one durable partial state a promotion can reach: the body
 * already reads as promoted while the item is still open. Every other call is
 * delegated to the real client, so the workspace and its history stay real.
 */
/**
 * A client whose `close` fails, and which lands ONE concurrent body edit on the
 * first `getTypedItem`-style read of the target — standing in for a peer writer
 * that commits between this caller's pre-lock read and its acquisition of the
 * writer lock.
 */
function clientWithConcurrentEditThenFailingClose(real: PmClient, targetId: string, concurrentBody: string, options: { failClose?: boolean; editId?: string; triggerId?: string } = {}): PmClient {
  const failClose = options.failClose ?? true;
  let edited = false;
  return new Proxy(real, {
    get(target, property, receiver) {
      if (property === "close" && failClose) {
        return async () => {
          throw new Error("close failed after the promoting write");
        };
      }
      if (property === "get") {
        return async (...arguments_: unknown[]) => {
          const result = await (Reflect.get(target, "get", receiver) as (...a: unknown[]) => Promise<GetResult>).apply(target, arguments_);
          if (!edited && arguments_[0] === (options.triggerId ?? targetId)) {
            edited = true;
            await real.update(options.editId ?? targetId, { body: concurrentBody, message: "Concurrent peer edit" });
          }
          return result;
        };
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? (value as (...arguments_: unknown[]) => unknown).bind(target) : value;
    },
  }) as PmClient;
}

/** A client whose `close` fails and whose subsequent revert `update` also fails. */
function clientWithFailingCloseAndFailingRevert(real: PmClient): PmClient {
  let promotingWriteDone = false;
  return new Proxy(real, {
    get(target, property, receiver) {
      if (property === "close") {
        return async () => {
          throw new Error("close failed after the promoting write");
        };
      }
      if (property === "update") {
        return async (...arguments_: unknown[]) => {
          if (promotingWriteDone) throw new Error("revert update failed too");
          promotingWriteDone = true;
          return (Reflect.get(target, "update", receiver) as (...a: unknown[]) => Promise<unknown>).apply(target, arguments_);
        };
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? (value as (...arguments_: unknown[]) => unknown).bind(target) : value;
    },
  }) as PmClient;
}

function clientWithFailingClose(real: PmClient): PmClient {
  return new Proxy(real, {
    get(target, property, receiver) {
      if (property === "close") {
        return async () => {
          throw new Error("close failed after the promoting write");
        };
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? (value as (...arguments_: unknown[]) => unknown).bind(target) : value;
    },
  }) as PmClient;
}

/** A host SDK whose client is the given real client; the production commands read only `context.sdk.client`. */
type HostSdk = NonNullable<Parameters<ExtensionTestHarness["runCommand"]>[0]["sdk"]>;
function sdkWith(client: PmClient): HostSdk {
  return { client } as unknown as HostSdk;
}

// -------------------------------------------------------------------------------------------------
// Pure lineage math: every parser, the gap formula, contamination traversal, and the renderer.
// -------------------------------------------------------------------------------------------------

test("parseScoreRecord accepts attributed scores and refuses every incomparable one", () => {
  assert.deepEqual(parseScoreRecord(score(7), "label"), score(7));
  assert.deepEqual(parseScoreRecord(score(3, "minimize", 2), "label").direction, "minimize");
  for (const [value, message] of [
    [null, /one JSON object/],
    [[], /one JSON object/],
    ["text", /one JSON object/],
    [{ ...score(1), objective: 5 }, /requires a string objective/],
    [{ ...score(1), objective_version: "" }, /requires a non-empty objective_version/],
    [{ ...score(1), evaluation_context: "  " }, /requires a non-empty evaluation_context/],
    [{ ...score(1), seed_set: 1 }, /requires a string seed_set/],
    [{ ...score(1), direction: "sideways" }, /direction of "maximize" or "minimize"/],
    [{ ...score(1), scale: "big" }, /positive finite scale/],
    [{ ...score(1), scale: 0 }, /positive finite scale/],
    [{ ...score(1), scale: Number.POSITIVE_INFINITY }, /positive finite scale/],
    [{ ...score(1), value: "x" }, /finite value/],
    [{ ...score(1), value: Number.NaN }, /finite value/],
  ] as Array<[unknown, RegExp]>) {
    assert.throws(() => parseScoreRecord(value, "label"), message);
  }
});

test("parseGenerationSpec accepts the seed and a full candidate and refuses every malformed provenance", () => {
  const seedText = JSON.stringify(seedSpec("ckpt-0", ""));
  assert.equal(parseGenerationSpec(seedText, "g").seed, true);
  const candidate = spec({ base_checkpoint: "ckpt-1", policy: "p1", collection_runs: ["run-1"], training_config: { lr: 0.1 }, environment_version: "env-1", reward_spec_version: "reward-1", parent: "gen-0", seed: false });
  const parsed = parseGenerationSpec(JSON.stringify(candidate), "g");
  assert.equal(parsed.parent, "gen-0");
  assert.deepEqual(parsed.collection_runs, ["run-1"]);
  assert.equal((parsed.training_config as { lr?: number }).lr, 0.1);
  // A complete valid record carrying every optional field parses, so later checks are reachable.
  const fullBase = { base_checkpoint: "b", policy: "x", collection_runs: ["r"], training_config: {}, environment_version: "e", reward_spec_version: "rw", parent: "p", seed: false, promoted: false, approval: null, proxy_score: null, held_out_score: null, gap: null, promotion_evidence: null };
  for (const [text, message] of [
    ["not-json", /not valid JSON/],
    ["[]", /one JSON object/],
    [JSON.stringify({ base_checkpoint: "b", parent: null, seed: false }), /collection_runs array of strings/],
    [JSON.stringify({ base_checkpoint: "b", collection_runs: [1], parent: null, seed: false }), /collection_runs array of strings/],
    [JSON.stringify({ base_checkpoint: "b", collection_runs: [], parent: 5, seed: false }), /parent to be a string or null/],
    [JSON.stringify({ base_checkpoint: "b", collection_runs: [], parent: "p", seed: true }), /declares seed but has a parent/],
    [JSON.stringify({ base_checkpoint: "b", collection_runs: [], parent: null, seed: false }), /non-empty parent for a non-seed/],
    [JSON.stringify({ base_checkpoint: "b", collection_runs: [], parent: "  ", seed: false }), /non-empty parent for a non-seed/],
    [JSON.stringify({ base_checkpoint: "b", collection_runs: [], parent: "p", seed: false }), /non-empty policy for a non-seed/],
    [JSON.stringify({ base_checkpoint: "b", collection_runs: [], parent: "p", policy: "x", seed: false }), /non-empty environment_version for a non-seed/],
    [JSON.stringify({ base_checkpoint: "b", collection_runs: [], parent: "p", policy: "x", environment_version: "e", seed: false }), /non-empty reward_spec_version for a non-seed/],
    [JSON.stringify({ base_checkpoint: "b", collection_runs: [], parent: "p", policy: "x", environment_version: "e", reward_spec_version: "r", seed: false }), /at least one collection run/],
    [JSON.stringify({ ...fullBase, approval: 3 }), /approval to be a string or null/],
    [JSON.stringify({ ...fullBase, gap: "wide" }), /gap to be a number or null/],
    [JSON.stringify({ ...fullBase, promotion_evidence: 5 }), /promotion_evidence to be a string or null/],
  ] as Array<[string, RegExp]>) {
    assert.throws(() => parseGenerationSpec(text, "g"), message);
  }
  // The promotion invariant: approval, proxy_score, held_out_score and gap are
  // non-null EXACTLY when promoted is true. A promoted record carrying all four
  // parses; one missing any of them is refused.
  const promotedBase = { base_checkpoint: "b", policy: "x", collection_runs: ["r"], training_config: {}, environment_version: "e", reward_spec_version: "rw", parent: "p", seed: false, promoted: true, approval: "a", proxy_score: score(2), held_out_score: score(3), gap: 1, promotion_evidence: "ev" };
  const promoted = parseGenerationSpec(JSON.stringify(promotedBase), "g");
  assert.equal(promoted.promoted, true);
  assert.equal(promoted.proxy_score?.value, 2);
  assert.equal(promoted.held_out_score?.value, 3);
  assert.equal(promoted.gap, 1);
  assert.equal(promoted.approval, "a");
  // A promoted record missing any evidence field is refused.
  for (const field of ["approval", "proxy_score", "held_out_score", "gap"] as const) {
    const breaking = { ...promotedBase, [field]: null };
    assert.throws(() => parseGenerationSpec(JSON.stringify(breaking), "g"), /promoted but is missing promotion evidence/);
  }
  // An unpromoted record carrying stale evidence is refused — it would let two
  // consumers disagree about whether the record counts as promoted.
  for (const field of ["approval", "proxy_score", "held_out_score", "gap"] as const) {
    const breaking = { ...promotedBase, promoted: false, [field]: field === "approval" ? "a" : field === "gap" ? 1 : score(2), approval: field === "approval" ? "a" : null, proxy_score: field === "proxy_score" ? score(2) : null, held_out_score: field === "held_out_score" ? score(2) : null, gap: field === "gap" ? 1 : null };
    assert.throws(() => parseGenerationSpec(JSON.stringify(breaking), "g"), /not promoted but carries promotion evidence/);
  }
  // An ABSENT gap key is not the same as an explicit null to `===` , and the
  // invariant compares with `=== null`. Both directions must treat them alike.
  const promotedNoGapKey: Record<string, unknown> = { ...promotedBase };
  delete promotedNoGapKey["gap"];
  assert.throws(() => parseGenerationSpec(JSON.stringify(promotedNoGapKey), "g"), /promoted but is missing promotion evidence/);
  const candidateNoGapKey: Record<string, unknown> = { ...promotedBase, promoted: false, approval: null, proxy_score: null, held_out_score: null, promotion_evidence: null };
  delete candidateNoGapKey["gap"];
  // A padded parent must normalize at parse time. The stored value is compared
  // by strict equality both for ancestry lookup and for head exclusion, so
  // storing " gen-0 " would fail to resolve its parent AND fail to exclude
  // gen-0 from the head set - the same padded-identity class as the
  // contamination gate bypass fixed earlier in this PR.
  const paddedParent = { ...candidate, parent: "  gen-0  " };
  assert.equal(parseGenerationSpec(JSON.stringify(paddedParent), "g").parent, "gen-0");
  // A seed body legitimately omits the parent key. Before `parent` collapsed
  // `undefined` to null like every other optional field, that body was refused
  // as invalid_parent with a message saying parent must be a string or null -
  // reporting a type error for a field whose absence IS null.
  const seedNoParentKey: Record<string, unknown> = { ...spec({ seed: true, parent: null, policy: "", collection_runs: [], environment_version: "", reward_spec_version: "" }) };
  delete seedNoParentKey["parent"];
  assert.equal(parseGenerationSpec(JSON.stringify(seedNoParentKey), "g").parent, null);
  // F5 regression: a blank or whitespace-only parent string normalizes to null
  // BEFORE the seed-with-parent check. A seed body carrying `parent: "   "` is
  // equivalent to one that omits the key — it must NOT be refused as
  // seed_with_parent. A non-seed body with a blank parent is still refused as
  // missing_parent, because the normalized null is not a usable parent.
  assert.equal(parseGenerationSpec(JSON.stringify({ ...spec({ seed: true, parent: null }), parent: "   " }), "g").parent, null);
  assert.equal(parseGenerationSpec(JSON.stringify({ ...spec({ seed: true, parent: null }), parent: "" }), "g").parent, null);
  // A NON-seed body missing the key must still be refused - but for the reason
  // that is true of it (no parent) rather than for a type it never violated.
  const candidateNoParentKey: Record<string, unknown> = { ...candidate };
  delete candidateNoParentKey["parent"];
  assert.throws(() => parseGenerationSpec(JSON.stringify(candidateNoParentKey), "g"), /requires a non-empty parent for a non-seed/);
  // The approval is the other stored identity compared by strict equality, and
  // the comparison is the one bounding the recursive promotion budget. A
  // promoted record storing "  a  " matches no approval id, so it consumes none
  // of a's budget while still counting as promoted everywhere else.
  assert.equal(parseGenerationSpec(JSON.stringify({ ...promotedBase, approval: "  a  " }), "g").approval, "a");
  // collection_runs was the last stored identity list left un-normalized. It
  // lives inside the JSON fence, which pm treats as opaque body text and does
  // NOT normalize, so unlike the Run's typed `environment` field a padded entry
  // here IS reachable — and each entry is resolved by strict id lookup during
  // the ancestry walk, so it would resolve nothing and quietly degrade the
  // contamination graph.
  assert.deepEqual(parseGenerationSpec(JSON.stringify({ ...promotedBase, collection_runs: ["  run-a  ", "run-b"] }), "g").collection_runs, ["run-a", "run-b"]);
  assert.throws(() => parseGenerationSpec(JSON.stringify({ ...promotedBase, collection_runs: ["run-a", "   "] }), "g"), /collection run id to be a non-empty identity/);
  // A blank approval is the same bypass without the padding: it is non-null, so
  // it satisfies the promotion-evidence invariant above, and it equals no
  // approval id. Storing an identity that names nothing is refused outright.
  for (const blank of ["", "   "]) {
    assert.throws(() => parseGenerationSpec(JSON.stringify({ ...promotedBase, approval: blank }), "g"), /approval to be a non-empty identity/);
  }
  // promotion_evidence is the other optional field the renderer reads as a
  // boolean promotion state, so an absent key must normalize to null too.
  const candidateNoEvidenceKey: Record<string, unknown> = { ...candidateNoGapKey };
  delete candidateNoEvidenceKey["promotion_evidence"];
  assert.equal(parseGenerationSpec(JSON.stringify(candidateNoEvidenceKey), "g").promotion_evidence, null);
  // An unpromoted record with no gap key carries no evidence and must be accepted,
  // not refused for a field it does not have.
  assert.equal(parseGenerationSpec(JSON.stringify(candidateNoGapKey), "g").gap, null);
});

test("parseApprovalSpec treats the count as permitted promotions and refuses non-counts", () => {
  assert.equal(parseApprovalSpec(JSON.stringify({ permitted_promotions: 0 }), "a").permitted_promotions, 0);
  assert.equal(parseApprovalSpec(JSON.stringify({ permitted_promotions: 4 }), "a").permitted_promotions, 4);
  for (const [text, message] of [
    ["not-json", /not valid JSON/],
    ["[]", /one JSON object/],
    [JSON.stringify({}), /non-negative integer permitted_promotions/],
    [JSON.stringify({ permitted_promotions: "2" }), /non-negative integer permitted_promotions/],
    [JSON.stringify({ permitted_promotions: 2.5 }), /non-negative integer permitted_promotions/],
    [JSON.stringify({ permitted_promotions: -1 }), /non-negative integer permitted_promotions/],
  ] as Array<[string, RegExp]>) {
    assert.throws(() => parseApprovalSpec(text, "a"), message);
  }
});

test("the direction-aware gap is positive when the proxy leads, regardless of optimization direction", () => {
  assert.equal(directionAwareGap(score(10), score(8)), 2);
  // A minimize objective's capability is its negation, so a lower held-out value is higher capability.
  const minimizeProxy = score(2, "minimize");
  const minimizeHeldOut = score(8, "minimize");
  assert.equal(directionAwareGap(minimizeProxy, minimizeHeldOut), (-2) - (-8));
  // Scores normalize to their declared scales before subtraction.
  assert.equal(directionAwareGap(score(10, "maximize", 5), score(8, "maximize", 2)), 2 - 4);
  // Incomparable scores are refused: differing objective, version, or direction
  // would yield a number that is not a gap (or add capabilities instead of subtracting).
  assert.throws(() => directionAwareGap({ ...score(10), objective: "loss" }, score(8)), /not comparable.*objective.*episode_return/);
  assert.throws(() => directionAwareGap({ ...score(10), objective_version: "obj-v2" }, score(8)), /not comparable.*objective_version/);
  assert.throws(() => directionAwareGap(score(10, "maximize"), score(8, "minimize")), /not comparable.*direction/);
  // A combined difference names every differing field.
  assert.throws(
    () => directionAwareGap({ ...score(10, "minimize"), objective: "loss", objective_version: "obj-v2" }, score(8)),
    /not comparable.*objective.*objective_version.*direction/,
  );
});

test("gap deltas align with their gaps and start null for the first promotion", () => {
  assert.deepEqual(gapDeltas([null, 1, 3, 3]), [null, null, 2, 0]);
  assert.deepEqual(gapDeltas([]), []);
  assert.deepEqual(gapDeltas([null]), [null]);
});

test("isGapWidening requires strictly increasing gaps over the full window", () => {
  assert.equal(isGapWidening([1, 2, 3], 3), true);
  assert.equal(isGapWidening([null, 1, 2, 3], 3), true);
  assert.equal(isGapWidening([1, 2], 3), false);
  assert.equal(isGapWidening([1, 2, 2], 3), false);
  assert.equal(isGapWidening([1, 3, 2], 3), false);
  // A trend needs at least two points: a window below 2 never reports widening.
  assert.equal(isGapWidening([1], 1), false);
  assert.equal(isGapWidening([1, 2], 1), false);
  assert.equal(isGapWidening([1, 2], 0), false);
  // Two points over a window of 2 is a real comparison and can widen.
  assert.equal(isGapWidening([1, 2], 2), true);
  assert.equal(isGapWidening([2, 1], 2), false);
});

/**
 * Adversarial: try to walk a contaminated candidate PAST the refusal by padding
 * its environment identity with whitespace.
 *
 * This is deliberately shaped as an attempt to defeat the gate rather than as a
 * proof that the gate fires. `findContaminationPath` decides overlap by strict
 * string equality, so before `asString` returned its trimmed value, a spec
 * declaring `" env-eval "` parsed happily and then never matched `"env-eval"` —
 * the contamination refusal passed for a candidate whose training data does
 * reach the evaluation set. A space defeated the gate.
 *
 * The spec is built by PARSING a document rather than by constructing the object
 * literal, because normalization happens at parse time and a hand-built literal
 * would bypass the very code path under test.
 */
test("a padded environment identity cannot slip past the contamination refusal", () => {
  const padded = parseGenerationSpec(
    JSON.stringify(
      spec({
        environment_version: "  env-eval\t",
        reward_spec_version: "reward-1",
        collection_runs: ["run-1"],
        policy: "p1",
        seed: false,
        parent: "gen-0",
      }),
    ),
    "padded",
  );
  assert.equal(padded.environment_version, "env-eval", "parse must normalize the identity");

  const found = findContaminationPath(
    [{ id: "gen-c1", spec: padded, runEnvironments: new Map() }],
    "env-eval",
  );
  assert.ok(found, "a padded identity must still be caught by the contamination refusal");
  assert.equal(found.overlap, "env-eval");
});

test("findContaminationPath follows environment and collection-run edges and is decided on identity", () => {
  const runEnvs = (entries: Array<[string, string]>) => new Map(entries);
  const envVersion = (environmentVersion: string, runs: Array<[string, string]> = []): AncestryEntry => ({
    id: "gen-c1",
    spec: spec({ environment_version: environmentVersion, collection_runs: runs.map(([runId]) => runId) }),
    runEnvironments: runEnvs(runs),
  });
  // Direct environment-version overlap produces a single-hop path.
  const direct = findContaminationPath([envVersion("env-eval")], "env-eval");
  assert.equal(direct?.overlap, "env-eval");
  assert.equal(renderContaminationPath(direct!), "gen-c1 →[environment_version]→ env-eval");
  // Collection-run overlap produces a multi-hop path, walking runs in sorted id order.
  const viaRun = findContaminationPath([envVersion("env-train", [["run-b", "env-eval"]])], "env-eval");
  assert.equal(viaRun?.overlap, "env-eval");
  assert.equal(renderContaminationPath(viaRun!), "gen-c1 →[collection_run]→ run-b →[environment_version]→ env-eval");
  // Both runs reach the evaluation set, so only the SORT decides which is
  // reported. With just one matching run the assertion would hold under
  // insertion order too, and removing the sort() in findContaminationPath
  // would fail nothing.
  const viaRunHop = findContaminationPath([envVersion("env-train", [["run-b", "env-eval"], ["run-a", "env-eval"]])], "env-eval");
  assert.ok(
    renderContaminationPath(viaRunHop!).includes("→[collection_run]→ run-a"),
    "the lexicographically first matching run id must be the one reported",
  );
  // No overlap returns null.
  assert.equal(findContaminationPath([envVersion("env-train", [["run-a", "env-other"]])], "env-eval"), null);
  // A match deeper in the ancestry reaches it over a parent hop, exercising the non-start via.
  const twoGen: AncestryEntry[] = [
    { id: "gen-c1", spec: spec({ environment_version: "env-train", collection_runs: [] }), runEnvironments: new Map() },
    { id: "gen-seed", spec: spec({ environment_version: "env-eval" }), runEnvironments: new Map() },
  ];
  const deep = findContaminationPath(twoGen, "env-eval");
  assert.equal(deep?.overlap, "env-eval");
  assert.equal(renderContaminationPath(deep!), "gen-c1 →[parent]→ gen-seed →[environment_version]→ env-eval");
  // An empty held-out environment never matches even when a generation recorded an empty one.
  const seedOnly: AncestryEntry = { id: "gen-seed", spec: spec(), runEnvironments: new Map() };
  assert.equal(findContaminationPath([envVersion(""), seedOnly], ""), null);
});

test("renderLineageTable renders one row per generation, with deltas, evidence, and findings", () => {
  const view: LineageView = {
    ancestries: [
      {
        head: "gen-c1",
        rows: [
          { id: "gen-seed", seed: true, promoted: false, base_checkpoint: "ckpt-0", collection_runs: [], proxy_score: null, held_out_score: null, gap: null, gap_delta: null, approval: null, promotion_evidence: null, invalidated: null },
          { id: "gen-c1", seed: false, promoted: true, base_checkpoint: "ckpt-1", collection_runs: ["run-1"], proxy_score: 10, held_out_score: 8, gap: 2, gap_delta: 2, approval: "approval-1", promotion_evidence: "rose on held-out", invalidated: null },
        ],
        findings: ["gap widening over last 3 promotions"],
      },
      {
        head: "gen-d1",
        rows: [
          { id: "gen-dseed", seed: true, promoted: false, base_checkpoint: "ckpt-0", collection_runs: [], proxy_score: null, held_out_score: null, gap: null, gap_delta: null, approval: null, promotion_evidence: null, invalidated: null },
          { id: "gen-d1", seed: false, promoted: true, base_checkpoint: "ckpt-9", collection_runs: [], proxy_score: 5, held_out_score: 7, gap: -2, gap_delta: -2, approval: "approval-d", promotion_evidence: "fell back", invalidated: "environment was edited" },
        ],
        findings: [],
      },
    ],
  };
  const table = renderLineageTable(view);
  assert.match(table, /head: gen-c1/);
  assert.match(table, /gen-seed \| seed \|/);
  assert.match(table, /gen-c1 \| generation \| base=ckpt-1 .* delta=\+2\.0000 .* approval=approval-1 .* evidence=rose on held-out \| promoted/);
  assert.match(table, /gen-c1 .* runs=run-1/, "the rendered row must include the collection run ids");
  assert.match(table, /findings: gap widening over last 3 promotions/);
  assert.match(table, /gen-d1 .* delta=-2\.0000 .* environment was edited/);
  assert.match(table, /head: gen-d1/);
});

test("buildLineageAncestry refuses an empty ancestry rather than dereferencing undefined", () => {
  // Unreachable from the command path, because buildAncestry always returns at
  // least the head it was asked to walk from — but this function is exported,
  // so it is tested at its own boundary. A non-null assertion here would turn a
  // caller's mistake into a TypeError from inside the renderer instead of an
  // expected error naming what was wrong.
  assert.throws(() => buildLineageAncestry([], new Map(), DEFAULT_GAP_WINDOW), /at least the head generation/);
});

test("buildLineageAncestry computes deltas, surfaces widening, and marks invalidated generations", () => {
  const entries: AncestryEntry[] = [
    { id: "gen-seed", spec: spec({ base_checkpoint: "ckpt-0", gap: null }), runEnvironments: new Map() },
    { id: "gen-c1", spec: spec({ base_checkpoint: "ckpt-1", environment_version: "env-1", gap: 1, promoted: true, approval: "a", promotion_evidence: "first" }), runEnvironments: new Map() },
    { id: "gen-c2", spec: spec({ base_checkpoint: "ckpt-2", environment_version: "env-1", gap: 2, promoted: true, approval: "a", promotion_evidence: "second" }), runEnvironments: new Map() },
    { id: "gen-c3", spec: spec({ base_checkpoint: "ckpt-3", environment_version: "env-edited", gap: 3, promoted: true, approval: "a", promotion_evidence: "third" }), runEnvironments: new Map() },
  ];
  const ancestry = buildLineageAncestry(entries, new Map([[
    "gen-c3", "environment was edited",
  ]]), 3);
  assert.equal(ancestry.head, "gen-c3");
  assert.equal(ancestry.rows[0]!.invalidated, null);
  assert.equal(ancestry.rows[3]!.invalidated, "environment was edited");
  assert.deepEqual(ancestry.rows.map((row) => row.gap_delta), [null, null, 1, 1]);
  assert.deepEqual(ancestry.findings, ["gap widening over last 3 promotions"]);
  // A shorter window that the gaps do not strictly span reports no finding.
  const flat = buildLineageAncestry(entries, new Map(), 4);
  assert.deepEqual(flat.findings, []);
  assert.equal(DEFAULT_GAP_WINDOW, 3);
  assert.deepEqual([...GENERATION_EDGE_TYPES], ["parent", "collection_run", "environment_version", "reward_spec_version", "base_checkpoint"]);
});

test("buildLineageAncestry propagates invalidation forward to descendants naming the ancestor", () => {
  // seed -> A -> B -> C: only A's own environment was edited. B and C recorded
  // different, still-valid environments, but their training data derives from A,
  // so they inherit an invalidation reason naming the nearest invalidated ancestor.
  const entries: AncestryEntry[] = [
    { id: "gen-seed", spec: spec({ base_checkpoint: "ckpt-0", gap: null }), runEnvironments: new Map() },
    { id: "gen-a", spec: spec({ base_checkpoint: "ckpt-a", environment_version: "env-edited", gap: 1, promoted: true, approval: "a", promotion_evidence: "first", parent: "gen-seed", seed: false, policy: "pa", collection_runs: ["run-a"], reward_spec_version: "r" }), runEnvironments: new Map() },
    { id: "gen-b", spec: spec({ base_checkpoint: "ckpt-b", environment_version: "env-other", gap: 2, promoted: true, approval: "a", promotion_evidence: "second", parent: "gen-a", seed: false, policy: "pb", collection_runs: ["run-b"], reward_spec_version: "r" }), runEnvironments: new Map() },
    { id: "gen-c", spec: spec({ base_checkpoint: "ckpt-c", environment_version: "env-third", gap: 3, promoted: true, approval: "a", promotion_evidence: "third", parent: "gen-b", seed: false, policy: "pc", collection_runs: ["run-c"], reward_spec_version: "r" }), runEnvironments: new Map() },
  ];
  const ancestry = buildLineageAncestry(entries, new Map([["gen-a", "environment was edited"]]), 3);
  assert.equal(ancestry.rows[1]!.invalidated, "environment was edited");
  assert.equal(ancestry.rows[2]!.invalidated, "invalidated by ancestor gen-a");
  assert.equal(ancestry.rows[3]!.invalidated, "invalidated by ancestor gen-b");
  assert.equal(ancestry.head, "gen-c");
  // A generation whose own environment is also edited overrides inheritance and
  // becomes the new propagation source for its own descendants.
  const withOwn: AncestryEntry[] = [
    { id: "gen-seed", spec: spec({ base_checkpoint: "ckpt-0" }), runEnvironments: new Map() },
    { id: "gen-a", spec: spec({ base_checkpoint: "ckpt-a", environment_version: "env-edited", gap: 1, promoted: true, approval: "a", promotion_evidence: "first", parent: "gen-seed", seed: false, policy: "pa", collection_runs: ["run-a"], reward_spec_version: "r" }), runEnvironments: new Map() },
    { id: "gen-b", spec: spec({ base_checkpoint: "ckpt-b", environment_version: "env-also-edited", gap: 2, promoted: true, approval: "a", promotion_evidence: "second", parent: "gen-a", seed: false, policy: "pb", collection_runs: ["run-b"], reward_spec_version: "r" }), runEnvironments: new Map() },
    { id: "gen-c", spec: spec({ base_checkpoint: "ckpt-c", environment_version: "env-clean", gap: 3, promoted: true, approval: "a", promotion_evidence: "third", parent: "gen-b", seed: false, policy: "pc", collection_runs: ["run-c"], reward_spec_version: "r" }), runEnvironments: new Map() },
  ];
  const mixed = buildLineageAncestry(withOwn, new Map([["gen-a", "environment was edited"], ["gen-b", "environment was edited"]]), 3);
  assert.equal(mixed.rows[1]!.invalidated, "environment was edited");
  assert.equal(mixed.rows[2]!.invalidated, "environment was edited");
  assert.equal(mixed.rows[3]!.invalidated, "invalidated by ancestor gen-b");
});

// -------------------------------------------------------------------------------------------------
// Generation and lineage commands through the real host.
// -------------------------------------------------------------------------------------------------

test("a seed generation registers with empty provenance and its children's runs reference its policy", async () => {
  const { root, pmRoot, client, harness } = await workspace();
  const env = await registerEnv(harness, pmRoot, root, "Grid");
  const seed = await registerSeed(harness, pmRoot, "gen-seed", "ckpt-seed", "ckpt-seed");
  const seedDetails = resultOf(await harness.runCommand({ command: "rl generation show", pmRoot, args: [seed] })).details;
  assert.equal(seedDetails?.seed, true);
  assert.equal(seedDetails?.parent, null);
  assert.equal(seedDetails?.policy, "ckpt-seed");
  const run = resultOf(await harness.runCommand({ command: "rl run start", pmRoot, args: ["run-1"], options: { environment: env, algorithm: "ckpt-seed" } }));
  const configFile = join(root, "train.json");
  writeFileSync(configFile, JSON.stringify({ learning_rate: 0.3 }));
  const candidate = resultOf(await harness.runCommand({
    command: "rl generation register",
    pmRoot,
    args: ["gen-c1"],
    options: { baseCheckpoint: "ckpt-c1", parent: seed, policy: "ckpt-c1", collectionRuns: run.id, environment: env, configFile },
  }));
  assert.equal(candidate.details?.seed, false);
  assert.equal(candidate.details?.parent, seed);
  assert.equal(candidate.details?.policy, "ckpt-c1");
  assert.equal(candidate.details?.environment, env);
  assert.equal(candidate.details?.reward_spec_version, hashJson({ goal: 10 }));
  assert.deepEqual(candidate.details?.edge_types, [...GENERATION_EDGE_TYPES]);
});

test("a candidate parented to a seed with no declared policy skips the run-policy check using only commands", async () => {
  const { root, pmRoot, harness } = await workspace();
  const env = await registerEnv(harness, pmRoot, root, "Grid");
  // The seed is registered with NO --policy, so its recorded policy is empty.
  const seed = await registerSeed(harness, pmRoot, "gen-seed", "ckpt-seed");
  const seedDetails = resultOf(await harness.runCommand({ command: "rl generation show", pmRoot, args: [seed] })).details;
  assert.equal(seedDetails?.policy, "", "the seed records an empty policy when none is declared");
  // A run collected by ANY algorithm would mismatch a declared policy, but the
  // seed declared none, so there is no policy to violate. The candidate registers
  // through published commands alone — no raw client.write behind the surface.
  const run = resultOf(await harness.runCommand({ command: "rl run start", pmRoot, args: ["run-1"], options: { environment: env, algorithm: "some-other-policy" } }));
  const candidate = resultOf(await harness.runCommand({
    command: "rl generation register",
    pmRoot,
    args: ["gen-c1"],
    options: { baseCheckpoint: "ckpt-c1", parent: seed, policy: "ckpt-c1", collectionRuns: run.id, environment: env },
  }));
  assert.equal(candidate.details?.parent, seed);
  assert.equal(candidate.details?.policy, "ckpt-c1");
  assert.equal(candidate.details?.seed, false);
});

test("registering a candidate refuses an unpromoted parent, a policy-mismatched run, and bad provenance", async () => {
  const { root, pmRoot, client, harness } = await workspace();
  const env = await registerEnv(harness, pmRoot, root, "Train");
  const seed = await registerSeed(harness, pmRoot, "gen-seed", "ckpt-seed", "ckpt-seed");
  const goodRun = resultOf(await harness.runCommand({ command: "rl run start", pmRoot, args: ["run-good"], options: { environment: env, algorithm: "ckpt-seed" } }));
  // An unpromoted, non-seed candidate cannot parent another candidate.
  const unpromoted = resultOf(await harness.runCommand({
    command: "rl generation register", pmRoot, args: ["gen-unpromoted"],
    options: { baseCheckpoint: "ckpt-u", parent: seed, policy: "ckpt-u", collectionRuns: goodRun.id, environment: env },
  }));
  await assert.rejects(
    harness.runCommand({ command: "rl generation register", pmRoot, args: ["gen-bad-parent"], options: { baseCheckpoint: "ckpt-x", parent: unpromoted.id, policy: "ckpt-x", collectionRuns: goodRun.id, environment: env } }),
    /not promoted/,
  );
  // A collection run whose policy differs from the parent's is refused.
  const wrongRun = resultOf(await harness.runCommand({ command: "rl run start", pmRoot, args: ["run-wrong"], options: { environment: env, algorithm: "other-policy" } }));
  await assert.rejects(
    harness.runCommand({ command: "rl generation register", pmRoot, args: ["gen-mismatch"], options: { baseCheckpoint: "ckpt-x", parent: seed, policy: "ckpt-x", collectionRuns: wrongRun.id, environment: env } }),
    /references policy other-policy, not the parent generation's policy ckpt-seed/,
  );
  // An empty collection-runs list for a non-seed is refused.
  await assert.rejects(
    harness.runCommand({ command: "rl generation register", pmRoot, args: ["gen-noruns"], options: { baseCheckpoint: "ckpt-x", parent: seed, policy: "ckpt-x", collectionRuns: " , ", environment: env } }),
    /requires --collection-runs/,
  );
  // A missing base checkpoint is refused.
  await assert.rejects(
    harness.runCommand({ command: "rl generation register", pmRoot, args: ["gen-nobase"] }),
    /requires --base-checkpoint/,
  );
  // Environments that are not content-addressed refuse the candidate.
  const noHash = await client.create({ id: "env-nohash", title: "NoHash", type: "Environment", status: "open" });
  await assert.rejects(
    harness.runCommand({ command: "rl generation register", pmRoot, args: ["gen-nohashenv"], options: { baseCheckpoint: "ckpt-x", parent: seed, policy: "ckpt-x", collectionRuns: goodRun.id, environment: noHash.item.id } }),
    /has no specification affected_version/,
  );
  const noFence = await client.create({ id: "env-nofence", title: "NoFence", type: "Environment", status: "open", affectedVersion: hashJson({ x: 1 }) });
  await assert.rejects(
    harness.runCommand({ command: "rl generation register", pmRoot, args: ["gen-nofenceenv"], options: { baseCheckpoint: "ckpt-x", parent: seed, policy: "ckpt-x", collectionRuns: goodRun.id, environment: noFence.item.id } }),
    /has no JSON specification fence/,
  );
  await client.update(env, { body: "# changed\n\n```json\n" + JSON.stringify({ name: "Train", version: "1", task_suite: ["reach-goal"], reward_specification: { goal: 99 } }, null, 2) + "\n```", message: "mutate env" });
  await assert.rejects(
    harness.runCommand({ command: "rl generation register", pmRoot, args: ["gen-mutatedenv"], options: { baseCheckpoint: "ckpt-x", parent: seed, policy: "ckpt-x", collectionRuns: goodRun.id, environment: env } }),
    /no longer matches its content-addressed identity/,
  );
});

test("registering a candidate refuses a collection run whose environment differs from the declared one", async () => {
  // F3 regression: the declared environment is resolved BEFORE iterating
  // collection runs, and each run's recorded environment is compared against
  // the resolved identity. A mismatch is refused at registration so the
  // generation's environment_version and its runs' environments cannot drift.
  const { root, pmRoot, harness } = await workspace();
  const envA = await registerEnv(harness, pmRoot, root, "EnvA");
  const envB = await registerEnv(harness, pmRoot, root, "EnvB", "2");
  const seed = await registerSeed(harness, pmRoot, "gen-seed", "ckpt-seed", "ckpt-seed");
  // Start a run with envB, then try to register a generation declaring envA.
  const runB = resultOf(await harness.runCommand({ command: "rl run start", pmRoot, args: ["run-b"], options: { environment: envB, algorithm: "ckpt-seed" } }));
  await assert.rejects(
    harness.runCommand({ command: "rl generation register", pmRoot, args: ["gen-mismatch"], options: { baseCheckpoint: "ckpt-x", parent: seed, policy: "ckpt-seed", collectionRuns: runB.id, environment: envA } }),
    (error: Error) => {
      assert.match(error.message, /records environment/);
      assert.match(error.message, /not the declared environment/);
      return true;
    },
  );
});

test("a clean candidate promotes with a direction-aware gap and consumes one budget unit", async () => {
  const { root, pmRoot, client, harness } = await workspace();
  const env = await registerEnv(harness, pmRoot, root, "Grid");
  const approval = await client.create({ id: "approval-2", title: "Approval", type: "Decision", status: "open", body: "# approval\n\n```json\n" + JSON.stringify({ permitted_promotions: 2 }) + "\n```" });
  const seed = await registerSeed(harness, pmRoot, "gen-seed", "ckpt-seed", "ckpt-seed");
  const run = resultOf(await harness.runCommand({ command: "rl run start", pmRoot, args: ["run-1"], options: { environment: env, algorithm: "ckpt-seed" } }));
  await harness.runCommand({ command: "rl generation register", pmRoot, args: ["gen-c1"], options: { baseCheckpoint: "ckpt-c1", parent: seed, policy: "ckpt-c1", collectionRuns: run.id, environment: env } });
  const scores = writeScores(root, 12, "held-out-ctx", 9);
  const promoted = resultOf(await harness.runCommand({ command: "rl generation promote", pmRoot, args: ["gen-c1"], options: { approval: approval.item.id, scores, evidence: "held-out rose" } }));
  assert.equal(promoted.details?.gap, 3);
  assert.equal(promoted.details?.budget_consumed, 1);
  assert.equal(promoted.details?.budget_permitted, 2);
  assert.equal(promoted.details?.status, "closed");
});

test("promotion refuses a seed, an already-promoted generation, and incomplete or malformed scores", async () => {
  const { root, pmRoot, client, harness } = await workspace();
  const env = await registerEnv(harness, pmRoot, root, "Grid");
  const approval = await client.create({ id: "approval-2", title: "Approval", type: "Decision", status: "open", body: "# approval\n\n```json\n" + JSON.stringify({ permitted_promotions: 2 }) + "\n```" });
  const seed = await registerSeed(harness, pmRoot, "gen-seed", "ckpt-seed", "ckpt-seed");
  const run = resultOf(await harness.runCommand({ command: "rl run start", pmRoot, args: ["run-1"], options: { environment: env, algorithm: "ckpt-seed" } }));
  const candidate = resultOf(await harness.runCommand({ command: "rl generation register", pmRoot, args: ["gen-c1"], options: { baseCheckpoint: "ckpt-c1", parent: seed, policy: "ckpt-c1", collectionRuns: run.id, environment: env } }));
  // The seed is registered, not promoted.
  await assert.rejects(
    harness.runCommand({ command: "rl generation promote", pmRoot, args: [seed], options: { approval: approval.item.id, scores: writeScores(root, 1, "held-out-ctx", 1), evidence: "x" } }),
    /seed generation .* is registered, not promoted/,
  );
  // Missing proxy and held-out scores are each refused.
  const noProxy = join(root, "no-proxy.json");
  writeFileSync(noProxy, JSON.stringify({ held_out_score: score(1) }));
  await assert.rejects(
    harness.runCommand({ command: "rl generation promote", pmRoot, args: [candidate.id!], options: { approval: approval.item.id, scores: noProxy, evidence: "x" } }),
    /require a proxy_score/,
  );
  const noHeldOut = join(root, "no-heldout.json");
  writeFileSync(noHeldOut, JSON.stringify({ proxy_score: score(1) }));
  await assert.rejects(
    harness.runCommand({ command: "rl generation promote", pmRoot, args: [candidate.id!], options: { approval: approval.item.id, scores: noHeldOut, evidence: "x" } }),
    /require a held_out_score/,
  );
  // A scores file that is not one JSON object is refused.
  const notObject = join(root, "array.json");
  writeFileSync(notObject, "[]");
  await assert.rejects(
    harness.runCommand({ command: "rl generation promote", pmRoot, args: [candidate.id!], options: { approval: approval.item.id, scores: notObject, evidence: "x" } }),
    /one JSON object/,
  );
  // A non-Decision approval item is refused.
  const issue = await client.create({ id: "not-approval", title: "Issue", type: "Issue", status: "open" });
  await assert.rejects(
    harness.runCommand({ command: "rl generation promote", pmRoot, args: [candidate.id!], options: { approval: issue.item.id, scores: writeScores(root, 1, "held-out-ctx", 1), evidence: "x" } }),
    /expected a Decision/,
  );
  // An approval without a specification fence is refused.
  const bareApproval = await client.create({ id: "bare-approval", title: "Bare", type: "Decision", status: "open", body: "no fence" });
  await assert.rejects(
    harness.runCommand({ command: "rl generation promote", pmRoot, args: [candidate.id!], options: { approval: bareApproval.item.id, scores: writeScores(root, 1, "held-out-ctx", 1), evidence: "x" } }),
    /no JSON specification fence/,
  );
  // A successful promotion consumed one unit; a second promotion of the same candidate is refused.
  const scores = writeScores(root, 12, "held-out-ctx", 9);
  await harness.runCommand({ command: "rl generation promote", pmRoot, args: [candidate.id!], options: { approval: approval.item.id, scores, evidence: "ok" } });
  await assert.rejects(
    harness.runCommand({ command: "rl generation promote", pmRoot, args: [candidate.id!], options: { approval: approval.item.id, scores, evidence: "again" } }),
    /already promoted/,
  );
});

test("promotion refuses when the evaluation set is reachable from the candidate's training data", async () => {
  const { root, pmRoot, client, harness } = await workspace();
  const trainEnv = await registerEnv(harness, pmRoot, root, "Train");
  const approval = await client.create({ id: "approval-2", title: "Approval", type: "Decision", status: "open", body: "# approval\n\n```json\n" + JSON.stringify({ permitted_promotions: 2 }) + "\n```" });
  const seed = await registerSeed(harness, pmRoot, "gen-seed", "ckpt-seed", "ckpt-seed");
  const run = resultOf(await harness.runCommand({ command: "rl run start", pmRoot, args: ["run-1"], options: { environment: trainEnv, algorithm: "ckpt-seed" } }));
  await harness.runCommand({ command: "rl generation register", pmRoot, args: ["gen-c1"], options: { baseCheckpoint: "ckpt-c1", parent: seed, policy: "ckpt-c1", collectionRuns: run.id, environment: trainEnv } });
  // The held-out evaluation context equals the training environment: direct environment-version overlap.
  await assert.rejects(
    harness.runCommand({ command: "rl generation promote", pmRoot, args: ["gen-c1"], options: { approval: approval.item.id, scores: writeScores(root, 12, trainEnv, 9), evidence: "contaminated" } }),
    /Promotion refused: the evaluation set is reachable/,
  );
  // Reachability through a collection run whose environment is the held-out set produces a multi-hop path.
  // The generation is created through a raw client because the command surface
  // now refuses a run whose recorded environment differs from the declared one
  // (F3: run_environment_mismatch). The contamination check at promotion time
  // reads the run's OWN environment, so a hand-authored body that declares a
  // different environment_version while pointing at a run that used the held-out
  // set is still caught — and the path goes through collection_run, not
  // environment_version, because the generation's own environment_version is the
  // alternate training environment, not the held-out one.
  const altTrainEnv = await registerEnv(harness, pmRoot, root, "AltTrain", "2");
  const heldOutEnv = await registerEnv(harness, pmRoot, root, "HeldOut", "3");
  const heldOutRun = resultOf(await harness.runCommand({ command: "rl run start", pmRoot, args: ["run-heldout"], options: { environment: heldOutEnv, algorithm: "ckpt-seed" } }));
  const c2Spec = spec({ base_checkpoint: "ckpt-c2", policy: "ckpt-c2", collection_runs: [String(heldOutRun.id)], environment_version: altTrainEnv, reward_spec_version: hashJson({ goal: 10 }), parent: seed, seed: false });
  const c2Body = generationBody(c2Spec);
  await client.create({ id: "gen-c2", title: "C2", type: "Generation", status: "open", body: c2Body.body, affectedVersion: c2Body.hash, parent: seed, environment: altTrainEnv });
  await assert.rejects(
    harness.runCommand({ command: "rl generation promote", pmRoot, args: ["gen-c2"], options: { approval: approval.item.id, scores: writeScores(root, 12, heldOutEnv, 9), evidence: "contaminated" } }),
    /reachable from the candidate's training data over provenance edges.*collection_run/,
  );
});

test("promotion refuses incomparable proxy and held-out scores naming the differing fields", async () => {
  const { root, pmRoot, client, harness } = await workspace();
  const env = await registerEnv(harness, pmRoot, root, "Grid");
  const approval = await client.create({ id: "approval-2", title: "Approval", type: "Decision", status: "open", body: "# approval\n\n```json\n" + JSON.stringify({ permitted_promotions: 2 }) + "\n```" });
  const seed = await registerSeed(harness, pmRoot, "gen-seed", "ckpt-seed", "ckpt-seed");
  const run = resultOf(await harness.runCommand({ command: "rl run start", pmRoot, args: ["run-1"], options: { environment: env, algorithm: "ckpt-seed" } }));
  const candidate = resultOf(await harness.runCommand({ command: "rl generation register", pmRoot, args: ["gen-c1"], options: { baseCheckpoint: "ckpt-c1", parent: seed, policy: "ckpt-c1", collectionRuns: run.id, environment: env } }));
  // The proxy names a different objective than the held-out score: not a gap.
  const incomparable = join(root, "incomparable.json");
  writeFileSync(incomparable, JSON.stringify({
    proxy_score: { objective: "loss", objective_version: "obj-v1", evaluation_context: "proxy-ctx", seed_set: "seed-set-1", direction: "minimize", scale: 1, value: 2 },
    held_out_score: { objective: "episode_return", objective_version: "obj-v1", evaluation_context: "held-out-ctx", seed_set: "seed-set-1", direction: "maximize", scale: 1, value: 9 },
  }));
  await assert.rejects(
    harness.runCommand({ command: "rl generation promote", pmRoot, args: [candidate.id!], options: { approval: approval.item.id, scores: incomparable, evidence: "x" } }),
    (error: Error) => {
      assert.match(error.message, /not comparable/);
      assert.match(error.message, /objective.*loss.*episode_return/);
      assert.match(error.message, /direction.*minimize.*maximize/);
      return true;
    },
  );
});

test("promotion refuses to advance past the approved budget and names the item to extend", async () => {
  const { root, pmRoot, client, harness } = await workspace();
  const env = await registerEnv(harness, pmRoot, root, "Grid");
  const zeroApproval = await client.create({ id: "approval-zero", title: "Zero", type: "Decision", status: "open", body: "# approval\n\n```json\n" + JSON.stringify({ permitted_promotions: 0 }) + "\n```" });
  const seed = await registerSeed(harness, pmRoot, "gen-seed", "ckpt-seed", "ckpt-seed");
  const run = resultOf(await harness.runCommand({ command: "rl run start", pmRoot, args: ["run-1"], options: { environment: env, algorithm: "ckpt-seed" } }));
  await harness.runCommand({ command: "rl generation register", pmRoot, args: ["gen-c1"], options: { baseCheckpoint: "ckpt-c1", parent: seed, policy: "ckpt-c1", collectionRuns: run.id, environment: env } });
  await assert.rejects(
    harness.runCommand({ command: "rl generation promote", pmRoot, args: ["gen-c1"], options: { approval: zeroApproval.item.id, scores: writeScores(root, 12, "held-out-ctx", 9), evidence: "first" } }),
    /Advancing past the approved promotion budget is refused/,
  );
  // Unparseable generations now REFUSE the budget (see the dedicated test below),
  // so they are kept out of this workspace; the budget is exhausted only across
  // clean, distinct candidates.
  const twoApproval = await client.create({ id: "approval-two", title: "Two", type: "Decision", status: "open", body: "# approval\n\n```json\n" + JSON.stringify({ permitted_promotions: 2 }) + "\n```" });
  const run2 = resultOf(await harness.runCommand({ command: "rl run start", pmRoot, args: ["run-2"], options: { environment: env, algorithm: "ckpt-seed" } }));
  await harness.runCommand({ command: "rl generation register", pmRoot, args: ["gen-c2"], options: { baseCheckpoint: "ckpt-c2", parent: seed, policy: "ckpt-c2", collectionRuns: run2.id, environment: env } });
  await harness.runCommand({ command: "rl generation promote", pmRoot, args: ["gen-c2"], options: { approval: twoApproval.item.id, scores: writeScores(root, 12, "held-out-ctx", 9), evidence: "one" } });
  await assert.rejects(
    harness.runCommand({ command: "rl generation promote", pmRoot, args: ["gen-c2"], options: { approval: twoApproval.item.id, scores: writeScores(root, 12, "held-out-ctx", 9), evidence: "retry" } }),
    /already promoted/,
  );

  // Exhaust the budget across DISTINCT candidates.
  //
  // Neither case above proves the counting walk works. The zero-permission
  // approval refuses at a count of 0, so the refusal fires whatever
  // countPromotedUnderApproval returns; and the repeat promotion of gen-c2 is
  // stopped by the already-promoted guard before the budget check is reached.
  // Only promoting distinct candidates up to the limit exercises a correct
  // non-zero count, which is the part of the guarantee that actually bounds a
  // recursive loop.
  const run3 = resultOf(await harness.runCommand({ command: "rl run start", pmRoot, args: ["run-3"], options: { environment: env, algorithm: "ckpt-seed" } }));
  await harness.runCommand({ command: "rl generation register", pmRoot, args: ["gen-c3"], options: { baseCheckpoint: "ckpt-c3", parent: seed, policy: "ckpt-c3", collectionRuns: run3.id, environment: env } });
  await harness.runCommand({ command: "rl generation promote", pmRoot, args: ["gen-c3"], options: { approval: twoApproval.item.id, scores: writeScores(root, 12, "held-out-ctx", 9), evidence: "two" } });

  // Two promotions now consume the two permitted; a third distinct candidate
  // must be refused, and the refusal must name the approval item to extend.
  const run4 = resultOf(await harness.runCommand({ command: "rl run start", pmRoot, args: ["run-4"], options: { environment: env, algorithm: "ckpt-seed" } }));
  await harness.runCommand({ command: "rl generation register", pmRoot, args: ["gen-c4"], options: { baseCheckpoint: "ckpt-c4", parent: seed, policy: "ckpt-c4", collectionRuns: run4.id, environment: env } });
  await assert.rejects(
    harness.runCommand({ command: "rl generation promote", pmRoot, args: ["gen-c4"], options: { approval: twoApproval.item.id, scores: writeScores(root, 12, "held-out-ctx", 9), evidence: "three" } }),
    (error: Error) => {
      assert.match(error.message, /Advancing past the approved promotion budget is refused/);
      assert.match(error.message, /2 promotion\(s\) consumed/, "the refusal must report the real count, not merely fire");
      assert.ok(error.message.includes(String(twoApproval.item.id)), "the refusal must name the approval item to extend");
      return true;
    },
  );
});

test("a padded --parent never reaches storage, because the option boundary normalizes it", async () => {
  // A regression guard on the OPTION boundary, exercised through the real
  // command. `stringOption` returns `value.trim()`, which is precisely why
  // `rl generation register` does not re-trim before storing. If that ever
  // stops being true, a padded `--parent " gen-seed "` lands in both the
  // specification JSON and the pm parent field, matching nothing until
  // `parseGenerationSpec` trims it again on the way back out — and this fails,
  // naming the assumption the command depends on.
  const { root, pmRoot, client, harness } = await workspace();
  const env = await registerEnv(harness, pmRoot, root, "Grid");
  const seed = await registerSeed(harness, pmRoot, "gen-seed", "ckpt-seed", "ckpt-seed");
  const run = resultOf(await harness.runCommand({ command: "rl run start", pmRoot, args: ["run-1"], options: { environment: env, algorithm: "ckpt-seed" } }));
  const registered = resultOf(await harness.runCommand({ command: "rl generation register", pmRoot, args: ["gen-padded-parent"], options: { baseCheckpoint: "ckpt-c1", parent: `  ${seed}  `, policy: "ckpt-c1", collectionRuns: run.id, environment: env } }));
  const stored = await client.get(registered.id!, { depth: "deep" });
  const fenced = /```json\n([\s\S]+?)\n```/.exec(String(stored.item.body));
  const spec = JSON.parse(String(fenced?.[1])) as { parent: string };
  assert.equal(spec.parent, seed, "the specification stores the trimmed parent identity");
  assert.equal(String(stored.item.parent), seed, "the pm parent field stores the same trimmed identity");
});

test("a promoted generation whose stored approval is padded still consumes that approval's budget", async () => {
  // The budget is counted by comparing each promoted generation's stored
  // approval to the approval id with strict equality. Generations are pm items,
  // so a body can be authored by hand or by another tool; if a padded approval
  // were stored verbatim it would match no id, and the record would be promoted
  // while consuming none of the budget it was promoted under. That is a bypass
  // of the one bound on a recursive promotion loop, reachable without touching
  // the promote command at all.
  const { root, pmRoot, client, harness } = await workspace();
  const env = await registerEnv(harness, pmRoot, root, "Grid");
  const oneApproval = await client.create({ id: "approval-pad", title: "One", type: "Decision", status: "open", body: "# approval\n\n```json\n" + JSON.stringify({ permitted_promotions: 1 }) + "\n```" });
  const approvalId = String(oneApproval.item.id);
  const seed = await registerSeed(harness, pmRoot, "gen-seed", "ckpt-seed", "ckpt-seed");
  // A hand-authored promoted generation that spends the single permitted
  // promotion, recording the approval with surrounding whitespace.
  const paddedSpec = { base_checkpoint: "ckpt-p", policy: "ckpt-p", collection_runs: ["run-p"], training_config: {}, environment_version: "env-1", reward_spec_version: "reward-1", parent: seed, seed: false, promoted: true, approval: `  ${approvalId}  `, proxy_score: score(12), held_out_score: score(9, "maximize", 1, "held-out-ctx"), gap: 3, promotion_evidence: "hand-authored" };
  await client.create({ id: "gen-padded", title: "Padded", type: "Generation", status: "open", body: "# gen-padded\n\n```json\n" + JSON.stringify(paddedSpec, null, 2) + "\n```" });
  const run = resultOf(await harness.runCommand({ command: "rl run start", pmRoot, args: ["run-next"], options: { environment: env, algorithm: "ckpt-seed" } }));
  await harness.runCommand({ command: "rl generation register", pmRoot, args: ["gen-next"], options: { baseCheckpoint: "ckpt-next", parent: seed, policy: "ckpt-next", collectionRuns: run.id, environment: env } });
  await assert.rejects(
    harness.runCommand({ command: "rl generation promote", pmRoot, args: ["gen-next"], options: { approval: approvalId, scores: writeScores(root, 12, "held-out-ctx", 9), evidence: "second" } }),
    (error: Error) => {
      assert.match(error.message, /Advancing past the approved promotion budget is refused/);
      assert.match(error.message, /1 promotion\(s\) consumed/, "the padded record must be counted, not merely make the count non-zero by accident");
      return true;
    },
  );
});

test("a promoted generation whose stored approval is blank makes the budget undecidable rather than free", async () => {
  // The blank case cannot be normalized into a real identity, so it is refused
  // at the parse boundary. Reaching that refusal through the budget walk is the
  // point: an unparseable promoted record must make the budget UNDECIDABLE, so
  // the promotion stops. Ignoring the record instead would hand a recursive
  // loop an unbounded budget, which is the failure the walk exists to prevent.
  const { root, pmRoot, client, harness } = await workspace();
  const env = await registerEnv(harness, pmRoot, root, "Grid");
  const approval = await client.create({ id: "approval-blank", title: "One", type: "Decision", status: "open", body: "# approval\n\n```json\n" + JSON.stringify({ permitted_promotions: 5 }) + "\n```" });
  const seed = await registerSeed(harness, pmRoot, "gen-seed", "ckpt-seed", "ckpt-seed");
  const blankSpec = { base_checkpoint: "ckpt-b", policy: "ckpt-b", collection_runs: ["run-b"], training_config: {}, environment_version: "env-1", reward_spec_version: "reward-1", parent: seed, seed: false, promoted: true, approval: "   ", proxy_score: score(12), held_out_score: score(9, "maximize", 1, "held-out-ctx"), gap: 3, promotion_evidence: "hand-authored" };
  await client.create({ id: "gen-blank", title: "Blank", type: "Generation", status: "open", body: "# gen-blank\n\n```json\n" + JSON.stringify(blankSpec, null, 2) + "\n```" });
  const run = resultOf(await harness.runCommand({ command: "rl run start", pmRoot, args: ["run-next"], options: { environment: env, algorithm: "ckpt-seed" } }));
  await harness.runCommand({ command: "rl generation register", pmRoot, args: ["gen-next"], options: { baseCheckpoint: "ckpt-next", parent: seed, policy: "ckpt-next", collectionRuns: run.id, environment: env } });
  await assert.rejects(
    harness.runCommand({ command: "rl generation promote", pmRoot, args: ["gen-next"], options: { approval: String(approval.item.id), scores: writeScores(root, 12, "held-out-ctx", 9), evidence: "second" } }),
    /gen-blank has an unparseable specification/,
  );
});

test("promotion refuses an unreadable collection run while lineage still renders", async () => {
  const { root, pmRoot, client, harness } = await workspace();
  const env = await registerEnv(harness, pmRoot, root, "Grid");
  const approval = await client.create({ id: "approval-2", title: "Approval", type: "Decision", status: "open", body: "# approval\n\n```json\n" + JSON.stringify({ permitted_promotions: 2 }) + "\n```" });
  const seed = await registerSeed(harness, pmRoot, "gen-seed", "ckpt-seed", "ckpt-seed");
  // A candidate whose collection run does not resolve. It is created through a
  // raw client because the command surface refuses a bogus run at registration;
  // the strict provenance check is what catches it at promotion time.
  const candSpec = {
    base_checkpoint: "ckpt-c1", policy: "ckpt-c1", collection_runs: ["missing-run"],
    training_config: {}, environment_version: env, reward_spec_version: hashJson({ goal: 10 }),
    parent: seed, seed: false, promoted: false, approval: null, proxy_score: null, held_out_score: null, gap: null, promotion_evidence: null,
  };
  const { body, hash } = generationBody(candSpec);
  const candidate = await client.create({ id: "gen-strict", title: "Strict", type: "Generation", status: "open", body, affectedVersion: hash, parent: seed, environment: env });
  await assert.rejects(
    harness.runCommand({ command: "rl generation promote", pmRoot, args: [candidate.item.id], options: { approval: approval.item.id, scores: writeScores(root, 12, "held-out-ctx", 9), evidence: "x" } }),
    (error: Error) => {
      assert.match(error.message, /collection run missing-run of generation/);
      assert.match(error.message, /could not be resolved/);
      return true;
    },
  );
  // rl lineage over the same workspace still renders: the unresolvable run is tolerated.
  const lineage = resultOf(await harness.runCommand({ command: "rl lineage", pmRoot, args: [candidate.item.id] }));
  assert.match(String(lineage.details?.output), /head: /);
  // A run that RESOLVES but records no environment is equally undecidable: the
  // contamination check would read undefined and treat the run as clean.
  await client.create({ id: "run-noenv", title: "No env", type: "Run", status: "in_progress", component: "ckpt-seed", affectedVersion: "1", fixedVersion: "1" });
  const noEnvSpec = { ...candSpec, collection_runs: ["run-noenv"] };
  const noEnvBody = generationBody(noEnvSpec);
  const noEnvCandidate = await client.create({ id: "gen-noenv", title: "No env run", type: "Generation", status: "open", body: noEnvBody.body, affectedVersion: noEnvBody.hash, parent: seed, environment: env });
  await assert.rejects(
    harness.runCommand({ command: "rl generation promote", pmRoot, args: [noEnvCandidate.item.id], options: { approval: approval.item.id, scores: writeScores(root, 12, "held-out-ctx", 9), evidence: "x" } }),
    (error: Error) => {
      assert.match(error.message, /collection run run-noenv of generation/);
      assert.match(error.message, /records no environment/);
      return true;
    },
  );
  // And lineage still tolerates it.
  const noEnvLineage = resultOf(await harness.runCommand({ command: "rl lineage", pmRoot, args: [noEnvCandidate.item.id] }));
  assert.match(String(noEnvLineage.details?.output), /head: /);
});

test("promotion refuses an uncountable generation while lineage still renders", async () => {
  const { root, pmRoot, client, harness } = await workspace();
  const env = await registerEnv(harness, pmRoot, root, "Grid");
  const approval = await client.create({ id: "approval-2", title: "Approval", type: "Decision", status: "open", body: "# approval\n\n```json\n" + JSON.stringify({ permitted_promotions: 2 }) + "\n```" });
  const seed = await registerSeed(harness, pmRoot, "gen-seed", "ckpt-seed", "ckpt-seed");
  const run = resultOf(await harness.runCommand({ command: "rl run start", pmRoot, args: ["run-1"], options: { environment: env, algorithm: "ckpt-seed" } }));
  const candidate = resultOf(await harness.runCommand({ command: "rl generation register", pmRoot, args: ["gen-c1"], options: { baseCheckpoint: "ckpt-c1", parent: seed, policy: "ckpt-c1", collectionRuns: run.id, environment: env } }));
  // A Generation with no JSON fence makes the approved budget undecidable.
  await client.create({ id: "gen-nofence", title: "NoFence", type: "Generation", status: "open", body: "no fence here" });
  await assert.rejects(
    harness.runCommand({ command: "rl generation promote", pmRoot, args: [candidate.id!], options: { approval: approval.item.id, scores: writeScores(root, 12, "held-out-ctx", 9), evidence: "x" } }),
    (error: Error) => {
      assert.match(error.message, /gen-nofence/);
      assert.match(error.message, /no JSON specification fence/);
      return true;
    },
  );
  // An unparseable spec is likewise refused.
  const { root: root2, pmRoot: pmRoot2, client: client2, harness: harness2 } = await workspace();
  const env2 = await registerEnv(harness2, pmRoot2, root2, "Grid");
  const approval2 = await client2.create({ id: "approval-2", title: "Approval", type: "Decision", status: "open", body: "# approval\n\n```json\n" + JSON.stringify({ permitted_promotions: 2 }) + "\n```" });
  const seed2 = await registerSeed(harness2, pmRoot2, "gen-seed", "ckpt-seed", "ckpt-seed");
  const run2 = resultOf(await harness2.runCommand({ command: "rl run start", pmRoot: pmRoot2, args: ["run-1"], options: { environment: env2, algorithm: "ckpt-seed" } }));
  const candidate2 = resultOf(await harness2.runCommand({ command: "rl generation register", pmRoot: pmRoot2, args: ["gen-c1"], options: { baseCheckpoint: "ckpt-c1", parent: seed2, policy: "ckpt-c1", collectionRuns: run2.id, environment: env2 } }));
  await client2.create({ id: "gen-badfence", title: "BadFence", type: "Generation", status: "open", body: "# x\n\n```json\n{not json}\n```" });
  await assert.rejects(
    harness2.runCommand({ command: "rl generation promote", pmRoot: pmRoot2, args: [candidate2.id!], options: { approval: approval2.item.id, scores: writeScores(root2, 12, "held-out-ctx", 9), evidence: "x" } }),
    (error: Error) => {
      assert.match(error.message, /gen-badfence/);
      assert.match(error.message, /unparseable specification/);
      return true;
    },
  );
  // rl lineage over the clean candidate still renders.
  const lineage = resultOf(await harness.runCommand({ command: "rl lineage", pmRoot, args: [candidate.id!] }));
  assert.match(String(lineage.details?.output), /head: /);
});

test("showing a generation without a specification fence is refused", async () => {
  const { pmRoot, client, harness } = await workspace();
  const bare = await client.create({ id: "gen-bare", title: "Bare", type: "Generation", status: "open", body: "no fence" });
  await assert.rejects(
    harness.runCommand({ command: "rl generation show", pmRoot, args: [bare.item.id] }),
    /has no JSON specification fence/,
  );
});

test("the lineage view renders a single ancestry as a table or as machine-readable json", async () => {
  const { root, pmRoot, client, harness } = await workspace();
  const env = await registerEnv(harness, pmRoot, root, "Grid");
  const approval = await client.create({ id: "approval-2", title: "Approval", type: "Decision", status: "open", body: "# approval\n\n```json\n" + JSON.stringify({ permitted_promotions: 2 }) + "\n```" });
  const seed = await registerSeed(harness, pmRoot, "gen-seed", "ckpt-seed", "ckpt-seed");
  const run = resultOf(await harness.runCommand({ command: "rl run start", pmRoot, args: ["run-1"], options: { environment: env, algorithm: "ckpt-seed" } }));
  const candidate = resultOf(await harness.runCommand({ command: "rl generation register", pmRoot, args: ["gen-c1"], options: { baseCheckpoint: "ckpt-c1", parent: seed, policy: "ckpt-c1", collectionRuns: run.id, environment: env } }));
  await harness.runCommand({ command: "rl generation promote", pmRoot, args: [candidate.id!], options: { approval: approval.item.id, scores: writeScores(root, 12, "held-out-ctx", 9), evidence: "ok" } });
  const table = resultOf(await harness.runCommand({ command: "rl lineage", pmRoot, args: [candidate.id!] }));
  assert.match(String(table.details?.output), /head: /);
  assert.match(String(table.details?.output), /gen-seed \| seed/);
  assert.match(String(table.details?.output), /gen-c1 .* promoted/);
  const json = resultOf(await harness.runCommand({ command: "rl lineage", pmRoot, args: [candidate.id!], options: { format: "json" } }));
  const view = json.details?.view as LineageView;
  assert.equal(view.ancestries.length, 1);
  assert.equal(view.ancestries[0]!.head, candidate.id);
  assert.equal(view.ancestries[0]!.rows.length, 2);
});

test("without a head the view enumerates every head, and invalid format or gap-window options are refused", async () => {
  const { root, pmRoot, client, harness } = await workspace();
  const env = await registerEnv(harness, pmRoot, root, "Grid");
  const seed = await registerSeed(harness, pmRoot, "gen-seed", "ckpt-seed", "ckpt-seed");
  const run = resultOf(await harness.runCommand({ command: "rl run start", pmRoot, args: ["run-1"], options: { environment: env, algorithm: "ckpt-seed" } }));
  // Two candidates that share the seed as a parent are both heads.
  await harness.runCommand({ command: "rl generation register", pmRoot, args: ["gen-c1"], options: { baseCheckpoint: "ckpt-c1", parent: seed, policy: "ckpt-c1", collectionRuns: run.id, environment: env } });
  await harness.runCommand({ command: "rl generation register", pmRoot, args: ["gen-c2"], options: { baseCheckpoint: "ckpt-c2", parent: seed, policy: "ckpt-c2", collectionRuns: run.id, environment: env } });
  const noHead = resultOf(await harness.runCommand({ command: "rl lineage", pmRoot }));
  const view = noHead.details?.view as LineageView;
  assert.equal(view.ancestries.length, 2);
  await assert.rejects(
    harness.runCommand({ command: "rl lineage", pmRoot, args: [seed], options: { format: "yaml" } }),
    /--format must be "table" or "json"/,
  );
  await assert.rejects(
    harness.runCommand({ command: "rl lineage", pmRoot, args: [seed], options: { gapWindow: "0" } }),
    /--gap-window must be an integer of at least 2/,
  );
  // A window of 1 is now refused: a trend needs at least two points.
  await assert.rejects(
    harness.runCommand({ command: "rl lineage", pmRoot, args: [seed], options: { gapWindow: "1" } }),
    /--gap-window must be an integer of at least 2/,
  );
  const custom = resultOf(await harness.runCommand({ command: "rl lineage", pmRoot, args: [seed], options: { gapWindow: "2" } }));
  assert.ok(String(custom.details?.output).includes("head: "));
});

test("an edited environment marks every downstream generation invalidated in the lineage", async () => {
  const { root, pmRoot, client, harness } = await workspace();
  // seed -> A -> B where A and B recorded DIFFERENT environments. Editing A's
  // environment must mark A on its own environment and B as a descendant that
  // inherited the invalidation, naming A — the propagation the prior fixture
  // (one candidate on the edited env, no descendant) never exercised.
  const envA = await registerEnv(harness, pmRoot, root, "EnvA");
  const envB = await registerEnv(harness, pmRoot, root, "EnvB", "2");
  const approval = await client.create({ id: "approval-2", title: "Approval", type: "Decision", status: "open", body: "# approval\n\n```json\n" + JSON.stringify({ permitted_promotions: 2 }) + "\n```" });
  const seed = await registerSeed(harness, pmRoot, "gen-seed", "ckpt-seed", "ckpt-seed");
  const runA = resultOf(await harness.runCommand({ command: "rl run start", pmRoot, args: ["run-a"], options: { environment: envA, algorithm: "ckpt-seed" } }));
  const genA = resultOf(await harness.runCommand({ command: "rl generation register", pmRoot, args: ["gen-a"], options: { baseCheckpoint: "ckpt-a", parent: seed, policy: "ckpt-a", collectionRuns: runA.id, environment: envA } }));
  await harness.runCommand({ command: "rl generation promote", pmRoot, args: [genA.id!], options: { approval: approval.item.id, scores: writeScores(root, 12, "held-out-ctx", 9), evidence: "ok" } });
  const runB = resultOf(await harness.runCommand({ command: "rl run start", pmRoot, args: ["run-b"], options: { environment: envB, algorithm: "ckpt-a" } }));
  const genB = resultOf(await harness.runCommand({ command: "rl generation register", pmRoot, args: ["gen-b"], options: { baseCheckpoint: "ckpt-b", parent: genA.id, policy: "ckpt-b", collectionRuns: runB.id, environment: envB } }));
  await client.update(envA, { body: "# changed\n\n```json\n" + JSON.stringify({ name: "EnvA", version: "1", task_suite: ["reach-goal"], reward_specification: { goal: 999 } }, null, 2) + "\n```", message: "edit envA" });
  const after = resultOf(await harness.runCommand({ command: "rl lineage", pmRoot, args: [genB.id!] }));
  // Ids are interpolated into these patterns, so they are escaped rather than
  // spliced raw: a tracker id containing a regex metacharacter would silently
  // change what the pattern matches, and the assertion would pass for text it
  // should reject - the exact weakening these assertions exist to catch.
  const escapeId = (value: string): string => value.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
  assert.match(String(after.details?.output), new RegExp(`${escapeId(genA.id!)} .* environment was edited`));
  assert.match(String(after.details?.output), new RegExp(`${escapeId(genB.id!)} .* invalidated by ancestor ${escapeId(genA.id!)}`));
  // A generation whose environment does not resolve is reported as ABSENT, not as edited.
  const ghostSpec = { ...seedSpec("ckpt-g", ""), environment_version: "ghost-env-v1", parent: seed, seed: false, policy: "g", collection_runs: ["ghost-run"], reward_spec_version: "r" };
  await client.create({ id: "gen-ghost", title: "Ghost", type: "Generation", status: "open", ...generationBody(ghostSpec) });
  const ghostLineage = resultOf(await harness.runCommand({ command: "rl lineage", pmRoot, args: ["gen-ghost"] }));
  assert.match(String(ghostLineage.details?.output), /gen-ghost .* environment could not be resolved/);
  // A generation whose SPEC parent names genB while its pm dependency field is
  // absent. buildAncestry walks spec.parent, so if head enumeration reads
  // item.parent instead, genB is reported as a head at the same time as it
  // appears inside this child's ancestry — one graph answering two ways.
  const divergentSpec = { ...seedSpec("ckpt-d", ""), environment_version: envB, parent: genB.id!, seed: false, policy: "d", collection_runs: [runB.id!], reward_spec_version: hashJson({ goal: 10 }) };
  const divergentBody = generationBody(divergentSpec);
  await client.create({ id: "gen-divergent", title: "Divergent", type: "Generation", status: "open", body: divergentBody.body, affectedVersion: divergentBody.hash });
  const afterDivergent = resultOf(await harness.runCommand({ command: "rl lineage", pmRoot }));
  const divergentHeads = (afterDivergent.details?.view as LineageView).ancestries.map((ancestry) => ancestry.head);
  assert.ok(!divergentHeads.includes(genB.id!), `${genB.id!} is named as a spec parent and must not also be a head, got: ${divergentHeads.join(", ")}`);
  // One malformed Generation must not break the view for every OTHER ancestry.
  // Head enumeration parses each body, and `rl lineage` with no argument comes
  // through it, so refusing here would make a single unreadable item anywhere in
  // the workspace fail the whole command - the opposite of the tolerance the
  // lineage view promises.
  const broken = await client.create({ id: "gen-broken", title: "Broken", type: "Generation", status: "open", body: "# broken\n\n```json\n{ not json\n```" });
  const brokenId = String(broken.item.id);
  const afterBroken = resultOf(await harness.runCommand({ command: "rl lineage", pmRoot }));
  assert.match(String(afterBroken.details?.output), /head: /);
  const brokenHeads = (afterBroken.details?.view as LineageView).ancestries.map((ancestry) => ancestry.head);
  // Assert against the id the tracker returned, not a literal rebuilt from the
  // requested id and an assumed prefix. A prefix change would make the literal
  // match nothing, and the assertion would then pass for a workspace where the
  // broken generation IS enumerated as a head.
  assert.ok(!brokenHeads.includes(brokenId), `an unreadable generation contributes no ancestry, got: ${brokenHeads.join(", ")}`);
});

test("a readable descendant of a malformed ancestor still enumerates in the tolerant lineage walk", async () => {
  // F2 regression: when extractGenerationSpec hits an unreadable ancestor body
  // during the TOLERANT walk, the walk truncates (like cycle handling) instead
  // of propagating the error. A readable descendant must still render.
  const { root, pmRoot, client, harness } = await workspace();
  const env = await registerEnv(harness, pmRoot, root, "Grid");
  const approval = await client.create({ id: "approval-2", title: "Approval", type: "Decision", status: "open", body: "# approval\n\n```json\n" + JSON.stringify({ permitted_promotions: 2 }) + "\n```" });
  const seed = await registerSeed(harness, pmRoot, "gen-seed", "ckpt-seed", "ckpt-seed");
  const run = resultOf(await harness.runCommand({ command: "rl run start", pmRoot, args: ["run-1"], options: { environment: env, algorithm: "ckpt-seed" } }));
  const candidate = resultOf(await harness.runCommand({ command: "rl generation register", pmRoot, args: ["gen-c1"], options: { baseCheckpoint: "ckpt-c1", parent: seed, policy: "ckpt-c1", collectionRuns: run.id, environment: env } }));
  // Corrupt the SEED's body so it is unparseable. The candidate (readable
  // descendant) points at the seed as its parent.
  await client.update(seed, { body: "# broken seed\n\n```json\n{ not valid json\n```", message: "Corrupt seed body" });
  // The tolerant lineage view must still render the candidate, truncated at
  // the malformed seed — the walk does not fail the whole command.
  const lineage = resultOf(await harness.runCommand({ command: "rl lineage", pmRoot, args: [candidate.id!] }));
  assert.match(String(lineage.details?.output), /head: /);
  assert.match(String(lineage.details?.output), /gen-c1/, "the readable descendant must appear in the truncated ancestry");
  // The strict promotion path must still refuse on the malformed ancestor.
  await assert.rejects(
    harness.runCommand({ command: "rl generation promote", pmRoot, args: [candidate.id!], options: { approval: approval.item.id, scores: writeScores(root, 12, "held-out-ctx", 9), evidence: "x" } }),
    /not valid JSON|no JSON specification fence|unparseable/,
  );
});

test("a generation whose environment lacks a hash or a specification fence reports a distinct reason", async () => {
  const { pmRoot, client, harness } = await workspace();
  // An environment registered without a specification hash cannot be content-addressed.
  const noHashEnv = await client.create({ id: "env-nohash", title: "NoHash", type: "Environment", status: "open" });
  // An environment with a recorded hash but no JSON specification fence.
  const noFenceEnv = await client.create({ id: "env-nofence", title: "NoFence", type: "Environment", status: "open", affectedVersion: hashJson({ x: 1 }) });
  const noHashSpec = spec({ base_checkpoint: "ckpt-a", environment_version: noHashEnv.item.id });
  await client.create({ id: "gen-nohash", title: "NoHash", type: "Generation", status: "open", ...generationBody(noHashSpec) });
  const noHashLineage = resultOf(await harness.runCommand({ command: "rl lineage", pmRoot, args: ["gen-nohash"] }));
  assert.match(String(noHashLineage.details?.output), /gen-nohash .* environment has no recorded specification identity/);
  const noFenceSpec = spec({ base_checkpoint: "ckpt-b", environment_version: noFenceEnv.item.id });
  await client.create({ id: "gen-nofence", title: "NoFence", type: "Generation", status: "open", ...generationBody(noFenceSpec) });
  const noFenceLineage = resultOf(await harness.runCommand({ command: "rl lineage", pmRoot, args: ["gen-nofence"] }));
  assert.match(String(noFenceLineage.details?.output), /gen-nofence .* environment specification is unreadable/);
  // A fence that is PRESENT but does not parse is unreadable too, not
  // unresolvable. Before the parse was given its own catch, the failure fell
  // through to the outer one and reported "environment could not be resolved" -
  // which tells an operator the item is absent when it exists and its body is
  // the problem. The two reasons send them to different places.
  const badFenceEnv = await client.create({ id: "env-badfence", title: "BadFence", type: "Environment", status: "open", affectedVersion: hashJson({ x: 1 }), body: "# env\n\n```json\n{ not valid json\n```" });
  const badFenceSpec = spec({ base_checkpoint: "ckpt-c", environment_version: badFenceEnv.item.id });
  await client.create({ id: "gen-badfence", title: "BadFence", type: "Generation", status: "open", ...generationBody(badFenceSpec) });
  const badFenceLineage = resultOf(await harness.runCommand({ command: "rl lineage", pmRoot, args: ["gen-badfence"] }));
  assert.match(String(badFenceLineage.details?.output), /gen-badfence .* environment specification is unreadable/);
  assert.doesNotMatch(String(badFenceLineage.details?.output), /gen-badfence .* environment could not be resolved/, "a present but unparseable body must not be reported as an absent environment");
});

test("environmentInvalidationReason treats an empty environment id as not invalidated", async () => {
  const { client } = await workspace();
  assert.equal(await environmentInvalidationReason(client, ""), null);
});

test("a lineage whose promotions strictly widen the gap surfaces the finding over the configured window", async () => {
  const { root, pmRoot, client, harness } = await workspace();
  const env = await registerEnv(harness, pmRoot, root, "Grid");
  const approval = await client.create({ id: "approval-3", title: "Approval", type: "Decision", status: "open", body: "# approval\n\n```json\n" + JSON.stringify({ permitted_promotions: 3 }) + "\n```" });
  const seed = await registerSeed(harness, pmRoot, "gen-seed", "ckpt-seed", "ckpt-seed");
  let parentId: string | undefined = seed;
  let parentPolicy = "ckpt-seed";
  for (const [index, gap] of [1, 2, 3].entries()) {
    const run = resultOf(await harness.runCommand({ command: "rl run start", pmRoot, args: [`run-${index}`], options: { environment: env, algorithm: parentPolicy } }));
    const candidate = resultOf(await harness.runCommand({ command: "rl generation register", pmRoot, args: [`gen-c${index}`], options: { baseCheckpoint: `ckpt-c${index}`, parent: parentId, policy: `ckpt-c${index}`, collectionRuns: run.id, environment: env } }));
    await harness.runCommand({ command: "rl generation promote", pmRoot, args: [candidate.id!], options: { approval: approval.item.id, scores: writeScores(root, 10 + gap, "held-out-ctx", 10), evidence: `gen ${index}` } });
    parentId = candidate.id;
    parentPolicy = `ckpt-c${index}`;
  }
  const widened = resultOf(await harness.runCommand({ command: "rl lineage", pmRoot, args: [parentId!], options: { gapWindow: "3" } }));
  assert.match(String(widened.details?.output), /gap widening over last 3 promotions/);
});

test("the budget counter and the head enumerator skip a listed generation row the SDK types without an id", async () => {
  const { root, pmRoot, client, harness } = await workspace();
  const realClient = new PmClient({ pmRoot, author: "pm-rl-test" });
  const wrapped = clientWithIdlessGenerationRow(realClient);
  const sdk = sdkWith(wrapped);
  const env = await registerEnv(harness, pmRoot, root, "Grid");
  const seed = await registerSeed(harness, pmRoot, "gen-seed", "ckpt-seed", "ckpt-seed");
  const run = resultOf(await harness.runCommand({ command: "rl run start", pmRoot, args: ["run-1"], options: { environment: env, algorithm: "ckpt-seed" } }));
  await harness.runCommand({ command: "rl generation register", pmRoot, args: ["gen-c1"], options: { baseCheckpoint: "ckpt-c1", parent: seed, policy: "ckpt-c1", collectionRuns: run.id, environment: env } });
  // findGenerationHeads lists Generations including the id-less row; the row is skipped and the real head still resolves.
  const noHead = resultOf(await harness.runCommand({ command: "rl lineage", pmRoot, sdk }));
  const view = noHead.details?.view as LineageView;
  assert.ok(view.ancestries.every((ancestry) => ancestry.head.startsWith("rl-gen-")));
  // countPromotedUnderApproval lists Generations including the id-less row; promotion still succeeds with the correct count.
  const approval = await client.create({ id: "approval-2", title: "Approval", type: "Decision", status: "open", body: "# approval\n\n```json\n" + JSON.stringify({ permitted_promotions: 2 }) + "\n```" });
  const promoted = resultOf(await harness.runCommand({ command: "rl generation promote", pmRoot, args: ["gen-c1"], options: { approval: approval.item.id, scores: writeScores(root, 12, "held-out-ctx", 9), evidence: "ok" }, sdk }));
  assert.equal(promoted.details?.budget_consumed, 1);
});

test("concurrent promotions against a budget never let more than the permitted count succeed", async () => {
  const { root, pmRoot, client, harness } = await workspace();
  const env = await registerEnv(harness, pmRoot, root, "Grid");
  // A budget of 1: at most one promotion may succeed.
  const approval = await client.create({ id: "approval-1", title: "Approval", type: "Decision", status: "open", body: "# approval\n\n```json\n" + JSON.stringify({ permitted_promotions: 1 }) + "\n```" });
  const seed = await registerSeed(harness, pmRoot, "gen-seed", "ckpt-seed", "ckpt-seed");
  const scores = writeScores(root, 12, "held-out-ctx", 9);
  // Six distinct candidates, each collected by a run matching the seed's policy.
  const candidateIds: string[] = [];
  for (let index = 0; index < 6; index += 1) {
    const run = resultOf(await harness.runCommand({ command: "rl run start", pmRoot, args: [`run-${index}`], options: { environment: env, algorithm: "ckpt-seed" } }));
    const candidate = resultOf(await harness.runCommand({ command: "rl generation register", pmRoot, args: [`gen-c${index}`], options: { baseCheckpoint: `ckpt-c${index}`, parent: seed, policy: `ckpt-c${index}`, collectionRuns: run.id, environment: env } }));
    candidateIds.push(candidate.id!);
  }
  // Six real clients with distinct authors compete to promote against one budget.
  const clients = candidateIds.map((_, index) => new PmClient({ pmRoot, author: `agent-${index}` }));
  const sdks = clients.map((c) => sdkWith(c));
  const settled = await Promise.allSettled(candidateIds.map((id, index) => harness.runCommand({ command: "rl generation promote", pmRoot, args: [id], options: { approval: approval.item.id, scores, evidence: `agent-${index}` }, sdk: sdks[index] })));
  const successes = settled.filter((r) => r.status === "fulfilled").length;
  assert.ok(successes === 1, `exactly one promotion should win the budget reservation, but ${successes} succeeded`);
  // Every loser must report the ACCURATE terminal condition. Because promotions
  // serialize on the workspace writer lock rather than racing, a loser re-reads
  // the count the winner just changed and refuses on the exhausted budget. A
  // contention error here would be a retryable message for a permanent state,
  // which a recursive loop would retry forever instead of stopping.
  const reasons = settled.filter((r) => r.status === "rejected").map((r) => (r as PromiseRejectedResult).reason as Error);
  assert.equal(reasons.length, 5);
  for (const reason of reasons) {
    // Two outcomes are correct for a loser, and asserting only the first would
    // demand a stronger property than the system provides: a caller that
    // ACQUIRES the lock re-reads the count and refuses on the exhausted budget,
    // while a caller that exceeds the bounded 30s wait reports lock_conflict.
    // Contention is bounded, not eliminated. What must never appear is a
    // promotion that silently did not happen or one that exceeded the budget.
    assert.match(reason.message, /Advancing past the approved promotion budget is refused|is locked \(owner /, `unexpected refusal reason: ${reason.message}`);
    assert.doesNotMatch(reason.message, /lost the budget reservation/, `a promotion must never report a lost reservation: ${reason.message}`);
  }
});

test("a cyclic parent chain is refused on the strict path instead of truncating the contamination walk", async () => {
  // buildAncestry stopped at the first repeat and returned a TRUNCATED ancestry
  // with no error. On the strict path findContaminationPath then compares only
  // the generations the walk reached, so an environment reachable only past the
  // repeat point is never compared and a contaminated candidate passes a gate
  // that reported nothing wrong. Two generation bodies build the cycle, and
  // hand-authored bodies are the reachable path for every refusal in this
  // module — `parent_not_promoted` is enforced at register time, not here.
  const { root, pmRoot, client, harness } = await workspace();
  const env = await registerEnv(harness, pmRoot, root, "Grid");
  const approval = await client.create({ id: "approval-1", title: "Approval", type: "Decision", status: "open", body: "# approval\n\n```json\n" + JSON.stringify({ permitted_promotions: 5 }) + "\n```" });
  const seed = await registerSeed(harness, pmRoot, "gen-seed", "ckpt-seed", "ckpt-seed");
  const run = resultOf(await harness.runCommand({ command: "rl run start", pmRoot, args: ["run-1"], options: { environment: env, algorithm: "ckpt-seed" } }));
  const candidate = resultOf(await harness.runCommand({ command: "rl generation register", pmRoot, args: ["gen-c1"], options: { baseCheckpoint: "ckpt-c1", parent: seed, policy: "ckpt-c1", collectionRuns: run.id, environment: env } }));
  // A second generation whose spec is a valid non-seed record, parented to the
  // candidate; then repoint the candidate at it. Both bodies stay parseable, so
  // the walk reaches the repeat rather than failing earlier on a malformed one.
  const c1Body = String((await client.get(candidate.id!, { fields: "body" })).item.body);
  // Plain string replace, not RegExp: JSON.stringify quotes and escapes JSON,
  // it does not escape regex metacharacters, so a tracker id containing one
  // would match nothing, the cycle would never be authored, and the test would
  // fail naming a property it never exercised.
  const seedParent = `"parent": ${JSON.stringify(seed)}`;
  const partner = await client.create({ id: "gen-c2", title: "Partner", type: "Generation", status: "open", body: c1Body.replace('"base_checkpoint": "ckpt-c1"', '"base_checkpoint": "ckpt-c2"').replace(seedParent, `"parent": ${JSON.stringify(candidate.id!)}`) });
  assert.notEqual(String(partner.item.body), c1Body, "the partner body must differ, or the cycle was never authored");
  await client.update(candidate.id!, { body: c1Body.replace(seedParent, `"parent": ${JSON.stringify(String(partner.item.id))}`), message: "Author a parent cycle" });
  await assert.rejects(
    harness.runCommand({ command: "rl generation promote", pmRoot, args: [candidate.id!], options: { approval: approval.item.id, scores: writeScores(root, 12, "held-out-ctx", 9), evidence: "cyclic" } }),
    (error: Error) => {
      assert.match(error.message, /appears twice in its own parent chain/, "the refusal must name the cycle, not a downstream symptom");
      return true;
    },
  );
  // The tolerant VIEW still renders: a degraded lineage is still useful, and
  // only the gate that decides a promotion may refuse on it. A third
  // generation hanging off the cycle is what makes the tolerant path
  // reachable — neither cycle member is a head, since each is the other's
  // parent, so head enumeration would never walk into the loop without it.
  const descendant = await client.create({ id: "gen-c3", title: "Descendant", type: "Generation", status: "open", body: c1Body.replace('"base_checkpoint": "ckpt-c1"', '"base_checkpoint": "ckpt-c3"').replace(seedParent, `"parent": ${JSON.stringify(candidate.id!)}`) });
  const view = resultOf(await harness.runCommand({ command: "rl lineage", pmRoot }));
  assert.ok(String(view.details?.output).includes(`head: ${String(descendant.item.id)}`), "the head whose chain enters the cycle still renders");
  assert.doesNotMatch(String(view.details?.output), /appears twice in its own parent chain/, "the view must not surface the promotion refusal");
});

test("a peer edit under the lock survives the promoting write, and one that changes the decision refuses", async () => {
  // The promoted body was rendered from the PRE-LOCK spec, so a peer edit that
  // does not set `promoted` passed the already-promoted guard and was then
  // overwritten by the promoting write — discarded on the SUCCESS path, with no
  // receipt. This is the other half of the revert-path defect fixed a round
  // earlier: both wrote a snapshot taken before any peer could be excluded.
  const { root, pmRoot, client, harness } = await workspace();
  const env = await registerEnv(harness, pmRoot, root, "Grid");
  const approval = await client.create({ id: "approval-1", title: "Approval", type: "Decision", status: "open", body: "# approval\n\n```json\n" + JSON.stringify({ permitted_promotions: 5 }) + "\n```" });
  const seed = await registerSeed(harness, pmRoot, "gen-seed", "ckpt-seed", "ckpt-seed");
  const run = resultOf(await harness.runCommand({ command: "rl run start", pmRoot, args: ["run-1"], options: { environment: env, algorithm: "ckpt-seed" } }));
  const candidate = resultOf(await harness.runCommand({ command: "rl generation register", pmRoot, args: ["gen-c1"], options: { baseCheckpoint: "ckpt-c1", parent: seed, policy: "ckpt-c1", collectionRuns: run.id, environment: env } }));
  // A peer edits training_config, which the promotion decision does not consume.
  const withPeerEdit = String((await client.get(candidate.id!, { fields: "body" })).item.body).replace('"training_config": {}', '"training_config": {\n    "peer": "kept"\n  }');
  const peerClient = new PmClient({ pmRoot, author: "peer" });
  const sdk = sdkWith(clientWithConcurrentEditThenFailingClose(new PmClient({ pmRoot, author: "pm-rl-test" }), candidate.id!, withPeerEdit, { failClose: false }));
  void peerClient;
  const promoted = resultOf(await harness.runCommand({ command: "rl generation promote", pmRoot, args: [candidate.id!], options: { approval: approval.item.id, scores: writeScores(root, 12, "held-out-ctx", 9), evidence: "peer-edit" }, sdk }));
  assert.equal(promoted.details?.budget_consumed, 1, "the promotion still succeeds");
  const finalBody = String((await client.get(candidate.id!, { fields: "body" })).item.body);
  assert.match(finalBody, /"promoted": true/, "the promotion was written");
  assert.match(finalBody, /"peer": "kept"/, "the peer edit to a field the decision does not consume must survive the promoting write");
});

test("a generation's affected_version survives promotion, because it pins provenance and not outcome", async () => {
  // affected_version is a content identity for what a generation was trained
  // FROM. Promotion legitimately rewrites the outcome fields, so hashing the
  // whole specification would make the recorded identity disagree with the
  // stored body the moment a generation is promoted — and any integrity check
  // applying the re-hash rule that verifyEnvironmentIdentity applies to
  // Environments would then report every promoted generation as mutated.
  const { root, pmRoot, client, harness } = await workspace();
  const env = await registerEnv(harness, pmRoot, root, "Grid");
  const approval = await client.create({ id: "approval-1", title: "Approval", type: "Decision", status: "open", body: "# approval\n\n```json\n" + JSON.stringify({ permitted_promotions: 1 }) + "\n```" });
  const seed = await registerSeed(harness, pmRoot, "gen-seed", "ckpt-seed", "ckpt-seed");
  const run = resultOf(await harness.runCommand({ command: "rl run start", pmRoot, args: ["run-1"], options: { environment: env, algorithm: "ckpt-seed" } }));
  const candidate = resultOf(await harness.runCommand({ command: "rl generation register", pmRoot, args: ["gen-c1"], options: { baseCheckpoint: "ckpt-c1", parent: seed, policy: "ckpt-c1", collectionRuns: run.id, environment: env } }));
  const before = String((await client.get(candidate.id!, { fields: "affected_version" })).item.affected_version);
  await harness.runCommand({ command: "rl generation promote", pmRoot, args: [candidate.id!], options: { approval: approval.item.id, scores: writeScores(root, 12, "held-out-ctx", 9), evidence: "identity" } });
  const after = await client.get(candidate.id!, { fields: "affected_version,body" });
  assert.equal(String(after.item.affected_version), before, "the recorded identity must not move when the outcome is written");
  // And it must still describe the stored body: re-deriving the provenance from
  // the promoted spec reproduces the same hash.
  const fenced = /```json\n([\s\S]+?)\n```/.exec(String(after.item.body));
  const promotedSpec = JSON.parse(String(fenced?.[1])) as Record<string, unknown>;
  assert.equal(promotedSpec["promoted"], true, "the body must actually be the promoted one");
  assert.equal(hashJson({ base_checkpoint: promotedSpec["base_checkpoint"], policy: promotedSpec["policy"], collection_runs: promotedSpec["collection_runs"], training_config: promotedSpec["training_config"], environment_version: promotedSpec["environment_version"], reward_spec_version: promotedSpec["reward_spec_version"], parent: promotedSpec["parent"], seed: promotedSpec["seed"] } as never), before, "re-hashing the provenance of the promoted body must reproduce the recorded identity");
});

test("the SDK normalizes a Run's environment identity, which is what makes the strict-equality contamination compare safe", async () => {
  // findContaminationPath compares environment identities by strict equality,
  // so a Run recording `"  env  "` would match nothing and the evaluation set
  // would become unreachable from the training data — the gate passing a
  // candidate it exists to refuse.
  //
  // That is NOT reachable today: the pm SDK normalizes typed item fields, so
  // even a hand-written padded value in the `.toon` reads back trimmed. This
  // package depends on that, and the dependency belongs to another package, so
  // it is asserted here rather than assumed. If the SDK ever stops trimming,
  // this fails in pm-rl's own suite instead of showing up as a contaminated
  // promotion that passed.
  const { root, pmRoot, client, harness } = await workspace();
  const env = await registerEnv(harness, pmRoot, root, "Grid");
  const run = resultOf(await harness.runCommand({ command: "rl run start", pmRoot, args: ["run-1"], options: { environment: env, algorithm: "ckpt-seed" } }));
  await client.update(String(run.id), { environment: `  ${env}  `, message: "Attempt to store a padded environment identity" });
  const readBack = await client.get(String(run.id), { fields: "environment" });
  assert.equal(String(readBack.item.environment), env, "the SDK must normalize the stored environment identity; pm-rl's contamination compare relies on it");
});

test("an approval whose budget is lowered under the lock is honoured, not the capacity read before it", async () => {
  // The budget check compares two values: the count of promotions already made,
  // and the capacity the approval permits. Re-reading only the count leaves the
  // comparison stale in the other direction — an approval narrowed while this
  // caller waited for the lock would be compared against the capacity it had
  // before, and the promotion would exceed the approval that governs it.
  const { root, pmRoot, client, harness } = await workspace();
  const env = await registerEnv(harness, pmRoot, root, "Grid");
  const approval = await client.create({ id: "approval-1", title: "Approval", type: "Decision", status: "open", body: "# approval\n\n```json\n" + JSON.stringify({ permitted_promotions: 1 }) + "\n```" });
  const seed = await registerSeed(harness, pmRoot, "gen-seed", "ckpt-seed", "ckpt-seed");
  const run = resultOf(await harness.runCommand({ command: "rl run start", pmRoot, args: ["run-1"], options: { environment: env, algorithm: "ckpt-seed" } }));
  const candidate = resultOf(await harness.runCommand({ command: "rl generation register", pmRoot, args: ["gen-c1"], options: { baseCheckpoint: "ckpt-c1", parent: seed, policy: "ckpt-c1", collectionRuns: run.id, environment: env } }));
  // A peer revokes the remaining capacity between the two approval reads. The
  // helper edits AFTER the triggering get returns, so triggering on the
  // approval itself means the pre-lock parse sees 1 and only an in-lock re-read
  // sees 0 — which is precisely the window under test. Triggering on the
  // candidate read instead lands the edit before the pre-lock parse, and the
  // test then passes with the in-lock re-read removed. Verified by removing it.
  const revoked = "# approval\n\n```json\n" + JSON.stringify({ permitted_promotions: 0 }) + "\n```";
  const sdk = sdkWith(clientWithConcurrentEditThenFailingClose(new PmClient({ pmRoot, author: "pm-rl-test" }), candidate.id!, revoked, { failClose: false, editId: String(approval.item.id), triggerId: String(approval.item.id) }));
  await assert.rejects(
    harness.runCommand({ command: "rl generation promote", pmRoot, args: [candidate.id!], options: { approval: approval.item.id, scores: writeScores(root, 12, "held-out-ctx", 9), evidence: "revoked" }, sdk }),
    (error: Error) => {
      assert.match(error.message, /Advancing past the approved promotion budget is refused/, "the refusal must be the budget one");
      assert.match(error.message, /permits 0/, `and must report the CURRENT capacity, not the one read before the lock, got: ${error.message}`);
      return true;
    },
  );
  assert.doesNotMatch(String((await client.get(candidate.id!, { fields: "body" })).item.body), /"promoted": true/, "a refused promotion must leave the record unpromoted");
});

test("a peer contaminating an ANCESTOR under the lock is caught, because the verdict is re-decided over the whole ancestry", async () => {
  // The contamination verdict is computed by walking every ancestor and reading
  // each one's environment version. Comparing only the candidate's own fields
  // under the lock was not enough: a peer editing an ANCESTOR leaves the leaf
  // byte-identical and the verdict stale, so the promotion would record a clean
  // verdict about provenance that is no longer clean.
  //
  // The fixture has to keep the candidate itself clean, or contamination is
  // found pre-lock and the test proves nothing. `holdout` is a second
  // environment that nothing references until the peer edit points the SEED at
  // it, and the edit is triggered on the APPROVAL read — after the pre-lock
  // walk and verdict, before the transaction opens.
  const { root, pmRoot, client, harness } = await workspace();
  const env = await registerEnv(harness, pmRoot, root, "Grid");
  const holdout = await registerEnv(harness, pmRoot, root, "Holdout");
  assert.notEqual(holdout, env, "the held-out environment must be distinct, or the candidate is contaminated before the peer edit");
  const approval = await client.create({ id: "approval-1", title: "Approval", type: "Decision", status: "open", body: "# approval\n\n```json\n" + JSON.stringify({ permitted_promotions: 5 }) + "\n```" });
  const seed = await registerSeed(harness, pmRoot, "gen-seed", "ckpt-seed", "ckpt-seed");
  const run = resultOf(await harness.runCommand({ command: "rl run start", pmRoot, args: ["run-1"], options: { environment: env, algorithm: "ckpt-seed" } }));
  const candidate = resultOf(await harness.runCommand({ command: "rl generation register", pmRoot, args: ["gen-c1"], options: { baseCheckpoint: "ckpt-c1", parent: seed, policy: "ckpt-c1", collectionRuns: run.id, environment: env } }));
  const seedBody = String((await client.get(seed, { fields: "body" })).item.body);
  const contaminatedSeed = seedBody.replace(/"environment_version": "[^"]*"/, `"environment_version": ${JSON.stringify(holdout)}`);
  assert.notEqual(contaminatedSeed, seedBody, "the peer edit must change the seed, or nothing is injected");
  const sdk = sdkWith(clientWithConcurrentEditThenFailingClose(new PmClient({ pmRoot, author: "pm-rl-test" }), candidate.id!, contaminatedSeed, { failClose: false, editId: seed, triggerId: String(approval.item.id) }));
  const settled = await harness.runCommand({ command: "rl generation promote", pmRoot, args: [candidate.id!], options: { approval: approval.item.id, scores: writeScores(root, 12, holdout, 9), evidence: "ancestor" }, sdk }).then(() => "promoted").catch((error: Error) => error.message);
  assert.notEqual(settled, "promoted", "a promotion whose ancestry became contaminated under the lock must not succeed");
  assert.match(String(settled), /reachable from the candidate's training data/, `the refusal must be the contamination verdict itself, got: ${String(settled)}`);
  assert.match(String(settled), new RegExp(String(seed).replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`)), "and the path must implicate the ANCESTOR the peer edited, not the candidate");
  assert.doesNotMatch(String((await client.get(candidate.id!, { fields: "body" })).item.body), /"promoted": true/, "a refused promotion must leave the record unpromoted");
});

test("a revert that also fails reports both causes instead of hiding the close error", async () => {
  // The close error explains what happened; a revert failure must not replace
  // it. When both fail the situation is worse than either alone — the body
  // reads as promoted while the item was never closed — so both are reported,
  // original cause first.
  const { root, pmRoot, client, harness } = await workspace();
  const env = await registerEnv(harness, pmRoot, root, "Grid");
  const approval = await client.create({ id: "approval-1", title: "Approval", type: "Decision", status: "open", body: "# approval\n\n```json\n" + JSON.stringify({ permitted_promotions: 1 }) + "\n```" });
  const seed = await registerSeed(harness, pmRoot, "gen-seed", "ckpt-seed", "ckpt-seed");
  const run = resultOf(await harness.runCommand({ command: "rl run start", pmRoot, args: ["run-1"], options: { environment: env, algorithm: "ckpt-seed" } }));
  const candidate = resultOf(await harness.runCommand({ command: "rl generation register", pmRoot, args: ["gen-c1"], options: { baseCheckpoint: "ckpt-c1", parent: seed, policy: "ckpt-c1", collectionRuns: run.id, environment: env } }));
  const failing = sdkWith(clientWithFailingCloseAndFailingRevert(new PmClient({ pmRoot, author: "pm-rl-test" })));
  // Reported through `fail`, so it is an EXPECTED command error with a stable
  // code and exit status rather than a plain Error — this is the path an
  // automated caller most needs to classify. The harness rejects on pm expected
  // errors and captures anything else into errorMessage, so the rejection here
  // is itself part of what is being asserted.
  await assert.rejects(
    harness.runCommand({ command: "rl generation promote", pmRoot, args: [candidate.id!], options: { approval: approval.item.id, scores: writeScores(root, 12, "held-out-ctx", 9), evidence: "x" }, sdk: failing }),
    (error: Error) => {
      assert.match(error.message, /close failed after the promoting write/, "the original close error must survive");
      assert.match(error.message, /revert of the promoting write also failed/, "and the revert failure must be reported alongside it");
      assert.match(error.message, /still reads as promoted while it was never closed/, "naming the state an operator has to repair");
      return true;
    },
  );
});

test("a failed close restores the body that was current when the lock was taken, not the one read before it", async () => {
  // `revertPromotingWrite` writes a captured body back over the promoting write.
  // Capturing it from the PRE-LOCK read discards any edit a peer landed between
  // that read and the lock: the revert would resurrect a body the peer had
  // already replaced, and the peer's write would be gone with no receipt. The
  // in-lock re-read is the only body that was actually overwritten.
  const { root, pmRoot, client, harness } = await workspace();
  const env = await registerEnv(harness, pmRoot, root, "Grid");
  const approval = await client.create({ id: "approval-1", title: "Approval", type: "Decision", status: "open", body: "# approval\n\n```json\n" + JSON.stringify({ permitted_promotions: 1 }) + "\n```" });
  const seed = await registerSeed(harness, pmRoot, "gen-seed", "ckpt-seed", "ckpt-seed");
  const run = resultOf(await harness.runCommand({ command: "rl run start", pmRoot, args: ["run-1"], options: { environment: env, algorithm: "ckpt-seed" } }));
  const candidate = resultOf(await harness.runCommand({ command: "rl generation register", pmRoot, args: ["gen-c1"], options: { baseCheckpoint: "ckpt-c1", parent: seed, policy: "ckpt-c1", collectionRuns: run.id, environment: env } }));
  // The peer's edit keeps the record a valid unpromoted generation, so the
  // in-lock re-read parses and the promotion proceeds to the failing close.
  const original = await client.get(candidate.id!, { fields: "body" });
  // Edits a field the promotion decision does NOT consume, so the in-lock
  // change guard lets the promotion proceed to the failing close. A decision
  // field would be refused first, and this test would then pass without ever
  // reaching the revert it exists to check.
  const peerBody = String(original.item.body).replace('"training_config": {}', '"training_config": {\n    "peer": "kept"\n  }');
  assert.notEqual(peerBody, String(original.item.body), "the peer edit must actually differ, or this test proves nothing");
  const sdk = sdkWith(clientWithConcurrentEditThenFailingClose(new PmClient({ pmRoot, author: "pm-rl-test" }), candidate.id!, peerBody));
  const failed = await harness.runCommand({ command: "rl generation promote", pmRoot, args: [candidate.id!], options: { approval: approval.item.id, scores: writeScores(root, 12, "held-out-ctx", 9), evidence: "x" }, sdk });
  assert.equal(failed.handled, false);
  const reread = await client.get(candidate.id!, { fields: "body" });
  assert.doesNotMatch(String(reread.item.body), /"promoted": true/, "the promoting write must still be reverted");
  assert.match(String(reread.item.body), /"peer": "kept"/, "the revert must restore the peer's body, not the pre-lock one it never saw");
});

test("a promotion whose close fails reverts its own body write rather than leaving budget consumed", async () => {
  const { root, pmRoot, client, harness } = await workspace();
  const failing = sdkWith(clientWithFailingClose(new PmClient({ pmRoot, author: "pm-rl-test" })));
  const env = await registerEnv(harness, pmRoot, root, "Grid");
  const approval = await client.create({ id: "approval-1", title: "Approval", type: "Decision", status: "open", body: "# approval\n\n```json\n" + JSON.stringify({ permitted_promotions: 1 }) + "\n```" });
  const seed = await registerSeed(harness, pmRoot, "gen-seed", "ckpt-seed", "ckpt-seed");
  const run = resultOf(await harness.runCommand({ command: "rl run start", pmRoot, args: ["run-1"], options: { environment: env, algorithm: "ckpt-seed" } }));
  const candidate = resultOf(await harness.runCommand({ command: "rl generation register", pmRoot, args: ["gen-c1"], options: { baseCheckpoint: "ckpt-c1", parent: seed, policy: "ckpt-c1", collectionRuns: run.id, environment: env } }));
  // The harness captures a non-pm error into errorMessage rather than rejecting;
  // only pm expected errors propagate as rejections.
  const failed = await harness.runCommand({ command: "rl generation promote", pmRoot, args: [candidate.id!], options: { approval: approval.item.id, scores: writeScores(root, 12, "held-out-ctx", 9), evidence: "x" }, sdk: failing });
  assert.equal(failed.handled, false);
  assert.match(String(failed.errorMessage), /close failed after the promoting write/);
  // The body must NOT read as promoted: a half-applied promotion left in place
  // would consume the single permitted promotion without ever completing one.
  const reread = await client.get(candidate.id!, { fields: "body,status" });
  assert.doesNotMatch(String(reread.item.body), /"promoted": true/);
  assert.equal(String(reread.item.status), "open");
  // And the budget it never spent is still available to a real promotion.
  const recovered = resultOf(await harness.runCommand({ command: "rl generation promote", pmRoot, args: [candidate.id!], options: { approval: approval.item.id, scores: writeScores(root, 12, "held-out-ctx", 9), evidence: "recovered" } }));
  assert.equal(recovered.details?.budget_consumed, 1);
});

test("concurrent promotions of the SAME generation promote it exactly once", async () => {
  const { root, pmRoot, client, harness } = await workspace();
  const env = await registerEnv(harness, pmRoot, root, "Grid");
  // A budget of 3, so the budget itself cannot be what stops the second caller —
  // only the already-promoted check can, and it has to hold under concurrency.
  const approval = await client.create({ id: "approval-1", title: "Approval", type: "Decision", status: "open", body: "# approval\n\n```json\n" + JSON.stringify({ permitted_promotions: 3 }) + "\n```" });
  const seed = await registerSeed(harness, pmRoot, "gen-seed", "ckpt-seed", "ckpt-seed");
  const run = resultOf(await harness.runCommand({ command: "rl run start", pmRoot, args: ["run-1"], options: { environment: env, algorithm: "ckpt-seed" } }));
  const candidate = resultOf(await harness.runCommand({ command: "rl generation register", pmRoot, args: ["gen-c1"], options: { baseCheckpoint: "ckpt-c1", parent: seed, policy: "ckpt-c1", collectionRuns: run.id, environment: env } }));
  const scores = writeScores(root, 12, "held-out-ctx", 9);
  // Three callers read the candidate as unpromoted before any of them takes the
  // lock, so the pre-lock check passes for all three.
  const sdks = [0, 1, 2].map((index) => sdkWith(new PmClient({ pmRoot, author: `agent-${index}` })));
  const settled = await Promise.allSettled(sdks.map((sdk, index) => harness.runCommand({ command: "rl generation promote", pmRoot, args: [candidate.id!], options: { approval: approval.item.id, scores, evidence: `agent-${index}` }, sdk })));
  const successes = settled.filter((r) => r.status === "fulfilled").length;
  assert.equal(successes, 1, `one generation must promote exactly once, but ${successes} promotions succeeded`);
  for (const rejected of settled.filter((r) => r.status === "rejected")) {
    // Two outcomes are correct for a loser, exactly as in the budget race
    // above. `is already promoted` is reported by a caller that ACQUIRES the
    // lock and re-reads the state; a caller that exceeds the bounded
    // PROMOTION_LOCK_WAIT_MS never gets to re-read and reports the lock owner
    // instead. Demanding only the first asserts a stronger property than the
    // system provides, and would fail intermittently on a slower machine for a
    // reason unrelated to the guarantee under test. What must never appear is a
    // second promotion, which the successes assertion above already pins.
    assert.match(String((rejected as PromiseRejectedResult).reason), /is already promoted|is locked \(owner /, `unexpected refusal reason: ${String((rejected as PromiseRejectedResult).reason)}`);
  }
  // And it consumed exactly one unit of the budget, not one per caller. The
  // next candidate needs its own run, collected under the promoted parent's policy.
  const run2 = resultOf(await harness.runCommand({ command: "rl run start", pmRoot, args: ["run-2"], options: { environment: env, algorithm: "ckpt-c1" } }));
  const second = resultOf(await harness.runCommand({ command: "rl generation register", pmRoot, args: ["gen-c2"], options: { baseCheckpoint: "ckpt-c2", parent: candidate.id, policy: "ckpt-c2", collectionRuns: run2.id, environment: env } }));
  const next = resultOf(await harness.runCommand({ command: "rl generation promote", pmRoot, args: [second.id!], options: { approval: approval.item.id, scores, evidence: "second" } }));
  assert.equal(next.details?.budget_consumed, 2);
});

