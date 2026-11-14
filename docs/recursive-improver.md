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

The input binding includes receipt schema `pm-rl/improver-receipts/3`.
Earlier receipts without probability calibration are incompatible: both interrupted
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

## Probability-calibration repetition

[improver-calibration-evidence.json](improver-calibration-evidence.json) records a
new three-generation run of the same frozen chronological corpus and programme.
It completed in 577722 ms under `nice -n 15`, two-core affinity and two-thread
environment caps. All 34 reserved fits settled, with zero recovery attempts,
8704 SGD updates and zero tokens. Measured process use was 187701 ms wall,
2950 CPU milliseconds and 92118 staging bytes. Source hashes and the full report
digest bind the aggregates; each durable phase's key, input and payload digest
is included. Every fit remains under its original 30-second/4096-byte allowance.

The development ledger contributes 2, 4 and 6 outcomes to the candidate policies.
Their failure priors and proposal probabilities change before the next meta
proposals are drawn: first-generation probabilities change from uniform 0.125
to 0.105263 on the two failed arms and 0.131579 on the other six. All twelve
matched sampled configurations nevertheless remain identical to the incumbent's
draws in this fixed-seed run. The ledger informs the proposal distribution; this
run does not show a changed sampled arm or improved proposer behavior. The
unchanged outer gate refuses all three candidates for two meta trackers versus
the required ten. All outer gains remain zero with lower bound -2.701814,
and descriptive tracker-level 95% score intervals remain [0, 1].

| Generation | Nonconstant fitted candidates / 10 | Beat training majority / 10 | Candidate held-out Brier range | Retained meta score | Promoted |
| --- | ---: | ---: | --- | ---: | --- |
| 1 | 10 | 10 | [0.243038, 0.359230] | 0.50 | no |
| 2 | 6 | 6 | [0.236055, 0.258490] | 0.50 | no |
| 3 | 5 | 7 | [0.226343, 0.260667] | 0.50 | no |

The separate final audit again retains the original constant learner:

| Target | Majority / retained correct | Descriptive item-level 95% accuracy interval | Brier | Log loss | ECE |
| --- | ---: | --- | ---: | ---: | ---: |
| Time-to-close | 8/16 | [0.160475, 0.839525] | 0.25 | 0.693147 | 0 |
| Issue type | 12/24 | [0.222779, 0.777221] | 0.25 | 0.693147 | 0 |

Both targets share one audit tracker, so these item-level intervals cannot be
pooled into independent tracker evidence; its tracker-level interval is [0, 1].
ECE is zero for a constant 0.5 forecast on the deliberately balanced sample.
That calibration does not establish useful discrimination or performance at
natural prevalence. All retained hard predictions are class one. Candidate,
retained and training-frequency calibration aggregates remain separate,
including every refused fit. The same five fixed reliability bins and descriptive
Hoeffding accuracy intervals as the original prefix benchmark are used.
No held-out probability recalibration, target tuning or gate change occurs.

The receipt is an explicit null. The capacity and statistical-power follow-ups
remain necessary before claiming recursive self-improvement on public trackers.
The three new behavior-only revert proofs and supported-entrypoint limitation
are recorded on `pm-rl-prefix`; old schema-2 receipts refuse before fitting.

## Configured terminal roles: acceptance remeasurement (2026-11-14)

