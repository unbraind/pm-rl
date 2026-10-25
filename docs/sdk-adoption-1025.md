# Controller SDK adoption prerequisites

The 2026-10-25 audit identified native lock recovery and transaction lock
identity publication in `index.ts`. Neither can be removed safely with this
package's pinned `@unbrained/pm-cli@2026.10.20`. Queue rules prohibit changing
that pin. This candidate records both blockers and executable regression
proofs; it makes **zero production replacements and deletes zero production
lines**. Existing controller, trainer and resource behavior is unchanged.

Tracking: [pm-rl-sdk-adoption-1025](https://github.com/unbraind/pm-rl/blob/main/.agents/pm/tasks/pm-rl-sdk-adoption-1025.toon).
Related historical SDK adoption:
[pm-rl-hncb](https://github.com/unbraind/pm-rl/blob/main/.agents/pm/chores/pm-rl-hncb.toon).

| Audit finding | Named SDK replacement | Disposition and evidence |
| --- | --- | --- |
| `index.ts:2757-2877`: native lock reads, enrichment, expiry and identity recovery | `acquireLock`, `acquireLockLease`, `LockLease.fence` | Retained. Pinned `acquireLock` provides token-owned release and bounded waiting, but TTL-only main-lock recovery. `acquireLockLease` and `LockLease` are absent from the pinned public runtime. `test/sdk-adoption.test.ts` proves a demonstrably obsolete holder still blocks direct native acquisition while the existing phase fence recovers. |
| `commitProcessTransaction`: edit transaction mutex identity at preparation | `commitWorkspaceTransaction.onTransition` | Retained. The observer is already forwarded for every transition; it does not provide lock recovery. Direct pinned coordination refuses the dead transaction holder before `prepared`, whereas the wrapper recovers and emits all five forward transitions. |

The published **2026.10.25** npm archive was inspected separately without
installing it into the package. Its public runtime exports `acquireLockLease`
and `LockLease`; declarations document same-host original-process early
recovery and `LockLease.fence`. Thus these are **pin prerequisites**, not missing
APIs in the current SDK, and do not warrant duplicate upstream API requests.
After the normal dependency update, replace only native mutex ownership and
recovery, then re-run the controller crash/takeover suite. Preserve distinct
trainer authority, resource limits, shared controller authority, operator
recovery rules and cross-process behavior.

The pinned public namespace probe is reproducible:

```sh
node --input-type=module - <<'JS'
import * as runtime from '@unbrained/pm-cli/sdk/runtime';
console.log({
  acquireLock: typeof runtime.acquireLock,
  acquireLockLease: typeof runtime.acquireLockLease,
});
JS
```

Expected at the unchanged pin: `function`, `undefined`.

## Behavioral replacement proofs

With only `withProcessJobFence` replaced by direct pinned `acquireLock`, this
regression fails **0/1**, `lock_conflict`:

```sh
node --test --test-name-pattern='dead native phase' test/sdk-adoption.test.ts
```

Independently, with only `commitProcessTransaction` replaced by direct pinned
`commitWorkspaceTransaction`, this regression fails **0/1**, `lock_conflict`:

```sh
node --test --test-name-pattern='transaction recovery retains' test/sdk-adoption.test.ts
```

The original file was restored byte-for-byte after each experiment. With the
production implementations unchanged, all **3/3** new tests pass, including
through pinned `pm test --run --progress` with a snapshot workspace and no PM
context. There is no successful production replacement to claim a revert proof
for; the two counterexamples explain why adoption is deferred.

## Integrity and standalone trackers

The third regression runs a real promoted loop in an SDK-initialized temporary
tracker outside Git discovery, primes status plus SDK comment/note event reads,
then corrupts an existing history author. Re-reading status must reject with
`loop_generation_drift` through retained policy-card integrity certification.
Restoring only the disposable fixture restores successful status. No history
record in the repository is rewritten, and no history read is replaced by an
unchecked cached index. The test suite is included in the existing unchanged
100/100/100/100 coverage gate.

## Public tracker differential

Baseline build: `origin/main` at
`606aef7d53d82178b4aa49e5ee682aefc4e1e7ea`, archived into a non-Git directory
and compiled with the same installed dependency graph as the candidate.

| Public committed tracker | Snapshot commit | Complete items compared |
| --- | --- | ---: |
| pm-rl | `606aef7d53d82178b4aa49e5ee682aefc4e1e7ea` | 106 |
| pm-slack | `5c0bd37fa16a42956c6b2e33e491163f04a3d9a9` | 89 |
| pm-vcs | `c7790d45aab22a3a28b4d44955a592dfc06e715e` | 162 |

The harness runs built `withProcessJobFence` and `commitProcessTransaction`
against independent copies of each committed tracker. The fenced operation
reads an SDK-certified complete item list; the transaction inspects an already
applied read-only step, so neither apply nor compensation may execute.
Authoritative copied files are made read-only. SDK locks, journals and derived
caches can be created only in disposable copies. All authoritative file hashes
and source snapshot hashes must stay unchanged.

All **3 trackers / 357 items** have identical results and transition receipts.
The harness omits only the SDK `now` observation timestamp and normalizes each
scratch tracker root; all other fields, including completeness certificates,
are compared. There are **no intentional product differences**.

Reproduction after building both packages and archiving the three public
trackers, using caller-supplied locations:

```sh
node test/sdk-adoption-differential.ts "$BASELINE_ROOT" "$CANDIDATE_ROOT" \
  "$RL_TRACKER" "$SLACK_TRACKER" "$VCS_TRACKER"
```

The harness adds its read probe only to the disposable baseline source tree.
No public tracker records or raw differential output are committed.
