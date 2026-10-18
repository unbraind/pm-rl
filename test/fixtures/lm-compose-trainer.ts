/** Real LM fits with deterministic corruption and an explicit deadline barrier. */
import { appendFileSync, writeFileSync, writeSync } from "node:fs";
import { Writable } from "node:stream";
import { runLmTrainer } from "../../process-lm-trainer.ts";
import { writeTrainerArtifact } from "../../process-bandit.ts";
appendFileSync("launches.ndjson", `${JSON.stringify({ started: true })}\n`);
const mode = process.env["TRAINER_MODE"];
const stdout = mode === "time" ? new Writable({
  /** Publish the real initial progress event, then hold this fault-injected worker past its unchanged deadline. */
  write(chunk: Buffer, _encoding, callback) {
    writeSync(process.stdout.fd, chunk);
    writeTrainerArtifact("time-barrier.json", { initial_progress_written: true });
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 120_000);
    callback();
  },
}) : process.stdout;
await runLmTrainer(process.stdin, stdout);
if (mode === "corrupt") writeFileSync("checkpoint.json", "corrupt");
