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

New decision-backed policy cards embed exactly the graph returned by the
reader. Their ordinary citations retain the full explanation sources, including
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
`decision_evidence`. Replay verifies the original certified versions and live
decision-bearing content. The first completed SDK snapshot binds the entire
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
generation, rejected, recursive and proposal-selection cards, including the original
review-plus-final-look counterexample. It also checks graph removal/rehashed
subsets, unrelated inputs, 500 SDK read-back transport sequences with older
replays/CRLF/relationships/custom active status, and 500 strict-schema cases.
