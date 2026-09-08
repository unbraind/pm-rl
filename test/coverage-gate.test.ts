/**
 * Behavioral tests for the coverage gate script.
 *
 * Every case imports the gate's exported functions and runs them in-process
 * against a throwaway workspace, because the properties worth protecting are
 * exactly the ones a subprocess run would miss: that the directory walk finds
 * every source file, that the lcov parser normalises paths, and that the gate
 * fails when files are missing from the report.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, test } from "node:test";
import { pathToFileURL } from "node:url";

import {
  collectSources,
  computeRequired,
  computeStatementCoverage,
  DEFAULT_SKIP_DIRS,
  defaultSpawn,
  isMainInvocation,
  main,
  parseLcov,
  parseLcovTotals,
  resolveEmitPaths,
  runGate,
} from "../scripts/coverage-gate.ts";
import { makeTempDir } from "./helpers/tmp.ts";

let dir: { root: string; cleanup(): void } | null = null;

afterEach(() => {
  dir?.cleanup();
  dir = null;
});

const repoRoot = resolve(import.meta.dirname, "..");
const defaultSkipDirs = new Set(DEFAULT_SKIP_DIRS);

test("collectSources walks a directory and returns TypeScript files as repo-relative paths", () => {
  dir = makeTempDir();
  writeFileSync(join(dir.root, "a.ts"), "export const a = 1;\n");
  mkdirSync(join(dir.root, "sub"));
  writeFileSync(join(dir.root, "sub", "b.ts"), "export const b = 2;\n");
  writeFileSync(join(dir.root, "c.d.ts"), "export declare const c: number;\n");
  writeFileSync(join(dir.root, "readme.md"), "# readme\n");
  const result = collectSources(dir.root, new Set(), dir.root).sort();
  assert.deepEqual(result, ["a.ts", "sub/b.ts"]);
});

test("collectSources skips configured directories", () => {
  dir = makeTempDir();
  writeFileSync(join(dir.root, "a.ts"), "export const a = 1;\n");
  mkdirSync(join(dir.root, "test"));
  writeFileSync(join(dir.root, "test", "ignored.ts"), "export const ignored = 1;\n");
  const result = collectSources(dir.root, new Set(["test"]), dir.root);
  assert.deepEqual(result, ["a.ts"]);
});

test("collectSources accepts a single TypeScript file", () => {
  dir = makeTempDir();
  const file = join(dir.root, "single.ts");
  writeFileSync(file, "export const single = 1;\n");
  const result = collectSources(file, new Set(), dir.root);
  assert.deepEqual(result, ["single.ts"]);
});

test("collectSources throws for a non-existent target", () => {
  dir = makeTempDir();
  const root = dir.root;
  assert.throws(
    () => collectSources(join(root, "missing"), new Set(), root),
    /does not exist/,
  );
});

test("collectSources throws for a non-TypeScript file", () => {
  dir = makeTempDir();
  const root = dir.root;
  const file = join(root, "readme.md");
  writeFileSync(file, "# readme\n");
  assert.throws(
    () => collectSources(file, new Set(), root),
    /not a TypeScript source file/,
  );
});

test("collectSources throws for a declaration file", () => {
  dir = makeTempDir();
  const root = dir.root;
  const file = join(root, "types.d.ts");
  writeFileSync(file, "export declare const x: number;\n");
  assert.throws(
    () => collectSources(file, new Set(), root),
    /not a TypeScript source file/,
  );
});

test("collectSources finds scripts when scripts is not in skipDirs", () => {
  const result = collectSources(repoRoot, defaultSkipDirs, repoRoot);
  assert.ok(result.includes("index.ts"), "index.ts must be found");
  assert.ok(result.includes("series.ts"), "series.ts must be found");
  assert.ok(result.some((file) => file.startsWith("scripts/")), "scripts/ files must be found");
});

test("parseLcov reads SF lines and normalises to repo-relative paths", () => {
  dir = makeTempDir();
  const lcovPath = join(dir.root, "lcov.info");
  writeFileSync(lcovPath, [
    `SF:${join(dir.root, "a.ts")}`,
    "DA:1,1",
    "SF:a.ts",
    "DA:1,1",
    "",
  ].join("\n"));
  const result = parseLcov(lcovPath, dir.root);
  assert.deepEqual(result, new Set(["a.ts"]));
});

test("parseLcov throws when the report file does not exist", () => {
  dir = makeTempDir();
  const root = dir.root;
  assert.throws(
    () => parseLcov(join(root, "missing.info"), root),
    /no coverage report was written/,
  );
});

test("parseLcovTotals sums LF/LH, BRF/BRH and FNF/FNH across records", () => {
  dir = makeTempDir();
  const lcovPath = join(dir.root, "lcov.info");
  // Two lcov records with different totals confirm the function sums rather
  // than taking the last record.
  writeFileSync(lcovPath, [
    "SF:a.ts",
    "FN:1,fa",
    "FNDA:1,fa",
    "FNF:1",
    "FNH:1",
    "BRDA:1,0,0,1",
    "BRDA:1,1,0,0",
    "BRF:2",
    "BRH:1",
    "DA:1,1",
    "DA:2,0",
    "LF:2",
    "LH:1",
    "end_of_record",
    "SF:b.ts",
    "FNF:2",
    "FNH:2",
    "BRF:1",
    "BRH:1",
    "LF:3",
    "LH:3",
    "end_of_record",
    "",
  ].join("\n"));
  const totals = parseLcovTotals(lcovPath);
  assert.equal(totals.lines.found, 5);
  assert.equal(totals.lines.hit, 4);
  assert.equal(totals.branches.found, 3);
  assert.equal(totals.branches.hit, 2);
  assert.equal(totals.functions.found, 3);
  assert.equal(totals.functions.hit, 3);
});

test("parseLcovTotals returns zeros when the report has no summary lines", () => {
  // A minimal lcov with only SF/DA lines (as the mock spawns write) has no
  // LF/LH/BRF/BRH/FNF/FNH lines, so the totals stay at zero.
  dir = makeTempDir();
  const lcovPath = join(dir.root, "lcov.info");
  writeFileSync(lcovPath, "SF:a.ts\nDA:1,1\n");
  const totals = parseLcovTotals(lcovPath);
  assert.equal(totals.lines.found, 0);
  assert.equal(totals.lines.hit, 0);
  assert.equal(totals.branches.found, 0);
  assert.equal(totals.branches.hit, 0);
  assert.equal(totals.functions.found, 0);
  assert.equal(totals.functions.hit, 0);
});

test("computeStatementCoverage measures all-covered V8 block ranges as 100%", () => {
  dir = makeTempDir();
  const root = dir.root;
  writeFileSync(join(root, "a.ts"), "export const a = 1;\n");
  const v8Dir = join(root, "v8");
  mkdirSync(v8Dir);
  // Two functions, each with one range at count > 0 \u2014 fully covered.
  writeFileSync(
    join(v8Dir, "coverage-0.json"),
    JSON.stringify({
      result: [
        {
          scriptId: "1",
          url: pathToFileURL(join(root, "a.ts")).href,
          functions: [
            { functionName: "", ranges: [{ startOffset: 0, endOffset: 20, count: 1 }], isBlockCoverage: true },
            { functionName: "f", ranges: [{ startOffset: 7, endOffset: 20, count: 2 }], isBlockCoverage: true },
          ],
        },
      ],
    }),
  );
  const result = computeStatementCoverage(v8Dir, ["a.ts"], root);
  assert.equal(result.total, 2);
  assert.equal(result.covered, 2);
  assert.equal(result.percentage, 100);
  assert.deepEqual(result.uncoveredFiles, []);
});

test("computeStatementCoverage flags files with uncovered V8 block ranges", () => {
  dir = makeTempDir();
  const root = dir.root;
  writeFileSync(join(root, "a.ts"), "export function f(x: number): number { return x > 0 ? x : -x; }\n");
  const v8Dir = join(root, "v8");
  mkdirSync(v8Dir);
  // The `f` function has an outer range (count 1) and an inner range for the
  // false branch (count 0) \u2014 one uncovered block.
  writeFileSync(
    join(v8Dir, "coverage-0.json"),
    JSON.stringify({
      result: [
        {
          scriptId: "1",
          url: pathToFileURL(join(root, "a.ts")).href,
          functions: [
            { functionName: "", ranges: [{ startOffset: 0, endOffset: 60, count: 1 }], isBlockCoverage: true },
            { functionName: "f", ranges: [
              { startOffset: 7, endOffset: 58, count: 1 },
              { startOffset: 50, endOffset: 55, count: 0 },
            ], isBlockCoverage: true },
          ],
        },
      ],
    }),
  );
  const result = computeStatementCoverage(v8Dir, ["a.ts"], root);
  assert.equal(result.total, 3);
  assert.equal(result.covered, 2);
  assert.ok(result.percentage < 100, "percentage must be below 100 when a block has count 0");
  assert.deepEqual(result.uncoveredFiles, ["a.ts"]);
});

test("computeStatementCoverage returns 100% with no matching V8 data", () => {
  // A required file absent from the V8 coverage report is skipped (the lcov
  // presence check catches missing files); with no matching blocks the total
  // stays 0 and the percentage defaults to 100 so an empty report does not
  // produce a false-negative zero.
  dir = makeTempDir();
  const root = dir.root;
  const v8Dir = join(root, "v8");
  mkdirSync(v8Dir);
  writeFileSync(join(v8Dir, "coverage-0.json"), JSON.stringify({ result: [] }));
  const result = computeStatementCoverage(v8Dir, ["missing.ts"], root);
  assert.equal(result.total, 0);
  assert.equal(result.percentage, 100);
});

test("computeStatementCoverage skips non-JSON files in the V8 coverage directory", () => {
  // Node only writes .json files to NODE_V8_COVERAGE, but the directory may
  // contain other files (a stale lock file, a temp file). The filter must skip
  // them rather than trying to JSON.parse a non-JSON file.
  dir = makeTempDir();
  const root = dir.root;
  writeFileSync(join(root, "a.ts"), "export const a = 1;\n");
  const v8Dir = join(root, "v8");
  mkdirSync(v8Dir);
  writeFileSync(join(v8Dir, "stale.lock"), "not json");
  writeFileSync(
    join(v8Dir, "coverage-0.json"),
    JSON.stringify({
      result: [
        {
          scriptId: "1",
          url: pathToFileURL(join(root, "a.ts")).href,
          functions: [
            { functionName: "", ranges: [{ startOffset: 0, endOffset: 20, count: 1 }], isBlockCoverage: true },
          ],
        },
      ],
    }),
  );
  const result = computeStatementCoverage(v8Dir, ["a.ts"], root);
  assert.equal(result.total, 1);
  assert.equal(result.covered, 1);
  assert.equal(result.percentage, 100);
});

test("computeStatementCoverage skips V8 entries with non-file URLs", () => {
  // The real V8 coverage includes Node internals with `node:` URLs and other
  // non-file schemes. `fileURLToPath` throws on those, so they must be filtered
  // out before path conversion.
  dir = makeTempDir();
  const root = dir.root;
  writeFileSync(join(root, "a.ts"), "export const a = 1;\n");
  const v8Dir = join(root, "v8");
  mkdirSync(v8Dir);
  writeFileSync(
    join(v8Dir, "coverage-0.json"),
    JSON.stringify({
      result: [
        {
          scriptId: "1",
          url: "node:internal/process/pre_execution",
          functions: [
            { functionName: "", ranges: [{ startOffset: 0, endOffset: 100, count: 1 }], isBlockCoverage: true },
          ],
        },
        {
          scriptId: "2",
          url: pathToFileURL(join(root, "a.ts")).href,
          functions: [
            { functionName: "", ranges: [{ startOffset: 0, endOffset: 20, count: 1 }], isBlockCoverage: true },
          ],
        },
      ],
    }),
  );
  const result = computeStatementCoverage(v8Dir, ["a.ts"], root);
  assert.equal(result.total, 1);
  assert.equal(result.covered, 1);
  assert.equal(result.percentage, 100);
});

test("computeStatementCoverage ignores V8 entries for files not in the required set", () => {
  // The V8 coverage directory includes test files, fixtures, and other modules
  // loaded during the run but not in the gate's required source set. Those
  // entries must be skipped so only the required files contribute to the
  // statement total.
  dir = makeTempDir();
  const root = dir.root;
  writeFileSync(join(root, "a.ts"), "export const a = 1;\n");
  writeFileSync(join(root, "b.ts"), "export const b = 2;\n");
  const v8Dir = join(root, "v8");
  mkdirSync(v8Dir);
  writeFileSync(
    join(v8Dir, "coverage-0.json"),
    JSON.stringify({
      result: [
        {
          scriptId: "1",
          url: pathToFileURL(join(root, "a.ts")).href,
          functions: [
            { functionName: "", ranges: [{ startOffset: 0, endOffset: 20, count: 1 }], isBlockCoverage: true },
          ],
        },
        {
          scriptId: "2",
          url: pathToFileURL(join(root, "b.ts")).href,
          functions: [
            { functionName: "", ranges: [{ startOffset: 0, endOffset: 20, count: 1 }], isBlockCoverage: true },
          ],
        },
      ],
    }),
  );
  const result = computeStatementCoverage(v8Dir, ["a.ts"], root);
  assert.equal(result.total, 1);
  assert.equal(result.covered, 1);
  assert.equal(result.percentage, 100);
});

test("computeStatementCoverage merges V8 block ranges across JSON files by max count", () => {
  // Node writes one V8 coverage JSON file per process, so the same source file
  // appears in multiple files with different counts. A block is covered if
  // ANY process entered it, so the merge takes the maximum count per range.
  dir = makeTempDir();
  const root = dir.root;
  writeFileSync(join(root, "a.ts"), "export const a = 1;\n");
  const v8Dir = join(root, "v8");
  mkdirSync(v8Dir);
  // First JSON: both ranges have count 0 (the block was not entered by this process).
  writeFileSync(
    join(v8Dir, "coverage-0.json"),
    JSON.stringify({
      result: [
        {
          scriptId: "1",
          url: pathToFileURL(join(root, "a.ts")).href,
          functions: [
            { functionName: "", ranges: [{ startOffset: 0, endOffset: 20, count: 0 }], isBlockCoverage: true },
            { functionName: "f", ranges: [{ startOffset: 7, endOffset: 20, count: 0 }], isBlockCoverage: true },
          ],
        },
      ],
    }),
  );
  // Second JSON: same ranges but count 1 (the block was entered by this process).
  writeFileSync(
    join(v8Dir, "coverage-1.json"),
    JSON.stringify({
      result: [
        {
          scriptId: "2",
          url: pathToFileURL(join(root, "a.ts")).href,
          functions: [
            { functionName: "", ranges: [{ startOffset: 0, endOffset: 20, count: 1 }], isBlockCoverage: true },
            { functionName: "f", ranges: [{ startOffset: 7, endOffset: 20, count: 1 }], isBlockCoverage: true },
          ],
        },
      ],
    }),
  );
  // Third JSON: same ranges but count 0 again. Processing this after the second
  // file exercises the `range.count > existing` false branch (0 is not > 1).
  writeFileSync(
    join(v8Dir, "coverage-2.json"),
    JSON.stringify({
      result: [
        {
          scriptId: "3",
          url: pathToFileURL(join(root, "a.ts")).href,
          functions: [
            { functionName: "", ranges: [{ startOffset: 0, endOffset: 20, count: 0 }], isBlockCoverage: true },
            { functionName: "f", ranges: [{ startOffset: 7, endOffset: 20, count: 0 }], isBlockCoverage: true },
          ],
        },
      ],
    }),
  );
  const result = computeStatementCoverage(v8Dir, ["a.ts"], root);
  // Merged: max(0, 1, 0) = 1 for each range, so both covered.
  assert.equal(result.total, 2);
  assert.equal(result.covered, 2);
  assert.equal(result.percentage, 100);
});

test("computeStatementCoverage counts a function V8 never entered as uncovered", () => {
  dir = makeTempDir();
  const root = dir.root;
  writeFileSync(join(root, "a.ts"), "export const a = 1;\n");
  const v8Dir = join(root, "v8");
  mkdirSync(v8Dir);
  // V8 sets `isBlockCoverage: false` for a function it NEVER ENTERED, reporting
  // a single whole-function range with count 0. Skipping those entries removes
  // the uncovered code from the numerator AND the denominator, so an entirely
  // uncalled function cannot move the percentage — the gate reports 100% with a
  // whole function untested, which is the blindness this gate exists to close.
  // Measured on the real tree: an uncalled probe function dropped lines to
  // 99.93% and functions to 99.69% while statements stayed at 100.00%.
  writeFileSync(
    join(v8Dir, "coverage-0.json"),
    JSON.stringify({
      result: [
        {
          scriptId: "1",
          url: pathToFileURL(join(root, "a.ts")).href,
          functions: [
            { functionName: "", ranges: [{ startOffset: 0, endOffset: 20, count: 1 }], isBlockCoverage: true },
            { functionName: "g", ranges: [{ startOffset: 7, endOffset: 20, count: 0 }], isBlockCoverage: false },
          ],
        },
      ],
    }),
  );
  const result = computeStatementCoverage(v8Dir, ["a.ts"], root);
  assert.equal(result.total, 2);
  assert.equal(result.covered, 1);
  assert.equal(result.percentage, 50);
  assert.deepEqual(result.uncoveredFiles, ["a.ts"]);
});

test("computeStatementCoverage counts a called function V8 did not instrument as covered", () => {
  dir = makeTempDir();
  const root = dir.root;
  writeFileSync(join(root, "a.ts"), "export const a = 1;\n");
  const v8Dir = join(root, "v8");
  mkdirSync(v8Dir);
  // The complement of the case above: `isBlockCoverage: false` with a non-zero
  // count means V8 entered the function but did not instrument it at block
  // level. That is covered code, and counting it as uncovered would make the
  // gate fail on tested source.
  writeFileSync(
    join(v8Dir, "coverage-0.json"),
    JSON.stringify({
      result: [
        {
          scriptId: "1",
          url: pathToFileURL(join(root, "a.ts")).href,
          functions: [
            { functionName: "", ranges: [{ startOffset: 0, endOffset: 20, count: 1 }], isBlockCoverage: true },
            { functionName: "g", ranges: [{ startOffset: 7, endOffset: 20, count: 3 }], isBlockCoverage: false },
          ],
        },
      ],
    }),
  );
  const result = computeStatementCoverage(v8Dir, ["a.ts"], root);
  assert.equal(result.total, 2);
  assert.equal(result.covered, 2);
  assert.equal(result.percentage, 100);
  assert.deepEqual(result.uncoveredFiles, []);
});

test("computeStatementCoverage removes phantom blocks subsumed by a covered block from another process", () => {
  // Different V8 processes can report the same code with different range
  // boundaries. One process reports a catch block starting at offset 50 with
  // count 0 (never entered as a standalone block), while another reports a
  // larger block starting at offset 40 that contains it with count 1 (the
  // code was entered). The subsumption filter removes the phantom so the
  // gate does not flag code that another process measured as covered.
  dir = makeTempDir();
  const root = dir.root;
  writeFileSync(join(root, "a.ts"), "export const a = 1;\n");
  const v8Dir = join(root, "v8");
  mkdirSync(v8Dir);
  // First JSON: function with a block at 50-100, count 0.
  writeFileSync(
    join(v8Dir, "coverage-0.json"),
    JSON.stringify({
      result: [
        {
          scriptId: "1",
          url: pathToFileURL(join(root, "a.ts")).href,
          functions: [
            { functionName: "", ranges: [{ startOffset: 0, endOffset: 110, count: 1 }], isBlockCoverage: true },
            { functionName: "f", ranges: [
              { startOffset: 10, endOffset: 105, count: 1 },
              { startOffset: 50, endOffset: 100, count: 0 },
            ], isBlockCoverage: true },
          ],
        },
      ],
    }),
  );
  // Second JSON: same function but the block starts at 40-100, count 1.
  // This contains the 50-100 block from the first JSON.
  writeFileSync(
    join(v8Dir, "coverage-1.json"),
    JSON.stringify({
      result: [
        {
          scriptId: "2",
          url: pathToFileURL(join(root, "a.ts")).href,
          functions: [
            { functionName: "", ranges: [{ startOffset: 0, endOffset: 110, count: 1 }], isBlockCoverage: true },
            { functionName: "f", ranges: [
              { startOffset: 10, endOffset: 105, count: 1 },
              { startOffset: 40, endOffset: 100, count: 1 },
            ], isBlockCoverage: true },
          ],
        },
      ],
    }),
  );
  const result = computeStatementCoverage(v8Dir, ["a.ts"], root);
  // The 50-100 block (count 0) is subsumed by the 40-100 block (count 1).
  // Remaining: module(0-110,count1), f outer(10-105,count1), f sub(40-100,count1).
  assert.equal(result.total, 3);
  assert.equal(result.covered, 3);
  assert.equal(result.percentage, 100);
  assert.deepEqual(result.uncoveredFiles, []);
});

test("computeStatementCoverage keeps genuinely uncovered blocks that are not subsumed", () => {
  // An uncovered block that no covered block from the same function contains
  // is genuine and must count against the threshold.
  dir = makeTempDir();
  const root = dir.root;
  writeFileSync(join(root, "a.ts"), "export const a = 1;\n");
  const v8Dir = join(root, "v8");
  mkdirSync(v8Dir);
  writeFileSync(
    join(v8Dir, "coverage-0.json"),
    JSON.stringify({
      result: [
        {
          scriptId: "1",
          url: pathToFileURL(join(root, "a.ts")).href,
          functions: [
            { functionName: "", ranges: [{ startOffset: 0, endOffset: 110, count: 1 }], isBlockCoverage: true },
            { functionName: "f", ranges: [
              { startOffset: 10, endOffset: 105, count: 1 },
              { startOffset: 50, endOffset: 100, count: 0 },
            ], isBlockCoverage: true },
          ],
        },
      ],
    }),
  );
  // Second JSON: has a covered block at 60-80, but it does NOT contain the
  // 50-100 uncovered block (60 > 50, so it starts after the uncovered block).
  writeFileSync(
    join(v8Dir, "coverage-1.json"),
    JSON.stringify({
      result: [
        {
          scriptId: "2",
          url: pathToFileURL(join(root, "a.ts")).href,
          functions: [
            { functionName: "", ranges: [{ startOffset: 0, endOffset: 110, count: 1 }], isBlockCoverage: true },
            { functionName: "f", ranges: [
              { startOffset: 10, endOffset: 105, count: 1 },
              { startOffset: 60, endOffset: 80, count: 1 },
            ], isBlockCoverage: true },
          ],
        },
      ],
    }),
  );
  const result = computeStatementCoverage(v8Dir, ["a.ts"], root);
  // The 50-100 block (count 0) is NOT subsumed by 60-80 (60 > 50).
  assert.ok(result.total >= 4, `total ${result.total} must include the uncovered block`);
  assert.ok(result.covered < result.total, "some blocks must be uncovered");
  assert.ok(result.percentage < 100, "percentage must be below 100");
  assert.deepEqual(result.uncoveredFiles, ["a.ts"]);
});

test("computeStatementCoverage handles a function with an empty ranges array", () => {
  // V8 may emit a function entry with `isBlockCoverage: true` but no ranges in
  // degenerate cases. The ternary falls back to a firstStart of 0 so the key
  // is still unique, and the empty range loop contributes zero blocks.
  dir = makeTempDir();
  const root = dir.root;
  writeFileSync(join(root, "a.ts"), "export const a = 1;\n");
  const v8Dir = join(root, "v8");
  mkdirSync(v8Dir);
  writeFileSync(
    join(v8Dir, "coverage-0.json"),
    JSON.stringify({
      result: [
        {
          scriptId: "1",
          url: pathToFileURL(join(root, "a.ts")).href,
          functions: [
            { functionName: "", ranges: [{ startOffset: 0, endOffset: 20, count: 1 }], isBlockCoverage: true },
            { functionName: "g", ranges: [], isBlockCoverage: true },
          ],
        },
      ],
    }),
  );
  const result = computeStatementCoverage(v8Dir, ["a.ts"], root);
  assert.equal(result.total, 1);
  assert.equal(result.covered, 1);
  assert.equal(result.percentage, 100);
});

test("resolveEmitPaths returns outDir and rootDir from the real tsconfig", () => {
  const result = resolveEmitPaths(repoRoot);
  assert.equal(result.outDir, "dist");
  assert.equal(result.rootDir, ".");
});

test("resolveEmitPaths defaults outDir and rootDir when the config omits them", () => {
  // A resolved config with no `compilerOptions` (or none naming the paths)
  // exercises the documented defaults rather than guessing an emit layout.
  const partial = (): { status: number; stdout: string; stderr: string } => ({
    status: 0,
    stdout: JSON.stringify({}),
    stderr: "",
  });
  const result = resolveEmitPaths(repoRoot, partial);
  assert.equal(result.outDir, "dist");
  assert.equal(result.rootDir, ".");
});

test("resolveEmitPaths throws when tsc --showConfig fails or writes nothing", () => {
  // An injectable show-config runner exercises the fail-closed branch without
  // depending on a broken real compiler: a non-zero status, or a successful
  // status with no output, both refuse to guess the emit layout.
  const failing = (): { status: number; stdout: string; stderr: string } => ({
    status: 1,
    stdout: "",
    stderr: "tsc: error TS5057",
  });
  assert.throws(
    () => resolveEmitPaths(repoRoot, failing),
    /could not resolve the effective tsconfig/,
  );
  const empty = (): { status: number; stdout: string; stderr: string } => ({
    status: 0,
    stdout: "",
    stderr: "",
  });
  assert.throws(
    () => resolveEmitPaths(repoRoot, empty),
    /could not resolve the effective tsconfig/,
  );
});

test("resolveEmitPaths refuses to guess when tsc --showConfig exits 0 with non-JSON output", () => {
  // `npx tsc --showConfig` can exit 0 and still write a non-JSON notice to
  // stdout. A bare JSON.parse would surface that as a SyntaxError stripped of
  // any `tsc --showConfig` context, contradicting the "Refusing to guess"
  // diagnostic this function exists to emit; the guard restates it so the
  // failure stays actionable regardless of what stdout carried.
  const nonJson = (): { status: number; stdout: string; stderr: string } => ({
    status: 0,
    stdout: "npx notice: this is not json",
    stderr: "",
  });
  assert.throws(
    () => resolveEmitPaths(repoRoot, nonJson),
    /did not return JSON/,
  );
});

test("computeRequired returns expected minus exempted files", () => {
  // The real repo has no ignore entries, so required equals expected.
  const expected = collectSources(repoRoot, defaultSkipDirs, repoRoot);
  const config = {
    sources: ["."],
    tests: [],
    thresholds: { lines: 100, branches: 100, functions: 100 },
  };
  const required = computeRequired(config, expected, repoRoot);
  assert.deepEqual(required, expected);
});

test("computeRequired accepts a type-only ignore entry and removes it from the required set", () => {
  dir = makeTempDir();
  const root = dir.root;
  mkdirSync(join(root, "dist"), { recursive: true });
  // The compiled output of a type-only module erases to `export {};` — nothing
  // executable — so the gate accepts it as exempt while still requiring `a.ts`.
  writeFileSync(join(root, "dist", "types.js"), "export {};\n");
  const config = {
    sources: ["."],
    tests: [],
    thresholds: { lines: 100, branches: 100, functions: 100 },
    ignore: ["types.ts"],
  };
  const showConfig = (): { status: number; stdout: string; stderr: string } => ({
    status: 0,
    stdout: JSON.stringify({ compilerOptions: { outDir: "dist", rootDir: "." } }),
    stderr: "",
  });
  const required = computeRequired(config, ["a.ts", "types.ts"], root, showConfig);
  assert.deepEqual(required, ["a.ts"]);
});

test("computeRequired throws when an ignored file has no compiled output", () => {
  dir = makeTempDir();
  const root = dir.root;
  const config = {
    sources: ["."],
    tests: [],
    thresholds: { lines: 100, branches: 100, functions: 100 },
    ignore: ["types.ts"],
  };
  const showConfig = (): { status: number; stdout: string; stderr: string } => ({
    status: 0,
    stdout: JSON.stringify({ compilerOptions: { outDir: "dist", rootDir: "." } }),
    stderr: "",
  });
  assert.throws(
    () => computeRequired(config, ["types.ts"], root, showConfig),
    /no compiled output/,
  );
});

test("computeRequired throws when an ignored file emits runtime code", () => {
  dir = makeTempDir();
  const root = dir.root;
  mkdirSync(join(root, "dist"), { recursive: true });
  // A module that keeps runtime code after stripping `export {};` is not type-only,
  // so exempting it would reopen the hole the gate exists to close.
  writeFileSync(join(root, "dist", "types.js"), "export const runtime = 1;\n");
  const config = {
    sources: ["."],
    tests: [],
    thresholds: { lines: 100, branches: 100, functions: 100 },
    ignore: ["types.ts"],
  };
  const showConfig = (): { status: number; stdout: string; stderr: string } => ({
    status: 0,
    stdout: JSON.stringify({ compilerOptions: { outDir: "dist", rootDir: "." } }),
    stderr: "",
  });
  assert.throws(
    () => computeRequired(config, ["types.ts"], root, showConfig),
    /emits runtime code/,
  );
});

test("computeRequired throws for an ignore entry not under sources", () => {
  const config = {
    sources: ["."],
    tests: [],
    thresholds: { lines: 100, branches: 100, functions: 100 },
    ignore: ["nonexistent.ts"],
  };
  assert.throws(
    () => computeRequired(config, ["index.ts"], repoRoot),
    /not under `sources`/,
  );
});

test("computeRequired throws when no source files are found", () => {
  const config = {
    sources: ["."],
    tests: [],
    thresholds: { lines: 100, branches: 100, functions: 100 },
  };
  assert.throws(
    () => computeRequired(config, [], repoRoot),
    /source walk found no files/,
  );
});

/** Mock spawn that writes a valid lcov listing every required file. */
function mockSpawnSuccess(required: readonly string[], lcovPath: string): typeof spawnSuccess {
  function spawnSuccess(
    _command: string,
    args: readonly string[],
    _options: { cwd: string; stdio: "inherit"; env: NodeJS.ProcessEnv },
  ): { status: number | null; error?: Error } {
    // Find the lcov destination in the args and write a fake report.
    const destIndex = args.indexOf(`--test-reporter-destination=${lcovPath}`);
    if (destIndex >= 0) {
      mkdirSync(join(lcovPath, ".."), { recursive: true });
      const lcov = required.map((file) => `SF:${file}\nDA:1,1\n`).join("");
      writeFileSync(lcovPath, lcov);
    }
    return { status: 0 };
  }
  return spawnSuccess;
}

