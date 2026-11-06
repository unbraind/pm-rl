/** Behavioral revert proofs in a disposable source copy; the reviewed checkout is never mutated. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/** One observed behavioral failure and its passing restoration. */
interface RevertProof { function: string; test: string; reverted: { pass: number; fail: number }; restored: { pass: number; fail: number } }
const repository = resolve("."); const root = mkdtempSync(join(tmpdir(), "rl-causal-revert-"));
try {
  for (const file of readdirSync(repository)) if (file.endsWith(".ts") || file === "package.json") cpSync(join(repository, file), join(root, file));
  for (const directory of ["test", "scripts", "examples"]) cpSync(join(repository, directory), join(root, directory), { recursive: true });
  symlinkSync(join(repository, "node_modules"), join(root, "node_modules"));
  const cases = [
    { file: "index.ts", name: "registerGenerationSnapshot", pattern: "causal candidate retries", before: '    if (reservation?.plan.ordering === "causal/1") await verifyCausalEvaluationRetry(client, reservation.plan, createOptions, evaluationLifecycleArtifacts(reservation, collectionRuns, 0));', after: '    void reservation; // Revert existing-candidate causal birth verification.' },
    { file: "evaluation-plan.ts", name: "validateEvaluationOrder", pattern: "permit equal clocks", before: '  if (plan?.ordering === "causal/1") return validateCausalEvaluationOrder(client, plan, artifacts, prospective);', after: "  void plan; // Revert causal dispatch to the original timestamp validator." },
    { file: "evaluation-lifecycle.ts", name: "validateCausalEvaluationOrder", pattern: "every cross-stage inversion", before: '    if (entry.witness.comparison !== comparison || entry.witness.stage !== entry.stage || JSON.stringify(entry.witness.predecessors) !== JSON.stringify(references(entries, entry.stage))) refuse("eval_plan_late", entry.id);', after: "    void entry; void comparison; // Revert the causal precedence checks." },
    { file: "evaluation-lifecycle.ts", name: "createCausalEvaluationArtifact", pattern: "shared across OS processes", before: '  if (existing !== null) {', after: '  if (false && existing !== null) { // Revert replay adoption to unconditional native create.' },
    { file: "evaluation-lifecycle.ts", name: "verifyCausalEvaluationRetry", pattern: "configuration-hash drift", before: '["id", "type", "affected_version", "fixed_version", "component", "environment", "created_at"]', after: '["id", "type", "affected_version", "component", "environment", "created_at"]' },
    { file: "evaluation-plan.ts", name: "parseEvaluationPlan", pattern: "causal schema refuses", before: '  if (orderingKeys.length > 0 && (p.ordering !== "causal/1" || !sequential)) refuse("eval_plan_invalid");', after: '  void orderingKeys; // Revert protocol admission checks.' },
    { file: "evaluation-lifecycle.ts", name: "createCausalEvaluationArtifact", pattern: "CLI approval", before: '  return createVerifiedItem(client, { ...options, note: [...(options.note ?? []), `${PREFIX}${encodeBoundedJson(witness)}`] });', after: '  return createVerifiedItem(client, options); // Revert atomic witness publication.' },
  ];
  const selected = process.argv.slice(2);
  assert.ok(selected.every(pattern => cases.some(entry => entry.pattern === pattern)), "Unknown proof selector");
  const results: RevertProof[] = selected.length === 0 ? [] : (JSON.parse(readFileSync("docs/evaluation-lifecycle-revert.json", "utf8")) as { tests: RevertProof[] }).tests;
  for (const entry of cases.filter(entry => selected.length === 0 || selected.includes(entry.pattern))) {
    const source = readFileSync(join(repository, entry.file), "utf8");
    assert.ok(source.includes(entry.before));
    const args = ["--test", "--test-concurrency=1", `--test-name-pattern=${entry.pattern}`, "test/evaluation-lifecycle.test.ts"];
    const run = () => spawnSync(process.execPath, args, { cwd: root, encoding: "utf8", timeout: 600_000, env: { ...process.env, NODE_V8_COVERAGE: undefined } });
    writeFileSync(join(root, entry.file), source.replace(entry.before, entry.after));
    const reverted = run();
    assert.equal(reverted.status, 1, reverted.stdout + reverted.stderr);
    assert.doesNotMatch(reverted.stderr, /SyntaxError|ERR_MODULE_NOT_FOUND/);
    writeFileSync(join(root, entry.file), source);
    const restored = run(); assert.equal(restored.status, 0, restored.stdout + restored.stderr);
    const previous = results.findIndex(result => result.test === entry.pattern);
    if (previous !== -1) results.splice(previous, 1);
    results.push({ function: entry.name, test: entry.pattern, reverted: { pass: 0, fail: 1 }, restored: { pass: 1, fail: 0 } });
    process.stdout.write(`${entry.name}: behavioural failure on revert; restoration passes\n`);
  }
  writeFileSync("docs/evaluation-lifecycle-revert.json", JSON.stringify({ format: "pm-rl/evaluation-lifecycle-revert/1", isolated_copy: true, tests: results }, null, 2) + "\n");
} finally { rmSync(root, { recursive: true, force: true }); }
