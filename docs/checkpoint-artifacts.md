# Content-addressed prefix checkpoints

Prefix checkpoint bytes live under the tracker in
`artifacts/pm-rl/sha256/<sha256>.json`. The filename hashes the exact JSON bytes;
the reference also binds the byte count, policy's semantic digest, and kind.
Every load verifies a regular bounded file, SHA-256, size, schema and policy
identity. Missing and damaged blobs raise `checkpoint_artifact_missing` and
`checkpoint_artifact_corrupt`; neither permits a replacement fit.

The trainer's `checkpoint.json` and completion receipt contain references and
metadata, each bounded by 4096 bytes. PM job bodies and controller step receipts
also contain checkpoint references. API results hydrate them for evaluators and
callers. Both prefix learners and proposal-policy checkpoints use this store.
New prefix meta programmes bind `pm-rl/meta-programme/3`; recursive improvers bind
`pm-rl/improver-receipts/4`. Older inline-parameter programmes require a new
programme identity and are refused before adoption, without rewriting history.

Publication validates each policy schema and semantic identity before creating any
blob or permanent ledger root. Invalid policies raise `checkpoint_artifact_invalid`
and leave existing audit roots usable. It writes a private temporary inode, fsyncs it, links it exclusively to
its digest name, verifies any existing blob, and fsyncs the directory. Identical
checkpoints deduplicate; an existing corrupt blob is refused. An SDK tracker lock
serializes publication and ledger insertion with garbage collection. Independent
processes use immutable hash-named ledger entries, so they never overwrite a
shared ledger array. A crash before ledger publication can leave an orphan blob;
a reference is exposed only after its root is durable.

`artifacts/pm-rl/ledger` is the promotion/audit reachability ledger. Staging,
evaluation, promotion and controller phases add immutable roots. Refused candidates
remain reachable for audit. Roots record retention intent before the corresponding
PM transaction; the PM job/phase receipt remains authoritative for the completed
promotion decision. Collection certifies every ledger entry and reachable blob
before deleting any unreachable digest-named blob. Unknown and pending files are
preserved. Collection deliberately does not retire audit roots; retention-policy
changes require a separate explicit operation. Back up the ledger and blobs with
the tracker; Git commits alone do not include runtime checkpoint artifacts.

```sh
pm rl checkpoint show sha256:<artifact-digest> --json
pm rl checkpoint gc --json
```

Inspection verifies ledger entry hashes and reference structure, then verifies only
the requested blob. Missing or corrupt blobs belonging to other jobs do not block
inspection of a healthy digest. Collection still certifies all referenced blobs
before deleting anything. Duplicate audit roots do not repeat target blob reads.

Both commands, training from a sealed dataset, promotion, resume and replay work
without Git. Public-history dataset construction retains its committed-public-source
provenance requirement. Node and the operating system's process identity tools
must remain available for controller/trainer fencing.

Allowed hashing widths are powers of two from 16 through 4096. Fits retain one
SGD pass, at most 512 training rows, the same quantization, learning-rate and
weight bounds, and the unchanged statistical gate. Existing improver arms through
width 64 keep the 4096-byte reservation; larger arms reserve 1 MiB of storage from
the existing approved resource Decision. Charges include both artifact bytes and
all staging files, conservatively per job even when a blob deduplicates. A wider
meta recipe must likewise declare enough storage in its adapter and approval.
Checkpoint blobs themselves have a fixed 1 MiB schema bound.

The reproducible measurement command accepts a sealed history-prefix dataset,
a scratch output directory and an evidence filename:

```sh
GIT_CEILING_DIRECTORIES="$(realpath scratch)" node scripts/checkpoint-benchmark.ts dataset scratch evidence.json
```

It runs the same two-generation, two-candidate compute/statistical programme at
widths 32 and 4096, then replays both. Legacy-size reads and artifact reads use
the same checkpoint bytes, SHA-256 and semantic validator. Load timing is 100
warm synchronous iterations after one warm-up; it is descriptive, not a latency
guarantee. The legacy reader refuses files above 4096 bytes. Scores, predictions,
baselines, gate decisions and final-test results are retained in
[the public-corpus receipt](checkpoint-capacity-evidence.json).

Create `scratch` first. The discovery ceiling keeps each benchmark tracker
independent even when the scratch directory is nested in a checkout. Controllers
inspect ancestor metadata before probing Git; plain-directory controllers launch
no Git subprocess. Git worktrees resolve their shared launch fence directly from `.git` and
`commondir` metadata, independent of Git executable availability. Incomplete or
unreadable worktree metadata raises `loop_git_metadata_unavailable` before any
lease is acquired; an empty marker directory still permits standalone operation.