/** Mock spawn that returns a non-zero exit status. */
function spawnFailure(
  _command: string,
  _args: readonly string[],
  _options: { cwd: string; stdio: "inherit"; env: NodeJS.ProcessEnv },
): { status: number | null; error?: Error } {
  return { status: 1 };
}

/** Mock spawn that returns a spawn error. */
function spawnError(
  _command: string,
  _args: readonly string[],
  _options: { cwd: string; stdio: "inherit"; env: NodeJS.ProcessEnv },
): { status: number | null; error?: Error } {
  return { status: null, error: new Error("spawn failed intentionally") };
}

/** Mock spawn that succeeds but writes no lcov report. */
function spawnNoLcov(
  _command: string,
  _args: readonly string[],
  _options: { cwd: string; stdio: "inherit"; env: NodeJS.ProcessEnv },
): { status: number | null; error?: Error } {
  return { status: 0 };
}

/** V8 block ranges for a fully covered single-function file. */
function v8FullyCovered(root: string, file: string): unknown {
  return {
    result: [
      {
        scriptId: "1",
        url: pathToFileURL(join(root, file)).href,
        functions: [
          { functionName: "", ranges: [{ startOffset: 0, endOffset: 20, count: 1 }], isBlockCoverage: true },
          { functionName: "f", ranges: [{ startOffset: 7, endOffset: 20, count: 2 }], isBlockCoverage: true },
        ],
      },
    ],
  };
}

