# pm-rl

**Reinforcement-learning programme management, on the pm SDK.** Production slices provide
content-addressed environments and benchmarks, attributable run and evaluation lifecycles,
fail-closed leaderboards, recursive-improvement lineage gates, transitive invalidation, and run
comparison. Run metrics live in merge-safe notes and are proven to union losslessly when two real
Git branches append independently. Sweeps expand into independent child-run arms and sim-to-real
transfer reports the per-metric gap series across a run's checkpoints — both fully implemented,
with no hidden or partial commands. The persisted recursive loop (`pm rl loop run`) executes a
bounded collect → train → evaluate → promote-or-reject cycle over the built-in deterministic
bandit or a calibration head over a frozen System One decision model, records every generation as tracker items and merge-safe history, and stops itself on its
own hard bounds. Interrupted executions resume from persisted generations; `loop status` reconstructs their state.

```bash
npm install --save-dev pm-rl     # or: bun add -d pm-rl
pm package install ./node_modules/pm-rl --project
pm rl env register --file environments/grid-v3.json
pm rl benchmark register --file benchmarks/safety-v1.json
pm rl eval record --run run-ppo-7 --benchmark benchmark-safety-v1-... --checkpoint sha256:... --score 0.91 --passed true
pm rl leaderboard benchmark-safety-v1-...
```

To run the built-in recursive loop in an initialized project, install the package
as above, create a Decision containing the promotion allowance, then run the
packaged example:

```bash
printf '%s\n' '```json' '{"permitted_promotions":3}' '```' > approval.md
pm create Decision "Allow three bandit promotions" --id demo-approval --body-file approval.md
pm rl loop run demo-loop --file node_modules/pm-rl/examples/loop-bandit.json --approval demo-approval --json
pm rl loop status demo-loop --json
pm rl loop resume demo-loop --approval demo-approval --json
```

For a local build, run `npm run build` and `npm pack` in this repository, then
install the resulting tarball with `npm install ../artifacts/pm-rl-2026.7.31.tgz`
in the consumer project before `pm package install ./node_modules/pm-rl --project`. Initialize a fresh consumer
with `pm init rl --defaults` first. The seed Generation retains the whole
configuration and a terminal report in its comment history; each attempted
generation retains its collection metrics, checkpoint weights and evaluation
results. Budget and generation limits stop before another batch is collected.
Promotion requires both a strictly higher exact held-out expected reward and a
Hoeffding-bounded sampled improvement. A tie or regression preserves the last
promoted checkpoint, even when noisy samples favor the candidate.

The typed SDK entry point is `runRlLoop(client, { pmRoot, author }, { id, config,
approval, signal? })`, exported from `pm-rl`. Repeating an id resumes it; use unique ids for independent runs. `resumeRlLoop(client, coordinates, { id, approval, signal? })` loads the stored programme, and `rlLoopStatus(client, id)` performs a read-only reconstruction. `onPhase(phase, generation)` observes durable phase boundaries for telemetry and interruption drills.
Its `RlLoopReport` names every attempted generation and the terminal condition.
Repeated held-out selection is adaptive validation; use an independent final
benchmark for unbiased performance claims.

For decision-model training, select `"trainer": "systemone"` and provide a
`decision_model` with `base_url`, `model` and `timeout_ms`, choice `questions`,
disjoint labelled PM items in `training`/`evaluation`, and the bounds described in
[the adapter contract](docs/durable-systemone-validation.md). No new runtime dependency is required.
The packaged `examples/loop-systemone.json` supplies a complete two-generation
configuration for the same synthetic demonstration. Run `npm run test:live:systemone`
locally for two real `tev1:4b` generations. Override
`SYSTEMONE_BASE_URL` and `SYSTEMONE_MODEL` for another TypeSafe-compatible service.
CI uses real in-process HTTP servers and never calls Ollama.

---

## Why this exists

`project management = context management`. An RL programme is one of the most context-heavy
things an agent can run: dozens of environments, hundreds of runs, sweeps whose individual
trials mean nothing without a baseline, and benchmark scores that are worthless without the
exact environment version, seed and checkpoint behind them.

Today that context lives in a dashboard, a folder of JSON, and shell history. None of it is
reviewable, none of it merge-safe, and none of it available to the agent that has to decide
what to train next. The number an agent most needs — *is this result still valid after I
changed the reward spec* — is not written down anywhere.

pm-rl makes the programme itself a tracker.

## Why pm is the right substrate, and not just a place to put labels

Two properties do the real work, and neither is incidental.

**Metric logging is append-only, and so are pm notes.** A training run emits a monotonically
growing series of events. `pm rl run log` validates the complete input, packs canonical NDJSON
into compressed segments of at most 48 KiB decoded data and 65 KiB serialized note text, and
appends the segments as one atomic mutation. pm's field-aware merge drivers preserve every
accepted branch occurrence when branches merge.
The reader remains compatible with the original one-event `pm-rl/1` notes. The package test
suite creates two real Git branches, appends the same measurement on each, merges them, and
reads both occurrences back through the public command.

Event identity is the accepted note occurrence, not the metric payload. Two identical
measurements may be legitimate and remain distinct; `run log` therefore has at-least-once
semantics and never guesses that equal payloads are retries. A producer that cannot tolerate a
duplicate must resume from its own acknowledged input boundary rather than replay an uncertain
batch.

The corollary is a hard design rule: **metrics go to history, never to an item's body.** A body
is a scalar field, and two sides changing a scalar is a real conflict. A series written to the
body would conflict on every concurrent write. A series written to history never does.

