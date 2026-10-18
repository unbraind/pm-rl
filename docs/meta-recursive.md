# Meta-recursive recipe improvement

`pm rl dataset build --from-trackers <first-directory> <more-directories...>
--output <new-directory>` builds the `terminal-disposition` environment from
committed public MIT tracker histories. GitHub visibility, license and commit
availability are checked before history blobs are read. Hosted data and the
pm-web, pm-gpt and pm-cli repositories are refused. The builder reads Git objects,
so uncommitted tracker changes never enter the dataset. Each example retains its
source repository, commit, opaque item identity, normalized lifecycle
prefix, and first terminal disposition (`completed` or `cancelled`). Imported
terminal snapshots without a prefix are omitted. Titles, comments, authors,
timestamps, local paths and close-reason prose are never copied.
Public repositories with no eligible prefixed terminal transitions are recorded
as omitted sources; at least three eligible repositories and four nonempty
compartments are required.

Repositories are deterministically assigned to training, meta-validation and
final-test roles. Within training repositories, complete observable prefix groups
are assigned to either collection or inner held-out evaluation. Identical prefixes
cannot cross that inner boundary. The small logistic policy consumes a bounded
prefix signature with a sign for the last observed blocked state. This is a real
public-history environment and a deliberately limited numerical learner; it does
not demonstrate language-model training on tracker text.

`pm rl meta run <id> --file examples/meta-trackers.json --dataset <directory>
--approval <decision>` executes or resumes the same programme. Programme ids use lowercase letters or
digits separated by single hyphens; noncanonical ids refuse before any write.
Retained reservation identities are compared using the SDK's case folding, so
an older uppercase spelling cannot hide an allocation. Its initial recipe
is a versioned content-addressed artifact. Numeric domains cover learning rate,
inner steps, batch, temperature and correct/incorrect reward weights. Categorical
domains cover balanced/all selection and forward/reverse curriculum. Steps bound
inner generations, each performing one real collected-batch REINFORCE update.
Temperature rescales the policy observation; reward weights affect collection
rewards only. Inner held-out and recipe-selection rewards remain exact match.
Every inner seed and generation names the recipe digest it used.

The outer controller receives a fitted checkpoint from each bounded inner loop;
inner examples and scores stay in the evaluator. The proposer receives only the
incumbent knobs and a seeded candidate pool. It has no dataset coordinate or
held-out capability. With `--proposer decision-model`, a local `tev1:4b` ranks a
pool of bounded seeded recipes through the existing System One calibration
adapter. Missing, remote-backed or malformed models fall back to the original
seeded recipes. This is local proposal inference, bounded by request count and a
five-second timeout per HTTP request, and not a claim that the decision model
itself is trained. The default proposer makes no inference requests.
An intent is persisted before the first metadata or inference request. A response
lost before its completion receipt causes seeded fallback on resume; it cannot
spend another inference allowance. Completed proposal receipts replay verbatim.

One **existing** Decision must contain `permitted_promotions`, `resource_budget`
and `meta_budget`. Search never creates, updates or enlarges it. Before fitting,
an SDK workspace transaction reserves worst-case collection samples, proposal
requests and recipe-promotion slots against all programmes using that Decision.
These conservative reservations remain held after failure or cancellation.
Each inner fit also uses the existing atomic process resource reservation,
measured completion receipt and settlement. Search cannot spend above either
allowance. The packaged process trainer is the only selectable meta trainer.

Create a Decision from [the bounded approval example](../examples/meta-approval.md)
and supply its returned item id:

```sh
pm create Decision "Approve bounded recipe search" --body-file examples/meta-approval.md
pm rl meta run tracker-search --file examples/meta-trackers.json --dataset <directory> --approval <decision-id>
```

The approval's identity and complete spec digest are immutable programme inputs.
Outer accounting reads certified metadata, then opens only stable reservation
identities; proposal recovery opens only its exact attempt record. An unrelated
item body or a renamed title cannot change the approved allocation.

The existing fail-closed `decidePromotion` gate compares exact-match rewards on
meta-validation repositories. Sample counts are distinct examples, not repeated
rollouts. Confidence is allocated across all planned comparisons; the programme's
effect threshold and minimum sample count are fixed. A proxy-only gain cannot
promote a recipe. Among eligible candidates, the largest conservative lower gain
bound wins. A refusal retains the incumbent and still permits the next bounded
meta-generation. No successful candidate is required for acceptance.

Meta-validation is an adaptive selection set. Per-example Hoeffding bounds retain
the existing gate's independent bounded-sample assumption; correlated items in a
repository limit population-level statistical interpretations. An untouched
final-test repository split is opened only after every recipe selection is
committed, and reports initial versus final policy on the same seeded exact-match
stream. Its score never proposes or promotes a recipe. These are controller
capability boundaries within the trusted local evaluator, not OS access controls
against arbitrary code running as the evaluator's user.

Outer phases use the inner controller's verified process identity, shared Git
worktree launch authority, owner lease, phase fencing and digested completion
receipts. An interrupted fit re-enters the same inner programme, adopting its
completed steps and resource reservation. A completed outer phase adopts its
receipt. Inputs, approval or receipt drift refuse resume. Cancellation stops at a
durable boundary; external fits retain their existing terminal-cancellation
semantics. A new invocation of the same `meta run` command resumes the programme.
The 15-minute whole-run watchdog also applies to `npm run test:live`.

The synthetic committed fixture and real temporary SDK trackers exercise this
contract. `npm run test:live` builds the actual public dataset at run time, executes
two meta-generations with two candidates each, and retains complete programme,
dataset, tracker and result evidence in ignored runtime state. The older System
One acceptance remains available as `npm run test:live:systemone`. Releases remain
disabled.

## Measured live acceptance

