# pm-rl architecture

pm-rl is a **tracker for a reinforcement-learning programme**, not a platform. It schedules
nothing, wraps no trainer, and stores no metrics of its own. What it does is make the
programme's context — which environment version, which reward specification, which seed, which
checkpoint, which benchmark, and what the sim-to-real gap was — into project data that survives
a merge, a clone, and a review.

This document explains the substrate argument, because that argument is the whole reason the
package is built on pm rather than beside it.

---

## 1. The substrate argument

Two properties of pm do the load-bearing work. Neither is decoration.

### 1.1 Append-only metric series, append-only history

A training run emits a monotonically growing series of metric events. That is precisely the
shape of pm's history stream: JSONL, append-only, with a field-aware merge driver that unions
concurrent appends rather than conflicting on them. pm-rl stores validated measurements as
deflate-raw segments whose decoded NDJSON is canonical. Each segment represents no more than 48 KiB of canonical
NDJSON and no more than 65 KiB of serialized note text, so compressed-buffer allocation,
decompression output and individual-note growth all have explicit limits while the complete
series remains attributable and replayable. Legacy one-event `pm-rl/1` notes remain readable.

The consequence is the property no other experiment tracker gives you from a plain merge: **two
agents running two arms of one sweep on two branches can both log, and the merge retains every
accepted occurrence from both series.** It needs no lock, server, or coordination, and it drops
no branch occurrence.

An event's identity is its accepted note occurrence, including pm's repeatable-note metadata;
the metric payload is not an idempotency key. Equal payloads can be legitimate repeated
measurements, so payload deduplication would itself lose data. `run log` consequently provides
at-least-once semantics: replaying an uncertain batch records another occurrence. The real-branch
test deliberately logs byte-equal payloads on both branches and requires both after merge.

This is verified rather than assumed. pm-rl's suite merges two real git branches that both
appended to one item's history and asserts both sides' appends survive — while a genuinely
conflicting *scalar* on the same item is still flagged. That second half is why the rule below
is a hard constraint and not a style preference.

**Design rule: metrics go to history, never to an item's body.** A body is a scalar field. Two
sides changing a scalar is a real conflict, and a conflicted body is unparseable — so a series
written to the body would conflict on every concurrent write, and the failure would take the
whole item with it. A series written to history never conflicts. Every command that records a
metric is bound by this. Tracked as [`pm-rl-mpd9`](.agents/pm/decisions/pm-rl-mpd9.toon).

### 1.2 Provenance is a graph query, and pm has the graph

A run depends on an environment version and a base checkpoint. An eval result depends on a run
and a benchmark version. A transfer measurement depends on two environments and a checkpoint. A
benchmark may depend on an environment by *contamination* — its tasks overlap that
environment's task suite.

Those are typed dependencies, which `pm update --dep` records and `pm graph` traverses. So the
question that actually costs programmes weeks —

> I changed this reward specification. Which of my results are now meaningless?

— is reachability over edges the host already stores. pm-rl does not implement a graph; it
declares the right edges and asks.

The same edges make an environment edit invalidate a generation **transitively**: the lineage
view propagates invalidation forward along the seed-to-head ordering, so a descendant that
recorded a different environment is still marked when an ancestor's environment was edited,
because its training data derives from that ancestor. The reason names the ancestor it inherited
from, distinct from the reason a generation invalidated on its own environment receives.

The approved promotion budget is enforced inside one workspace writer lock, via the SDK's
`commitWorkspaceTransaction`, so the count of promoted generations and the promotion write are one
critical section: concurrent promotions cannot both read the same count and both advance past what
a human authorized. Callers that acquire the lock serialize rather than the loser being refused
for contention. Acquiring the lock does not itself produce `budget_exceeded`: the holder re-reads
both the consumed count AND the approval's permitted count, and refuses only when that re-read
finds no remaining capacity — with headroom it promotes. A caller that exceeds the bounded
acquisition wait reports `lock_conflict` without ever re-reading. `budget_exceeded` is terminal and
a loop must respect it; `lock_conflict` is contention and bounded. The transaction id is **unique per invocation**, never
keyed on the generation: the transaction is used here for mutual exclusion, not idempotent
replay, and keying it on the generation would make concurrent callers promoting the same
generation look like replays of one committed transaction, so the journal would skip `apply` and
every caller would report success for a promotion only one of them performed. Correctness under
concurrency comes instead from re-checking `already_promoted` **inside** the lock, because the
pre-lock check runs on a read every concurrent caller performs before any of them holds it.
The wait is bounded at 30 seconds: a caller that cannot acquire the lock in that window fails with
`lock_conflict` (exit 4) naming the owner, so contention is bounded rather than eliminated, and is
always reported as contention rather than as a promotion that silently did not happen.
A promotion whose close fails reverts its own body write rather than leaving budget consumed by a
promotion that never completed. A seed
may declare a `--policy` its children's collection runs must match; a seed with no declared policy
skips that check, and `pm rl lineage --gap-window` requires at least two consecutive gaps.

---

## 2. Item types

Registered as custom types with typed fields, so the host's governance and validation apply
rather than being reimplemented.

| type | fields that matter | invariant |
| --- | --- | --- |
| **Environment** | task suite, action/observation space, **reward specification**, version, seed policy | **Immutable once referenced.** A change to a referenced version produces a new version instead. Enforced at write time, because the failure it prevents — a result attributed to an environment that no longer exists — is silent |
| **Run** | algorithm, hyperparameters, base checkpoint, environment version, determinism receipt | Metric series in **history**; the body never holds a metric |
| **Sweep** | search space, selection rule | Children are ordinary Runs, so arms are independent items and two agents can take two arms on two branches |
| **Benchmark** | tasks, scoring function, pass criteria, version, contamination edges | A contamination edge is a typed dependency, not a note, so the leaderboard can derive its refusal |
| **EvalResult** | checkpoint, score, pass/fail | Depends on both the Run and the Benchmark version — provenance is complete or the result does not exist |
| **Transfer** | source environment, target environment, checkpoint, **per-metric gap** | Depends on *both* environments, so an environment change invalidates transfers too |

