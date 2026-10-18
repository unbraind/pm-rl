/** Exhaust the container's physical memory guard without loading the LM or hitting a smaller V8 heap ceiling first. */
import { Buffer } from "node:buffer";
import { appendFileSync, closeSync, fsyncSync, openSync, writeFileSync } from "node:fs";
import { getHeapStatistics } from "node:v8";

appendFileSync("launches.ndjson", `${JSON.stringify({ started: true })}\n`);
process.stdin.resume();
const handle = openSync("partial.json", "wx");
try {
  writeFileSync(handle, JSON.stringify({ allocation_started: true, heap_limit_bytes: getHeapStatistics().heap_size_limit }));
  fsyncSync(handle);
} finally { closeSync(handle); }
const blocks: Buffer[] = [];
for (;;) blocks.push(Buffer.alloc(8 * 1024 * 1024, 1));
