# Checkpoint promotion contention

Issue [#152](https://github.com/unbraind/pm-rl/issues/152) records one release-CI
failure where a checkpoint promoter exhausted a 30-second workspace-lock wait
while its owner remained alive. A bounded `lock_conflict` is a documented
retryable refusal, including in the existing promotion-budget contract
(`pm-rl-qix7`). It does not by itself establish a broken SDK lock.

The positive two-process fixture now reserves 120 seconds per lock acquisition,
the same duration as its existing fit cancellation signal. Its outer test limit
remains 900 seconds. A lock wait is a per-acquisition allowance, not an end-to-end
completion guarantee. Production waits, promotion budgets, trainer resources,
SDK pins and coverage thresholds are unchanged.

The companion regression holds the real `sdk-workspace-transaction` lock in the
live parent until a child proves at least 35 seconds of actual blocked acquisition.
Both children deliberately delay fitting by eight seconds after readiness and
`go`, exceeding the original fixture's five-second scheduling margin. A child
observes native lock-file opens without suppressing or replacing SDK operations:
the first `EEXIST` starts its monotonic clock, repeated failures establish it is
still blocked, and the successful open records the acquisition duration. The
parent releases only after the blocked witness exceeds 35 seconds, certifies its
original lease bytes immediately before release, and requires a successful
acquisition receipt exceeding 35 seconds too. Readiness and parent elapsed time
are never accepted as contention evidence. This models an instrumented owner
whose critical section exceeds the former wait.
The SDK also serializes approval preflight readers, so either the workspace lock
or the approval lock behind it can be the first bounded refusal.

Both cases use the same fixture implementation and real plain-directory
trackers. They require two successful promotion receipts, clean child exits,
the two original job identities without recovery attempts, exactly two training
charges, both promotion ledger roots, matching verified checkpoint contents and
one retained shared artifact after collection. Child exit rejects the receipt
wait immediately; cancellation and cleanup kill and reap remaining children.

## Deterministic sensitivity

On Node 26.13.0, changing only the fixture's `PM_LOCK_WAIT_MS` value back to
30 seconds in a disposable source copy makes the live-holder regression fail with
`lock_conflict`, `lock_owner_alive`, `waited_ms=30085` and zero owner handoffs.
The 120-second version passes on Node 24.19.0 and Node 26.13.0. The original
30-second version also failed a separate controlled run on Node 24.19.0 with
`waited_ms=30007`; an earlier equivalent Node 26 revert reported 30006 ms.

```sh
node --test --test-concurrency=2 \
  --test-name-pattern='two processes promote|outwait a healthy' \
  test/checkpoint-artifacts.test.ts
```

## Loaded repetitions

The unforced fixture is repeated serially, with one low-priority CPU load process
and the same V8 coverage instrumentation used by the release gate. Each
invocation limits test concurrency to two. This exercises the checkpoint test,
not the complete release suite or its aggregate coverage thresholds.

| Scenario | 30-second wait | 120-second wait |
| --- | --- | --- |
| Unforced loaded repetitions, Node 24.19.0 | 0 failures / 30 runs | 0 failures / 30 runs |
| Controlled live-holder regression, initial PR revision on Node 26.13.0 | 1 failure / 1 run | 0 failures / 1 run |

All 60 unforced invocations pass without skips, cancellations or lock-conflict
reports. The baseline retains the original 30-second bound while the fixture is
extracted into a shared helper; the corrected series retains the 120-second
bound throughout. A release-only fast-forward during the corrected series
changes version metadata. The final two-case Node 26 snapshot run passes 2/2
after that fast-forward and the final behavioral revert.

Per-invocation wall times range from 17.528 to 55.706 seconds before and 26.407
to 66.826 seconds after, with medians of 37.845 and 38.826 seconds respectively.
These include startup and coverage reporting; they are not lock-hold timings or
evidence of a performance improvement under variable shared load.

```sh
node --experimental-test-coverage --test --test-concurrency=2 \
  --test-name-pattern='two processes promote' test/checkpoint-artifacts.test.ts
```

These 60-run receipts and the initial revert timings describe the first PR
revision. Review identified that its parent timer could expire before a delayed
child had waited 30 seconds. The strengthened acquisition-witness regression
above closes that false-positive class; it does not replace or rerun those
historical experiments.

Two disposable behavioral reverts verify the strengthened regression. Restoring
only the 30-second lock wait fails with `lock_conflict`. Restoring only the
readiness-based parent release timer, while retaining the successful-acquisition
oracle, fails that oracle after the eight-second pre-fit delay. The latter
refusal catches the scheduling class independently of the lock-wait setting.

The controlled hold establishes scheduling sensitivity. The unforced runs must
be reported separately: a non-reproduction does not measure the frequency of the
historical hosted failure. SDK issue
[#1516](https://github.com/unbraind/pm-cli/issues/1516) concerns contention
throughput and bounded waiting; this experiment establishes no additional SDK
defect. The installed SDK already exposes
`CommitWorkspaceTransactionOptions.lockWaitMs`.

## Review scope

The package-wide audit covers production lock calls in `state-boundary.ts`,
`index.ts`, `checkpoint-artifacts.ts` and `evaluation-plan.ts`; SDK confinement
and adoption tests; promotion-budget and sequential-evaluation tests; controller
heartbeat and process polling barriers; and acceptance, packed npm/Bun and
compatibility consumers with JSON/TOON and plain-directory trackers. The shared
checkpoint fixture was the only minimum-contention-duration assertion inferred
from readiness plus a release timer. Other lock refusals execute real operations
while an owner is explicitly held; heartbeat and polling tests assert observed
state changes. The child-only observation protocol is not shipped in the package
and changes no CLI, SDK or serialized consumer contract.

## Review validation

The strengthened focused regression passes 2/2 through pinned pm snapshot
execution on Node 26.13.0 after both disposable reverts. Both checkpoint cases
also pass in each complete covered suite below. Full gates ran sequentially,
with the existing two-worker limit and unchanged coverage thresholds.

| Command | Policy tests | Suite tests | Passed | Failed | Cancelled | Skipped |
| --- | --- | --- | --- | --- | --- | --- |
| `npm run release:check` | 31/31 | 1511 | 1504 | 6 | 1 | 0 |
| `bun run release:check` | 31/31 | 1511 | 1510 | 1 | 0 | 0 |

Both commands exit 1, so neither is full release or coverage certification. The
npm HTTP crash drill reaches its existing 300000 ms timeout; five later HTTP
cases fail `uv_cwd` after fixture cleanup. Its idle socket-holding worker was
stopped after inactivity was verified, allowing all remaining results to report.
The HTTP file passes in the Bun attempt. Existing `pm-rl-local-gate-timing`
retains this failure; no HTTP source or timeout changes are part of this PR.

Both attempts fail the separately tracked packed LM CLI timing case
(`pm-rl-7c7m`). npm reaches the existing 25000 ms child timeout; Bun measures
20104 ms against the existing 20000 ms assertion. Total test setup-plus-run
times are 35734.588011 and 23619.436248 ms respectively and must not be called
measured CLI durations. These limits and all assertions are retained.

The Bun gate uses official Bun 1.3.14, matching CI, in a temporary runtime with
archive SHA-256
`951ee2aee855f08595aeec6225226a298d3fea83a3dcd6465c09cbccdf7e848f`.
The installed Bun 1.3.5 and package pins are unchanged; temporary runtime files
are removed after the run. Both gate test runners use Node 26.13.0.

Build, typecheck, test compilation and lint pass. Docstrings and duplication
checks pass (539 documented declarations across 62 sources; zero duplicates).
Pinned tracker health with CI-style home and Git configuration isolation passes
with existing advisories. The development environment's extension-version
warning remains tracked separately by `pm-rl-9uz4`.

Post-gate identity and production audits pass (zero production vulnerabilities),
as do package dry-run verification (260 files) and the changelog check. These
individual checks do not turn either failed full gate into release certification.
