/** Real LM controller with IPC barriers inside PM step writes for crash and cancellation drills. */
import { PmClient } from "@unbrained/pm-cli/sdk/core";
import { isPmCliExpectedError } from "@unbrained/pm-cli/sdk/runtime";
import { runRlLoop, type JsonValue } from "../../index.ts";

const [pmRoot, approval, encoded, mode] = process.argv.slice(2);
const controller = new AbortController();
process.once("SIGINT", () => controller.abort());
process.once("SIGTERM", () => controller.abort());
const client = new PmClient({ pmRoot, author: "lm-process-test", noExtensions: true });
let held = false;
/** Hold the real controller until the parent resumes it or cancellation arrives. */
async function barrier(): Promise<void> {
  process.send!("ready");
  await new Promise<void>((resolve) => {
    process.once("message", () => resolve());
    controller.signal.addEventListener("abort", () => resolve(), { once: true });
  });
}
const update = client.update.bind(client);
client.update = async (id, options) => {
  const result = await update(id, options);
  if (!held && mode === "mid-collect" && options?.note !== undefined) { held = true; await barrier(); }
  return result;
};
let step = "";
let candidate = false;
const get = client.get.bind(client);
client.get = (async (...args: Parameters<PmClient["get"]>) => {
  const result = await get(...args);
  if (!("item" in result)) throw new Error("LM controller read omitted its source item.");
  const body = String(result.item.body);
  if (body.includes('"state":"running"')) step = args[0].split("-step-").at(-1)!;
  if (args[0].endsWith("-g1") && result.item.type === "Generation") {
    candidate = true;
    if (!held && mode === "mid-promote" && body.includes('"promoted": true')) {
      held = true;
      if ((await get(args[0], { fields: "status" })).item.status !== "closed") throw new Error("Promotion body and closure must commit together.");
      await barrier();
    }
  }
  return result;
}) as PmClient["get"];
const configRead = client.config.bind(client);
client.config = async (...args: Parameters<PmClient["config"]>) => {
  const result = await configRead(...args);
  // Hold the real fenced operation at its SDK coordinate read, before the item transaction.
  const committing = new Error().stack?.includes("mutateLoopItem");
  const uncommittedFit = mode === "mid-train" && step === "train";
  const committedFit = mode === "train" && step === "evaluate";
  const committedEvaluation = mode === "evaluate" && candidate;
  if (!held && committing && (uncommittedFit || committedFit || committedEvaluation)) { held = true; await barrier(); }
  return result;
};

try {
  if (mode === "race") { process.send!("starting"); await new Promise<void>((resolve) => { process.once("message", () => resolve()); }); }
  const report = await runRlLoop(client, { pmRoot, author: "lm-process-test" }, {
    id: "lm-drill", approval, config: JSON.parse(encoded) as JsonValue, signal: controller.signal,
    async onPhase(phase, generation) { if (mode === "race" && generation === 1 && phase === "collect") await barrier(); },
  });
  process.send!({ report });
} catch (error) {
  if (!isPmCliExpectedError(error)) throw error;
  process.send!({ refusal: error.context.code, message: error.message });
  process.exitCode = 1;
} finally {
  process.disconnect!();
}
