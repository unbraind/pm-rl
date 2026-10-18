# History-prefix learner

The second tracker task predicts whether the time remaining until the first terminal
transition is at or below a median fixed on fit items. Both `closed` and cancellation
count as terminal. This task uses the public MIT source commits and repository roles
sealed in `meta-live-evidence.json`. GitHub visibility, licence and commit reachability
are verified again before reading history blobs. No hosted data is eligible.

Four candidate targets are screened only within training repositories: next lifecycle
state after the cut, an explicit return to `open` after first termination, initial item
type, and median time remaining. Time remaining was selected for its balanced binary
classes and plausible signal from elapsed time, activity and first-text vocabulary.
The committed receipt contains all four class distributions from the fit compartment.
Neither outer holdout chooses the task, quantile, feature vocabulary or search bounds.

The frozen fit-only screening result is:

| Target | Class counts (943 fit items) | Majority |
| --- | --- | ---: |
| Next lifecycle | closed 776; in_progress 155; canceled 9; open 2; blocked 1 | 82.291% |
| Reopened to open | false 926; true 17 | 98.197% |
| Initial item type | Issue 368; Task 240; Chore 214; Feature 111; Decision 6; Epic 4 | 39.024% |
| Time remaining | fast 472; slow 471 | 50.053% |

The median is **47356 ms**, fixed before outer evaluation. The dataset has 943 fit,
225 inner-held-out, 214 meta-validation and 385 final-test items from 25 public
repositories. An earlier training-repository screening also counted inner-held-out
items (1168 total); the final calibration and distributions above exclude them.


One example comes from each eligible item. The cut is `hash(id, seed) mod
first_terminal_event_index`, inclusive of that event and strictly before termination.
Missing or invalid timestamps and negative durations are ineligible. The cut may use
future history to establish an eligible prediction point; only events through the cut
become model inputs. Reopening and type are screening labels, never learner inputs.
An item hash assigns one fifth of training-repository items to inner-held-out; the
other training-repository items alone fix the median and train the learner. Original
repository roles remain fixed even if eligibility changes. The receipt records each
example's split, opaque item id, public repository, source commit and prefix digest.

The CPU learner uses an intercept and signed hash buckets containing event counts,
ordered event n-grams, field-change counts, logarithmic elapsed-time buckets, capped
author count and hashed words from the first visible title and description. It retains
no raw text or author identity. Counts are log-scaled; fitted weights are quantised to four decimal places so
checkpoint, receipt and mirrored completion event fit the unchanged 4096-byte
staging allowance. There is no pretrained model or
external download. Recipe bounds are regularisation 0–0.1, event n-gram order 1–3,
hashing widths 16/32/64 and learning rate 0.01–1. The existing selection and curriculum
knobs control training row selection and order; scalar-policy temperature and reward
weights do not affect this classifier. Each fit starts independently from zero weights
and makes one SGD pass over `steps * batch` rows, at most 512; repeated rows count
against the sample budget. Meta search changes recipes, never the evaluation gate.

`pm rl dataset build --task history-prefix --from-trackers <first-directory> <more-directories...> --output <new-directory>` builds this family.
Use [the fixed prefix programme](../examples/meta-prefix.json) with `pm rl meta run
prefix --file examples/meta-prefix.json --dataset <new-directory> --approval <decision>`. `pm rl meta run` uses
its existing approval reservation, controller, completion receipts and selection loop.
The packaged trainer gets only training observables and labels. Inner-held-out,
meta-validation and final-test rows never enter its stdin. One process step is reserved
before each fit, with at most 30 seconds wall/CPU and 4096 staging bytes, and zero model
tokens. The same pre-approved live Decision holds twenty process steps, 600000 wall/CPU
milliseconds, 81920 bytes, 20480 training samples, four proposals and two recipe
promotions. Actual search uses an initial fit and four candidates across two generations.

The inner gate evaluates each item once. It retains changed candidate parameters,
measured gain, conservative lower confidence bound, acceptance and explicit refusal
reason, even when the seed is retained. Fits that fail operationally abort acceptance.
The unchanged 0.95-confidence, ten-item, 0.01-effect gate chooses inner policies;
meta selection additionally allocates family-wise error over the planned comparisons.
Final testing happens after both selection generations. Its best constant-class
baseline and prediction diversity are descriptive; exact one-sided paired binomial tests of discordant wins/losses
against both predeclared constant classifiers report whether
there is evidence of an advantage. Both tests must reject: the reported p-value is
the larger of their p-values, so final labels do not choose the inferential baseline.
The gain lower bound applies a simultaneous Hoeffding bound against both constants;
the accuracy lower bound is one-sided at 95% confidence. Items within one repository are correlated, so
item-level bounds do not establish generalisation to an independent repository
population. A null result remains a null result.

