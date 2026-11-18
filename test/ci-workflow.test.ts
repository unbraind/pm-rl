/** Required checks fail closed over every quick-tier dependency; deep remains a single gate. */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { parseDocument } from "yaml";

/** Relevant job and step fields in the quick workflow. */
interface Job {
  name?: string;
  needs?: string | string[];
  if?: string;
  "timeout-minutes": number;
  strategy?: { matrix: { "node-version": number[]; shard?: number[] } };
  steps: { name?: string; if?: string; run?: string; uses?: string; with?: Record<string, unknown> }[];
}
const document = parseDocument(readFileSync(".github/workflows/ci.yml", "utf8"), { uniqueKeys: true });
const jobs = (document.toJS() as { jobs: Record<string, Job> }).jobs;

test("quick CI shards coverage with exact replay and unchanged required names", () => {
  assert.deepEqual(document.errors, []);
  assert.deepEqual(jobs["coverage-shard"].strategy?.matrix, { "node-version": [26], shard: [1, 2, 3, 4] });
  assert.match(jobs["coverage-shard"].steps.map(step => step.run ?? "").join("\n"), /coverage-gate.ts --shard.*matrix.shard.*\/4/);
  assert.ok(jobs["coverage-shard"].steps.some(step => step.uses?.startsWith("actions/upload-artifact@") && step.with?.["if-no-files-found"] === "error"));
  assert.equal(jobs["coverage-merge"].needs, "coverage-shard");
  assert.equal(jobs["coverage-merge"].if, "always()");
  assert.match(jobs["coverage-merge"].steps.map(step => step.run ?? "").join("\n"), /--merge coverage-input\/coverage-26-\{1,2,3,4\}/);
  assert.equal(jobs.test.name, "test (26)");
  assert.deepEqual(jobs.test.needs, ["coverage-shard", "coverage-merge", "release-checks"]);
  assert.equal(jobs.test.if, "always()");
  const aggregate = jobs.test.steps[0].run ?? "";
  for (const name of ["SHARDS", "MERGE", "RELEASE"]) assert.ok(aggregate.includes(`test "$${name}" = success`));
  assert.equal(jobs["test-22"].name, "test (22)");
  assert.equal(jobs["test-22"].needs, "quick-shard");
  assert.equal(jobs["test-22"].if, "always()");
  for (const job of Object.values(jobs)) assert.ok(job["timeout-minutes"] <= 22);
});

/** The engines-floor launcher's dry-run output for a single matrix leg. */
interface QuickShard {
  shard: number;
  estimatedSeconds: number;
  files: string[];
}

test("Node 22 quick shards launch every quick test file exactly once", () => {
  const job = jobs["quick-shard"];
  assert.deepEqual(job.strategy?.matrix, { "node-version": [22], shard: [1, 2, 3] });
  assert.equal(job["timeout-minutes"], 22);
  const step = job.steps.find(candidate => candidate.name === "Engines floor shard");
  assert.match(step?.run ?? "", /node scripts\/quick-shards\.ts \$\{\{ matrix\.shard \}\}/);
  const requireShards = jobs["test-22"].steps.find(candidate => candidate.name === "Fail unless every quick Node 22 shard succeeded");
  assert.match(requireShards?.if ?? "", /needs\.quick-shard\.result != 'success'/);
  assert.match(requireShards?.run ?? "", /exit 1/);

  const dryRun = execFileSync(process.execPath, ["scripts/quick-shards.ts"], { encoding: "utf8" });
  const shards = JSON.parse(dryRun) as QuickShard[];
  assert.deepEqual(shards.map(shard => shard.shard), job.strategy?.matrix.shard);
  const expected = readdirSync("test").filter(name => !name.startsWith(".") && name.endsWith(".test.ts"))
    .map(name => `test/${name}`).sort();
  assert.deepEqual(shards.flatMap(shard => shard.files).sort(), expected);
  for (const shard of shards) {
    assert.ok(shard.files.length > 0);
    assert.ok(Number.isFinite(shard.estimatedSeconds) && shard.estimatedSeconds > 0);
  }
});