**Runs are a dependency graph, and pm already has one.** A run depends on an environment
version and a base checkpoint; an eval result depends on a run and a benchmark version; a
transfer measurement depends on two environments. `pm update --dep` models that and `pm graph`
queries it — so *"which results are invalidated if I change this reward spec"* is a reachability
query the host can already answer, not a feature to build.

## What it tracks

| type | holds | key constraint |
| --- | --- | --- |
| **Environment** | task suite, action/observation space, reward specification and version | Content-addressed; registration is idempotent and every use verifies that the stored body still matches its identity |
| **Run** | algorithm, hyperparameters, base checkpoint, environment reference, determinism receipt | Metric series lives in the item's **history**, never its body |
| **Sweep** | search space, selection rule; children are runs | Arms are independent items, so two agents can run two arms on two branches |
| **Benchmark** | tasks, scoring function, pass criteria, version | May declare a contamination edge to an environment whose task suite it overlaps |
| **EvalResult** | one checkpoint scored against one benchmark version | Depends on both, so provenance is complete |
| **Transfer** | the measured per-metric gap between a source environment and a target one for one checkpoint | Depends on **both** environments — the sim-to-real gap becomes tracked data, not folklore |
| **Generation** | base checkpoint, the policy that collected the training data, those collection runs, and the training configuration | Its parent is the generation whose policy did the collecting, so lineage is an edge rather than a filename convention |
| **GateEpisode** | one judged candidate against a registered gate environment: content-addressed candidate-tree identity, per-gate results, extracted verdict, and its pull-request link | Content-addressed; replay resolves that exact artifact before re-deriving the verdict, so a moved verdict is caught, not trusted |
| **MergeOutcome** | whether one pull request actually merged | The real side of the sim-to-real gap: paired by pull-request link against gate episodes, with unpaired sides reported as coverage |

## Available commands

| command | what it does |
| --- | --- |
| `pm rl env register` / `list` / `show` | Declare and version environments and their reward specifications |
| `pm rl benchmark register` | Declare a content-addressed task suite, scoring function, pass criteria, score direction, and typed contamination edges |
| `pm rl eval record` | Record an immutable score/pass verdict whose typed edges and body trace to its checkpoint, source run, exact benchmark, environment, and reward specification |
| `pm rl leaderboard` | Rank one benchmark version deterministically after a complete-corpus graph read; refuse mixed environment versions and declared training/eval contamination |
| `pm rl run start` / `log` / `show` / `finish` | Snapshot exact environment and configuration provenance, append validated NDJSON metrics from a file or stdin, order the series by step, and refuse to finish an empty run |
| `pm rl generation register` / `show` | Record one policy generation of a recursive self-improvement lineage, parented to the generation it was trained from, carrying its base checkpoint and collection runs. Registration records provenance only; the scores, gap and promotion evidence stay null until `promote` populates them. A seed may declare a `--policy` that its children's collection runs must match; a seed with no declared policy skips the run-policy check, since there is no declared policy to violate |
| `pm rl generation promote` | Promote a candidate generation, but only after the contamination and approved-budget refusals below both pass |
| `pm rl lineage` | Print the generation chain with each hop's promotion evidence, its direction-aware proxy-to-held-out gap, and any invalidation, reported with a distinct reason per condition (edited, unreadable, no recorded identity, or absent) |
| `pm rl invalidate` | Given one environment or benchmark version, list every `Run`, `EvalResult` and `Transfer` transitively invalidated by changing it, each with the exact dependency path (`env-v1 → run-a → eval-a1`) by which the change reaches it. The walk is directional over the `dependencies` edges pm itself stores, so changing an environment version never reports another version's runs |
| `pm rl compare` | Diff two runs at the metric level over their common step range and report the hyperparameter, environment-version and reward-spec delta alongside, because a metric difference with no configuration difference beside it is not an explanation |
| `pm rl run verify` | Re-derive a run's determinism receipt — seed policy, library versions, device, environment item id — against a fresh one and refuse any drift naming every differing field, without mutating anything ([`pm-rl-dpug`](.agents/pm/features/pm-rl-dpug.toon)) |
| `pm rl sweep plan` / `status` | Expand a declared search space into one child Run per arm with the arm's hyperparameters recorded; report per-arm progress and a verdict only when the selection rule supports one ([`pm-rl-mqdb`](.agents/pm/features/pm-rl-mqdb.toon)) |
| `pm rl transfer record` / `gap` | Record one measured per-metric sim-to-real gap for one checkpoint, linked to both environment versions; report the gap series across a run's checkpoints in order, holding transfers whose environments went stale out of the series with reasons ([`pm-rl-06n6`](.agents/pm/features/pm-rl-06n6.toon)) |
| `pm rl episode env register` / `record` / `replay`, `pm rl outcome record`, `pm rl simreal gap` | The fleet's own mandatory gates as a content-addressed environment: episodes store a candidate-tree identity (git tree or patch hash), replay resolves that exact artifact before re-deriving the verdict, every episode links its pull request, and the sim-to-real gap is computed over the paired cohort with denominators stated and unpaired sides reported as coverage ([`pm-rl-0cqg`](.agents/pm/features/pm-rl-0cqg.toon)) |
| `pm rl loop run` | Execute or resume a bounded `bandit`, `systemone` or `lm` programme, preserving per-generation artifacts, logical sample accounting and transactional promotions. |
| `pm rl loop status <id>` | Reconstruct phases, consumed samples, checkpoints and terminal reason without writes. |
| `pm rl loop resume <id>` | Load the seed's persisted programme; requires the governing `--approval` Decision. `--force-takeover` audits explicit recovery of an ambiguous or stale controller lease. |

