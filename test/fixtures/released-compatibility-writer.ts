/** Run in a scratch consumer with imports redirected to the pinned published distribution. */
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { PmClient } from "@unbrained/pm-cli/sdk/core";
import { init } from "@unbrained/pm-cli/sdk/runtime";
import { createExtensionTestHarness } from "@unbrained/pm-cli/sdk/testing";
import extension, { hashJson, generationProvenance, registerEvaluationPlan, recordPlanEvaluation, parseEvaluationPlan, evaluationComparison, evaluatePlan, parseEvalResultSpec, parseBenchmarkSpec, readCompleteLoopItem, type JsonValue } from "../../index.ts";
import { parseGenerationSpec, parseScoreRecord, canonicalizeGenerationSpec, canonicalizeScoreRecord, canonicalizeIdentifier } from "../../lineage.ts";
import { parseSweepSpec } from "../../sweep.ts";
import { parseTransferSpec } from "../../transfer.ts";
import { requiredTrimmedString } from "../../refuse.ts";
import { compatibilityInputs, LEGACY_LABELS } from "./compatibility-inputs.ts";

const root = process.argv[2]; const output = process.argv[3];
mkdirSync(root, { recursive: true });
const tracker = await init("rl", { defaults: true, agentGuidance: "skip", author: "compatibility-test" }, { cwd: root, pmRoot: join(root, ".agents/pm") });
const client = new PmClient({ cwd: root, pmRoot: tracker.path, author: "compatibility-test", noExtensions: true });
for (const type of ["Environment", "Generation", "Run"]) await client.schemaAddType(type, { folder: `${type.toLowerCase()}s`, defaultStatus: "open" });
const harness = await createExtensionTestHarness(extension, { name: "pm-rl", capabilities: ["commands", "hooks", "schema"] });
const environmentFile = join(root, "environment.json");
writeFileSync(environmentFile, JSON.stringify({ name: "Legacy training", version: "v1", task_suite: [], reward_specification: {} }));
const environment = (await harness.runCommand({ command: "rl env register", pmRoot: tracker.path, options: { file: environmentFile } })).result as { id: string };
const seedRaw = { base_checkpoint: " seed checkpoint:1 ", policy: "", collection_runs: [], training_config: {}, environment_version: "", reward_spec_version: "", parent: "   ", seed: true, promoted: false, approval: null, proxy_score: null, held_out_score: null, gap: null, promotion_evidence: null };
const seed = parseGenerationSpec(JSON.stringify(seedRaw), "Legacy seed");
await client.create({ id: "rl-seed", type: "Generation", title: "Published seed", body: `\`\`\`json\n${JSON.stringify(seedRaw)}\n\`\`\``, affectedVersion: hashJson(generationProvenance(seed)) });
const p = { ...compatibilityInputs(0).plan, incumbent_version: hashJson(generationProvenance(seed)), evaluation_context: "held out: session", members: Array.from({ length: 100 }, (_, slot) => ({ id: `case ${slot + 1}`, unit: `session:${slot + 1}` })), stopping: { kind: "fixed" as const, observations: 100, independent_units: 100 } };
const registered = await registerEvaluationPlan(client, p);
const longCandidate = `rl-${"c".repeat(182)}`;
const longPlan = { ...p, candidate: longCandidate }; await registerEvaluationPlan(client, longPlan);
for (let index = 0; index < LEGACY_LABELS.length; index += 1) {
  await registerEvaluationPlan(client, { ...compatibilityInputs(index).plan, candidate: `rl-legacy-${index}`, incumbent_version: p.incumbent_version });
}
await client.create({ id: "rl-run", type: "Run", title: "Published collection", environment: environment.id });
const benchmarkInput = { name: "Legacy benchmark", version: "v1", task_suite: [], scoring_function: "score", pass_criteria: "all", direction: "maximize", contaminated_environments: [` ${environment.id} `] };
const benchmarkFile = join(root, "benchmark.json"); writeFileSync(benchmarkFile, JSON.stringify(benchmarkInput));
const benchmark = (await harness.runCommand({ command: "rl benchmark register", pmRoot: tracker.path, options: { file: benchmarkFile } })).result as { id: string };
await harness.runCommand({ command: "rl eval record", pmRoot: tracker.path, options: { run: "rl-run", benchmark: benchmark.id, checkpoint: "legacy checkpoint:2", score: "1", passed: true } });
const candidateRaw = { ...seedRaw, base_checkpoint: " legacy checkpoint:2 ", policy: " legacy policy:1 ", collection_runs: [" rl-run "], environment_version: ` ${environment.id} `, reward_spec_version: "v1", parent: " rl-seed ", seed: false };
const candidate = parseGenerationSpec(JSON.stringify(candidateRaw), "Legacy candidate");
await client.create({ id: "rl-candidate", type: "Generation", title: "Published candidate", body: `\`\`\`json\n${JSON.stringify(candidateRaw)}\n\`\`\``, affectedVersion: hashJson(generationProvenance(candidate)) });
const rows = p.members.map((member) => ({ id: member.id, candidate: 1, incumbent: 0 }));
const report = await recordPlanEvaluation(client, p.candidate, rows);
const longSeed = `rl-${"s".repeat(198)}`;
await client.create({ id: longSeed, type: "Generation", title: "Published long native seed", body: `\`\`\`json\n${JSON.stringify(seedRaw)}\n\`\`\``, affectedVersion: hashJson(generationProvenance(seed)) });

