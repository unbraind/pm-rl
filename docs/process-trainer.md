# Durable local process trainer

[pm-rl-shgm](../.agents/pm/features/pm-rl-shgm.toon) implements the local-process
slice of [pm-rl-apvf](../.agents/pm/epics/pm-rl-apvf.toon). Collection, held-out
evaluation and promotion use the existing fenced recursive controller. The
packaged TypeScript bandit kernel performs a real REINFORCE parameter update in
an external child. Both the numerical implementation and synthetic data are MIT.
Docker Compose remains [pm-rl-mjo5](../.agents/pm/tasks/pm-rl-mjo5.toon).

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

Every resource value is a nonnegative safe integer. The reference performs one
optimizer step per external phase. Wall time is capped at one hour and staging
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

The CLI chooses a fixed packaged trainer, launching Node with the script as an
**argv array**, `shell: false`. It accepts no command field in the programme and
never extracts executable commands from PM item text. The SDK adapter entry point
can receive argv selected by trusted application code; it binds the launcher
selection digest into job identity. Those argv values are not persisted in the
tracker. Custom launchers must implement this same bandit checkpoint contract;
additional model formats require a separately validated adapter.

The child receives one JSON request on stdin, then EOF. It contains `job` and
`input`: the programme/generation/input-policy identities, training examples,
actual collected actions/rewards, `training_config`, and dataset/collection
lineage digests. Environment and reward content identities are included. The
held-out dataset's digest is included for attribution; its examples are absent.
Training cannot read held-out data through this input channel. Local processes
run as the invoking user; filesystem isolation and process-tree/cgroup quotas
belong to the Compose follow-up.

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
