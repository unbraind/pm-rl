/**
 * Coverage gate for the package test suite.
 *
 * Runs `node --test` with the runtime's built-in V8 coverage against the
 * TypeScript sources directly (Node executes `.ts` natively, so the reported
 * line numbers are the ones an author edits, not compiled output), enforces a
 * per-dimension threshold, and reconciles the reported file list against the
 * files actually on disk.
 *
 * That last step is the reason this script exists rather than a bare
 * `node --test --test-coverage-lines=...` invocation. Node only reports files
 * that were loaded during the run: a source module with no test at all is
 * omitted from the report entirely rather than reported at zero. The published
 * percentage is therefore computed over the tested subset, and a package can
 * satisfy a 100% threshold while an entire module goes unexercised. Comparing
 * the report against a directory walk turns that silent omission into a failure
 * naming the missing files, so the threshold cannot be passed by narrowing what
 * the suite touches.
 *
 * Configuration lives in `package.json` under `coverageGate` so the numbers the
 * gate enforces are visible in the same file that declares the scripts, and a
 * threshold change shows up in review as a deliberate diff.
 *
 * @example
 * ```bash
 * node scripts/coverage-gate.ts
 * ```
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { type GateResult, isMainInvocation, runIfMain } from "./script-launcher.ts";

/**
 * Minimum acceptable percentage for each coverage dimension.
 *
 * Lines, branches and functions are forwarded to the Node test runner as
 * `--test-coverage-*` flags, so the runner enforces them and exits non-zero
 * when a threshold is unmet. Statements are measured separately from raw V8
 * block coverage (see {@link computeStatementCoverage}) because the Node runner
 * exposes no statement-level counter — forwarding a `--test-coverage-statements`
 * flag would be a no-op that passes a threshold the runner never checks.
 */
interface CoverageThresholds {
  /** Minimum percentage of executable lines that must be covered. */
  readonly lines: number;
  /** Minimum percentage of branch arms that must be taken. */
  readonly branches: number;
  /** Minimum percentage of declared functions that must be invoked. */
  readonly functions: number;
  /** Minimum percentage of V8 block ranges that must have been entered. */
  readonly statements?: number;
}

/** The `coverageGate` block read from `package.json`. */
interface CoverageGateConfig {
  /**
   * Source locations the gate requires to appear in the report. Each entry is
   * either a directory, walked recursively for `.ts` files, or a single file.
   *
   * Prefer a directory — including `"."` for a package whose entrypoint sits at
   * the repository root. A directory is enumerated at run time, so a source file
   * added later is required automatically. An explicit file list freezes the
   * required set at the moment it was written, and a new untested module simply
   * never enters it, which is the same blind spot this gate exists to close.
   */
  readonly sources: readonly string[];
  /**
   * Directory names skipped while walking, on top of {@link DEFAULT_SKIP_DIRS}.
   * Needed only for a source tree with a non-standard non-source directory.
   */
  readonly skipDirs?: readonly string[];
  /** Test file arguments handed to `node --test`. */
  readonly tests: readonly string[];
  /** Threshold enforced on the aggregate report. */
  readonly thresholds: CoverageThresholds;
  /**
   * Source files exempt from the presence check, each of which must be
   * type-only. A module that erases to nothing emits no coverage counters, so
   * requiring it in the report would make the gate unsatisfiable.
   */
  readonly ignore?: readonly string[];
}

/** Shape of the `package.json` fields this script reads. */
interface PackageManifest {
  readonly coverageGate?: CoverageGateConfig;
}

/** A single V8 block range with its execution count. */
interface V8Range {
  /** Byte offset where the block begins (inclusive). */
  readonly startOffset: number;
  /** Byte offset where the block ends (exclusive). */
  readonly endOffset: number;
  /** Number of times the block was entered during the test run. */
  readonly count: number;
}

/** A function entry in V8's coverage report. */
interface V8Function {
  /** Name of the function, empty string for the top-level module scope. */
  readonly functionName: string;
  /** Block ranges covering the function body and its sub-blocks. */
  readonly ranges: readonly V8Range[];
  /** Whether this entry carries block-level coverage data. */
  readonly isBlockCoverage: boolean;
}

