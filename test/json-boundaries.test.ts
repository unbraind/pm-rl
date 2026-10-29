/** Producer/consumer byte and depth agreement across real tracker and artifact boundaries. */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, existsSync, writeFileSync, globSync, mkdirSync, copyFileSync, symlinkSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import { after, test } from "node:test";
import { parseSync } from "@babel/core";
import { PmClient } from "@unbrained/pm-cli/sdk/core";
import { init, isPmCliExpectedError } from "@unbrained/pm-cli/sdk/runtime";
import { createExtensionTestHarness } from "@unbrained/pm-cli/sdk/testing";
import extension, { canonicalJson, generationProvenance, hashJson, readCompleteLoopItem, type JsonValue } from "../index.ts";
import { parseEvaluationPlan, registerEvaluationPlan, readEvaluationPlan, evaluationComparison, evaluatePlan, type EvaluationPlan } from "../evaluation-plan.ts";
import { parseShadowDeployment, registerShadowDeployment } from "../shadow.ts";
import { assertJsonEncoding, encodeBoundedJson, parseBoundedJson, MAX_JSON_BYTES, MAX_TRACKER_RECORD_BYTES } from "../tracker-record.ts";
import { largePlan, reservation, wrapperOverflowPlan } from "./fixtures/json-boundary.ts";
import { writeTrainerArtifact } from "../process-bandit.ts";

const roots: string[] = [];
after(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });
/** Match a content-free actionable size refusal rather than a later missing/drifted record. */
function limit(error: unknown): boolean { return isPmCliExpectedError(error) && error.context.code === "json_record_limit" && /json_record_limit/.test(error.message) && /Reduce or split/.test(error.message); }

