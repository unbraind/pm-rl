/** Revert receipts are tracked evidence: never overwrite uncommitted edits, and measure the reviewed worktree. */
import { execFileSync } from "node:child_process";

/**
 * Refuse to regenerate a receipt that has uncommitted edits.
 * @param repository - Repository checkout that tracks the receipt.
 * @param receipt - Repository-relative receipt path.
 */
export function refuseChangedReceipt(repository: string, receipt: string): void {
  const status = execFileSync("git", ["status", "--porcelain=v1", "--", receipt], { cwd: repository, encoding: "utf8" });
  if (status !== "") throw new Error(`${receipt} has uncommitted edits; commit or discard them before regenerating the receipt.`);
}

/**
 * Snapshot every tracked and untracked change outside the receipt, so "unchanged" is measured rather than asserted.
 * @param repository - Repository checkout the revert run reviews.
 * @param receipt - Repository-relative receipt path the run itself rewrites.
 * @returns Porcelain status of the worktree excluding the receipt.
 */
export function worktreeState(repository: string, receipt: string): string {
  return execFileSync("git", ["status", "--porcelain=v1", "--untracked-files=all", "--", ".", `:(exclude)${receipt}`], { cwd: repository, encoding: "utf8" });
}
