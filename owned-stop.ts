/** Bounded retries for operations that retain authority over one exact child or container. */
import { setTimeout as delay } from "node:timers/promises";

/** Retry transient stop failures without retaining an in-flight latch between attempts. */
export async function retryOwnedStop(operation: () => boolean | void | Promise<boolean | void>, permanent: (error: unknown) => boolean = () => false): Promise<boolean> {
  for (const milliseconds of [0, 25, 50, 100, 200, 200]) {
    if (milliseconds > 0) await delay(milliseconds);
    try { if (await operation() !== false) return true; }
    catch (error) { if (permanent(error)) throw error; }
  }
  return false;
}

/** Bound native close acknowledgement independently of whether a kill syscall succeeded. */
export async function waitForOwnedClose(closed: Promise<void>): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([closed.then(() => true), new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), 1000); })]);
  } finally { clearTimeout(timer); }
}