The fresh audit below is against main `b2c1cfbd950d674183d5713b2f90d165efcb5f7b`,
including the write-once evaluation lifecycle from PR #153. The three suggested
controller slices already have real behavioral tests. Eight selected main
process/LM tests passed locally with no failures, skips or cancellations, and
[exact-main CI](https://github.com/unbraind/pm-rl/actions/runs/43541726149) passed
its npm Node 22/26 and Bun Node 26 jobs.

| Epic acceptance criterion | Current main proof: implementation; exact test | Missing / boundary |
| --- | --- | --- |
| Two real training generations change checkpoints and collect with the promoted successor | index.ts, loop.ts, process.ts; test/process-loop.test.ts: two process generations collect with the externally trained promoted successor; test/corpus.test.ts: real non-git corpus command trains two successors, resumes sealed inputs and preserves source bytes; docs/tracker-loop-evidence.json records a public pinned corpus run | Delivered for the bounded reference learner. Collection is incomplete for configured terminal registries: improver-data.ts projectImproverHistory recognizes only literal closed/canceled/cancelled. Existing child pm-rl-history-status-roles tracks this missing generalization. |
| Bounded LLM adapter demonstrates parameter updates | lm.ts, index.ts; test/lm-loop.test.ts: pm rl loop run performs real recursive self-improvement on the language model (two promotions then a sealed refusal) | Delivered for the bounded tiny LM; does not establish large-model improvement. |
| Two controllers launch a job once | index.ts controller lease and process.ts job fence/reservation; test/process-loop.test.ts: two real controllers race for one job: one launch, one reservation and one checkpoint | Delivered, including real processes against the same tracker. |
| Crash and cancellation preserve artifacts and budget integrity | process.ts and index.ts; test/process-loop.test.ts: SIGKILL with a complete checkpoint before receipt commit recovers without retraining or double charge; SIGTERM mid-training cancels the child, retains artifacts and settles its reservation; real controller crashes after planning, evaluation and promotion resume the same job identity | Delivered for documented phase boundaries; cancellation may deliberately leave a terminal cancelled job. |
| Contamination and invalid checkpoints stop promotion | lm.ts, process.ts, promotion.ts, evaluation-lifecycle.ts; test/lm-loop.test.ts: a contaminated programme is refused before any completion is collected; a tampered candidate checkpoint is refused as invalid before the chain advances; test/evaluation-lifecycle-verdict.test.ts write-once verdict regressions | Delivered at the declared data/checkpoint boundaries. No statistical threshold will be tuned for this work. |
| Every authored source passes exact four-metric coverage and documented-surface gates | package.json coverageGate and scripts/coverage-gate.ts/docstring-gate.ts; successful exact-main CI run https://github.com/unbraind/pm-rl/actions/runs/43541726149 | Main has recorded passing CI; the new branch still requires its own touched-source measurement and exact-head CI. |


The selected gap is the first row's custom-schema collection boundary, tracked
by `pm-rl-history-status-roles`. Chronological improver projection previously
recognized only literal `closed`, `canceled` and `cancelled`. It now receives
the pinned source registry and uses the SDK's terminal-role and alias semantics.
Terminal-disposition verification projects configured lifecycle roles to its
existing vocabulary. The synchronous builder reads settings and the optional
status file from the same immutable Git tree as histories. SDK normalization
merges inline/default definitions with array, `statuses` or `definitions` file
containers. A source-relative schema reference must stay inside that tracker.
Working-copy edits cannot change the pinned labels. Historical sealed datasets
and the legacy three-argument projection retain their existing read contract.

The new tests compare terminal sets with real SDK settings reads, exercise 128
seeded registries and aliases, preserve released histories, and read sealed
datasets in a plain directory. This changes input collection only: existing SDK
controller leases, workspace transactions, sealed verdict history and approved
resource budgets still govern execution. There is no new launcher or budget
store and no SDK gap. The separate literal-vocabulary history-prefix builder is
tracked by follow-up `pm-rl-prefix-status-roles`.

### Fresh public CLI run

[The aggregate receipt](history-status-roles-evidence.json) records a fresh packed
CLI run against the public MIT `unbraind/pm-ops` tracker at
`eba7d5262fd75e67afce0caad29dae7dc7dfbaeb`. Public visibility and exact commit
were checked before copying. Both source and controller were plain directories.
All 300 durable source files remained unchanged; SDK runtime/cache files are
excluded. The corpus has 105 training and 41 held-out items.

The existing `examples/loop-corpus.json` supplies the two-generation schedule and
unchanged statistical thresholds. A separate scratch Decision approved two
promotions and 16 optimizer updates, 10,000 wall milliseconds, 524,288 staging
bytes, 2,000 CPU milliseconds and zero tokens. The real installed CLI executed:

```sh
node node_modules/@unbrained/pm-cli/dist/cli.js --author codex-rl-apvf-1114 rl corpus build --from-tracker source/.agents/pm --file examples/loop-corpus.json --output programme.json --json
node node_modules/@unbrained/pm-cli/dist/cli.js --author codex-rl-apvf-1114 rl loop run public-recursion --file programme.json --approval public-approval --json
node node_modules/@unbrained/pm-cli/dist/cli.js --author codex-rl-apvf-1114 rl loop resume public-recursion --approval public-approval --json
```

Paths above are relative reproduction coordinates; initialize a separate scratch
tracker and install the packed extension there first. The receipt records the
executed artifact and implementation hashes.

| Generation | Source checkpoint SHA-256 | Candidate checkpoint SHA-256 | Exact held-out expectation | Sampled incumbent → candidate | Decision |
| --- | --- | --- | ---: | --- | --- |
| 1 | `17493680209cdf2fc86126ff2ad0b7bb6063ae24ce00f28f931224bb5ab2fd11` | `2df645949b852625c2acdc20bf5232620cac8c87d1ab1f8f85c4221da14ac605` | 0.5979768546 | 0.499825 → 0.597650 | promote |
| 2 | `2df645949b852625c2acdc20bf5232620cac8c87d1ab1f8f85c4221da14ac605` | `3e31b06286e99d6b3d73486216f98f0c6d519228cac4bcbefc56f4945c292863` | 0.6810112913 | 0.595100 → 0.685825 | promote |

Generation two's collection component equals generation one's promoted
checkpoint. The two settled jobs charge eight updates each; terminal replay
retains their checkpoint bytes and consumes no extra reservation. Collection
uses 512 samples total; evaluation uses 40,000 policy episodes per side per
generation. Repeated episodes over 41 items are adaptive finite-corpus
validation, not independent tracker samples or evidence of proposer transfer.
This run verifies the existing unattended loop on real data; the new
custom-status behavior is established by SDK-backed pinned-source regressions.

### Behavioral revert evidence

Each isolated variant keeps the new tests, typechecks, and exits 1 on a retained
assertion. The fixed checkout is never reverted.

| Variant | Changed function behavior | Regression selection in `test/history-status-roles.test.ts` |
| --- | --- | --- |
| `projection-literal-terminals` | `projectImproverHistory` recognizes only the old three literal terminal strings | `SDK roles` |
| `dataset-literal-statuses` | `trackerHistoryExample` ignores SDK status normalization and terminal sets | `SDK roles` |
| `builder-ignores-registry` | `buildImproverDataset` omits its pinned registry when projecting histories | `improver builder pins` |
| `registry-working-tree` | `committedTrackerStatusRegistry` reads working settings instead of the pinned tree | `improver builder pins` |

Exact commands are `npm run typecheck` and
`node --test --test-concurrency=2 --test-name-pattern="<selection>" test/history-status-roles.test.ts`.
After restoration, the complete new regression file passes 3/3.

### Targeted gates

The final focused coverage command passed 18/18 tests with 462/462 lines,
305/305 branches and 79/79 functions across `dataset.ts` and `improver-data.ts`.
One additional existing source-path regression passed 1/1 and completed the
repo gate's V8 statement measurement at 303/303 blocks. Every threshold stays
at 100%. New linked regressions passed 3/3 through `pm test --run --progress`;
typecheck, test declarations, lint, documented surface (572 declarations) and
duplication (zero clones) pass. Full npm/Bun release certification belongs to
the PR's exact-head CI; local focused evidence is not a full-suite claim.

The coverage selection runs `test/history-status-roles.test.ts`,
`test/dataset.test.ts`, `test/improver.test.ts`,
`test/transfer-review-native.test.ts`, `test/transfer-review-capacity.test.ts`
and `test/prefix.test.ts` with `--test-concurrency=2`, the two touched-file
`--test-coverage-include` flags, and line/branch/function thresholds 100.
The selection is:

```text
SDK roles|improver builder pins|committed registry|history extraction|builder reads|builder fails|mixed-case|dataset readers|source limits|empty public|cubic: every dataset|repository identity|leakage sentinel|chronological splits|frozen public task|malformed role|powered role projections|public snapshot builder
```

The supplementary selection is `pm-cli position controls` in
`test/transfer-review-round2.test.ts`. Both runs share a fresh scratch V8 output
directory; `computeStatementCoverage` from `scripts/coverage-gate.ts` enforces
100% over their combined exact-source reports. Run-artifact records stay outside
this package's planning tracker; only minimized receipts are committed here.
