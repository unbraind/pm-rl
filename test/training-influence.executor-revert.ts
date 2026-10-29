/** Prove executor, shared transition and native revision invariants using disposable behavioral reverts. */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const repository = resolve("."); const root = mkdtempSync(join(tmpdir(), "rl-executor-revert-"));
/** Extract one top-level function, allowing internal and public declarations. */
function functionText(source: string, name: string): string {
  const signature = source.indexOf(`async function ${name}`); assert.ok(signature >= 0, name);
  const line = source.lastIndexOf("\n", signature) + 1;
  const end = source.indexOf("\n}\n", signature); assert.ok(end > line, name);
  return source.slice(line, end + 3);
}
try {
  for (const file of readdirSync(repository)) if (file.endsWith(".ts") || file === "package.json") copyFileSync(join(repository, file), join(root, file));
  mkdirSync(join(root, "test")); copyFileSync(join(repository, "test/process-publication.test.ts"), join(root, "test/process-publication.test.ts"));
  cpSync(join(repository, "test/fixtures"), join(root, "test/fixtures"), { recursive: true });
  cpSync(join(repository, "examples"), join(root, "examples"), { recursive: true });
  mkdirSync(join(root, "scripts")); copyFileSync(join(repository, "scripts/script-launcher.ts"), join(root, "scripts/script-launcher.ts"));
  symlinkSync(join(repository, "node_modules"), join(root, "node_modules"));
  const processSource = readFileSync("process.ts", "utf8"); const indexSource = readFileSync("index.ts", "utf8");
  const oldProcess = execFileSync("git", ["show", "a1575a2:process.ts"], { encoding: "utf8" });
  const previousProcess = execFileSync("git", ["show", "f8678f5:process.ts"], { encoding: "utf8" });
  const fence = '        if (expectedRevision !== undefined && await readLoopRevision(client, before.item.id) !== expectedRevision) fail("Tracker history advanced after planning. Read the current target and retry; peer state and held budget were retained.", "superseded", EXIT_CODE.CONFLICT);\n';
  const checks = [
    { file: "process.ts", name: "executeReservedProcessJob", source: processSource, mutant: processSource.replace(functionText(processSource, "executeReservedProcessJob"), functionText(oldProcess, "executeReservedProcessJob")), pattern: "full executor publication faults" },
    { file: "process.ts", name: "transitionProcessJob", source: processSource, mutant: processSource.replace(functionText(processSource, "transitionProcessJob"), functionText(oldProcess, "transitionProcessJob")), pattern: "every process lifecycle transition" },
    { file: "index.ts", name: "mutateLoopItem revision fence", source: indexSource, mutant: indexSource.replace(fence, ""), pattern: "native item CAS rejects ABA" },
    { file: "process.ts", name: "commitProcessTransition journal identity", source: processSource, mutant: processSource.replace('`${target.id}-${target.state}-v${source.revision}-${targetDigest.slice(-64)}`', '`${target.id}-${target.state}`'), pattern: "process journals bind" },
    { file: "process.ts", name: "processTransitionTarget accounting schema", source: processSource, mutant: processSource.replace("  validateProcessAccounting(target);\n", ""), pattern: "transition producers share" },
    { file: "index.ts", name: "runRlLoop authoritative refusal", source: indexSource, mutant: indexSource.replace("compare_and_set_refused|generation_terminal|superseded)", "compare_and_set_refused|generation_terminal)"), pattern: "recursive controller propagates" },
    { file: "process.ts", name: "executeReservedProcessJob staging settlement", source: processSource, mutant: processSource.replace(functionText(processSource, "executeReservedProcessJob"), functionText(previousProcess, "executeReservedProcessJob")), pattern: "staging creation failures" },
    { file: "process.ts", name: "processTransitionTarget consumption floor", source: processSource, mutant: processSource.replace(/^  if .*"process_charge_regression".*\n/m, ""), pattern: "every failure settlement edge" },
    { file: "process.ts", name: "failedProcessCharge inaccessible reports", source: processSource, mutant: processSource.replace('    } catch { /* Inaccessible or vanished reports cannot prove unused resources. */ }', '    } catch (error) { throw error; }'), pattern: "recovery settlement retains reservations" },
    { file: "process.ts", name: "failedProcessCharge native birth proof", source: processSource, mutant: processSource.replace('state === "planned" && revision === 1', 'state === "planned"'), pattern: "staging failures cannot refund" },
  ];
  const stagingOnly = process.argv.includes("--staging-only");
  const results = [];
  for (const check of stagingOnly ? checks.slice(-4) : checks) {
    assert.notEqual(check.mutant, check.source, check.name);
    const run = () => spawnSync(process.execPath, ["--test", "--test-concurrency=1", `--test-name-pattern=${check.pattern}`, "test/process-publication.test.ts"], { cwd: root, encoding: "utf8", timeout: 240_000, env: { ...process.env, NODE_V8_COVERAGE: undefined } });
    writeFileSync(join(root, check.file), check.mutant);
    const broken = run(); assert.equal(broken.status, 1, broken.stdout + broken.stderr); assert.match(broken.stdout + broken.stderr, /AssertionError/);
    writeFileSync(join(root, check.file), check.source);
    const restored = run(); assert.equal(restored.status, 0, restored.stdout + restored.stderr); assert.match(restored.stdout, /pass 1/);
    results.push({ function: check.name, reverted: { pass: 0, fail: 1 }, restored: { pass: 1, fail: 0 } });
    process.stdout.write(`${check.name}: revert fails; restoration passes\n`);
  }
  writeFileSync(stagingOnly ? "docs/training-influence-staging-revert.json" : "docs/training-influence-executor-revert.json", JSON.stringify({ format: "pm-rl/executor-revert/1", baseline: stagingOnly ? "f8678f5" : "a1575a2", tests: results, reviewed_source_unchanged: true }, null, 2) + "\n");
} finally { rmSync(root, { recursive: true, force: true }); }
