# Recursive proposal-policy improvement

`pm rl improver run` implements two distinct promotion levels. A learner is a
checkpoint plus a feature configuration. An improver is a content-addressed
`pm-rl/improver/1` artifact containing a frozen search space, a proposal strategy,
explicit Beta success/failure priors, accumulated promoted gain, a version, its
parent digest and its development-ledger digest. The initial policy fixes eight
feature/optimizer arms and an exploration mixture before any evaluation. Policy
sampling has no dataset capability.

Each generation proposes K configurations for each development task. Each actual
CPU fit uses the existing process trainer, atomic resource reservation, checkpoint
validation, immutable completion receipt and settlement. Training receives only
training prefixes and labels. The existing `decidePromotion` gate, minimum ten
samples, effect 0.01, confidence 0.95 and maximum training/evaluation gap 0.3 decide
which learner survives. Error is allocated across all planned learner and improver
comparisons, making each individual bound more conservative. Every fit uses the
same declared number of SGD updates, including repeated rows; learner candidates
start from zero and compete with the retained learner.

The update step rebuilds priors from the programme's immutable initial artifact
and its complete, unique development outcome ledger. A promoted artifact used
as a later programme's initial policy retains its learned priors; cumulative
updates count each new outcome once. Successes and failures change proposal probabilities; only promoted gains
contribute to its gain preference. Merely changing version metadata cannot satisfy
the regression. Rejected proposals remain useful evidence. The candidate improver
has the retained improver as parent. Rejected candidate revisions may share a
version number; their content and ledger digests remain distinct.

The candidate improver and incumbent then each propose K configurations for each
separate meta task, starting from identical constant learner baselines. Both get
the same optimizer updates and process allowances. The outer objective is the
score of the best **promoted** learner reached within that budget, including the
constant if every fit is refused. It is not the best unpromoted fitted score.
The unchanged gate compares those scores, averaging the two related targets within
a tracker before counting trackers as samples. Only a better bounded score can
promote the improver. Meta outcomes never update its priors. Repeated selection makes meta validation
adaptive; the audit is the separate final benchmark. Untouched audit
trackers are opened after every generation's promotion receipt is durable.

## Real chronological tasks

The builder first verifies public GitHub visibility, MIT licensing and source
commit reachability using the existing public dataset boundary. The live command
copies the declared tracker snapshots into scratch Git clones; canonical trackers
are read-only. No hosted data is eligible. Source pins come from the existing
public corpus. The small live cohort fixes `pm-csv`, `pm-beads`, `pm-rl` and
`pm-starter`. Eligibility diagnostics excluded sources with no initial type,
without using fitted or promoted scores to choose replacements. These four
trackers are then assigned new, disjoint
40/40/20 development/meta/audit roles using the fixed repository hash ordering.
This small cohort is deliberate: separate durable process fits dominate runtime
on the shared CPU host. Larger diagnostic attempts were interrupted and are not
acceptance evidence.

There are two fixed binary targets: median time remaining until the first terminal
transition (`fast`/`slow`) and initial item type (`Issue`/other). Each prediction is
one millisecond after creation, independent of future history length or close time.
Only events strictly before that timestamp supply inputs. Type and priority fields
and values never enter features. Features are bounded operation/field counts,
hashed first-title/description words, elapsed time and distinct-author count; raw
text and author identities are not exported.

Within each tracker, the earliest 60% prediction times establish the boundary.
Training predictions must precede it, and their target labels must already be
available before it. Time-to-close calibration uses those training durations only;
the even-sample median is the midpoint of the middle values. Training and later
held-out rows are stratified to equal class counts using a fixed earliest-item
rule. Neither labels nor items cross the time boundary. Missing timestamps,
nonmonotonic histories, imported terminal snapshots, missing initial type and
insufficient balanced cohorts are omitted. This is a completed-item cohort, with
selection and censoring limitations; it is not a forecast for all open work.

The split reader checks content digests, tracker roles, unique item ids, chronology,
label availability, valid inputs and balance. A sentinel regression changes future
operations, future text, an event exactly at prediction time and the type label;
features must remain byte-identical. Removing only the strict history filter makes
that test fail.

## Reproduce and recover

