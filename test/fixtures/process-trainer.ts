/** Real hostile/cancellable child fixtures exercise the documented stdin, NDJSON and disk contract. */
import { Readable, Writable } from "node:stream";
import type { ProcessInput, Resources } from "../../process.ts";
import { readFileSync, writeFileSync, symlinkSync, unlinkSync } from "node:fs";
import { setTimeout } from "node:timers/promises";
import { runReferenceTrainer } from "../../process-bandit.ts";
const mode = process.argv[2];
if (mode === "empty") process.stdin.resume();
else if (mode === "hang") {
  process.stdin.resume(); writeFileSync("partial.json", "retained partial checkpoint"); await setTimeout(10000);
} else if (mode === "stderr") {
  process.stdin.resume(); process.stderr.write("x".repeat(70000)); await setTimeout(10000);
} else if (mode === "channel") {
  process.stdin.resume(); process.stdout.write("x".repeat(70000)); await setTimeout(10000);
} else if (mode === "invalid-event") {
  process.stdin.resume(); process.stdout.write('{}\n'); await setTimeout(10000);
} else if (mode === "malformed") {
  process.stdin.resume(); process.stdout.write('oops\n'); await setTimeout(10000);
} else if (mode === "oversize") {
  process.stdin.resume(); writeFileSync("huge.json", "x".repeat(70000)); await setTimeout(10000);
} else if (["progress-excess", "progress-regress", "complete-regress", "foreign-event", "stream-disagreement"].includes(mode)) {
  let text = ""; for await (const chunk of process.stdin) text += String(chunk);
  const request = JSON.parse(text) as { job: string; input: ProcessInput };
  const usage: Resources = { training_steps: 0, wall_ms: 0, storage_bytes: 0, compute_units: 0, tokens: 1 };
  if (mode === "foreign-event") process.stdout.write(`${JSON.stringify({ type: "foreign", job: request.job })}\n`);
  else if (mode === "stream-disagreement") {
    let output = "";
    const sink = new Writable({ write(chunk: Buffer, _encoding, callback) { output += String(chunk); callback(); } });
    await runReferenceTrainer(Readable.from([text]), sink);
    const events = output.trim().split('\n').map((line) => JSON.parse(line) as { type: string; receipt: Record<string, unknown> });
    events[1].receipt["digest"] = "foreign"; process.stdout.write(`${events.map((event) => JSON.stringify(event)).join('\n')}\n`);
  } else {
    process.stdout.write(`${JSON.stringify({ type: "progress", job: request.job, usage })}\n`);
    if (mode === "progress-regress") process.stdout.write(`${JSON.stringify({ type: "progress", job: request.job, usage: { ...usage, tokens: 0 } })}\n`);
    if (mode === "complete-regress") {
      let output = ""; const sink = new Writable({ write(chunk: Buffer, _encoding, callback) { output += String(chunk); callback(); } });
      await runReferenceTrainer(Readable.from([text]), sink);
      process.stdout.write(`${output.trim().split('\n')[1]}\n`);
    }
  }
} else if (mode === "unicode") {
  let text = ""; for await (const chunk of process.stdin) text += String(chunk);
  const request = JSON.parse(text) as { job: string; input: ProcessInput };
  const line = Buffer.from(`${JSON.stringify({ type: "progress", job: request.job, note: "café", usage: { training_steps: 0, wall_ms: 0, storage_bytes: 0, compute_units: 0, tokens: 0 } })}\n`);
  const split = line.indexOf(Buffer.from("é")) + 1; process.stdout.write(line.subarray(0, split)); await setTimeout(25); process.stdout.write(line.subarray(split));
  await runReferenceTrainer(Readable.from([text]));
} else if (mode === "checkpoint-only") {
  const sink = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
  await runReferenceTrainer(process.stdin, sink); unlinkSync("completion.json");
} else if (mode === "large-receipt") {
  let output = ""; const sink = new Writable({ write(chunk: Buffer, _encoding, callback) { output += String(chunk); callback(); } });
  await runReferenceTrainer(process.stdin, sink);
  const value = JSON.parse(readFileSync("completion.json", "utf8")) as { job: string; usage: Resources };
  writeFileSync("completion.json", JSON.stringify({ ...value, padding: "x".repeat(70000) }));
  process.stdout.write(`${JSON.stringify({ type: "complete", job: value.job, receipt: { usage: value.usage } })}\n`);
} else {
  await runReferenceTrainer();
  if (mode === "partial-line") process.stdout.write("partial");
  if (mode === "extra-event") process.stdout.write('{}\n');
  if (mode === "nonzero") process.exitCode = 1;
  if (mode === "stderr-small") process.stderr.write("retained diagnostics");
  if (mode === "staging-link") symlinkSync("checkpoint.json", "extra-link");
  if (mode === "completion-link") { unlinkSync("completion.json"); symlinkSync("checkpoint.json", "completion.json"); }
  if (mode === "corrupt") writeFileSync("checkpoint.json", "corrupt");
  if (mode === "receipt-drift") { const receipt = JSON.parse(readFileSync("completion.json", "utf8")) as Record<string, unknown>; receipt["source_policy"] = "foreign"; writeFileSync("completion.json", JSON.stringify(receipt)); }
}
