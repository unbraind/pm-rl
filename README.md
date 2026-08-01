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
growing series of events. `pm rl run log` encodes each event as one append-only note, and pm's
field-aware merge drivers preserve their union when branches merge. The package test suite
creates two real Git branches, appends a different measurement on each, merges them, and reads
both measurements back through the public command.

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

## Not in scope

- **No orchestration.** pm-rl does not schedule GPUs, launch jobs, or wrap a trainer. `run log`
  accepts NDJSON on stdin, so any trainer in any language pipes into it.
- **No metric store.** The history stream *is* the store. Growth is bounded by the host's
  `pm history-compact`, not by a retention service.
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
