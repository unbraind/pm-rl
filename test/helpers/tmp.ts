/**
 * Lightweight temporary directories for script tests.
 *
 * Each test stands up a real directory and tears it down afterwards. Nothing
 * is mocked: mocking the filesystem would assert against the mock, not
 * against the real path resolution the scripts use.
 */

import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Creates a fresh empty directory and returns a cleanup handle.
 *
 * @returns The absolute path and a removal function.
 */
export function makeTempDir(): { root: string; cleanup(): void } {
  // Canonicalized, because the scripts' containment checks use `resolve`/`relative`
  // rather than a filesystem canonicalization, and a temp root that is a symlink —
  // `/var/folders/...` for `/private/var/folders/...` on macOS — would make a path
  // inside the repository look like a path outside it.
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pm-rl-test-")));
  return {
    root,
    cleanup(): void {
      rmSync(root, { recursive: true, force: true });
    },
  };
}