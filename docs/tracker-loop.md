# Recursive execution on a tracker snapshot

`pm rl corpus build` reads a complete SDK inventory from an explicitly selected
local tracker, with extensions disabled. It does not invoke Git, mutate the
source, or read hosted services. The output is an exclusive new JSON file for
`pm rl loop run`. Run performs collect → external train → held-out evaluation →
gate → promote for the declared number of generations unattended. Only a
promoted checkpoint collects the next generation. Resume uses the seed's sealed
configuration, so subsequent source edits cannot silently change its data.
The corpus builder accepts the bandit trainer; selecting another trainer refuses
before output publication.

The output must be a new file outside the source tracker. Existing files,
directories and dangling symlinks refuse with `corpus_output_exists` before
reading bounds or source items. Canonical source and output-parent paths reject
destinations inside the source, including symlink aliases, with
`corpus_output_inside_source`. Publication retains exclusive creation; a
concurrent creator receives the same typed conflict without exposing a path.

The task is deliberately small: recognize the snapshot's `closed` status from
normalized title length. Every other status has target zero. The single
logistic weight receives actual on-policy sampled rewards. The shipped programme
declares eight optimizer updates per external process, with importance ratios
correcting every later update back to the collecting policy's action probabilities.
`fit_steps` is bounded to 1–256 and must equal the process reservation; omitted
values retain the original one-update behaviour and programme identity. Every
update is charged. A finite-difference regression checks the empirical
importance-weighted reward objective. The feature is `log(1 + min(256, length)) / log(257)`;
length counts Unicode codepoints after NFKC, whitespace and case normalization.
Status is never a feature. This is snapshot recognition, not time-to-close
forecasting, code improvement, or a new LLM adapter. The existing bounded LM and
Compose adapter remain covered by their numerical and real-container tests.

The builder accepts at most 10,000 items and requires at least two items in each
partition. The split is fixed before fitting: all items with the same projected length
belong to one partition, using a fixed SHA-256 modulo-five assignment. Thus
renamed duplicate inputs, including conflicting labels, cannot cross the
training/evaluation boundary. The receipt retains only hashed item/content
identities, projected lengths and labels. It binds the dataset, environment,
programme and persisted seed. `corpus_invalid_seal`, `corpus_snapshot_drift`,
`corpus_duplicate_item`, and `corpus_dataset_drift` refuse malformed evidence or
edited datasets before collection. Ordinary programmes continue to use their
existing contamination checks. Existing process checkpoint validation and typed
refusals are unchanged.

The existing controller owns leases, fencing, durable phases, reservations,
staged completion recovery, cancellation and promotion. There is no additional
job launcher. Two competing controllers still share one launch and reservation.
Mid-fit cancellation retains artifacts and settles conservatively; a cancelled
external fit requires a new programme identity. A crash after durable completion
adopts the original checkpoint and charge. Corpus sealing does not weaken those
contracts or enlarge an approval.

Evaluation reports exact expected reward on the finite held-out corpus and
sampled policy reward under the existing Hoeffding gate. Many policy episodes
reuse those items; their count is not a count of independent tracker items.
Repeated selection is adaptive validation. The closed/open constant classifiers
are reported to distinguish progress over an untrained policy from useful
prediction; there is no independent final-test or cross-repository claim.

## Reproduction

Use a copied, explicitly authorized public `.agents/pm` tree as `source/.agents/pm`.
Keep it read-only. Initialize a separate plain scratch tracker with `pm init`,
install the packed package with `pm package install`, and follow the commands in
the README. Declare the approval separately before running. The source repository
and commit are caller-attested provenance; the builder verifies content, not a
remote's visibility or licence. Never select private or hosted trackers by default.

`test/corpus.test.ts` executes the command and two actual process fits with a
Git-free PATH and `GIT_CEILING_DIRECTORIES`, checks byte-preserving source reads,
the promoted successor's collection component, unchanged replay artifacts and
one charge per fit. A separate inverted held-out fixture proves a changed but
non-improving candidate is refused. Existing process/controller/Compose suites
provide physical crash, cancellation, contention and corrupt-checkpoint drills.
Source immutability checks hash sorted relative filenames and exact bytes for
all regular tracker files, including settings, nested item folders and
`search/eval-queries.json`. SDK runtime, locks, transactions, checkpoints and
other search cache files are excluded. A focused regression checks durable-file
additions, removals, renames and binary changes while allowing cache updates.

## Public corpus measurement

[The machine-readable receipt](tracker-loop-evidence.json) pins the public
`unbraind/pm-ops` tracker at `eba7d5262fd75e67afce0caad29dae7dc7dfbaeb`.
Its 300 copied tracker files were read-only and byte-identical afterward. Neither
the source copy nor the controller tracker was a Git repository. The seal contains
146 items: 105 training and 41 held-out, with 36 held-out items closed.

The initial one-update experiment changed its checkpoint but scored 0.511125
sampled held-out reward, failing the unchanged confidence/effect gate. It
promoted nothing and did not collect a successor. The receipt retains that null.
The subsequent independent eight-update programme used the same corpus and
thresholds, with a separately declared 16-update resource allowance.

