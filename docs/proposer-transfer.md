# Paired proposer transfer and prospective power

A proposer learns only from development promotion counts. Transfer measures the
quality of the retained learners its instructions produce on unseen trackers;
each contender may fit the earlier chronological rows of the target tracker.
This is transfer of a learned search procedure, not zero-shot prediction by a
single model. Task scores are retained deployment accuracy, including the
unchanged inner gate: an uncertified fit leaves the constant baseline in place.

`proposer-transfer.ts` adds a necessary promotion condition to the existing durable
proposer controller. It never substitutes a looser gate for an existing refusal.
The declaration is sealed before development fits. Meta trackers are partitioned
by normalized repository identity, fixed seed and planned generation number so an
adaptive next generation does not reuse its predecessor's evaluation trackers.
Audit trackers remain outside every selection generation. Target availability and
tracker identities determine membership; neither item-level randomization nor
observed score selects a tracker.

For each task, candidate and incumbent accuracy lie in [0,1]. Average paired
differences within a tracker first, then weight trackers equally. A paired tracker
difference D lies in [-1,1]. For n independent tracker units and m = 2L
predeclared task/look comparisons, the simultaneous two-sided Hoeffding interval is:

```text
r(n) = sqrt(2 log(2m / alpha) / n)
CI = [max(-1, mean(D)-r), min(1, mean(D)+r)]
```

Promotion requires the lower endpoint to reach the unchanged 0.01 margin for
both tasks, in addition to all previous gates. The prospective alternative (MDE), family alpha, desired per-task power and look
count are explicit fields in the native transfer plan. For MDE delta, the lower
power guarantee is zero if s = delta - margin - r is nonpositive, otherwise
`1 - exp(-n*s*s/2)`. Solving for the minimum integer n gives:

```text
ceil(2 (sqrt(log(2m/alpha)) + sqrt(log(1/(1-power))))^2 / (MDE-margin)^2)
```

For the original study declaration (MDE 0.10, alpha 0.05, power 0.80, two looks), this is 3,062 independent trackers per task at each look. Every meta generation uses a disjoint tracker set, and audit uses a separate set.
The calculation uses the declared alternative, never an observed effect or fitted
variance. Zero rows or a missing target remain underpowered. Confidence intervals
are wide rather than silently borrowing item counts or training examples.

The guarantee assumes independent tracker units. Shared fleet conventions can
correlate trackers across repositories; this run makes no cross-organization
independence or efficacy claim. Accounting for within-tracker correlation and
separating targets prevents pseudo-replication, but does not prove independence
between fleet projects. The follow-up corpus task requires a justified broader
sampling frame. The existing public Git builder also caps source count at 64;
its current domain cannot supply this power requirement.

# Choosing and sealing a prospective design

New proposer configurations must contain an explicit `transfer` declaration:

```json
{
  "generations": 1,
  "transfer": { "effect": 0.10, "alpha": 0.05, "power": 0.80 }
}
```

This fragment accompanies the other bounded fields in
`examples/proposer-program.json`. `effect` is the minimum detectable population
gain (MDE), not the observed gain or the promotion margin. The controller derives
the total looks from the predeclared generation count plus one final audit and
seals the full design, including that count, margin and task identities, in a
native `pm-rl/proposer-transfer-plan/2` Decision before proposal/scoring work.
Every new evaluation cites that plan's content address. Resume binds the same
configuration and plan; changing choices requires a new study. Configuration
validation can still inspect older files, but new execution requires an explicit
`transfer` declaration. Older evaluation receipts keep their historical parameters
and remain replayable; they are never reinterpreted using a new default.

