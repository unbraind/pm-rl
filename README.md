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
| `pm rl generation register` / `show` | Record one policy generation of a recursive self-improvement lineage, parented to the generation it was trained from, carrying its base checkpoint and collection runs. Registration records provenance only; the scores, gap and promotion evidence stay null until `promote` populates them. A seed may declare a `--policy` that its children's collection runs must match; a seed with no declared policy skips the run-policy check, since there is no declared policy to violate |
| `pm rl generation promote` | Promote a candidate generation, but only after the contamination and approved-budget refusals below both pass |
| `pm rl lineage` | Print the generation chain with each hop's promotion evidence, its direction-aware proxy-to-held-out gap, and any invalidation, reported with a distinct reason per condition (edited, unreadable, no recorded identity, or absent) |

The remaining types and commands in the roadmap table above are intentionally not registered
until their acceptance criteria and refusal paths are implemented and tested.

## Implemented refusals

The first slice fails closed when context would otherwise become misleading:

1. **A mutated environment cannot start a run.** The command re-hashes the stored specification
   and requires its full hash and content-addressed id to agree, directing the caller to register
   changed behavior as a new version.
2. **An empty run cannot finish.** A terminal Run must contain at least one validated finite
   metric event, so “completed” cannot silently mean that the trainer produced no evidence.
3. **A contaminated candidate cannot be promoted.** Promotion walks provenance edges and refuses
   when the evaluation set is reachable from the candidate's training data, naming the exact path.
   It refuses rather than warns, because a warning on a self-improving loop is a warning nobody
   reads on the tenth generation. A promotion is also refused when the provenance graph is
   unreadable — a collection run that does not resolve leaves the contamination check unable to
   decide overlap, so the promotion is refused (`provenance_unreadable`) rather than treated as
   clean. The lineage view stays tolerant of an unresolvable run, because a degraded view is
   still useful; only a promotion decided on a degraded graph is refused. A parent chain that
   loops is refused the same way (`lineage_cycle`): the ancestry walk can never reach a seed, so it
   would return a TRUNCATED lineage and the contamination check would compare only the part it
   reached — an environment reachable past the repeat point would never be compared, and a
   contaminated candidate would pass a gate that reported nothing wrong. The view again stays
   tolerant and simply stops walking.
   The contamination verdict is decided **inside** the writer lock, over a fresh walk of the whole
   ancestry, so a peer that contaminates an ANCESTOR while this caller waits for the lock cannot
   leave a stale clean verdict behind — the leaf would be byte-identical, and comparing only the
   candidate would miss it. The pre-lock walk is kept as a fast refusal so an obviously
   contaminated candidate never takes the lock; the in-lock walk is the one that decides. The
   promoting write is rendered from the body read inside the lock, so a peer edit that the verdict
   does not depend on survives the promotion rather than being silently overwritten.
4. **The loop cannot advance past its approved budget.** Promotion counts the generations already
   promoted under an approval item and refuses beyond the permitted count, directing the caller to
   extend the approval. The count and the promotion write run inside one workspace writer lock
   (`commitWorkspaceTransaction`), so two concurrent promotions cannot both read the same count and
   both promote past the budget. Callers that **acquire** the lock serialize rather than one being
   rejected for contention: the second caller re-reads the count the winner just changed and
   refuses with the accurate `budget_exceeded`, which is a terminal condition a recursive loop
   must respect, instead of a
   retryable contention error it would retry forever. A Generation whose body is uncountable (no JSON fence or an
   unparseable spec) makes the budget undecidable and is refused (`budget_undecidable`) rather than
   skipped, because treating unreadable provenance as absent provenance inverts the contract. This
   is the property that keeps a recursive loop from running unattended further than a human
   authorized. The same lock makes **one generation promote at most once**: the already-promoted
   check is re-run inside the critical section, because the pre-lock check reads state every
   concurrent caller sees before any of them holds the lock, so all of them would pass it.
   The lock wait is **bounded**, not unlimited: a caller that cannot acquire it within 30 seconds
   fails with `lock_conflict` (exit 4), naming the current owner and how long it waited. That is a
   retryable outcome, so contention is bounded rather than eliminated — but it is reported as
   contention, never as a promotion that did not happen.
