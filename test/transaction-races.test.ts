/** Real ordinary SDK writers interleave every transaction boundary without workspace-lock assumptions. */
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";
import { PmClient } from "@unbrained/pm-cli/sdk/core";
import { EXIT_CODE, isPmCliExpectedError } from "@unbrained/pm-cli/sdk/runtime";
import { certifyAppliedRevision, commitProcessTransaction, createVerifiedItem, hashJson, mutateLoopItem, readCompleteLoopItem, readLoopRevision, withWriteHistoryFence, withRlController, type JsonValue } from "../index.ts";
import { reserveMeta, type MetaRequest } from "../meta.ts";
import { RESOURCE_KEYS, processDigest, processJobId, readProcessJob, reserveProcessJob, transitionProcessJob, type ProcessJob, type ProcessCoordinates } from "../process.ts";
import { allowance, processWorkspace, trainingInput } from "./fixtures/process-workspace.ts";
import { metaConfig, metaSpec } from "./fixtures/meta-workspace.ts";

const nativePath = process.env.PATH; const nativeCeiling = process.env.GIT_CEILING_DIRECTORIES;
const bin = mkdtempSync(join(tmpdir(), "rl-transaction-no-git-"));
before(() => {
  symlinkSync(process.execPath, join(bin, "node"));
  const identityTool = process.platform === "linux" ? "getconf" : "ps";
  symlinkSync(execFileSync("/bin/sh", ["-c", `command -v ${identityTool}`], { encoding: "utf8" }).trim(), join(bin, identityTool));
  process.env.PATH = bin; process.env.GIT_CEILING_DIRECTORIES = tmpdir();
});
after(() => {
  if (nativePath === undefined) delete process.env.PATH; else process.env.PATH = nativePath;
  if (nativeCeiling === undefined) delete process.env.GIT_CEILING_DIRECTORIES; else process.env.GIT_CEILING_DIRECTORIES = nativeCeiling;
  rmSync(bin, { recursive: true, force: true });
});

const forward = ["prepared", "step_applied", "step_recorded", "committing", "committed"] as const;
const reverse = ["compensating", "step_compensating", "step_compensated", "compensated"] as const;
/** Include wrapped SDK compensation refusals while requiring a typed conflict in their causal chain. */
function conflict(error: unknown): boolean {
  if (isPmCliExpectedError(error)) return error.exitCode === EXIT_CODE.CONFLICT;
  if (error instanceof AggregateError) return error.errors.some(conflict);
  return false;
}
/** Independent peer client uses only ordinary SDK mutations against the same non-git tracker. */
function peerFor(w: Awaited<ReturnType<typeof processWorkspace>>): PmClient {
  return new PmClient({ cwd: w.root, pmRoot: w.pmRoot, author: "ordinary-peer", noExtensions: true });
}
/** Capture exact authoritative bytes after a peer commits; compensation may not erase its history. */
function nativeBytes(pmRoot: string, id: string): readonly string[] {
  return [readFileSync(join(pmRoot, "tasks", `${id}.toon`), "utf8"), readFileSync(join(pmRoot, "history", `${id}.jsonl`), "utf8")];
}

test("reservation boundary property: every immutable request field conflicts at every forward hook", { timeout: 600_000 }, async () => {
  const budget = Object.fromEntries(Object.entries(allowance).map(([key, value]) => [key, Math.max(value * 100, 100)])) as typeof allowance;
  const w = await processWorkspace(budget); const peer = peerFor(w); const input = trainingInput();
  const template = await reserveProcessJob(w.client, w.coordinates, processJobId(input), input, w.approval, allowance);
  const other = await peer.create({ id: "other-approval", type: "Decision", title: "Other capacity", body: '```json\n' + JSON.stringify({ permitted_promotions: 100, resource_budget: budget }) + '\n```' });
  const mutations: readonly ((job: ProcessJob) => ProcessJob)[] = [
    job => ({ ...job, input: processDigest({ changed: true }) }),
    job => ({ ...job, binding: { changed: true } }),
    job => ({ ...job, approval: other.item.id }),
    ...RESOURCE_KEYS.map(key => (job: ProcessJob): ProcessJob => ({ ...job, allowance: { ...job.allowance, [key]: job.allowance[key] + 1 }, charge: { ...job.charge, [key]: job.charge[key] + 1 } })),
    job => ({ ...job, budget_digest: processDigest({ changed: true }) }),
  ];
  let cases = 0;
  for (const hook of forward) for (const mutate of mutations) {
    const request = { ...input, identity: { case: cases++ } }; const raw = processJobId(request); const id = `rl-${raw}`;
    let injected = false; let expected: readonly string[] = [];
    await assert.rejects(reserveProcessJob(w.client, { ...w.coordinates, async onTransition(context) {
      if (context.transition !== hook || injected) return;
      injected = true;
      const current = await readProcessJob(peer, id);
      const changed = mutate((current ?? { ...template, id, input: processDigest(request), binding: request.identity }) as ProcessJob);
      if (current === null) await peer.create({ id, type: "Task", tags: "rl-process-job", title: "Peer reservation", body: JSON.stringify(changed) });
      else await peer.update(id, { body: JSON.stringify(changed) });
      expected = nativeBytes(w.pmRoot, id);
    } }, raw, request, w.approval, allowance), conflict, `${hook}:${cases}`);
    assert.ok(injected); assert.deepEqual(nativeBytes(w.pmRoot, id), expected, "preserve the peer document and append-only history");
    await peer.delete(id);
  }
  console.log(JSON.stringify({ reservation_hook_cases: cases, ordinary_writers: true, non_git: true }));
});

