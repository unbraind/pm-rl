# Fleet CI v2

Required checks remain `test (22)` and `test (26)` on `ubuntu-latest`.
The PR tier runs on pull requests and dispatch, cancels superseded PR runs,
and bounds each job to 30 minutes. Main pushes no longer duplicate that tier.
CodeQL is not required by main branch protection.

| Check | Code PR Node 22 | Code PR Node 26 | Docs/tracker PR, both nodes | Deep |
| --- | --- | --- | --- | --- |
| npm ci and merge-driver preparation | yes | yes | yes | all jobs |
| Strict pm health, required merge drivers | — | yes | yes | four release gates |
| Release approval/workflow and calendar contracts | tests | release gate | input suites | four release gates |
| Build and test typecheck | quick tests | release gate | build for package contents | four release gates |
| Source typecheck, lint, duplicates, docstring | — | yes | — | four release gates |
| Publish attestation verifier | tests | release gate | when selected by input suites | four release gates |
| Coverage: statements, lines, branches, functions, all 100% | — | quick | — | full in four release gates |
| Full-history Git identity audit | tests | release gate | explicit audit | four release gates |
| Privacy/identity/path refusal tests | quick | quick | input suites and packed tests | full in four release gates |
| Production dependency audit | — | yes | — | four release gates |
| Pack dry-run and package file list | embedded acceptance | explicit + embedded | explicit + embedded | four release gates |
| Changelog consistency | — | yes | yes | four release gates |
| Docs, README, public evidence, LICENSE and shipped examples | tests | tests | input suites | four release gates |
| Packed Node/Bun SDK and CLI acceptance | embedded tests | embedded tests | packed input suites | four release gates |
| Bun graph install, bunx CLI resolution, Bun built-module smoke | — | yes | packed consumers only | four release gates |
| Synthetic Docker executable tests | quick | quick | if selected | four release gates on pm-local |
| Real Compose bandit and LM lifecycle/resource drills | hosted deep only | hosted deep only | hosted deep only | separate hosted Docker jobs, Node 22/26 |
| Exhaustive sequential mutable-edge/commuting-read matrix | focused endpoints | focused endpoints | full-depth deep only | full in four release gates |
| Snapshot/card corruption and callback/recovery fault matrices | representative kinds | representative kinds | if selected | exhaustive in four release gates |
| Real healthy-owner wait beyond 30 seconds | deep only | deep only | deep only | unchanged real wait |
| CodeQL | matching paths | matching paths | path-filtered | main matching paths and weekly Monday 05:37 UTC |

The docs/tracker classifier uses a NUL-delimited base-to-head diff, without rename
folding. Executable JS/TS tracker files select the code path. Documentation and
tracker changes retain strict health and changelog checks, the full-history
identity audit, pack dry-run (including its build), and entire existing suites
that read repository documentation/evidence or pack package contents. The
conservative selector is `test/support/docs-inputs.ts`; identity/privacy/secret
suites are always selected by filename, and its log lists every
selected file. This retains README/LICENSE, public evidence, private path refusal,
packaging, identity and release documentation contracts. No independent secret
scanner or markdown linter exists in the original release gate. Documentation
suites that pack consumers can still be substantial; they must not be bypassed.

Node 22 runs build, test typecheck and quick tests, without a separate coverage,
changelog or pack gate. Several existing tests pack their own consumers, and these
remain intact. Packed tests execute Node and Bun consumers but do **not** prove
Bun project/global package-manager installs or bunx ephemeral installation. The
additional smoke checks Bun's graph install, local bunx host-CLI resolution and
loading the built extension under Bun. It does not claim global/ephemeral install
certification absent from the old gate.

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
`testCases` applies `testDepth` to exhaustive corruption and fault matrices. It
retains first/last cases, evenly spread middle cases, every declared input/site,
and each fault or boundary kind. Required kinds can exceed the depth budget;
matrices below 25 cases remain exhaustive (including the 15-case main corpus,
four-phase crash sweeps and eight HTTP receipt crash cases). Full depth returns
every case in the original order. The native snapshot chain still runs all three
promotions and every receipt/card variant at quick depth; only its corruption
pairs are sampled. Card recovery retains all command paths and before/after boundary kinds, plus
EIO/ENOSPC/SIGKILL for each schema, receipt, seal, card and read boundary kind. The callback matrix retains every operation site and
error code. Routine card mutations retain every input and mutation kind.

The 35-second healthy-owner wait is deep-only, with its real product contract
unchanged; the ordinary competing-promoter test remains in quick. The controller
heartbeat contract still uses its real interval in both tiers. Quick engines and
coverage run at most four independent files at once; full/local test commands
retain two. Tests that patch process globals remain serial within each file.
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
overlaps four independent quick files, targeting at most 15 minutes per job.

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
| Recoverable card transactions | timeout at 600.002 | initial sample 152.887; stronger sample pending |
| Real healthy-owner wait | 103.105 | deep only |
| Three-generation chain regression | 220.458 | 243.255 |

Snapshot counts fall from 337 to 100, and corrupt-card checks from 1910 to 500,
while retaining three promotions, four receipts, ten card variants and 21 replays.
The callback matrix passes 30 representative cases with every site/error kind
retained. No improvement is claimed for the small candidate/refused sweep or the
unchanged chain regression. Whole-suite quick coverage remains at the original
100 percent thresholds and scope, with results pending hosted CI.

Implementation head: `031a2357485e9cd0d3dc5a93748057030b6e87cc`.
[Follow-up CI run 43789664325](https://github.com/unbraind/pm-rl/actions/runs/43789664325)
started both required jobs at 02:01:47 UTC. Completed step durations are pending;
CI observation is bounded to 30 minutes after the last push.


After 20 minutes, both required jobs were still executing their main steps. The
running job logs API returned 404, so a fresh per-test ranking was unavailable.
The previous Node 26 quick run's next unchanged costs were the main compatibility
corpus (65.5 s), heartbeat (65.2 s), shared-tracker interleavings (64.2 s), large
learner (47.7 s), pending peer refusals (34.2 s) and chain regression (32.7 s).
The 15-minute target is not yet demonstrated. The final recovery sampler also
retains every fault mode for each boundary kind, preserving physical SIGKILL
coverage at receipt, seal and card writes; its focused measurement is pending.
