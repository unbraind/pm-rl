/** Independent ordinary SDK process; no transaction coordinator or inherited tracker focus. */
import assert from "node:assert/strict";
import { PmClient } from "@unbrained/pm-cli/sdk/core";

const [root, pmRoot, id, body, mode] = process.argv.slice(2);
assert.ok(root && pmRoot && id && body);
const client = new PmClient({ cwd: root, pmRoot, author: "ordinary-process-peer", noExtensions: true });
if (mode === "create") await client.create({ id, type: "Task", tags: "rl-process-job", title: "Independent peer reservation", body });
else { assert.equal(mode, "update"); await client.update(id, { body }); }
