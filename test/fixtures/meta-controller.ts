/** Real killable outer controller: pause only after a committed initial fit receipt. */
import { readFileSync } from "node:fs";
import { PmClient } from "@unbrained/pm-cli/sdk/core";
import { runRlMeta } from "../../dist/meta.js";
import type { MetaRequest } from "../../meta.ts";
const [pmRoot, file] = process.argv.slice(2);
const request = JSON.parse(readFileSync(file, "utf8")) as MetaRequest;
const client = new PmClient({ pmRoot, author: "meta-test", noExtensions: true });
const execution: MetaRequest = { ...request, async onStep(key) {
  if (key === "initial") {
    process.send!({ phase: key });
    await new Promise<void>(() => { setInterval(() => {}, 1000); });
  }
} };
await runRlMeta(client, { pmRoot, author: "meta-test" }, execution);