test("Node 22 quick launcher runs new files and propagates failures", t => {
  const root = mkdtempSync(join(tmpdir(), "rl-quick-shards-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "test"));
  const launcher = resolve("scripts/quick-shards.ts");
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const run = (...args: string[]) => spawnSync(process.execPath, [launcher, ...args], {
    cwd: root, env, encoding: "utf8", timeout: 30_000,
  });

  for (const name of ["alpha", "bravo", "charlie"]) {
    writeFileSync(join(root, "test", `${name}.test.ts`), `import { test } from "node:test"; test("${name}", () => {});\n`);
  }
  const dryRun = run();
  assert.equal(dryRun.status, 0, dryRun.stderr);
  const shards = JSON.parse(dryRun.stdout) as QuickShard[];
  for (const shard of shards) {
    const result = run(String(shard.shard));
    assert.equal(result.status, 0, result.stderr);
    const reported = [...result.stdout.matchAll(/^ok \d+ - (\w+)$/gm)].map(match => `test/${match[1]}.test.ts`);
    assert.deepEqual(reported, shard.files);
  }
  assert.deepEqual(shards.flatMap(shard => shard.files).sort(), ["test/alpha.test.ts", "test/bravo.test.ts", "test/charlie.test.ts"]);
  const failingShard = shards[0];
  writeFileSync(join(root, failingShard.files[0]), 'throw new Error("fixture failure");\n');
  const failed = run(String(failingShard.shard));
  assert.equal(failed.status, 1, failed.stderr);
  assert.match(failed.stderr + failed.stdout, /fixture failure/);
  const unknown = run("4");
  assert.equal(unknown.status, 1, unknown.stderr);
  assert.match(unknown.stderr, /No test files assigned to quick shard 4/);
});

test("parallel release checks retain every non-coverage release component", () => {
  const script = jobs["release-checks"].steps.find(step => step.name === "Quick non-coverage release checks")?.run ?? "";
  const manifest = JSON.parse(readFileSync("package.json", "utf8")) as { scripts: Record<string, string> };
  for (const match of manifest.scripts["release:check"].matchAll(/npm run ([\w:-]+)/g)) {
    if (match[1] !== "coverage") assert.ok(script.includes(match[1]), match[1]);
  }
  assert.doesNotMatch(script, /npm run (?:coverage|release:check)/);
  assert.match(script, /transfer-review-round6.test.ts/);
  for (const job of Object.values(jobs)) for (const step of job.steps.filter(step => step.name === "Check documentation and tracker changes")) {
    assert.match(step.run ?? "", /pack:dry-run -- --ignore-scripts/);
    assert.doesNotMatch(step.run ?? "", /npm run build|docs-inputs.ts/);
  }
  const deep = readFileSync(".github/workflows/ci-deep.yml", "utf8");
  assert.equal((deep.match(/(?:npm|bun) run release:check/g) ?? []).length, 2);
  assert.doesNotMatch(deep, /--shard|--merge/);
});

test("revert runner's disposable test copy imports with its support modules", () => {
  const child = spawnSync(process.execPath, ["test/training-influence.revert.ts", "--check-copy"], { encoding: "utf8", timeout: 60_000, env: { ...process.env, NODE_TEST_CONTEXT: "" } });
  assert.equal(child.status, 0, child.stdout + child.stderr);
});

test("copy-only revert probe accepts edited receipts while regeneration refuses them", t => {
  const root = mkdtempSync(join(tmpdir(), "rl-copy-receipt-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const entry of readdirSync(".")) if (entry.endsWith(".ts") || entry === "package.json" || ["test", "scripts", "examples"].includes(entry)) {
    cpSync(entry, join(root, entry), { recursive: true });
  }
  symlinkSync(resolve("node_modules"), join(root, "node_modules"), "dir");
  mkdirSync(join(root, "docs"));
  const receipt = "docs/training-influence-revert.json";
  const original = readFileSync(receipt, "utf8");
  writeFileSync(join(root, receipt), original);
  execFileSync("git", ["init", "--quiet"], { cwd: root });
  execFileSync("git", ["add", "--", receipt], { cwd: root });
  // No commit or global identity is needed: a staged receipt is already an edited receipt.
  const edited = original + " \n";
  writeFileSync(join(root, receipt), edited);
  const run = (args: string[]) => spawnSync(process.execPath, ["test/training-influence.revert.ts", ...args], {
    cwd: root, encoding: "utf8", timeout: 60_000, env: { ...process.env, NODE_TEST_CONTEXT: "" },
  });
  const check = run(["--check-copy"]);
  assert.equal(check.status, 0, check.stdout + check.stderr);
  assert.equal(readFileSync(join(root, receipt), "utf8"), edited);
  const regenerate = run([]);
  assert.notEqual(regenerate.status, 0);
  assert.match(regenerate.stderr, /has uncommitted edits.*before regenerating the receipt/);
  assert.equal(readFileSync(join(root, receipt), "utf8"), edited);
});