Build the package, then run `npm run test:live:improver` against the explicit fleet
input `PM_RL_TRACKER_ROOT`. The command has a 20-minute parent watchdog, makes no
model requests, and uses one trainer process at a time. Its live programme fixes
seed 42, three generations, K=1 and 256 SGD updates per fit; the general API also
supports K>1. The whole experiment, including source verification, dataset building,
packaging and the packed CLI invocation, must fit the watchdog. The 34 nominal
fits allow at most 68 process attempts and 17,408 SGD updates including
recomputation; a normal run uses 8,704 updates. Both meta contenders have the
same two-attempt cap, and a recovery fit restarts from identical parameters. Artifacts remain
in ignored tracker-owned runtime state. No source histories or checkpoints are
committed to this repository.

For another corpus, use `pm rl improver build --from-trackers <first-directory>
<more-directories...> --output <new-directory>`. The typed SDK exports
`improverConfiguration()` and `runRecursiveImprover()`. Serialize a configuration
and create an existing Decision with a `resource_budget` sufficient for
`improverBudget().max_process_jobs` times the fixed `IMPROVER_ADAPTER.allowance`. Invoke:

```sh
pm --author codex-agent rl improver run example --file programme.json --dataset dataset --approval decision-id --json
```

The pinned host requires explicit `--author` for extension-client attribution;
`PM_AUTHOR` alone does not reach that injected client. Repeat the exact command
to resume. Every proposal, fit, updated policy,
generation and promotion has a PM item and append-only history. Controller leases
and fenced, input-bound step receipts adopt completed work. Every logical fit has at most two predeclared process slots. A missing or partial
receipt after a hard kill may use the second slot with identical source parameters
and training rows. The first failed job and its conservative charge remain in
history; each individual process identity still launches at most once. Valid
receipt/lineage drift and cancellation refuse. Exhausting both slots stops the run.
A kill after an improver update adopts its original settled jobs and updated artifact. The original absolute deadline
is persisted, so repeated resumes cannot replenish time. Completed replay launches
no jobs. Dataset, configuration, approval or receipt drift refuses. Ambiguous
holders use the same command with `--force-takeover`; live holders still block.

The input binding includes receipt schema `pm-rl/improver-receipts/2`.
Earlier receipts without candidate diagnostics are incompatible: both interrupted
resume and completed replay return typed `loop_step_drift` at the programme
receipt before launching any fit. Use a new programme identity for a new run.

Each trial now records the fitted candidate's held-out class counts (`0` and
`1`), number of distinct predictions, training accuracy, training majority
accuracy, and whether training accuracy exceeds that majority. These aggregates
include rejected candidates, separately from retained learner scores. Every
generation also reports `any_candidate_beats_train_majority` across development
and both meta searches; audit diagnostics remain separate and open only after
selection. Class `0` means fast/Issue and class `1` means slow/other.

## Measured result

| Generation | Time-to-close | Item type | Majority / retained seed | Meta score (95% tracker CI) | Improver promotion | Held-out constant candidates | Beat train majority |
| --- | ---: | ---: | ---: | --- | --- | ---: | ---: |
| 1 | 0.50 | 0.50 | 0.50 / 0.50 | 0.50 [0.00, 1.00] | refused | 0/10 | 10/10 |
| 2 | 0.50 | 0.50 | 0.50 / 0.50 | 0.50 [0.00, 1.00] | refused | 4/10 | 6/10 |
| 3 | 0.50 | 0.50 | 0.50 / 0.50 | 0.50 [0.00, 1.00] | refused | 5/10 | 7/10 |

All three outer gains are zero, with simultaneous lower gain bound
-2.701813717997259. Each comparison has confidence 0.9986486486486487 after
allocation over 34 fits and three outer comparisons. Every improver is refused
for insufficient samples: two distinct meta trackers, with 100 held-out target
examples across them. Development contains one tracker (36 time-to-close and
32 item-type held-out examples); final audit contains one separate tracker
(16 and 24 examples). Both audit scores remain 0.50 before and after.

The diagnostic columns count all ten fitted proposals per generation across
development and both meta contenders. Held-out class distributions show 21/30
nonconstant candidates; 23/30 exceed the training majority, and the generation
summary boolean is true in every generation. Candidate held-out accuracy spans
0.375 to 0.666667. Audit diagnostics, opened after selection, show 2/4 constant
candidates and 2/4 beating training majority; their candidate accuracies are
0.375 and 0.50, while all retained audit scores stay 0.50. Exact per-candidate
class counts, distinct prediction counts, training accuracies and majority
comparisons are in the evidence JSON.

