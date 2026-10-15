/** Protocol, real child execution, atomic approved reservations and evidence corruption. */
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdirSync, symlinkSync, lstatSync, existsSync, rmSync, renameSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { commitProcessTransaction, withProcessJobFence, runRlLoop } from "../index.ts";
import { Readable, Writable } from "node:stream";
import { runReferenceTrainer, referenceTrainerMain, writeTrainerArtifact } from "../process-bandit.ts";
import { parseLoopProgramme, parseLoopConfig } from "../loop.ts";
import { test } from "node:test";
import { appendDiagnostics, executeProcessTrainer, launchTrainer, transitionProcessJob, stopTrainer, parseProcessAdapter, parseResources, processJobId, processStaging, readProcessJob, referenceTrainerArgv, reserveProcessJob, stagingBytes, validateProcessCompletion, verifiedProcessPolicy, type ProcessCompletion } from "../process.ts";
import { allowance, configuration, processWorkspace, trainingInput } from "./fixtures/process-workspace.ts";
// Node's parent coverage hooks remain active; SIGKILL-able children must not inherit its raw-report directory.
delete process.env["NODE_V8_COVERAGE"];

const adapter = { kind: "process-bandit", allowance } as const;
/** Only explicitly trusted test code selects fixture argv; tracker bodies never carry commands. */
function argv(mode: string): readonly string[] { return [process.execPath, new URL("./fixtures/process-trainer.ts", import.meta.url).pathname, mode]; }

test("resource vectors and packaged adapter require complete bounded declarations", () => {
  assert.deepEqual(parseResources(allowance), allowance);
  assert.deepEqual(parseProcessAdapter(adapter), adapter);
  for (const value of [null, [], 1]) { assert.throws(() => parseResources(value)); assert.throws(() => parseProcessAdapter(value)); }
  for (const key of Object.keys(allowance)) for (const value of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, null]) assert.throws(() => parseResources({ ...allowance, [key]: value }));
  for (const value of [{ ...adapter, kind: "shell" }, { ...adapter, argv: ["untrusted"] }, { ...adapter, allowance: { ...allowance, training_steps: 2 } }, { ...adapter, allowance: { ...allowance, wall_ms: 0 } }, { ...adapter, allowance: { ...allowance, wall_ms: 3600001 } }, { ...adapter, allowance: { ...allowance, storage_bytes: 0 } }, { ...adapter, allowance: { ...allowance, storage_bytes: 1073741825 } }]) assert.throws(() => parseProcessAdapter(value));
});

test("real trainer materializes changed weights and replays one settled reservation", async () => {
  const { client, coordinates, approval, pmRoot } = await processWorkspace(); const input = trainingInput();
  const first = await executeProcessTrainer(client, coordinates, input, approval, adapter);
  assert.equal(first.state, "materialized"); assert.equal(first.settled, true); assert.equal(first.charge.training_steps, 1);
  assert.notEqual(first.completion!.policy.digest, input.source.digest); assert.equal(first.charge.storage_bytes, stagingBytes(processStaging(pmRoot, first.id)));
  const history = readFileSync(join(pmRoot, "history", `rl-${first.id}.jsonl`), "utf8");
  assert.equal(history.split('\n').filter((line) => line.includes('"op":"create"')).length, 1);
  assert.deepEqual(await executeProcessTrainer(client, coordinates, input, approval, adapter), first);
  assert.equal(readFileSync(join(pmRoot, "history", `rl-${first.id}.jsonl`), "utf8"), history);
  assert.equal(verifiedProcessPolicy(first, pmRoot, input)!.digest, first.completion!.policy.digest);
  assert.equal(referenceTrainerArgv().length, 2);
});

