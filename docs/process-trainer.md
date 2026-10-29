# Durable process trainers

[pm-rl-shgm](../.agents/pm/features/pm-rl-shgm.toon) implements the local-process
slice of [pm-rl-apvf](../.agents/pm/epics/pm-rl-apvf.toon). Collection, held-out
evaluation and promotion use the existing fenced recursive controller. The
packaged TypeScript bandit kernel performs a real REINFORCE parameter update in
an external child. Both the numerical implementation and synthetic data are MIT.
[pm-rl-mjo5](../.agents/pm/tasks/pm-rl-mjo5.toon) adds Docker Compose execution using the same durable job and receipt contract.

## Programme and approved resources

Select `trainer: "bandit"` (also the default) and add this adapter declaration:

```json
{
  "kind": "process-bandit",
  "allowance": {
    "training_steps": 1,
    "wall_ms": 5000,
    "storage_bytes": 65536,
    "compute_units": 1000,
    "tokens": 0
  }
}
```

The full programme is [examples/loop-process.json](../examples/loop-process.json).
Authorize its two promotions and aggregate resource ceilings explicitly:

```sh
pm create Decision "Two bounded process generations" --id process-approval \
  --body '```json
{"permitted_promotions":2,"resource_budget":{"training_steps":2,"wall_ms":10000,"storage_bytes":131072,"compute_units":2000,"tokens":0}}
```'
pm rl loop run process-demo --file node_modules/pm-rl/examples/loop-process.json --approval process-approval --json
pm rl loop status process-demo --json
pm rl loop resume process-demo --approval process-approval
```

Default process-loop output shows the stop reason, promotions, samples, final
policy and compact job states. `--json` retains complete job identities, receipts,
allowances, settled charges and generation evidence. The SDK's `runRlLoop`,
`resumeRlLoop` and `rlLoopStatus` return that full evidence. Pass the tracker root
to status so it can verify checkpoint bytes.

Every resource value is a nonnegative safe integer. The reference defaults to one
optimizer update per external phase. An explicit `fit_steps` from 1 to 256
enables repeated importance-weighted updates over the collected batch and must
match the adapter's `training_steps` reservation before launch. Each update is
charged; resume retains the declared count. See the [real tracker corpus
measurement](tracker-loop.md). Wall time is capped at one hour and staging
at 1 GiB; the supplied example is much smaller. Compute units are adapter-reported CPU milliseconds for fitting and checkpoint
publication (ceil of user plus system CPU time). Runtime bootstrap and
request/receipt processing are outside that reported compute interval; observed
wall time covers startup through completion publication. Tokens are zero for this
local numerical trainer. These bounds supplement existing generation, collection,
statistical improvement and approved-promotion bounds.

The controller never creates or edits a resource-budget Decision. A workspace
transaction reserves the whole allowance before launch, counting every held or
settled execution Task governed by that Decision. One stable transaction key and
one content-bound job identity prevent duplicate charges on replay, including
concurrent SDK calls. Successful materialization atomically commits its receipt,
state and measured charge; the unused allowance is released. Failed/cancelled
jobs settle conservatively against the whole reserved vector, increased to any
larger observable storage or valid reported use. Unknown use is never assumed
zero. Compensated reservations record their released vector and outcome. Settled
training and retained storage remain charged, including after evaluation refusal.

All dimensions and the original approval specification digest are rechecked.
Changing an approval cannot silently authorize an already reserved job. Concurrent
writers must use the same coherent tracker and SDK coordinator. Independent Git
worktrees use separate approved allocations; their job Tasks, metric notes and
lineage can merge, while ignored local staging must be transferred and verified
explicitly before executing a foreign branch's artifacts.

## Execution channel and completion contract

