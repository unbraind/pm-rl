/** Exercise proof admission with real bounded Node runners, including unrelated and infrastructure failures. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { proveRevert, runProofTest, validateProofRun } from "./fixtures/causal-proof.ts";
import { isolatedChildEnv } from "./fixtures/child-env.ts";

/** Each fixture is a real test file outside Git; no SDK behavior is substituted. */
function fixture(source: string, run: (root: string, file: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), "rl-proof-runner-"));
  const file = "probe.test.mjs";
  try {
    writeFileSync(join(root, file), `import { test } from 'node:test'; import assert from 'node:assert/strict';\n${source}`);
    run(root, file);
  } finally { rmSync(root, { recursive: true, force: true }); }
}

test("proof records measured counts and the selected assertion diagnostic", () => {
  fixture("test('selected', () => assert.fail('expected causal refusal')); test('extra', () => {});", (root, file) => {
    const run = runProofTest(root, file, "selected|extra");
    const result = validateProofRun(run, "selected", /expected causal refusal/);
    assert.deepEqual(result, { pass: 1, fail: 1, failure: { test: "selected", code: "ERR_ASSERTION", failureType: "testCodeFailure", matched: "expected causal refusal" } });
    assert.throws(() => validateProofRun(run, "selected", /another cause/), /Unexpected behavioral cause/);
    assert.throws(() => validateProofRun(run, "selected", /expected causal refusal/, "wrong_code"), /Unexpected failure code/);
  });
  fixture("test('selected', () => {}); test('extra', () => {});", (root, file) => {
    assert.deepEqual(validateProofRun(runProofTest(root, file, "selected|extra"), "selected"), { pass: 2, fail: 0 });
  });
});

test("proof rejects worker timeouts, runner errors, cancellation and unrelated failures", () => {
  for (const source of ["test('selected', () => { throw new Error('Worker run timed out'); });", "test('selected', () => { throw new Error('unrelated problem'); });", "test('selected', {timeout: 5}, async () => { await new Promise(r => setTimeout(r, 50)); });"]) {
    fixture(source, (root, file) => {
      assert.throws(() => validateProofRun(runProofTest(root, file, "selected"), "selected", /expected causal refusal|Worker run timed out/));
    });
  }
  const run = spawnSync(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { encoding: "utf8", timeout: 50 });
  assert.throws(() => validateProofRun(run, "selected", /expected/), /Runner process error/);
});

test("proof admits behavioral failures that name infrastructure words and refuses harness noise by its primary cause", () => {
  // A behavioral assertion may legitimately mention timeouts, cancellation or syntax errors:
  // the refusal must classify noise by the message's primary cause, not by banned words.
  for (const source of [
    "test('selected', () => { throw new Error('expected refusal: the run must reject cancelled checkpoints after the timeout'); });",
    "test('selected', () => { throw new Error('expected refusal: a SyntaxError must not be reported as a runner failure'); });",
  ]) {
    fixture(source, (root, file) => {
      const result = validateProofRun(runProofTest(root, file, "selected"), "selected", /expected refusal/);
      assert.equal(result.failure!.matched, "expected refusal");
    });
  }
  // The harness timeout embeds the child's stderr after the marker, so the expected
  // diagnostic can appear INSIDE the noise; the primary cause must still be refused.
  for (const source of [
    "test('selected', () => { throw new Error('Worker run timed out: stderr: Evaluation plan refused (eval_plan_late)'); });",
    "test('selected', () => { throw new Error('SyntaxError: unexpected token in reverted source'); });",
  ]) {
    fixture(source, (root, file) => {
      assert.throws(() => validateProofRun(runProofTest(root, file, "selected"), "selected", /eval_plan_late|unexpected token/));
    });
  }
});

test("proof refuses skipped, missing, duplicate and malformed runner evidence", () => {
  fixture("test.skip('selected', () => {});", (root, file) => {
    assert.throws(() => validateProofRun(runProofTest(root, file, "selected"), "selected"));
  });
  fixture("test('selected', () => {});", (root, file) => {
    const run = runProofTest(root, file, "selected");
    assert.throws(() => validateProofRun(run, "missing"), /Exactly one selected test/);
    assert.throws(() => validateProofRun({ ...run, stdout: run.stdout + '# pass 1\n' }, "selected"), /ambiguous TAP/);
    assert.throws(() => validateProofRun({ ...run, stdout: run.stdout.replace('# pass 1', '# pass 7') }, "selected"));
  });
});

test("proof execution ignores inherited Node test selection options", () => {
  const previous = process.env.NODE_OPTIONS;
  try {
    process.env.NODE_OPTIONS = "--test-name-pattern=extra --test-skip-pattern=selected";
    fixture("test('selected', () => {}); test('extra', () => assert.fail('must not execute'));", (root, file) => {
      assert.deepEqual(validateProofRun(runProofTest(root, file, "selected"), "selected"), { pass: 1, fail: 0 });
    });
  } finally {
    if (previous === undefined) delete process.env.NODE_OPTIONS;
    else process.env.NODE_OPTIONS = previous;
  }
});


