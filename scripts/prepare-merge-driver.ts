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

import { isMainInvocation, runIfMain } from "./script-launcher.ts";

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
  // With `shell: true` on Windows, execFileSync hands cmd.exe a single command
  // line and Node does not quote the executable path itself, so a shim under a
  // directory whose name contains a space (e.g. `C:\Program Files\...\.CMD`)
  // is split at the space and the merge-driver install fails during npm
  // install. Discovery already validated this exact path, so quoting it before
  // it crosses the command-shell boundary is safe and keeps the POSIX path
  // (no shell) untouched.
  const shell = platform === "win32";
  install(shell ? `"${executable}"` : executable, ["merge", "install"], {
    stdio: "inherit",
    env: environment,
    shell,
  });
  return true;
}

/** Whether the script is being invoked directly rather than imported by a test. */
export { isMainInvocation } from "./script-launcher.ts";

runIfMain(process.argv, import.meta.url, main, process.env, process.platform);