test("transition boundary property: peer edits and ABA writes never become pending overwrite or success", { timeout: 600_000 }, async () => {
  const w = await processWorkspace({ ...allowance, training_steps: 100 }); const peer = peerFor(w); const input = trainingInput();
  let cases = 0;
  for (const hook of forward) for (const aba of [false, true]) {
    const request = { ...input, identity: { transition: cases++ } }; const raw = processJobId(request);
    const job = await reserveProcessJob(w.client, w.coordinates, raw, request, w.approval, { ...allowance, wall_ms: 0, storage_bytes: 0, compute_units: 0 });
    const nativeId = (await readCompleteLoopItem(peer, job.id)).item.id;
    let injected = false; let expected: readonly string[] = [];
    await assert.rejects(transitionProcessJob(w.client, { ...w.coordinates, async onTransition(context) {
      if (context.transition !== hook || injected) return;
      injected = true;
      const before = (await readCompleteLoopItem(peer, job.id)).item;
      const current = (await readProcessJob(peer, job.id))!;
      await peer.update(job.id, { body: JSON.stringify({ ...current, input: processDigest({ peer: cases }) }) });
      if (aba) await peer.update(job.id, { body: String(before.body) });
      expected = nativeBytes(w.pmRoot, nativeId);
    } }, job, "running", "Launch trainer"), conflict, `${hook}:${aba}`);
    assert.ok(injected); assert.deepEqual(nativeBytes(w.pmRoot, nativeId), expected);
  }
  console.log(JSON.stringify({ transition_hook_cases: cases, aba_cases: cases / 2 }));
});

test("observer helper writes cannot replace the transaction's own history witness", async () => {
  const w = await processWorkspace(); const input = trainingInput();
  const job = await reserveProcessJob(w.client, w.coordinates, processJobId(input), input, w.approval, allowance);
  const id = (await readCompleteLoopItem(w.client, job.id)).item.id;
  let injected = false; let expected: readonly string[] = [];
  await assert.rejects(transitionProcessJob(w.client, { ...w.coordinates, async onTransition(context) {
    if (context.transition !== "step_applied" || injected) return;
    injected = true;
    const before = await readCompleteLoopItem(w.client, id);
    await mutateLoopItem(w.client, before, "Observer peer write", document => { document.body = "Observer body"; return ["body"]; }, [], "ordinary-peer");
    const changed = await readCompleteLoopItem(w.client, id);
    await mutateLoopItem(w.client, changed, "Observer ABA restoration", document => { document.body = String(before.item.body); return ["body"]; }, [], "ordinary-peer");
    expected = nativeBytes(w.pmRoot, id);
  } }, job, "running", "Launch trainer"), conflict);
  assert.ok(injected); assert.deepEqual(nativeBytes(w.pmRoot, id), expected);
});

