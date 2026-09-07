# Recursive training execution

Status: specified for implementation. The current package tracks runs, metrics, generation lineage, evaluation evidence and promotion budgets. It does not execute a trainer. This next phase adds a complete bounded collect → train → evaluate → promote → collect cycle to pm-rl.

## The next production slice

A persisted programme names its initial policy checkpoint, training and evaluation datasets, environment and reward revisions, trainer adapter, seed, and an approved resource-budget Decision. Every artifact has a content digest. The evaluator's held-out dataset remains inaccessible to collection and training. Each promoted successor supplies the policy for the next collection cycle, so a successful demonstration must change a real checkpoint and use it in the next generation.

The first execution adapter runs a local trainer under Docker Compose. The controller and public contracts are TypeScript or Rust. Trainer-specific numerical kernels may be external dependencies, but process execution, provenance, validation and state transitions belong to pm-rl. A local adapter is the first target; a remote scheduler is a later adapter with the same contract.

A programme has explicit bounds on generations, training steps, elapsed time, storage and adapter-reported compute or token use. It cannot create a larger budget Decision itself. Before each phase, the controller atomically reserves the required allowance with the SDK workspace transaction coordinator. Cancellation, exhausted resources, invalid evidence and failed evaluation stop progression. A higher proxy reward alone never authorizes promotion.

## Durable execution contract

Each job follows `planned → running → materialized → evaluated → promoted`, with explicit `failed`, `cancelled` and `invalidated` terminal states. Its identity binds the programme, generation, input checkpoint, dataset digests, environment, reward and training configuration. A replay with identical inputs resumes that identity; it does not create another training run or charge the same reservation twice.

The controller acquires an owner-bound lease before launching work. A second agent may observe it but cannot launch the same job. Checkpoints and metrics first land in a job-owned staging directory. After digest and schema validation, a workspace transaction records the artifact receipt, phase outcome, resource consumption and next eligible action together. A crash between staging and commit must be recoverable without losing a valid checkpoint or promoting it twice. Conflicting configuration changes create a new job identity and invalidate affected successors.

Adapters report structured progress and completion evidence over a documented stream. Exit code zero is insufficient: the receipt must include a readable checkpoint, content identity, training configuration, source policy, dataset lineage and measured resource use. The controller checks actual process identity when stopping a job, retains failed-job evidence, and never runs arbitrary commands from imported untrusted PM text.

## Evidence required before registering execution commands

1. A real small local policy is trained for at least two generations. Generation two collects with generation one's newly trained checkpoint. The experiment records before/after weights or checkpoint hashes and a held-out objective; a simulated process that emits a prewritten metric does not satisfy this criterion.
2. A bounded LLM adapter demonstrates collection, a real parameter update, held-out evaluation and successor use. Model and dataset licenses, checkpoint size and resource limits are declared in the programme before execution.
3. Two controllers contend for one job: exactly one process launches and exactly one budget reservation is charged. Concurrent unrelated jobs keep their metrics and lineage when branches merge in either direction.
4. Crash and cancellation drills cover every transition, including a complete checkpoint without a committed receipt. Restart is idempotent and does not overwrite prior artifacts.
5. Contamination, a widening proxy/held-out gap, stale reward or environment identity, corrupt checkpoints, missing metrics and exceeded resource limits prevent promotion. A failed candidate cannot become the next collection policy.
6. Unit, real-process integration, CLI acceptance, replay, performance and failure-path tests cover every authored source file at exact statement/line/branch/function thresholds. The docstring gate covers the declared source surface, and the scope inventory names anything it excludes.

## Data boundary and capacity

Training workspaces and checkpoints belong to an explicitly selected local project and host-mounted artifact directory. Hosted pm-web, pm-gpt and remote MCP user data are not training inputs merely because they share this host. Cross-project reads require the selected project's authorization, and public package fixtures contain only synthetic or redistributable data.

Capacity claims require measured concurrent programmes, jobs and active clients, plus latency distributions, memory, queue depth, restart behavior and event-loss accounting. A shared directory or a passing health endpoint cannot establish a thousand-user collaboration guarantee.
