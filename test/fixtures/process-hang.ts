/** Minimal real child publishes a partial checkpoint before waiting for cancellation or wall expiry. */
import { writeFileSync } from "node:fs";
import { setTimeout } from "node:timers/promises";
process.stdin.resume();
writeFileSync("partial.json", "retained partial checkpoint");
await setTimeout(10000);