test("reservation publication rejects ABA after its own create at every remaining forward hook", async () => {
  const w = await processWorkspace({ ...allowance, training_steps: 100 }); const peer = peerFor(w);
  await peer.update(w.approval, { body: '```json\n' + JSON.stringify({ ...metaSpec, permitted_promotions: 10_000, resource_budget: { ...allowance, training_steps: 100 }, meta_budget: { training_samples: 100_000_000, proposal_calls: 10_000, recipe_promotions: 10_000 } }) + '\n```' });
  for (const domain of ["process", "meta"] as const) for (const hook of forward.slice(1)) {
    const name = `aba-${hook.replaceAll("_", "-")}`;
    const request = { ...trainingInput(), identity: { domain, hook } }; const id = domain === "process" ? processJobId(request) : `${name}-reservation`;
    let injected = false; let expected: readonly string[] = []; let path = ""; let history = "";
    const coordinates = { ...w.coordinates, async onTransition(context: Parameters<NonNullable<ProcessCoordinates["onTransition"]>>[0]) {
      if (context.transition !== hook || injected) return;
      injected = true;
      const item = (await readCompleteLoopItem(peer, id)).item;
      await peer.update(id, { body: "Peer publication" }); await peer.update(id, { body: String(item.body) });
      path = join(w.pmRoot, domain === "process" ? "tasks" : "decisions", `${item.id}.toon`); history = join(w.pmRoot, "history", `${item.id}.jsonl`);
      expected = [readFileSync(path, "utf8"), readFileSync(history, "utf8")];
    } };
    const operation = domain === "process"
      ? reserveProcessJob(w.client, coordinates, id, request, w.approval, { ...allowance, wall_ms: 0, storage_bytes: 0, compute_units: 0 })
      : reserveMeta(w.client, coordinates, { id: name, config: { ...metaConfig, meta_generations: 1, candidates: 1 }, dataset: "unused", approval: w.approval, proposer: "seeded" }, "binding");
    await assert.rejects(operation, conflict, `${domain}:${hook}`);
    assert.ok(injected); assert.deepEqual([readFileSync(path, "utf8"), readFileSync(history, "utf8")], expected);
  }
});

test("loop receipt publication rejects a native ABA after completing its own write", async () => {
  for (const existing of [false, true]) {
    const w = await processWorkspace(); const peer = peerFor(w); const run = w.client.run.bind(w.client);
    const probe = { injected: false }; let reads = 0; let expected: readonly string[] = []; const id = "rl-aba-receipt-step-result";
    if (existing) await peer.create({ id, type: "Decision", title: "Retained running receipt", tags: "rl-loop-step", body: JSON.stringify({ format: "pm-rl/loop-step/1", key: "aba-receipt-step-result", input: hashJson({}), state: "running" }) });
    Object.assign(w.client, { run: (async (...args) => {
      const result = await run(...args);
      const options = args[1] as { id?: string } | undefined;
      if (!probe.injected && args[0] === "history" && options?.id === id) {
        const item = (await readCompleteLoopItem(peer, id)).item;
        if (String(item.body).includes('"state":"complete"') && ++reads === 1) {
          Object.assign(probe, { injected: true });
          await peer.update(id, { body: "Peer receipt" }); await peer.update(id, { body: String(item.body) });
          expected = [readFileSync(join(w.pmRoot, "decisions", `${id}.toon`), "utf8"), readFileSync(join(w.pmRoot, "history", `${id}.jsonl`), "utf8")];
        }
      }
      return result;
    }) as PmClient["run"] });
    await assert.rejects(withRlController(w.client, w.coordinates, { id: "aba-receipt", approval: w.approval, recoveryCommand: "pm rl loop resume aba-receipt" }, new AbortController().signal,
      step => step("result", {}, async () => ({ value: 1 }))), conflict);
    assert.ok(probe.injected);
    assert.deepEqual([readFileSync(join(w.pmRoot, "decisions", `${id}.toon`), "utf8"), readFileSync(join(w.pmRoot, "history", `${id}.jsonl`), "utf8")], expected);
  }
});

test("publication history fences permit nested own writes and no-ops but retain a later peer ABA", async () => {
  for (const competing of [false, true]) {
    const w = await processWorkspace(); const peer = peerFor(w); const id = "rl-nested-writes";
    let expected: readonly string[] = [];
    const publish = withWriteHistoryFence(async () => {
      await createVerifiedItem(w.client, { id, type: "Task", title: "Nested native writes", body: "Before" });
      await withWriteHistoryFence(async () => {
        const before = await readCompleteLoopItem(w.client, id);
        await mutateLoopItem(w.client, before, "Own second revision", (document) => { document.body = "After"; return ["body"]; });
        const after = await readCompleteLoopItem(w.client, id);
        await mutateLoopItem(w.client, after, "Own no-op", () => []);
      });
      if (competing) { await peer.update(id, { body: "Peer write" }); await peer.update(id, { body: "After" }); }
      expected = nativeBytes(w.pmRoot, id);
    });
    if (competing) await assert.rejects(publish, conflict); else { await publish; assert.equal(await readLoopRevision(w.client, id), 2); }
    assert.deepEqual(nativeBytes(w.pmRoot, id), expected);
  }
});

