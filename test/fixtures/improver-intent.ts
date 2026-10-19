/** A real SDK launch intent pauses before exec, allowing a hard kill with no completion receipt. */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PmClient } from "@unbrained/pm-cli/sdk/core";
import { improverProcessAttempt, IMPROVER_ADAPTER } from "../../improver-environment.ts";
import { processJobId, processStaging, reserveProcessJob, transitionProcessJob, type ProcessInput } from "../../process.ts";
import type { PrefixCheckpoint } from "../../prefix.ts";
import { prefixTrainerArgv } from "../../prefix-trainer.ts";
const [project, pmRoot, file, mode] = process.argv.slice(2);
const request = JSON.parse(readFileSync(file, "utf8")) as { input: ProcessInput<PrefixCheckpoint>; approval: string };
const client = new PmClient({ cwd: project, pmRoot, author: "improver-test", noExtensions: true });
const coordinates = { pmRoot, author: "improver-test" };
const input = improverProcessAttempt(request.input, 0);
const id = processJobId(input, prefixTrainerArgv(), IMPROVER_ADAPTER);
const planned = await reserveProcessJob(client, coordinates, id, input, request.approval, IMPROVER_ADAPTER.allowance);
await transitionProcessJob(client, coordinates, planned, "running", "launch_intent");
if (mode !== "missing") {
  const staging = processStaging(pmRoot, id); mkdirSync(staging, { recursive: true });
  writeFileSync(join(staging, "completion.json"), mode === "partial" ? "{" : "{}");
}
process.send?.({ id });
await new Promise<void>(() => { setInterval(() => {}, 1000); });