5. **Incomparable scores cannot form a gap.** The proxy and held-out scores must share the same
   objective, objective version, and optimization direction. Subtracting scores that name different
   objectives yields a number that is not a gap, and a `maximize` proxy against a `minimize` held-out
   score adds capabilities instead of measuring drift; both are refused (`incomparable_scores`),
   naming the differing fields. A generation spec is also refused when its promotion evidence is
   inconsistent — promoted records must carry their approval, both scores, and their gap, and
   unpromoted records must carry none of them (`promoted_missing_evidence` / `unpromoted_with_evidence`),
   so two consumers never disagree about whether a record counts as promoted. The stored identities —
   `parent` and `approval` — are trimmed at the parse boundary and a blank `approval` is refused
   (`empty_approval`), because both are compared by strict equality: a promoted record storing
   `"  approval-a  "` or `""` would satisfy the evidence invariant while matching no approval id, and
   so consume none of the budget it was promoted under.

All exit non-zero. The roadmap keeps a further hard refusal—ranking across incompatible
environment versions—but no leaderboard command is registered until that graph-derived check is
implemented and accepted. The gap-widening check needs at least two consecutive gaps, so
`pm rl lineage --gap-window` requires an integer of at least 2.

## Recursive self-improvement, and the four properties that make it honest

pm-rl exists to **track and gate** a loop that improves itself: a generation collects trajectories,
a trainer *outside pm-rl* produces a successor, and the successor collects the next generation's
trajectories. pm-rl never runs the trainer — that boundary is the same one stated under *Not in
scope*, and it does not move here. That loop is easy to run and almost impossible to trust, because
every property that makes its results meaningful degrades *silently* as it turns.

None of the four failures below is a training problem. Each one is a provenance problem — which is
to say a context problem — and each becomes answerable from the graph pm stores and merges, **once
the graph carries the right edges**. Reachability is not free: a parent edge from a generation to
its predecessor does not connect an environment revision to the generations that used it. So the
programme's foundation is an explicit graph contract — content-addressed identities for every
artifact a verdict depends on, and declared edges from each generation to its parent, its collection
runs, and the exact environment and reward-spec versions those runs used.

| what quietly breaks | why the score still rises | what pm-rl does about it |
| --- | --- | --- |
| The generating policy is not recorded | Trajectories are indistinguishable, so a regression cannot be attributed to the generation that caused it | A **Generation** names its base checkpoint, its collecting policy and its collection runs, and its parent edge points at the generation that produced its training data ([`pm-rl-81oc`](.agents/pm/features/pm-rl-81oc.toon)) |
| The held-out set becomes training data | The evaluation number improves while capability does not | Promotion is **refused**, not warned about, when the evaluation set is reachable from the candidate's training data, and the refusal names the connecting path ([`pm-rl-gyrj`](.agents/pm/decisions/pm-rl-gyrj.toon)) |
| The proxy and the real objective drift apart | The loop keeps improving *the number being optimized* | Both scores are attributed to the same standard — objective id, version and evaluation context — each objective declares a direction, and the **direction-aware** gap plus its trend along one selected ancestry is the reward-hacking signal ([`pm-rl-zav1`](.agents/pm/features/pm-rl-zav1.toon)) |
| The loop has no stopping point | Nothing distinguishes generation four from generation forty | Advancing past an **approved promotion budget** is refused, and the refusal names the approval item to extend — a tracked decision, never an environment variable ([`pm-rl-qix7`](.agents/pm/features/pm-rl-qix7.toon)) |

Two consequences fall out of modelling it this way rather than bolting on a dashboard. An
environment or reward-spec edit invalidates every downstream generation *transitively*, by reverse
traversal of the environment and reward-spec edges the graph contract requires. And
[`pm rl lineage`](.agents/pm/features/pm-rl-32a9.toon) renders one ancestry from the seed to
a named head with each hop's promotion evidence **and** its invalidation state — the column that
actually decides what to train next. A generation can have more than one promoted successor, so
gap trends are computed within a single ancestry and never across branches. Both selections are
supported: `pm rl lineage <id>` renders the one ancestry ending at that head, and `pm rl lineage`
with no id enumerates every head and renders each ancestry separately.

The first environment this targets is deliberately unglamorous: [the fleet's own mandatory
gates](.agents/pm/features/pm-rl-0cqg.toon). An agent proposes a diff to a pm package, and the
package's exact coverage thresholds, docstring coverage, acceptance scripts and review rounds
decide whether it passed. Those gates make an unusually good reward because they were built to be
uncheatable for an entirely different reason. Because the action is a diff rather than the base
commit, an episode records a content-addressed identity for the **candidate tree** itself, and
replay resolves that exact artifact before running the gates. The sim-to-real gap is then reported
over the **paired cohort** — candidates linked to a real pull request on both sides — with the
denominator stated; candidates present on only one side are reported separately as coverage rather
than folded into a rate.

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
