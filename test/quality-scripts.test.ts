/**
 * Behavioral coverage for release-quality scripts that operate outside the extension host.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

import eslintConfig from "../scripts/eslint.config.ts";
import { isMainInvocation as docstringIsMain, main as docstringMain, runGate as docstringRunGate } from "../scripts/docstring-gate.ts";
import { isExecutableFile, isMainInvocation as prepareIsMain, main as prepareMain, pmOnPath } from "../scripts/prepare-merge-driver.ts";
import { runIfMain } from "../scripts/script-launcher.ts";

/** Creates an executable Node fixture and returns its path. */
function executableFixture(root: string, body: string, name = "fixture.ts"): string {
  const path = join(root, name);
  writeFileSync(path, `#!/usr/bin/env node\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

test("ESLint configuration applies every mandatory TypeScript syntax prohibition", () => {
  const configured = eslintConfig.find((entry) => entry.files?.includes("**/*.ts"));
  assert.ok(configured?.languageOptions?.parser);
  const restrictions = configured.rules?.["no-restricted-syntax"];
  assert.ok(Array.isArray(restrictions));
  const selectors = new Set(restrictions.slice(1).map((entry) =>
    typeof entry === "object" && entry !== null && "selector" in entry ? entry.selector : ""));
  assert.deepEqual(selectors, new Set([
    "TSAnyKeyword",
    "ImportExpression",
    "TSImportType",
    "TSParameterProperty",
    "TSEnumDeclaration",
    "TSModuleDeclaration",
    "TSImportEqualsDeclaration",
    "TSExportAssignment",
  ]));
});

test("ESLint configuration ignores coverage, dist, and node_modules", () => {
  const ignoreEntry = eslintConfig.find((entry) => entry.ignores !== undefined);
  assert.ok(ignoreEntry?.ignores);
  assert.deepEqual(new Set(ignoreEntry.ignores), new Set(["coverage/**", "dist/**", "node_modules/**"]));
});

test("ESLint configuration enforces eqeqeq and prefer-const", () => {
  const configured = eslintConfig.find((entry) => entry.files?.includes("**/*.ts"));
  assert.ok(configured, "TypeScript rule block must be configured");
  assert.deepEqual(configured.rules?.eqeqeq, ["error", "always"]);
  assert.equal(configured.rules?.["prefer-const"], "error");
});

test("merge-driver preparation distinguishes absence, invalid candidates and an executable PM", () => {
  const root = mkdtempSync(join(tmpdir(), "pm-rl-prepare-"));
  try {
    const directory = join(root, "pm");
    mkdirSync(directory);
    assert.equal(isExecutableFile(directory, "linux"), false);
    assert.equal(isExecutableFile(join(root, "absent"), "linux"), false);
    const nonExecutable = executableFixture(root, "process.exit(0);", "not-pm");
    chmodSync(nonExecutable, 0o644);
    assert.equal(isExecutableFile(nonExecutable, "linux"), false);
    assert.equal(isExecutableFile(nonExecutable, "win32"), true);
    assert.equal(pmOnPath({ PATH: "" }, "win32"), null);
    assert.equal(pmOnPath({}, "linux"), null);
    assert.equal(pmOnPath({ PATH: '"' + root + '"', PATHEXT: ".CMD;.EXE" }, "win32"), null);
    assert.equal(prepareMain({ PATH: "" }, "linux"), false);

    rmSync(directory, { recursive: true });
    const marker = join(root, "called");
    executableFixture(root, `
if (process.argv.slice(2).join(" ") !== "merge install") process.exit(8);
require("node:fs").writeFileSync(${JSON.stringify(marker)}, "yes");`, "pm");
    const fixturePath = `${root}:${dirname(process.execPath)}`;
    assert.equal(pmOnPath({ PATH: fixturePath }, "linux"), join(root, "pm"));
    assert.equal(prepareMain({ PATH: fixturePath }, "linux"), true);

    const windowsShim = executableFixture(root, "process.exit(0);", "pm.CMD");
    const windowsEnvironment = { PATH: `"${root}"`, PATHEXT: ".CMD;.EXE" };
    assert.equal(
      pmOnPath(windowsEnvironment, "win32"),
      windowsShim,
    );
    let windowsShell = false;
    assert.equal(prepareMain(windowsEnvironment, "win32", (executable, arguments_, options) => {
      // With shell:true on Windows the executable path is quoted before it
      // crosses the cmd.exe boundary, so a directory name containing a space
      // is not split into arguments.
      assert.equal(executable, `"${windowsShim}"`);
      assert.deepEqual(arguments_, ["merge", "install"]);
      windowsShell = options.shell;
    }), true);
    assert.equal(windowsShell, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("prepare-merge-driver quotes a Windows shim resolved from a directory whose name contains a space", () => {
  // execFileSync with shell:true hands cmd.exe a single command line and does
  // not quote the executable path itself, so a shim under a directory such as
  // `Program Files` would be split at the space. Discovery resolves the real
  // path; main must then quote it before invoking the shell.
  const root = mkdtempSync(join(tmpdir(), "pm-rl-prepare-space-"));
  try {
    const spaced = join(root, "Program Files");
    mkdirSync(spaced, { recursive: true });
    const shim = executableFixture(spaced, "process.exit(0);", "pm.CMD");
    const environment = { PATH: `"${spaced}"`, PATHEXT: ".CMD;.EXE" };
    assert.equal(pmOnPath(environment, "win32"), shim);
    let received: string | null = null;
    assert.equal(prepareMain(environment, "win32", (executable) => {
      received = executable;
    }), true);
    assert.equal(received, `"${shim}"`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("prepare-merge-driver isMainInvocation resolves matching and non-matching scripts", () => {
  const root = mkdtempSync(join(tmpdir(), "pm-rl-prepare-main-"));
  try {
    const script = join(root, "prepare-merge-driver.ts");
    const other = join(root, "other.ts");
    writeFileSync(script, "");
    writeFileSync(other, "");
    const url = pathToFileURL(script).href;
    assert.equal(prepareIsMain([process.execPath, script], url), true);
    assert.equal(prepareIsMain([process.execPath, other], url), false);
    assert.equal(prepareIsMain([process.execPath], url), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("docstring gate runGate returns success for the real repository root", () => {
  const root = resolve(import.meta.dirname, "..");
  const result = docstringRunGate(root);
  assert.equal(result.exitCode, 0, result.stderr);
  assert.match(result.stdout, /docstring-gate:.*file\(s\).*documented/);
  assert.equal(result.stderr, "");
});

test("docstring gate runGate reports violations for an undocumented source", () => {
  const root = mkdtempSync(join(tmpdir(), "pm-rl-docstring-"));
  try {
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "a.ts"), "export function undocumented(): void {}\n");
    const result = docstringRunGate(root);
    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /undocumented: no docstring/);
    assert.equal(result.stdout, "");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("docstring gate main writes results to streams and sets the exit code", () => {
  const root = mkdtempSync(join(tmpdir(), "pm-rl-docstring-main-"));
  try {
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "a.ts"), "export function undocumented(): void {}\n");
    const originalExitCode = process.exitCode;
    const originalStdoutWrite = process.stdout.write.bind(process.stdout);
    const originalStderrWrite = process.stderr.write.bind(process.stderr);
    let stdout = "";
    let stderr = "";
    process.stdout.write = ((chunk: string | Uint8Array): boolean => {
      stdout += chunk.toString();
      return true;
    }) as typeof process.stdout.write;
    process.stderr.write = ((chunk: string | Uint8Array): boolean => {
      stderr += chunk.toString();
      return true;
    }) as typeof process.stderr.write;
    process.exitCode = undefined;
    let observedExitCode: number | string | undefined;
    try {
      docstringMain(root);
    } finally {
      observedExitCode = process.exitCode;
      process.stdout.write = originalStdoutWrite;
      process.stderr.write = originalStderrWrite;
      process.exitCode = originalExitCode;
    }
    assert.equal(observedExitCode, 1);
    assert.equal(stdout, "");
    assert.match(stderr, /undocumented: no docstring/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("docstring gate isMainInvocation resolves matching and non-matching scripts", () => {
  const root = mkdtempSync(join(tmpdir(), "pm-rl-docstring-main-invocation-"));
  try {
    const script = join(root, "docstring-gate.ts");
    const other = join(root, "other.ts");
    writeFileSync(script, "");
    writeFileSync(other, "");
    const url = pathToFileURL(script).href;
    assert.equal(docstringIsMain([process.execPath, script], url), true);
    assert.equal(docstringIsMain([process.execPath, other], url), false);
    assert.equal(docstringIsMain([process.execPath], url), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runIfMain forwards arguments only when the module is invoked directly", () => {
  // runIfMain replaces the per-script array-index dispatch. The main branch
  // invokes run with the forwarded arguments; the import branch does not, so
  // `run` is covered by the tests that call it directly.
  const root = mkdtempSync(join(tmpdir(), "pm-rl-runifmain-"));
  try {
    const script = join(root, "launcher.ts");
    const other = join(root, "other.ts");
    writeFileSync(script, "");
    writeFileSync(other, "");
    const url = pathToFileURL(script).href;
    const received: number[] = [];
    runIfMain([process.execPath, script], url, (value: number) => { received.push(value); }, 7);
    assert.deepEqual(received, [7]);
    runIfMain([process.execPath, other], url, (value: number) => { received.push(value); }, 9);
    assert.deepEqual(received, [7]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("docstring gate main writes a success line to stdout and exits 0", () => {
  // The real repository is fully documented, so main() takes the success path:
  // non-empty stdout is terminated with a newline and exitCode stays 0. This
  // covers the stdout-newline branch the violation-only main test cannot.
  const root = resolve(import.meta.dirname, "..");
  const originalExitCode = process.exitCode;
  const originalStdoutWrite = process.stdout.write.bind(process.stdout);
  let stdout = "";
  process.stdout.write = ((chunk: string | Uint8Array): boolean => {
    stdout += chunk.toString();
    return true;
  }) as typeof process.stdout.write;
  process.exitCode = undefined;
  let observedExitCode: number | string | undefined;
  try {
    docstringMain(root);
  } finally {
    observedExitCode = process.exitCode;
    process.stdout.write = originalStdoutWrite;
    process.exitCode = originalExitCode;
  }
  assert.equal(observedExitCode, 0);
  assert.match(stdout, /docstring-gate:.*documented\.\n$/);
});

test("docstring gate isMainInvocation throws rather than skipping the gate when a path cannot be resolved", () => {
  const root = mkdtempSync(join(tmpdir(), "pm-rl-docstring-unresolvable-"));
  try {
    const script = join(root, "docstring-gate.ts");
    writeFileSync(script, "");
    const url = pathToFileURL(script).href;
    // Returning false here would make the caller treat the script as a library
    // import and skip main, so a required release check exits 0 having done
    // nothing. Crashing is the safe outcome, so assert it is what happens.
    assert.throws(
      () => docstringIsMain([process.execPath, join(root, "does-not-exist.ts")], url),
      /ENOENT/,
      "an unresolvable entry must propagate, not silently decline to run the gate",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the packed tarball can actually be imported, so no reachable module is left unpublished", () => {
  // `pack:dry-run` lists file NAMES; it never resolves an import. That is how a
  // package whose entry point imports a module the `files` array omits passes
  // `release:check` and then fails at import time for anyone who installs it —
  // which happened here once, with `dist/lineage.js` absent from the tarball.
  //
  // This deliberately does NOT parse imports. The previous form walked the graph
  // with a regex matching only double-quoted `from "./x.js"`, so `../` paths,
  // single quotes, side-effect imports and dynamic `import()` all evaded it, and
  // a module reachable through any of those could stay unpublished with the gate
  // green. Regex is not a parser, and the repo pins a TypeScript whose compiler
  // API is unavailable at runtime, so there is no parser to reach for either.
  //
  // Enumerating emitted modules instead does not work: the build also emits
  // `dist/scripts/**`, which is release tooling that is correctly unpublished.
  //
  // So this asserts the property directly rather than approximating it. The real
  // tarball is packed, extracted, and imported. Node resolves the graph, so
  // every import form is covered by construction, and a missing module fails as
  // ERR_MODULE_NOT_FOUND. Extraction happens INSIDE the repo so that the
  // extracted entry point resolves `@unbrained/pm-cli` up the directory chain
  // through the repo's own node_modules, exactly as an installed copy would.
  const repoRoot = resolve(import.meta.dirname, "..");
  const scratch = mkdtempSync(join(repoRoot, ".pack-import-"));
  try {
    const packed = execFileSync(process.platform === "win32" ? "npm.cmd" : "npm", ["pack", "--silent", "--pack-destination", scratch], { cwd: repoRoot, encoding: "utf8", shell: process.platform === "win32" }).trim().split("\n").pop()!;
    execFileSync("tar", ["-xzf", join(scratch, packed), "-C", scratch]);
    const entry = join(scratch, "package", "dist", "index.js");
    // Imported in a CHILD process, not this one. A dynamic import is the only
    // way to load a path computed at runtime, and this repo forbids them; a
    // child also keeps a second copy of the extension - which registers item
    // types on load - out of the test process. Importing IS the assertion: a
    // `files` array omitting any reachable module makes it exit non-zero with
    // ERR_MODULE_NOT_FOUND. The marker confirms the entry produced the
    // extension definition, so a silently empty module cannot pass as success.
    const probe = execFileSync(process.execPath, ["--input-type=module", "-e", `const m = await import(${JSON.stringify(pathToFileURL(entry).href)}); if (m.default === undefined) { console.error("no default export"); process.exit(2); } console.log("packed-entry-imported");`], { cwd: scratch, encoding: "utf8" });
    assert.match(probe, /packed-entry-imported/, "the packed entry point must import and export the extension definition");
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
