/** Intake objectives use creation inputs, balanced item evidence and mandatory fixed-router comparisons. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { banditCheckpoint, banditProbability, banditSampleRows, fitBanditBatch, validatedBanditDatasets, type BanditExample } from "../bandit.ts";
import { corpusHeldOut, intakeHeuristic, projectIntakeHistory, sealIntakeCorpus, verifyTrackerLoopCorpus } from "../corpus.ts";
import { hashJson, type JsonValue } from "../index.ts";
import { itemBootstrap, pairedItemEvidence } from "../item-evaluation.ts";
import { generationTrainingConfig, parseLoopConfig, parseStoredLoopGeneration, runLoopGeneration, seedTrainingConfig, verifyStoredLoopGeneration } from "../loop.ts";
import { intakeNoGit } from "./fixtures/intake-no-git.ts";

const bounds = JSON.parse(readFileSync(new URL("../examples/loop-intake-objective.json", import.meta.url), "utf8")) as Record<string, JsonValue>;
const items = Array.from({ length: 160 }, (_, index) => ({ id: `intake-${index}`, title: `${index % 2 === 0 ? "fix crash" : "future roadmap"} ${"z".repeat(index + 1)}`, type: index % 2 === 0 ? "Issue" : "Feature" }));

test("balanced bootstrap keeps every constant at one half despite imbalance and requires the heuristic", () => {
  const labels = Array.from({ length: 120 }, (_, index) => index >= 20);
  const rewards = labels.map((label) => label ? [0, 1] as const : [1, 0] as const);
  for (const probability of [0, 0.1, 0.9, 1]) {
    const interval = itemBootstrap(labels.map((label) => label ? probability : 1 - probability), 0.95, labels);
    assert.ok(Math.abs(interval.mean - 0.5) < 1e-12);
    assert.ok(Math.abs(interval.lower - 0.5) < 1e-12 && Math.abs(interval.upper - 0.5) < 1e-12);
  }
  const candidate = labels.map(() => 0.9);
  const incumbent = labels.map(() => 0.5);
  const perfect = labels.map(() => 1);
  const result = pairedItemEvidence(candidate, incumbent, rewards, 0.95, 10, 0.01, { labels, heuristic: perfect });
  assert.equal(result.reason, "item_heuristic_not_beaten");
  assert.ok(result.constant_zero.lower > 0.01 && result.constant_one.lower > 0.01);
  assert.equal(result.method, "paired-stratified-item-bootstrap/1");
  assert.deepEqual(result.class_samples, [20, 100]);
  assert.equal(pairedItemEvidence(candidate, incumbent, rewards, 0.95, 10, 0.01, { labels, heuristic: incumbent }).accepted, true);
  assert.equal(pairedItemEvidence(candidate, incumbent, rewards, 0.95, 21, 0.01, { labels, heuristic: incumbent }).reason, "item_insufficient_samples");
  assert.throws(() => pairedItemEvidence(candidate, incumbent, rewards, 0.95, 10, 0.01, { labels, heuristic: [] }), /item_pairing/);
  for (const labels of [[], [false], [true, true]]) assert.throws(() => itemBootstrap([0, 1], 0.95, labels), /item_bootstrap_classes/);
});

test("intake projection stops at the creation event and title features never depend on labels", () => {
  const first = { op: "create", patch: ["id", "title", "type"].map((field) => ({ op: "add", path: `/metadata/${field}`, value: { id: "one", title: "fix crash", type: "Issue" }[field] })) };
  assert.deepEqual(projectIntakeHistory(`${JSON.stringify(first)}\n${JSON.stringify({ op: "update", patch: [{ path: "/metadata/title", value: "future outcome" }] })}`), { id: "one", title: "fix crash", type: "Issue" });
  for (const event of [{}, { ...first, op: "update" }, { ...first, patch: null }, { ...first, patch: first.patch.slice(1) }, { ...first, patch: first.patch.map((patch) => ({ ...patch, op: "remove" })) }]) assert.throws(() => projectIntakeHistory(JSON.stringify(event)), /intake_missing_creation/);
  assert.equal(intakeHeuristic("fix security crash"), 1); assert.equal(intakeHeuristic("future roadmap"), 0);
  const original = sealIntakeCorpus(items, bounds) as Record<string, JsonValue>;
  const changed = sealIntakeCorpus(items.map((item) => ({ ...item, type: item.type === "Issue" ? "Feature" : "Issue" })), bounds) as Record<string, JsonValue>;
  const rows = (original.corpus as Record<string, JsonValue>).rows as Record<string, JsonValue>[];
  const other = (changed.corpus as Record<string, JsonValue>).rows as Record<string, JsonValue>[];
  assert.deepEqual(rows.map((row) => [row.features, row.heuristic]), other.map((row) => [row.features, row.heuristic]));
  assert.notEqual((original.corpus as Record<string, JsonValue>).snapshot, (changed.corpus as Record<string, JsonValue>).snapshot);
  const config = parseLoopConfig(original);
  assert.equal(config.objective, "intake-issue-balanced-v1");
  assert.deepEqual(parseLoopConfig((seedTrainingConfig(config) as Record<string, JsonValue>).configuration), config);
});

test("intake corpus refuses malformed projections, missing classes, renamed leaks and changed baselines", () => {
  const programme = sealIntakeCorpus(items, bounds) as Record<string, JsonValue>;
  const corpus = programme.corpus as Record<string, JsonValue>;
  const rows = corpus.rows as Record<string, JsonValue>[];
  for (const changed of [null, {}, { ...rows[0], item: "bad" }, { ...rows[0], content: "bad" }, { ...rows[0], length: 0 }, { ...rows[0], length: 257 }, { ...rows[0], length: 1.5 }, { ...rows[0], label: "true" }, { ...rows[0], heuristic: 2 }, { ...rows[0], features: null }, { ...rows[0], features: [] }, { ...rows[0], features: new Array(64).fill(2) }, { ...rows[0], features: new Array(64).fill("x") }]) assert.throws(() => verifyTrackerLoopCorpus({ ...programme, corpus: { ...corpus, rows: [changed] } }), /intake_invalid_seal/);
  for (const changed of [{ ...corpus, rows: null }, { ...corpus, rows: new Array(10001).fill(rows[0]) }, { ...corpus, rows: [rows[0], rows[0]] }, { ...corpus, snapshot: "drift" }]) assert.throws(() => verifyTrackerLoopCorpus({ ...programme, corpus: changed }), /invalid_seal|duplicate_item|snapshot_drift/);
  for (const changed of [{ objective: "other" }, { objective: undefined }, { corpus: undefined }]) assert.throws(() => parseLoopConfig({ ...programme, ...changed } as unknown as JsonValue), /objective|invalid_seal/);
  for (const key of ["training", "evaluation", "environment"]) {
    for (const value of [undefined, []]) assert.throws(() => verifyTrackerLoopCorpus({ ...programme, [key]: value }), /corpus_dataset_drift/);
  }
  assert.throws(() => verifyTrackerLoopCorpus({ ...programme, objective: "other" }), /intake_invalid_seal/);
  const evaluation = programme.evaluation as Record<string, JsonValue>[];
  assert.throws(() => verifyTrackerLoopCorpus({ ...programme, evaluation: [{ ...evaluation[0], balance: { label: false, heuristic: 1 } }, ...evaluation.slice(1)] }), /corpus_dataset_drift/);
  assert.throws(() => sealIntakeCorpus([...items, { ...items[0], id: "renamed" }], { ...bounds, training: evaluation }), /corpus_invalid_bounds/);
  for (const changed of [null, [], {}, { ...bounds, objective: "other" }, { ...bounds, feature_mode: "status" }]) assert.throws(() => sealIntakeCorpus(items, changed), /corpus_invalid_bounds/);
  for (const changed of [{ id: "", title: "valid", type: "Issue" }, { id: "x", title: "", type: "Issue" }, { id: "x", title: "valid", type: "" }]) assert.throws(() => sealIntakeCorpus([changed], bounds), /invalid_item|invalid_seal/);
  for (const field of ["id", "title", "type"]) assert.throws(() => sealIntakeCorpus([{ ...items[0], [field]: 1 }], bounds), /corpus_invalid_item/);
  for (const changed of [{ ...rows[0], length: "1" }, { ...rows[0], features: new Array<number>(64).fill(NaN) }]) assert.throws(() => verifyTrackerLoopCorpus({ ...programme, corpus: { ...corpus, rows: [changed] } }), /intake_invalid_seal/);
  assert.throws(() => sealIntakeCorpus([items[0], items[0]], bounds), /duplicate_item/);
  assert.throws(() => sealIntakeCorpus(items.map((item) => ({ ...item, type: "Issue" })), bounds), /intake_missing_class/);
  assert.throws(() => sealIntakeCorpus(items.map((item) => ({ ...item, type: corpusHeldOut(item.title.length) ? "Issue" : item.type })), bounds), /intake_missing_class/);
  const renamed = sealIntakeCorpus([...items, { ...items[0], id: "renamed" }], bounds) as Record<string, JsonValue>;
  const matching = ((renamed.corpus as Record<string, JsonValue>).rows as Record<string, JsonValue>[]).filter((row) => row.content === rows.find((row) => row.item === hashJson(items[0].id))!.content);
  assert.equal(matching.length, 2); assert.equal(corpusHeldOut(matching[0].length as number), corpusHeldOut(matching[1].length as number));
});

test("balanced collection and fitting optimize class means instead of the majority reward", () => {
  const rows: BanditExample[] = Array.from({ length: 10 }, (_, index) => ({ id: `r-${index}`, feature: 0, features: [1, index === 0 ? -1 : 1], rewards: index === 0 ? [1, 0] : [0, 1], balance: { label: index !== 0, heuristic: 0 } }));
  const schedule = banditSampleRows(rows, 100);
  assert.equal(schedule.filter((row) => row.balance!.label).length, 50);
  assert.equal(new Set(schedule.map((row) => row.id)).size, 10);
  const source = banditCheckpoint(0);
  const observations = schedule.map((row) => ({ example: row.id, action: Number(row.balance!.label) as 0 | 1, reward: 1 }));
  const fitted = fitBanditBatch(rows, source, observations, 1, 8);
  assert.ok(banditProbability(fitted, rows[0]) < 0.2 && banditProbability(fitted, rows[1]) > 0.8);
  assert.ok(Math.abs(fitted.coefficients![0]) < 1e-12);
  const valid = { training: rows, evaluation: rows.map((row) => ({ ...row, id: `eval-${row.id}` })) };
  assert.deepEqual(validatedBanditDatasets(valid).training, rows);
  for (const balance of [undefined, null, { label: "true", heuristic: 0 }, { label: false, heuristic: 2 }, { label: true, heuristic: 0 }]) assert.throws(() => validatedBanditDatasets({ ...valid, training: [{ ...rows[0], balance } as BanditExample, ...rows.slice(1)] }), /bandit_invalid/);
  assert.throws(() => validatedBanditDatasets({ training: rows, evaluation: valid.evaluation.map((row) => ({ ...row, balance: undefined })) }), /bandit_invalid/);
  assert.throws(() => validatedBanditDatasets({ training: rows.slice(1), evaluation: valid.evaluation }), /both classes/);
  assert.throws(() => validatedBanditDatasets({ training: rows, evaluation: valid.evaluation.slice(1) }), /both classes/);
  assert.throws(() => validatedBanditDatasets({ ...valid, training: [{ ...rows[0], rewards: [0, 0] }, ...rows.slice(1)] }), /bandit_invalid/);
  assert.throws(() => validatedBanditDatasets({ training: rows.map((row) => ({ ...row, features: undefined })), evaluation: valid.evaluation }), /bandit_invalid/);
});

test("intake generations retain the mandatory heuristic refusal and replay the sealed metric", () => {
  const config = parseLoopConfig(sealIntakeCorpus(items, bounds));
  const step = { learningRate: 1, evaluationSamples: 40000 };
  const source = banditCheckpoint(0);
  const receipt = runLoopGeneration(config, step, 1, source);
  assert.ok(receipt.evaluationScore > 0.5 + config.minimumImprovement);
  assert.equal(receipt.promoted, false); assert.equal(receipt.refusalReason, "item_heuristic_not_beaten");
  assert.equal(receipt.itemEvidence!.samples, config.evaluation.length);
  const saved = generationTrainingConfig(config, step, 1, receipt);
  assert.deepEqual(verifyStoredLoopGeneration(config, step, 1, source, parseStoredLoopGeneration(saved, "intake")), receipt);
  const altered = { ...saved as Record<string, JsonValue>, item_evidence: { ...receipt.itemEvidence, heuristic: null } as unknown as JsonValue };
  assert.throws(() => verifyStoredLoopGeneration(config, step, 1, source, parseStoredLoopGeneration(altered, "intake")), /does not replay/);
  const constant = banditCheckpoint(0, [Math.log(9), ...new Array<number>(63).fill(0)]);
  const constantReceipt = runLoopGeneration(config, step, 1, source, constant);
  assert.ok(Math.abs(constantReceipt.evaluationScore - 0.5) < 1e-12);
  assert.equal(constantReceipt.promoted, false);
  assert.equal(constantReceipt.itemEvidence!.reason, "item_incumbent_not_beaten");
});

test("intake external fits and status replay work on a plain SDK tracker", { timeout: 300_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "rl-intake-controller-"));
  try { await intakeNoGit(root); } finally { rmSync(root, { recursive: true, force: true }); }
});

test("intake fit and replay need no git executable or enclosing repository", { timeout: 300_000 }, () => {
  const root = mkdtempSync(join(tmpdir(), "rl-intake-no-git-"));
  try {
    const bin = join(root, "tools"); mkdirSync(bin); symlinkSync(process.execPath, join(bin, "node"));
    for (const tool of ["ps", "getconf"]) symlinkSync(execFileSync("sh", ["-c", `command -v ${tool}`], { encoding: "utf8" }).trim(), join(bin, tool));
    const output = execFileSync(process.execPath, [new URL("./fixtures/intake-no-git.ts", import.meta.url).pathname, root], { encoding: "utf8", timeout: 280_000, env: { ...process.env, NODE_V8_COVERAGE: undefined, PATH: bin, GIT_CEILING_DIRECTORIES: dirname(root) } });
    assert.match(output, /balanced intake fit and sealed replay/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