All commands listed above are implemented. [Recursive training execution](RECURSIVE_TRAINING.md)
documents the local process and Docker Compose adapters and remaining scheduler work.

## Implemented refusals

The first slice fails closed when context would otherwise become misleading:

1. **A mutated environment cannot start a run.** The command re-hashes the stored specification
   and requires its full hash and content-addressed id to agree, directing the caller to register
   changed behavior as a new version.
2. **An empty run cannot finish.** A terminal Run must contain at least one validated finite
   metric event, so “completed” cannot silently mean that the trainer produced no evidence.
3. **A contaminated candidate cannot be promoted.** Promotion walks provenance edges and refuses
   when the evaluation set is reachable from the candidate's training data, naming the exact path.
   It refuses rather than warns, because a warning on a self-improving loop is a warning nobody
   reads on the tenth generation. A promotion is also refused when the provenance graph is
   unreadable — a collection run that does not resolve leaves the contamination check unable to
   decide overlap, so the promotion is refused (`provenance_unreadable`) rather than treated as
   clean. The lineage view stays tolerant of an unresolvable run, because a degraded view is
   still useful; only a promotion decided on a degraded graph is refused. A parent chain that
   loops is refused the same way (`lineage_cycle`): the ancestry walk can never reach a seed, so it
   would return a TRUNCATED lineage and the contamination check would compare only the part it
   reached — an environment reachable past the repeat point would never be compared, and a
   contaminated candidate would pass a gate that reported nothing wrong. The view again stays
   tolerant and simply stops walking.
   The contamination verdict is decided **inside** the writer lock, over a fresh walk of the whole
   ancestry, so a peer that contaminates an ANCESTOR while this caller waits for the lock cannot
   leave a stale clean verdict behind — the leaf would be byte-identical, and comparing only the
   candidate would miss it. The pre-lock walk is kept as a fast refusal so an obviously
   contaminated candidate never takes the lock; the in-lock walk is the one that decides. The
   promoting write is rendered from the body read inside the lock, so a peer edit that the verdict
   does not depend on survives the promotion rather than being silently overwritten.
4. **The loop cannot advance past its approved budget.** Promotion counts the generations already
   promoted under an approval item and refuses beyond the permitted count, directing the caller to
   extend the approval. The count, **the approval's permitted count**, and the promotion write all
   run inside one workspace writer lock (`commitWorkspaceTransaction`). Both sides of the budget
   comparison are re-read there, not just the count: an approval narrowed while a caller waits
   would otherwise be compared against the capacity it had before, and the promotion would exceed
   the approval that actually governs it. Callers that **acquire** the lock serialize rather than
   one being rejected for contention. Acquiring the lock does not itself refuse: the holder
   re-reads both values and reports `budget_exceeded` only when that re-read finds no remaining
   capacity, which is a terminal condition a recursive loop must respect. A caller that exceeds the
   bounded acquisition wait reports `lock_conflict` instead, without ever re-reading. A Generation whose body is uncountable (no JSON fence or an
   unparseable spec) makes the budget undecidable and is refused (`budget_undecidable`) rather than
   skipped, because treating unreadable provenance as absent provenance inverts the contract. This
   is the property that keeps a recursive loop from running unattended further than a human
   authorized. The same lock makes **one generation promote at most once**: the already-promoted
   check is re-run inside the critical section, because the pre-lock check reads state every
   concurrent caller sees before any of them holds the lock, so all of them would pass it.
   The lock wait is **bounded**, not unlimited: a caller that cannot acquire it within 30 seconds
   fails with `lock_conflict` (exit 4), naming the current owner and how long it waited. That is a
   retryable outcome, so contention is bounded rather than eliminated — but it is reported as
   contention, never as a promotion that did not happen.
5. **Incomparable scores cannot form a gap.** The proxy and held-out scores must share the same
   objective, objective version, and optimization direction. Subtracting scores that name different
   objectives yields a number that is not a gap, and a `maximize` proxy against a `minimize` held-out
   score adds capabilities instead of measuring drift; both are refused (`incomparable_scores`),
   naming the differing fields. An objective that declares no positive comparable scale is refused at
   score parse time (`invalid_scale`) rather than compared: the gap is computed over normalized
   scales, so a missing scale means there is nothing to normalize against and the subtraction would
   produce a number whose units are undefined. A generation spec is also refused when its promotion
   evidence is
   inconsistent — promoted records must carry their approval, both scores, and their gap, and
   unpromoted records must carry none of them (`promoted_missing_evidence` / `unpromoted_with_evidence`),
   so two consumers never disagree about whether a record counts as promoted. The stored identities —
   `parent`, `approval`, and each `collection_runs` entry — are trimmed at the parse boundary, and a
   blank `approval` or a blank run id is refused (`empty_approval` / `empty_collection_run`), because
   all of them are compared by strict equality: a promoted record storing
   `"  approval-a  "` or `""` would satisfy the evidence invariant while matching no approval id, and
   so consume none of the budget it was promoted under.
6. **Runs from different environment versions cannot be compared.** `pm rl compare` refuses
   (`environment_version_mismatch`) when the two runs recorded different environment versions, naming both runs and
   both environment ids, because a metric difference across environment versions launders the version change into an
   apparent improvement. A run that records no environment at all is refused the same way
   (`run_environment_unrecorded`): comparability is undecidable, and a best-effort diff would answer a question that
   has exactly one answer. A Run whose body lacks the environment snapshot or configuration sections `rl run start`
   writes is refused (`run_body_unreadable`) rather than diffed against an invented empty configuration.
