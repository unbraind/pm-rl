import { execFileSync, type ExecFileSyncOptionsWithStringEncoding } from "node:child_process";
import { testTime } from "./depth.ts";

/** Use twice the ordinary budget under V8 coverage unless the profile sets an explicit scale. */
export function proofTime(milliseconds: number): number {
  const coverageScale = process.env.NODE_V8_COVERAGE && process.env.PM_TEST_TIME_SCALE === undefined ? 2 : 1;
  return testTime(milliseconds * coverageScale);
}

/** An outer watchdog around nested proofs keeps an unscaled floor, so a small explicit scale cannot undercut the nested budget. */
export function outerProofTime(milliseconds: number): number {
  return Math.max(milliseconds, testTime(milliseconds));
}

/** Child arguments that re-run a whole test file under the runner mode the active runtime supports. */
export function testFileRunnerArguments(file: string): string[] {
  return process.versions.bun === undefined ? ["--test", "--test-concurrency=1", file] : ["test", file];
}

/** Run a Node proof with a finite watchdog, based on the profile of the test that launches it. */
export function runTimedProof(
  args: readonly string[],
  milliseconds: number,
  options: Pick<ExecFileSyncOptionsWithStringEncoding, "cwd" | "env"> = {},
): string {
  return execFileSync(process.execPath, args, { ...options, encoding: "utf8", timeout: proofTime(milliseconds) });
}
