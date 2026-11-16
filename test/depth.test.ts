/** Depth and time scale are harness controls, validated before child creation. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { testDepth } from "./support/depth.ts";

const helper = new URL("./support/depth.ts", import.meta.url).href;
test("quick depth keeps a deterministic prefix, a 25 case floor and full defaults", () => {
  const previous = process.env.PM_TEST_DEPTH;
  try {
    delete process.env.PM_TEST_DEPTH; assert.equal(testDepth(500), 500);
    process.env.PM_TEST_DEPTH = "full"; assert.equal(testDepth(500), 500);
    process.env.PM_TEST_DEPTH = "quick";
    assert.equal(testDepth(500), 50); assert.equal(testDepth(128), 25);
    assert.equal(testDepth(30), 25); assert.equal(testDepth(10), 10);
  } finally { if (previous === undefined) delete process.env.PM_TEST_DEPTH; else process.env.PM_TEST_DEPTH = previous; }
});
test("scaled spawnSync deadlines are integer milliseconds and invalid scales fail before workers start", () => {
  for (const scale of ["1.001", "3", "0", "-1", "NaN", "Infinity", ""]) {
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", `const { testTime } = await import(${JSON.stringify(helper)}); console.log(testTime(11));`], { encoding: "utf8", env: { ...process.env, PM_TEST_TIME_SCALE: scale }, timeout: 30_000 });
    if (scale === "1.001" || scale === "3") { assert.equal(result.status, 0, result.stderr); assert.equal(Number(result.stdout), scale === "3" ? 33 : 12); }
    else { assert.notEqual(result.status, 0); assert.equal(result.stdout, ""); assert.match(result.stderr, /PM_TEST_TIME_SCALE/); }
  }
});
