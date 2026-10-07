# Durable continuation and System One calibration

This slice extends the persisted loop from PR #61. Feature evidence is tracked in
[pm-rl-od32](../.agents/pm/features/pm-rl-od32.toon),
[pm-rl-qhz2](../.agents/pm/features/pm-rl-qhz2.toon) and
[pm-rl-ip21](../.agents/pm/features/pm-rl-ip21.toon).

## Controller persistence

`pm rl loop run <id> --file <programme> --approval <decision>` creates or resumes
that programme. A changed configuration under the same id conflicts. The seed
stores the validated programme; `pm rl loop resume <id> --approval <decision>`
reads it. `pm rl loop status <id>` reconstructs phases and samples without writes.
The SDK entry points are `runRlLoop`, `resumeRlLoop` and `rlLoopStatus`.

Each collection Run stores immutable configuration and merge-safe metric notes.
Candidate Generation items store actual parameters, digests, training evidence
and evaluation scores. Replay verifies these artifacts and appends only missing
metric suffixes. Logical samples are reconstructed from persisted batches;
rejected candidates retain spent budget. Existing promotion refusals are terminal.
An existing bandit candidate requires the complete collection batch to match its
deterministic receipt, including event count, sample identities, actions and
rewards. Lost, duplicated or rewritten collection notes make both status and
resume refuse with `loop_generation_drift`, including after promotion or refusal.
The System One HTTP adapter rejects fractional or unsafe input/output token counts
and an unsafe total with `systemone_endpoint_usage_invalid` before recording a
decision. Zero counts and totals up to the maximum safe integer are accepted.
The SDK transaction coordinator admits each promotion and charges the governing
Decision once. Cancellation stops at a phase boundary or aborts an HTTP request;
completed artifacts remain available to resume. `onPhase` provides observation
at completed collect/train/evaluate/promote boundaries.

