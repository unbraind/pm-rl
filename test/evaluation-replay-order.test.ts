/** Public replay hashes and member cutoffs use code-point rather than host locale ordering. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { commitTrackerDigest, selectReplayItems, trackerDigest, verifySourceCommit } from "./fixtures/replay-order.ts";

test("public replay preserves code-point traversal and the 64-member cutoff", () => {
  const root = mkdtempSync(join(tmpdir(), "rl-replay-order-"));
  try {
    const names = ["Z.json", "a.json", "nested/Z.toon", "nested/a.toon"];
    mkdirSync(join(root, "nested"));
    for (const name of names) writeFileSync(join(root, name), name);
    mkdirSync(join(root, "runtime")); writeFileSync(join(root, "runtime/cache.json"), "excluded");
    writeFileSync(join(root, "unrelated.txt"), "excluded");
    const expected = createHash("sha256");
    for (const name of names) expected.update(`${name.length}:${name}${name.length}:${name}`);
    assert.equal(trackerDigest(root), expected.digest("hex"), "public digest must use code-point traversal");
    const items = [...Array.from({ length: 63 }, (_, n) => ({ id: `0-${String(n).padStart(2, "0")}` })), { id: "a" }, { id: "Z" }];
    const snapshot = [...items];
    assert.deepEqual(selectReplayItems(items).map(item => item.id), [...snapshot.slice(0, 63).map(item => item.id), "Z"]);
    assert.deepEqual(items, snapshot);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("the tracker digest separates file names from file contents", () => {
  const joined = mkdtempSync(join(tmpdir(), "rl-digest-joined-")), split = mkdtempSync(join(tmpdir(), "rl-digest-split-"));
  try {
    // Unframed, both trees hash the bytes "a.jsonb.json".
    writeFileSync(join(joined, "a.json"), "b.json");
    writeFileSync(join(split, "a.json"), ""); writeFileSync(join(split, "b.json"), "");
    assert.notEqual(trackerDigest(joined), trackerDigest(split));
    // Must allow: identical trees still share one digest.
    const copy = mkdtempSync(join(tmpdir(), "rl-digest-copy-"));
    try { cpSync(joined, copy, { recursive: true }); assert.equal(trackerDigest(copy), trackerDigest(joined)); }
    finally { rmSync(copy, { recursive: true, force: true }); }
  } finally { rmSync(joined, { recursive: true, force: true }); rmSync(split, { recursive: true, force: true }); }
});

test("a replay source is attributed only to the commit whose tracker it is", () => {
  const repo = mkdtempSync(join(tmpdir(), "rl-source-commit-")), source = mkdtempSync(join(tmpdir(), "rl-source-copy-"));
  const git = (...args: string[]): string => execFileSync("git", ["-C", repo, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", ...args], { encoding: "utf8" }).trim();
  try {
    git("init", "-q");
    mkdirSync(join(repo, ".agents/pm/issues"), { recursive: true });
    writeFileSync(join(repo, ".agents/pm/issues/a.toon"), "first");
    git("add", "."); git("commit", "-qm", "first");
    const first = git("rev-parse", "HEAD");
    writeFileSync(join(repo, ".agents/pm/issues/a.toon"), "second");
    git("commit", "-qam", "second");
    const second = git("rev-parse", "HEAD");
    cpSync(join(repo, ".agents/pm"), source, { recursive: true });
    // Must allow: the copy is exactly the second commit's tracker.
    assert.equal(verifySourceCommit(repo, source, second), trackerDigest(source));
    assert.equal(commitTrackerDigest(repo, second), trackerDigest(source));
    // Must refuse: a caller naming another real commit, a modified copy, and a short SHA.
    assert.throws(() => verifySourceCommit(repo, source, first), /not the \.agents\/pm tree of/);
    writeFileSync(join(source, "issues/a.toon"), "edited");
    assert.throws(() => verifySourceCommit(repo, source, second), /not the \.agents\/pm tree of/);
    assert.throws(() => verifySourceCommit(repo, source, second.slice(0, 7)), /full 40-character SHA/);
  } finally { rmSync(repo, { recursive: true, force: true }); rmSync(source, { recursive: true, force: true }); }
});