test("atomic reservation-once survives concurrent replay and exhausted approval", async () => {
  const { client, coordinates, approval } = await processWorkspace(allowance); const input = trainingInput(); const id = processJobId(input);
  const reservations = await Promise.all([reserveProcessJob(client, coordinates, id, input, approval, allowance), reserveProcessJob(client, coordinates, id, input, approval, allowance)]);
  assert.deepEqual(reservations[0], reservations[1]); assert.equal(reservations[0].charge.training_steps, 1);
  assert.deepEqual(await reserveProcessJob(client, coordinates, id, input, approval, allowance), reservations[0]);
  // A job body re-serialized with different JSON spacing still holds its charge, and prose naming the format is not a job.
  await client.update(id, { body: JSON.stringify(reservations[0], null, 2) });
  await client.create({ type: "Task", title: "Prose mention", body: "This note mentions pm-rl/process-job/1 in prose." });
  await client.create({ type: "Task", title: "Foreign JSON", body: JSON.stringify({ note: "pm-rl/process-job/1" }) });
  await assert.rejects(reserveProcessJob(client, coordinates, processJobId({ ...input, identity: { foreign: true } }), { ...input, identity: { foreign: true } }, approval, allowance), /budget exhausted/);
  await assert.rejects(reserveProcessJob(client, coordinates, id, input, approval, { ...allowance, tokens: 1 }), /inputs changed/);
  await assert.rejects(reserveProcessJob(client, coordinates, id, { ...input, identity: { changed: true } }, approval, allowance), /inputs changed/);
  const other = await client.create({ id: "other", type: "Decision", title: "Other approval", body: `\`\`\`json\n${JSON.stringify({ permitted_promotions: 1, resource_budget: allowance })}\n\`\`\`` });
  await assert.rejects(reserveProcessJob(client, coordinates, id, input, other.item.id, allowance), /inputs changed/);
});

test("receipt-required, digest and storage failures retain artifacts and settle without eligible policies", async () => {
  for (const mode of ["empty", "checkpoint-only", "corrupt", "receipt-drift", "oversize", "invalid-event", "malformed", "channel", "stderr", "staging-link", "completion-link"]) {
    const { client, coordinates, approval, pmRoot } = await processWorkspace(); const input = trainingInput(); const command = argv(mode);
    await assert.rejects(executeProcessTrainer(client, coordinates, input, approval, adapter, undefined, command));
    const job = (await readProcessJob(client, processJobId(input, command)))!;
    assert.equal(job.state, "failed", mode); assert.equal(job.settled, true); assert.equal(job.charge.training_steps, 1);
    assert.throws(() => verifiedProcessPolicy(job, pmRoot, input), /Process job is failed/);
    await assert.rejects(executeProcessTrainer(client, coordinates, input, approval, adapter, undefined, command), /Process job is failed/);
  }
});

test("wall expiry and AbortSignal settle a running real child while retaining partial artifacts", async () => {
  for (const cancel of [false, true]) {
    const { client, coordinates, approval, pmRoot } = await processWorkspace(); const input = trainingInput(); const command = argv("hang"); const controller = new AbortController();
    const run = executeProcessTrainer(client, coordinates, input, approval, { ...adapter, allowance: { ...allowance, wall_ms: cancel ? 5000 : 2000 } }, controller.signal, command);
    if (cancel) {
      for (let attempt = 0; attempt < 200 && !existsSync(join(processStaging(pmRoot, processJobId(input, command)), "partial.json")); attempt += 1) await new Promise<void>((resolve) => { setTimeout(resolve, 10); });
      controller.abort();
    }
    await assert.rejects(run);
    const job = (await readProcessJob(client, processJobId(input, command)))!;
    assert.equal(job.state, cancel ? "cancelled" : "failed"); assert.equal(job.settled, true);
    assert.equal(readFileSync(join(processStaging(pmRoot, job.id), "partial.json"), "utf8"), "retained partial checkpoint");
  }
});