Thus the table's null is the constant incumbent retained by the unchanged inner
gates, followed by an outer gate with insufficient independent trackers. It is
not uniform fitted-candidate collapse: some proposals fit training signal and
predict both held-out classes, while other feature configurations predict a
single held-out class. Neither training fit nor an isolated higher held-out
point estimate establishes statistically bounded improvement.

Every generation adds two development outcomes to the ledger. The candidate
artifacts retain distinct ledger digests and changed failure priors at two, four
and six observations, while the outer gate retains the original improver.
This is an honest, statistically underpowered null. The small cohort cannot
establish that an updated proposer is better. Follow-up `pm-rl-rsipower` requires
a separately powered benchmark. The single review-fix repetition completed in 244.523 seconds, with
34 successful reserved process jobs, zero recovery attempts and zero tokens.
Measured process use was 71684 ms wall, 2971 CPU milliseconds
and 92102 staging bytes. The parent watchdog covers the complete run.
Source, dataset, policy, budget and timing receipts are recorded in
[improver-live-evidence.json](improver-live-evidence.json).

Item-level learner bounds and tracker-level outer bounds are different claims.
This bounded cohort has fewer than ten meta trackers, so it cannot pass the
unchanged outer minimum sample count. A null result here establishes execution,
attribution and refusal, not statistical evidence of better proposals. Related
fleet trackers can also share development practices, limiting any broader
population interpretation. Balanced held-out sampling estimates performance on
the declared balanced target rather than natural class prevalence.

## Regression evidence

The complete synthetic suite uses real temporary trackers, real Git snapshots and
real reserved trainer processes. It demonstrates a successful inner promotion,
regression/gap refusal, update-sensitive proposal changes, both outer gate
outcomes, immutable budgets, data drift refusal and a real SIGKILL after the
ledger update. It removes the audit file until all three selections commit, then
resumes successfully and verifies identical terminal replay and job counts.
Behavior-only reversions of the prior update and strict history filter fail with
the tests retained; restoring each implementation passes. The PM item records
exact commands and results. No SDK mocks are used.

Round 1 adds four behavior-only revert proofs with the new tests retained:

| Fix | Regression command (`node --test ... test/improver.test.ts`) | Reverted behavior and failure |
| --- | --- | --- |
| Exact parsed repository identity | `--test-name-pattern='repository identity'` | Suffix lookup chooses the other owner's commit; Git cannot read that tree. |
| Finite numeric learning rate | `--test-name-pattern='learning rate'` | Removing `Number.isFinite` accepts a numeric string; the required rejection is missing. |
| Deadline after pack/install | `--test-name-pattern='public command builds'` | Moving remaining-time calculation before packaging fails the package-exists timing assertion. The restored path also checks installation completion and exhausted-deadline refusal. |
| Finally-based live fixture cleanup | `--test-name-pattern='live fixture cleanup'` | Removing cleanup leaves generated entries; the before/after inventory differs. The restored test covers success and assertion failure. |

All four reverted variants exit 1. Restored focused acceptance passes 5/5,
including actual constant and nonconstant candidate diagnostics and the packed
worker path. Cleanup removes only entries absent from the initial inventory and
restores the executable search path even on failure. The complete run deadline
includes dataset preparation, packaging and package installation; an exhausted
budget refuses before writing a programme or invoking the training CLI.

Implementation digests use `hashJson` on UTF-8 source text, matching the package's canonical JSON hashing. Time-to-close uses the same all-slow zero-weight baseline retained by the previous prefix learner; class one maps to other for the new item-type target.


Round 1 full release acceptance on source head `3d4fb10` passed in
[CI run 39282564621](https://github.com/unbraind/pm-rl/actions/runs/39282564621):
`npm run release:check` on Node 22 and Node 26, and `bun run release:check` on
Node 26, each with 653/653 tests, zero failures/skips/cancellations/todos,
44/44 source files present and 100.00% statements, lines, branches and
functions. Thresholds, dependency pins and the existing runtime smoke limits
are unchanged. The CI merge checkout and branch head have identical trees.
