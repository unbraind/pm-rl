/** Disposable verification owns its directory and always removes it, including partially initialized runs. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Retained live evidence uses caller-owned trackers; disposable CLI/revert checks use this cleanup boundary. */
export async function withTransferScratch<T>(prefix: string, operation: (scratch: string) => Promise<T>): Promise<T> {
  const scratch = mkdtempSync(join(tmpdir(), prefix));
  try { return await operation(scratch); }
  finally { rmSync(scratch, { recursive: true, force: true }); }
}