test("completion validation refuses foreign lineage, unsafe resources and unreadable staging", async () => {
  const { client, coordinates, approval, pmRoot } = await processWorkspace(); const input = trainingInput();
  const job = await executeProcessTrainer(client, coordinates, input, approval, adapter); const directory = processStaging(pmRoot, job.id);
  const receiptFile = join(directory, "completion.json"); const original = readFileSync(receiptFile, "utf8"); const completion = JSON.parse(original) as ProcessCompletion;
  for (const patch of [{ format: "foreign" }, { job: "foreign" }, { checkpoint: "../checkpoint.json" }, { training_config: {} }, { source_policy: "foreign" }, { lineage: {} }, { digest: "foreign" }, { policy: {} }, { usage: { ...completion.usage, training_steps: 0 } }, { usage: { ...completion.usage, storage_bytes: 0 } }, { usage: { ...completion.usage, tokens: 1 } }]) {
    writeFileSync(receiptFile, JSON.stringify({ ...completion, ...patch })); assert.throws(() => validateProcessCompletion(directory, job.id, input, allowance));
  }
  writeFileSync(receiptFile, original);
  assert.throws(() => validateProcessCompletion(directory, job.id, input, { ...allowance, storage_bytes: 200 }));
  assert.throws(() => verifiedProcessPolicy({ ...job, completion: { ...job.completion!, digest: "foreign" } }, pmRoot, input));
  mkdirSync(join(directory, "unexpected")); assert.throws(() => stagingBytes(directory));
  const second = join(directory, "link"); symlinkSync(receiptFile, second); assert.throws(() => stagingBytes(directory));
});


test("the shipped trainer writes real parameter updates and durable NDJSON receipts", async () => {
  const { root } = await processWorkspace(); const input = trainingInput(); let output = "";
  const stream = new Writable({ write(chunk: Buffer, _encoding, callback) { output += String(chunk); callback(); } });
  await runReferenceTrainer(Readable.from([JSON.stringify({ job: "standalone", input })]), stream, root);
  const events = output.trim().split('\n').map((line) => JSON.parse(line) as { type: string });
  assert.deepEqual(events.map((event) => event.type), ["progress", "complete"]);
  assert.throws(() => writeTrainerArtifact(join(root, "checkpoint.json"), {}), /EEXIST/);
  assert.throws(() => parseLoopProgramme({ trainer: "lm", adapter }));
  assert.throws(() => parseLoopProgramme({ trainer: "systemone", adapter }));
});


test("real transaction compensation releases a reservation and restores an interrupted transition", async () => {
  const { client, coordinates, approval } = await processWorkspace(); const input = trainingInput(); const id = processJobId(input);
  await assert.rejects(reserveProcessJob(client, { ...coordinates, onTransition(context) { if (context.transition === "step_applied") throw new Error("reservation interruption"); } }, id, input, approval, allowance), /reservation interruption/);
  const compensated = (await readProcessJob(client, id))!; assert.equal(compensated.state, "failed"); assert.equal(compensated.charge.training_steps, 0); assert.equal(compensated.settled, true);
  const alternate = { ...input, identity: { alternative: true } }; const nextId = processJobId(alternate);
  const planned = await reserveProcessJob(client, coordinates, nextId, alternate, approval, allowance);
  await assert.rejects(transitionProcessJob(client, { ...coordinates, onTransition(context) { if (context.transition === "step_applied") throw new Error("transition interruption"); } }, planned, "running", "launch"), /transition interruption/);
  assert.equal((await readProcessJob(client, nextId))!.state, "planned");
  assert.deepEqual(await transitionProcessJob(client, coordinates, planned, "planned", "ignored"), planned);
  await assert.rejects(transitionProcessJob(client, coordinates, planned, "promoted", "illegal"), /Illegal process job transition/);
});

