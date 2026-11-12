/** Validate actual TAP evidence before a behavioral revert receipt can be published. */
import assert from "node:assert/strict";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { parse } from "yaml";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { isolatedChildEnv } from "./child-env.ts";

/** Measured runner totals and the positively identified behavioral diagnostic, without machine paths. */
export interface ProofResult {
  pass: number;
  fail: number;
  failure?: { test: string; code: string; failureType: string; matched: string };
}
/** Launch a bounded selected test without inherited runner filters or credentials. */
export function runProofTest(root: string, file: string, pattern: string): SpawnSyncReturns<string> {
  return spawnSync(process.execPath, ["--test", "--test-reporter=tap", "--test-concurrency=1", `--test-name-pattern=${pattern}`, file], { cwd: root, encoding: "utf8", timeout: 600_000, env: isolatedChildEnv() });
}
/** Refuse infrastructure errors and require the selected test's observed result and expected failure cause. */
export function validateProofRun(run: SpawnSyncReturns<string>, pattern: string, expectedFailure?: RegExp, expectedCode?: string): ProofResult {
  assert.equal(run.error, undefined, "Runner process error is not behavioral evidence");
  assert.equal(run.signal, null, "Runner signal is not behavioral evidence");
  assert.equal(run.status, expectedFailure === undefined ? 0 : 1, run.stdout + run.stderr);
  const lines = run.stdout.split("\n");
  const count = (key: string): number => {
    const matches = lines.filter(line => line.startsWith(`# ${key} `));
    assert.equal(matches.length, 1, `Missing or ambiguous TAP ${key} count`);
    assert.match(matches[0], new RegExp(`^# ${key} [0-9]+$`));
    return Number(matches[0].slice(key.length + 3));
  };
  const result: ProofResult = { pass: count("pass"), fail: count("fail") };
  for (const key of ["cancelled", "skipped", "todo", "suites"]) assert.equal(count(key), 0, `${key} is not behavioral evidence`);
  const outcomes = lines.flatMap((line, index) => {
    const match = /^(not )?ok [0-9]+ - (.+)$/.exec(line);
    return match === null ? [] : [{ failed: match[1] !== undefined, name: match[2], index }];
  });
  assert.equal(outcomes.length, count("tests"), "Incomplete TAP results");
  assert.equal(outcomes.filter(row => !row.failed).length, result.pass);
  assert.equal(outcomes.filter(row => row.failed).length, result.fail);
  const selected = outcomes.filter(row => new RegExp(pattern).test(row.name));
  assert.equal(selected.length, 1, "Exactly one selected test must execute");
  assert.equal(selected[0].failed, expectedFailure !== undefined);
  assert.equal(result.fail, expectedFailure === undefined ? 0 : 1, "Unexpected test failure");
  if (expectedFailure !== undefined) {
    const diagnostic = lines.slice(selected[0].index + 1);
    assert.equal(diagnostic[0], "  ---", "Missing TAP failure diagnostic");
    const end = diagnostic.indexOf("  ...");
    assert.ok(end > 0, "Incomplete TAP failure diagnostic");
    const raw: unknown = parse(diagnostic.slice(1, end).map(line => line.slice(2)).join("\n"));
    assert.ok(raw !== null && typeof raw === "object");
    const data = raw as Record<string, unknown>;
    assert.equal(typeof data.error, "string");
    assert.equal(typeof data.code, "string");
    if (expectedCode !== undefined) assert.equal(data.code, expectedCode, `Unexpected failure code: ${String(data.error)}`);
    assert.equal(data.failureType, "testCodeFailure");
    const error = String(data.error);
    // Refuse infrastructure noise by its PRIMARY CAUSE, not by banned words: a harness
    // timeout embeds the child's stderr after the marker (so the expected diagnostic can
    // appear inside noise), and a broken reverted source fails module loading. A genuine
    // behavioral message may legitimately mention timeouts, cancellation or syntax errors
    // anywhere else, so only the message start is checked here.
    assert.doesNotMatch(error, /^(?:Worker [^\n]*? timed out|SyntaxError|ERR_MODULE_NOT_FOUND)/, "Runner infrastructure noise is not behavioral evidence");
    const matched = expectedFailure.exec(error)?.[0];
    assert.ok(matched !== undefined, `Unexpected behavioral cause: ${String(data.code)}: ${error}`);
    result.failure = { test: selected[0].name, code: String(data.code), failureType: String(data.failureType), matched };
  }
  return result;
}


/** Restore the isolated implementation even when failure admission refuses an infrastructure error. */
export function proveRevert(root: string, sourceFile: string, fixed: string, reverted: string, testFile: string, pattern: string, expected: RegExp, code = "ERR_ASSERTION"): { reverted: ProofResult; restored: ProofResult } {
  let broken: ProofResult;
  try {
    writeFileSync(join(root, sourceFile), reverted);
    broken = validateProofRun(runProofTest(root, testFile, pattern), pattern, expected, code);
  } finally { writeFileSync(join(root, sourceFile), fixed); }
  const restored = validateProofRun(runProofTest(root, testFile, pattern), pattern);
  return { reverted: broken, restored };
}
