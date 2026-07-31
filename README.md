# pm-rl

**Reinforcement-learning programme management, on the pm SDK.** Environments and reward
specifications that version instead of mutating. Runs whose metric series live in an
append-only history that unions losslessly when two agents sweep on two branches. Benchmarks,
eval results and sim-to-real transfer gaps that carry provenance back to every environment
version that contributed to them.

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

**Metric logging is append-only, and so is pm's history stream.** A training run emits a
monotonically growing series of events. That is exactly the shape pm's history JSONL and its
field-aware merge driver handle losslessly under concurrent writers on different branches. Two
agents running two arms of one sweep on two branches both append, then merge to the **union**
of both series — no lock, no server, no lost rows. This is verified against real git merges,
not assumed: pm-vcs's suite proves the union property on the same stream, and both agents'
appends survive while a genuinely conflicting scalar is still flagged.

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
| **Environment** | task suite, action/observation space, reward specification, version, seed policy | Immutable once a run references it. A change is a **new version**, enforced — so a result stays attributable |
| **Run** | algorithm, hyperparameters, base checkpoint, environment reference, determinism receipt | Metric series lives in the item's **history**, never its body |
| **Sweep** | search space, selection rule; children are runs | Arms are independent items, so two agents can run two arms on two branches |
| **Benchmark** | tasks, scoring function, pass criteria, version | May declare a contamination edge to an environment whose task suite it overlaps |
| **EvalResult** | one checkpoint scored against one benchmark version | Depends on both, so provenance is complete |
| **Transfer** | the measured per-metric gap between a source environment and a target one for one checkpoint | Depends on **both** environments — the sim-to-real gap becomes tracked data, not folklore |

## Commands

| command | what it does |
| --- | --- |
| `pm rl env register` / `list` / `show` | Declare and version environments and their reward specifications |
| `pm rl run start` / `log` / `finish` | `log` reads newline-delimited JSON on stdin and appends metric events to the run's history — the merge-safe path |
| `pm rl run verify` | Re-derive the determinism receipt, so an unreproducible run is detectable when it is claimed rather than months later |
| `pm rl sweep plan` / `status` | Expand a search space into child run items; report progress across arms |
| `pm rl bench run` / `report` | Score a checkpoint against a benchmark version, recording an EvalResult linked to both |
| `pm rl transfer measure` / `gap` | Record and report the sim-to-real gap per metric across a run's checkpoints |
| `pm rl compare <a> <b>` | Metric-level diff of two runs, with the config delta that explains it |
| `pm rl leaderboard --benchmark <id>` | Rank checkpoints — and **refuse** rather than mix incompatible environment versions or a contaminated benchmark |
| `pm rl invalidate <id>` | Every result transitively invalidated by a change to an environment or benchmark |

## The two refusals

Most experiment trackers will happily show you a number. pm-rl refuses to, in two cases, and
both refusals are the point of the package:

1. **Ranking across incompatible versions.** Two checkpoints evaluated under two environment
   versions are not comparable, and a leaderboard that silently mixes them is worse than no
   leaderboard — it launders a version change into an apparent improvement.
2. **Ranking on a contaminated benchmark.** If a benchmark's tasks overlap the training
   environment's task suite, the score is flattering and meaningless. The overlap is declared
   as a typed dependency, so the refusal is derived from the graph rather than from a human
   remembering.

Both exit non-zero. A warning would be ignored.

## Not in scope

- **No orchestration.** pm-rl does not schedule GPUs, launch jobs, or wrap a trainer. `run log`
  accepts NDJSON on stdin, so any trainer in any language pipes into it.
- **No metric store.** The history stream *is* the store. Growth is bounded by the host's
  `pm history-compact`, not by a retention service.
- **No relationship to `pm eval`.** That core command measures pm's own search relevance
  (nDCG/MRR/precision/recall over a golden-query set). It shares a word and nothing else.

## Requirements

- Node.js ≥ 22.18, tested on 22 and 26
- `@unbrained/pm-cli` ≥ 2026.7.29 (peer dependency)
- Works under `npm`/`npx` and `bun`/`bunx`
- No runtime dependencies beyond the Node standard library

## Development

```bash
npm ci
npm run typecheck
npm run coverage        # hard 100% lines / branches / functions, no suppressions
npm run changelog:check
```

## License

MIT