/** A file entry in V8's coverage report. */
interface V8ScriptCoverage {
  /** V8's internal script identifier. */
  readonly scriptId: string;
  /** `file://` URL of the source file. */
  readonly url: string;
  /** Function-level coverage entries for this file. */
  readonly functions: readonly V8Function[];
}

/** The root object of a V8 coverage JSON file. */
interface V8CoverageReport {
  /** Per-file coverage entries. */
  readonly result: readonly V8ScriptCoverage[];
}

/** Statement coverage measured from V8 block ranges. */
interface StatementCoverage {
  /** Total V8 block ranges across all matched required source files. */
  readonly total: number;
  /** Block ranges with count > 0 (entered at least once). */
  readonly covered: number;
  /** Percentage of blocks covered, or 100 when no blocks were found. */
  readonly percentage: number;
  /** Required files with at least one uncovered block. */
  readonly uncoveredFiles: readonly string[];
}

/** Aggregate coverage totals parsed from an lcov report. */
interface LcovTotals {
  /** Total lines found and hit across all reported files. */
  readonly lines: { readonly found: number; readonly hit: number };
  /** Total branches found and hit across all reported files. */
  readonly branches: { readonly found: number; readonly hit: number };
  /** Total functions found and hit across all reported files. */
  readonly functions: { readonly found: number; readonly hit: number };
}

/** Compiler paths used to locate a source file's emitted output. */
interface TsConfig {
  readonly compilerOptions?: { readonly outDir?: string; readonly rootDir?: string };
}

/** Result of a spawned test-runner process used by the gate. */
interface SpawnResult {
  /** Exit status of the process, or null on signal/error. */
  readonly status: number | null;
  /** Spawn error when the process could not be started. */
  readonly error?: Error;
}

/** Injectable spawn function matching the subset of `spawnSync` the gate uses. */
type SpawnFn = (
  command: string,
  arguments_: readonly string[],
  options: { cwd: string; stdio: "inherit"; env: NodeJS.ProcessEnv },
) => SpawnResult;

/**
 * Directories never treated as source, so that `sources: ["."]` works for a
 * package whose entrypoint sits at the repository root.
 *
 * These hold tests, build output, tooling and installed dependencies. None of
 * them contain shipped source, and several would otherwise make the required
 * set unsatisfiable — a test file cannot appear in its own coverage report.
 *
 * `scripts` is deliberately absent: operational scripts can corrupt a release,
 * so they must be inside the coverage gate.
 */
export const DEFAULT_SKIP_DIRS: readonly string[] = [
  "node_modules",
  "dist",
  "dist-test",
  "coverage",
  "test",
  "tests",
  "public",
  ".agents",
  ".git",
  ".github",
];

/** Default spawn implementation, overridden in tests. */
export const defaultSpawn: SpawnFn = (command, arguments_, options) =>
  spawnSync(command, [...arguments_], { ...options, encoding: "utf8" }) as SpawnResult;

/** Output of a `tsc --showConfig` invocation, normalized so a test can inject it. */
interface ShowConfigResult {
  /** Exit status of the `tsc --showConfig` process, or null on signal. */
  readonly status: number | null;
  /** Standard output of the resolved config, empty when `tsc` wrote nothing. */
  readonly stdout: string;
  /** Standard error of the resolved config, empty on success. */
  readonly stderr: string;
}

/** Injectable `tsc --showConfig` runner; defaults to the real `spawnSync`. */
type ShowConfigFn = (repoRoot: string) => ShowConfigResult;