The local-process CLI chooses a fixed packaged trainer, launching Node with the script as an
**argv array**, `shell: false`. It accepts no command field in the programme and
never extracts executable commands from PM item text. The SDK adapter entry point
can receive argv selected by trusted application code; it binds the launcher
selection digest into job identity. Those argv values are not persisted in the
tracker. Custom launchers must implement this same bandit checkpoint contract;
the LM adapter supplies its model-specific validator through this same execution contract (see [LM Compose validation](lm-adapter.md#external-compose-trainer-2026-10-16)).

The child receives one JSON request on stdin, then EOF. It contains `job` and
`input`: the programme/generation/input-policy identities, training examples,
actual collected actions/rewards, `training_config`, and dataset/collection
lineage digests. Environment and reward content identities are included. The
held-out dataset's digest is included for attribution; its examples are absent.
Training cannot read held-out data through this input channel. Local processes
run as the invoking user. The Compose adapter below supplies filesystem and
container lifecycle isolation; kernel CPU/storage quotas are tracked separately.

Stdout is UTF-8 line-delimited JSON. Every event has `job` and `type`:

```json
{"type":"progress","job":"<content-bound job>","usage":{"training_steps":0,"wall_ms":0,"storage_bytes":0,"compute_units":0,"tokens":0}}
{"type":"complete","job":"<content-bound job>","receipt":{"format":"pm-rl/process-completion/1","job":"<content-bound job>","checkpoint":"checkpoint.json","digest":"sha256:<exact byte digest>","policy":{"weight":0.1,"digest":"sha256:<policy digest>"},"training_config":{"learning_rate":0.5,"steps":1},"source_policy":"sha256:<collecting policy>","lineage":{"training":"sha256:<dataset>","held_out":"sha256:<dataset>","collection":"sha256:<batch>"},"usage":{"training_steps":1,"wall_ms":1,"storage_bytes":120,"compute_units":1,"tokens":0}}}
```

Progress use must be monotonic and within the reservation. Exactly one completion
ends the stream; missing, malformed, foreign, regressing, oversized or subsequent
events refuse. Combined stdout/stderr is capped at 65,536 bytes. Diagnostics and
valid events are retained in staging. A zero exit code **without completion
evidence is refused**. A nonzero exit also refuses an ordinary invocation.

The child exclusively creates and fsyncs `checkpoint.json`, then fsyncs
`completion.json` and the staging directory before sending completion. The
receipt binds configuration, source policy, dataset lineage and measured use.
Its digest hashes exact checkpoint bytes; the policy digest hashes the versioned
numerical policy and is independently recomputed. The reference's checkpoint
contains its real scalar weight and policy digest. The current schema caps it at
4,096 bytes and the completion document at 65,536 bytes. The stream receipt must
match the durable completion document.

Each job owns tracker-relative `runtime/pm-rl/jobs/<job>/`. The validator measures
all retained flat staging files, refuses directories and symbolic links, and
accepts only the fixed checkpoint basename inside that directory. Actual wall
and storage use are checked while the child runs, with a 25 ms watchdog. Observed
wall use also covers process startup through completion publication. Adapter
compute/token/step reports are validated before promotion. Polling is bounded
overshoot detection, not an OS disk quota; an exceeded allowance is recorded and
blocks progression.

## Durable state and recovery

The job Task stores `planned → running → materialized → evaluated → promoted`,
with `failed`, `cancelled` and `invalidated` outcomes. Promotion requires the
existing held-out objective, contamination, immutable environment/reward and
approved-budget checks. Resource failure and invalid evidence cannot select a
successor. Job identity binds programme instance and configuration, generation,
input policy, datasets, collected batch, environment, reward, fit configuration
and trusted launcher identity. Identical inputs reuse the same job. A changed
programme under an existing loop id conflicts; an explicitly new programme id
has a new identity. Existing lineage invalidation continues to fence successors.

Both the controller and standalone SDK adapter hold owner-bound SDK mutexes.
Process-owned SDK transaction locks record OS birth identity. Recovery expires
only demonstrably dead local holders through the open inode/token check; a live,
unknown or successor owner retains authority. Stopping a trainer verifies its
recorded PID and birth time first. Failed-job artifacts are retained.

A kill after checkpoint and completion publication but before the materialization
transaction commits leaves a running job with valid staged evidence. Restart
verifies and adopts that checkpoint, settles the original reservation, evaluates
and promotes once. It never launches that fit again. A running job without a
valid staged completion terminates safely rather than silently restarting a
possibly active fit. SIGTERM/AbortSignal stops the owned child, records
`cancelled`, retains partial artifacts and settles its reservation. A cancelled
external fit is terminal; another attempt requires a newly authorized programme
identity. Completed phases before a boundary cancellation remain resumable.

## Docker Compose execution

A bandit programme can select the container adapter for every generation:

```json
{
  "kind": "compose-bandit",
  "image": "sha256:<64 lowercase hexadecimal digits from docker build --quiet>",
  "allowance": {
    "training_steps": 1,
    "wall_ms": 30000,
    "storage_bytes": 65536,
    "compute_units": 1000,
    "tokens": 0
  }
}
```

The image must already exist in the local Docker daemon and implement the stdin,
NDJSON and staged bandit checkpoint protocol above. Mutable tags, repository
names, arbitrary commands and extra adapter fields refuse at configuration parse.
`docker compose run --pull never --no-deps -T` runs the image's entrypoint. The
image identity is part of the trusted launcher digest; source-policy, dataset,
programme and generation identities retain the existing process job schema.
The CLI, SDK and persisted resume/status paths use the same selection. Switching
images requires a new programme identity. The SDK's local-process argv override
does not override a Compose image's entrypoint.

The controller reserves before launch and retains launch ownership. A project
name hashes the complete job ID and its staging location, isolating independent
trackers even when they have identical synthetic inputs. The controller fsyncs
an exclusive `compose.json` in the job directory and explicitly passes its file,
project and directory on every Compose call. Ambient Compose discovery and dotenv
loading are disabled. Only this job directory is mounted at the container's
working directory. The generated file is additionally mounted read-only to
prevent the trainer changing cleanup instructions. There are no host ports,
networks, Docker socket mounts, hosted inputs or host environment forwarding.
The root filesystem is read-only, capabilities are dropped, privilege escalation
is disabled and the trainer uses the invoking user's numeric UID/GID. Image
entrypoints must work within those restrictions.

The container is the trainer process. The controller supplies input, applies the
existing wall/storage watchdog and validates its stream against durable host
files. Compute units retain the trainer-reported CPU-millisecond meaning; these
checks do not promise CPU scheduling, a cgroup CPU-time ceiling or an OS disk quota.
Kernel-enforced CPU/storage ceilings are tracked in
[pm-rl-7073](../.agents/pm/tasks/pm-rl-7073.toon).
The reservation and settlement transaction is shared with local execution.
Failure/cancellation releases the active hold, retaining the conservative settled
charge and original artifacts rather than assuming unknown consumption is zero.

On normal exit, container death, watchdog refusal or cancellation, cleanup removes
only the exact job-named container with matching Compose project/service labels,
using its immutable daemon ID, then runs project-scoped `compose down`. The trainer
is created without automatic removal so recovery and daemon auto-removal cannot
race over container ownership. Explicit
container removal matters because Compose `down` and `rm` omit one-off `run`
containers on supported hosts. Cleanup never removes images or host artifacts.
A fsynced `compose-stop.json` records job, project and exit/cancellation/recovery
reason. The job Task and append-only history contain the durable failure or
cancellation receipt and settled charge. A failed cleanup never changes that outcome:
it is recorded as the separate `cleanup` diagnostic described below.

Recovery never launches a previously running job. It stops any surviving owned
container, validates staged completion, then either adopts the original checkpoint
and settles once or commits failure with retained staging. A kill after completion
publication and before the PM materialization commit therefore trains only once.
A cancelled fit remains terminal. Transfer staging explicitly before resuming in
a relocated workspace; active containers belong to their original local location.

Cleanup failure is recorded independently as `cleanup: { code: "cleanup_failed", error }`
in the durable process job body and transition history. It preserves a validated
completion, cancellation outcome, or original trainer error. The diagnostic is
bounded to 4,096 characters and replaces the job staging path with `<staging>`.
Recovery uses the same separate diagnostic path; retained artifacts remain
available for inspection when cleanup could not finish.

### Real container drills

Run `node --test test/compose.test.ts` from a source checkout. Its tiny local
`test/fixtures/compose.Dockerfile` pins `node:24-alpine` by digest, copies only the actual
TypeScript numerical trainer and fixture entrypoint, and installs no dependencies.
Only the base image may need a pull; trainer execution has no network and never
pulls. The fixture performs the real REINFORCE update rather than emitting a
prewritten checkpoint. A second locally built image publishes a partial artifact
and waits, providing a deterministic kill/cancel barrier.

The suite skips real Docker drills only when `docker compose version` fails and
prints an explicit `SKIPPED` reason. A working Compose CLI with a failed daemon,
image build or drill is a failure. It checks launch/receipt/replay, container kill,
cancellation, competing real controllers, controller SIGKILL before receipt commit,
orphan cleanup and two bounded generations with retained receipts. The second
collection Run must identify the first promoted checkpoint; both checkpoint byte
hashes must change. The same full coverage thresholds include the Compose source.

The measured two-generation Compose drill promoted policy digests
`2a2616b67e223fbee4480df1716b75d7542a736f574bce0eed331ac17ad90866`
and `4242c0ffdd131a7c535bd18c42f6118e89f6cb27ed728485ddce43464d08b5c4`.
Their exact checkpoint byte digests were
`a81ee5538f8451969dd7d22df07ea5299dff92e4267200d760c5298a418cf66f`
and `04205767f4fefcb97c97eedc6fc7739da446f51ab7cc050f7f3f20e5f9527452`.
The second collection Run identifies the first promoted policy. Each job charged
one training step and zero tokens; completion and stop receipts remained under
its job directory. These are synthetic numerical-policy results.

All 11 added cases fail with their relevant behaviour reverted in isolated source
snapshots: the previous adapter parser (one case), previous reserved execution
function (nine cases), or removal of the pre-launch recovery guard (one case).
The restored implementation passes 11/11 with zero skips. No test fixture,
coverage scope or threshold is changed by those proofs.

### Compose release validation

Review round 1 adds four real Compose cleanup regressions: cancellation, success,
trainer failure and recovery of completed staging. An executable wrapper fails
only `compose down`; container launch, training, kill and removal remain real.
Reverting only launch cleanup handling fails the three primary-outcome cases;
reverting only recovery cleanup handling fails the recovery case. Fixed code
passes 4/4 through the linked PM snapshot run and both complete release gates.

Both `npm run release:check` and `bun run release:check` pass **582/582 tests**,
with zero failures, skips, cancellations or todo cases. Each gate measures exact
**100/100/100/100** statement/line/branch/function coverage across all **28**
authored sources, **266** documented declarations, zero duplication and zero
production audit findings. Packaging and changelog checks pass. Dependency pins,
coverage scope and all thresholds are unchanged.

One earlier npm attempt missed the existing packed LM CLI bound: the measured
CLI took 22.138 seconds against its unchanged 20-second limit. The same case
measured 9.038 seconds in the passing full npm gate and 12.907 seconds in the
passing full Bun gate. Review round 1 measured 12.623 seconds (npm) and 12.272
seconds (Bun), also within the unchanged bound. The separate test setup time is
not the timed CLI interval.
[pm-rl-7c7m](../.agents/pm/tasks/pm-rl-7c7m.toon) tracks that existing variability.

## Two-generation packed CLI measurement

The real packed CLI selected `process-bandit` for both fits, used 128 collection
samples and 40,000 held-out evaluation episodes per policy per generation, and
promoted both candidates. Acceptance used a 256-sample total cap; the shipped
example declares 256 samples per generation and a 512-sample total cap. The measured
acceptance command completed in **5.210 seconds** at the time of measurement. The test
asserts outcomes only: it logs the elapsed time and keeps the 20-second subprocess
deadline, so host load cannot fail an otherwise correct run. This is a synthetic contextual-bandit
objective and an adaptive validation set, not a language-model capability claim.

| Generation | Collecting policy SHA-256 | Candidate policy SHA-256 | Sampled held-out reward |
| --- | --- | --- | ---: |
| 1 | `17493680209cdf2fc86126ff2ad0b7bb6063ae24ce00f28f931224bb5ab2fd11` | `2a2616b67e223fbee4480df1716b75d7542a736f574bce0eed331ac17ad90866` | 0.524050 |
| 2 | `2a2616b67e223fbee4480df1716b75d7542a736f574bce0eed331ac17ad90866` | `4242c0ffdd131a7c535bd18c42f6118e89f6cb27ed728485ddce43464d08b5c4` | 0.550400 |

The exact stored checkpoint byte hashes were
`a81ee5538f8451969dd7d22df07ea5299dff92e4267200d760c5298a418cf66f`
and `04205767f4fefcb97c97eedc6fc7739da446f51ab7cc050f7f3f20e5f9527452`.
Generation two's real collection Run component equals generation one's promoted
policy digest. Each job settled one training step, zero tokens and two reported
CPU milliseconds. Observed fit wall use was 78 / 78 ms; retained staging was
2,176 / 2,203 bytes. The unchanged held-out environment and reward identities are
bound into each job. Rejected, missing-receipt, corrupt and oversized candidates
never become generation two's collector.

## Verification

Real temp trackers and real child processes cover one-launch contention, one
reservation, SIGKILL before receipt commit, crashes at durable transitions,
SIGTERM mid-fit, checkpoint/dataset/budget drift, malformed and absent completion,
resource limits, compensation, replay, successor use and packed CLI output.
The crash fixtures prevent SIGKILL-able children from inheriting the parent
coverage report directory; the same authored trainer, entry dispatcher and
controller execute under coverage in the parent test suite. This avoids truncated
V8 diagnostic files without excluding source or lowering thresholds.
The full release gate inventories both new source files and retains the original
100/100/100/100 statement/line/branch/function thresholds, docstring gate and zero
duplication policy. Operational script sources remain in the existing gate scope.

Final implementation `d06e3cb` passes both `npm run release:check` and
`bun run release:check`: **564/564 tests each**, zero skips/cancellations,
27 authored sources at exact **100/100/100/100** statement/line/branch/function
coverage, 261 documented declarations, zero duplication and zero production audit
findings. The original thresholds and existing CLI deadlines are unchanged.
An earlier Bun attempt missed the existing LM CLI 20-second assertion at 20.436
seconds under CPU saturation; the unchanged retry measured 11.891 seconds.

The added 38 real-process tests increase the suite from 526 to 564 cases.
Their recorded case durations total 108.298 seconds under npm
and 127.320 seconds under Bun. The isolated `origin/main`
baseline suite took 2,199.529 seconds; final suite times were
1,946.330 seconds for npm (raw delta -253.199) and
1,867.577 seconds for Bun (raw delta -331.952).
Shared-host load varied, so these raw differences are not a controlled speedup
claim. Both full gates used ordinary temporary trackers and isolated CI Git/home
settings; the separate diagnostic memory-filesystem attempt is not a gate result.

Final-fixture behavioural guard-removal proofs run in an isolated source snapshot:
the restored reservation and receipt regressions pass 2/2; removing reservation-once
inspection and stable transaction identity fails its replay regression (0/1, budget
exhaustion); reversing receipt-required acceptance in `launchTrainer` and
`validateProcessCompletion` fails its real checkpoint-without-receipt regression
(0/1, missing expected rejection). The target implementation was never reverted.

```sh
node --test test/process.test.ts test/process-loop.test.ts test/process-cli.test.ts
npm run release:check
bun run release:check
npm run changelog:full
npm run changelog:check
```


Recovery preserves the SDK-recorded wall charge. Historical Node writers observed
fractional filesystem milliseconds; older Bun writers observed integer
milliseconds. A recorded charge must exactly match one of those two measurements
of the same nanosecond timestamp and declared usage. Other charges refuse; this
is not a general tolerance. Initial measurement keeps the writer's existing
behavior, and receipt contents, checkpoint bytes, every other resource and the
approved allowance remain checked. Copy retained staging files with timestamps
preserved. The main-produced corpus checks both runtime directions through the
SDK, without normalizing the reference state.

`processJobBodyId(body)` retains a stored version-one ID exactly. The explicit
`processJobBodyId(body, false)` declaration check validates and canonicalizes a
new ID. Strict new-write refusals remain tested separately from legacy reads.
