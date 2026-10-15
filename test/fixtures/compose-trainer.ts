/** Tiny real container trainer; the hang mode exposes deterministic kill and cancellation barriers. */
import { appendFileSync, unlinkSync } from "node:fs";
import { Writable } from "node:stream";
import { setTimeout } from "node:timers/promises";
import { runReferenceTrainer, writeTrainerArtifact } from "../../process-bandit.ts";

appendFileSync("launches.ndjson", `${JSON.stringify({ started: true })}\n`);
if (process.env["TRAINER_MODE"] === "hang") {
  process.stdin.resume();
  writeTrainerArtifact("partial.json", { partial: "retained" });
  await setTimeout(120_000);
} else if (process.env["TRAINER_MODE"] === "checkpoint-only") {
  const sink = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
  await runReferenceTrainer(process.stdin, sink); unlinkSync("completion.json");
} else await runReferenceTrainer();
