# Recursive training execution

Status: the persisted bounded loop is implemented as `pm rl loop run` ([`pm-rl-hjg1`](.agents/pm/features/pm-rl-hjg1.toon)): one command executes collect → train → evaluate → compare against the promoted baseline → promote or reject over the built-in deterministic contextual bandit, records every generation as real tracker items (a collection Run with per-sample metric notes, a Generation item with the derived configuration and full provenance, refusal reasons as item history), promotes only through the existing transactional contamination- and budget-checked gate, derives the next generation's learning rate and evaluation episode count deterministically from the previous evaluation results, and terminates on its own hard bounds — generation limit, total sample budget, unchanged checkpoint, training-to-evaluation gap above `maximum_gap`, statistical gate refusal, or an exhausted approved promotion budget. Durable continuation is implemented in [pm-rl-od32](.agents/pm/features/pm-rl-od32.toon): SDK controller leases, shared worktree launch authority, persisted replay, status/resume commands and signal recovery. [pm-rl-qhz2](.agents/pm/features/pm-rl-qhz2.toon) adds real per-question temperature/bias gradient updates over a frozen System One model; [pm-rl-ip21](.agents/pm/features/pm-rl-ip21.toon) records CPU-only live tev1 generations with retained canonical checkpoints, per-query PM receipts and a 15-minute whole-run deadline. See [the measured adapter contract](docs/durable-systemone-validation.md). [pm-rl-upe0](.agents/pm/features/pm-rl-upe0.toon) adds a real bounded TypeScript causal LM with frozen copy-pretrained weights, REINFORCE LoRA updates, canonical disk checkpoints and verified successor collection. [LM validation](docs/lm-adapter.md) records three real CLI generations and held-out improvement; criterion 2 is met for this CPU adapter. Opted-in remote endpoint receipts recover the HTTP-to-PM commit window in [pm-rl-9nlg](.agents/pm/issues/pm-rl-9nlg.toon). Docker Compose adapters and storage/compute reservations remain separate work.

## Durable local continuation

Every generation has stable PM Decision keys `<loop>-g<N>-step-collect`,
`-step-train`, `-step-evaluate`, and `-step-promote`. Each records `running` before
work and commits a content-digested `complete` receipt bound to the programme,
source checkpoint, generation and derived configuration. Resume adopts completed
receipts; unfinished collection appends only its missing metric suffix. The LM
fit commits its actual adapter tensors before checkpoint materialization and
held-out evaluation, so a kill after the fit receipt can recover the artifact
without fitting again. The seed retains the frozen base weights; status and
resume restore them without repeating pretraining. Older loop records retain their
original replay verification path.

A completed promotion receipt whose generation was subsequently reverted is
refused as drift; resume preserves the records for explicit reconciliation.

The SDK controller lease lasts 60 seconds, renews at phase entry and exit, and heartbeats every 20 seconds while idle between phases.
The SDK phase mutex serializes a step's effects and receipt with takeover; a live
controller executing a phase retains that mutex through the commit. A contender
receives the holder and expiry. Expired idle leases and demonstrably dead local
holders can be taken over. A displaced controller's token is fenced before every
write and before claim release, including when both controllers use the same
author. Lease renewal publishes atomic JSON, and abandoned phase mutex recovery
expires the dead holder's open inode for the SDK's own stale-lock cleanup.

SIGINT, SIGTERM or an AbortSignal stop at the next durable step boundary and
append a cancellation comment to the seed. `pm rl loop resume <loop> --approval
<decision>` continues unfinished steps using the persisted configuration. Work
killed before a completion receipt is durable may execute again; completed steps
are adopted once. The synthetic tiny-LM process drills cover SIGKILL inside metric
and fit writes, a committed fit before materialization, committed evaluation,
a promotion body committed before item close, simultaneous lease contenders,
expired live-holder fencing and SIGTERM during
collection. These local receipts do not provide remote endpoint idempotency.

## The next production slice

A persisted programme names its initial policy checkpoint, training and evaluation datasets, environment and reward revisions, trainer adapter, seed, and an approved resource-budget Decision. Every artifact has a content digest. The evaluator's held-out dataset remains inaccessible to collection and training. Each promoted successor supplies the policy for the next collection cycle, so a successful demonstration must change a real checkpoint and use it in the next generation.

The next execution adapter will run an external local trainer under Docker Compose, extending the implemented in-process TypeScript bandit trainer. Trainer-specific numerical kernels may be external dependencies, but process execution, provenance, validation and state transitions belong to pm-rl. A local process adapter is the first durable target; a remote scheduler is a later adapter with the same contract.

The implemented loop bounds generations, collection samples and approved promotions. Durable continuation will additionally bound training steps, elapsed time, storage and adapter-reported compute or token use. It cannot create a larger budget Decision itself. Before each external phase, the durable controller will atomically reserve the required allowance with the SDK workspace transaction coordinator. Cancellation, exhausted resources, invalid evidence and failed evaluation must stop progression. A higher proxy reward alone never authorizes promotion.

## Durable execution contract

Each job follows `planned → running → materialized → evaluated → promoted`, with explicit `failed`, `cancelled` and `invalidated` terminal states. Its identity binds the programme, generation, input checkpoint, dataset digests, environment, reward and training configuration. A replay with identical inputs resumes that identity; it does not create another training run or charge the same reservation twice.