Choose the smallest improvement that would justify deployment using the task's
actual costs and benefits **before** looking at held-out contender scores. Then
choose the family error budget, desired power and total planned looks.
Declarations may tighten the historical policy: alpha must be at most 0.05 and
target power at least 0.80 (and below 1). They cannot weaken either threshold. Use
`transferPower(availableTrackers, declaredDesign)` to check feasibility. A larger
MDE is easier to detect but promises nothing about smaller useful gains; it is
not a remedy for an unfavorable observed result. If the required population is
unavailable, collect more independently justified trackers, run an explicitly
underpowered diagnostic, or predeclare a separately justified statistical method.
Never revise a plan after seeing its evaluation outcomes to manufacture power.

For alpha 0.05, per-task power 0.80, margin 0.01, two tasks and two looks:

| Prospective MDE (accuracy units) | Required trackers per task per look |
| --- | ---: |
| 0.05 (5 percentage points) | 15,501 |
| 0.10 | 3,062 |
| 0.20 | 688 |
| 0.30 | 295 |
| 0.50 | 104 |
| 0.80 | 40 |

The MDE must also fit the objective: a baseline accuracy of 0.50 leaves at most
0.50 possible gain. The 0.80 row illustrates the bound and is not a realistic
setting for that baseline.

These conservative bounded-difference requirements can exceed a real fleet even
for a large MDE. Three trackers cannot support this design for any feasible
bounded accuracy gain. Higher confidence, higher target power or more looks
require more evidence. Existing task-count, time, resource and independent
promotion gates also apply; this table does not guarantee overall loop promotion.

# Corpus and replay contract

The builder verifies PUBLIC visibility, MIT licensing and published commit pins
before projecting copies. Private and hosted tracker directories are denied
before access; private remote names are also denied before metadata/history reads.
Only copied committed histories are read. Chronological train/evaluation boundaries,
label availability, task balance and the released dataset identity contract are
validated on initial input and before each durable operation. A run reuses its
verified projections while the manifest, role files and all referenced role shards retain their
device, inode, size, nanosecond mtime and ctime. Any change triggers full corpus
verification; approval reads remain fresh at every durable validation.

Version-two archives group source metadata, omissions and projected tasks into
content-addressed native shard Decisions. A small root pins the manifest header,
ordered shard digests and total entry count. Each shard hashes its sequence index
as well as its contents. The planner and writer share the same complete byte
preflight; an oversized entry refuses before the first corpus mutation. The root
is published after its shards. Replay checks every native digest and birth state,
shard position and count, then reconstructs and verifies the complete source and
split hashes. Missing, extra, duplicated, reordered, altered and oversized version-two shards
refuse. New-format reads enforce the same byte cap as writes; legacy version-one
read behavior is preserved.
Version-one roots and evaluation receipts remain readable.

The evaluation Decision binds the corpus root and sealed plan to exact paired
scores, the generation look and report. All use registered native
`affected_version` and `component` fields and native birth history. Existing
addresses must match their native birth and content hash; writes never overwrite
a conflicting address. Corpus and split hashes are rechecked during replay.
Preflight checks every producer size before creating the first task record.

```sh
pm --pm-path "$scratch/.agents/pm" rl proposer transfer replay EVALUATION_SHA256 --json
```

For an existing scratch tracker with pm-rl installed, this command reads PM context only. Neither a moving fleet checkout nor an
external JSON evidence file is an input. The regression deletes dataset files
before replay. Old chronological dataset envelopes remain accepted; the new gate
applies to new proposer execution and does not rewrite older history or reports.
Individual records retain the package's one-MiB bound; the proposer task-count
representation permits 10,000 tasks per compartment so its shape is not itself
incapable of representing a powered population. Time, optimizer, token, shared
approval and original statistical limits remain unchanged.

# Real public diagnostic

The complete frozen public corpus digest is
`7156cf8c85b9941e12e42632c08f27419af69b7b3ee8824545c35def3fee9d49`.
It contains 31 eligible source pins and 46 chronological tasks (19 development,
16 meta, 11 audit). Missing tasks are retained as omissions in its manifest.
An unverifiable source was excluded without opening its tracker.

