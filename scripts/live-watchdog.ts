/** Minimal process watchdog for the opt-in live suite, including SDK import and startup time. */
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { streamProcess } from "./audit-git-identities.ts";
import { isMainInvocation } from "./script-launcher.ts";

/** Maximum live command lifetime, including its termination grace period. */
export const LIVE_TIMEOUT_MS = 15 * 60 * 1000;

/** Evidence-write headroom reserved between the worker's self-imposed deadline and the parent watchdog budget. */
export const LIVE_WORKER_MARGIN_MS = 30_000;

/** Worker deadline when the parent passes no derived budget; LIVE_TIMEOUT_MS minus the evidence margin, so it still precedes the watchdog kill. */
export const LIVE_WORKER_DEADLINE_MS = LIVE_TIMEOUT_MS - LIVE_WORKER_MARGIN_MS;

/** Name of the environment variable the watchdog uses to hand the derived worker deadline to the live worker. */
export const LIVE_WORKER_TIMEOUT_ENV = "PM_LIVE_WORKER_TIMEOUT_MS";

/**
 * Split a live budget into the watchdog kill time and the worker's own deadline.
 *
 * The worker must stop itself before the watchdog kills it, or a deadline stop
 * cannot retain failure evidence. The worker deadline is the budget minus the
 * evidence margin; budgets that leave no positive deadline are refused instead
 * of launching a worker the watchdog would kill mid-write.
 *
 * @param timeoutMs - Requested total live command budget in milliseconds.
 * @returns The SIGKILL escalation grace and the derived worker deadline.
 */
export function liveWatchdogBudget(timeoutMs: number): { graceMs: number; workerDeadlineMs: number } {
  assert.ok(Number.isInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= LIVE_TIMEOUT_MS, "Live deadline must be within 15 minutes");
  const graceMs = Math.min(5000, Math.floor(timeoutMs / 2));
  const workerDeadlineMs = timeoutMs - LIVE_WORKER_MARGIN_MS;
  assert.ok(workerDeadlineMs > 0, `Live deadline must exceed the ${LIVE_WORKER_MARGIN_MS} ms worker evidence margin`);
  assert.ok(timeoutMs - graceMs - workerDeadlineMs >= 10_000, "Live deadline must leave at least 10 s between the worker deadline and the watchdog kill");
  return { graceMs, workerDeadlineMs };
}

/** Launch a bounded worker and stream its transcript; a stalled SDK cannot outlive the parent deadline. */
export async function runLiveCommand(environment: NodeJS.ProcessEnv, emit: (chunk: Buffer) => void, timeoutMs = LIVE_TIMEOUT_MS): Promise<void> {
  const { graceMs, workerDeadlineMs } = liveWatchdogBudget(timeoutMs);
  await streamProcess(process.execPath, [resolve(import.meta.dirname, "live-systemone.ts")], {
    cwd: resolve(import.meta.dirname, ".."),
    env: { ...environment, [LIVE_WORKER_TIMEOUT_ENV]: String(workerDeadlineMs) },
    timeoutMs: timeoutMs - graceMs, escalationMs: graceMs,
  }, emit);
}

if (isMainInvocation(process.argv, import.meta.url)) await runLiveCommand(process.env, (chunk) => { process.stdout.write(chunk); });
