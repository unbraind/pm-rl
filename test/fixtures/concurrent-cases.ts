/** Execute isolated real-tracker cases with two cooperative workers and drain both before reporting failure. */
export async function concurrentCases<T>(values: readonly T[], execute: (value: T) => Promise<void>): Promise<void> {
  let next = 0; const admission = new AbortController();
  /** Stop admitting cases after a failure while allowing already-started cleanup to finish. */
  async function worker(): Promise<void> {
    while (!admission.signal.aborted && next < values.length) {
      const value = values[next++];
      try { await execute(value); } catch (error) { admission.abort(); throw error; }
    }
  }
  const results = await Promise.allSettled([worker(), worker()]);
  for (const result of results) if (result.status === "rejected") throw result.reason;
}
