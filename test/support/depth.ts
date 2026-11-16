/** Run a deterministic seed prefix in quick CI; local and release defaults stay full. */
export function testDepth(full: number): number {
  return process.env.PM_TEST_DEPTH === "quick" ? Math.min(full, Math.max(25, Math.ceil(full / 10))) : full;
}

// Validate on import, before callers can launch any worker or subprocess.
const scale = Number(process.env.PM_TEST_TIME_SCALE ?? "1");
if (!Number.isFinite(scale) || scale <= 0) throw new Error("PM_TEST_TIME_SCALE must be finite and greater than zero");

/** Scale harness watchdogs only. Product deadlines and resource allowances stay unchanged. */
export function testTime(milliseconds: number): number {
  const scaled = Math.ceil(milliseconds * scale);
  if (!Number.isSafeInteger(scaled) || scaled < 1 || scaled > 2_147_483_647) throw new Error("Invalid scaled harness timeout");
  return scaled;
}
