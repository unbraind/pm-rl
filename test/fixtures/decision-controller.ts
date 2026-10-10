/** Built-package controller paused at a decision boundary for real SIGKILL drills. */
import { PmClient } from "@unbrained/pm-cli/sdk/core";
import { runRlLoop, type JsonValue } from "../../dist/index.js";

const [pmRoot, encoded, targetStage, targetMetric, targetStep] = process.argv.slice(2);
const client = new PmClient({ pmRoot, author: "receipt-process" });
try {
  await runRlLoop(client, { pmRoot, author: "receipt-process" }, {
    id: "recovery", config: JSON.parse(encoded) as JsonValue, approval: "approval",
    async onDecision(stage, metric, step) {
      if (stage === targetStage && metric === targetMetric && step === Number(targetStep)) {
        process.send!("ready");
        await new Promise<void>(() => { /* Parent kills this process at the observed boundary. */ });
      }
    },
  });
  process.send!("finished");
} catch (error) {
  process.send!({ error: String(error) });
  process.exitCode = 1;
} finally { process.disconnect!(); }