The broad diagnostic stopped for resource reasons after 19 development fits and
one meta-baseline fit, before a complete candidate comparison. Its interrupted receipts are excluded from the development tracker; the completed diagnostic below is preserved by a compact replay receipt. No result from it was
used to choose another threshold, feature, task or tracker.

A second diagnostic predeclared three eligible trackers with both tasks per role,
ordered by SHA-256 repository identity and seed 42. It used one generation, one
proposal per task, 64 optimizer updates per fit and a 600-second controller
deadline, in a non-Git SDK tracker under nice level 19 (the parent was already
niced). The full and bounded attempts together stayed below the 30-minute run
budget. The bounded dataset digest is
`feaee19e299df80d7e0764b64ed9d686975b5f606a4afe381c1b094c09386b67`.

| Compartment | Trackers |
| --- | --- |
| Development | pm-beads, pm-gantt-chart, pm-csv |
| Meta | pm-context, pm-ops, pm-graph |
| Audit | pm-linear, pm-vcs, pm-starter |

The human-facing `pm-rl-rsipower-bounded-result` Decision retains the historical
summary. Run records belong in a scratch tracker, outside any Git worktree.
[The compact receipt](proposer-transfer-receipt.json) retains both measured paired
score sets, source commit pins, the full and bounded split identities, and the
expected native root, ordered shard, plan and evaluation digests. Rebuilding from
the public pins and replaying through the SDK requires no development-tracker run
records. It verifies all digests and reports with zero new fits. The version-two
plan re-expresses the historical fixed design during replay; it is not a new
prospective study. Process staging and local diagnostic logs remain untracked.

The completed controller took 567.448 seconds; verification and native evidence
publication brought elapsed time to **576.235 seconds**. It executed 30 fits,
1,920 optimizer updates and five proposal processes, with zero inference tokens.
One executable candidate changed behavior, but zero candidates were promoted.
The original proposer remained retained; no audit rollback was needed. Because
selection had refused the candidate, the final audit compares the retained
original proposer with itself, not the rejected candidate.

| Look | Task | Candidate / baseline accuracy | Paired effect | Simultaneous CI | Trackers | Power lower bound |
| --- | --- | --- | --- | --- | --- | --- |
| Meta generation 1 | Issue type | 0.50 / 0.50 | 0.00 | [-1.00, 1.00] | 3 | 0.00 |
| Meta generation 1 | Time to close | 0.50 / 0.50 | 0.00 | [-1.00, 1.00] | 3 | 0.00 |
| Final audit | Issue type | 0.50 / 0.50 | 0.00 | [-1.00, 1.00] | 3 | 0.00 |
| Final audit | Time to close | 0.50 / 0.50 | 0.00 | [-1.00, 1.00] | 3 | 0.00 |

Both transfer decisions are `transfer_underpowered`; the original minimum-ten
and protected-cohort gates independently refuse too. These intervals cover large
improvement and harm. An empirical zero is not evidence that transfer is absent.
The guarantee of 80% power is unmet, and no gate was tuned to achieve promotion.

The compact receipt pins version-two root
`3f8832a61fe653ce1582fde506c9d1e64daab218c6f42ef96bc080e1b3acc3fe`, ten
ordered shard digests, and plan
`917536ce1cdff1eb5d2384ca8e3fc288da700e000d9260a620b55a065769c268`.
The scratch replay reproduced the full corpus digest, every bounded split and
both reports: effects 0.00, simultaneous CIs [-1.00, 1.00], three trackers per
task, power lower bound 0.00, required trackers 3,062 and refusal unchanged.
It creates 14 native Decisions in the scratch tracker, with no new training.

From a package checkout with dependencies installed:

