/** Independent process sharing the same plain tracker, budget and artifact ledger. */
import { readFileSync } from "node:fs";
import { PmClient } from "@unbrained/pm-cli/sdk/core";
import { openImproverEnvironment, IMPROVER_CRITERION } from "../../improver-environment.ts";
import type { ImproverDataset } from "../../improver-data.ts";
import type { LearnerConfig } from "../../improver.ts";
const [file, job] = process.argv.slice(2);
const request = JSON.parse(readFileSync(file, "utf8")) as { root: string; pmRoot: string; dataset: string; manifest: ImproverDataset; approval: string; config: LearnerConfig };
const client = new PmClient({ cwd: request.root, pmRoot: request.pmRoot, author: "checkpoint-test", noExtensions: true });
process.send?.({ ready: true });
await new Promise<void>((resolve) => { process.once("message", () => resolve()); });
const environment = openImproverEnvironment(client, { pmRoot: request.pmRoot, author: "checkpoint-test" }, request.dataset, request.manifest, request.approval, 256, 42, IMPROVER_CRITERION);
const trial = await environment.fit("development", 0, request.config, job, null, AbortSignal.timeout(120_000));
process.send?.({ trial });
process.disconnect?.();
