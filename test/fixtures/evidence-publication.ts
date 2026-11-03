/** Publish fully certified evidence under a cooperative refresh lock, preserving conflicting edits without rollback. */
import assert from "node:assert/strict";
import { closeSync, fstatSync, lstatSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createPmCliExpectedError, EXIT_CODE } from "@unbrained/pm-cli/sdk/runtime";

/** Refuse a concurrent refresh or changed saved base with one stable typed conflict. */
function conflict(): never { throw createPmCliExpectedError("Evidence publication conflicted; retain current documents and rerun the completed refresh.", { exitCode: EXIT_CODE.CONFLICT, context: { code: "evidence_write_conflict" } }); }
/** Serialize refresh publishers, then reread each base immediately before its forward-only write. */
export function publishEvidence(root: string, bases: ReadonlyMap<string, string>, documents: ReadonlyMap<string, string>): void {
  const lock = join(root, ".public-evidence-refresh.lock");
  let fd: number;
  try { fd = openSync(lock, "wx", 0o600); } catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") conflict(); throw error; }
  try {
    for (const [file, text] of documents) {
      const current = readFileSync(join(root, file), "utf8");
      if (current !== bases.get(file) && current !== text) conflict();
    }
    for (const [file, text] of documents) {
      const target = join(root, file); const current = readFileSync(target, "utf8");
      if (current === text) continue;
      if (current !== bases.get(file)) conflict();
      writeFileSync(target, text);
    }
  } finally {
    const held = fstatSync(fd, { bigint: true }); const current = lstatSync(lock, { bigint: true, throwIfNoEntry: false });
    if (current?.dev === held.dev && current.ino === held.ino) unlinkSync(lock);
    closeSync(fd);
  }
}
/** Retain failed child output before surfacing its original failure to the orchestration driver. */
export function acceptanceLog(file: string, execute: () => string): void {
  try { writeFileSync(file, execute()); }
  catch (error) {
    const captured = error as { stdout?: string | Buffer; stderr?: string | Buffer };
    writeFileSync(file, `${captured.stdout ?? ""}${captured.stderr ?? ""}`);
    throw error;
  }
}