7. **Incomparable or contaminated evaluations cannot be ranked.** `pm rl leaderboard` certifies
   a complete, unbounded tracker inventory before filtering EvalResults. It refuses
   (`environment_version_mismatch`) when rows span more than one environment version and names every
   version, because cross-version scores do not share a measurement context. It also refuses
   (`benchmark_contaminated`) when the benchmark's immutable contamination graph names the training
   environment, including the suite name, version, benchmark id, and overlapping environment in the
   error. Every accepted row is re-verified against its typed Run and Benchmark edges and the
   current content identities of its environment and reward specification before ranking.

All exit non-zero. The gap-widening check needs at least two consecutive gaps, so
`pm rl lineage --gap-window` requires an integer of at least 2.

## Recursive self-improvement

`pm rl improver run` adds a second recursive level: a versioned proposal policy
learns search preferences from its own development outcome ledger. Each generation
proposes K bounded learner configurations, fits them through the reserved CPU
process trainer, and applies the existing learner promotion gate. The updated
improver must then find better **promoted** learners than its incumbent on separate
meta trackers with the same fit and optimizer budget. Every policy, proposal,
score and decision has a durable PM receipt; a real SIGKILL after an update resumes
without another launch of its settled jobs.

The real experiment uses chronological, class-balanced time-to-close and item-type
tasks on copied public tracker snapshots. Features use strictly earlier history;
future-history and type-label sentinels are covered by behavioral revert proofs.
The final audit trackers are opened after all three generations commit. Run
`npm run build` and `npm run test:live:improver` to reproduce the fixed CPU programme.
The [recursive improver contract](docs/recursive-improver.md) explains artifact
schemas, data boundaries, equal budgets, confidence units and recovery.

<!-- improver-measurement:start -->
The completed public-tracker run used **34 reserved fits and 8,704 SGD updates**
across three generations (K=1), with seed 42 and zero model tokens. Every score
below is a retained, gate-approved learner score; class balancing makes both
constant baselines 0.50.

| Generation | Time-to-close | Item type | Majority / retained seed | Meta score (95% tracker CI) | Improver promotion | Held-out constant candidates | Beat train majority |
| --- | ---: | ---: | ---: | --- | --- | ---: | ---: |
| 1 | 0.50 | 0.50 | 0.50 / 0.50 | 0.50 [0.00, 1.00] | refused | 0/10 | 10/10 |
| 2 | 0.50 | 0.50 | 0.50 / 0.50 | 0.50 [0.00, 1.00] | refused | 4/10 | 6/10 |
| 3 | 0.50 | 0.50 | 0.50 / 0.50 | 0.50 [0.00, 1.00] | refused | 5/10 | 7/10 |

The single review-fix repetition completed in **244.523 seconds** with the same
sealed dataset. Candidate counts include development and both meta searches.
Of 30 fitted candidates, **21 predicted both classes on held-out data** and **23
beat the 0.50 training majority**; each generation's
`any_candidate_beats_train_majority` is true. Candidate held-out accuracies range
from 0.375 to 0.667. The evidence records each candidate's exact class counts,
distinct prediction count and training scores, including rejected candidates.
Final audit has 2/4 constant candidates and 2/4 that beat training majority.

The measured 0.50 null therefore reflects **retention of the constant seed after
learner gate refusal**, plus an underpowered outer comparison. Some candidates
produce a constant held-out class, but uniform learner collapse or an inability
to fit training signal does not explain the result. Training gains and varied
predictions do not establish held-out or proposer improvement.

No learner or improver was promoted. The two meta trackers are below the
unchanged ten-sample minimum; each outer gain is 0 with conservative lower bound
-2.701813717997259. These wide intervals establish no improvement. Final audit
accuracy stays 0.50 for both targets (16 time-to-close and 24 item-type examples).
The complete dataset, artifact, resource and timing receipts are in
[the measured evidence](docs/improver-live-evidence.json).
<!-- improver-measurement:end -->

### Learner recipe search and provenance gates

`pm rl meta run` also searches the bounded recipe that trains each candidate.
The programme names a versioned content-addressed initial recipe; every inner
generation records its recipe digest. Seeded search can vary learning rate,
steps, batch, data selection, curriculum, temperature and reward-shaping weights
within declared domains. Optional local `tev1:4b` proposals use the existing
calibration adapter and fall back to seeded search when unavailable. One existing
Decision bounds the entire search and every inner process fit through atomic
reservations; the loop cannot enlarge that approval.

Recipe selection receives only exact-match meta-validation evidence from separate
public tracker repositories. Inner held-out data stays in its evaluator; the
proposer has no dataset capability. A proxy-only gain is refused by the existing
statistical gate. The final-test repositories are opened only after all recipe
promotions, and report the initial versus selected policy without influencing
selection. Reports include constant-majority baselines, predicted-label counts and
pairwise candidate disagreement, computed inside the evaluator. The current
tracker learner does not beat that baseline; the committed signal sanity case
proves that real gain can promote under the same gate. [The meta-recursive contract](docs/meta-recursive.md) documents the
data boundary, confidence assumptions, idempotent resume and measured real-data
acceptance. Start with [the bounded programme](examples/meta-trackers.json) and
`pm rl dataset build --from-trackers <first-directory> <more-directories...> --output <new-directory>`.

