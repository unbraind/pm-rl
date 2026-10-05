/** Real process fixture: IPC phase barrier and operating-system signal drills. */
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createExtensionTestHarness } from "@unbrained/pm-cli/sdk/testing";
import type { CommandHandlerContext } from "@unbrained/pm-cli/sdk/authoring";
import { PmClient } from "@unbrained/pm-cli/sdk/core";
import { isPmCliExpectedError } from "@unbrained/pm-cli/sdk/runtime";
import extension, { runRlLoop, type JsonValue } from "../../index.ts";

const [pmRoot, approval, encoded, mode] = process.argv.slice(2);
const controller = new AbortController();
process.once("SIGINT", () => controller.abort()); process.once("SIGTERM", () => controller.abort());
const client = new PmClient({ pmRoot, author: "process-test" });
try {
  if (mode === "cli") {
    const update = client.update.bind(client);
    let held = false;
    client.update = async (id, options) => {
      const result = await update(id, options);
      if (options?.note && !held) {
        held = true;
        process.send!("ready");
        await new Promise<void>((resolve) => { process.once("message", () => resolve()); process.once("SIGINT", () => resolve()); process.once("SIGTERM", () => resolve()); });
      }
      return result;
    };
    const file = join(dirname(pmRoot), "cli-config.json"); writeFileSync(file, encoded);
    const harness = await createExtensionTestHarness(extension, { name: "pm-rl", capabilities: ["commands", "hooks", "schema"] });
    await harness.runCommand({ command: "rl loop run", pmRoot, args: ["race"], options: { file, approval }, sdk: { client } as NonNullable<CommandHandlerContext["sdk"]> });
  } else {
  const report = await runRlLoop(client, { pmRoot, author: "process-test" }, { id: "race", config: JSON.parse(encoded) as JsonValue, approval, signal: controller.signal,
    async onPhase(phase, generation) {
      if (mode === "hold" && phase === "collect" && generation === 1) {
        process.send!("ready");
        await new Promise<void>((resolve) => { process.once("message", () => resolve()); controller.signal.addEventListener("abort", () => resolve(), { once: true }); });
      }
    } });
  process.send!({ promoted: report.promoted });
  }
} catch (error) {
  if (!isPmCliExpectedError(error)) throw error;
  process.send!({ refusal: error.context.code });
  process.exitCode = 1;
} finally { process.disconnect!(); }
