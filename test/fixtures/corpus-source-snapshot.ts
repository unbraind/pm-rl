/** Durable source snapshots shared by corpus publication and non-Git acceptance tests. */
import { readFileSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { hashJson } from "../../index.ts";

/** Hash sorted relative filenames and exact bytes, excluding only SDK runtime state. */
export function sourceBytes(pmRoot: string): string {
  const runtimeRoots = new Set(["runtime", "locks", "transactions", "checkpoints"]);
  return hashJson(readdirSync(pmRoot, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => {
      const absolute = join(entry.parentPath, entry.name);
      return [relative(pmRoot, absolute), absolute] as const;
    })
    .filter(([path]) => !runtimeRoots.has(path.split(sep)[0]) &&
      (path.split(sep)[0] !== "search" || path === join("search", "eval-queries.json")))
    .sort(([left], [right]) => left < right ? -1 : 1)
    .map(([path, absolute]) => [path, readFileSync(absolute, "hex")]));
}