The [history-prefix learner](docs/history-prefix.md) adds `--task history-prefix`:
a bounded logistic classifier reads event counts/order, field changes, elapsed time,
author count and hashed first-title/description words. Its time-to-close target is
balanced on fit repositories (472 fast / 471 slow; median 47.356 seconds), with
regularisation, n-gram order, hashing width and learning rate searched over two meta
generations under the existing process budget and unchanged promotion gate. The
[public live receipt](docs/prefix-live-evidence.json) retains every fit and refusal,
majority baselines, prediction diversity and the final-test comparison. Five fits
change parameters, but none promotes; final-test remains 220/385, equal to its
majority baseline.

The current pm-rl runtime **executes, tracks and gates** a bounded numerical loop: a generation collects trajectories,
the built-in bandit trainer produces a successor, and the successor collects the next generation's
trajectories. `pm rl loop run` executes these steps with the built-in contextual
bandit, the frozen System One model with a fitted calibration head, or a tiny
causal transformer with trainable LoRA adapters (`trainer: "lm"`). The LM base
is regenerated by deterministic copy pretraining; REINFORCE updates real adapter
parameters from sampled sequence rewards. [LM adapter validation](docs/lm-adapter.md)
records a three-generation real CLI run, checkpoint hashes, held-out exact-match
improvement and regression refusal. SDK leases serialize controllers, persisted receipts support crash recovery, and real calibration parameters change across generations. [Durable adapter validation](docs/durable-systemone-validation.md) explains the shared worktree authority and endpoint boundary.
For endpoints with durable immutable receipts, set
`decision_model.receipt_protocol: "idempotency-v1"`. The controller persists a
run namespace, sends stable content-bound request IDs as `Idempotency-Key`, and
recovers the original decision and token usage after a lost response or hard
kill before the PM commit. Receipt IDs and physical inference counts are stored
with each metric event; terminal resume makes no requests. See the
[endpoint contract and crash proofs](docs/durable-systemone-validation.md#recoverable-external-decision-receipts).
Legacy endpoints retain their documented unresolved-request limitation.

For the CPU-only LM adapter, start with [examples/loop-lm.json](examples/loop-lm.json).
Its programme declares the task alphabet, disjoint training/evaluation strings,
model dimensions and fail-closed resource/licence limits:

```json
{
  "trainer": "lm",
  "task": "rotate",
  "alphabet": ["0", "1", "2", "3", "4"],
  "model": { "d_model": 16, "ffn": 32, "layers": 1, "rank": 4 },
  "limits": {
    "max_parameters": 4096, "max_checkpoint_bytes": 65536,
    "max_steps": 256, "max_wall_seconds": 60,
    "model_license": "MIT", "dataset_license": "MIT"
  }
}
```

This fragment highlights the model contract; use the full example for the
required datasets, optimizer settings, seed and loop bounds. Create an approval
Decision whose JSON body declares `{"permitted_promotions":4}`, then run:

```sh
pm rl loop run lm-demo --file node_modules/pm-rl/examples/loop-lm.json --approval lm-approval --json
```

The example has 2,912 total parameters (352 trainable), persists canonical
adapter artifacts below the selected tracker, and uses the promoted adapter
for successor collection. The declared optimizer limit includes pretraining;
the wall allowance applies to each CPU phase. [The adapter contract](docs/lm-adapter.md)
explains refusal codes, the sampled reward gate and the small measured accuracy gain.

Controller leases bind hostname, PID and process birth time. A dead same-host
identity recovers automatically when the probed birth time differs. Linux uses
boot time plus process-start ticks; Windows uses the OS process start timestamp.
macOS/BSD and other Unix probes have one-second precision: a PID reused within
that second may be indistinguishable and remain blocked. Verify that the original
controller has stopped and wait for the unrelated process to exit, then retry
resume; do not kill an unrelated process solely to clear a lease.
Different-host,
legacy or unreadable identities refuse with a tracker-relative lock path and the
exact recovery command. After checking that the previous controller has stopped,
use `pm rl loop resume <id> --approval <decision> --force-takeover` to recover an
ambiguous lease. The seed's PM history records the operator and previous holder,
with machine identities represented by digests. A matching live identity still
blocks, including indistinguishable same-second PID reuse. A live local PID with
unavailable birth-time probing or missing recorded identity also blocks forced
takeover. Restore OS probing and stop or exclude the holder before retrying;
`--force-takeover` cannot bypass `loop_identity_unavailable` when this controller
cannot determine its own birth time. Elapsed time never authorizes takeover.
Symlink aliases of one tracker
share the same launch-authority identity.

None of the four failures below is a training problem. Each one is a provenance problem — which is
to say a context problem — and each becomes answerable from the graph pm stores and merges, **once
the graph carries the right edges**. Reachability is not free: a parent edge from a generation to
its predecessor does not connect an environment revision to the generations that used it. So the
programme's foundation is an explicit graph contract — content-addressed identities for every
artifact a verdict depends on, and declared edges from each generation to its parent, its collection
runs, and the exact environment and reward-spec versions those runs used.

| what quietly breaks | why the score still rises | what pm-rl does about it |
| --- | --- | --- |
| The generating policy is not recorded | Trajectories are indistinguishable, so a regression cannot be attributed to the generation that caused it | A **Generation** names its base checkpoint, its collecting policy and its collection runs, and its parent edge points at the generation that produced its training data ([`pm-rl-81oc`](.agents/pm/features/pm-rl-81oc.toon)) |
| The held-out set becomes training data | The evaluation number improves while capability does not | Promotion is **refused**, not warned about, when the evaluation set is reachable from the candidate's training data, and the refusal names the connecting path ([`pm-rl-gyrj`](.agents/pm/decisions/pm-rl-gyrj.toon)) |
| The proxy and the real objective drift apart | The loop keeps improving *the number being optimized* | Both scores are attributed to the same standard — objective id, version and evaluation context — each objective declares a direction, and the **direction-aware** gap plus its trend along one selected ancestry is the reward-hacking signal ([`pm-rl-zav1`](.agents/pm/features/pm-rl-zav1.toon)) |
| The loop has no stopping point | Nothing distinguishes generation four from generation forty | Advancing past an **approved promotion budget** is refused, and the refusal names the approval item to extend — a tracked decision, never an environment variable ([`pm-rl-qix7`](.agents/pm/features/pm-rl-qix7.toon)) |

Two consequences fall out of modelling it this way rather than bolting on a dashboard. An
environment or reward-spec edit invalidates every downstream generation *transitively*, by reverse
traversal of the environment and reward-spec edges the graph contract requires. And
[`pm rl lineage`](.agents/pm/features/pm-rl-32a9.toon) renders one ancestry from the seed to
a named head with each hop's promotion evidence **and** its invalidation state — the column that
actually decides what to train next. A generation can have more than one promoted successor, so
gap trends are computed within a single ancestry and never across branches. Both selections are
supported: `pm rl lineage <id>` renders the one ancestry ending at that head, and `pm rl lineage`
with no id enumerates every head and renders each ancestry separately.

The first environment this targets is deliberately unglamorous: [the fleet's own mandatory
gates](.agents/pm/features/pm-rl-0cqg.toon). An agent proposes a diff to a pm package, and the
package's exact coverage thresholds, docstring coverage, acceptance scripts and review rounds
decide whether it passed. Those gates make an unusually good reward because they were built to be
uncheatable for an entirely different reason. Because the action is a diff rather than the base
commit, an episode records a content-addressed identity for the **candidate tree** itself, and
replay resolves that exact artifact before running the gates. The sim-to-real gap is then reported
over the **paired cohort** — candidates linked to a real pull request on both sides — with the
denominator stated; candidates present on only one side are reported separately as coverage rather
than folded into a rate.

`pm rl loop run` trains the bounded contextual-bandit policy, persists real checkpoint
updates and uses each promoted successor for the next collection batch. Its resource
bounds and provenance refusals apply to every generation. Durable continuation and calibration-head updates are implemented. The local process bandit adapter and atomic resource reservations are implemented. GPU scheduling remains under [`pm-rl-apvf`](.agents/pm/epics/pm-rl-apvf.toon), extending the programme specified
under [`pm-rl-yi7j`](.agents/pm/epics/pm-rl-yi7j.toon).

## Durable external process training

| Programme selection | Execution | Training input |
| --- | --- | --- |
| `trainer: "bandit"` | In-process numerical policy | Synthetic on-policy samples |
| `trainer: "systemone"` | Calibration head over a frozen decision model | Explicitly selected labelled items |
| `trainer: "lm"` | Bounded CPU LoRA update | Programme-declared sequences |
| Bandit with `adapter.kind: "process-bandit"` | Packaged local child process | Collected training batch |
| LM with `adapter.kind: "compose-lm"`, immutable `image`, `memory_bytes` and `cpus` | Networkless non-root Compose fit with kernel memory/CPU ceilings | Frozen weights, source tensors and collected rewards; held-out examples stay in the controller ([evidence](docs/lm-adapter.md#external-compose-trainer-2026-10-16)) |
| Bandit with `adapter.kind: "compose-bandit"` and immutable `adapter.image` | Isolated Docker Compose trainer | Same batch and receipt contract; only job staging is mounted |


Select `adapter: {"kind":"process-bandit","allowance":{"training_steps":1,"wall_ms":5000,"storage_bytes":65536,"compute_units":1000,"tokens":0}}`
in a bandit programme to run the real packaged TypeScript trainer as a child
process. The approved Decision must declare both `permitted_promotions` and an
aggregate `resource_budget` with those five resource dimensions. The controller
reserves atomically before launch, validates a staged checkpoint and completion
receipt, and settles resources once. Exit code zero alone cannot promote.

```sh
pm rl loop run process-demo --file node_modules/pm-rl/examples/loop-process.json --approval process-approval --json
pm rl loop status process-demo --json
pm rl loop resume process-demo --approval process-approval
```

Default output is compact; `--json` includes complete jobs, receipts and charges.
[The process contract and measured two-generation proof](docs/process-trainer.md)
include the approval example, NDJSON protocol, Compose configuration, crash recovery and cancellation
semantics. Checkpoints and failed-job evidence live in tracker-owned staging.

Prefix checkpoints now live in SHA-256 artifacts, with small staging references,
verified resume/replay, and reachability-based garbage collection. Hashing widths
through 64 retain the existing 4096-byte reservation. Widths above 64, up to 4096,
require an explicit larger storage approval; optimizer and promotion bounds are unchanged. See [checkpoint storage and measurements](docs/checkpoint-artifacts.md).

## Without git

Tracker environments, training on sealed datasets, evaluation, promotion,
checkpoint inspection/collection, resume and replay work in a plain-directory
tracker. Process execution requires the operating system's process identity tools.
`pm rl corpus build` reads an explicitly selected tracker without Git and seals
a small title-length/closed-status task for the same durable controller:

```sh
pm rl corpus build --from-tracker source/.agents/pm \
  --file node_modules/pm-rl/examples/loop-corpus.json --output sealed.json
# Create an independent Decision allowing two promotions and the resource budget below.
pm rl loop run tracker-live --file sealed.json --approval corpus-approval --json
pm rl loop resume tracker-live --approval corpus-approval --json
```

For the shipped bounds, the approval's JSON is
`{"permitted_promotions":2,"resource_budget":{"training_steps":16,"wall_ms":10000,"storage_bytes":524288,"compute_units":2000,"tokens":0}}`.
The builder never modifies its source or overwrites an existing output. Input
groups stay in one partition; the seal is checked again on run and resume.
See [the corpus contract and measured result](docs/tracker-loop.md).

Building public-history datasets requires Git repositories and verified public
source commits. Release changelogs and GitHub provenance also require Git.

## Not in scope

- **Current execution boundary.** `run log` accepts NDJSON from an external trainer. Native
  bounded bandit and System One calibration-head training are implemented as `pm rl loop run`. Local process training is implemented with atomic reservations and validated staged receipts.
  GPU scheduling remains in [Recursive training execution](RECURSIVE_TRAINING.md).
- **No separate metric store.** The history stream *is* the store. Retained evidence necessarily
  grows with retained measurements. Each segment is capped at 48 KiB decoded and 65 KiB
  serialized. In the representative sustained integration workload—not as a universal
  compression ratio—10,000 events across 40 mutations occupy 99,526 history bytes for 736,650
  input bytes (13.51%).
- **No relationship to `pm eval`.** That core command measures pm's own search relevance
  (nDCG/MRR/precision/recall over a golden-query set). It shares a word and nothing else.

## Requirements

- Node.js ≥ 22.18, tested on 22 and 26
- `@unbrained/pm-cli` ≥ 2026.8.28 (peer dependency)
- Works under `npm`/`npx` and `bun`/`bunx`
- No runtime dependencies beyond the Node standard library

## Development

```bash
npm ci
./node_modules/.bin/pm package install npm:pm-github@2026.10.4 --project
./node_modules/.bin/pm github import unbraind/pm-rl --state open --atomic --dry-run
./node_modules/.bin/pm github sync --repo unbraind/pm-rl --dry-run
npm run typecheck
npm run docstring       # hard 100% documented declarations
npm run coverage        # hard 100% statements / lines / branches / functions
npm run changelog:check
```

The tracked managed-extension manifest records `pm-github`, but its installed
code is ignored by Git. `npm ci` does not restore that project extension in a
fresh checkout, so install the pinned package before using `pm github`.
The import and sync commands above only preview changes. When you run them
manually, review issue bodies, provenance, and the proposed PM diff for private
data and duplicates before any import or push. The scheduled issue sync in
`.github/workflows/pm-github-sync.yml` instead runs the pinned pm-github
reusable workflow, whose automated privacy gate fails closed on suspicious
content; it then opens a pull request with the proposed tracker changes, and a
human reviews that pull request before it merges.

## License

MIT

## Real recursive training adapter

The package exports a small numerical foundation for the execution controller.
This example performs three real policy-gradient updates with disjoint synthetic
training and evaluation identities. Every accepted successor supplies the policy
used to collect the next generation's actions.

```typescript
import { runBanditProgramme } from "pm-rl";

const result = runBanditProgramme({
  training: [
    { id: "train-positive", feature: 1, rewards: [0, 1] },
    { id: "train-negative", feature: -1, rewards: [1, 0] },
  ],
  evaluation: [
    { id: "eval-positive", feature: 0.8, rewards: [0, 1] },
    { id: "eval-negative", feature: -0.8, rewards: [1, 0] },
  ],
  initialWeight: 0,
  seed: 42,
  generations: 3,
  samplesPerGeneration: 256,
  learningRate: 0.5,
  minimumImprovement: 0,
  maximumGap: 0.2,
  evaluationSamples: 40000,
  confidence: 0.95,
  minSamples: 10,
});
console.log(result.generations.map(({ source, candidate, evaluationScore, promoted }) => ({
  source: source.digest, weight: candidate.weight, evaluationScore, promoted,
})));
```

The API returns deterministic content-addressed checkpoint and collection receipts.
It stops at the first rejected candidate and retains the last accepted checkpoint.
It does not mutate a tracker, grant a budget, execute an LLM, or launch a hosted
job. Evaluation is an adaptive validation set; a separate final benchmark is
needed after repeated selection. See [the execution contract](RECURSIVE_TRAINING.md)
for the local process and Compose adapters; [the decision adapter](docs/durable-systemone-validation.md) documents the implemented frozen-model calibration trainer.

## Predeclared causal evaluation plans

Declare the target population, selection rule, member-to-correlation-unit mapping,
exact observation and independent-unit counts, objective, bounded reward scale,
criterion and fixed stopping rule **before creating a candidate or its collection
runs**. The plan also pins the incumbent generation's provenance hash. The
[example plan](examples/evaluation-plan.json) and [paired observations](examples/evaluation-observations.json)
form a powered synthetic positive control:

```bash
pm init rl --defaults
pm rl generation register rl-seed --base-checkpoint checkpoint
pm rl eval plan register --file examples/evaluation-plan.json
pm rl eval plan show rl-candidate --json
# Create the collection run and register rl-candidate with parent rl-seed.
pm rl eval plan evaluate rl-candidate --file examples/evaluation-observations.json --json
# Supply matching held-out scores to the existing generation promotion command.
pm rl generation promote rl-candidate --approval rl-approval --scores scores.json --evidence "Predeclared paired comparison"
```

Use full canonical generation IDs and the incumbent's `spec_hash` from registration
as `incumbent_version`. Copy and adjust the example for your tracker before declaring
it. TOON is the default; `--json` returns the same compact summary: comparison hash,
observation/unit counts, equal-unit means, statistical verdict and remedy. Cohorts
and raw observations remain in the Plan and result Decision, available through
complete item reads (`pm get <plan-id> --depth standard --output-limit unbounded
--output-budget unbounded`). Output size does not grow with cohort size. For promotion,
set the held-out score's `seed_set` to the registered comparison hash, `scale`
to the declared reward-bound width, and `value` to exactly equal the report's
`candidate_mean`. Copy that mean unrounded from the `--json` output, since TOON
may format numbers differently. All three fields are checked against the frozen
plan and sealed evidence; rounding the mean causes an `eval_plan_evidence` refusal.

Each member supplies one candidate and incumbent outcome. The evaluator first
averages within each declared correlation unit, then weights units equally and
uses the **number of units** in the existing Hoeffding promotion gate. A hundred
related items in one project cannot count as a hundred independent samples.
Rewards are centered on the declared lower bound and rescaled to `[0, 1]` before
averaging and computing confidence bounds; the effect threshold is divided by
the declared reward width. This keeps large common offsets and subnormal scales
from erasing uncertainty. Ties never promote. Reported `candidate_mean` and
`incumbent_mean` retain the declared reward units; the statistical `verdict`
bounds, epsilons, margin and reason use the normalized units.
Unknown members, duplicates, supplied aggregate counts, changed objective/scale,
missing observations, extra observations and adaptive stopping are refused. Up to
10,000 members are supported. This fixed-stop format allows one sealed paired
look per plan, including a statistical refusal; retrying identical evidence is
idempotent. Changing a population, grouping, stopping size, criterion or incumbent
provenance changes comparison identity and requires a fresh plan/candidate.
Plan reads, evaluation retries and promotions compare sealed fields against the
SDK's verified version-one history snapshot. Replacing observations or a plan
and recomputing its hash is refused with `eval_plan_drift`. Missing, corrupt or
compacted-away original history also refuses; unrelated annotations remain allowed.
Candidate provenance is checked against its creation snapshot, while creation
order uses the original candidate and collection-run timestamps. Deleting a plan
and removing the candidate's pin cannot discard a reservation retained in history.
This relies on the SDK's append-only history: privileged rewriting of the original
history itself is outside this enforcement boundary.

`rl generation register` pins an existing plan in generation provenance. Both
manual and controller promotions re-read the plan and sealed outcomes inside the
existing promotion transaction; missing plans, comparison drift, changed parents,
late predeclarations, mismatched held-out scores and refused bounds stop promotion
with stable `eval_plan_*` codes and a remedy. The original contamination and
approval-budget checks still apply. Existing unplanned workflows retain their
legacy behavior and carry no predeclared causal-evaluation claim. A reserved
candidate remains gated even if its caller omits plan flags; a generation pin
also makes a deleted plan a refusal.

The typed SDK exports `EvaluationPlan`, `EvaluationObservation`,
`EvaluationPlanReport`, `EvaluationPlanRefusal`, `parseEvaluationPlan`,
`evaluationComparison`, `registerEvaluationPlan`, `readEvaluationPlan`,
`evaluatePlan`, `recordPlanEvaluation` and `enforceEvaluationPlan`. Tracker methods
accept a real `PmClient`; `evaluatePlan` is pure. Plans and results use core Plan
and Decision records; this does not replace pm-jev's decision-model calibration
or the separate powered-corpus dataset work.

Independence between declared units, truthful cohort membership, outcome
measurement and appropriate target-population selection remain experiment-design
assumptions. Paired policy replay alone does not establish a randomized causal
effect in a deployed population. The gate enforces the declared design and a
conservative bound; it cannot detect semantic correlations hidden from the plan
or prevent external peeking. Repeated experiments require their own selection or
multiplicity analysis. [Public tracker validation](docs/evaluation-plan-evidence.json)
records aggregate replay measurements and the unchanged read-only source digest.
The acceptance runner takes a read-only public tracker copy, an output report,
the public source commit and a packed package archive:
`node test/evaluation-plan.acceptance.ts <tracker-copy> <report.json> <commit> <package.tgz>`.
It installs the archive into a plain scratch tracker and runs the real JSON/TOON
CLI with Git absent from `PATH`.

## Without git

Tracker-based environments, runs, evaluations, predeclared plans, shadow
observation/comparison, generation promotion and lineage work in plain directories without Git. Public-history
dataset/improver builders and Git-tree episode replay need Git provenance. Plan
registration, evaluation and promotion are tested with Git absent from `PATH` and
an explicit discovery ceiling.

## Shadow policy deployment

Observe a candidate beside the active policy on explicitly consented, minimized inputs with `pm rl shadow register`, `observe` and `compare`, or the typed SDK equivalents. Candidate lookup failures preserve the active decision; both arms consume the reserved budget. The comparison receipt feeds the existing predeclared evaluation and generation promotion gate, so online switching requires validated outcomes and the existing approval. No candidate receives mutation or tool authority.

See [the consent, budget and promotion contract](docs/shadow-policy.md) and [registration example](examples/shadow-policy.json). Policies currently use bounded declarative lookup tables.