Regression tests initialize real temporary SDK trackers. The capacity test
interrupts after an inner promotion, resumes without repeating that fit, replays
without new fits, and refuses a missing or corrupt promoted checkpoint. Concurrent
processes promote into one plain tracker with no Git executable on PATH and
preserve both promotion roots. Reachability tests retain shared blobs, collect
orphans and refuse deletion after an incomplete integrity read.
The [behavioral revert receipt](checkpoint-revert-evidence.json) lists the
function-level reversions and retained commands; every reverted variant fails.

## Pinned public-corpus measurements

The completed run uses dataset
`6eb9e7dcb22bb243b472512ce55e4c0ab1d2fa6053b5d489eea7b59240592f48`,
25 public repositories and split sizes 943/225/214/385. Each capacity trains five
fits across two generations and replays the completed programme without new fits.

| Measurement | Width 32 | Width 4096 |
| --- | ---: | ---: |
| Fitted checkpoint size range | 296–651 bytes | 10,343–18,756 bytes |
| Initial fitted checkpoint | 396 bytes | 17,921 bytes |
| Legacy verified load, median | 0.039 ms | Refused: exceeds 4096 bytes |
| Artifact verified load, median | 0.042 ms | 3.768 ms |
| Meta retained accuracy | 140/214 | 140/214 |
| Final before and after | 220/385 | 220/385 |

This is a capacity/storage result. Neither public run promotes a learner or recipe.
Both retain the constant slow seed, predict one class, match the majority baseline,
and have meta gain 0 with lower confidence bound -0.21778781183411927. Final-test
gain is also 0 and the paired majority test has p=1. The synthetic real-tracker
regression separately demonstrates a larger learner's positive inner promotion,
resume and digest-based audit. No real-data improvement is claimed.

## Complete validation

[CI run 39551781806](https://github.com/unbraind/pm-rl/actions/runs/39551781806)
validates source/test commit `f3c8e06d37e715ab4bb65d45c7cc92ed6e911582`:

| Command | Runtime | Tests | Statements / lines / branches / functions |
| --- | --- | --- | --- |
| `npm run release:check` | Node 22 | 661/661 | 100/100/100/100 |
| `npm run release:check` | Node 26 | 661/661 | 100/100/100/100 |
| `bun run release:check` | Node 26, Bun | 661/661 | 100/100/100/100 |

Every variant has zero failures, skips, cancellations or todos; measures all 46
authored sources; and documents all 334 declarations. Full logs confirm strict
fresh-checkout tracker health, typechecking, build, lint, zero duplication,
release-attestation verification, identity audit, zero production vulnerabilities,
pack dry-run, changelog check and Bun package-graph installation. The merge
checkout has the same tree as the source head.
[CodeQL](https://github.com/unbraind/pm-rl/actions/runs/39551782330) also passes.

Pinned linked PM execution passes the six checkpoint regressions and the focused
trainer-IO storage-boundary check. Eight typechecked behavioral reverts fail the
retained tests. The first CI attempt passed all behavioral tests but failed the
unchanged branch threshold; the added combined-budget case closes that gap.
Interrupted local runs are not passing evidence.

Normal local tracker health still reports host-version skew and merge-fence drift;
fresh-checkout CI health passes. Greptile's expired trial, Sourcery's quota limit
and CodeRabbit's skipped automatic review leave substantive review unavailable.
No summary or skipped review is counted as approval. The PR remains unmerged and
the package unreleased.


The PR 92 review round validates source commit
`6bfa3bcc765d96d67adba1da3bf85d4b66b491f5` in
[CI run 39558157659](https://github.com/unbraind/pm-rl/actions/runs/39558157659).
All four findings were valid: policy schema/identity now validates before any
publication, worktree authority resolves directly from Git metadata regardless
of executable availability, the README preserves the reservation through width
64, and both restricted-PATH fixtures discover process tools from the original
PATH. The complete diff was checked for the same defect classes.

| Command | Runtime | Tests | Statements / lines / branches / functions |
| --- | --- | --- | --- |
| `npm run release:check` | Node 22 | 665/665 | 100/100/100/100 |
| `npm run release:check` | Node 26 | 665/665 | 100/100/100/100 |
| `bun run release:check` | Node 26, Bun | 665/665 | 100/100/100/100 |

Each variant has zero failures, skips, cancellations or todos; measures all 46
sources; documents 336 declarations; and passes the complete unchanged gate,
including tracker health, identity/audit, packaging and changelog checks.
[CodeQL](https://github.com/unbraind/pm-rl/actions/runs/39558157708) passes too.
The five focused checks also pass directly and through pinned `pm test --run
--only-last --progress`. Four additional isolated behavioral reverts each
typecheck and fail their retained regression; the revert receipt maps each to
its review thread. The local full gate was interrupted by a provider error and
is not counted as passing. No local timeout is substituted for a passing result.
The review threads remain untouched. No new PM CLI/SDK defect was encountered.
