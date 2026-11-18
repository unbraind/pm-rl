# Fleet CI v2

Required checks remain `test (22)` and `test (26)` on `ubuntu-latest`.
The PR tier runs on pull requests and dispatch, cancels superseded PR runs,
and bounds each job to 22 minutes (target: at most 15 minutes). Main pushes no longer duplicate that tier.
CodeQL is not required by main branch protection.

Node 22 quick tests run in three non-required `quick-shard (22, 1..3)` jobs.
The launcher assigns every `test/*.test.ts` file to one shard using measured
file durations. The required `test (22)` check is their aggregate.
It needs the shards, runs with `always()`, and fails unless every shard
concluded successfully. For docs/tracker PRs the shards idle and `test (22)`
runs changelog, identity, pack-manifest and workflow contracts. Node 26 uses four
non-required `coverage-shard (26, 1..4)` jobs at quick depth with
`--test-shard=i/4`. Each uploads original per-worker V8 function/block hit ranges.
`coverage-merge` relocates artifact URLs, replays all raw reports through Node's
own coverage reporter, and reuses the coverage gate's source reconciliation and
statement measurement. Thresholds remain 100% in all four dimensions.
`release-checks (26)` runs the remaining release checks and packed Node/Bun
acceptance in parallel. Required `test (26)` needs all three job groups, uses
`always()`, and fails unless every dependency succeeded. CI Deep and the single
local `npm run release:check` command are unchanged.

The initial four Node 26 coverage shards projected to roughly eight minutes each from the previous run's
29-plus-minute instrumented test lower bound. Actual file imbalance and setup
cost must be measured on CI. Docs/tracker shards and merge skip build/test work;
the release job runs strict health and the lightweight contracts. Pack inspection
uses `--ignore-scripts`; docs-only CI does not build or run packed consumers.

| Check | Code PR Node 22 | Code PR Node 26 | Docs/tracker PR, both nodes | Deep |
| --- | --- | --- | --- | --- |
| npm ci and merge-driver preparation | yes | yes | yes | all jobs |
| Strict pm health, required merge drivers | — | yes | Node 26 | four release gates |
| Release approval/workflow and calendar contracts | tests | release checks | workflow contracts | four release gates |
| Build and test typecheck | quick tests | release checks/shards | — | four release gates |
| Source typecheck, lint, duplicates, docstring | — | yes | — | four release gates |
| Publish attestation verifier | tests | release checks | — | four release gates |
| Coverage: statements, lines, branches, functions, all 100% | — | quick | — | full in four release gates |
| Full-history Git identity audit | tests | release gate | explicit audit | four release gates |
| Privacy/identity/path refusal tests | quick | quick | identity audit | full in four release gates |
| Production dependency audit | — | yes | — | four release gates |
| Pack dry-run and package file list | embedded acceptance | explicit + embedded | manifest only, no scripts | four release gates |
| Changelog consistency | — | yes | yes | four release gates |
| Docs, README, public evidence, LICENSE and shipped examples | tests | tests | pack manifest + workflow contracts | four release gates |
| Packed Node/Bun SDK and CLI acceptance | embedded tests | release checks + shards | — | four release gates |
| Bun graph install, bunx CLI resolution, Bun built-module smoke | — | yes | — | four release gates |
| Synthetic Docker executable tests | quick | quick | — | four release gates on pm-local |
| Real Compose bandit and LM lifecycle/resource drills | hosted deep only | hosted deep only | hosted deep only | separate hosted Docker jobs, Node 22/26 |
| Exhaustive sequential mutable-edge/commuting-read matrix | focused endpoints | focused endpoints | full-depth deep only | full in four release gates |
| Snapshot/card corruption and callback/recovery fault matrices | representative kinds | representative kinds | — | exhaustive in four release gates |
| Real healthy-owner wait beyond 30 seconds | deep only | deep only | deep only | unchanged real wait |
| CodeQL | matching paths | matching paths | path-filtered | main matching paths and weekly Monday 05:37 UTC |