test("budget and job identity drift refuse execution through real tracker reads", async () => {
  const { client, coordinates, approval, pmRoot } = await processWorkspace(); const input = trainingInput(); const id = processJobId(input);
  const job = await reserveProcessJob(client, coordinates, id, input, approval, allowance);
  const original = JSON.stringify(job);
  for (const patch of [{ format: "foreign" }, { id: "foreign" }, { state: "foreign" }, { settled: "foreign" }, { charge: { ...allowance, training_steps: 0 } }]) {
    await client.update(id, { body: JSON.stringify({ ...job, ...patch }) }); await assert.rejects(readProcessJob(client, id));
  }
  await client.update(id, { body: original });
  assert.throws(() => verifiedProcessPolicy({ ...job, input: "foreign" }, pmRoot, input));
  const approvalItem = await client.get(approval); await client.update(approval, { body: String(approvalItem.item.body).replace('"training_steps":2', '"training_steps":3') });
  await assert.rejects(reserveProcessJob(client, coordinates, id, input, approval, allowance), /budget identity changed/);
  for (const type of ["Task", "Decision"]) {
    const result = await client.create({ id: `wrong-${type}`, type, title: `Invalid ${type}`, body: type === "Task" ? String(approvalItem.item.body) : "no fence" });
    await assert.rejects(reserveProcessJob(client, coordinates, processJobId({ ...input, identity: type }), { ...input, identity: type }, result.item.id, allowance));
  }
  const path = join(pmRoot, "tasks", `rl-${id}.toon`); renameSync(path, `${path}.retained`); mkdirSync(path);
  try { await assert.rejects(readProcessJob(client, id)); } finally { rmSync(path, { recursive: true }); renameSync(`${path}.retained`, path); }
});

test("standalone SDK execution also launches one child under contention", async () => {
  const { client, coordinates, approval } = await processWorkspace(); const input = trainingInput();
  const [first, second] = await Promise.all([executeProcessTrainer(client, coordinates, input, approval, adapter), executeProcessTrainer(client, coordinates, input, approval, adapter)]);
  assert.deepEqual(first, second); assert.equal(first.charge.training_steps, 1);
});

test("a running job with no staged completion fails safely, and native spawn errors settle", async () => {
  const { client, coordinates, approval } = await processWorkspace(); const input = trainingInput(); const id = processJobId(input);
  const planned = await reserveProcessJob(client, coordinates, id, input, approval, allowance); await transitionProcessJob(client, coordinates, planned, "running", "interrupted before spawn");
  await assert.rejects(executeProcessTrainer(client, coordinates, input, approval, adapter), /no completion receipt/);
  assert.equal((await readProcessJob(client, id))!.state, "failed");
  const missing = ["missing-trainer-executable"];
  await assert.rejects(executeProcessTrainer(client, coordinates, { ...input, identity: "missing-executable" }, approval, adapter, undefined, missing), /ENOENT/);
});

test("native child identity failure and PID reuse do not authorize an unrelated stop", async () => {
  const { root } = await processWorkspace(); const input = trainingInput(); const directory = join(root, "native"); mkdirSync(directory);
  const path = process.env["PATH"]; process.env["PATH"] = "";
  try { await assert.rejects(launchTrainer(directory, "native", input, allowance, argv("hang")), /Cannot establish trainer process identity/); }
  finally { process.env["PATH"] = path; }
  stopTrainer(process.pid, "foreign birth time");
  assert.equal(process.pid > 0, true);
});


test("NDJSON event ordering, final accounting and native pipe failures are enforced with real children", async () => {
  for (const mode of ["progress-excess", "progress-regress", "complete-regress", "foreign-event", "stream-disagreement", "partial-line", "extra-event", "nonzero"]) {
    const { client, coordinates, approval } = await processWorkspace({ ...allowance, training_steps: 2, tokens: 2 }); const input = trainingInput();
    const limits = mode.includes("regress") ? { ...allowance, tokens: 1 } : allowance;
    await assert.rejects(executeProcessTrainer(client, coordinates, input, approval, { ...adapter, allowance: limits }, undefined, argv(mode)));
    assert.equal((await readProcessJob(client, processJobId(input, argv(mode))))!.state, "failed");
  }
  const { client, coordinates, approval, pmRoot } = await processWorkspace(); const input = trainingInput();
  const job = await executeProcessTrainer(client, coordinates, input, approval, adapter, undefined, argv("stderr-small"));
  assert.equal(readFileSync(join(processStaging(pmRoot, job.id), "stderr.log"), "utf8"), "retained diagnostics");
  const directory = join(pmRoot, "runtime", "pipe"); mkdirSync(directory);
  await assert.rejects(launchTrainer(directory, "pipe", { ...input, identity: "x".repeat(1000000) }, allowance, [process.execPath, "-e", "process.stdin.destroy();process.exit(0)"]));
});

