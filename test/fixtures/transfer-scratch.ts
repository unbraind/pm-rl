/** Disposable verification owns its directory and always removes it, including partially initialized runs. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

/** Retry only bounded transient directory races from recently exited consumers, without hiding permanent IO failures. */
async function removeTransferScratch(scratch: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try { rmSync(scratch, { recursive: true, force: true }); return; }
    catch (error) {
      if (attempt >= 5 || !["ENOTEMPTY", "EBUSY"].includes(String((error as NodeJS.ErrnoException | undefined)?.code))) throw error;
      await delay(50 * (attempt + 1));
    }
  }
}
/** Retained live evidence uses caller-owned trackers; disposable CLI/revert checks use this cleanup boundary. */
export async function withTransferScratch<T>(prefix: string, operation: (scratch: string) => Promise<T>): Promise<T> {
  const scratch = mkdtempSync(join(tmpdir(), prefix));
  let outcome: { ok: true; value: T } | { ok: false; error: unknown };
  try { outcome = { ok: true, value: await operation(scratch) }; }
  catch (error) { outcome = { ok: false, error }; }
  try { await removeTransferScratch(scratch); }
  catch (cleanupError) {
    if (!outcome.ok) throw new AggregateError([outcome.error, cleanupError], "Transfer scratch operation and cleanup both failed.");
    throw cleanupError;
  }
  if (!outcome.ok) throw outcome.error;
  return outcome.value;
}
