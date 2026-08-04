# pm-rl

**Reinforcement-learning programme management, on the pm SDK.** The first production slice
provides content-addressed environment specifications and attributable run lifecycles. Run
metrics live in merge-safe notes and are proven to union losslessly when two real Git branches
append independently. Benchmarks, sweeps, eval results and sim-to-real transfer are the next
planned slices, not hidden or partial commands.

```bash
npm install --save-dev pm-rl     # or: bun add -d pm-rl
pm install pm-rl
pm rl env register --file environments/grid-v3.json
```

---

## Why this exists

`project management = context management`. An RL programme is one of the most context-heavy
things an agent can run: dozens of environments, hundreds of runs, sweeps whose individual
trials mean nothing without a baseline, and benchmark scores that are worthless without the
exact environment version, seed and checkpoint behind them.

Today that context lives in a dashboard, a folder of JSON, and shell history. None of it is
reviewable, none of it merge-safe, and none of it available to the agent that has to decide
what to train next. The number an agent most needs — *is this result still valid after I
changed the reward spec* — is not written down anywhere.

pm-rl makes the programme itself a tracker.

## Why pm is the right substrate, and not just a place to put labels

Two properties do the real work, and neither is incidental.

**Metric logging is append-only, and so are pm notes.** A training run emits a monotonically
growing series of events. `pm rl run log` validates the complete input, packs canonical NDJSON
into compressed segments of at most 48 KiB decoded data and 65 KiB serialized note text, and
appends the segments as one atomic mutation. pm's field-aware merge drivers preserve every
accepted branch occurrence when branches merge.
The reader remains compatible with the original one-event `pm-rl/1` notes. The package test
suite creates two real Git branches, appends the same measurement on each, merges them, and
reads both occurrences back through the public command.

Event identity is the accepted note occurrence, not the metric payload. Two identical
measurements may be legitimate and remain distinct; `run log` therefore has at-least-once
semantics and never guesses that equal payloads are retries. A producer that cannot tolerate a
duplicate must resume from its own acknowledged input boundary rather than replay an uncertain
batch.

The corollary is a hard design rule: **metrics go to history, never to an item's body.** A body
is a scalar field, and two sides changing a scalar is a real conflict. A series written to the
body would conflict on every concurrent write. A series written to history never does.

**Runs are a dependency graph, and pm already has one.** A run depends on an environment
version and a base checkpoint; an eval result depends on a run and a benchmark version; a
transfer measurement depends on two environments. `pm update --dep` models that and `pm graph`
queries it — so *"which results are invalidated if I change this reward spec"* is a reachability
query the host can already answer, not a feature to build.

## What it tracks

| type | holds | key constraint |
| --- | --- | --- |
| **Environment** | task suite, action/observation space, reward specification and version | Content-addressed; registration is idempotent and every use verifies that the stored body still matches its identity |
| **Run** | algorithm, hyperparameters, base checkpoint, environment reference, determinism receipt | Metric series lives in the item's **history**, never its body |
| **Sweep** | search space, selection rule; children are runs | Arms are independent items, so two agents can run two arms on two branches |
| **Benchmark** | tasks, scoring function, pass criteria, version | May declare a contamination edge to an environment whose task suite it overlaps |
| **EvalResult** | one checkpoint scored against one benchmark version | Depends on both, so provenance is complete |
| **Transfer** | the measured per-metric gap between a source environment and a target one for one checkpoint | Depends on **both** environments — the sim-to-real gap becomes tracked data, not folklore |
| **Generation** | base checkpoint, the policy that collected the training data, those collection runs, and the training configuration | Its parent is the generation whose policy did the collecting, so lineage is an edge rather than a filename convention |

## Available commands

| command | what it does |
| --- | --- |
| `pm rl env register` / `list` / `show` | Declare and version environments and their reward specifications |
| `pm rl run start` / `log` / `show` / `finish` | Snapshot exact environment and configuration provenance, append validated NDJSON metrics from a file or stdin, order the series by step, and refuse to finish an empty run |

The remaining types and commands in the roadmap table above are intentionally not registered
until their acceptance criteria and refusal paths are implemented and tested.

## Implemented refusals

The first slice fails closed when context would otherwise become misleading:

1. **A mutated environment cannot start a run.** The command re-hashes the stored specification
   and requires its full hash and content-addressed id to agree, directing the caller to register
   changed behavior as a new version.
2. **An empty run cannot finish.** A terminal Run must contain at least one validated finite
   metric event, so “completed” cannot silently mean that the trainer produced no evidence.