/** V8 block ranges for a file with one uncovered block (the false branch). */
function v8PartiallyCovered(root: string, file: string): unknown {
  return {
    result: [
      {
        scriptId: "1",
        url: pathToFileURL(join(root, file)).href,
        functions: [
          { functionName: "", ranges: [{ startOffset: 0, endOffset: 60, count: 1 }], isBlockCoverage: true },
          { functionName: "f", ranges: [
            { startOffset: 7, endOffset: 58, count: 1 },
            { startOffset: 50, endOffset: 55, count: 0 },
          ], isBlockCoverage: true },
        ],
      },
    ],
  };
}

/** Mock spawn that writes both an lcov report and V8 coverage JSON. */
function mockSpawnWithV8(
  required: readonly string[],
  lcovPath: string,
  v8Data: unknown,
): typeof spawnWithV8 {
  function spawnWithV8(
    _command: string,
    args: readonly string[],
    options: { cwd: string; stdio: "inherit"; env: NodeJS.ProcessEnv },
  ): { status: number | null; error?: Error } {
    const destIndex = args.indexOf(`--test-reporter-destination=${lcovPath}`);
    if (destIndex >= 0) {
      mkdirSync(join(lcovPath, ".."), { recursive: true });
      const lcov = required.map((file) => `SF:${file}\nDA:1,1\n`).join("");
      writeFileSync(lcovPath, lcov);
    }
    const v8Dir = options.env.NODE_V8_COVERAGE;
    if (v8Dir) {
      mkdirSync(v8Dir, { recursive: true });
      writeFileSync(join(v8Dir, "coverage-0.json"), JSON.stringify(v8Data));
    }
    return { status: 0 };
  }
  return spawnWithV8;
}

