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
difference D lies in [-1,1]. For n independent tracker units and m = 2(G+1)
predeclared task/look comparisons, the simultaneous two-sided Hoeffding interval is:

```text
r(n) = sqrt(2 log(2m / alpha) / n)
CI = [max(-1, mean(D)-r), min(1, mean(D)+r)]
```

Promotion requires the lower endpoint to reach the unchanged 0.01 margin for
both tasks, in addition to all previous gates. The prospective alternative is
0.10, alpha is 0.05, and desired per-task power is 0.80. At that alternative the lower power
guarantee is zero if s = 0.10 - 0.01 - r is nonpositive, otherwise
`1 - exp(-n*s*s/2)`. Solving for the minimum integer n gives:

```text
ceil(2 (sqrt(log(2m/alpha)) + sqrt(log(1/(1-power))))^2 / (0.10-0.01)^2)
```

With one generation and an audit, this is 3,062 trackers **per task and per look**.
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

# Corpus and replay contract

The builder verifies PUBLIC visibility, MIT licensing and published commit pins
before projecting copies. Private and hosted tracker directories are denied
before access; private remote names are also denied before metadata/history reads.
Only copied committed histories are read. Chronological train/evaluation boundaries,
label availability, task balance and the released dataset identity contract are
validated on initial input and before each durable operation.

Each task is a bounded SDK-created Decision. Another Decision binds the original
manifest to all task digests; the evaluation Decision binds that address to exact
paired scores, design, generation look and report. All use registered native
`affected_version` and `component` fields and native birth history. Existing
addresses must match their native birth and content hash; writes never overwrite
a conflicting address. Corpus and split hashes are rechecked during replay.
Preflight checks every producer size before creating the first task record.

```sh
pm rl proposer transfer replay EVALUATION_SHA256 --json
```

This command reads PM context only. Neither a moving fleet checkout nor an
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
one meta-baseline fit, before a complete candidate comparison. Its native
receipts and reservations remain in the package tracker. No result from it was
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

The native `pm-rl-rsipower-bounded-result` Decision contains the complete result;
its linked evaluation addresses replay from the package tracker. Projected corpus
and measured transfer evidence are copied into that tracker through the same SDK
archive/evaluation functions, checked for exact report equality. Process staging
and local diagnostic logs remain untracked.

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

Native corpus address:
`89aa1ae2c8eef8ab784d83f6d4bd8bff2638ed7259af5f2a50fbfff7b7893c2e`.
Meta evaluation:
`f5962dbe9114770b1e8e426beb980f626c1d02978c8792aefc79ff0678e3d759`.
Audit evaluation:
`7f767f0ef02f4c822df577a2a5a31d99e05db4fdd272150294ffb74df8f6eb7b`.

```sh
pm rl proposer transfer replay 7f767f0ef02f4c822df577a2a5a31d99e05db4fdd272150294ffb74df8f6eb7b --json
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
