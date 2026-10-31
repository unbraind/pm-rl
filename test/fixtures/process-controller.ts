/** Real controller with barriers after staged completion and at each durable external-job transition. */
import { PmClient } from "@unbrained/pm-cli/sdk/core";
import { isPmCliExpectedError } from "@unbrained/pm-cli/sdk/runtime";
import { runRlLoop, type JsonValue } from "../../index.ts";
import type { ProcessCoordinates } from "../../process.ts";
const [pmRoot, approval, encoded, mode] = process.argv.slice(2);
const client = new PmClient({ pmRoot, author: "process-test", noExtensions: true });
const abort = new AbortController();
process.once("SIGTERM", () => abort.abort());
let held = false;
/** Pause at a real write boundary until the parent permits progress or signals cancellation. */
async function barrier(): Promise<void> { process.send!("ready"); await new Promise<void>((resolve) => { process.once("message", () => resolve()); abort.signal.addEventListener("abort", () => resolve(), { once: true }); }); }
const create = client.create.bind(client);
client.create = async (options) => { const result = await create(options); if (!held && mode === "planned" && String(options?.body).includes('"state":"planned"')) { held = true; await barrier(); } return result; };
try {
  if (mode === "race") { process.send!("starting"); await new Promise<void>((resolve) => { process.once("message", () => resolve()); }); }
  const coordinates: ProcessCoordinates = { pmRoot, author: "process-test", async onTransition(context) {
    const state = mode === "race" ? "running" : mode === "committed-materialized" ? "materialized" : mode;
    const boundary = mode === "materialized" ? "prepared" : "step_applied";
    if (!held && context.transactionId.includes(`-${state}-v`) && context.transition === boundary) { held = true; await barrier(); }
  } };
  const report = await runRlLoop(client, coordinates, { id: "process-drill", approval, config: JSON.parse(encoded) as JsonValue, signal: abort.signal,
    ...(mode === "cancel" ? { processTrainerArgv: [process.execPath, new URL("./process-trainer.ts", import.meta.url).pathname, "hang"] } : {}),
  });
  process.send!({ report });
} catch (error) { if (!isPmCliExpectedError(error)) throw error; process.send!({ refusal: error.context.code, message: error.message }); process.exitCode = 1; }
finally { process.disconnect!(); }
