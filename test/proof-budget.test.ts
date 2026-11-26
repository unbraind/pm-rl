import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import { testTime } from "./support/depth.ts";

const helper = new URL("./support/proof-budget.ts", import.meta.url).href;

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
      timeout: testTime(10_000),
    });
    assert.deepEqual(JSON.parse(output), expected);
  }
});

test("a proof exceeding its scaled watchdog fails even after printing a receipt", () => {
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
    timeout: testTime(10_000),
  });
});
