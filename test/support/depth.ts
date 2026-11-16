/** Run a deterministic seed prefix in quick CI; local and release defaults stay full. */
export function testDepth(full: number): number {
  return process.env.PM_TEST_DEPTH === "quick" ? Math.min(full, Math.max(25, Math.ceil(full / 10))) : full;
}

/** Keep endpoints, spread intermediate cases, and retain every declared boundary kind. */
export function testCases<T>(values: readonly T[], kinds: (value: T) => readonly string[] = () => []): T[] {
  const count = testDepth(values.length);
  if (count === values.length) return [...values];
  const selected = new Set<number>([0, values.length - 1]);
  const seen = new Set<string>();
  values.forEach((value, index) => {
    for (const kind of kinds(value)) if (!seen.has(kind)) { seen.add(kind); selected.add(index); }
  });
  // Bisect the widest remaining gap. Required kinds may exceed the depth budget.
  while (selected.size < count) {
    const ordered = [...selected].sort((a, b) => a - b);
    let left = ordered[0], right = ordered[1];
    for (let i = 1; i < ordered.length - 1; i += 1) {
      if (ordered[i + 1] - ordered[i] > right - left) { left = ordered[i]; right = ordered[i + 1]; }
    }
    selected.add(Math.floor((left + right) / 2));
  }
  return [...selected].sort((a, b) => a - b).map((index) => values[index]);
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