test("every budget dimension is checked atomically before a child can launch", async () => {
  for (const key of Object.keys(allowance) as Array<keyof typeof allowance>) {
    const limits = key === "tokens" ? { ...allowance, tokens: 1 } : allowance;
    const { client, coordinates, approval } = await processWorkspace({ ...allowance, [key]: Math.max(0, limits[key] - 1) });
    await assert.rejects(reserveProcessJob(client, coordinates, processJobId(trainingInput()), trainingInput(), approval, limits), /budget exhausted/);
    assert.equal((await client.listAllComplete({})).items.filter((item) => item.type === "Task").length, 0);
  }
});


test("checkpoint schema size, actual wall use and malformed resource evidence fail closed", async () => {
  const { client, coordinates, approval, pmRoot } = await processWorkspace(); const input = trainingInput(); const job = await executeProcessTrainer(client, coordinates, input, approval, adapter);
  const directory = processStaging(pmRoot, job.id); const checkpoint = join(directory, "checkpoint.json"); const receiptPath = join(directory, "completion.json"); const runnerPath = join(directory, "runner.json");
  const receipt = JSON.parse(readFileSync(receiptPath, "utf8")) as ProcessCompletion;
  const originalCheckpoint = readFileSync(checkpoint); const originalReceipt = readFileSync(receiptPath); const runner = JSON.parse(readFileSync(runnerPath, "utf8")) as { pid: number; start: string; started_at: number };
  for (const policy of [{ weight: null, digest: "foreign" }, { weight: 21, digest: "foreign" }, { weight: 1, digest: "foreign" }]) {
    const bytes = Buffer.from(JSON.stringify(policy)); writeFileSync(checkpoint, bytes);
    writeFileSync(receiptPath, JSON.stringify({ ...receipt, policy, digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}` }));
    assert.throws(() => validateProcessCompletion(directory, job.id, input, allowance), /parameters are invalid/);
  }
  writeFileSync(checkpoint, " ".repeat(4097)); writeFileSync(receiptPath, originalReceipt); assert.throws(() => validateProcessCompletion(directory, job.id, input, allowance), /schema bound/);
  writeFileSync(checkpoint, originalCheckpoint); writeFileSync(runnerPath, JSON.stringify({ ...runner, started_at: Math.floor(lstatSync(receiptPath).mtimeMs) - 6000 }));
  assert.throws(() => validateProcessCompletion(directory, job.id, input, allowance), /observed wall/);
  assert.ok(referenceTrainerArgv(new URL("../dist/process.js", import.meta.url).href)[1].endsWith("process-bandit.js"));
  const badReceipt = join(directory, "completion.json"); writeFileSync(badReceipt, "x".repeat(70000)); assert.throws(() => validateProcessCompletion(directory, job.id, input, { ...allowance, storage_bytes: 131072 }), /staging storage/);
  
  await client.update(job.id, { body: JSON.stringify({ ...job, charge: { ...job.charge, tokens: 1 } }) }); await assert.rejects(readProcessJob(client, job.id), /accounting drifted/); await client.update(job.id, { body: JSON.stringify(job) });
});

test("process transaction owner probes refuse unavailable OS identity without effects", async () => {
  const { coordinates } = await processWorkspace(); const path = process.env["PATH"]; process.env["PATH"] = "";
  try {
    await assert.rejects(commitProcessTransaction({ ...coordinates, transactionId: "unavailable", steps: [] }), /process transaction identity/);
    await assert.rejects(withProcessJobFence(coordinates, "unavailable", async () => 1), /trainer owner identity/);
  } finally { process.env["PATH"] = path; }
});

test("oversized durable completion refuses before parsing and preserves failed-job evidence", async () => {
  const { client, coordinates, approval } = await processWorkspace({ ...allowance, storage_bytes: 131072 }); const input = trainingInput(); const command = argv("large-receipt");
  await assert.rejects(executeProcessTrainer(client, coordinates, input, approval, { ...adapter, allowance: { ...allowance, storage_bytes: 131072 } }, undefined, command));
  assert.equal((await readProcessJob(client, processJobId(input, command)))!.state, "failed");
});


test("approval aliases share one physical budget and the same reservation identity", async () => {
  const { client, coordinates, approval } = await processWorkspace(allowance); const input = trainingInput(); const id = processJobId(input);
  const alias = approval.replace(/^rl-/, ""); const first = await reserveProcessJob(client, coordinates, id, input, alias, allowance);
  assert.equal(first.approval, approval); assert.deepEqual(await reserveProcessJob(client, coordinates, id, input, approval, allowance), first);
  const other = { ...input, identity: "separate job" };
  await assert.rejects(reserveProcessJob(client, coordinates, processJobId(other), other, approval, allowance), /budget exhausted/);
});


test("a real staging creation failure releases the unlaunched reservation with a failed outcome", async () => {
  const { client, coordinates, approval, pmRoot } = await processWorkspace(); const input = trainingInput();
  mkdirSync(join(pmRoot, "runtime/pm-rl"), { recursive: true }); writeFileSync(join(pmRoot, "runtime/pm-rl/jobs"), "blocked staging directory");
  await assert.rejects(executeProcessTrainer(client, coordinates, input, approval, adapter));
  const job = (await readProcessJob(client, processJobId(input)))!; assert.equal(job.state, "failed"); assert.equal(job.settled, true); assert.equal(job.charge.training_steps, 0);
});


test("malformed wall identity and terminal candidates cannot supply an executable policy", async () => {
  const { client, coordinates, approval, pmRoot } = await processWorkspace(); const input = trainingInput(); const job = await executeProcessTrainer(client, coordinates, input, approval, adapter);
  const directory = processStaging(pmRoot, job.id); const runnerPath = join(directory, "runner.json"); const original = readFileSync(runnerPath, "utf8");
  const runner = JSON.parse(original) as { started_at: number };
  for (const value of [null, 0, Date.now() + 60000]) { writeFileSync(runnerPath, JSON.stringify({ ...runner, started_at: value })); assert.throws(() => validateProcessCompletion(directory, job.id, input, allowance), /wall identity/); }
  writeFileSync(runnerPath, "x".repeat(4097)); assert.throws(() => validateProcessCompletion(directory, job.id, input, allowance), /identity metadata/);
  writeFileSync(runnerPath, original);
  assert.throws(() => verifiedProcessPolicy({ ...job, state: "failed" }, pmRoot, input), /Process job is failed/);
  assert.equal(verifiedProcessPolicy({ ...job, state: "failed" }, pmRoot, input, true)!.digest, job.completion!.policy.digest);
});


test("UTF-8 NDJSON survives split multibyte chunks without corrupting retained events", async () => {
  const { client, coordinates, approval, pmRoot } = await processWorkspace(); const input = trainingInput(); const job = await executeProcessTrainer(client, coordinates, input, approval, adapter, undefined, argv("unicode"));
  assert.equal(job.state, "materialized"); assert.ok(readFileSync(join(processStaging(pmRoot, job.id), "events.ndjson"), "utf8").includes("café"));
});


test("the reference entry dispatcher executes the same numerical trainer with explicit real IO", async () => {
  const { root } = await processWorkspace(); let text = ""; const output = new Writable({ write(chunk: Buffer, _encoding, callback) { text += String(chunk); callback(); } });
  const url = new URL("../process-bandit.ts", import.meta.url); const input = Readable.from([JSON.stringify({ job: "entry", input: trainingInput() })]);
  await referenceTrainerMain([process.execPath, url.pathname], url.href, input, output, root);
  assert.ok(text.includes('"type":"complete"'));
});


test("renamed held-out copies are rejected before any process reservation", async () => {
  const { client, coordinates, approval } = await processWorkspace(); const parsed = parseLoopConfig(configuration); const example = parsed.training[0];
  const contaminated = { ...configuration, evaluation: [{ id: "held-out-copy", feature: example.feature, rewards: [...example.rewards] }] };
  assert.throws(() => parseLoopConfig(contaminated), /content overlap/);
  await assert.rejects(runRlLoop(client, coordinates, { id: "contamination", approval, config: contaminated }), /content overlap/);
  assert.equal((await client.listAllComplete({})).items.filter((item) => item.type === "Task").length, 0);
});


test("identity publication failure stops the real child and settles without overwriting retained metadata", async () => {
  const { client, coordinates, approval, pmRoot } = await processWorkspace(); const input = trainingInput(); const id = processJobId(input);
  const directory = processStaging(pmRoot, id); mkdirSync(directory, { recursive: true }); const path = join(directory, "runner.json"); writeFileSync(path, "retained identity collision");
  const start = performance.now(); await assert.rejects(executeProcessTrainer(client, coordinates, input, approval, adapter), /EEXIST/);
  assert.ok(performance.now() - start < 5000); const job = (await readProcessJob(client, id))!; assert.equal(job.state, "failed"); assert.equal(job.settled, true);
  assert.equal(readFileSync(path, "utf8"), "retained identity collision");
});

test("a diagnostics write failure becomes a refusal instead of escaping the stream callback", () => {
  // A missing directory fails the append even for root, which ignores file permission bits.
  const refused: unknown[] = [];
  appendDiagnostics(join(processStaging("/nonexistent-pm-rl-root", "absent"), "stderr.log"), Buffer.from("diagnostic"), (error) => { refused.push(error); });
  assert.equal(refused.length, 1); assert.equal((refused[0] as NodeJS.ErrnoException).code, "ENOENT");
});

test("a job body copied into another task neither double-charges nor names a missing job", async () => {
  const doubled = Object.fromEntries(Object.entries(allowance).map(([key, value]) => [key, value * 2])) as typeof allowance;
  const { client, coordinates, approval } = await processWorkspace(doubled); const input = trainingInput();
  const held = await reserveProcessJob(client, coordinates, processJobId(input), input, approval, allowance);
  await client.create({ type: "Task", title: "Copied job", body: JSON.stringify(held) });
  await client.create({ type: "Task", title: "Dangling job", body: JSON.stringify({ ...held, id: "process-missing" }) });
  const second = { ...input, identity: { second: true } };
  assert.equal((await reserveProcessJob(client, coordinates, processJobId(second), second, approval, allowance)).state, "planned");
});

test("the workspace writer lock carries a recoverable phase identity from its creation", async () => {
  const { coordinates, pmRoot } = await processWorkspace(); let owner = "";
  const noop = { id: "noop", async inspect() { return { state: "applied" as const }; }, async apply() { return undefined; }, async compensate() { return undefined; } };
  await commitProcessTransaction({ ...coordinates, transactionId: "owner-probe", steps: [noop], onTransition(context) {
    if (context.transition === "prepared") owner = String((JSON.parse(readFileSync(join(pmRoot, "locks", "sdk-workspace-transaction.lock"), "utf8")) as { owner?: unknown }).owner);
  } });
  assert.match(owner, /^pm-rl-phase:[0-9a-f]+:[A-Za-z0-9_-]+:/);
});
