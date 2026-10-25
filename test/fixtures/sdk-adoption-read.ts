/** Read-only domain probe shared by the baseline and candidate builds. */
import assert from "node:assert/strict";
import { PmClient } from "@unbrained/pm-cli/sdk/core";
import { commitProcessTransaction, withProcessJobFence } from "../../dist/index.js";

const pmRoot = process.argv[2];
const client = new PmClient({ pmRoot, author: "adoption-differential", noExtensions: true });
const transitions: string[] = [];
const result = await withProcessJobFence({ pmRoot, author: "adoption-differential" }, "adoption-differential", async () => {
  const items = await client.listAllComplete();
  assert.ok(items.items.length > 0, "a real public tracker must be populated");
  return items;
});
await commitProcessTransaction({ pmRoot, author: "adoption-differential", transactionId: "adoption-differential",
  steps: [{ id: "read", async inspect() { return { state: "applied", result: result.items.length }; }, async apply() { assert.fail("read-only probe cannot apply a mutation"); }, async compensate() { assert.fail("read-only probe cannot compensate a mutation"); } }],
  onTransition(context) { transitions.push(context.transition); },
});
// The SDK records the wall clock of each read; compare every other envelope field.
const { now, ...snapshot } = result;
assert.ok(Number.isFinite(Date.parse(now)));
process.stdout.write(`${JSON.stringify({ result: snapshot, transitions })}\n`);