`npm run test:live` completed two meta-generations with two candidates each over
25 verified public MIT repositories. One further verified repository had no
eligible prefixed terminal events and is recorded as omitted. The dataset contains
1,023 training, 145 inner held-out, 214 meta-validation and 385 final-test examples
(1,767 total). Repository roles contain 15 training, five meta-validation and five
final-test repositories. Source commits, split digests, full recipes and verdicts
are retained in [the public evidence envelope](meta-live-evidence.json).

The incumbent recipe is
`sha256:b77fdfeff48dc713d46b397ff6ea652257fe46ca09650264ba5563e4e53a34ae`:
learning rate 0.25, two steps, batch 128, temperature 1, correct/incorrect weights
1/0, all examples and forward curriculum. The numerical learner's accepted
checkpoint remained the seed; the trained candidates did not pass inner promotion.
Outer recipe selection therefore measured each resulting policy against that
same accepted incumbent.

| Meta generation | Candidate recipe digest prefix | Exact-match score | Gain | Lower gain bound | Verdict |
| --- | --- | ---: | ---: | ---: | --- |
| 1 | `800886e9f4cd` | 107/214 = 0.5 | 0 | -0.21778781183411927 | refuse |
| 1 | `45113586500f` | 107/214 = 0.5 | 0 | -0.21778781183411927 | refuse |
| 2 | `4a48567235f1` | 107/214 = 0.5 | 0 | -0.21778781183411927 | refuse |
| 2 | `55539a90ca05` | 107/214 = 0.5 | 0 | -0.21778781183411927 | refuse |

The declared confidence is 0.95, allocated across four comparisons as 0.9875 per
comparison. The existing gate retains effect threshold 0.01, minimum ten samples,
and reward bounds [0,1]. Each side's Hoeffding half-width is
0.10889390591705964. No recipe was promoted in either generation. The final-test
score was **198/385 = 0.5142857142857142 before and after**. No real-data recipe
improvement is claimed, and the gate was not relaxed. Dataset build plus controller
execution took 58,251.420959 ms inside the command's unchanged 15-minute watchdog.


## Baseline and recipe sensitivity review

The majority class is `completed`: a constant predictor scores **211/214 =
0.985981308411215** on meta-validation and **384/385 = 0.9974025974025974** on
final-test. These are descriptive split-majority baselines, computed inside the
evaluator; final-test statistics are released only after all selection ends.
**The current learner does not beat the majority baseline on real trackers.**

Every candidate predicts two labels: 108 `completed` and 106 `cancelled` on
meta-validation. All six candidate pairs disagree on **0/214 = 0%** of examples,
as does every candidate versus the incumbent. Final-test predictions are 199
`completed` and 186 `cancelled`, also unchanged. This is not a single-class
collapse: every inner fit was refused, so the accepted zero-weight seed policy
remained identical across recipes. The score diagnostics expose only aggregate
counts and disagreement rates, without held-out rows or prediction vectors.
[pm-rl-prefix](../.agents/pm/features/pm-rl-prefix.toon) tracks a bounded learner
that reads the history prefix, such as the existing LM adapter, while preserving
all split, budget and promotion boundaries.

The committed [known-signal fixture](../test/fixtures/tracker-signal.json) uses
last-state sign as a deterministic learnable rule. Each compartment has distinct
prefixes and repository roles remain disjoint; its seed and weak initial recipe
are fixed in the fixture. The actual process fits and two-generation outer loop
use the live criterion unchanged: confidence 0.95, minimum ten samples and effect
0.01. With two candidates in each generation, family-wise allocation gives 0.9875
per comparison. Generation 1 promotes recipe `30eccf433a17` with score
**5629/10000**, incumbent **4943/10000**, gain **0.0686**, and lower gain bound
**0.036740389785077876**. Generation 2 retains that incumbent. Final-test improves
from **5093/10000 to 5806/10000**, above its **5000/10000** majority baseline.
[The complete sanity receipt](meta-sanity-evidence.json) is separate from the real
acceptance receipt. This proves conditional promotion; it makes no claim of
real-tracker learning. The synthetic baseline test also checks a balanced split,
a cancellation-majority subset, both-label and single-label policies, identical
predictions, and full disagreement.


## Release verification

The [complete CI run](https://github.com/unbraind/pm-rl/pull/84/checks)
executes `npm run release:check` on Node 22 and 26 and `bun run release:check` on
Node 26 with isolated HOME and global/system Git configuration. Each passes
613/613 tests, zero failures/skips, 100% statements/lines/branches/functions over
all 35 declared sources, 295 documented declarations, and zero duplicate clones
or production audit findings. Thresholds, dependency pins and release approval
are unchanged. The live evidence names the measured production source commit;
later receipt updates do not change the measured production source.

The real Compose resource faults are explicit: the deadline worker publishes
real LM progress then pauses past its unchanged 15-second limit; the memory
worker has a V8 ceiling above its unchanged 192 MiB physical cgroup cap and is
actually OOM-killed. Existing no-successor, receipt, cleanup and resume assertions
remain. Guard-only reverts for recipe lineage, public visibility, programme ids,
retained reservation case folding and both resource fault injectors fail; restored
implementations pass. PM-linked data/recipe, crash/promotion/budget, identity and
resource-refusal commands pass 9/9, 3/3, 1/1 and 1/1 respectively.

A separate local full-suite attempt hit the unchanged 300-second HTTP crash-drill
deadline under host load and was retained as failed evidence. The required complete
commands pass in CI. External review is incomplete: CodeRabbit skips automatic
review under its star policy, Greptile reports an expired trial, Sourcery skips
and Cubic is neutral. Those states provide no approval. The PR remains unmerged,
work items remain in progress, and the orchestrator owns closure.