test("runGate succeeds when the mock spawn reports all required files", () => {
  dir = makeTempDir();
  writeFileSync(join(dir.root, "a.ts"), "export const a = 1;\n");
  const config = {
    sources: ["."],
    tests: ["test/a.test.ts"],
    thresholds: { lines: 100, branches: 100, functions: 100 },
  };
  const lcovPath = join(dir.root, "coverage", "lcov.info");
  const result = runGate(config, dir.root, mockSpawnSuccess(["a.ts"], lcovPath));
  assert.equal(result.exitCode, 0, result.stderr);
  assert.match(result.stdout, /1 source file\(s\) reported/);
});

test("runGate threads the injectable showConfig runner through ignore validation", () => {
  // runGate accepts an injectable spawn but must also forward the injectable
  // `tsc --showConfig` runner to computeRequired; otherwise any runGate test
  // with a non-empty `coverageGate.ignore` would fall back to the real
  // defaultShowConfig and reach the installed toolchain. A type-only ignore
  // entry exercised through the injected runner proves the threading works.
  dir = makeTempDir();
  const root = dir.root;
  writeFileSync(join(root, "a.ts"), "export const a = 1;\n");
  writeFileSync(join(root, "types.ts"), "export type X = number;\n");
  mkdirSync(join(root, "dist"), { recursive: true });
  writeFileSync(join(root, "dist", "types.js"), "export {};\n");
  const config = {
    sources: ["."],
    tests: ["test/a.test.ts"],
    thresholds: { lines: 100, branches: 100, functions: 100 },
    ignore: ["types.ts"],
  };
  let showConfigCalls = 0;
  const showConfig = (): { status: number; stdout: string; stderr: string } => {
    showConfigCalls += 1;
    return { status: 0, stdout: JSON.stringify({ compilerOptions: { outDir: "dist", rootDir: "." } }), stderr: "" };
  };
  const lcovPath = join(root, "coverage", "lcov.info");
  const result = runGate(config, root, mockSpawnSuccess(["a.ts"], lcovPath), showConfig);
  assert.equal(result.exitCode, 0, result.stderr);
  assert.ok(showConfigCalls > 0, "the injected showConfig runner must be used for ignore validation");
});