| Generation | Source checkpoint SHA-256 | Candidate checkpoint SHA-256 | Exact expected held-out reward | Sampled incumbent → candidate | Promoted |
| --- | --- | --- | ---: | --- | --- |
| 1 | `17493680209cdf2fc86126ff2ad0b7bb6063ae24ce00f28f931224bb5ab2fd11` | `2df645949b852625c2acdc20bf5232620cac8c87d1ab1f8f85c4221da14ac605` | 0.5979768546 | 0.499825 → 0.597650 | yes |
| 2 | `2df645949b852625c2acdc20bf5232620cac8c87d1ab1f8f85c4221da14ac605` | `3e31b06286e99d6b3d73486216f98f0c6d519228cac4bcbefc56f4945c292863` | 0.6810112913 | 0.595100 → 0.685825 | yes |

The untrained policy's exact expected reward was 0.5. Generation two's collection
Run component was independently checked against generation one's promoted
checkpoint. Weights changed from 0 to 0.6829963491 to 1.3452115702. Each generation
collected 256 actual actions, evaluated 40,000 held-out policy episodes per side,
and charged eight optimizer updates once. The command took 124.736 seconds on
the shared host; process wall charges were 1,591 and 1,157 ms, CPU charges 6 and
7 ms, and retained staging 2,200 bytes each. Resume verified both generations
without changing checkpoint bytes; status agreed with the accepted final policy.

This is a measured stochastic-objective improvement over the seed. **It does
not beat the always-closed classifier**, which scores 36/41 = 0.8780487805;
both learned greedy classifiers also predict closed for every item and tie that
baseline. The always-other classifier scores 5/41 = 0.1219512195. This receipt
does not establish useful forecasting, cross-repository improvement or an
independent final-test win. Implementation hashes identify the measured code.
Subsequent preflight checks do not change the measured optimizer or promotion
criterion.

## Verification receipts

The prior [complete CI](https://github.com/unbraind/pm-rl/actions/runs/39645374144) receipt
validates executable source and tests at `56e28544c28158f36654fb3f0ce58f300e96ef86`:

| Command | Runtime | Passed | Statements / lines / branches / functions |
| --- | --- | --- | --- |
| `npm run release:check` | Node 22 | 685/685 | 100/100/100/100 |
| `npm run release:check` | Node 26 | 685/685 | 100/100/100/100 |
| `bun run release:check` | Node 26, Bun 1.3.14 | 685/685 | 100/100/100/100 |

Each variant has zero failures, skips, cancellations or todos, covers all 48
authored sources, documents all 339 declarations, and passes strict tracker
health, identity, duplication, production audit, publication attestation,
packaging, changelog and Bun installation checks. Both release commands run with
an isolated HOME and disabled global/system Git configuration. CodeQL also passes.

That source's pinned tracker-linked corpus command passes 9/9 in snapshot
workspace context with PM context `none`; the stream-fixture
command passes 2/2 (2.112 seconds). Three output-publication regressions also fail when only `buildCorpusCommand`
is reverted, and pass 3/3 when restored. Four earlier retained behavioural proofs fail before
their corresponding fixes: disabled seal verification, the old single-update
fitter, the old process preflight, and acceptance of an incompatible trainer
selector. Restored focused regressions pass 5/5. These use real SDK trackers or
the actual numerical kernel, with no SDK mocks.

Superseded local full attempts are not passing receipts. Their partial logs
retain shared-host benchmark and HTTP timing failures; the unchanged checkpoint
benchmark passes isolated verification, and the full CI variants pass those
cases without skips. The existing HTTP timing follow-up remains open. The
stream fixture now closes the actual stdin descriptor while retaining its
one-second deadline and 16 MiB input. Coverage thresholds remain 100% in every
dimension. The shipped programme retains its five-second per-job wall bound and
separately approved 16-update total budget.

The review-round path regressions additionally cover missing and non-directory
source/output parents, parent removal during publication, canonical alias writes
and parent swaps during collection. Publication rechecks the caller and canonical
parents immediately before exclusive creation. These checks narrow the race window;
they do not provide descriptor-relative protection against a hostile concurrent
filesystem writer. The CI receipt above predates these review-round changes.

## Review-round verification

[Complete review-round CI](https://github.com/unbraind/pm-rl/actions/runs/39660872803)
validates executable source and tests at `83969917f6183ab1999a7c8e87def0bcb92892b1`:

| Command | Runtime | Passed | Statements / lines / branches / functions |
| --- | --- | --- | --- |
| `npm run release:check` | Node 22 | 688/688 | 100/100/100/100 |
| `npm run release:check` | Node 26 | 688/688 | 100/100/100/100 |
| `bun run release:check` | Node 26, Bun 1.3.14 | 688/688 | 100/100/100/100 |

Each variant has zero failures, skips, cancellations or todos, covers all 48
sources and documents all 340 declarations. Fresh-checkout strict tracker health,
identity, zero duplication, production audit, publication attestation, packaging,
changelog and Bun installation pass; CodeQL also passes. Thresholds are unchanged.

All six focused review regressions pass directly and through the pinned
tracker-linked runner. Reverting only `buildCorpusCommand` fails both the missing
path and publication-swap regressions; reverting only this document fails the
receipt regression. The epic retains the exact commands and revert results.
The existing local managed-extension skew and shared merge-fence drift are
separate from the passing fresh-checkout CI health. The descriptor-relative
publication follow-up remains open as `pm-rl-corpusnofollow`.
