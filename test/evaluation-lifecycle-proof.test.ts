/** Exercise proof admission with real bounded Node runners, including unrelated and infrastructure failures. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { runProofTest, validateProofRun } from "./fixtures/causal-proof.ts";

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