test("every isolated trainer image includes its producer runtime dependency closure", () => {
  const repository = fileURLToPath(new URL("../", import.meta.url));
  for (const recipe of ["test/fixtures/compose.Dockerfile", "test/fixtures/lm-compose.Dockerfile", "lm-trainer.Dockerfile"]) {
    const root = mkdtempSync(join(tmpdir(), "rl-trainer-closure-")); roots.push(root);
    const text = readFileSync(join(repository, recipe), "utf8");
    for (const match of text.matchAll(/^COPY (.+) (\S+)$/gm)) {
      const directory = join(root, match[2]); mkdirSync(directory, { recursive: true });
      for (const pattern of match[1].split(" ")) {
        const files = globSync(pattern, { cwd: repository }); assert.ok(files.length > 0, pattern);
        for (const file of files) copyFileSync(join(repository, file), join(directory, basename(file)));
      }
    }
    if (/^RUN npm ci --ignore-scripts(?: |$)/m.test(text)) {
      assert.equal(readFileSync(join(root, "package-lock.json"), "utf8"), readFileSync(join(repository, "package-lock.json"), "utf8"));
      symlinkSync(join(repository, "node_modules"), join(root, "node_modules"), "dir");
    }
    const entry = JSON.parse(text.match(/^ENTRYPOINT (.+)$/m)![1]) as string[];
    const sources = entry.join(" ").match(/\/trainer\/[\w/.-]+\.ts/g)!;
    assert.ok(sources.length > 0);
    const dependencies = sources.flatMap((file) => {
      const source = join(root, file.replace(/^\/trainer\//, ""));
      return [...readFileSync(source, "utf8").matchAll(/from "(\.[^"]+)"/g)].map((match) => pathToFileURL(join(dirname(source), match[1])).href);
    });
    assert.ok(dependencies.length > 0);
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", `for (const target of ${JSON.stringify(dependencies)}) await import(target)`], { cwd: root, encoding: "utf8", timeout: 120_000, env: { ...process.env, NODE_V8_COVERAGE: undefined, GIT_CEILING_DIRECTORIES: root } });
    assert.equal(child.status, 0, `${recipe}: ${child.stderr}`);
  }
});
/** Real plain-directory SDK tracker, with no enclosing Git discovery. */
async function workspace() {
  const root = mkdtempSync(join(tmpdir(), "rl-json-boundary-")); roots.push(root);
  const initialized = await init("rl", { defaults: true, agentGuidance: "skip", author: "json-boundary-test" }, { cwd: root, pmRoot: join(root, ".agents/pm") });
  return { root, pmRoot: initialized.path, client: new PmClient({ cwd: root, pmRoot: initialized.path, noExtensions: true, author: "json-boundary-test" }) };
}
/** Snapshot only this named disposable tracker's durable files, including all item/history/config bytes. */
function durable(root: string): Record<string, string> {
  const result: Record<string, string> = {};
  /** Derived query observations and locks are excluded from native state comparisons. */
  function visit(relative: string): void {
    for (const entry of readdirSync(join(root, relative), { withFileTypes: true })) {
      const key = join(relative, entry.name); if (key === "runtime" || key === "locks") continue;
      if (entry.isDirectory()) visit(key); else result[key] = readFileSync(join(root, key)).toString("base64");
    }
  }
  visit(""); return result;
}
/** Find raw JSON encoders inside persistent body/file sinks, without relying on source line spellings. */
function rawJsonWrites(source: string): number {
  let count = 0;
  /** Inspect compiler-owned AST records without trusting arbitrary property lookup. */
  function node(value: unknown): Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  }
  /** Resolve ordinary and computed identifier names in calls, fields and assignments. */
  function name(value: unknown): unknown { const n = node(value); return n.type === "MemberExpression" ? name(n.property) : n.type === "StringLiteral" ? n.value : n.name; }
  /** Every direct persistent sink must route JSON text through the shared encoding contract. */
  function visit(value: unknown, ancestors: readonly Record<string, unknown>[]): void {
    if (Array.isArray(value)) { for (const child of value) visit(child, ancestors); return; }
    const n = node(value); if (typeof n.type !== "string") return;
    const callee = node(n.callee);
    if (n.type === "CallExpression" && ((name(callee) === "stringify" && name(callee.object) === "JSON") || name(callee) === "canonicalJson")) {
      const sink = ancestors.some((parent) => (parent.type === "ObjectProperty" && name(parent.key) === "body") || (parent.type === "AssignmentExpression" && name(parent.left) === "body") || (parent.type === "CallExpression" && ["writeFile", "writeFileSync"].includes(String(name(parent.callee)))));
      const guarded = ancestors.some((parent) => parent.type === "CallExpression" && name(parent.callee) === "assertJsonEncoding");
      if (sink && !guarded) count += 1;
    }
    for (const child of Object.values(n)) visit(child, [...ancestors, n]);
  }
  visit(parseSync(source, { configFile: false, babelrc: false, sourceType: "module", parserOpts: { plugins: ["typescript"] } }), []);
  return count;
}

test("persistent SDK, CLI and file sinks cannot add an unguarded raw JSON encoder", () => {
  for (const source of ['client.create({body: JSON.stringify(value)})', 'item.body = JSON["stringify"](value)', 'writeFileSync(file, JSON.stringify(value))', 'client.create({body: canonicalJson(value)})', 'writeFile(file, `${JSON.stringify(value)}\\n`)']) assert.equal(rawJsonWrites(source), 1);
  assert.equal(rawJsonWrites('client.create({body: assertJsonEncoding(JSON.stringify(value))})'), 0);
  const root = new URL("../", import.meta.url);
  for (const file of readdirSync(root).filter((name) => name.endsWith(".ts"))) assert.equal(rawJsonWrites(readFileSync(new URL(file, root), "utf8")), 0, file);
});

test("every emitted encoding obeys the matching reader's inclusive byte and depth bounds", () => {
  for (const maximum of [MAX_TRACKER_RECORD_BYTES, MAX_JSON_BYTES]) {
    const atLimit = `"${"x".repeat(maximum - 2)}"`;
    assert.equal(Buffer.byteLength(assertJsonEncoding(atLimit, maximum)), maximum);
    assert.equal((parseBoundedJson(atLimit) as string).length, maximum - 2);
    assert.throws(() => assertJsonEncoding(`"${"x".repeat(maximum - 1)}"`, maximum), limit);
  }
  assert.throws(() => parseBoundedJson(`"${"x".repeat(MAX_JSON_BYTES - 1)}"`), SyntaxError);
  assert.throws(() => encodeBoundedJson(undefined), (error: unknown) => isPmCliExpectedError(error) && error.context.code === "json_record_invalid");
  const cycle: { value?: unknown } = {}; cycle.value = cycle;
  for (const value of [cycle, 1n]) assert.throws(() => encodeBoundedJson(value), (error: unknown) => isPmCliExpectedError(error) && error.context.code === "json_record_invalid");
  for (const maximum of [NaN, Infinity, -Infinity, -1, 0, 0.5, MAX_JSON_BYTES + 1]) assert.throws(() => encodeBoundedJson({ value: "valid JSON" }, maximum), (error: unknown) => isPmCliExpectedError(error) && error.context.code === "json_record_invalid");
  assert.throws(() => assertJsonEncoding("[".repeat(65) + "0" + "]".repeat(65)), limit);
  assert.throws(() => parseBoundedJson("[".repeat(65) + "0" + "]".repeat(65)), SyntaxError);
  assert.deepEqual(parseBoundedJson(assertJsonEncoding("[".repeat(64) + "0" + "]".repeat(64))), JSON.parse("[".repeat(64) + "0" + "]".repeat(64)));
  assert.equal(parseBoundedJson(encodeBoundedJson("quoted brackets [[[[ and escaped \\\" ] ] ] 😀")), "quoted brackets [[[[ and escaped \\\" ] ] ] 😀");
});

test("500 seeded byte/depth/escaping variants either round-trip through the reader and SDK or refuse before a file exists", async () => {
  const w = await workspace(); let state = 0x5eed16;
  /** Deterministic operation choices include both Unicode byte expansion and JSON escape expansion. */
  function next(): number { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state >>> 12; }
  const symbols = ["a", "é", "😀", "\u0000", '"', "\\", "\r\n", "[]{}"];
  for (let i = 0; i < 500; i += 1) {
    const count = next() % 1024; const text = symbols[next() % symbols.length].repeat(count); const layers = next() % 67;
    let nested: JsonValue = text; for (let depth = 0; depth < layers; depth += 1) nested = [nested];
    const value: JsonValue = { text, nested }; const maximum = next() % 8192 + 2;
    const serializers = [(): string => encodeBoundedJson(value, maximum), (): string => assertJsonEncoding(canonicalJson(value), maximum), (): string => encodeBoundedJson(value, maximum, 2)];
    for (const [index, serialize] of serializers.entries()) {
      const native: string = index === 1 ? canonicalJson(value) : JSON.stringify(value, null, index === 2 ? 2 : undefined);
      if (Buffer.byteLength(native) > maximum || layers + 1 > 64) assert.throws(serialize, limit);
      else assert.deepEqual(parseBoundedJson(serialize()), JSON.parse(native));
    }
    if (i % 50 === 0) {
      const file = join(w.root, `artifact-${i}.json`);
      if (Buffer.byteLength(JSON.stringify(value)) > maximum || layers + 1 > 64) {
        assert.throws(() => writeTrainerArtifact(file, value, maximum), limit); assert.equal(existsSync(file), false);
      } else {
        writeTrainerArtifact(file, value, maximum);
        const created = await w.client.create({ id: `rl-json-${i}`, type: "Decision", title: "Encoding round trip", body: readFileSync(file, "utf8"), unset: ["parent", "sprint", "release", "blocked-by"], clearDeps: true });
        assert.deepEqual(parseBoundedJson(String((await readCompleteLoopItem(w.client, created.item.id)).item.body)), JSON.parse(JSON.stringify(value)));
      }
    }
  }
});

test("expanded cohort reservations and raw-input-fit wrapper overflows refuse through SDK and CLI before persistence", { timeout: 120_000 }, async () => {
  const w = await workspace(); const maximum = largePlan(); assert.ok(Buffer.byteLength(reservation(maximum)) > MAX_JSON_BYTES);
  const wrapperOnly = wrapperOverflowPlan(); const input = JSON.stringify(wrapperOnly);
  assert.ok(Buffer.byteLength(input) <= MAX_JSON_BYTES); assert.ok(Buffer.byteLength(reservation(wrapperOnly)) > MAX_JSON_BYTES);
  assert.deepEqual(parseBoundedJson(input), wrapperOnly);
  const before = durable(w.pmRoot);
  for (const plan of [maximum, wrapperOnly]) {
    assert.throws(() => parseEvaluationPlan(plan), limit);
    assert.throws(() => evaluatePlan(plan, []), limit);
    await assert.rejects(registerEvaluationPlan(w.client, plan), limit);
    assert.deepEqual(durable(w.pmRoot), before);
  }
  const file = join(w.root, "wrapper-overflow.json"); writeFileSync(file, input);
  const harness = await createExtensionTestHarness(extension, { name: "pm-rl", capabilities: ["commands", "hooks", "schema"] });
  await assert.rejects(harness.runCommand({ command: "rl eval plan register", pmRoot: w.pmRoot, options: { file } }), limit);
  assert.deepEqual(durable(w.pmRoot), before);
});

test("a readable plan cannot preview evidence whose complete sealed envelope exceeds the reader limit", () => {
  const base = JSON.parse(readFileSync(new URL("../examples/evaluation-plan.json", import.meta.url), "utf8")) as EvaluationPlan;
  const members = Array.from({ length: 10_000 }, (_, i) => ({ id: `${String(i).padStart(8, "0")}${"\u0000".repeat(269)}`, unit: `u-${i}` }));
  const plan = { ...base, members, stopping: { kind: "fixed" as const, observations: members.length, independent_units: members.length } };
  const observations = members.map((m) => ({ id: m.id, candidate: 0.12345678901234567, incumbent: 0.9876543210987654 }));
  assert.ok(Buffer.byteLength(reservation(plan)) <= MAX_JSON_BYTES);
  assert.ok(Buffer.byteLength(JSON.stringify({ comparison: "a".repeat(64), observations })) > MAX_JSON_BYTES);
  assert.deepEqual(parseEvaluationPlan(plan), plan);
  assert.throws(() => evaluatePlan(plan, observations), limit);
});

test("readable legacy plans retain exact serialization and native competing writers remain truthful", async () => {
  const w = await workspace(); await w.client.schemaAddType("Generation", { folder: "generations", defaultStatus: "open" });
  const seed = { base_checkpoint: "checkpoint", policy: "", collection_runs: [], training_config: {}, environment_version: "", reward_spec_version: "", parent: null, seed: true, promoted: false, approval: null, proxy_score: null, held_out_score: null, gap: null, promotion_evidence: null };
  await w.client.create({ id: "rl-seed", title: "Seed", type: "Generation", body: `\`\`\`json\n${JSON.stringify(seed)}\n\`\`\``, affectedVersion: hashJson(generationProvenance(seed)), unset: ["parent"] });
  const old = JSON.parse(readFileSync(new URL("../examples/evaluation-plan.json", import.meta.url), "utf8")) as EvaluationPlan;
  const plan = parseEvaluationPlan({ ...old, incumbent_version: hashJson(generationProvenance(seed)) });
  const peer = new PmClient({ cwd: w.root, pmRoot: w.pmRoot, noExtensions: true, author: "native-json-peer" });
  const create = w.client.create.bind(w.client);
  for (const outcome of ["same", "same-after-native-failure", "different", "absent"] as const) {
    const intended = parseEvaluationPlan({ ...plan, candidate: `rl-${outcome}` });
    const winner = outcome === "different" ? parseEvaluationPlan({ ...intended, selection: "Native peer selection" }) : intended;
    // Successful observations always come from the SDK; competing writes and invalid-ID failures are native too.
    w.client.create = (async (options) => {
      if (outcome === "absent") return peer.create({ ...options, id: " " });
      await peer.create({ ...options, body: reservation(winner), affectedVersion: hashJson({ comparison: evaluationComparison(winner), incumbent_version: winner.incumbent_version }) });
      if (outcome === "same-after-native-failure") return create({ ...options, id: " " });
      return create(options);
    }) as PmClient["create"];
    if (outcome === "same" || outcome === "same-after-native-failure") {
      const registered = await registerEvaluationPlan(w.client, intended);
      assert.deepEqual((await readEvaluationPlan(w.client, intended.candidate))?.plan, intended);
      assert.equal((await readCompleteLoopItem(w.client, registered.id)).item.body, reservation(intended));
    } else await assert.rejects(registerEvaluationPlan(w.client, intended), (error: unknown) => isPmCliExpectedError(error));
  }
  assert.equal(encodeBoundedJson(JSON.parse(reservation(plan))), reservation(plan));
});

test("shadow lookup expansion is rejected before it can reserve an evaluation plan", async () => {
  const w = await workspace(); const table = Object.fromEntries(Array.from({ length: 10_000 }, (_, i) => [String(i).padStart(1024, "k"), "v".repeat(1024)]));
  const deployment = { format: "pm-rl/shadow/1", consent: "rl-consent", generation: "rl-candidate", incumbent: "rl-seed", active: table, candidate: table, inputs: { task: "a".repeat(64) }, budget: { active_calls: 1, candidate_calls: 1 } };
  const before = durable(w.pmRoot);
  assert.throws(() => parseShadowDeployment(deployment), limit);
  await assert.rejects(registerShadowDeployment(w.client, deployment, {}), limit);
  assert.deepEqual(durable(w.pmRoot), before);
});
