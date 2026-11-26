import { execFileSync, type ExecFileSyncOptionsWithStringEncoding } from "node:child_process";
import { testTime } from "./depth.ts";

/** Use twice the ordinary budget under V8 coverage unless the profile sets an explicit scale. */
export function proofTime(milliseconds: number): number {
  const coverageScale = process.env.NODE_V8_COVERAGE && process.env.PM_TEST_TIME_SCALE === undefined ? 2 : 1;
  return testTime(milliseconds * coverageScale);
}

/** Run a Node proof with a finite watchdog, based on the profile of the test that launches it. */
export function runTimedProof(
  args: readonly string[],
  milliseconds: number,
  options: Pick<ExecFileSyncOptionsWithStringEncoding, "cwd" | "env"> = {},
): string {
  return execFileSync(process.execPath, args, { ...options, encoding: "utf8", timeout: proofTime(milliseconds) });
}
