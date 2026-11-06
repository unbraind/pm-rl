/** Behavioral revert proofs in a disposable source copy; the reviewed checkout is never mutated. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const repository = resolve("."); const root = mkdtempSync(join(tmpdir(), "rl-causal-revert-"));
try {
  for (const file of readdirSync(repository)) if (file.endsWith(".ts") || file === "package.json") cpSync(join(repository, file), join(root, file));
  for (const directory of ["test", "scripts", "examples"]) cpSync(join(repository, directory), join(root, directory), { recursive: true });
  symlinkSync(join(repository, "node_modules"), join(root, "node_modules"));
  const cases = [
    { file: "evaluation-plan.ts", name: "validateEvaluationOrder", pattern: "permit equal clocks", before: '  if (plan?.ordering === "causal/1") return validateCausalEvaluationOrder(client, plan, artifacts, prospective);', after: "  void plan; // Revert causal dispatch to the original timestamp validator." },
    { file: "evaluation-lifecycle.ts", name: "validateCausalEvaluationOrder", pattern: "every cross-stage inversion", before: '    if (entry.witness.comparison !== comparison || entry.witness.stage !== entry.stage || JSON.stringify(entry.witness.predecessors) !== JSON.stringify(references(entries, entry.stage))) refuse("eval_plan_late", entry.id);', after: "    void entry; void comparison; // Revert the causal precedence checks." },
    { file: "evaluation-lifecycle.ts", name: "createCausalEvaluationArtifact", pattern: "shared across OS processes", before: '  if (existing !== null) {', after: '  if (false && existing !== null) { // Revert replay adoption to unconditional native create.' },
  ];
  const results = [];
  for (const entry of cases) {
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
    results.push({ function: entry.name, test: entry.pattern, reverted: { pass: 0, fail: 1 }, restored: { pass: 1, fail: 0 } });
    process.stdout.write(`${entry.name}: behavioural failure on revert; restoration passes\n`);
  }
  writeFileSync("docs/evaluation-lifecycle-revert.json", JSON.stringify({ format: "pm-rl/evaluation-lifecycle-revert/1", isolated_copy: true, tests: results }, null, 2) + "\n");
} finally { rmSync(root, { recursive: true, force: true }); }
