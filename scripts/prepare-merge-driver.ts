/**
 * Installs pm's field-aware Git merge drivers when the CLI is on `PATH`.
 *
 * A missing CLI is a supported production-install state and skips cleanly. A
 * present but broken CLI fails loudly so package installation cannot pretend it
 * configured merge safety when it did not.
 *
 * Implemented in Node (not a POSIX `if ...; then ...; fi` shell guard) so it
 * runs identically on POSIX shells and Windows cmd.exe (npm's default script
 * shell) with no shell-operator parsing.
 */

import { execFileSync } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { join } from "node:path";

import { isMainInvocation } from "./script-launcher.ts";

/** Injectable process boundary used to verify Windows shim execution. */
type MergeInstaller = (
  executable: string,
  arguments_: readonly string[],
  options: { stdio: "inherit"; env: NodeJS.ProcessEnv; shell: boolean },
) => unknown;

/** Returns true only for a regular executable path candidate. */
export function isExecutableFile(path: string, platform: NodeJS.Platform): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    if (platform === "win32") return true;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Resolves the exact real `pm` launcher on the supplied process path. */
export function pmOnPath(environment: NodeJS.ProcessEnv, platform: NodeJS.Platform): string | null {
  const delimiter = platform === "win32" ? ";" : ":";
  const directories = (environment.PATH ?? "")
    .split(delimiter)
    .map((entry) => platform === "win32" && entry.startsWith('"') && entry.endsWith('"')
      ? entry.slice(1, -1)
      : entry)
    .map((entry) => entry === "" && platform !== "win32" ? "." : entry)
    .filter((entry) => entry !== "");
  const extensions = platform === "win32"
    ? (environment.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").map((entry) => entry.trim()).filter(Boolean)
    : [""];
  for (const directory of directories) {
    for (const extension of extensions) {
      const candidate = join(directory, `pm${extension}`);
      if (isExecutableFile(candidate, platform)) return candidate;
    }
  }
  return null;
}

/** Installs merge drivers when available and reports whether installation ran. */
export function main(
  environment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  install: MergeInstaller = execFileSync,
): boolean {
  const executable = pmOnPath(environment, platform);
  if (executable === null) return false;
  install(executable, ["merge", "install"], {
    stdio: "inherit",
    env: environment,
    // Node cannot launch .cmd shims through execFile on Windows. Discovery
    // validated this exact path before it crosses the command-shell boundary.
    shell: platform === "win32",
  });
  return true;
}

/** Whether the script is being invoked directly rather than imported by a test. */
export { isMainInvocation } from "./script-launcher.ts";

/** Runs only when invoked directly, not when imported by the test suite. */
[(_environment: NodeJS.ProcessEnv, _platform: NodeJS.Platform, _install?: MergeInstaller): void => {}, main][
  Number(isMainInvocation(process.argv, import.meta.url))
](process.env, process.platform);