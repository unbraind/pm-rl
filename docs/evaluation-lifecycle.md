# Clock-independent evaluation lifecycle

New sequential designs can declare `"ordering":"causal/1"`; start from the
[complete example](../examples/evaluation-plan-causal.json). The statistical
plan format and stopping rule stay the same; the comparison hash includes the
new ordering choice. Existing plans, including fixed-sample plans, keep their
original serialization and timestamp-based ordering. There is no in-place
upgrade: choose a fresh candidate and review a new design. Fixed plans do not
accept this option.

The lifecycle is review approved → Plan sealed → all collection Runs → candidate
→ ordered looks → promotion. Collection Runs are exchangeable. Each later stage
binds **every** earlier-stage artifact, including every collection Run at every
look. The review attests to the exact design; a separate Decision still supplies
the promotion budget. Neither a causal witness nor a sufficient statistical
result grants execution or mutation authority.

```sh
# plan.json is a complete sequential design with ordering set to causal/1.
pm rl eval plan approve --file plan.json
pm rl eval plan register --file plan.json
pm rl run start rl-collection --environment rl-training --algorithm policy \
  --evaluation-candidate rl-candidate
pm rl generation register rl-candidate --parent rl-seed --base-checkpoint candidate \
  --policy policy --collection-runs rl-collection --environment rl-training
pm rl eval plan advance rl-candidate --file first-look.json
pm rl eval plan advance rl-candidate --file final-look.json
pm rl eval plan resume rl-candidate --json
# Promotion uses the existing approval and exact-score requirements.
```

Use the actual registered environment ID and the seed provenance hash in your
plan. The SDK exports `approveEvaluationPlan(client, plan)` and
`startRunCore(client, request)` with `RunStartRequest.evaluationCandidate`.
`registerEvaluationPlan`, candidate registration, sequential advance/resume and
manual/controller promotion consume the same validator. `rl eval plan show`
reports the opted-in ordering. No Git repository or executable is needed for
this lifecycle.

A witness is one `pm-rl/evaluation-birth/1` native note created **atomically with**
its artifact. It contains the comparison, stage, a fresh random nonce, the
request digest and exact predecessor birth digests. Readers reconstruct each
birth using the SDK's verified version-one snapshot, verify the original witness
still exists unchanged, and compare all predecessor digests. Each predecessor birth
is read once as a birth/current pair per operation. Creation and replay reuse those
validated records and the digest cache; the cache expires when that call returns.
Dates remain
historical content; no date comparison, filesystem mtime or timestamp-sorted
event-list position decides causal order. Equal timestamps, host skew and clock
rollback therefore do not alter an eligible chain.

This is causal evidence produced by the declared SDK writers, under the existing
append-only-history trust boundary. It is not an externally signed time service
or a proof against an actor fabricating all artifacts and their histories.
Pre-existing native records cannot acquire eligibility by adding a witness
later. Missing, duplicated, changed or incomplete witnesses refuse with
`eval_plan_evidence` or `eval_plan_late`; request or immutable-envelope drift
refuses with `eval_plan_drift`. Retained policy-card checks surface changed cited
witnesses as `card_drift`. Use a fresh candidate/plan when an existing
artifact has no original witness. Restore certified history if it is unavailable.

Collection admission holds the candidate/Plan leases; candidate publication
retains the existing evidence revision fences. Native creates commit the witness
and artifact together, so there is no secondary ordering journal to repair.
Identical retries reuse that birth, including after an unacknowledged committed
write. A new Run after candidate creation is refused; a retry of an already
admitted Run remains valid. Annotations and metric appends remain allowed.
Existing candidate registration and preflight verify the same birth envelope,
including the checkpoint field. Generation bodies compare their immutable
provenance, and policy-card checks retain the promotion-bookkeeping validation.
Causal witnesses also participate in decision/evidence digests. Promotion and
already-promoted retries revalidate the same chain alongside provenance,
contamination, exact scores, terminal state and approval capacity.

## Public tracker example

The [retained receipt](evaluation-lifecycle-evidence.json) uses a read-only copy
of public `unbraind/pm-rl` main, with the exact source commit and authoritative
record digest. It selects the first 64 canonical item IDs and records the
closed-item fraction against constant 0.5. These are descriptive bounded values,
not measured policy improvement. All items belong to **one repository correlation
unit**, so the conservative sequential gate refuses promotion.

Review, Plan, Run, candidate and look were written with SDK clocks stepping
backwards from 2032 through 2028. The causal chain validates, and the source
records retain their original digest. Reproduce after copying the named public
commit's `.agents/pm` into a scratch source directory:

```sh
node test/evaluation-lifecycle.acceptance.ts source/.agents/pm PUBLIC_COMMIT
```

`test/evaluation-lifecycle.test.ts` additionally exercises equal clocks,
independent OS writers on one tracker, SIGKILL before application acknowledgement,
identical retry history, all cross-stage pair inversions, malformed/retroactive
witnesses, CLI flows, promotion retry and fixed-plan compatibility. The revert
runner executes behavioural mutations only in disposable copies. Run
`node test/evaluation-lifecycle.revert.ts` to regenerate the complete
[revert receipt](evaluation-lifecycle-revert.json). It parses the runner's actual
TAP counts, requires the selected test's expected failure code and diagnostic,
and records the passing restoration. Process errors, signals, worker timeouts,
cancelled/skipped tests and unrelated failures cannot certify a revert. Inherited
Node test filters are excluded. Receipts are written only after every selected
mutation and restoration has been verified; `finally` restores the disposable
source even when verification refuses the evidence. All five package revert
generators use this same admission and restoration helper; the proof tests enumerate
them and reject independent runners or assumed pass/fail totals.

Causal ancestry checks compare each stored birth with a fresh current read of its
sealed fields: ID, type, creation time, affected and fixed versions, component,
environment, and body. Run metric notes, annotations and terminal status may
change; Generation bodies compare provenance so promotion bookkeeping remains
supported. These checks apply to ancestry and retries before publication.

Causal artifact slots must remain distinct after native project-prefix
normalization. Approval repeats the identity check under its lease before the
review write, and plan resolution applies the same rule to registration.

A selected lifecycle revert run writes a partial receipt (`complete: false`) with
its selection and only the results measured by that invocation. It never adopts
older results. A run without selectors measures every case and writes a complete
receipt.