test("runGate fails when the test runner exits non-zero", () => {
  dir = makeTempDir();
  writeFileSync(join(dir.root, "a.ts"), "export const a = 1;\n");
  const config = {
    sources: ["."],
    tests: ["test/a.test.ts"],
    thresholds: { lines: 100, branches: 100, functions: 100 },
  };
  const result = runGate(config, dir.root, spawnFailure);
  assert.equal(result.exitCode, 1);
  assert.equal(result.stderr, "");
});

test("runGate reports exit code 1 when the runner is killed with a null status", () => {
  // A null status with no spawn error (a signal kill, for instance) is neither a
  // spawn failure nor a clean exit: the gate fails closed on exit code 1.
  dir = makeTempDir();
  writeFileSync(join(dir.root, "a.ts"), "export const a = 1;\n");
  const config = {
    sources: ["."],
    tests: ["test/a.test.ts"],
    thresholds: { lines: 100, branches: 100, functions: 100 },
  };
  const nullStatus = (): { status: number | null; error?: Error } => ({ status: null });
  const result = runGate(config, dir.root, nullStatus);
  assert.equal(result.exitCode, 1);
  assert.equal(result.stderr, "");
});

test("runGate fails when the test runner cannot be spawned", () => {
  dir = makeTempDir();
  writeFileSync(join(dir.root, "a.ts"), "export const a = 1;\n");
  const config = {
    sources: ["."],
    tests: ["test/a.test.ts"],
    thresholds: { lines: 100, branches: 100, functions: 100 },
  };
  const result = runGate(config, dir.root, spawnError);
  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /failed to start the test runner/);
});

