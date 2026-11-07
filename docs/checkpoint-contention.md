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
live parent for at least 35 seconds, after both children have announced readiness. This
models an instrumented owner whose critical section exceeds the former wait.
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
| Controlled live-holder regression, final Node 26.13.0 verification | 1 failure / 1 run | 0 failures / 1 run |

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

The controlled hold establishes scheduling sensitivity. The unforced runs must
be reported separately: a non-reproduction does not measure the frequency of the
historical hosted failure. SDK issue
[#1516](https://github.com/unbraind/pm-cli/issues/1516) concerns contention
throughput and bounded waiting; this experiment establishes no additional SDK
defect. The installed SDK already exposes
`CommitWorkspaceTransactionOptions.lockWaitMs`.

Complete npm and Bun release gates remain CI certification work; targeted local
passes do not constitute full-suite or full-coverage certification.

Build, typecheck, test compilation and lint pass. Docstrings and duplication
checks pass (539 documented declarations across 62 sources; zero duplicates).
Pinned tracker health with CI-style home and Git configuration isolation passes
with existing advisories. The development environment's extension-version
warning remains tracked separately by `pm-rl-9uz4`.
