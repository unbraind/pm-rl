/** Independent-process writer; IPC barriers expose committed-but-unacknowledged application boundaries. */
import { readFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { isPmCliExpectedError } from "@unbrained/pm-cli/sdk/runtime";
import { PmClient } from "@unbrained/pm-cli/sdk/core";
import { causalStep, withCausalClock, type causalWorkspace } from "./causal-evaluation.ts";

const fixture = JSON.parse(readFileSync(process.argv[2], "utf8")) as Awaited<ReturnType<typeof causalWorkspace>>;
fixture.client = new PmClient({ cwd: fixture.root, pmRoot: fixture.pmRoot, author: "lifecycle-peer", noExtensions: true });
process.send!({ state: "ready" });
process.once("message", () => {
  if (process.argv[3] === "exit-after-ready") { process.disconnect!(); return; }
  void withCausalClock(process.argv[4], async () => {
    for (let attempt = 0; ; attempt++) {
      try { return await causalStep(fixture, process.argv[3]); }
      catch (error) { if (!isPmCliExpectedError(error) || error.context.code !== "lock_conflict" || attempt >= 3) throw error; await delay(100); }
    }
  }).then((result) => {
    process.send!({ state: "committed", result });
    if (process.argv[5] === "hold") setInterval(() => {}, 1000);
    else process.disconnect!();
  }, (error: unknown) => { process.stderr.write(String(error)); process.exitCode = 1; process.disconnect!(); });
});
