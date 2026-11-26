import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { outerProofTime, testFileRunnerArguments } from "./support/proof-budget.ts";

const helper = new URL("./support/proof-budget.ts", import.meta.url).href;
const depthHelper = new URL("./support/depth.ts", import.meta.url).href;

test("timed proofs keep ordinary budgets and scale for coverage and deep profiles", () => {
  const script = `
    import { proofTime } from ${JSON.stringify(helper)};
    if (process.argv[1] === "instrumented") process.env.NODE_V8_COVERAGE = "coverage";
    console.log(JSON.stringify([2_000, 20_000, 25_000].map(proofTime)));
  `;
  for (const [depth, coverage, scale, expected] of [
    ["quick", "ordinary", undefined, [2_000, 20_000, 25_000]],
    ["quick", "instrumented", undefined, [4_000, 40_000, 50_000]],
    ["full", "instrumented", "3", [6_000, 60_000, 75_000]],
    ["full", "ordinary", "3", [6_000, 60_000, 75_000]],
  ] as const) {
    const output = execFileSync(process.execPath, ["--input-type=module", "-e", script, coverage], {
      encoding: "utf8",
      env: { ...process.env, PM_TEST_DEPTH: depth, NODE_V8_COVERAGE: undefined, PM_TEST_TIME_SCALE: scale },
      timeout: outerProofTime(10_000),
    });
    assert.deepEqual(JSON.parse(output), expected);
  }
});

test("a proof exceeding its scaled watchdog fails even after printing a receipt", { timeout: outerProofTime(30_000) }, () => {
  const script = `
    import assert from "node:assert/strict";
    import { runTimedProof } from ${JSON.stringify(helper)};
    const withinBudget = 'setTimeout(() => console.log("proof receipt"), 1_200)';
    const overBudget = 'console.log("proof receipt"); setTimeout(() => {}, 4_000)';
    assert.equal(runTimedProof(["-e", withinBudget], 1_000), "proof receipt\\n");
    assert.throws(
      () => runTimedProof(["-e", overBudget], 1_000),
      { code: "ETIMEDOUT", signal: "SIGTERM", stdout: "proof receipt\\n" },
    );
  `;
  execFileSync(process.execPath, ["--input-type=module", "-e", script], {
    env: { ...process.env, NODE_V8_COVERAGE: undefined, PM_TEST_TIME_SCALE: "3" },
    timeout: outerProofTime(10_000),
  });
});

test("outer proof watchdogs keep an unscaled floor at small scales and preserve deep budgets", () => {
  const script = `
    import { outerProofTime, testFileRunnerArguments } from ${JSON.stringify(helper)};
    import { testTime } from ${JSON.stringify(depthHelper)};
    for (const milliseconds of [1, 7, 333, 2_000, 10_000, 25_000, 250_000]) {
      const floored = outerProofTime(milliseconds);
      if (floored < milliseconds || floored < testTime(milliseconds)) throw new Error("outer watchdog dropped below the nested budget");
    }
    const runner = testFileRunnerArguments("proof-budget.test.ts");
    if ((process.versions.bun === undefined ? "--test" : "test") !== runner[0]) throw new Error("runner mode is not supported by the active runtime");
    console.log(JSON.stringify([10_000, 25_000].map(outerProofTime)));
  `;
  for (const [scale, expected] of [
    ["0.4", [10_000, 25_000]],
    ["1", [10_000, 25_000]],
    ["3", [30_000, 75_000]],
  ] as const) {
    const output = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
      encoding: "utf8",
      env: { ...process.env, NODE_V8_COVERAGE: undefined, PM_TEST_TIME_SCALE: scale },
      timeout: outerProofTime(10_000),
    });
    assert.deepEqual(JSON.parse(output), expected);
  }
});

test("the proof regressions still finish when the whole file runs at a small explicit scale", { timeout: outerProofTime(90_000), skip: process.env.PM_TEST_PROOF_BUDGET_CHILD === "1" ? "reentrancy guard: the child run exercises every watchdog in this file" : false }, () => {
  if (process.env.PM_TEST_PROOF_BUDGET_CHILD === "1") return;
  // 0.005 is a valid explicit scale: a reverted outer watchdog (50 ms) then undercuts even the
  // instrumented child startup behind the sibling watchdog, while the floor keeps every declared budget.
  // Bun's node:test shim ignores the skip option and defaults to a 5 s test timeout, so the guard
  // also returns early and the long regressions carry explicit floored timeouts.
  const run = spawnSync(process.execPath, testFileRunnerArguments(fileURLToPath(import.meta.url)), {
    encoding: "utf8",
    env: { ...process.env, NODE_V8_COVERAGE: undefined, NODE_TEST_CONTEXT: undefined, PM_TEST_TIME_SCALE: "0.005", PM_TEST_PROOF_BUDGET_CHILD: "1" },
    timeout: outerProofTime(60_000),
  });
  assert.equal(run.status, 0, run.stdout + run.stderr);
});