Reproduce with `npm run build`, then `npm run test:live`. This opt-in suite verifies public sources, packs the implementation,
installs it into a disposable tracker and executes the actual `pm rl meta run` command.
The prefix family is the default; `PM_RL_TRACKER_TASK=terminal-disposition npm run
test:live` retains the original task. Runtime artifacts are retained locally. The sanitized live receipt belongs next to
the original receipt as `docs/prefix-live-evidence.json`. Release remains disabled.

## Live result

`npm run test:live` completes in 125124.91358699999 ms on the sealed 1767-example
corpus. Five real reserved process jobs finish `evaluated`, each with changed
parameters; zero inner policies or outer recipes promote. Measured use totals five
steps, 8986 ms wall, 15905 staging bytes, 382 CPU milliseconds and zero tokens;
the largest individual staging set is 3625 bytes, below the unchanged 4096 limit.

| Split | fast | slow | Majority accuracy |
| --- | ---: | ---: | ---: |
| Fit | 472 | 471 | 472/943 (50.053%) |
| Inner-held-out | 104 | 121 | 121/225 (53.778%) |
| Meta-validation | 74 | 140 | 140/214 (65.421%) |
| Final-test | 165 | 220 | 220/385 (57.143%) |

The independently fitted models show observable prefix-dependent predictions on
inner-held-out items, even though the gate retains their seeds:

| Fit | Correct / 225 | Gain vs seed | 95% gain lower bound | Fitted predictions fast / slow |
| --- | ---: | ---: | ---: | ---: |
| Initial | 124 | 0.013333333333333308 | -0.16774686876541595 | 111 / 114 |
| Generation 1, candidate 0 | 121 | 0 | -0.18108020209874925 | 0 / 225 |
| Generation 1, candidate 1 | 133 | 0.053333333333333344 | -0.1277468687654159 | 26 / 199 |
| Generation 2, candidate 0 | 115 | -0.026666666666666727 | -0.20774686876541598 | 166 / 59 |
| Generation 2, candidate 1 | 124 | 0.013333333333333308 | -0.16774686876541595 | 3 / 222 |

Every refusal is insufficient statistical improvement under the unchanged gate.
All four outer comparisons score 140/214, gain 0, family-wise lower gain bound
-0.21778781183411927. Retained policies predict only `slow`: 0 fast / 214 slow on
meta-validation and 0 / 385 on final-test; every pairwise disagreement is zero.
Final-test before and after are both **220/385**, equal to its majority baseline.
The paired comparison has 0 wins / 0 losses against the matching constant, maximum
one-sided p-value **1**, simultaneous gain lower bound **-0.13843052463687777**, and
one-sided accuracy lower bound **0.5090542065482301**. The learner does not establish
a final-test advantage or recursive improvement. No gate is loosened.

## Regression and diagnostic evidence

Nine behaviour-only reverts retain the regression tests and fail: checkpoint identity
replaced with recipe identity; prefix process validation removed; inner-held-out rows
included in calibration; feature vectors zeroed; source returned instead of fitted
weights; post-cut events exposed; target-balance refusal removed; positive binomial
verdict disabled; paired exact comparison removed. Restoring each mutation passes
its retained regression. The first eight restored cases also pass together. The actual reserved-process
regression also demonstrates synthetic inner acceptance, gap rejection, disjointness
refusal, cancellation and durable replay. The packed command runs in a real disposable
SDK tracker, with no SDK mocks.

Development diagnostics exposed two implementation defects before the final receipt:
an initial 4195-byte staging set exceeded the unchanged 4096-byte limit, and an inner
self-comparison used recipe identity for both fitted and seed checkpoints. Quantised
parameters fix storage; distinct checkpoint identities fix the comparison. The invalid
runs remain local diagnostic artifacts and are excluded from improvement claims.
The target, source roles, seed, recipe search bounds and statistical gate were fixed
before either outer holdout and were not tuned after these diagnostics.
