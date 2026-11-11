/** Public replay hashes and member cutoffs use code-point rather than host locale ordering. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { selectReplayItems, trackerDigest } from "./fixtures/replay-order.ts";

test("public replay preserves code-point traversal and the 64-member cutoff", () => {
  const root = mkdtempSync(join(tmpdir(), "rl-replay-order-"));
  try {
    const names = ["Z.json", "a.json", "nested/Z.toon", "nested/a.toon"];
    mkdirSync(join(root, "nested"));
    for (const name of names) writeFileSync(join(root, name), name);
    mkdirSync(join(root, "runtime")); writeFileSync(join(root, "runtime/cache.json"), "excluded");
    writeFileSync(join(root, "unrelated.txt"), "excluded");
    const expected = createHash("sha256");
    for (const name of names) expected.update(name).update(name);
    assert.equal(trackerDigest(root), expected.digest("hex"), "public digest must use code-point traversal");
    const items = [...Array.from({ length: 63 }, (_, n) => ({ id: `0-${String(n).padStart(2, "0")}` })), { id: "a" }, { id: "Z" }];
    const snapshot = [...items];
    assert.deepEqual(selectReplayItems(items).map(item => item.id), [...snapshot.slice(0, 63).map(item => item.id), "Z"]);
    assert.deepEqual(items, snapshot);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
