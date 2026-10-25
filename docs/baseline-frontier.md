# Item-paired baseline gates for recursive tracker proposals

This promotion-gate infrastructure includes the already merged PR #94. Work is tracked by
[pm-rl-baseline](https://github.com/unbraind/pm-rl/blob/main/.agents/pm/tasks/pm-rl-baseline.toon),
a child of [pm-rl-apvf](https://github.com/unbraind/pm-rl/blob/main/.agents/pm/epics/pm-rl-apvf.toon).

The measured public corpus still favors the constant policy. No generation in
this experiment was promoted. The implementation improves representational
capacity and refuses apparently improving but uncompetitive policies.

## Diagnosis recorded before implementation

The original policy has one weight and a strictly positive title-length feature.
Its greedy decision is consequently constant. More examples, a different
learning rate or more optimizer updates cannot remove that capacity limit.
The 41 held-out items contain 36 closed items: always-closed earns 0.8780487805,
whereas the original stochastic learner earned 0.5980 and 0.6810. Expected
stochastic action reward remains the evaluation objective; substituting greedy
accuracy would change that objective and obscure the shortfall.

The training partition contains only 105 items: 77 closed and 28 other
(73.33% closed, versus 87.80% in held-out). This split has substantial class
frequency shift and limited evidence about minority outcomes. The feature split holds all equal
lengths together, which is conservative but protects against renamed identical
inputs. It is retained exactly. The new experiment uses 1,024 sampled actions
and 256 explicitly reserved updates per attempted generation, rather than 256
actions and eight updates. The larger action batch still reuses the same 105
training inputs; it does not create new independent examples. These are approved
resource changes, not gate changes.

## Learner and gate

`examples/loop-corpus-baseline.json` selects `feature_mode: "title-tokens-v1"`.
The version-two seal contains 64 bounded columns: an intercept, centered capped
length, and 62 signed SHA-256 word-hash columns. Words come only from normalized
titles. No target status, item identity or held-out fitting statistics enter
features. Held-out examples and their reward outcomes stay in the evaluator; the external
trainer sees only training examples and the collected actions/rewards. Vector fitting uses
the original importance-weighted reward objective. Checkpoint format two binds
every coefficient; legacy scalar checkpoint bytes and programme identities are
preserved. Every vector dimension and parameter is bounded and validated.

Every vector candidate must clear all original exact-improvement, sampled
Hoeffding, gap, checkpoint and contamination gates. It must additionally have
item-paired bootstrap lower effects strictly greater than the existing 0.01
minimum improvement over the incumbent and **both** constant actions. Each
paired interval uses identical deterministic item resampling indices, 8,192
replicates and Bonferroni adjustment for the three comparisons (nominal family
confidence 95% per attempted generation). Reward intervals use nominal 95%.
The sample count is the number of held-out items, never the 40,000 repeated
policy-action episodes. Insufficient item counts, ties and nonpositive lower
bounds refuse promotion. Item evidence and all coefficients are persisted and
verified during replay.

These are percentile bootstrap intervals conditional on this frozen corpus.
They assume exchangeable held-out items, do not correct for adaptive generation
selection, and do not establish independent final-test or cross-repository
performance. Related titles and repeated inputs can make that assumption
optimistic. No inferential claim beyond this bounded validation is made.

## Three-generation measured frontier

The explicitly selected public MIT `unbraind/pm-ops` tracker is the same commit
used in #94: `eba7d5262fd75e67afce0caad29dae7dc7dfbaeb`. The same length split gives
105 training and 41 held-out items. All attempts use the same seal. The constant
baseline is **36/41 = 0.8780487805**.

| Attempted generation | Learning rate | Exact held-out reward | 95% item-bootstrap interval | Promoted |
| --- | ---: | ---: | --- | --- |
| 1 | 1 | 0.8713980699 | [0.7743570291, 0.9668509885] | no |
| 2 | 0.5 | 0.8645003749 | [0.7683455624, 0.9579166612] | no |
| 3 | 0.25 | 0.8534392510 | [0.7593053408, 0.9436312068] | no |

Candidate checkpoint SHA-256 digests, in generation order:

```text
4ef73d08f88098b40d3e0d29dafb625b3fcb0f2e2b04626f2c1ab486d4d77085
530717c2441a189fbd671564c10a92d4f5cc45847d443926717ad6287aeda9fa
61e60cf08292bc4f5ab1c287987e13ce33efe92b01108b5f73840f56c703c482
```

The seed and final retained checkpoint are both
`17493680209cdf2fc86126ff2ad0b7bb6063ae24ce00f28f931224bb5ab2fd11`.
There are three recursive proposal attempts and **zero promoted successors**.
The sealed `retry_rejected: true` option permits bounded exploration after an
item-gate refusal, deriving the next learning rate through the existing weak
progress schedule. Every rejected candidate retains its refusal and never
becomes a collector or lineage parent. The declared generation/sample limits
and original approval bound all attempts. Other refusals, exhausted approvals,
process errors and cancellation still stop execution. Omitted/false retains
stop-on-refusal; enabling retries requires a sealed vector corpus.

The best candidate still loses to the constant by 0.0066507106. Its adjusted
paired interval against always-closed is wholly negative. All three greedy policies still predict closed on all 41 held-out items and
tie the constant baseline; greedy accuracy cannot substitute for the stochastic
objective. Later attempts at smaller learning rates perform worse; their
collection streams also change, so this is not an isolated learning-rate
ablation. Capacity and extra fitting alone therefore do
not establish a useful predictor on this corpus. A diagnostic log-loss probe
was also worse (first held-out score 0.7492), so it was not adopted. Broader
history/transfer work remains with the existing prefix and powered-corpus items.

## Reproduction and verification

Create a read-only copy of that public tracker as `source/.agents/pm`, then run:

```sh
node scripts/live-baseline.ts source/.agents/pm acceptance examples/loop-corpus-baseline.json
```

The runner creates a separate controller tracker and approval, seals the source,
runs three real external fits, verifies all charges, resumes, compares checkpoint
bytes and checks status and source byte inventories. Its output contains metrics
and hashes, not title text or local coordinates. The caller owns source provenance;
the builder does not infer a repository's public visibility or licence.

`test/baseline.test.ts` exercises three promoted synthetic generations, independent
finite differences of the vector objective, constant-policy refusal, corrupted
vector seals/checkpoints, changed item evidence and real external receipts. The
three-refusal acceptance runs in-process; a separate fit and replay runs with a
Git-free PATH plus `GIT_CEILING_DIRECTORIES` in an SDK-initialized temporary tracker. This retains the
existing crash, cancellation, shared-budget and contamination suites.

Behavior-only copies with vector fitting removed fail the three-promotion
capacity regression. Disabling only the item-gate application fails the
constant-policy refusal regression. Restored code must pass both. Coverage
thresholds and source scope remain unchanged at 100% in every dimension.

The combined implementation at `4f64e31576b952b35e918561cdb9f67ac981eb26`
includes #94's output preflight review fix. [Complete CI](https://github.com/unbraind/pm-rl/actions/runs/39646147464)
passes every release variant:

| Command | Runtime | Passed | Statements / lines / branches / functions |
| --- | --- | --- | --- |
| `npm run release:check` | Node 22 | 696/696 | 100/100/100/100 |
| `npm run release:check` | Node 26 | 696/696 | 100/100/100/100 |
| `bun run release:check` | Node 26, Bun 1.3.14 | 696/696 | 100/100/100/100 |

Each has zero failures, skips, cancellations and todos, measures all 50 authored
sources, documents 343 declarations, and passes strict tracker health, identity,
zero duplication, production audit, attestation, packaging and changelog checks.
Both release commands use isolated HOME and disabled global/system Git config.
CodeQL passes. Superseded local and CI attempts are not counted as passing.
The tiny Compose fixture now includes the new evaluator module; all original
physical crash, cancellation, recovery and contention drills pass in full CI.

The pinned tracker-linked `node --test test/baseline.test.ts` command passes
11/11, zero failures/skips, in snapshot workspace context with PM context none.
A packed consumer also passes on PM CLI **2026.10.21** and Node 26.12.0 with no
Git executable: init, activation, sealing the same corpus, a real external fit
and resume. That separate eight-update compatibility probe is refused against
the constant and retains the same single settled job and checkpoint on resume.
It does not replace the three-generation frontier above. The repository's SDK
pin remains unchanged. Complete resource/digest receipts are in
[the machine-readable evidence](baseline-frontier-evidence.json).

Strict local tracker health reports `merge_fence_drift:2`; the child item's strict
history verification passes. Fresh CI tracker health passes in all variants.
The owner contract excludes merge-tooling work, so that clone configuration and
standing tracker advisories remain unchanged. This is separate from source
coverage and the measured learner frontier.


## Bounded cycle and current acceptance

After corpus sealing and a separately authorized resource Decision, the command
below runs collect → external train → evaluate → gate → promote-or-refuse → record.
Every attempt records its checkpoint and item-paired evidence on a Generation,
immutable policy-card Decisions, process receipts and a terminal seed comment.
The next generation collects only with the retained incumbent: a promoted
checkpoint replaces it; a refused proposal never does.

```sh
pm rl corpus build --from-tracker source/.agents/pm \
  --file node_modules/pm-rl/examples/loop-corpus-baseline.json --output sealed.json
pm rl loop run paired-cycle --file sealed.json --approval corpus-approval --json
pm rl loop resume paired-cycle --approval corpus-approval --json
pm rl loop status paired-cycle --json
```

The explicit three-attempt approval requires 768 training steps, 90,000 wall
milliseconds, 786,432 storage bytes, 30,000 compute units and zero tokens, with
three permitted promotions. Reusing the loop id resumes its sealed programme;
it never resets those allowances. This objective compares the incumbent and
both constant policies. PR #98 adds the balanced intake objective and its
mandatory frozen heuristic comparison; it includes this branch so neither PR
requires the other to merge during this run.

The 2026-10-25 acceptance adds 96 seeded random score-vector cases plus ties
against each baseline, asserting that the item gate accepts exactly when all
paired lower bounds exceed the unchanged threshold. The complete promotion
still requires every original sampled, exact, contamination and approval gate.

The new boundary drill uses one non-git tracker per schedule, a real competing
SDK client and real external fits. It injects crashes after collect/train/evaluate
and before/after refusal and terminal-comment publication. Resume verifies all
proposals, finishes their process lifecycle, preserves foreign records with
skip reasons, and cannot double-charge or duplicate decision comments. Positive
vector schedules also cover collect/train/evaluate/promote crashes, a real peer
promotion, truthful attribution and successor collection from the winner.
Main's native item CAS, approval locks, owner-verified release, foreign decoding
and EIO/ENOSPC/SIGKILL transaction tests remain required acceptance.

The current merge retains a divergent inherited epic reconciliation event and
main's newer epic history verbatim. The single permitted normal reconciliation
cannot prove that combined snapshot (`no_receipt_set_proves_snapshot`), and
strict health reports `history_drift_chain_mismatch:pm-rl-apvf`. No force,
history rewrite or re-anchor is authorized. This blocks readiness and the CI
health prerequisite; historical green release runs above are not current-head
release evidence. The existing health follow-up is `pm-rl-9uz4`.


The final randomized cases include arbitrary crossing score vectors and correlated
noisy effects, including positive point averages whose paired lower bound fails.
Replacing only the lower-bound decision predicates with point-mean predicates
fails the seeded property (0/1); disabling the constant gate in #95 or heuristic
gate in #98 also fails it (0/1 each). Restored focused commands pass 4/4 and
5/5 respectively. This guards the statistical bound itself, in addition to ties
and clear wins.
