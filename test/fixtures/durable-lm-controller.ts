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
  const body = options?.body;
  const midCollection = mode === "mid-collect" && options?.note !== undefined;
  const publishedStep = typeof body === "string" && body.includes('"state":"complete"') && id.endsWith(`step-${mode}`);
  const uncommittedFit = mode === "mid-train" && typeof body === "string" && id.endsWith("step-train") && body.includes('"state":"complete"');
  if (!held && uncommittedFit) { held = true; await barrier(); }
  const result = await update(id, options);
  const midPromotion = mode === "mid-promote" && id.endsWith("-g1") && typeof body === "string" && body.includes('"promoted": true');
  if (!held && (midCollection || publishedStep || midPromotion)) { held = true; await barrier(); }
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