test("publication fences retain failed child witnesses across body-matching recovery", async () => {
  const w = await processWorkspace(); const peer = peerFor(w); const id = "rl-child-recovery";
  let expected: readonly string[] = [];
  await assert.rejects(withWriteHistoryFence(async () => {
    await assert.rejects(withWriteHistoryFence(async () => {
      await createVerifiedItem(w.client, { id, type: "Task", title: "Child publication", body: "Original" });
      await peer.update(id, { body: "Peer change" }); await peer.update(id, { body: "Original" });
      expected = nativeBytes(w.pmRoot, id);
    }), conflict);
    assert.equal((await readCompleteLoopItem(w.client, id)).item.body, "Original");
  }), conflict);
  assert.deepEqual(nativeBytes(w.pmRoot, id), expected);
});

test("adopted reservation snapshots refuse post-adoption ABA and stable retries converge", async () => {
  const w = await processWorkspace({ ...allowance, training_steps: 100 }); const peer = peerFor(w);
  await peer.update(w.approval, { body: '```json\n' + JSON.stringify({ ...metaSpec, permitted_promotions: 10_000, resource_budget: { ...allowance, training_steps: 100 }, meta_budget: { training_samples: 100_000_000, proposal_calls: 10_000, recipe_promotions: 10_000 } }) + '\n```' });
  const template = await reserveProcessJob(w.client, w.coordinates, processJobId(trainingInput()), trainingInput(), w.approval, allowance);
  const metaRequest: MetaRequest = { id: "adopt-template", config: { ...metaConfig, meta_generations: 1, candidates: 1 }, dataset: "unused", approval: w.approval, proposer: "seeded" };
  await reserveMeta(w.client, w.coordinates, metaRequest, "binding");
  const metaTemplate = JSON.parse(String((await readCompleteLoopItem(peer, "adopt-template-reservation")).item.body)) as Record<string, unknown>;
  for (const domain of ["process", "meta"] as const) {
    const request = { ...trainingInput(), identity: { adopted: domain } }; const id = domain === "process" ? processJobId(request) : "adopt-meta-reservation";
    const record = domain === "process" ? { ...template, id, input: processDigest(request), binding: request.identity } : { ...metaTemplate, id };
    const native = await peer.create({ id, type: domain === "process" ? "Task" : "Decision", tags: domain === "process" ? "rl-process-job" : "rl-meta-reservation", title: "Matching peer allocation", body: JSON.stringify(record) });
    let injected = false; let expected: readonly string[] = [];
    const path = join(w.pmRoot, domain === "process" ? "tasks" : "decisions", `${native.item.id}.toon`); const history = join(w.pmRoot, "history", `${native.item.id}.jsonl`);
    const coordinates: ProcessCoordinates = { ...w.coordinates, async onTransition(context) {
      if (context.transition !== "committing" || injected) return;
      injected = true;
      await peer.update(id, { body: "Peer ABA" }); await peer.update(id, { body: JSON.stringify(record) });
      expected = [readFileSync(path, "utf8"), readFileSync(history, "utf8")];
    } };
    const publish = (observed: ProcessCoordinates) => domain === "process"
      ? reserveProcessJob(w.client, observed, id, request, w.approval, allowance)
      : reserveMeta(w.client, observed, { ...metaRequest, id: "adopt-meta" }, "binding");
    await assert.rejects(publish(coordinates), conflict, domain); assert.ok(injected);
    assert.deepEqual([readFileSync(path, "utf8"), readFileSync(history, "utf8")], expected);
    await publish(w.coordinates);
    assert.deepEqual([readFileSync(path, "utf8"), readFileSync(history, "utf8")], expected);
  }
});

test("an adopted snapshot cannot refresh its witness after a peer restores matching bytes", async () => {
  const w = await processWorkspace(); const peer = peerFor(w); const id = "rl-adopted-snapshot";
  await peer.create({ id, type: "Task", title: "Stable peer snapshot", body: "Original" });
  await certifyAppliedRevision(w.client, id, await readLoopRevision(w.client, id));
  let expected: readonly string[] = [];
  await assert.rejects(withWriteHistoryFence(async () => {
    await createVerifiedItem(w.client, { id: "other-owned-item", type: "Task", title: "Own publication" });
    await certifyAppliedRevision(w.client, id, await readLoopRevision(w.client, id));
    await peer.update(id, { body: "Peer body" }); await peer.update(id, { body: "Original" });
    expected = nativeBytes(w.pmRoot, id);
    await certifyAppliedRevision(w.client, id, await readLoopRevision(w.client, id));
  }), conflict);
  assert.deepEqual(nativeBytes(w.pmRoot, id), expected);
});

