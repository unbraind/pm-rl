/** Minimal process watchdog for the opt-in live suite, including SDK import and startup time. */
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { streamProcess } from "./audit-git-identities.ts";
import { isMainInvocation } from "./script-launcher.ts";

/** Maximum live command lifetime, including its termination grace period. */
export const LIVE_TIMEOUT_MS = 15 * 60 * 1000;

/** Launch a bounded worker and stream its transcript; a stalled SDK cannot outlive the parent deadline. */
export async function runLiveCommand(environment: NodeJS.ProcessEnv, emit: (chunk: Buffer) => void, timeoutMs = LIVE_TIMEOUT_MS): Promise<void> {
  assert.ok(Number.isInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= LIVE_TIMEOUT_MS, "Live deadline must be within 15 minutes");
  const graceMs = Math.min(5000, Math.floor(timeoutMs / 2));
  await streamProcess(process.execPath, [resolve(import.meta.dirname, "live-systemone.ts")], {
    cwd: resolve(import.meta.dirname, ".."), env: environment,
    timeoutMs: timeoutMs - graceMs, escalationMs: graceMs,
  }, emit);
}

if (isMainInvocation(process.argv, import.meta.url)) await runLiveCommand(process.env, (chunk) => { process.stdout.write(chunk); });