Note for implementation: `pm schema add-type --folder` honours a `..` segment
(upstream pm-cli#799), so the folder name must be validated as a plain segment before it is
passed through.

---

## 3. The two refusals

Most trackers will show you a number whatever you ask. pm-rl refuses in exactly two cases, and
these refusals are the reason to use it.

1. **Ranking across environment versions.** Two checkpoints measured under two environment
   versions are not comparable. A leaderboard that mixes them launders a version change into an
   apparent improvement.
2. **Ranking on a contaminated benchmark.** If the benchmark's tasks overlap the training
   environment's task suite, the score is flattering and meaningless. The overlap is declared as
   an edge, so the refusal is derived rather than remembered.

Both **exit non-zero**. A warning is ignored, and an ignored warning is worse than no check
because it manufactures confidence. Tracked as
[`pm-rl-p401`](.agents/pm/decisions/pm-rl-p401.toon).

Implementation constraint discovered while building pm-vcs: an extension handler **cannot** both
return a structured report and exit non-zero. Throwing is the only exit-code channel, and a
thrown error's remediation field is replaced by a generic host line — so the remediation must be
folded into the message itself. Filed upstream as pm-cli#826.

---

## 4. Sim-to-real

The gap between a simulator and its target is the number that decides whether more sim training
is worth anything, and it is the number least likely to be written down.

A **Transfer** records it: source environment, target environment, checkpoint, and the measured
per-metric gap. `pm rl transfer gap` reports the gap series across a run's checkpoints, which
surfaces the actual failure mode of a sim-heavy programme — *sim performance improving while
transfer stalls* — instead of leaving it to be noticed at deployment.

Because a Transfer depends on both environment versions, `pm rl invalidate` covers it with no
new machinery: changing either side's reward spec marks the measurement stale, and a stale
transfer is reported as stale rather than plotted.

---

## 5. Boundaries

- **No orchestration.** `run log` reads newline-delimited JSON on stdin, so any trainer in any
  language pipes into it with no client library and no integration. Scheduling GPUs is somebody
  else's job and always will be.
- **No separate metric store.** The history stream *is* the store. Keeping every measurement
  means total storage must grow with evidence; pm-rl bounds individual decoded and serialized
  segments instead of making an impossible constant-space or universal compression-ratio claim.
  In the representative sustained integration workload, 10,000 events in 40 realistic batches
  produce 70,442 compressed segment bytes and 99,526 total history bytes from 736,650 input bytes
  (an observed 13.51%), with all events read back. Each segment is capped at 48 KiB decoded and
  65 KiB serialized; oversized or corrupt segments fail closed.
- **No overlap with `pm eval`.** That core command measures pm's *own search relevance*
  (nDCG@k / MRR@k / precision@k / recall@k over a golden-query set). It is a retrieval
  regression gate for the tracker's index and shares nothing with this package but a word. The
  overlap check was run against every core command and every fleet package before this was
  specced.

---

## 6. Status

| capability | epic/feature | state |
| --- | --- | --- |
| Environment registration and versioning | [`pm-rl-et5b`](.agents/pm/features/pm-rl-et5b.toon) | **first slab** |
| Run lifecycle, NDJSON ingestion into history | [`pm-rl-dyho`](.agents/pm/features/pm-rl-dyho.toon) | **first slab** |
| Determinism receipts and `run verify` | [`pm-rl-dpug`](.agents/pm/features/pm-rl-dpug.toon) | planned |
| Sweep planning | [`pm-rl-mqdb`](.agents/pm/features/pm-rl-mqdb.toon) | planned |
| Benchmarks and eval results | [`pm-rl-tl1x`](.agents/pm/features/pm-rl-tl1x.toon) | planned |
| Sim-to-real transfer and gap reporting | [`pm-rl-06n6`](.agents/pm/features/pm-rl-06n6.toon) | planned |
| Leaderboard and its two refusals | [`pm-rl-nzxt`](.agents/pm/features/pm-rl-nzxt.toon) | planned |
| `invalidate` over the dependency graph | [`pm-rl-keet`](.agents/pm/features/pm-rl-keet.toon) | planned |
| `compare` with the config delta | [`pm-rl-taj8`](.agents/pm/features/pm-rl-taj8.toon) | planned |
| 100/100/100 + docstring coverage | [`pm-rl-fpon`](.agents/pm/tasks/pm-rl-fpon.toon) | continuous gate |

Everything hangs off [`pm-rl-e20d`](.agents/pm/epics/pm-rl-e20d.toon).

---

## 7. Testing

The fleet gate: 100% lines, branches and functions, no suppressions, and the gate fails when a
source file is absent from the report at all — Node omits files no test loads, so a module
could otherwise go entirely unexercised while the percentage read 100%.

Tests build **real** trackers in temporary directories and drive commands through the host's
real extension loader (`createExtensionTestHarness`). No api doubles: asserting against a
double of the host asserts against this package's assumptions about the host.

The concurrency claim in §1.1 is tested against **real git branches** with a real merge, not
simulated. The storage claim is likewise measured across repeated real SDK mutations and the
actual history file, not estimated from encoded payloads. If either test fails, the package's
central premise is false and the failure must be loud.
