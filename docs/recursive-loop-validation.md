# Bounded recursive loop validation

Feature: [pm-rl-hjg1](https://github.com/unbraind/pm-rl/blob/main/.agents/pm/features/pm-rl-hjg1.toon).
Epic: [pm-rl-apvf](https://github.com/unbraind/pm-rl/blob/main/.agents/pm/epics/pm-rl-apvf.toon).

The persisted controller shares the existing numerical trainer and promotion transaction. Every attempted generation records its collection Run, real per-sample metrics, checkpoint weight, derived configuration and evaluation results. The seed stores the full programme configuration and the terminal report. A candidate must improve exact held-out expected reward and clear the sampled Hoeffding gate; regression or tied reward cannot replace the promoted baseline.

## Failing-first evidence

The inherited 19 loop tests passed. Added tests initially failed because budget/generation stops were not persisted and the seed retained only a programme digest. A deterministic adversarial fixture (seed 2, ten evaluation episodes, confidence 0.001) promoted a truly regressing policy: sampled reward 0.9 versus 0.4, exact reward 0.46927703497848094 versus 0.5. The added expected-reward guard refuses that candidate. A changed checkpoint with rewards [1, 1] verifies that an exact held-out tie is also refused.

Before the concurrency repair below, the focused suite passed 25/25, without skips. It exercises generation and sample bounds, approval exhaustion, refusal history, successor learning-rate derivation, real SDK and extension execution, and invalid transaction identity propagation. Two loops execute simultaneously in separate real Git worktrees; both independent merge directions preserve every generation and collection item, exact metric events and byte-identical JSONL histories. Every resulting item history is verified. Two simultaneous loops in one workspace also serialize against a shared one-promotion approval.

```text
pm test pm-rl-hjg1 --run --progress --workspace-context snapshot --override-linked-workspace-context
[pm test] linked-test 1/1 end status=passed exit_code=0 elapsed_ms=26801 command="node --test test/loop.test.ts"
ℹ tests 25
ℹ pass 25
ℹ fail 0
ℹ skipped 0
```

The linked command uses `pm_context_mode=none`. The runner requires snapshot or isolated workspace context for that mode; snapshot carries the actual project sources and resolves the execution contract. Runtime caches and transaction journals follow the repository's ignore rules in the merge fixture.

## Concurrent registration repair (PR #61)

The environment registration initially read the content-addressed id and then
created it without handling a concurrent winner. Both loops could finish the
absent read before either create; the SDK serialized the writes and refused the
loser. The original simultaneous-loop test depended on scheduler timing.

The regression now holds both real SDK Environment creates at a barrier until
both callers reach that boundary. It does not replace registration, fabricate
SDK results, sleep, or reduce the existing history/promotion assertions. On
Node v26.7.0, before implementation:

```text
node --test --test-name-pattern='two simultaneous loops share' test/loop.test.ts
✖ two simultaneous loops share a newly registered environment without losing history
ℹ tests 1
ℹ pass 0
ℹ fail 1
Error [PmCliError]: Item "rl-env-loop-bandit-1-e0ddf819a87f" already exists
```

Registration now handles only the SDK's typed duplicate-create refusal, rereads
the winning item, and checks its type, claimed hash and actual content identity.
Different content produces a typed conflict even when it claims the expected
hash. The SDK currently supplies conflict exit 4 and an empty error context for
duplicate creates; recovery checks its exact resolved-id message as well.
Invalid-status, strict duplicate-policy, different-id duplicate and actual
filesystem errors propagate. The review round below replaces the original
permission-based EACCES fixture with a privilege-independent EEXIST fixture.

Audit: `loop.ts` is pure. Environment, seed, collection Run and candidate
Generation persistence in `index.ts` share the verified create/re-read path.
Runs compare configuration, environment, algorithm and receipt-bearing body;
generations rehash immutable provenance while allowing recorded promotion
outcomes. No winner's body or history is overwritten. Seed registration is
idempotent, while loop execution requires a newly created seed: another execution
of that loop id refuses with `loop_already_started` before collection. A second
barrier test verifies exactly one owner and one Run for simultaneous same-id
executions; the existing rerun-refusal test is unchanged.

After implementation, the environment regression reports `tests 1`, `pass 1`,
`fail 0`. The deterministic concurrency test also passed twenty consecutive
invocations, each in a new process and fresh disposable workspace:

```bash
for iteration in $(seq 1 20); do
  node --test --test-name-pattern='two simultaneous loops share' test/loop.test.ts || exit 1
done
```

```text
race repeat 1/20 PASS
race repeat 20/20 PASS
```

Additional real SDK competing creates cover matching and differing seed, Run
and candidate provenance, verify one create event per item, and strictly verify
their item histories. Tracker-linked focused command:

```bash
node --test --test-name-pattern='two simultaneous loops share|loop creation|seed registration|rerunning one loop' test/loop.test.ts
pm test pm-rl-hjg1 --run --only-last --progress
```

The tracker-linked focused command passed 9/9 tests with zero failures, skips or
cancellations in snapshot workspace context with `pm_context_mode=none`.
The final unfiltered `pm test pm-rl-hjg1 --run --progress` also passed both
linked commands: the complete loop suite (32/32) and focused regressions (9/9).

## Independent sampling repair (PR #61)

Finding 4178790392 exposed identical collection and incumbent evaluation seeds.
The new `collection and held-out action streams differ and replay deterministically`
test first failed with identical action vectors. It executes the real numerical
kernel across 64 base seeds and three generations, holds both policies at weight
zero, exposes sampled actions through rewards, compares all three streams and
replays every receipt exactly. No numerical kernel or evaluator is mocked.

The common unsigned 32-bit generation seed is
`base + Math.imul(generation, 0x9e3779b1)`. Collection adds `0x85ebca6b`,
incumbent held-out evaluation adds zero, and candidate held-out evaluation adds
`0x6d5b5b5d`, all modulo 2^32. These distinct seed domains separate collection
from both held-out streams while preserving deterministic replay. They do not
turn adaptive validation into an independent final benchmark.

The lucky-sample fixture still uses seed 2 and yields sampled rewards 0.9 versus
0.4, but its candidate's exact expected reward is now 0.46781798872397673 versus
0.5. The expected-reward guard still refuses it. The packed demo below was rerun
after the seed change, refreshing its means and checkpoint identities.

Finding 4178790401 was valid: directory permissions can be bypassed by a
privileged process. `loop creation propagates real filesystem failures` now
replaces the Environment directory with a regular file immediately before the
real SDK create and restores it afterward. The SDK's mkdir fails with raw
EEXIST, distinct from its typed duplicate-item conflict, regardless of write
permission overrides. The test first failed when its portable assertion saw the
old EACCES fixture, then passed with the replacement; it requires no skip.
Privileged execution itself was unavailable in this verification environment.

Finding 4178790398 is addressed in README and RECURSIVE_TRAINING: the registered
command trains and persists the bounded bandit loop today. Durable continuation,
external process adapters and LLM trainers remain future work. The gap stop is a
training-to-evaluation gap above `maximum_gap`, not a trend check.

## Packed CLI demo

Built and packed the package, initialized a fresh disposable consumer project,
installed the tarball and activated that installed package as the README instructs.
The commands below use relative paths for an artifacts directory and a separate
consumer project:

```bash
npm run build
npm pack --pack-destination artifacts
# In a fresh scratch project:
pm init rl --defaults --agent-guidance skip
npm init -y
npm install ../artifacts/pm-rl-2026.7.31.tgz --ignore-scripts
pm package install ./node_modules/pm-rl --project
printf '%s\n' '```json' '{"permitted_promotions":3}' '```' > approval.md
pm create Decision "Allow three bandit promotions" --id demo-approval --body-file approval.md
pm rl loop run demo-loop --file node_modules/pm-rl/examples/loop-bandit.json --approval demo-approval --json
```

Real command output:

```json
{
  "action": "rl-loop-run",
  "id": "demo-loop",
  "details": {
    "stop_reason": "generation_limit",
    "environment": "rl-env-recursive-loop-bandit-1-8b9a032c92dd",
    "seed_generation": "rl-demo-loop-seed",
    "generations": [
      {
        "generation": 1,
        "run": "rl-demo-loop-g1-collect",
        "item": "rl-demo-loop-g1",
        "promoted": true,
        "held_out_mean": 0.5231,
        "candidate_checkpoint": "sha256:b616a657d2fbbe517dbdb321bdd56a8b9ab4c3e8c42fc2279fbc91a3f77ee7dd",
        "refusal_reason": null
      },
      {
        "generation": 2,
        "run": "rl-demo-loop-g2-collect",
        "item": "rl-demo-loop-g2",
        "promoted": true,
        "held_out_mean": 0.551875,
        "candidate_checkpoint": "sha256:47dc9d4f8a9c39fbc8b0efee229f2d9185c09ce34cacbebb32da8a094715905c",
        "refusal_reason": null
      },
      {
        "generation": 3,
        "run": "rl-demo-loop-g3-collect",
        "item": "rl-demo-loop-g3",
        "promoted": true,
        "held_out_mean": 0.5742,
        "candidate_checkpoint": "sha256:91c81703f2a3edb817bf52409e44cd83256f8f4ff98d312632cbaafa4006e874",
        "refusal_reason": null
      }
    ],
    "promoted": 3,
    "samples_consumed": 768,
    "budget": 768,
    "final_checkpoint": "sha256:91c81703f2a3edb817bf52409e44cd83256f8f4ff98d312632cbaafa4006e874",
    "refusal_reason": null
  }
}
```

`pm history rl-demo-loop-seed --verify --strict-exit --json` exits 0. Scratch `pm validate --json` returns `ok: true` with advisory metadata warnings; these are separate from the execution and history checks.

## Release gate

`npm run release:check` exits 0. Typecheck, build, lint, duplication, docstrings, release attestation, all-source coverage, identity audit, production audit, pack dry-run and changelog check all pass. Exact pass lines:

```text
No duplicates found.
Found 0 clones.
docstring-gate: 21 file(s), 149 declaration(s) documented.
verify-release-publish-attestation: every publish invocation is attested.
git identity audit approved 1 unique address(es).
git identity audit approved 0 unique address(es).
git identity audit approved 1 unique address(es).
git identity audit approved 1 unique address(es).
ℹ tests 365
ℹ pass 365
ℹ fail 0
ℹ skipped 0
coverage-gate: 21 source file(s) reported, thresholds met (lines 100.00%, branches 100.00%, functions 100.00%, statements 100.00%).
git identity audit approved 4 unique address(es).
found 0 vulnerabilities
Changelog is up to date: CHANGELOG.md
```

Coverage thresholds remain 100% in every dimension. `changelog:check` is current, so CHANGELOG was not regenerated.

## Boundaries

This is a bounded in-process contextual-bandit controller. Docker Compose training, distributed leases, cross-branch shared-budget enforcement, crash/cancellation recovery and LLM parameter updates remain in the open epic. Repeated held-out selection is adaptive validation; an independent final benchmark is still required for unbiased performance claims. No publication or deployment is part of this change.
