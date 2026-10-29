/** Native main-produced process receipts preserve identity and accounting across filesystem clock representations. */
import assert from "node:assert/strict";
import fs, { mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync, type PathLike } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { mock, test } from "node:test";
import { isPmCliExpectedError } from "@unbrained/pm-cli/sdk/runtime";
import { readCompleteLoopItem } from "../index.ts";
import { processStaging, readProcessJob, validateProcessCompletion, verifiedProcessPolicy, verifyProcessJobBudget, type ProcessInput, type ProcessJob } from "../process.ts";
import { statePath } from "../state-boundary.ts";
import { processWorkspace } from "./fixtures/process-workspace.ts";

interface RecordedClock { readonly runtime: string; readonly job: ProcessJob; readonly body: string; readonly approval: string; readonly files: Readonly<Record<string, string>>; readonly mtime_ns: string; readonly clock_ms: number; readonly policy: unknown }
const fixture = JSON.parse(readFileSync(new URL("./fixtures/main-process-clocks.json", import.meta.url), "utf8")) as { readonly input: ProcessInput; readonly records: readonly RecordedClock[] };

test("main Node and Bun process receipts retain SDK charges under both filesystem clocks and reject forged charges", { timeout: 600_000 }, async () => {
  for (const record of fixture.records) {
    const w = await processWorkspace();
    try {
      await w.client.create({ id: record.job.approval, type: "Decision", title: "Main process approval", body: record.approval });
      await w.client.create({ id: record.job.id, type: "Task", title: "Main process receipt", tags: "rl-process-job", body: record.body });
      const directory = processStaging(w.pmRoot, record.job.id, true); mkdirSync(directory, { recursive: true });
      for (const [name, content] of Object.entries(record.files)) writeFileSync(statePath(directory, name), content);
      const completionFile = statePath(directory, "completion.json"); const ns = BigInt(record.mtime_ns);
      const seconds = Number(ns / 1_000_000_000n) + Number(ns % 1_000_000_000n) / 1_000_000_000;
      utimesSync(completionFile, seconds, seconds);
      const job = (await readProcessJob(w.client, record.job.id))!;
      assert.deepEqual(job, record.job); await verifyProcessJobBudget(w.client, job);
      const before = (await readCompleteLoopItem(w.client, job.id)).item;
      assert.deepEqual(verifiedProcessPolicy(job, w.pmRoot, fixture.input), record.policy);
      // Replay the actual old Bun stat observation, while forwarding real SDK
      // and filesystem operations. The bigint observation remains precise.
      const native = fs.lstatSync;
      const integerClock = fixture.records[1]!.clock_ms;
      assert.ok(Number.isSafeInteger(integerClock));
      // Node supplies the fault overlay; Bun exercises its native integer clock.
      if (typeof mock.method === "function") {
      const probe = mock.method(fs, "lstatSync", ((path: PathLike, options?: unknown) => {
        const stat = Reflect.apply(native, fs, [path, options]) as object;
        if (path !== completionFile || options !== null && typeof options === "object" && "bigint" in options && options.bigint === true) return stat;
        return new Proxy(stat, { get(target, field) { return field === "mtimeMs" ? integerClock : Reflect.get(target, field, target); } });
      }) as typeof fs.lstatSync);
      syncBuiltinESMExports();
      try { assert.deepEqual(verifiedProcessPolicy(job, w.pmRoot, fixture.input), record.policy); }
      finally { probe.mock.restore(); syncBuiltinESMExports(); }
      }
      for (const wall of [-1, NaN, Infinity, Number.MAX_SAFE_INTEGER, job.completion!.usage.wall_ms + 2]) assert.throws(() => validateProcessCompletion(directory, job.id, fixture.input, job.allowance, w.pmRoot, wall), isPmCliExpectedError);
      assert.deepEqual((await readCompleteLoopItem(w.client, job.id)).item, before);
    } finally { rmSync(w.root, { recursive: true, force: true }); }
  }
});
