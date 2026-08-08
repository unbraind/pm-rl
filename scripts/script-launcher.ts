/**
 * Shared launcher detection for operational scripts.
 *
 * Every script that guards its top-level execution behind an "am I the main
 * module?" check uses this one resolver, so the symlink-aware path comparison
 * is defined once rather than copied across scripts. A script imports
 * {@link isMainInvocation} and re-exports it so its own test can exercise the
 * guard without reaching into this shared module directly.
 */

import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";

/**
 * Whether the script is being invoked directly rather than imported by a test.
 *
 * Compares resolved real paths, not the invoked spelling. `import.meta.url` is
 * already symlink-resolved, so a launcher that reaches a file through a symlink
 * (an npm bin shim, a linked workspace) would otherwise compare unequal and
 * silently skip `main` — a release script that no-ops without erroring is worse
 * than one that throws. Fail closed if the entry path cannot be resolved at all.
 *
 * @param argv - The process argv slice to inspect.
 * @param moduleUrl - The `import.meta.url` of the module that might be main.
 * @returns True when `argv[1]` resolves to this module's own URL.
 */
export function isMainInvocation(argv: readonly string[], moduleUrl: string): boolean {
  const entry = argv[1];
  if (entry === undefined) return false;
  try {
    return pathToFileURL(realpathSync(entry)).href === moduleUrl;
  } catch {
    return false;
  }
}