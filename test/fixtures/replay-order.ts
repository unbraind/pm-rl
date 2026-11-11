/** Locale-independent public replay identity and member selection. */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

/** Hash authoritative public records only; SDK caches are disposable derived state. */
export function trackerDigest(root: string): string {
  const hash = createHash("sha256");
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
      const path = join(directory, entry.name);
      if (entry.isDirectory() && !["runtime", "locks", "search", "transactions"].includes(entry.name)) visit(path);
      if (entry.isFile() && /\.(toon|jsonl|json)$/.test(entry.name)) hash.update(relative(root, path)).update(readFileSync(path));
    }
  };
  visit(root); return hash.digest("hex");
}

/** Select the same first 64 canonical IDs on every host without mutating the input. */
export function selectReplayItems<T extends { id: string }>(items: readonly T[]): T[] {
  return [...items].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0).slice(0, 64);
}