test("runGate fails when no lcov report is written", () => {
  dir = makeTempDir();
  writeFileSync(join(dir.root, "a.ts"), "export const a = 1;\n");
  const config = {
    sources: ["."],
    tests: ["test/a.test.ts"],
    thresholds: { lines: 100, branches: 100, functions: 100 },
  };
  const result = runGate(config, dir.root, spawnNoLcov);
  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /no coverage report was written/);
});

test("runGate fails when required files are missing from the report", () => {
  dir = makeTempDir();
  writeFileSync(join(dir.root, "a.ts"), "export const a = 1;\n");
  writeFileSync(join(dir.root, "b.ts"), "export const b = 2;\n");
  const config = {
    sources: ["."],
    tests: ["test/a.test.ts"],
    thresholds: { lines: 100, branches: 100, functions: 100 },
  };
  // Mock spawn writes lcov with only "a.ts", so "b.ts" is missing.
  const lcovPath = join(dir.root, "coverage", "lcov.info");
  const result = runGate(config, dir.root, mockSpawnSuccess(["a.ts"], lcovPath));
  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /b\.ts/);
  assert.match(result.stderr, /never loaded during the run/);
});

test("runGate enforces the configured statements threshold and reports four-dimensional totals", () => {
  // When `statements` is configured, the gate reads V8 block coverage from
  // the NODE_V8_COVERAGE directory the runner wrote, computes the percentage,
  // and includes all four dimensions in the success message. With all blocks
  // covered the gate passes.
  dir = makeTempDir();
  const root = dir.root;
  writeFileSync(join(root, "a.ts"), "export const a = 1;\n");
  const config = {
    sources: ["."],
    tests: ["test/a.test.ts"],
    thresholds: { lines: 100, branches: 100, functions: 100, statements: 100 },
  };
  const lcovPath = join(root, "coverage", "lcov.info");
  const result = runGate(config, root, mockSpawnWithV8(["a.ts"], lcovPath, v8FullyCovered(root, "a.ts")));
  assert.equal(result.exitCode, 0, result.stderr);
  assert.match(result.stdout, /1 source file\(s\) reported/);
  assert.match(result.stdout, /lines 100\.00%/);
  assert.match(result.stdout, /branches 100\.00%/);
  assert.match(result.stdout, /functions 100\.00%/);
  assert.match(result.stdout, /statements 100\.00%/);
});