await client.create({ id: longCandidate, type: "Generation", title: "Published long-plan candidate", body: `\`\`\`json\n${JSON.stringify(candidateRaw)}\n\`\`\``, affectedVersion: hashJson(generationProvenance(candidate)) });
const longReport = await recordPlanEvaluation(client, longCandidate, rows);
await client.create({ id: "rl-long-approval", type: "Decision", title: "One long-reference promotion", body: '```json\n{"permitted_promotions":1}\n```' });
await client.create({ id: "rl-approval", type: "Decision", title: "One compatibility promotion", body: '```json\n{"permitted_promotions":1}\n```' });
const snapshots = [];
for (const item of (await client.listAllComplete({ includeBody: true })).items) snapshots.push((await readCompleteLoopItem(client, item.id)).item);
const files: Record<string, string> = {};
/** Retain portable text state exactly as the released writer produced it, excluding runtime caches. */
function collect(directory: string): void {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const file = join(directory, entry.name); const name = relative(tracker.path, file).split("\\").join("/");
    if (entry.isDirectory()) { if (!["runtime", "locks", "transactions"].includes(name)) collect(file); }
    else if (["settings.json", "settings.toml"].includes(name) || name.endsWith(".toon") || name.startsWith("schema/") && name.endsWith(".json") || name.startsWith("history/") && name.endsWith(".jsonl")) files[name] = readFileSync(file, "utf8");
  }
}
collect(tracker.path);
const cases = Array.from({ length: 500 }, (_, index) => {
  const input = compatibilityInputs(index);
  return { index, hashes: [parseEvaluationPlan(input.plan), evaluationComparison(input.plan), evaluatePlan(input.plan, input.rows), parseGenerationSpec(JSON.stringify(input.generation), "Legacy generation"), parseScoreRecord(input.score, "Legacy score"), parseSweepSpec(JSON.stringify(input.sweep)), parseEvalResultSpec(JSON.stringify(input.evaluation)), parseBenchmarkSpec(JSON.stringify(input.benchmark)), requiredTrimmedString(input.example, "id", "Example", "example_"), canonicalizeGenerationSpec(parseGenerationSpec(JSON.stringify(input.generation), "Legacy generation"), "rl"), canonicalizeScoreRecord(parseScoreRecord(input.score, "Legacy score"), "rl"), canonicalizeIdentifier(input.example.id, "rl"), parseTransferSpec(JSON.stringify(input.transfer))].map((value) => hashJson(value as unknown as JsonValue)) };
});
writeFileSync(output, JSON.stringify({ producer: { name: "pm-rl", version: "2026.7.31", integrity: "sha512-jRIgerasEWztIIFq5cdFk6FL/qHEp9pvxxAPJ47ySn3JHL+lJAS+H+4/kzat13GNqWSdFvlrFMLScHNt9uDx7Q==" }, coordinates: { environment: environment.id, benchmark: benchmark.id, long_seed: longSeed, long_candidate: longCandidate, long_comparison: longReport.comparison }, benchmark_input: benchmarkInput, plan: registered.plan, rows, report, snapshots, files, cases }, null, 2) + "\n");