The controller acquires an owner-bound lease before launching work. A second agent may observe it but cannot launch the same job. Checkpoints and metrics first land in a job-owned staging directory. After digest and schema validation, a workspace transaction records the artifact receipt, phase outcome, resource consumption and next eligible action together. A crash between staging and commit must be recoverable without losing a valid checkpoint or promoting it twice. Conflicting configuration changes create a new job identity and invalidate affected successors.

Adapters report structured progress and completion evidence over a documented stream. Exit code zero is insufficient: the receipt must include a readable checkpoint, content identity, training configuration, source policy, dataset lineage and measured resource use. The controller checks actual process identity when stopping a job, retains failed-job evidence, and never runs arbitrary commands from imported untrusted PM text.

## Evidence required for durable continuation and LLM trainers

`pm rl loop run` is already registered and tested for bounded in-process bandit training. The following criteria apply to the remaining durable process adapters and LLM training work.

1. A real small local policy is trained for at least two generations. Generation two collects with generation one's newly trained checkpoint. The experiment records before/after weights or checkpoint hashes and a held-out objective; a simulated process that emits a prewritten metric does not satisfy this criterion.
2. **Met for the in-process CPU adapter:** a bounded LLM adapter demonstrates collection, a real parameter update, held-out evaluation and successor use. Model and dataset licenses, checkpoint size and resource limits are declared in the programme before execution. See [the measured LM adapter](docs/lm-adapter.md) and [pm-rl-upe0](.agents/pm/features/pm-rl-upe0.toon). The external Docker trainer remains open.
3. Two controllers contend for one job: exactly one process launches and exactly one budget reservation is charged. Concurrent unrelated jobs keep their metrics and lineage when branches merge in either direction.
4. Crash and cancellation drills cover every transition, including a complete checkpoint without a committed receipt. Restart is idempotent and does not overwrite prior artifacts.
5. Contamination, a training-to-evaluation gap above `maximum_gap`, stale reward or environment identity, corrupt checkpoints, missing metrics and exceeded resource limits prevent promotion. A failed candidate cannot become the next collection policy.
6. Unit, real-process integration, CLI acceptance, replay, performance and failure-path tests cover every authored source file at exact statement/line/branch/function thresholds. The docstring gate covers the declared source surface, and the scope inventory names anything it excludes.

## Data boundary and capacity

Training workspaces and checkpoints belong to an explicitly selected local project and host-mounted artifact directory. Hosted pm-web, pm-gpt and remote MCP user data are not training inputs merely because they share this host. Cross-project reads require the selected project's authorization, and public package fixtures contain only synthetic or redistributable data.

Capacity claims require measured concurrent programmes, jobs and active clients, plus latency distributions, memory, queue depth, restart behavior and event-loss accounting. A shared directory or a passing health endpoint cannot establish a thousand-user collaboration guarantee.

## Implemented numerical foundation

[`pm-rl-s44k`](.agents/pm/features/pm-rl-s44k.toon) provides a small real TypeScript
policy-gradient adapter through `runBanditProgramme`. Its logistic two-action policy
collects actual actions and observed rewards, applies one batch REINFORCE update,
evaluates the candidate, and uses only a promoted checkpoint to collect the next
batch. The implementation follows the score-function policy-gradient update
covered by [Sutton and Barto](https://www.incompleteideas.net/book/bookdraft2018mar21.pdf).
The numerical adapter is deliberately limited to bounded scalar observations and
synthetic contextual bandits; it is not an LLM parameter-update demonstration.

The deterministic seed, explicitly serialized programme configuration, dataset
identities, actual checkpoint weights and collection receipts make replay
inspectable. Collection cycles through the training examples in declared order;
actions are sampled from the source policy. The trainer receives only the reward
of the sampled action. Exact expected rewards over the examples reject regressions
and measure the training-to-evaluation gap. The promotion gate also samples each
policy for the declared `evaluation_samples` episode count on separate deterministic
held-out streams; collection uses its own seed domain.

The adapter rejects duplicate example identities, invalid numerical bounds,
unchanged checkpoints, insufficient evaluation improvement and excessive
training/evaluation gaps. It allows at most 100 generations, 100,000 total collected
actions, and 10,000 examples per dataset. A rejected candidate remains in the
receipt but never replaces the last accepted checkpoint. There is no PM budget
reservation or PM generation promotion implied by this in-memory result.

Evaluation examples never enter the gradient. Repeated promotion decisions do
use their scores, so this is an adaptive validation set: reserve a separate final
benchmark for unbiased performance claims. Unique example IDs cannot establish
semantic dataset independence or detect differently named duplicate content.

`pm rl loop run` already persists collection Runs, Generation artifacts and refusal
history, and calls the transactional provenance-aware PM promotion gate against an
approved promotion budget. The implemented controller adds owner-bound SDK leases and idempotent
continuation after durable phase boundaries and cancellation. The System One
adapter changes calibration-head parameters and uses promoted heads for successor
collection. Isolated external execution, compute-budget reservations and remote
scheduling remain under the execution criteria above. Immutable remote request receipts are supported through the opted-in contract in [the adapter validation document](docs/durable-systemone-validation.md#recoverable-external-decision-receipts).