test("runGate fails when statement coverage is below the configured threshold", () => {
  // The V8 data has one uncovered block (count 0), so statement coverage is
  // below 100%. The gate must reject it even though the mock lcov reports all
  // files present and the mock runner exits 0 \u2014 proving the gate is not
  // blind to the statement dimension.
  dir = makeTempDir();
  const root = dir.root;
  writeFileSync(join(root, "a.ts"), "export function f(x: number): number { return x > 0 ? x : -x; }\n");
  const config = {
    sources: ["."],
    tests: ["test/a.test.ts"],
    thresholds: { lines: 100, branches: 100, functions: 100, statements: 100 },
  };
  const lcovPath = join(root, "coverage", "lcov.info");
  const result = runGate(config, root, mockSpawnWithV8(["a.ts"], lcovPath, v8PartiallyCovered(root, "a.ts")));
  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /statement coverage/);
  assert.match(result.stderr, /below the configured threshold/);
  assert.match(result.stderr, /a\.ts/);
});

test("runGate fails when statements is configured but no V8 coverage data exists", () => {
  // If the runner exits 0 but no V8 coverage was written (a misconfigured env,
  // a runner that swallowed the env var, or a mock that did not write it),
  // the gate must fail rather than pass vacuously with total 0 = 100%.
  dir = makeTempDir();
  const root = dir.root;
  writeFileSync(join(root, "a.ts"), "export const a = 1;\n");
  const config = {
    sources: ["."],
    tests: ["test/a.test.ts"],
    thresholds: { lines: 100, branches: 100, functions: 100, statements: 100 },
  };
  const lcovPath = join(root, "coverage", "lcov.info");
  // mockSpawnSuccess writes lcov but no V8 coverage.
  const result = runGate(config, root, mockSpawnSuccess(["a.ts"], lcovPath));
  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /no V8 block coverage data found/);
});

test("runGate skips statement coverage when the threshold is not configured", () => {
  // Without `statements` in the config the gate does not read V8 coverage,
  // so it passes even when no V8 data was written. This is the backward-
  // compatible path: existing configs without `statements` are unaffected.
  dir = makeTempDir();
  const root = dir.root;
  writeFileSync(join(root, "a.ts"), "export const a = 1;\n");
  const config = {
    sources: ["."],
    tests: ["test/a.test.ts"],
    thresholds: { lines: 100, branches: 100, functions: 100 },
  };
  const lcovPath = join(root, "coverage", "lcov.info");
  const result = runGate(config, root, mockSpawnSuccess(["a.ts"], lcovPath));
  assert.equal(result.exitCode, 0, result.stderr);
  // Three-dimensional totals still appear, but statements defaults to 100%.
  assert.match(result.stdout, /statements 100\.00%/);
});