Controllers acquire SDK `acquireLock` leases before creating job artifacts and
claim the seed through the SDK. An SDK recovery mutex serializes abandoned-lease
inspection, dead-identity cleanup and acquisition. Lease records bind hostname,
PID and process start time; recovery never uses elapsed lease age. Before any
lock acquisition, the controller must determine its own birth time or refuse
with `loop_identity_unavailable`; `--force-takeover` cannot bypass this check.
Restore the OS process-start tooling or access and retry. The captured birth time
is reused for the lease and claim. The enriched SDK record is written to an
exclusive same-directory temporary file, then renamed into place under the
recovery mutex; no recovery can consume a partially written identity.
Linux start
time combines field 22 of the process stat record, clock ticks from `getconf CLK_TCK`
and the kernel boot epoch ([process stat](https://www.man7.org/linux/man-pages/man5/proc_pid_stat.5.html),
[boot time](https://www.man7.org/linux/man-pages/man5/proc_stat.5.html)). A reused PID
whose birth time differs is a dead holder. macOS and other Unix systems use
`ps -p <pid> -o lstart=` with the C locale and UTC timezone; this signal has
one-second precision, so PID reuse within that second may be indistinguishable
and remain blocked. Operators must verify the original controller has stopped
and wait for the unrelated process to exit before retrying resume;
do not kill an unrelated process merely to clear the lease. Windows uses
PowerShell `Get-Process` and its UTC `StartTime`
in round-trip format. These portable probes depend on OS tooling and access;
different hostnames and malformed records are ambiguous and never recover
automatically. A live local PID with an unavailable birth-time probe or missing
stored identity blocks even explicit takeover, including legacy SDK records
without host metadata. EPERM cannot prove death and does not authorize takeover.

Refusals name the tracker-relative lock path and the exact
`pm rl loop resume <id> --approval <decision> --force-takeover` command. Operators
must first stop or otherwise exclude the previous controller, particularly for
shared filesystems. The flag explicitly recovers an ambiguous or stale lease and
records the forcing PM author, previous PID and identity digests in the seed's
append-only history before removing the old lease. A matching live identity
still blocks, even with the flag, including indistinguishable same-second reuse
on macOS/BSD. Restore probing and stop or exclude an unverifiable local holder
before forcing recovery. Claim receipts also retain PID, birth time and
a hostname digest; raw hostnames remain only in local lease files.

Standalone PM projects coordinate at their tracker root.
Git worktrees coordinate at shared repository metadata: an SDK tracker containing
Decision launch records and SDK leases under `pm-rl-controllers`. Launch records
store an opaque digest of the canonical real tracker path, never its path.
Symlink aliases share this identity. A launch refusal names the authority Decision
item and the canonical digest needed to reassign its body in the shared controller
tracker after stopping all controllers and verifying the persisted artifacts.
A losing
worktree creates no duplicate job artifacts. Merge the winning artifacts before
using that id elsewhere. These receipts are local coordination state and must be
retained along with repository metadata; separate clones/machines require a shared
scheduler. The model parameters and lineage remain in the tracked PM project.

## Decision-model contract

Select `trainer: "systemone"`. `decision_model` supplies `base_url`, `model` and
`timeout_ms` (1–600000 ms). Requests use plain fetch:

```json
{"model":"tev1:4b","state":"# Item title\n\nItem description","questions":{"kind":{"type":"choice","instructions":"Route the item","criteria":{"Bug":"Repair a defect","Feature":"Add functionality"}}}}
```

The response must contain exactly the requested choice answers, finite normalized
`probabilities` for every option, and nonnegative token usage in
`usage.input_tokens`/`usage.output_tokens`. A response may include a `type` marker;
a foreign type refuses. `noul` and `score` are not trainable by this choice head.
Errors and timeouts leave completed decision notes intact. Caller AbortSignal,
SIGINT and SIGTERM stop progression. Endpoint latency is measured through body
receipt and persisted per decision, separately from controller wall time.

`training` and `evaluation` contain `{id,title,description,labels}` items. Labels
map each question name to a declared option. Identities must be unique and disjoint;
held-out labels never enter the head fit. Duplicate content under different ids
still requires dataset curation. The `questions` map supplies choice instructions
and criteria; no prompt contains the known label. The frozen model never updates.
The learned policy has one log temperature and one additive bias per answer option
per question. Full-batch analytic cross-entropy gradients update the head;
checkpoint SHA-256 binds its actual finite, bounded parameters and question shape.

Shared programme bounds are `seed`, `max_generations` (1–100),
`samples_per_generation`, `budget` (up to 100000 logical decision queries),
`learning_rate` (0.01–1), `minimum_improvement` (>0), `maximum_gap` (>=0),
`evaluation_samples` (1–100000 sampled answer episodes), `confidence` (0–1 exclusive)
and `min_samples`. `fit_steps` is bounded to 1–10000. Optional `initial_head` stores
`log_temperature` and `biases`; omission uses the neutral head. Each generation
charges collection queries plus one query per held-out item. Evaluation episodes
resample head actions on these fixed decisions; they are not independent dataset
items or additional model calls. Hoeffding bounds concern conditional action reward
on this fixed dataset. They do not establish generalization to unseen PM items.

Promotion requires a changed checkpoint, strictly better held-out expected reward,
an acceptable training/held-out gap, the existing sampled statistical gate and
transactional provenance/budget guards. Invalid shape, nonfinite parameters,
tampered digests, foreign decision prefixes and contamination refuse progression.

The pure SDK surface includes `parseSystemOneLoopConfig`, `validatedSystemOneDatasets`,
`neutralSystemOneHead`, `parseSystemOneHeadParameters`, `jsonHeadParameters`,
`systemOneCheckpoint`, `calibratedProbabilities`, `fitSystemOneHead`,
`sampleSystemOneActions`, `systemOneSampleSeed`, `executeSystemOneStep`,
`systemOneAccuracy`, `systemOneCalibrationError`, `systemOneEnvironmentSpec`,
`systemOneRunConfig`, `systemOneGenerationTrainingConfig`, `systemOneSeedTrainingConfig`,
`systemOnePromotionScores`, `parseStoredSystemOneGeneration`,
`verifyStoredSystemOneGeneration`, `systemOneDecisionEvent`,
`parseSystemOneDecisionEvent`, `systemOneState` and `requestSystemOneDecision`.
Trainer selection uses `parseLoopTrainer`/`parseLoopProgramme`; bandit replay uses
`parseStoredLoopGeneration`/`verifyStoredLoopGeneration`.

## Acceptance and limits

`npm run test:live` runs two real generations on synthetic PM items, checks changed
checkpoints and successor collection, and prints per-generation accuracy/ECE,
conditional held-out means, reported tokens, endpoint latency and wall time.
`SYSTEMONE_BASE_URL` and `SYSTEMONE_MODEL` override the loopback service and
`tev1:4b` defaults. CI calls the same controller with real deterministic HTTP
servers. It never mocks fetch or requires Ollama.

The first live run measured accuracy 1.0 → 1.0, ECE 0.332981 → 0.292739 → 0.241165,
held-out means 0.66375 → 0.70685 and 0.709475 → 0.761025, eight requests,
1094 reported tokens and 23189.12 ms wall time. A repeat run produced the same
accuracy, ECE, checkpoints and token counts: 26157.71 ms wall time and
23302.17 ms endpoint time (2912.77 ms per query). The starting head deliberately
softens model probabilities (log temperature 2), making the bounded calibration
experiment explicit. The held-out split contains two synthetic items and repeated
selection is adaptive validation; it is not an independent final benchmark.

## Recoverable external decision receipts

[pm-rl-9nlg](../.agents/pm/issues/pm-rl-9nlg.toon) implements the HTTP-to-PM
recovery contract. Enable it only for an endpoint that supports:

```json
{"decision_model":{"base_url":"http://127.0.0.1:8080","model":"tev1:4b","timeout_ms":10000,"receipt_protocol":"idempotency-v1"}}
```

Before inference, the controller commits a random UUID namespace as a Run
comment. Retain this comment with the run and its history. Each query key is a
SHA-256 digest of the namespace, programme digest, collecting checkpoint, metric
(collection or held-out) and query index. The programme binds the endpoint,
model, questions and datasets. Independent tracker runs receive separate
namespaces; resumed or moved/copied tracked runs reuse their persisted namespace.
The namespace is established under the existing controller lease. The POST
includes `receipt_protocol: "idempotency-v1"`, `request_id` and the same value in
the `Idempotency-Key` header, alongside the existing request fields.

The endpoint must atomically register a key before executing inference, serialize
concurrent submissions of that key, and retain its immutable result for the full
lifetime of resumable runs. A repeated identical request returns that result
without another physical inference or charge. A reused key with different inputs
must fail with HTTP 409; an expired or unavailable receipt must fail closed,
never silently execute a new inference. Its successful JSON response contains:

```json
{
  "request_id":"sha256:<the request digest>",
  "decision_id":"<unique immutable inference identity>",
  "physical_requests":1,
  "answers":{"kind":{"probabilities":{"Bug":0.6,"Feature":0.4}}},
  "usage":{"input_tokens":10,"output_tokens":1,"latency_ms":12}
}
```

`decision_id` is a nonblank trimmed string of at most 256 characters. Usage and
latency describe the original inference, including on a retry. Token counts and
their sum must be nonnegative safe integers; latency must be finite and
nonnegative. Responses missing or disagreeing with this contract refuse before
PM persistence. The metric event retains both identities, `physical_requests`,
individual input/output counts, their total and original latency. Status and
resume verify the content-bound key, accounting and unique decision identities
within each run before advancing. Stored counts and latency must use the
canonical strings written by the package; padded or malformed representations
refuse. Sum `physical_requests`, `input_tokens` and
`output_tokens` over the run's receipt events to reconcile inference spending;
HTTP retries are transport attempts and are not additional inferences. A
partial run can have an unresolved remote receipt that status cannot yet count:
resume retrieves it and commits the missing event before advancing.

A crash before dispatch spends nothing. A lost response, timeout, cancellation,
or hard kill after remote completion leaves the key recoverable at the endpoint.
A kill after receiving the receipt but before PM persistence retrieves the same
receipt on resume. A kill after PM persistence skips the existing event. No local
response cache or invented tracker lock is needed. `RlLoopRequest.onDecision`
observes `request`, `response` and `commit` boundaries for interruption drills.

`test/decision-recovery.test.ts` uses the built package, real temporary SDK
trackers and local HTTP servers. SIGKILL drills cover both collection and
held-out queries at each boundary: before dispatch, remote completion before
body delivery, parsed response before PM commit and committed PM event. Separate
tests drop the HTTP connection/body, time out and cancel completed remote work,
reject corrupted receipt evidence, and distinguish independent run namespaces.
Eight decisions retain eight physical inferences and 88 tokens, with zero new
requests on terminal resume. Legacy endpoints remain supported by omitting
`receipt_protocol`; their unresolved HTTP-to-PM window still permits repeated
inference and cannot establish exactly-once remote spending. The guarantee for
opted-in endpoints depends on their durable atomic idempotency contract, not on
an arbitrary service accepting the header. No real external service is invoked
by these tests. No GPU scheduling, base-model fine-tuning, distributed clone
coordination, independent benchmark, storage cap or token-budget reservation is
claimed here.

## Behavioral regression proof

Restore only the pre-fix bodies of `requestSystemOneDecision` in `systemone.ts`
and `verifyDecisionPrefix` in `index.ts` from the base revision. Retain current
API signatures, namespace persistence, decision boundary callbacks, exports and
all tests. Build the package, then run:

```sh
node --test --test-name-pattern="built receipt recovery|SIGKILL|received headers" test/decision-recovery.test.ts
```

The build succeeds and all three tests execute and fail on physical request
accounting: **9 actual versus 8 expected**, including a real SIGKILL after remote
completion. Restore the fixed bodies and rebuild before running the full suite.
The proof changes behavior without deleting test seams or causing load/type
failures. The initial unmodified-package reproduction also failed at 9 versus 8.
Restoring only the earlier `verifySystemOneReceiptEvent` body also builds and
makes the real-tracker corruption test fail with `Missing expected rejection:
input-leading-zero`. Restoring the canonical validator rejects padded token
strings before any further HTTP request.

## Package verification

The earlier continuation slice passed 398 tests with `npm run release:check`, zero failures/skips, and exact
100% statements, lines, branches and functions across all 23 authored source
files, including operational scripts. Coverage ignores remain empty and every
threshold remains 100. Lint and strict TypeScript passed; duplication was zero;
all 203 declarations were documented. Identity and publish-attestation gates,
production audit (zero vulnerabilities), pack dry run and changelog check passed.
The documented changelog generator was run; open features produce no completed
release entries, so the existing changelog remains current.

Earlier adapter acceptance passed `bun run check`, `bun run build:test` and
`bun run docstring`. Separate
packed npm/Node and native Bun consumers each completed two promotions, eight
requests, eight charged logical samples, successor collection, checkpoint
validation and status/resume without further requests. The current release gate
includes 25 durable-loop tests, 8 adapter tests and 6 receipt-recovery tests. PM-linked commands
`node --test --test-name-pattern="terminal bandit candidates" test/durable-loop.test.ts`,
`node --test --test-name-pattern="real HTTP usage" test/systemone.test.ts` and
`node --test test/systemone.test.ts` passed. Earlier PM-linked full durability
(24 tests) and live-command (1 test) checks passed. Strict `pm health` passed with
two existing tracker advisories recorded in `pm-rl-9uz4`.
The live command is deliberately outside CI.

The PR #62 lease review regressions add real-process reused-PID recovery,
matching live-holder refusal despite an old lock timestamp, foreign-host refusal,
audited CLI force takeover, malformed/legacy identity recovery and preservation
of the old lease when its audit write fails. A real symlink alias reaches the same
Git worktree's launch authority. Re-review regressions prove own-probe failure
refuses before acquisition, unavailable live-holder probing or missing recorded
identity blocks forced takeover, and publication replaces the SDK record's inode
atomically while preserving its token and excluding recovery during the raw-record
window. The captured own birth time is shared with the claim receipt. PM-linked
full durability and focused identity commands passed 24 and 4 tests respectively.
Portable birth-time probes and SDK acquisition
failure paths have fixture coverage; native macOS and Windows execution was not
performed in this Linux validation run.