test("a temporary approval read while verifying a retained meta reservation stays retryable", async () => {
  const w = await processWorkspace(); const peer = peerFor(w);
  await peer.update(w.approval, { body: '```json\n' + JSON.stringify({ ...metaSpec, permitted_promotions: 10_000, meta_budget: { training_samples: 100_000_000, proposal_calls: 10_000, recipe_promotions: 10_000 } }) + '\n```' });
  const request: MetaRequest = { id: "rl-meta-retained", config: { ...metaConfig, meta_generations: 1, candidates: 1 }, dataset: "unused", approval: w.approval, proposer: "seeded" };
  await reserveMeta(w.client, w.coordinates, request, "binding");
  const get = w.client.get.bind(w.client); let fail = true;
  w.client.get = (async (id, options) => {
    if (fail && id === w.approval) { fail = false; throw Object.assign(new Error("Temporary approval read failure"), { code: "EIO" }); }
    return get(id, options);
  }) as PmClient["get"];
  await assert.rejects(reserveMeta(w.client, w.coordinates, request, "binding", true), (error: unknown) => isPmCliExpectedError(error) && error.context.code === "provenance_read_retryable");
  assert.equal(fail, false, "the retained approval read must be the injected one");
  await reserveMeta(w.client, w.coordinates, request, "binding", true);
});

test("meta reservation boundary property compares every retained request field including committed replay", { timeout: 600_000 }, async () => {
  const w = await processWorkspace(); const peer = peerFor(w);
  await peer.update(w.approval, { body: '```json\n' + JSON.stringify({ ...metaSpec, permitted_promotions: 10_000, meta_budget: { training_samples: 100_000_000, proposal_calls: 10_000, recipe_promotions: 10_000 } }) + '\n```' });
  const config = { ...metaConfig, meta_generations: 1, candidates: 1 };
  const changes: readonly Record<string, unknown>[] = [{ binding: "changed" }, { id: "other-reservation" }, { charge: { training_samples: 1, proposal_calls: 0, recipe_promotions: 1 } }, { promotion_headroom: 1 }, { approval: "absent-approval" }];
  // Obtain the expected record from the real writer; no second reservation formula is the oracle.
  const templateRequest: MetaRequest = { id: "rl-meta-template", config, dataset: "unused", approval: w.approval, proposer: "seeded" };
  await reserveMeta(w.client, w.coordinates, templateRequest, "binding");
  const template = JSON.parse(String((await readCompleteLoopItem(peer, "rl-meta-template-reservation")).item.body)) as Record<string, unknown>;
  let cases = 0;
  for (const hook of forward) for (const change of changes) {
    const request = { ...templateRequest, id: `rl-meta-${cases++}` }; const key = `${request.id}-reservation`;
    let injected = false; let expected = "";
    await assert.rejects(reserveMeta(w.client, { ...w.coordinates, async onTransition(context) {
      if (context.transition !== hook || injected) return;
      injected = true;
      const current = await readCompleteLoopItem(peer, key).catch(error => { if (isPmCliExpectedError(error) && error.exitCode === EXIT_CODE.NOT_FOUND) return null; throw error; });
      const record = current === null ? { ...template, id: key } : JSON.parse(String(current.item.body)) as Record<string, unknown>;
      if (current === null) await peer.create({ id: key, type: "Decision", tags: "rl-meta-reservation", title: "Peer meta reservation", body: JSON.stringify({ ...record, ...change }) });
      else await peer.update(key, { body: JSON.stringify({ ...record, ...change }) });
      expected = readFileSync(join(w.pmRoot, "history", `${key}.jsonl`), "utf8");
    } }, request, "binding"), conflict, `${hook}:${cases}`);
    assert.ok(injected); assert.equal(readFileSync(join(w.pmRoot, "history", `${key}.jsonl`), "utf8"), expected);
    await peer.delete(key);
  }
  const replay = { ...templateRequest, id: "rl-meta-replay" };
  await reserveMeta(w.client, w.coordinates, replay, "binding");
  await peer.delete(`${replay.id}-reservation`);
  await assert.rejects(reserveMeta(w.client, w.coordinates, replay, "binding"), conflict);
  console.log(JSON.stringify({ meta_hook_cases: cases, committed_missing_refused: true }));
});

