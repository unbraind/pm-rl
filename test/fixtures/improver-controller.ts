/** A real controller pauses after a durable update so the parent can deliver SIGKILL. */
import { readFileSync } from "node:fs";
import { PmClient } from "@unbrained/pm-cli/sdk/core";
import { runRecursiveImprover, type ImproverRequest } from "../../recursive-improver.ts";
const [project, pmRoot, requestFile] = process.argv.slice(2);
const request = JSON.parse(readFileSync(requestFile, "utf8")) as ImproverRequest;
const client = new PmClient({ cwd: project, pmRoot, author: "improver-test", noExtensions: true });
await runRecursiveImprover(client, { pmRoot, author: "improver-test" }, { ...request, async onStep(key) {
  if (key === "g1-update") { process.send?.({ key }); await new Promise<void>(() => { setInterval(() => {}, 1000); }); }
} });
