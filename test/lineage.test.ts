/** Recursive-self-improvement lineage: pure provenance math and the generation/lineage commands. */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { PmClient } from "@unbrained/pm-cli/sdk/core";
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
          { id: "gen-seed", seed: true, base_checkpoint: "ckpt-0", collection_runs: [], proxy_score: null, held_out_score: null, gap: null, gap_delta: null, approval: null, promotion_evidence: null, invalidated: null },
          { id: "gen-c1", seed: false, base_checkpoint: "ckpt-1", collection_runs: ["run-1"], proxy_score: 10, held_out_score: 8, gap: 2, gap_delta: 2, approval: "approval-1", promotion_evidence: "rose on held-out", invalidated: null },
        ],
        findings: ["gap widening over last 3 promotions"],
      },
      {
        head: "gen-d1",
        rows: [
          { id: "gen-dseed", seed: true, base_checkpoint: "ckpt-0", collection_runs: [], proxy_score: null, held_out_score: null, gap: null, gap_delta: null, approval: null, promotion_evidence: null, invalidated: null },
          { id: "gen-d1", seed: false, base_checkpoint: "ckpt-9", collection_runs: [], proxy_score: 5, held_out_score: 7, gap: -2, gap_delta: -2, approval: "approval-d", promotion_evidence: "fell back", invalidated: "environment was edited" },
        ],
        findings: [],
      },
    ],
  };
  const table = renderLineageTable(view);
  assert.match(table, /head: gen-c1/);
  assert.match(table, /gen-seed \| seed \|/);
  assert.match(table, /gen-c1 \| generation \| base=ckpt-1 .* delta=\+2\.0000 .* approval=approval-1 .* evidence=rose on held-out \| promoted/);
  assert.match(table, /findings: gap widening over last 3 promotions/);
  assert.match(table, /gen-d1 .* delta=-2\.0000 .* environment was edited/);
  assert.match(table, /head: gen-d1/);
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
  const altTrainEnv = await registerEnv(harness, pmRoot, root, "AltTrain", "2");
  const heldOutEnv = await registerEnv(harness, pmRoot, root, "HeldOut", "3");
  const heldOutRun = resultOf(await harness.runCommand({ command: "rl run start", pmRoot, args: ["run-heldout"], options: { environment: heldOutEnv, algorithm: "ckpt-seed" } }));
  await harness.runCommand({ command: "rl generation register", pmRoot, args: ["gen-c2"], options: { baseCheckpoint: "ckpt-c2", parent: seed, policy: "ckpt-c2", collectionRuns: heldOutRun.id, environment: altTrainEnv } });
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
      assert.match(error.message, new RegExp(twoApproval.item.id), "the refusal must name the approval item to extend");
      return true;
    },
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
  assert.match(String(after.details?.output), new RegExp(`${genA.id!} .* environment was edited`));
  assert.match(String(after.details?.output), new RegExp(`${genB.id!} .* invalidated by ancestor ${genA.id!}`));
  // A generation whose environment does not resolve is reported as ABSENT, not as edited.
  const ghostSpec = { ...seedSpec("ckpt-g", ""), environment_version: "ghost-env-v1", parent: "rl-gen-seed", seed: false, policy: "g", collection_runs: ["ghost-run"], reward_spec_version: "r" };
  await client.create({ id: "gen-ghost", title: "Ghost", type: "Generation", status: "open", ...generationBody(ghostSpec) });
  const ghostLineage = resultOf(await harness.runCommand({ command: "rl lineage", pmRoot, args: ["gen-ghost"] }));
  assert.match(String(ghostLineage.details?.output), /gen-ghost .* environment could not be resolved/);
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