test("every proof producer validates measured selected-test evidence and restores refused reverts", () => {
  const producers = readdirSync(new URL(".", import.meta.url)).filter(file => /revert.*\.ts$/.test(file));
  assert.equal(producers.length, 5);
  for (const file of producers) {
    const source = readFileSync(new URL(file, import.meta.url), "utf8");
    assert.match(source, /proveRevert\(/, `${file} must use shared behavioral admission`);
    assert.doesNotMatch(source, /spawnSync|(?:pass|passed|fail|failed): [01]\b/, `${file} must measure results rather than assume counts`);
  }
  fixture("test('selected', () => {});", (root, file) => {
    const fixed = readFileSync(join(root, file), "utf8");
    const infrastructure = fixed.replace("() => {}", "() => { throw new Error('Worker selected timed out'); }");
    assert.throws(() => proveRevert(root, file, fixed, infrastructure, file, "selected", /Worker selected timed out/, "ERR_TEST_FAILURE"));
    assert.ok(readFileSync(join(root, file), "utf8") === fixed, "Refused proof must restore the implementation");
    assert.deepEqual(validateProofRun(runProofTest(root, file, "selected"), "selected"), { pass: 1, fail: 0 });
  });
});


test("selected revert receipts exclude unverified results from earlier source", () => {
  const repository = new URL("../", import.meta.url);
  const root = mkdtempSync(join(tmpdir(), "rl-selected-proof-"));
  try {
    for (const file of readdirSync(repository)) if (file.endsWith(".ts") || file === "package.json") cpSync(new URL(file, repository), join(root, file));
    for (const directory of ["test", "scripts", "examples"]) cpSync(new URL(directory, repository), join(root, directory), { recursive: true });
    symlinkSync(new URL("node_modules", repository), join(root, "node_modules"));
    mkdirSync(join(root, "docs"));
    const receipt = join(root, "docs/evaluation-lifecycle-revert.json");
    writeFileSync(receipt, JSON.stringify({ tests: [{ function: "stale", test: "unselected prior source", reverted: { pass: 0, fail: 1 }, restored: { pass: 1, fail: 0 } }] }));
    // The shared filter, so names such as OPENAI_API_KEY or HTTP_AUTHORIZATION never reach the intermediate receipt process.
    const run = spawnSync(process.execPath, ["test/evaluation-lifecycle.revert.ts", "proof rejects worker timeouts"], { cwd: root, encoding: "utf8", env: isolatedChildEnv(), timeout: 60_000 });
    assert.equal(run.error, undefined);
    assert.equal(run.status, 0, run.stdout + run.stderr);
    const recorded = JSON.parse(readFileSync(receipt, "utf8")) as { complete: boolean; selection: string[]; tests: { test: string }[] };
    assert.deepEqual(recorded.tests.map(row => row.test), ["proof rejects worker timeouts"], "Selected receipts must contain only freshly measured results");
    assert.equal(recorded.complete, false);
    assert.deepEqual(recorded.selection, ["proof rejects worker timeouts"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("proof and CLI child processes never inherit credentials, including API and access keys", () => {
  const names = ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "AWS_SECRET_ACCESS_KEY", "AWS_ACCESS_KEY_ID", "GH_TOKEN", "NPM_MEDIA_SERVER", "DB_PASSWORD", "BASIC_AUTH", "SESSION_COOKIE",
    "HTTP_AUTHORIZATION", "GITHUB_AUTHORIZATION", "PM_AUTHORIZATION", "PM_AUTHOR_TOKEN"];
  const env = isolatedChildEnv({ PATH: "/bin", HOME: "/home/fixture", PM_AUTHOR: "fixture-author", GIT_AUTHOR_NAME: "Fixture Author", GIT_AUTHOR_EMAIL: "author@example.invalid", NODE_OPTIONS: "--inspect", ...Object.fromEntries(names.map(name => [name, "fixture-secret"])) });
  for (const name of names) assert.equal(env[name], undefined, `${name} must not reach a child process`);
  assert.equal(env.NODE_OPTIONS, undefined);
  // Must allow: ordinary runtime variables, including the pm author, still reach the child.
  assert.deepEqual([env.PATH, env.HOME, env.PM_AUTHOR, env.GIT_AUTHOR_NAME, env.GIT_AUTHOR_EMAIL], ["/bin", "/home/fixture", "fixture-author", "Fixture Author", "author@example.invalid"]);
  const previous = process.env.OPENAI_API_KEY;
  try {
    process.env.OPENAI_API_KEY = "fixture-secret";
    fixture("test('selected', () => { assert.equal(process.env.OPENAI_API_KEY, undefined); });", (root, file) => {
      assert.deepEqual(validateProofRun(runProofTest(root, file, "selected"), "selected"), { pass: 1, fail: 0 });
    });
  } finally {
    if (previous === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previous;
  }
});
