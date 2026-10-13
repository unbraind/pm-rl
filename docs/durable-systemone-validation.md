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
SIGINT and SIGTERM stop progression. Legacy endpoint latency is measured through body
receipt and persisted per decision, separately from controller wall time.
Receipt mode persists the endpoint's original inference latency, including on
retrieval.

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
`parseSystemOneDecisionEvent`, `systemOneState`, `systemOneDecisionRequestId`,
`verifySystemOneReceiptEvent` and `requestSystemOneDecision`.
Trainer selection uses `parseLoopTrainer`/`parseLoopProgramme`; bandit replay uses
`parseStoredLoopGeneration`/`verifyStoredLoopGeneration`.

## Acceptance and limits

`npm run test:live` runs two real generations on synthetic PM items, checks changed
checkpoints and successor collection, and prints per-generation accuracy/ECE,
conditional held-out means, reported tokens, endpoint latency and wall time.
`SYSTEMONE_BASE_URL` and `SYSTEMONE_MODEL` override the loopback service and
`tev1:4b` defaults. CI calls the same controller with real deterministic HTTP
servers. It never mocks fetch or requires Ollama.

### CPU acceptance and retained receipts

The live command requires a local Ollama model configured with `num_gpu 0` and
`num_thread` from `1` to `4`. It verifies these parameters before any decision query,
pins the model inventory digest, and checks `/api/ps` after every response for
that digest and exactly zero GPU bytes before committing the decision. The
[Ollama System One handler](https://github.com/ollama/ollama/blob/main/server/routes.go)
does not pass generation options to the scheduler, so adding `num_gpu` to the
System One request would not establish CPU execution. Use a CPU-configured model
in an isolated local Ollama process; retain its writable model manifest and logs
under `.agents/pm/runtime/`. Existing weight blobs may be linked read-only.
`SYSTEMONE_BASE_URL` selects that process and `SYSTEMONE_MODEL` selects its model.
The default endpoint is loopback and the default model is `tev1:4b`; remote
endpoints and cloud model inventory entries refuse live acceptance.

The command has a parent watchdog that terminates its worker at 895000 ms and
escalates to SIGKILL after five seconds, enforcing the 15-minute process bound
even if an SDK operation stalls. A whole-run AbortSignal bounds metadata checks,
requests and controller phases
to **900000 ms (15 minutes)**. A cold model load may use up to 600000 ms of that
allowance; later requests inherit the same remaining whole-run deadline. The
trainer performs two bounded full-batch head fits over two collection items each,
with two held-out decision queries per generation and at most eight total
queries. Held-out sampling is bounded to the configured episode count, and the
existing statistical promotion threshold is unchanged.

Every invocation retains a unique artifact directory under
`.agents/pm/runtime/live/`, including a real SDK tracker and its append-only
history, artifact-local Git/controller authority, `programme.json`, canonical
checkpoint JSON files, `loop-report.json` and `summary.json`. Each checkpoint
file's actual SHA-256 must equal the policy digest; generation two's Run must
name generation one's promoted checkpoint as its collecting policy. The summary
includes all eight decision metric receipts, dataset/collection identities,
per-generation accuracy/ECE, conditional held-out means, episode counts,
promotion decisions, tokens and latency. Failed runs retain `failure.json` and
any partial PM evidence; a refused evaluation retains the unpromoted loop report.
Removing only the new `num_gpu` condition from `cpuModelEvidence` builds
successfully and makes `node --test --test-name-pattern="CPU validation"
test/live-systemone.test.ts` fail with **Missing expected rejection**. Restoring
the guard makes that real-HTTP test pass.

The package tracker records the public synthetic summary as PM evidence; model
weights, local process logs and runtime artifacts remain ignored.

Offline acceptance uses real HTTP servers and real trackers with an explicit
SDK `pmRoot`, avoiding ancestor discovery. It also checks GPU configuration and
runner refusal, unavailable metadata/model, non-200 inference, a shortened
whole-run deadline, overlapping labels, and persisted nonfinite/shape/hash
corruption before promotion. Unit/integration and release gates never contact
Ollama. The live command remains opt-in.

### Fresh CPU transcript (2026-10-13)

`SYSTEMONE_BASE_URL=http://127.0.0.1:11436 npm run test:live` completed against an
isolated CPU service using the existing frozen `tev1:4b` Q8_0 weight blob, with
four threads and `num_gpu 0`. All eight post-response status checks measured
zero GPU bytes. The CPU manifest digest is
`740fab438224f962f9f785f3b0d4479c82121980654e1e3df30499dc336d4337`;
the weight blob remains
`sha256:35f9281a3df58b566b24091572467001906a5a6aac879fe8005c4db19c8d4a2e`.

| Generation | Source policy | Candidate checkpoint | Held-out sampled mean | ECE | Promotion |
| --- | --- | --- | --- | --- | --- |
| 1 | `sha256:f40ae63747108d680e70fa6b092b50473fdea6ee3a65e81d717ce48d60881e25` | `sha256:0a0eeb54d990640fbdefad6f501b30df7ff94fe0a634f9a464247770568b2718` | 0.664375 → 0.70785 | 0.3319549522 → 0.2914266552 | promoted |
| 2 | `sha256:0a0eeb54d990640fbdefad6f501b30df7ff94fe0a634f9a464247770568b2718` | `sha256:9d499e5b1276d95e687bfafebdedca7a2820dafcd9cf94400727c2ca97621037` | 0.711 → 0.7624 | 0.2914266552 → 0.2395788277 | promoted |

Accuracy remained **1.0** in both generations. The real worker took
**838542.232476 ms (13m 58.54s)**; endpoint time was **771935.354015 ms**, or
**96491.919252 ms per query**. Eight requests reported **1094 tokens** (547 per
generation). Both policies used 40000 sampled held-out episodes at confidence
0.95, unchanged minimum improvement 0.001 and the existing promotion budget of
two. The terminal reason was `generation_limit`, with two promotions and no
refusal. Generation two's collection Run names generation one's candidate as
its collecting policy; its collection digest differs from generation one's.

The actual canonical JSON file hashes equal the checkpoint identities in the
table. The retained tracker contains both collection Runs, Generation artifacts,
eight per-query metric events and all phase Decision receipts. Full synthetic
summary receipts were copied through the PM CLI into notes on `pm-rl-ip21` and
`pm-rl-qhz2`. The CPU service was stopped after verification. Cold-load and
undersized CPU attempts earlier in this session failed closed before promotion;
their partial artifacts remain ignored. This is a two-item adaptive validation
split, with a deliberately softened initial head, and demonstrates a real
calibration parameter update and successor use. It is not an independent
benchmark or base-model fine-tuning result.

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

The SDK exposes these identities at `SystemOneDecisionResponse.usage.receipt`
as `SystemOneDecisionReceipt`.

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

PR #65 review comment 4213484429 adds a real-tracker completion regression:
the final held-out decision's commit callback removes the receipt namespace
after all four events have persisted. Completion refuses with
`loop_generation_drift` and `EXIT_CODE.CONFLICT` before prefix verification,
training, evaluation or promotion. The test verifies the event notes remain
unchanged and no candidate or evaluation item is created. Endpoints without
`receipt_protocol` keep their existing behavior.

Reverting only the new completion guard builds successfully and makes
`node --test --test-name-pattern="evidence completion refuses" test/decision-recovery.test.ts`
fail with `Missing expected rejection`; restoring the guard makes it pass.
The fixture is bounded to one generation so the revert reaches successful
completion rather than a later fault-injection callback.

The receipt recovery implementation and tests at `fe69f39` passed both
`npm run release:check` and `bun run release:check`: **439/439 tests per gate**,
zero failures/skips and exact **100% statements, lines, branches and functions**
across all **24 authored source files**, including operational scripts. Coverage
ignores remain empty and all thresholds remain 100. Both gates also passed strict
TypeScript, lint, zero duplication, all 227 documented declarations, identity
and publish-attestation checks, production audit with zero vulnerabilities,
pack dry run and changelog validation. The final guard correction then passed
440/440 tests per npm and Bun release gate on 2026-10-08. That day's PM-linked recovery and adapter
commands passed 7/7 and 8/8 tests. Both behavioral revert proofs are documented
above. Receipt guarantees are conditional on the supported endpoint contract;
these tests contact local synthetic servers only.

A documentation-only rerun on 2026-10-10 executed all seven recovery cases under
concurrent host load: five passed, one exceeded its existing 300-second deadline,
and one was cancelled after a missing temporary tracker caused an `ENOENT` error.
The worker retained handles after reporting the cases and was terminated after
26 minutes. This is a failed fresh receipt, not a replacement for the historical
passing gates. Source, tests and deadlines were unchanged; the recovery owner
remains open for a successful fresh run and required review.


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
includes 25 durable-loop tests, 8 adapter tests and 7 receipt-recovery tests. PM-linked commands
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