Both exit non-zero. The roadmap keeps two further hard refusals—ranking across incompatible
environment versions and ranking a contaminated benchmark—but no leaderboard command is
registered until those graph-derived checks are implemented and accepted.

## Recursive self-improvement, and the four properties that make it honest

pm-rl exists to support a loop that improves itself: a generation collects trajectories, trains a
successor, and the successor collects the next generation's trajectories. That loop is easy to run
and almost impossible to trust, because every property that makes its results meaningful degrades
*silently* as it turns.

None of the four failures below is a training problem. Each one is a provenance problem — which is
to say a context problem — and each is already answerable from the graph pm stores and merges.

| what quietly breaks | why the score still rises | what pm-rl does about it |
| --- | --- | --- |
| The generating policy is not recorded | Trajectories are indistinguishable, so a regression cannot be attributed to the generation that caused it | A **Generation** names its base checkpoint, its collecting policy and its collection runs, and its parent edge points at the generation that produced its training data ([`pm-rl-81oc`](.agents/pm/features/pm-rl-81oc.toon)) |
| The held-out set becomes training data | The evaluation number improves while capability does not | Promotion is **refused**, not warned about, when the evaluation set is reachable from the candidate's training data, and the refusal names the connecting path ([`pm-rl-gyrj`](.agents/pm/decisions/pm-rl-gyrj.toon)) |
| The proxy and the real objective drift apart | The loop keeps improving *the number being optimized* | Every generation records both a proxy and a held-out score; the gap and its trend across promotions are reported as the reward-hacking signal they are ([`pm-rl-zav1`](.agents/pm/features/pm-rl-zav1.toon)) |
| The loop has no stopping point | Nothing distinguishes generation four from generation forty | Advancing past an **approved generation budget** is refused, and the refusal names the approval item to extend — a tracked decision, never an environment variable ([`pm-rl-qix7`](.agents/pm/features/pm-rl-qix7.toon)) |

Two consequences fall out of modelling it this way rather than bolting on a dashboard. An
environment or reward-spec edit invalidates every downstream generation *transitively*, because
descendants are reachable over edges that already exist. And [`pm rl lineage`](.agents/pm/features/pm-rl-32a9.toon)
can render the chain from seed to head with each hop's promotion evidence **and** its invalidation
state — the column that actually decides what to train next, and the one that is invisible today.

The first environment this targets is deliberately unglamorous: [the fleet's own mandatory
gates](.agents/pm/features/pm-rl-0cqg.toon). An agent proposes a diff to a pm package, and the
package's exact coverage thresholds, docstring coverage, acceptance scripts and review rounds
decide whether it passed. Those gates make an unusually good reward because they were built to be
uncheatable for an entirely different reason, and the sim-to-real gap is directly measurable:
sandbox gate-pass rate against merge rate on real pull requests.

**What this is not.** None of the above is a claim of unbounded self-improvement, and pm-rl does
not train anything — it has no orchestration and never will (see *Not in scope*). It tracks the
loop, and it refuses to let the loop's results look valid when their provenance says otherwise.
The programme is specified under [`pm-rl-yi7j`](.agents/pm/epics/pm-rl-yi7j.toon); as with every
other roadmap slice, no command is registered until its acceptance criteria and refusal paths are
implemented and tested.

## Not in scope

- **No orchestration.** pm-rl does not schedule GPUs, launch jobs, or wrap a trainer. `run log`
  accepts NDJSON on stdin, so any trainer in any language pipes into it.
- **No separate metric store.** The history stream *is* the store. Retained evidence necessarily
  grows with retained measurements. Each segment is capped at 48 KiB decoded and 65 KiB
  serialized. In the representative sustained integration workload—not as a universal
  compression ratio—10,000 events across 40 mutations occupy 99,526 history bytes for 736,650
  input bytes (13.51%).
- **No relationship to `pm eval`.** That core command measures pm's own search relevance
  (nDCG/MRR/precision/recall over a golden-query set). It shares a word and nothing else.

## Requirements

- Node.js ≥ 22.18, tested on 22 and 26
- `@unbrained/pm-cli` ≥ 2026.8.1 (peer dependency)
- Works under `npm`/`npx` and `bun`/`bunx`
- No runtime dependencies beyond the Node standard library

## Development

```bash
npm ci
npm run typecheck
npm run docstring       # hard 100% documented declarations
npm run coverage        # hard 100% lines / branches / functions, no suppressions
npm run changelog:check
```

## License

MIT