/** Default show-config implementation, overridden in tests. */
const defaultShowConfig: ShowConfigFn = (repoRoot) => {
  const result = spawnSync("npx", ["--no-install", "tsc", "--showConfig", "-p", "tsconfig.json"], {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: 60_000,
    shell: process.platform === "win32",
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
};

/**
 * Resolves the compiler's effective output paths.
 *
 * Asks `tsc --showConfig` rather than parsing `tsconfig.json` directly: the file
 * may be JSONC and may inherit `outDir`/`rootDir` through an `extends` chain, so
 * a raw `JSON.parse` can either throw on a valid config or silently read the
 * wrong paths.
 *
 * @param repoRoot - Absolute repository root the tsconfig resolves against.
 * @param showConfig - Injectable `tsc --showConfig` runner; defaults to the real `spawnSync`.
 * @returns The effective `outDir` and `rootDir` from the resolved compiler config.
 * @throws When `tsc --showConfig` fails or returns no output.
 */
export function resolveEmitPaths(
  repoRoot: string,
  showConfig: ShowConfigFn = defaultShowConfig,
): { outDir: string; rootDir: string } {
  const shown = showConfig(repoRoot);
  if (shown.status !== 0 || !shown.stdout) {
    throw new Error(
      [
        "coverage-gate: could not resolve the effective tsconfig via `tsc --showConfig`,",
        "so the emit layout is unknown and `coverageGate.ignore` entries cannot be verified",
        "as type-only. Refusing to guess.",
        shown.stderr.trim() ? `\n${shown.stderr.trim()}` : "",
      ].join("\n"),
    );
  }
  let parsed: TsConfig;
  try {
    parsed = JSON.parse(shown.stdout) as TsConfig;
  } catch (error) {
    // `npx tsc --showConfig` can exit 0 and still write non-JSON to stdout (an
    // npx notice, for instance). A bare `JSON.parse` would surface that as a
    // `SyntaxError` from `runGate`'s catch, which strips the `Error: ` prefix
    // and never names `tsc --showConfig` — contradicting the "Refusing to
    // guess" message this function exists to emit. Re-state the diagnostic so
    // the failure stays actionable regardless of what stdout carried.
    throw new Error(
      [
        "coverage-gate: `tsc --showConfig` did not return JSON, so the emit layout is unknown",
        "and `coverageGate.ignore` entries cannot be verified as type-only. Refusing to guess.",
        String(error),
      ].join("\n"),
    );
  }
  // `tsc --showConfig` echoes the config's literal spelling, so a `tsconfig.json`
  // that writes `"outDir": "./dist"` reports `./dist` back. Clean the leading
  // `./` and any trailing separator so callers see a stable, join-friendly
  // directory name regardless of how the author spelled it, matching the clean
  // default `computeRequired` already assumes.
  const cleanDir = (value: string): string => {
    const stripped = value.replace(/^\.\//, "").replace(/\/+$/, "");
    return stripped === "" ? "." : stripped;
  };
  return {
    outDir: cleanDir(parsed.compilerOptions?.outDir ?? "dist"),
    rootDir: cleanDir(parsed.compilerOptions?.rootDir ?? "."),
  };
}

/**
 * Collects every TypeScript source file at a configured location.
 *
 * A file entry resolves to itself; a directory entry is walked recursively with
 * `skipDirs` pruned. Declaration files are skipped either way: they carry no
 * runtime code and so can never appear in a coverage report.
 *
 * @param target - Absolute path to a source file or directory.
 * @param skipDirs - Set of directory names to skip while walking.
 * @param repoRoot - Absolute repository root for computing relative paths.
 * @returns Repository-relative POSIX paths, in directory order.
 * @throws When the target does not exist or is not a TypeScript source file.
 */
export function collectSources(target: string, skipDirs: Set<string>, repoRoot: string): string[] {
  if (!existsSync(target)) {
    throw new Error(
      `coverage-gate: \`coverageGate.sources\` names ${relative(repoRoot, target)}, which does not exist.`,
    );
  }
  if (!statSync(target).isDirectory()) {
    if (!target.endsWith(".ts") || target.endsWith(".d.ts")) {
      throw new Error(
        `coverage-gate: \`coverageGate.sources\` names ${relative(repoRoot, target)}, which is not a TypeScript source file. A declaration file or non-TypeScript entry can never appear in a coverage report, so requiring it would make the gate unsatisfiable.`,
      );
    }
    return [relative(repoRoot, target).split(sep).join("/")];
  }
  const found: string[] = [];
  for (const entry of readdirSync(target, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!skipDirs.has(entry.name)) {
        found.push(...collectSources(join(target, entry.name), skipDirs, repoRoot));
      }
    } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) {
      found.push(relative(repoRoot, join(target, entry.name)).split(sep).join("/"));
    }
  }
  return found;
}

/**
 * Validates `ignore` entries and computes the required file set.
 *
 * The exemption exists for type-only modules, which erase to nothing and so can
 * never appear in a coverage report. Left untested, it is also the one way to
 * remove an executable module from both the measured set and the required set —
 * exactly the escape this gate exists to prevent. TypeScript emits `export {};`
 * and nothing else for a module that erases completely, so the compiled output
 * settles the question rather than the author's say-so.
 *
 * @param config - The coverage gate configuration.
 * @param expected - All source files found by the directory walk.
 * @param repoRoot - Absolute repository root.
 * @param showConfig - Injectable `tsc --showConfig` runner; defaults to the real `spawnSync`.
 * @returns The files that must appear in the coverage report, with exemptions removed.
 * @throws When an `ignore` entry is not under `sources` or emits runtime code.
 */
export function computeRequired(
  config: CoverageGateConfig,
  expected: readonly string[],
  repoRoot: string,
  showConfig: ShowConfigFn = defaultShowConfig,
): string[] {
  const exempt = new Set(config.ignore ?? []);
  const emitPaths = (config.ignore ?? []).length > 0 ? resolveEmitPaths(repoRoot, showConfig) : { outDir: "dist", rootDir: "." };

  for (const file of config.ignore ?? []) {
    if (!expected.includes(file)) {
      throw new Error(`coverage-gate: \`coverageGate.ignore\` names ${file}, which is not under \`sources\`.`);
    }
    const emitted = join(
      repoRoot,
      emitPaths.outDir,
      relative(join(repoRoot, emitPaths.rootDir), join(repoRoot, file)),
    ).replace(/\.ts$/, ".js");
    if (!existsSync(emitted)) {
      throw new Error(
        `coverage-gate: cannot verify that ignored file ${file} is type-only — no compiled output at ${relative(repoRoot, emitted)}. Build before running the gate, or correct \`outDir\`/\`rootDir\`.`,
      );
    }
    // Block comments are stripped as well as line comments: tsc carries a
    // file-leading JSDoc into the emit, so a documented type-only module would
    // otherwise read as runtime code and be rejected for having a comment.
    const body = readFileSync(emitted, "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "")
      .replace(/export\s*\{\s*\}\s*;?/g, "")
      .trim();
    if (body.length > 0) {
      throw new Error(
        `coverage-gate: \`coverageGate.ignore\` names ${file}, but it emits runtime code to ${relative(repoRoot, emitted)}. Only type-only modules may be exempt; anything executable must be covered.`,
      );
    }
  }

  const required = expected.filter((file) => !exempt.has(file));
  if (required.length === 0) {
    throw new Error("coverage-gate: source walk found no files; check `coverageGate.sources`.");
  }
  return required;
}

/**
 * Parses an lcov report and returns the set of source files it reports on.
 *
 * `SF:` paths are normalised to repository-relative POSIX form so they can be
 * compared against the walk. The lcov reporter emits them relative to the
 * working directory on Linux, but that is not contractual and Windows runners
 * have been seen to emit absolute paths; without normalising, the presence
 * check would invert into a permanently red build that blames every source file
 * for never loading.
 *
 * @param lcovPath - Absolute path to the lcov report.
 * @param repoRoot - Absolute repository root for normalising paths.
 * @returns Repository-relative POSIX paths that appeared in the report.
 * @throws When the report file does not exist.
 */
export function parseLcov(lcovPath: string, repoRoot: string): Set<string> {
  const reported = new Set<string>();
  // Narrow the guard to the existence check alone. The previous `try` wrapped the
  // read and parse loop too, so an existing but unreadable report (permissions,
  // encoding) reported "no coverage report was written" — a different problem
  // than the docstring promises. Letting read/parse errors propagate keeps the
  // diagnostic honest while preserving the documented missing-file failure.
  if (!existsSync(lcovPath)) {
    throw new Error(`coverage-gate: no coverage report was written to ${relative(repoRoot, lcovPath)}.`);
  }
  for (const line of readFileSync(lcovPath, "utf8").split("\n")) {
    if (!line.startsWith("SF:")) continue;
    const raw = line.slice(3).trim();
    const abs = isAbsolute(raw) ? raw : join(repoRoot, raw);
    reported.add(relative(repoRoot, abs).split(sep).join("/"));
  }
  return reported;
}

/**
 * Parses aggregate line, branch and function totals from an lcov report.
 *
 * Sums the `LF`/`LH`, `BRF`/`BRH`, and `FNF`/`FNH` summary lines across all
 * records so the gate can report the exact three-dimensional totals the Node
 * runner enforced, alongside the statement total computed from V8 coverage.
 *
 * @param lcovPath - Absolute path to the lcov report.
 * @returns Aggregate line, branch and function found/hit counts.
 */
export function parseLcovTotals(lcovPath: string): LcovTotals {
  const lines = { found: 0, hit: 0 };
  const branches = { found: 0, hit: 0 };
  const functions = { found: 0, hit: 0 };
  for (const line of readFileSync(lcovPath, "utf8").split("\n")) {
    if (line.startsWith("LF:")) lines.found += Number(line.slice(3));
    else if (line.startsWith("LH:")) lines.hit += Number(line.slice(3));
    else if (line.startsWith("BRF:")) branches.found += Number(line.slice(4));
    else if (line.startsWith("BRH:")) branches.hit += Number(line.slice(4));
    else if (line.startsWith("FNF:")) functions.found += Number(line.slice(4));
    else if (line.startsWith("FNH:")) functions.hit += Number(line.slice(4));
  }
  return { lines, branches, functions };
}

/**
 * Computes statement coverage from V8 block coverage data.
 *
 * The Node test runner reports line, branch and function coverage but not
 * statements — V8 exposes no statement-level counter. V8 does, however, report
 * block ranges: each is a maximal sequence of statements with a uniform
 * execution count. A block with count > 0 was entered, so every statement in
 * it was executed; a block with count 0 was never entered, so none of its
 * statements ran.
 *
 * Property: every V8 block range was entered at least once (count > 0).
 * Domain: all block ranges with `isBlockCoverage` true across every required
 * source file's V8 coverage entry.
 *
 * The guard is bound to this property — "all blocks entered" — not to a
 * single symptom value, so it remains correct when the specific uncovered
 * block changes. For a 100% threshold, block coverage is equivalent to
 * statement coverage: all blocks entered iff all statements executed.
 *
 * Node writes one V8 coverage JSON file per process, even with
 * --test-concurrency=1, so the same source file appears in multiple files.
 * Different processes can report different range boundaries for the same
 * logical block (V8 splits or merges ranges depending on optimisation level).
 * The merge keys on `(file, functionName, functionFirstStart, rangeStartOffset)`:
 * a block is covered if ANY process entered it. When a count-0 block from one
 * process is fully contained by a count->0 block from a different process (same
 * function, earlier start, same-or-later end), the count-0 block is a V8
 * range-boundary phantom and is removed — it represents the same code the other
 * process measured as covered, not genuinely untested code.
 *
 * @param v8CoverageDir - Directory containing V8 coverage JSON files.
 * @param required - Repository-relative POSIX paths that must appear in the report.
 * @param repoRoot - Absolute repository root for path resolution.
 * @returns The total block count, covered block count, percentage, and uncovered files.
 */
export function computeStatementCoverage(
  v8CoverageDir: string,
  required: readonly string[],
  repoRoot: string,
): StatementCoverage {
  const scriptsWithSources: { script: V8ScriptCoverage; source: string }[] = [];
  for (const file of readdirSync(v8CoverageDir)) {
    if (!file.endsWith(".json")) continue;
    const report = JSON.parse(readFileSync(join(v8CoverageDir, file), "utf8")) as V8CoverageReport;
    for (const script of report.result) {
      scriptsWithSources.push({ script, source: file });
    }
  }

  const requiredSet = new Set(required);
  // Key: "file|fnName|funcFirstStart|rangeStart" -> { count, endOffset, source }
  const blockEntries = new Map<string, { count: number; endOffset: number; source: string }>();

  for (const { script, source } of scriptsWithSources) {
    if (!script.url.startsWith("file://")) continue;
    const abs = fileURLToPath(script.url);
    const rel = relative(repoRoot, abs).split(sep).join("/");
    if (!requiredSet.has(rel)) continue;

    for (const func of script.functions) {
      // Do NOT skip functions with `isBlockCoverage: false`. V8 sets that flag
      // false for a function it never entered, reporting a single
      // whole-function range with `count: 0`. Skipping those makes an entirely
      // uncalled function contribute nothing to either total or covered, so the
      // percentage stays at 100% while a whole function is untested — the exact
      // blindness this gate exists to close. Its ranges are counted like any
      // other: a never-entered function is one uncovered block, and a called
      // one that V8 did not instrument at block level is one covered block.
      const funcFirstStart = func.ranges.length > 0 ? func.ranges[0].startOffset : 0;
      for (const range of func.ranges) {
        const key = `${rel}|${func.functionName}|${funcFirstStart}|${range.startOffset}`;
        const existing = blockEntries.get(key);
        if (existing === undefined || range.count > existing.count) {
          blockEntries.set(key, { count: range.count, endOffset: range.endOffset, source });
        }
      }
    }
  }

  // Pre-group covered blocks by function so the subsumption loop only
  // iterates over covered blocks in the same function, not all blocks.
  const coveredByFunc = new Map<string, { start: number; end: number; src: string }[]>();
  for (const [key, entry] of blockEntries) {
    if (entry.count === 0) continue;
    const parts = key.split("|");
    const funcKey = `${parts[0]}|${parts[1]}|${parts[2]}`;
    let list = coveredByFunc.get(funcKey);
    if (list === undefined) {
      list = [];
      coveredByFunc.set(funcKey, list);
    }
    list.push({ start: Number(parts[3]), end: entry.endOffset, src: entry.source });
  }

  let total = 0;
  let covered = 0;
  const uncoveredFiles: string[] = [];

  for (const [key, entry] of blockEntries) {
    if (entry.count > 0) {
      total++;
      covered++;
      continue;
    }
    // Check whether a covered block from a DIFFERENT V8 process fully contains
    // this uncovered block. If so, it is a range-boundary phantom: the same
    // code was entered in another process that split the range differently.
    // The `src !== entry.source` check prevents a parent block in the same
    // process from subsuming its genuinely-uncovered child.
    const parts = key.split("|");
    const file = parts[0];
    const funcKey = `${parts[0]}|${parts[1]}|${parts[2]}`;
    const start = Number(parts[3]);
    const list = coveredByFunc.get(funcKey);
    let subsumed = false;
    if (list !== undefined) {
      for (const other of list) {
        if (other.src !== entry.source && other.start <= start && other.end >= entry.endOffset) {
          subsumed = true;
          break;
        }
      }
    }
    if (subsumed) continue;
    total++;
    uncoveredFiles.push(file);
  }

  const percentage = total === 0 ? 100 : (covered / total) * 100;
  return { total, covered, percentage, uncoveredFiles };
}

/**
 * Runs the coverage gate against a configured repository root.
 *
 * Walks the configured sources, validates ignore entries, spawns the test
 * runner with V8 coverage, parses the lcov report, reconciles the reported
 * file list against the required set, and \u2014 when `statements` is configured \u2014
 * measures statement coverage from raw V8 block data and enforces the threshold.
 * Returns the exit code and output the CLI would emit, so a test can call this
 * in-process without touching the real streams or exit code.
 *
 * @param config - The `coverageGate` block from `package.json`.
 * @param repoRoot - Absolute repository root.
 * @param spawn - Injectable spawn function; defaults to the real `spawnSync`.
 * @param showConfig - Injectable `tsc --showConfig` runner; defaults to the real `spawnSync`.
 * @returns The exit code and stdout/stderr the gate would emit.
 */
export function runGate(
  config: CoverageGateConfig | null,
  repoRoot: string,
  spawn: SpawnFn = defaultSpawn,
  showConfig: ShowConfigFn = defaultShowConfig,
): GateResult {
  if (!config) {
    return { exitCode: 1, stdout: "", stderr: "coverage-gate: package.json has no `coverageGate` block." };
  }

  const skipDirs = new Set([...DEFAULT_SKIP_DIRS, ...(config.skipDirs ?? [])]);
  let expected: string[];
  try {
    expected = config.sources.flatMap((source) => collectSources(join(repoRoot, source), skipDirs, repoRoot));
  } catch (error) {
    return { exitCode: 1, stdout: "", stderr: String(error).replace(/^Error: /, "") };
  }

  let required: string[];
  try {
    required = computeRequired(config, expected, repoRoot, showConfig);
  } catch (error) {
    return { exitCode: 1, stdout: "", stderr: String(error).replace(/^Error: /, "") };
  }

  const lcovPath = join(repoRoot, "coverage", "lcov.info");
  // Directory for the raw V8 coverage JSON that the statement-coverage
  // measurement reads. Node creates the directory when `NODE_V8_COVERAGE` is
  // set, but deleting it first prevents a leftover from a previous, broader
  // run from satisfying the statement check on stale data — the same stale-
  // report hazard the lcov deletion guards against for the presence check.
  const v8CoverageDir = join(repoRoot, "coverage", "v8");
  mkdirSync(join(repoRoot, "coverage"), { recursive: true });
  // Delete any previous report first. If this run writes none, a leftover file
  // from an earlier, broader run would satisfy the presence check on stale data —
  // the gate would pass by reading history rather than by measuring anything.
  rmSync(lcovPath, { force: true });
  rmSync(v8CoverageDir, { recursive: true, force: true });
  mkdirSync(v8CoverageDir, { recursive: true });

  const result = spawn(
    process.execPath,
    [
      "--test",
      // One test process at a time. The runner otherwise runs test FILES
      // concurrently and merges each worker's V8 coverage, and that merge is not
      // reliable: repeated runs of an unchanged, fully passing suite reported a
      // module anywhere between 38% and 100% of its lines, purely by which worker
      // happened to flush. Under a hard 100% threshold that is not slow-and-correct
      // versus fast-and-correct — it is a gate that fails releases at random, which
      // is worse than no gate because the failure teaches people to re-run it.
      "--test-concurrency=1",
      "--experimental-test-coverage",
      // Scope the report to exactly the files the presence check requires. Passing
      // the enumerated paths rather than a directory glob keeps the two in step by
      // construction, and keeps test files and tooling out of the percentages even
      // when the source root is the repository root.
      ...required.map((file) => `--test-coverage-include=${file}`),
      `--test-coverage-lines=${config.thresholds.lines}`,
      `--test-coverage-branches=${config.thresholds.branches}`,
      `--test-coverage-functions=${config.thresholds.functions}`,
      "--test-reporter=spec",
      "--test-reporter-destination=stdout",
      "--test-reporter=lcov",
      `--test-reporter-destination=${lcovPath}`,
      ...config.tests,
    ],
    {
      cwd: repoRoot,
      stdio: "inherit",
      // Pin the timezone so the measurement is reproducible on any machine.
      // Code that branches on a timestamp's UTC offset takes different paths under
      // a local offset than under UTC, which moves the reported percentage between
      // a contributor's machine and CI. A threshold pinned to one machine's number
      // then fails on the other for reasons unrelated to the change under review.
      env: { ...process.env, TZ: "UTC", NODE_V8_COVERAGE: v8CoverageDir },
    },
  );

  if (result.error) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: `coverage-gate: failed to start the test runner: ${result.error.message}`,
    };
  }

  // Surface a runner failure before touching the report at all. A failing suite,
  // an unmet threshold, or a test file that will not load can each leave the lcov
  // output absent or incomplete, and every diagnostic below would then describe a
  // coverage-configuration problem the author does not have — burying the test
  // failure they need to act on.
  if (result.status !== 0) {
    return { exitCode: result.status ?? 1, stdout: "", stderr: "" };
  }

  let reported: Set<string>;
  try {
    reported = parseLcov(lcovPath, repoRoot);
  } catch (error) {
    return { exitCode: 1, stdout: "", stderr: String(error).replace(/^Error: /, "") };
  }

  const missing = required.filter((file) => !reported.has(file));

  if (missing.length > 0) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: [
        "",
        `coverage-gate: ${missing.length} source file(s) never loaded during the run and were`,
        "omitted from the coverage report, so the reported percentages exclude them entirely:",
        ...missing.map((file) => `  - ${file}`),
        "",
        "Import each file from a test (or exercise it through the CLI entrypoint under test).",
        "A file that is genuinely type-only belongs in `coverageGate.ignore` in package.json.",
        "",
      ].join("\n"),
    };
  }

  // The Node runner enforces line, branch and function thresholds and exits
  // non-zero when any is unmet, so reaching this point means those three passed.
  // Statements are not a Node runner metric, so the gate measures them itself
  // from the raw V8 block coverage. Without this check a `statements` threshold
  // declared in package.json would be silently ignored — the gate would report
  // success having never measured the dimension it promised to enforce.
  let statementCoverage: StatementCoverage | null = null;
  if (config.thresholds.statements !== undefined) {
    statementCoverage = computeStatementCoverage(v8CoverageDir, required, repoRoot);
    if (statementCoverage.total === 0) {
      return {
        exitCode: 1,
        stdout: "",
        stderr:
          "coverage-gate: no V8 block coverage data found \u2014 cannot measure statement coverage. Ensure NODE_V8_COVERAGE is set and the test runner wrote coverage output.",
      };
    }
    if (statementCoverage.percentage < config.thresholds.statements) {
      return {
        exitCode: 1,
        stdout: "",
        stderr: [
          "",
          `coverage-gate: statement coverage ${statementCoverage.percentage.toFixed(2)}% is below the configured threshold of ${config.thresholds.statements}%.`,
          `  ${statementCoverage.total - statementCoverage.covered} of ${statementCoverage.total} V8 block(s) never entered in:`,
          ...statementCoverage.uncoveredFiles.map((file) => `  - ${file}`),
          "",
          "Add a test that exercises the uncovered branch or block.",
          "",
        ].join("\n"),
      };
    }
  }

  const totals = parseLcovTotals(lcovPath);
  const linesPct = totals.lines.found === 0 ? 100 : (totals.lines.hit / totals.lines.found) * 100;
  const branchesPct = totals.branches.found === 0 ? 100 : (totals.branches.hit / totals.branches.found) * 100;
  const functionsPct = totals.functions.found === 0 ? 100 : (totals.functions.hit / totals.functions.found) * 100;
  const statementsPct = statementCoverage ? statementCoverage.percentage : 100;
  const dimensions = [
    `lines ${linesPct.toFixed(2)}%`,
    `branches ${branchesPct.toFixed(2)}%`,
    `functions ${functionsPct.toFixed(2)}%`,
    `statements ${statementsPct.toFixed(2)}%`,
  ];

  return {
    exitCode: 0,
    stdout: `\ncoverage-gate: ${required.length} source file(s) reported, thresholds met (${dimensions.join(", ")}).`,
    stderr: "",
  };
}

/**
 * CLI entry point: read the `coverageGate` config, run the gate, and emit its result.
 *
 * @param repoRoot - Absolute repository root.
 * @param spawn - Injectable spawn function; defaults to the real `spawnSync`.
 * @param showConfig - Injectable `tsc --showConfig` runner; defaults to the real `spawnSync`.
 */
export function main(repoRoot: string, spawn: SpawnFn = defaultSpawn, showConfig: ShowConfigFn = defaultShowConfig): void {
  const manifest = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as PackageManifest;
  const result = runGate(manifest.coverageGate ?? null, repoRoot, spawn, showConfig);
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  process.exitCode = result.exitCode;
}

/** Shared gate-run contract and whether the script is direct-invoked. */
export { type GateResult, isMainInvocation } from "./script-launcher.ts";

runIfMain(process.argv, import.meta.url, main, resolve(import.meta.dirname, ".."));