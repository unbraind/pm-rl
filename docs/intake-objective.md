# Creation-time Issue routing with balanced accuracy

This builds on **#94 and #95 and must merge after both**. Work is tracked on
[pm-rl-baseline](https://github.com/unbraind/pm-rl/blob/main/.agents/pm/tasks/pm-rl-baseline.toon).
The old snapshot-status task and all three negative results remain in
[baseline-frontier.md](baseline-frontier.md). No candidate in this experiment
beats the mandatory heuristic; no successor is promoted.

## Data-first diagnosis

The same public MIT `unbraind/pm-ops` commit
`eba7d5262fd75e67afce0caad29dae7dc7dfbaeb` contains 146 tracker items.
The original split has 77 closed / 28 other training items and 36 closed / 5
other held-out items. Always-closed predicts closed for every input: its
class-conditional rewards are 1 for closed and 0 for other, producing
36/41 = 0.8780487805 overall. Always-other earns 5/41 = 0.1219512195.
The three previous learners earn 0.8713980699, 0.8645003749 and 0.8534392510;
their greedy decisions are all closed. They were correctly refused.

Mean normalized-title lengths are 82.5325 versus 89.5 in training and
79.8611 versus 79.8 in held-out, for closed versus other. Length alone carries
little held-out separation. The vector adds title words but no timing or
lifecycle observations. It recognizes current status from possibly edited
titles; it does not predict future closure. These measurements explain the
majority shortcut without claiming that no possible title classifier could
ever beat it.

All 146 items have a creation event containing the original title and type.
The new task routes a proposed intake title to the Issue queue versus other
work, using the creator's initial type as the historical label. This is a
bounded triage task an agent can use before choosing an item's type. It does
not forecast reopening, duration or which open item closes next. Training-only
word counts show a real association: `publish` occurs in 15 Issue versus 1
other title, `npm` in 10 versus 0, `pm` in 9 versus 22, and `ops` in 4 versus
13. The low-capacity hash representation may not recover all that information.

## Frozen objective and baselines

The metric is **stochastic balanced accuracy**:

```text
0.5 * (mean P(action=Issue | Issue) + mean P(action=other | other))
```

It measures the deployed stochastic policy, rather than substituting greedy
decisions after training. Every input-independent policy, including either
constant and every constant probability, scores exactly 0.5. All items remain
in their compartments; there is no majority downsampling. Training alternates
classes and cycles within each, using training labels only. Every optimizer
pass still consumes only collected source-policy actions and rewards.

The fixed non-learning router predicts Issue for whole words matching
`bug|fix|fail*|error|regression|security|refus*|reject*|corrupt*|broken|crash*`.
It was declared and measured during diagnosis before the new fits. Its training
balanced accuracy is 0.5988562. No keyword, target, split, learning budget or
threshold was tuned after fitting.

The versioned seal binds creation-title projections, target labels, fixed
heuristic actions, datasets and environment. Only the first create event is
read; later events are not model inputs. The 64 fixed title columns are
unchanged. Original title lengths determine the same conservative grouped
split, so identical projected inputs and renamed duplicates stay together.
Initial type, item identity and label frequencies never enter policy features.
Changing the task creates a new programme identity; legacy seals and receipts
retain their original identities and exact replay behavior.

The resulting split has 104 training items (68 Issue / 36 other) and 42
held-out items (22 Issue / 20 other). The slight difference from #95's split
comes from using creation titles instead of current edited titles.

Every candidate must pass the original exact improvement, sampled Hoeffding,
gap, checkpoint, contamination, approval and resource gates. The item gate
additionally requires paired lower effects **strictly above 0.01** against the
incumbent, both constants and the fixed keyword router. Its 8,192 deterministic
bootstrap replicates resample items separately within each class and average
class means equally. Identical draws pair each comparison. Bonferroni adjusts
four comparisons to nominal 95% family confidence per attempt. Each held-out
class must contain at least the configured ten items. Repeated action episodes
never increase the item count.

Intervals assume exchangeability within classes and are conditional on this
frozen corpus. Related items, adaptive objective diagnosis and repeated
generation selection limit inference; there is no independent final-test,
cross-repository or temporal generalization claim.

## Three real external attempts

| Policy | Balanced accuracy | Nominal 95% item CI | Promoted |
| --- | ---: | --- | --- |
| Constant other | 0.5000000000 | [0.5000000000, 0.5000000000] | baseline |
| Constant Issue | 0.5000000000 | [0.5000000000, 0.5000000000] | baseline |
| Fixed keyword router | 0.6545454545 | [0.5340909091, 0.7727272727] | baseline |
| Generation 1, rate 1 | 0.6080315976 | [0.5184090204, 0.6933652525] | no |
| Generation 2, rate 0.5 | 0.5915538072 | [0.5245356249, 0.6579211102] | no |
| Generation 3, rate 0.25 | 0.5667374267 | [0.5221832763, 0.6118104112] | no |

The first two attempts fail adjusted incumbent/constant improvement. The third
clears their 0.01 lower-effect bound but fails the heuristic. All three paired
effects against the heuristic include zero and have negative point estimates.
There are **three recursive proposal attempts and zero promoted successors**.
Refused candidates never collect or become lineage parents. Lower learning
rates come from the existing refusal schedule, not a held-out tuning search;
the collected action streams also differ.

Candidate checkpoint digests, in order:

```text
989342db5ba90fc607932c4bc25a9a68461361fdf366ebbba7cad71c6f8e8e70
8f71594a490475ad17c7f56215464e1bd7af75cd414752d3c23b846da1447a3f
e9c25380609fae64ac046f21f42c2cada97c27b0b8b0b97d21f06e0dc7afd3d6
```

The seed and retained final checkpoint are both
`17493680209cdf2fc86126ff2ad0b7bb6063ae24ce00f28f931224bb5ab2fd11`.
All three jobs settle 256 updates exactly once; total collection is 3,072
actions. Resume verifies three generations, preserves checkpoint bytes and
launches no new jobs. Status agrees, and all 300 source files are unchanged.
Full class counts, paired intervals and resource receipts are in
[intake-objective-evidence.json](intake-objective-evidence.json).

## Reproduction and verification

Copy the explicitly selected public commit's tracker to `source/.agents/pm`,
then run from a fresh output directory:

```sh
node scripts/live-baseline.ts source/.agents/pm acceptance examples/loop-intake-objective.json
```

The same objective is available through the installed command:

```sh
pm rl corpus build --from-tracker source/.agents/pm \
  --file examples/loop-intake-objective.json --output sealed-intake.json
```

Then use `pm rl loop run` with that sealed file and an independent approval.
The shipped three-attempt bounds require 768 total updates, 90,000 wall
milliseconds, 786,432 storage bytes, 30,000 compute units and zero tokens.

The caller owns public-source and licence verification. The runner reads a
certified complete inventory, projects its creation histories, initializes a
separate plain SDK tracker and executes actual external trainer processes.
Source data, text, identities and local coordinates are absent from the report.

`test/objective.test.ts` covers unequal class frequencies, constants at 0.5,
mandatory heuristic refusal, label-independent features, malformed seals,
renamed-input grouping, creation-only projection, balanced fitting and sealed
replay. Actual SDK/process acceptance runs in-process and with no Git executable
and `GIT_CEILING_DIRECTORIES` in temporary trackers. Existing crash, cancellation,
resource, contamination and legacy numerical suites remain required.

Local targeted tests, typecheck and lint run before publication. The complete
release gate runs in CI under npm on Node 22/26 and Bun on Node 26 with all four
coverage thresholds unchanged at 100%. Final run receipts are recorded on the
tracker and PR; a pending or failed run is not passing evidence.