The docs/tracker classifier uses a NUL-delimited base-to-head diff without rename
folding. Executable JS/TS tracker files select the code path. Documentation and
tracker changes run strict health, changelog, identity, pack-manifest and workflow
contracts without compiling. Packed acceptance and the broader documentation
input suites still run on code PRs and in CI Deep.

Node 22 runs build, test typecheck and quick tests through the shard jobs above,
without a separate coverage,
changelog or pack gate. Several existing tests pack their own consumers, and these
remain intact. Packed tests execute Node and Bun consumers but do **not** prove
Bun project/global package-manager installs or bunx ephemeral installation. The
additional smoke checks Bun's graph install, local bunx host-CLI resolution and
loading the built extension under Bun. It does not claim global/ephemeral install
certification absent from the old gate.

## Node 22 shard timing

The November 18 sample includes ten code PR runs with both Node 22 quick
shards active. Times are job start to completion and include setup and cleanup.
The two cancelled legs reached the 22-minute timeout with no failed TAP assertion.
The older runs used an earlier file inventory, so the alternating filename split
placed some heavy files on different shards.

| Run | Previous shard 1 | Previous shard 2 |
| --- | ---: | ---: |
| [44335527685](https://github.com/unbraind/pm-rl/actions/runs/44335527685) | 22m16s, timed out | 15m03s |
| [44330266829](https://github.com/unbraind/pm-rl/actions/runs/44330266829) | 22m15s, timed out | 13m16s |
| [44298187804](https://github.com/unbraind/pm-rl/actions/runs/44298187804) | 12m43s | 11m10s |
| [44294960939](https://github.com/unbraind/pm-rl/actions/runs/44294960939) | 17m15s | 12m14s |
| [44291568242](https://github.com/unbraind/pm-rl/actions/runs/44291568242) | 13m04s | 9m57s |
| [44185993763](https://github.com/unbraind/pm-rl/actions/runs/44185993763) | 21m48s | 11m04s |
| [44078429489](https://github.com/unbraind/pm-rl/actions/runs/44078429489) | 14m34s | 8m57s |
| [43941285752](https://github.com/unbraind/pm-rl/actions/runs/43941285752) | 10m41s | 15m44s |
| [43834307071](https://github.com/unbraind/pm-rl/actions/runs/43834307071) | 9m47s | 11m43s |
| [43824664162](https://github.com/unbraind/pm-rl/actions/runs/43824664162) | 11m56s | 11m11s |

In run 44335527685, shard 1 had logged 762 seconds in
`policy-card.test.ts` by cancellation. The same file took 765 seconds in the
21m48s green run. Shard 1 also spent 626 seconds in `durable-loop.test.ts`,
263 seconds in `evaluation-lifecycle-verdict.test.ts` and 243 seconds in
`lm-loop.test.ts`. The origin-main controller corpus replay took 70.9 seconds
in run 44298187804, 101.3 seconds in run 44294960939 and 140.0 seconds in
run 44335527685. Several unchanged files slowed on the two timeout runs.

To update [the timing data](../scripts/quick-shard-timings.json), sum each file's
top-level TAP `duration_ms` values from recent quick logs, including the time
of nested cases through their parent tests. Use the largest complete per-file
sum across the sample. The current data adds 10% to shard 1 files that were
unfinished or absent from the latest timeout log. For shared complete files
taking over three seconds, the 90th-percentile slowdown against the 21m48s
green run was about 5.5%. The model rounds file weights up, allows 45 seconds
for setup, build, worker startup and cleanup, and assigns new files a provisional
60-second weight until they have CI measurements. The workflow contract file
includes a 10-second allowance for its new launcher tests.

The launcher assigns heavier files first by choosing the shard with the
earliest projected finish after adding each file. The estimate models Node's
filename-sorted queue across four workers. Under the same weights, the old
alternating split projects to 23m52s and 15m28s. The new assignment projects
to 15m03s in each shard, about 32% below the 22-minute cap. The estimates
depend on observed runner speed and must be checked against hosted wall times.

Run `node scripts/quick-shards.ts` to list each shard's estimated seconds and
assigned files. The workflow contract verifies that the partition covers the
quick files exactly once, that new files run, and that a failing test produces
a nonzero exit status.

## Deep routing and schedules

Deep runs on main pushes, dispatch and daily at 02:13 UTC, away from release's
03:23 and hourly :41 schedules. Ref concurrency cancels older deep runs. Each job
has a 120-minute timeout and uses `PM_TEST_DEPTH=full`, `PM_TEST_TIME_SCALE=3`.

* `deep (22, npm)`, `deep (22, bun)`, `deep (26, npm)` and `deep (26, bun)` each
  run **one** complete release gate on `[self-hosted, pm-local]`, with
  `ubuntu-latest` fallback only when `PM_LOCAL_DEEP=off`. All original gate
  commands and coverage thresholds remain intact. Synthetic Docker cleanup,
  controller-boundary and process-publication tests run here. Real container
  drills explicitly report their hosted-deep routing rather than probing a socket.
* `deep Docker (22)` and `deep Docker (26)` always run on `ubuntu-latest` and
  execute `test/compose.test.ts` and `test/lm-compose.test.ts` with
  `PM_TEST_DOCKER=required`. Missing Docker/Compose fails the job. These build
  images and exercise real launch, two-generation lineage, controller races,
  SIGKILL/recovery, cancellation, cleanup faults, corrupted checkpoints, native
  OOM and product wall-time refusal. They cannot run on the socket-free local
  pool. The same files' non-container parser tests also remain in the main suite.

Local runners use their persistent npm cache, without restoring GitHub's cache
archive, and their installed Bun. Hosted runners install pinned Bun 1.3.14.
Every release-matrix log reports `bun --version`. Gate execution retains the old
synthetic HOME and disabled global/system Git config for identity isolation.
CodeQL keeps its weekly scan, filters tracker/docs/lockfile-only changes on push
and PR, cancels superseded PR runs, and has a 30-minute timeout.

## Depth, watchdogs and measurements

Unset depth remains full. Quick runs the same deterministic seed prefix at one
tenth depth, rounded up, with at least 25 cases capped by the original count.
The four independent 128-case card corpora retain 25 cases **per seed**.
The 10,000-trial simulation retains 1,000 trials; success/error assertions use
the generated trial count. Proposer replay counts derive from generated records,
including actual mutation cases, rather than the original 500-case totals.
Fixed capacity, memory and resource-budget fixtures remain intact.
`testCases` applies `testDepth` to corruption and fault matrices. It retains
first/last cases, evenly spread middle cases, and every declared input/site,
fault or boundary kind; required kinds can exceed the depth budget. Matrices
below 25 cases remain exhaustive, including the 15-case main corpus and the
four-phase crash sweeps that do not use `testKindCases`. Full depth returns
every case in the original order.

`testKindCases` instead keeps endpoints and the first representative of every
declared kind, even for matrices smaller than 25 (pairs stay exhaustive):

* HTTP receipt recovery runs five of eight stage/metric combinations: the
  `systemone_decision` metric at remote, response, commit and request, plus
  `systemone_held_out_decision` at request. Deep runs both metrics at all four
  stages.
* The baseline vector crash test runs collect plus all four refusal/report
  before/after boundaries (five of seven); deep additionally runs train and
  evaluate phase crashes.
* Generated chronology witnesses keep all nine run-count/look-count shapes,
  their baseline and focused orders, but sample inversions by artifact-class
  pair. Deep runs every inversion.
* The native snapshot chain keeps all three promotions, four receipts and
  every card variant. Quick sweeps corruption on three receipts (legacy,
  first-cycle and latest-cycle), and samples each selected receipt's corruption
  pairs with `testCases`, retaining every single-input kind. Deep sweeps all
  four receipts and every corruption pair.

Card recovery retains all command paths and before/after boundary kinds, plus
EIO/ENOSPC/SIGKILL for each schema, receipt, seal, card and read boundary kind.
The callback matrix retains every operation site and error code. Routine card
mutations retain every input and mutation kind. Deep runs these matrices
exhaustively; quick preserves the declared kinds through `testCases`.

The 35-second healthy-owner wait is deep-only, with its real product contract
unchanged; the ordinary competing-promoter test remains in quick. The controller
heartbeat contract still uses its real interval in both tiers. Quick engines run at most four independent files at once; instrumented coverage
and full/local test commands retain two. Tests that patch process globals remain serial within each file.
The exhaustive sequential snapshot matrix moves to deep; its focused endpoint
and candidate-discovery drill remains in quick. No coverage threshold, source
scope or exclusion changes in either depth.

`testTime` validates a finite positive scale on import before spawning workers,
rounds to integer milliseconds and rejects unsafe timer values. Scaled uses are
runner/external-command watchdogs. Product `wall_ms`, lock budgets, lookup/request
deadlines, retry counts and asserted resource values remain unscaled. CLI elapsed
throughput is diagnostic; receipts, lineage and operation counts prove completion.
This avoids treating overloaded runner speed as a product contract. The previous
packed process-CLI timeout and 600-second card property failures are owned by
this Task; quick corpus reduction and scaled harness limits address those causes.
No new filename containing control characters is introduced.

Baseline: successful main run [43747476735](https://github.com/unbraind/pm-rl/actions/runs/43747476735)
on 2026-11-15. Queue-inclusive job wall times were 79m58s (Node 22 npm),
60m14s (Node 26 npm), and 63m23s (Node 26 Bun). Node 26's slowest test was the
sequential snapshot matrix, 1,388,331 ms (23m08s), followed by immutable snapshot
cycles (199,855 ms), recovery-card transactions (179,657 ms), generated chronology
witnesses (154,117 ms), the seeded sequential model (147,315 ms) and card aliases
(138,794 ms). These are full-depth hosted measurements, not quick predictions.
The local quick seeded/property subset passed 8/8 in 320,250 ms, including
50 proposer sequences and 1,000 simulation trials. This shared-host subset is
not comparable to a full hosted gate. The optional local quick coverage attempt
was stopped after 983 seconds in the gate, still in early controller matrices,
as it could not plausibly finish within the 20-minute shared-host budget. It
reported no failure before termination, but establishes no coverage percentage.
Full depth is deferred to post-merge CI Deep. At the initial rollout handoff required PR checks were still
running; that handoff had no completed PR wall times. Remaining evidence
and run links are recorded in the Task and PR body.

Tracking: [pm-rl-local-gate-timing](https://github.com/unbraind/pm-rl/blob/main/.agents/pm/tasks/pm-rl-local-gate-timing.toon),
companion `pm-cli-website-dyhg`. Release callers, release verifier scripts and
pm-github workflows remain owned by their separate rollout.


## Quick timing follow-up

The next quick run, [43782039631](https://github.com/unbraind/pm-rl/actions/runs/43782039631),
was cancelled by the unchanged 30-minute job cap without a test failure.
The jobs API measured the Node 22 engines step at 1797 seconds and the Node 26
release gate at 1792 seconds; created-to-completed job times were 1816/1818
seconds respectively. This follow-up samples every large exhaustive matrix and
overlaps four independent engines files, targeting at most 15 minutes per job.
Instrumented coverage retains two workers: four workers reached only the card
recovery matrix after 26 minutes, while the earlier two-worker run reached the
transfer suites within 30 minutes.

Shared-host Node 24 measurements at quick depth follow. Original runs used
harness scale 1; sampled runs use scale 3 only for watchdogs. Host load varied;
these are relative diagnostics, and timed-out baselines are lower bounds.
The original full-file baseline was incomplete after its callback timeout and
replacement of its card-file leg by a focused original-source matrix run.

| Test | Before (s) | After (s) |
| --- | ---: | ---: |
| Snapshot corruption pairs | 1504.418 | 595.319 |
| Callback fault matrix | timeout at 600.003 | 163.011 |
| Decision graph corruption | 323.585 | 229.696 |
| Candidate/refused graph sweep | 185.309 | 188.025 |
| Routine card mutations | 410.284 | 175.374 |
| Generation evidence mutations | 293.039 | 103.787 |
| Recoverable card transactions | timeout at 600.002 | final 35 cases: 768.207 |
| Real healthy-owner wait | 103.105 | deep only |
| Three-generation chain regression | 220.458 | 243.255 |

Snapshot counts fall from 337 to 100, and corrupt-card checks from 1910 to 500,
while retaining three promotions, four receipts, ten card variants and 21 replays.
The callback matrix passes 30 representative cases with every site/error kind
retained. No improvement is claimed for the small candidate/refused sweep or the
unchanged chain regression. Whole-suite quick coverage remains at the original
100 percent thresholds and scope, with results pending hosted CI.

Implementation head: `054c023d54ea7fa3f11d5ed9858a2189c77d4f1b`.
[Follow-up CI run 43789664325](https://github.com/unbraind/pm-rl/actions/runs/43789664325)
started both required jobs at 02:01:47 UTC. Completed step durations are pending;
CI observation is bounded to 30 minutes after the last push.


After 20 minutes, both required jobs were still executing their main steps. The
running job logs API returned 404, so a fresh per-test ranking was unavailable.
The previous Node 26 quick run's next unchanged costs were the main compatibility
corpus (65.5 s), heartbeat (65.2 s), shared-tracker interleavings (64.2 s), large
learner (47.7 s), pending peer refusals (34.2 s) and chain regression (32.7 s).
The 15-minute target is not yet demonstrated. The direct engines invocation also restores the package-local CLI directory on
PATH: the first attempt exposed three pm ENOENT failures because npm had
previously provided that directory implicitly. Isolated CLI resolution and all
38 release/workflow/discovery contracts pass with the explicit PATH.
The final recovery sampler also
retains every fault mode for each boundary kind, preserving physical SIGKILL
coverage at receipt, seal and card writes; its focused run passed all 35 cases (36 tests including parent) in 768.207 s.


Final local results: the five full touched files passed 285 tests with one
intentional deep-only skip and zero failures in 2848.564 s. The stronger recovery
superset passed 36/36 tests; final depth/coverage harness passed 65/65 and release
contracts passed 38/38. Final source/test typecheck, lint, zero-duplication gate,
changelog, strict tracker health, identity/docstring/attestation and YAML checks
passed. The original recovery baseline is censored and load changed substantially;
no runtime improvement is inferred from its final local duration alone.

[Final implementation CI run 43793233716](https://github.com/unbraind/pm-rl/actions/runs/43793233716)
started both jobs at 02:37:06 UTC. Its observation deadline is 03:06:41 UTC.
The earlier follow-up run was superseded at 1599 s (engines) / 1603 s (release);
job created-to-completed times were 1628 / 1626 s. Node 22 exposed the now-fixed
local CLI PATH regression. No successful complete quick coverage or target
runtime is claimed until the final jobs finish.


Final bounded observation at 2026-11-16 03:05:13 UTC: test (22): in_progress/None; test (26): completed/failure.
The 15-minute target was missed. Completed gate durations and final quick
coverage remain unverified. The observed jobs API step times follow; running
values are elapsed observations, not completed durations.

| Step | Node 22 (s) | Node 26 (s) |
| --- | ---: | ---: |
| Set up job | 0 | 1 |
| Checkout | 3 | 3 |
| Detect code changes | 0 | 0 |
| Setup Node.js | 3 | 7 |
| Setup Bun | 1 | 1 |
| Install dependencies | 9 | 3 |
| Verify tracked pm project health | skipped | 2 |
| Check documentation and tracker changes | skipped | skipped |
| Engines floor tests | running (~1671 s) | skipped |
| Quick npm release gate | pending | 1584 |
| Verify Bun can install the package graph | pending | skipped |
| Post Setup Bun | pending | skipped |
| Post Setup Node.js | pending | skipped |
| Post Checkout | pending | 0 |
| Complete job | not reached | 0 |

The item claim is released and its status remains in progress. This final
docs/tracker receipt is committed locally and left unpushed to avoid superseding
the running implementation checks. The PR body publishes the same measurements.
