# Decision input provenance

`readEvaluationDecision(client, candidate)` executes the same reader used by
promotion, and returns `{ registered, report, evidence }`. `evidence` is the
complete input graph captured from real SDK reads by that execution. There is
no separate list of review or checkpoint IDs in card construction. Current
counterparts of history-only sources are read as well; certified creation
snapshots still establish lifecycle order.

The strict `pm-rl/evaluation-evidence/1` schema contains the sealed comparison,
a dense bounded list of canonical SDK IDs and domain digests, and a digest over
that entire object. Each input is `{ id, digest, at? }`; `at` is a positive, safe SDK history-version string.
Durable enclosing steps also pin the certified SDK version
of each input. Plans, review Decisions, every recorded look, collection Runs,
incumbent and candidate provenance all participate. A look contains the actual
cohort observations and predecessor hash, so changing cohort data or dropping a
predecessor changes or invalidates the graph. Human annotations and tracker
status bookkeeping do not change statistical input identity.

Generation policy cards bind exactly the graph returned by the
reader; recursive and proposal-selection cards embed the frozen input manifest
from their completed receipt. Both use the evaluator's captured dependency list. Discovery also finds a registered fixed plan when an older Generation
does not carry the optional `evaluation_plan` field. The decision reader owns
that compatibility rule; cards do not impose a second Plan-binding rule. Foreign
unclaimed Plan slots are skipped with a reason. A retained graph requires its
Plan even when the older Generation has no explicit Plan field. Their ordinary citations retain the full explanation sources, including
generation approvals and training environments. Generation, recursive-step,
and individual proposal cards use this shared path. Legacy cards without a graph
remain readable and historically replayable; they gain no additional authority.

Sequential `advance` and `resume` emit only `evidence_digest` alongside their
compact statistics. Inspect the full graph through the typed SDK. Promotion and rejection
bodies retain `evaluation_evidence`; generation show, promotion/recovery and loop
summaries expose its root. Fixed-sample report fields and comparison hashes stay
unchanged. A new promotion may retain additional provenance without rewriting
its existing plan or cohort.

Durable steps inherit the inputs of actual nested evaluators rather than
collecting unrelated controller bookkeeping. Their completed receipt carries
`decision_evidence` with `format: "pm-rl/evaluation-evidence/2"`. Each input
contains the canonical SDK ID, verified history coordinate and a digest of the
snapshot consumed at execution. The fingerprint includes the complete body,
provenance seal, creation time and Run environment, policy and decoded metrics;
it does not project a Generation under the enclosing step's comparison.
Replay reads only those immutable versions. Later promotions, status changes and
champion changes cannot change an earlier execution or its cards. Snapshot
corruption refuses with its `id@version` in the typed error and remedy. Existing
version-one completed receipts use their recorded history coordinates and original
digest algorithm; no migration or live-state substitution occurs. A receipt with
no certified coordinate refuses only that replay with a restoration remedy.
Promotion/rejection graphs retain version one and validate current evidence. The first completed SDK snapshot binds the entire
receipt; the first terminal snapshot binds a promotion or rejection graph. Removing the graph
or replacing it with a rehashed subset refuses, including when result values
remain unchanged. A completed graph-bearing step cannot be downgraded to running to repeat its
decision. Serialized graph IDs must equal the canonical IDs returned by the SDK;
operator aliases remain supported at normal command boundaries.
A portable card cannot remove its graph and rehash itself to
bypass a graph-bearing receipt or sequential declaration. Upstream generations
are revalidated by the same decision reader, with one operation-local traversal
scope to avoid recursive duplicate reads. Retries still read current revisions
before applying writes.

Errors name the offending canonical record in `context.item_id`, retain a typed
code, and include a remedy. Backend failures remain retryable. Restore the
original evidence or start a fresh predeclared evaluation; never edit an old look
or silently truncate its dependencies. Cards remain bounded to 4096 bytes and 32
direct citations, and refuse before a promotion consumes approval if they cannot
represent the evidence. They continue to allow only inspection and evaluation.

Cards normally inline the complete manifest. When repeating its IDs alongside
the complete citation list would exceed 4096 bytes, `decision_evidence` instead
uses `{ format: "pm-rl/evaluation-evidence-ref/1", comparison, digest }`.
This root identifies the same full manifest in the cited completed receipt or
shared generation decision reader. Replay resolves that manifest, verifies every
input binding, and checks the entire citation set. No citation is dropped, no
limit increases, and a card that still cannot fit refuses before publication.
The typed `PolicyCardDecisionEvidence` union describes both representations.

Tracing preserves the original typed exception and its context identity when
adding `item_id`. Controllers can therefore distinguish their own terminal
promotion-budget verdict from a retryable dependency or revision refusal.
Historical SDK reads remain available after native deletion of the current
record; a storage failure reading that current counterpart still retries.
Recovery validates all required committed promotion fields before closing or
publishing anything. A deleted sealed reservation cannot become a legacy plan
by removing the candidate's pin.
Historical completion discovery uses the same payload validator as step replay.
Malformed peer replacements establish no execution seal; the first valid
completed execution remains immutable even after later invalid records.

```ts
import { PmClient } from '@unbrained/pm-cli/sdk/core';
import { readEvaluationDecision, exportPolicyCard } from 'pm-rl';

const client = new PmClient({ pmRoot: '.agents/pm', author: 'reviewer' });
const decision = await readEvaluationDecision(client, 'rl-candidate');
const card = await exportPolicyCard(client, 'rl-candidate');
// The actual decision reader supplies the graph embedded by the card.
console.log(decision.evidence?.digest, card.decision_evidence?.digest);
```

`test/decision-evidence.test.ts` corrupts each input and all input pairs across
generation and rejected cards, while frozen recursive and proposal-selection cards
retain their digests after live source changes, including the original
review-plus-final-look counterexample. It also checks graph removal/rehashed
subsets, unrelated inputs, 500 SDK read-back transport sequences with older
replays/CRLF/relationships/custom active status, and 500 strict-schema cases.

`test/durable-snapshots.test.ts` generates three evaluate/promote cycles and
replays every earlier completed step and card after each promotion. It covers
existing version-one receipts, all proposal selections, every recorded snapshot
and every snapshot pair, rehashed corruption, SDK read-back after compensation,
and refusal without re-executing a completed operation. The packed acceptance script tests the same frozen/live split through SDK,
JSON and TOON, including named snapshot refusals, under Node and Bun in non-git
trackers.

`test/evaluation-integration.test.ts` checks exception identity through nested
controllers, tracing at depths one through three, deleted native history,
malformed/NDJSON receipts and historical completions, compact full-citation
replay, incomplete committed promotions, and 500 seeded valid/invalid
manifest-reference transports.
