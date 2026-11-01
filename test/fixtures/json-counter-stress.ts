/** Exercise the released maximum JSON payload often enough to expose signed V8 loop-counter overflow. */
import assert from "node:assert/strict";
import { assertJsonEncoding, MAX_JSON_BYTES } from "../../tracker-record.ts";
const value = JSON.stringify("x".repeat(MAX_JSON_BYTES - 2));
for (let iteration = 0; iteration < 130; iteration += 1) assert.equal(assertJsonEncoding(value), value);
console.log(JSON.stringify({ bytes: Buffer.byteLength(value), encodings: 130 }));