```sh
scratch=$(mktemp -d)
nice -n 19 node test/fixtures/transfer-replay.ts \
  --receipt docs/proposer-transfer-receipt.json --pm-root "$scratch/.agents/pm"
# Optional: append --fleet "$PUBLIC_FLEET" to use read-only local clone sources.
# SDK replay above is complete; install the local package for native CLI replay:
npm run build
archive=$(NPM_CONFIG_USERCONFIG=/dev/null npm pack --ignore-scripts --silent --pack-destination "$scratch")
pm --pm-path "$scratch/.agents/pm" package install "$scratch/$archive" --project
pm --pm-path "$scratch/.agents/pm" rl proposer transfer replay \
  e1a8859a3556759119bea432da23257573c26c665a0c9f7c242e6032a9b4bd19 --json
```

The replay helper names its required tracker option `--pm-root`; the native pm
CLI names the corresponding global option `--pm-path`.
The script fetches only the receipt's pinned public commits into scratch and
rechecks public visibility, MIT licensing and commit reachability before
projection. It refuses an implicit tracker target or any target within a Git
worktree, including symlink aliases. An optional local fleet directory is read
only; all clone, projection and tracker writes remain in scratch. The live-run
helper likewise requires an explicit `--pm-root` and never copies run records
back into the development tracker. For a fresh study, initialize/install the
package and record resource approval **in that scratch tracker**, then use:

```sh
pm --pm-path "$scratch/.agents/pm" rl proposer run transfer-study \
  --file examples/proposer-program.json --dataset sealed-public-corpus \
  --approval resource-decision --json
```

# Regression evidence

Real non-Git temporary SDK trackers cover underpowered refusal, normalized tracker
leakage, native split-digest mismatch, immutable record drift, unavailable native
records, fresh generation shards, paired score validation and deleted-file replay.
A synthetic analytical control at n=3,062 passes with a unit paired effect;
a powered null still refuses. That control is explicitly synthetic.

`node test/fixtures/transfer-reverts.ts` creates a disposable copy, removes only
the transfer gate or only the corpus verifier, and requires the three named native
regressions to fail with assertion errors (exit 1). Every mutation is restored in
`finally`. No SDK mocks, missing imports or build failures count as revert proof.

# Powered archive capacity regression (issue 149)

The minimum-size real SDK regression uses 3,062 synthetic tracker references per
task in both meta and audit, plus valid development data: 12,248 held-out tasks.
It archives and replays 73 native shards. The root is **5,412 bytes**; the largest
record is **264,191 bytes**, below the unchanged **1,048,576-byte** cap. A favorable
synthetic paired comparison then passes and replays through its explicit native
plan. This is a storage/statistics positive control, not real transfer efficacy.
No new real-data run is needed to repair the storage format; the historical
underpowered measurements above are unchanged.

The behavioral revert runner also removes only the version-two read-side byte
check and requires the oversized native-shard replay assertion to fail. Every probe restores its disposable source in `finally`.

`node test/fixtures/transfer-reverts.ts review-round-one` exercises seven
review regressions: resolved private aliases, typed declaration refusal, stable
corpus caching, complete three-tracker cohorts, unconditional scratch cleanup,
Git-independent reversion and rejection of empty probe selectors. The released
single-record writer is a TypeScript fixture, so no historical Git object is
required. Disposable CLI and revert workspaces are removed on success or failure;
operator-owned live evidence stays in its explicitly selected scratch tracker.

Large role projections use a bounded role index and content-addressed, ordered task-array shards. Each JSON file retains the 16 MiB reader limit, and the manifest and split digest still identify the original ordered task array. Small released role arrays remain unchanged and readable. Cache signatures include shard file identities, so changing or removing a shard forces verification. Empty planned meta looks refuse with `transfer_underpowered` before controller writes or fits.

Paired measurements that exceed one native record use indexed native pair shards and a small version-three evaluation root. Every root and shard retains the one-MiB bound, registered SDK fields and birth-history verification; replay checks the ordered digest list and total pair count before recomputing the same report. Small version-two evaluations and historical version-one evaluations remain readable with their original digests. No alpha, power, MDE or look count is changed to accommodate storage.
