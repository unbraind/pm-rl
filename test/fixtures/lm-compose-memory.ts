/** Exercise the physical memory guard while keeping PID 1 alive until Docker's real OOM evidence is observed. */
import { Buffer } from "node:buffer";
import { spawn } from "node:child_process";
import { appendFileSync, closeSync, existsSync, fsyncSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { setTimeout } from "node:timers/promises";
import { getHeapStatistics } from "node:v8";

/** Publish bounded fixture evidence before a process can be killed by its container's memory guard. */
function marker(name: string, value: Record<string, number | string | boolean | null>): void {
  const handle = openSync(name, "wx");
  try { writeFileSync(handle, JSON.stringify(value)); fsyncSync(handle); }
  finally { closeSync(handle); }
}

if (process.argv[2] === "allocate") {
  // Prefer the allocating child over the idle supervisor as the kernel's victim; the memory ceiling is unchanged.
  writeFileSync("/proc/self/oom_score_adj", "1000");
  marker("partial.json", { allocation_started: true, heap_limit_bytes: getHeapStatistics().heap_size_limit,
    oom_score_adjustment: Number(readFileSync("/proc/self/oom_score_adj", "utf8")) });
  const blocks: Buffer[] = [];
  for (;;) blocks.push(Buffer.alloc(8 * 1024 * 1024, 1));
} else {
  appendFileSync("launches.ndjson", `${JSON.stringify({ started: true })}\n`);
  process.stdin.resume();
  const child = spawn(process.execPath, ["--max-old-space-size=1024", import.meta.filename, "allocate"], { stdio: "ignore" });
  const ended = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once("error", reject); child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  marker("memory-child.json", { exit_code: ended.code, signal: ended.signal });
  // The test releases this failed supervisor only after Docker has recorded the genuine kernel OOM notification.
  while (!existsSync("memory-release.json")) await setTimeout(10);
  process.exit(1);
}
