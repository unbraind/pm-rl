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
  DEFAULT_SKIP_DIRS,
  defaultSpawn,
  isMainInvocation,
  main,
  parseLcov,
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