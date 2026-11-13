/** Locale-independent public replay identity and member selection. */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

/** Hash authoritative public records only; SDK caches are disposable derived state. Each path and body is
 * length-prefixed, so moving bytes between a file name and file contents always changes the digest. */
export function trackerDigest(root: string): string {
  const hash = createHash("sha256");
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
      const path = join(directory, entry.name);
      if (entry.isDirectory() && !["runtime", "locks", "search", "transactions"].includes(entry.name)) visit(path);
      if (entry.isFile() && /\.(toon|jsonl|json)$/.test(entry.name)) {
        const name = Buffer.from(relative(root, path)), body = readFileSync(path);
        hash.update(`${name.length}:`).update(name).update(`${body.length}:`).update(body);
      }
    }
  };
  visit(root); return hash.digest("hex");
}

/** Digest the `.agents/pm` tree of `commit` in the Git repository `repo`, extracted with `git archive`. */
export function commitTrackerDigest(repo: string, commit: string): string {
  const archive = spawnSync("git", ["-C", repo, "archive", "--format=tar", commit, ".agents/pm"], { maxBuffer: 1024 * 1024 * 1024 });
  if (archive.status !== 0) throw new Error(`Commit ${commit} has no readable .agents/pm tree: ${String(archive.stderr)}`);
  const scratch = mkdtempSync(join(tmpdir(), "rl-commit-tracker-"));
  try {
    const extract = spawnSync("tar", ["-x", "-C", scratch], { input: archive.stdout, maxBuffer: 1024 * 1024 });
    if (extract.status !== 0) throw new Error(`Could not extract the .agents/pm tree of ${commit}: ${String(extract.stderr)}`);
    return trackerDigest(join(scratch, ".agents/pm"));
  } finally { rmSync(scratch, { recursive: true, force: true }); }
}

/** Refuse a source copy whose records are not exactly the named commit's tracker, so a receipt never attributes them to another commit. */
export function verifySourceCommit(repo: string, source: string, commit: string): string {
  if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error("The source commit must be a full 40-character SHA");
  const digest = trackerDigest(source);
  if (commitTrackerDigest(repo, commit) !== digest) throw new Error(`The source records are not the .agents/pm tree of ${commit}`);
  return digest;
}

/** Select the same first 64 canonical IDs on every host without mutating the input. */
export function selectReplayItems<T extends { id: string }>(items: readonly T[]): T[] {
  return [...items].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0).slice(0, 64);
}