test("compensation boundary property preserves peer state and history at every reverse hook", { timeout: 600_000 }, async () => {
  const w = await processWorkspace({ ...allowance, training_steps: 100 }); const peer = peerFor(w); const input = trainingInput();
  let cases = 0;
  for (const hook of reverse) {
    const request = { ...input, identity: { compensation: cases++ } }; const raw = processJobId(request); const id = `rl-${raw}`;
    let injected = false; let expected: readonly string[] = [];
    await assert.rejects(reserveProcessJob(w.client, { ...w.coordinates, async onTransition(context) {
      if (context.transition === "step_applied") throw new Error("Deliberate rollback boundary");
      if (context.transition !== hook || injected) return;
      injected = true;
      const current = (await readProcessJob(peer, id))!;
      await peer.update(id, { body: JSON.stringify({ ...current, binding: { peer: cases } }) });
      expected = nativeBytes(w.pmRoot, id);
    } }, raw, request, w.approval, { ...allowance, wall_ms: 0, storage_bytes: 0, compute_units: 0 }), /rollback boundary|compensation failed/);
    assert.ok(injected); assert.deepEqual(nativeBytes(w.pmRoot, id), expected);
  }
  console.log(JSON.stringify({ compensation_hook_cases: cases }));
});


test("matching peer reservations accept SDK aliases and replay without changing native fields", async () => {
  const w = await processWorkspace(); const peer = peerFor(w); const input = trainingInput(); const raw = processJobId(input);
  const template = await reserveProcessJob(w.client, w.coordinates, raw, input, w.approval, allowance);
  const request = { ...input, identity: { matching: true } }; const alternate = processJobId(request); const id = `rl-${alternate}`;
  let peerBody = "";
  const result = await reserveProcessJob(w.client, { ...w.coordinates, async onTransition(context) {
    if (context.transition !== "prepared") return;
    peerBody = JSON.stringify({ ...template, id: alternate.toUpperCase(), approval: "#RL-APPROVAL", input: processDigest(request), binding: request.identity });
    await peer.create({ id, type: "Task", tags: "rl-process-job", title: "Matching peer", body: peerBody });
  } }, alternate, request, "#RL-APPROVAL", allowance);
  assert.equal(result.id, alternate.toUpperCase()); assert.equal((await readCompleteLoopItem(peer, id)).item.body, peerBody);
  assert.deepEqual(await reserveProcessJob(w.client, w.coordinates, alternate, request, w.approval, allowance), result);
  const occupied = processJobId({ ...input, identity: { foreign: true } });
  await peer.create({ id: occupied, type: "Task", title: "Foreign target", body: "Unrelated native task" });
  await assert.rejects(reserveProcessJob(w.client, w.coordinates, occupied, { ...input, identity: { foreign: true } }, w.approval, allowance), conflict);
});

test("a peer creating inside apply is never compensated as an owned reservation", async () => {
  const w = await processWorkspace(); const peer = peerFor(w); const input = trainingInput(); const raw = processJobId(input); const id = `rl-${raw}`;
  const client = w.client; const create = client.create.bind(client); let expected: readonly string[] = [];
  client.create = async options => {
    assert.equal(options?.id, raw);
    await peer.create({ ...options, body: String(options?.body).replace('"reserved"', '"peer-created"') });
    expected = nativeBytes(w.pmRoot, id);
    return create(options);
  };
  try { await assert.rejects(reserveProcessJob(w.client, w.coordinates, raw, input, w.approval, allowance), conflict); }
  finally { client.create = create; }
  assert.deepEqual(nativeBytes(w.pmRoot, id), expected);
});

test("compensation preserves peer metadata and transition history at reverse boundaries", { timeout: 600_000 }, async () => {
  const w = await processWorkspace({ ...allowance, training_steps: 100 }); const peer = peerFor(w); const input = trainingInput();
  let cases = 0;
  for (const hook of reverse) {
    const request = { ...input, identity: { reverseTransition: cases++ } }; const raw = processJobId(request);
    const job = await reserveProcessJob(w.client, w.coordinates, raw, request, w.approval, { ...allowance, wall_ms: 0, storage_bytes: 0, compute_units: 0 });
    const id = (await readCompleteLoopItem(peer, job.id)).item.id;
    let injected = false; let expected: readonly string[] = [];
    await assert.rejects(transitionProcessJob(w.client, { ...w.coordinates, async onTransition(context) {
      if (context.transition === "step_applied") throw new Error("Deliberate transition rollback");
      if (context.transition !== hook || injected) return;
      injected = true; await peer.update(id, { title: "Peer metadata must survive" }); expected = nativeBytes(w.pmRoot, id);
    } }, job, "running", "Start"), /transition rollback|compensation failed/);
    assert.ok(injected); assert.deepEqual(nativeBytes(w.pmRoot, id), expected);
  }
  console.log(JSON.stringify({ transition_compensation_cases: cases, metadata_preserved: true }));
});