test("runGate reports non-vacuous percentages when the lcov report has summary lines", () => {
  // The mock lcov in other tests has only SF/DA lines, so the line, branch and
  // function totals are zero and the percentages default to the vacuous 100%.
  // This test writes an lcov with LF/LH/BRF/BRH/FNF/FNH lines so the gate
  // computes real percentages from the totals, exercising the `found > 0` branch
  // of each ternary.
  dir = makeTempDir();
  const root = dir.root;
  writeFileSync(join(root, "a.ts"), "export const a = 1;\n");
  const config = {
    sources: ["."],
    tests: ["test/a.test.ts"],
    thresholds: { lines: 100, branches: 100, functions: 100, statements: 100 },
  };
  const lcovPath = join(root, "coverage", "lcov.info");
  function spawnWithTotals(
    _command: string,
    args: readonly string[],
    options: { cwd: string; stdio: "inherit"; env: NodeJS.ProcessEnv },
  ): { status: number | null; error?: Error } {
    const destIndex = args.indexOf(`--test-reporter-destination=${lcovPath}`);
    if (destIndex >= 0) {
      mkdirSync(join(lcovPath, ".."), { recursive: true });
      writeFileSync(lcovPath, [
        "SF:a.ts",
        "FN:1,f",
        "FNDA:1,f",
        "FNF:1",
        "FNH:1",
        "BRDA:1,0,0,1",
        "BRF:1",
        "BRH:1",
        "DA:1,1",
        "LF:1",
        "LH:1",
        "end_of_record",
        "",
      ].join("\n"));
    }
    const v8Dir = options.env.NODE_V8_COVERAGE;
    if (v8Dir) {
      mkdirSync(v8Dir, { recursive: true });
      writeFileSync(join(v8Dir, "coverage-0.json"), JSON.stringify(v8FullyCovered(root, "a.ts")));
    }
    return { status: 0 };
  }
  const result = runGate(config, root, spawnWithTotals);
  assert.equal(result.exitCode, 0, result.stderr);
  assert.match(result.stdout, /lines 100\.00%/);
  assert.match(result.stdout, /branches 100\.00%/);
  assert.match(result.stdout, /functions 100\.00%/);
  assert.match(result.stdout, /statements 100\.00%/);
});

test("runGate fails when config is null", () => {
  dir = makeTempDir();
  const result = runGate(null, dir.root, () => ({ status: 0 }));
  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /no `coverageGate` block/);
});

test("runGate fails when a source directory does not exist", () => {
  dir = makeTempDir();
  const config = {
    sources: ["nonexistent"],
    tests: [],
    thresholds: { lines: 100, branches: 100, functions: 100 },
  };
  const result = runGate(config, dir.root, () => ({ status: 0 }));
  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /does not exist/);
});

test("runGate surfaces a computeRequired failure through its own catch", () => {
  // Uses the real repo root so resolveEmitPaths succeeds and computeRequired
  // reaches the "not under sources" check; that throw propagates through
  // runGate's catch (after the source walk already succeeded), not the
  // source-walk try block. The mock spawn is never reached.
  const config = {
    sources: ["."],
    tests: [],
    thresholds: { lines: 100, branches: 100, functions: 100 },
    ignore: ["nonexistent.ts"],
  };
  const result = runGate(config, repoRoot, () => ({ status: 0 }));
  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /not under `sources`/);
});

test("defaultSpawn forwards the command and returns the real exit status", () => {
  // The default spawn is the one `npm run coverage` relies on. Covering it with
  // a trivial command verifies the wrapper forwards argv and reports status;
  // a full in-process gate run is unverifiable here because a test runner
  // spawned from inside another test runner does not flush its lcov reporter.
  const result = defaultSpawn(process.execPath, ["-e", "process.exit(0)"], {
    cwd: repoRoot,
    stdio: "inherit",
    env: process.env,
  });
  assert.equal(result.status, 0);
});

test("main reads package.json, runs the gate, and writes its result", () => {
  // main() is exercised against a throwaway workspace with an injected spawn
  // rather than the real repository: spawning the real test runner would
  // re-run this very file (coverage-gate.test.ts is a configured test), which
  // recurses back into main() and never produces a report. The injected spawn
  // isolates main()'s own responsibility — reading package.json and emitting
  // runGate's result — without the recursion.
  dir = makeTempDir();
  const root = dir.root;
  writeFileSync(join(root, "a.ts"), "export const a = 1;\n");
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({
      coverageGate: {
        sources: ["."],
        tests: ["test/a.test.ts"],
        thresholds: { lines: 100, branches: 100, functions: 100 },
      },
    }),
  );
  const lcovPath = join(root, "coverage", "lcov.info");
  const originalExitCode = process.exitCode;
  const originalStdoutWrite = process.stdout.write.bind(process.stdout);
  let stdout = "";
  process.stdout.write = ((chunk: string | Uint8Array): boolean => {
    stdout += chunk.toString();
    return true;
  }) as typeof process.stdout.write;
  process.exitCode = undefined;
  try {
    main(root, mockSpawnSuccess(["a.ts"], lcovPath));
    assert.equal(process.exitCode, 0);
    assert.match(stdout, /1 source file\(s\) reported/);
  } finally {
    process.stdout.write = originalStdoutWrite;
    process.exitCode = originalExitCode;
  }
});

test("main fails closed when package.json has no coverageGate block", () => {
  dir = makeTempDir();
  const root = dir.root;
  writeFileSync(join(root, "package.json"), JSON.stringify({}));
  const originalExitCode = process.exitCode;
  const originalStderrWrite = process.stderr.write.bind(process.stderr);
  let stderr = "";
  process.stderr.write = ((chunk: string | Uint8Array): boolean => {
    stderr += chunk.toString();
    return true;
  }) as typeof process.stderr.write;
  process.exitCode = undefined;
  try {
    main(root, () => ({ status: 0 }));
    assert.equal(process.exitCode, 1);
    assert.match(stderr, /no `coverageGate` block/);
  } finally {
    process.stderr.write = originalStderrWrite;
    process.exitCode = originalExitCode;
  }
});

test("isMainInvocation resolves matching, different and absent scripts", () => {
  dir = makeTempDir();
  const root = dir.root;
  const script = join(root, "coverage-gate.ts");
  const other = join(root, "other.ts");
  writeFileSync(script, "");
  writeFileSync(other, "");
  const url = pathToFileURL(script).href;
  assert.equal(isMainInvocation([process.execPath, script], url), true);
  assert.equal(isMainInvocation([process.execPath, other], url), false);
  assert.equal(isMainInvocation([process.execPath], url), false);
});

test("isMainInvocation throws rather than skipping the gate when the entry cannot be resolved", () => {
  dir = makeTempDir();
  const root = dir.root;
  const script = join(root, "coverage-gate.ts");
  writeFileSync(script, "");
  const url = pathToFileURL(script).href;
  // This assertion previously expected `false`. That made the caller treat the
  // script as a library import and skip `main`, so the coverage gate exited 0
  // having measured nothing - a required release check reporting success
  // without doing its job. Crashing is the safe outcome, so assert it happens.
  assert.throws(
    () => isMainInvocation([process.execPath, join(root, "missing.ts")], url),
    /ENOENT/,
    "an unresolvable entry must propagate, not silently decline to run the gate",
  );
});