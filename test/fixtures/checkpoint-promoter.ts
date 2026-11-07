/** Independent process sharing the same plain tracker, budget and artifact ledger. */
import { readFileSync } from "node:fs";
import promises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { PmClient } from "@unbrained/pm-cli/sdk/core";
import { openImproverEnvironment, IMPROVER_CRITERION } from "../../improver-environment.ts";
import type { ImproverDataset } from "../../improver-data.ts";
import type { LearnerConfig } from "../../improver.ts";

/** Monotonic evidence from actual failed and successful native lock-file opens. */
export interface CheckpointContention {
  readonly blocked_ms: number;
  readonly acquired_ms: number | null;
  readonly attempts: number;
}

/** Observe real filesystem contention without replacing the SDK or suppressing any operation. */
function observeContention(lock: string, minimumMs: number) {
  const native = promises.open;
  let started: number | undefined; let acquired: number | null = null; let attempts = 0; let reported = false;
  promises.open = async (...args: Parameters<typeof native>): ReturnType<typeof native> => {
    const target = args[0] === lock && args[1] === "wx";
    try {
      const handle = await native(...args);
      if (target && started !== undefined && acquired === null) acquired = performance.now() - started;
      return handle;
    } catch (error) {
      if (target && acquired === null && (error as NodeJS.ErrnoException).code === "EEXIST") {
        started ??= performance.now(); attempts += 1;
        const elapsed = performance.now() - started;
        if (!reported && elapsed >= minimumMs) {
          reported = true;
          process.send?.({ blocked: { blocked_ms: elapsed, acquired_ms: null, attempts } satisfies CheckpointContention });
        }
      }
      throw error;
    }
  };
  syncBuiltinESMExports();
  return {
    /** Retain the first contended acquisition even when later transactions acquire the same mutex. */
    receipt(): CheckpointContention { return { blocked_ms: started === undefined ? 0 : acquired ?? performance.now() - started, acquired_ms: acquired, attempts }; },
    /** Restore native bindings on every fixture outcome. */
    restore(): void { promises.open = native; syncBuiltinESMExports(); },
  };
}

const [file, job] = process.argv.slice(2);
const request = JSON.parse(readFileSync(file, "utf8")) as { root: string; pmRoot: string; dataset: string; manifest: ImproverDataset; approval: string; config: LearnerConfig; contention?: { minimum_ms: number; delay_ms: number } };
const client = new PmClient({ cwd: request.root, pmRoot: request.pmRoot, author: "checkpoint-test", noExtensions: true });
process.send?.({ ready: true });
await new Promise<void>((resolve) => { process.once("message", () => resolve()); });
// Delay beyond the old five-second margin to expose readiness-based release false positives.
if (request.contention !== undefined) await delay(request.contention.delay_ms);
const observed = request.contention === undefined ? undefined : observeContention(join(request.pmRoot, "locks", "sdk-workspace-transaction.lock"), request.contention.minimum_ms);
const environment = openImproverEnvironment(client, { pmRoot: request.pmRoot, author: "checkpoint-test" }, request.dataset, request.manifest, request.approval, 256, 42, IMPROVER_CRITERION);
try {
  const trial = await environment.fit("development", 0, request.config, job, null, AbortSignal.timeout(120_000));
  process.send?.({ trial, contention: observed?.receipt() });
} finally { observed?.restore(); process.disconnect?.(); }