test("committed journal replay certifies a live native domain effect", async () => {
  const w = await processWorkspace(); const peer = peerFor(w); const id = "rl-journal-effect";
  const steps = [{ id: "effect", async inspect() {
    const item = await readCompleteLoopItem(peer, id).catch(error => { if (isPmCliExpectedError(error) && error.exitCode === EXIT_CODE.NOT_FOUND) return null; throw error; });
    return { state: item === null ? "pending" as const : "applied" as const };
  }, async apply() { await peer.create({ id, type: "Task", title: "Native transaction effect" }); return undefined; }, async compensate() {} }];
  await commitProcessTransaction({ ...w.coordinates, transactionId: "committed-domain-check", steps });
  await peer.delete(id);
  await assert.rejects(commitProcessTransaction({ ...w.coordinates, transactionId: "committed-domain-check", steps }), conflict);
});

test("malformed retained resource vectors and owned states refuse as typed conflicts", async () => {
  const budget = Object.fromEntries(Object.entries(allowance).map(([key, value]) => [key, Math.max(value * 100, 100)])) as typeof allowance;
  const w = await processWorkspace(budget); const peer = peerFor(w); const input = trainingInput();
  const template = await reserveProcessJob(w.client, w.coordinates, processJobId(input), input, w.approval, allowance);
  const changes: readonly Record<string, unknown>[] = [{ allowance: null }, { allowance: {} }, { allowance: { ...allowance, tokens: -1 } }, { state: "foreign-state" }, { settled: "no" }];
  let cases = 0;
  for (const change of changes) {
    const request = { ...input, identity: { malformed: cases++ } }; const raw = processJobId(request); const id = `rl-${raw}`;
    await assert.rejects(reserveProcessJob(w.client, { ...w.coordinates, async onTransition(context) {
      if (context.transition === "prepared") await peer.create({ id, type: "Task", tags: "rl-process-job", title: "Malformed peer", body: JSON.stringify({ ...template, id: raw, input: processDigest(request), binding: request.identity, ...change }) });
    } }, raw, request, w.approval, allowance), conflict);
    await peer.delete(id);
  }
});


