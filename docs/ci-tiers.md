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
| CodeQL | matching paths | matching paths | path-filtered | main matching paths and weekly Monday 05:37 UTC |

The docs/tracker classifier uses a NUL-delimited base-to-head diff, without rename
folding. Executable JS/TS tracker files select the code path. Documentation and
tracker changes retain strict health and changelog checks, the full-history
identity audit, pack dry-run (including its build), and entire existing suites
that read repository documentation/evidence or pack package contents. The
conservative selector is `test/support/docs-inputs.ts`; its log lists every
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
Fixed capacity, memory, resource-budget and corruption fixtures remain intact.
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
Local quick coverage has a 20-minute observation budget; full depth is certified
by post-merge CI Deep. PR quick timing and any remaining validation gaps are
recorded in the Task and PR body.

Tracking: [pm-rl-local-gate-timing](https://github.com/unbraind/pm-rl/blob/main/.agents/pm/tasks/pm-rl-local-gate-timing.toon),
companion `pm-cli-website-dyhg`. Release callers, release verifier scripts and
pm-github workflows remain owned by their separate rollout.
