/** Real LM fits plus deterministic corruption, memory exhaustion and mid-fit barriers. */
import { appendFileSync, writeFileSync } from "node:fs";
import { runLmTrainer } from "../../process-lm-trainer.ts";
import { writeTrainerArtifact } from "../../process-bandit.ts";
appendFileSync("launches.ndjson", `${JSON.stringify({ started: true })}\n`);
const mode = process.env["TRAINER_MODE"];
if (mode === "memory") {
  process.stdin.resume();
  writeTrainerArtifact("partial.json", { allocation_started: true });
  const blocks: Buffer[] = [];
  for (;;) blocks.push(Buffer.alloc(8 * 1024 * 1024, 1));
} else {
  await runLmTrainer();
  if (mode === "corrupt") writeFileSync("checkpoint.json", "corrupt");
}