test("independent process peer conflicts at every forward reservation hook", { timeout: 600_000 }, async () => {
  const budget = Object.fromEntries(Object.entries(allowance).map(([key, value]) => [key, Math.max(value * 100, 100)])) as typeof allowance;
  const w = await processWorkspace(budget); const peer = peerFor(w); const input = trainingInput();
  const template = await reserveProcessJob(w.client, w.coordinates, processJobId(input), input, w.approval, allowance);
  let cases = 0;
  for (const hook of forward) {
    const request = { ...input, identity: { independent: cases++ } }; const raw = processJobId(request); const id = `rl-${raw}`;
    let injected = false; let expected: readonly string[] = [];
    await assert.rejects(reserveProcessJob(w.client, { ...w.coordinates, async onTransition(context) {
      if (context.transition !== hook || injected) return;
      injected = true;
      const current = await readProcessJob(peer, id);
      const changed = { ...(current ?? { ...template, id: raw, binding: request.identity }), input: processDigest({ independentPeer: cases }) };
      execFileSync(process.execPath, [fileURLToPath(new URL("./fixtures/transaction-peer.ts", import.meta.url)), w.root, w.pmRoot, id, JSON.stringify(changed), current === null ? "create" : "update"], {
        env: { PATH: process.env.PATH, HOME: w.root, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", NPM_CONFIG_USERCONFIG: "/dev/null", GIT_CEILING_DIRECTORIES: dirname(w.root) },
        timeout: 60_000, stdio: "pipe",
      });
      expected = nativeBytes(w.pmRoot, id);
    } }, raw, request, w.approval, allowance), conflict, hook);
    assert.ok(injected); assert.deepEqual(nativeBytes(w.pmRoot, id), expected);
    await peer.delete(id);
  }
  console.log(JSON.stringify({ independent_process_hook_cases: cases }));
});


test("meta apply adopts matching late peers and preserves conflicting peers without rollback", async (t) => {
  const w = await processWorkspace(); const peer = peerFor(w);
  await peer.update(w.approval, { body: '```json\n' + JSON.stringify({ ...metaSpec, permitted_promotions: 10_000 }) + '\n```' });
  const request: MetaRequest = { id: "late-template", config: { ...metaConfig, meta_generations: 1, candidates: 1 }, dataset: "unused", approval: w.approval, proposer: "seeded" };
  const client = w.client; const get = client.get.bind(client); const create = client.create.bind(client);
  /** Restore the actual SDK methods after each fault boundary, including a failed subtest. */
  function restoreClient(): void { client.get = get; client.create = create; }
  let reads = 0; let lastRead = 0;
  client.get = (async (...args) => { if (args[0] === "late-template-reservation") reads++; return get(...args); }) as PmClient["get"];
  client.create = async options => { if (options?.id === "late-template-reservation") lastRead = reads; return create(options); };
  try { await reserveMeta(w.client, w.coordinates, request, "late-binding"); }
  finally { restoreClient(); }
  assert.ok(lastRead > 0);
  const template = JSON.parse(String((await peer.get("late-template-reservation")).item.body)) as Record<string, JsonValue>;
  for (const boundary of ["validation", "create"] as const) for (const matching of [true, false]) {
    await t.test(`${boundary}:${matching}`, async () => {
    const id = `late-${boundary}-${matching}`; const key = `${id}-reservation`;
    const body = JSON.stringify({ ...template, id: key, binding: matching ? "late-binding" : "peer-binding" });
    let injected = false; let count = 0; let expected: readonly string[] = [];
    /** Commit with an independent ordinary writer at the actual SDK IO boundary. */
    async function inject(): Promise<void> {
      if (injected) return; injected = true;
      await peer.create({ id: key, type: "Decision", title: "Peer owns this reservation", tags: "rl-meta-reservation", body });
      const native = (await peer.get(key)).item.id;
      expected = [readFileSync(join(w.pmRoot, "decisions", `${native}.toon`), "utf8"), readFileSync(join(w.pmRoot, "history", `${native}.jsonl`), "utf8")];
    }
    client.get = (async (...args) => {
      try { return await get(...args); }
      finally { if (boundary === "validation" && args[0] === key && ++count === lastRead - 1) await inject(); }
    }) as PmClient["get"];
    client.create = async options => { if (boundary === "create" && options?.id === key) await inject(); return create(options); };
    try {
      const operation = reserveMeta(w.client, w.coordinates, { ...request, id }, "late-binding");
      if (matching) await operation; else await assert.rejects(operation, conflict);
    } finally { restoreClient(); }
    assert.ok(injected, `${boundary}:${matching}`);
    const native = (await peer.get(key)).item.id;
    assert.deepEqual([readFileSync(join(w.pmRoot, "decisions", `${native}.toon`), "utf8"), readFileSync(join(w.pmRoot, "history", `${native}.jsonl`), "utf8")], expected);
    if (matching) await reserveMeta(w.client, w.coordinates, { ...request, id }, "late-binding");
    else await assert.rejects(reserveMeta(w.client, w.coordinates, { ...request, id }, "late-binding"), conflict);
    });
  }
});


test("meta reservation preserves native create failures and converges on a writable retry", { skip: process.platform === "win32" || process.getuid?.() === 0 ? "Requires unprivileged POSIX directory permissions" : false }, async () => {
  const w = await processWorkspace(); const peer = peerFor(w);
  await peer.update(w.approval, { body: '```json\n' + JSON.stringify({ ...metaSpec, permitted_promotions: 10_000 }) + '\n```' });
  const request: MetaRequest = { id: "native-failure", config: { ...metaConfig, meta_generations: 1, candidates: 1 }, dataset: "unused", approval: w.approval, proposer: "seeded" };
  const directory = join(w.pmRoot, "decisions"); const mode = statSync(directory).mode & 0o7777;
  let prepared = false;
  try {
    chmodSync(directory, mode & ~0o222);
    await assert.rejects(reserveMeta(w.client, { ...w.coordinates, onTransition(context) { if (context.transition === "prepared") prepared = true; } }, request, "native-failure-binding"), /EACCES|permission/i);
  } finally { chmodSync(directory, mode); }
  assert.ok(prepared, "native creation must fail after validation and journal preparation");
  assert.equal((await peer.listAllComplete({ includeBody: true })).items.some(item => item.id === "rl-native-failure-reservation"), false);
  await reserveMeta(w.client, w.coordinates, request, "native-failure-binding");
  assert.ok((await peer.get("native-failure-reservation")).item.body);
});
