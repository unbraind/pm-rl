# Portable policy explanation cards

A policy card describes the suitability of one generation or recursive proposal phase. It is an explanation with evidence locators, never an executable checkpoint or a grant of backend authority. The format is `pm-rl/policy-card/1`.

```sh
pm rl policy-card export rl-programme-g1 --json
pm rl policy-card export rl-programme-g1
# Save the unwrapped `details` object from JSON output as card.json.
pm rl policy-card replay --file card.json --json
pm rl policy-card adopt --file card.json --json
# Inspect one proposed candidate from a recursive proposal batch.
pm rl policy-card export rl-improver-step-g1-d-t0-proposals --selection 0
```

The host renders compact TOON by default and JSON with `--json`. Export and replay read trackers without mutations. Each card is capped at 4 KiB and 32 direct evidence citations; overflow refuses rather than hiding citations. Tracker identifiers and immutable history-version locators are the only copied source strings. Training configurations, policy parameters, example text, titles, credentials, raw outcomes and free-text diagnostic messages stay in their original stores. Their domain contents contribute SHA-256 digests. Do not treat a hash as anonymization of low-entropy data, or publish the underlying tracker without a separate privacy review.

Each card includes a proposal digest and a nullable policy digest, training-scope digest, collection count, environment and reward digests, permitted explanation actions (`inspect`, `evaluate`), numeric resource declarations, fixed regression categories, bounded numeric evaluation diagnostics and evidence locators. The policy digest binds the declared content-addressed checkpoint/policy artifact and its configuration. Evaluation notes do not change it. Unfitted proposals and opaque legacy references have `policy_digest: null`; their `proposal_digest` identifies their definition without claiming a learned policy identity. Unknown evaluation remains `evaluation_incomplete`; an unpromoted candidate cannot pass adoption checks. Resource declarations describe the original experiment; another backend must supply its own consent and enforce its own budget.

## Recursive coverage

Generation registration seals evaluation diagnostics in the Generation body as `policy_evaluation`, leaving replay-critical trainer configuration unchanged. Native comments and notes, including notes resembling old evaluation markers, are annotations only. It records the candidate card before promotion; promotion retains a new outcome card. Earlier cards stay unchanged and replay against verified history. The durable inner/outer controller records every completed recursive phase and each member of a proposed recipe/configuration batch. This covers learner trials, improver updates, causal selection outcomes, retained/rejected generations and outcome-ledger receipts. A later improver can enumerate the SDK's complete Decision inventory, select `pm-rl/policy-card/1` bodies and replay their citations before using earlier diagnostics. Checkpoint artifacts continue to own executable state. If card publication is interrupted after a committed promotion, restore storage and run the normal loop resume command; it repairs the explanation before advancing. Publication failures remain retryable operational errors.

Generation cards cite parents, collection runs, environments and promotion approvals. When present, they also cite the causal evaluation plan, paired result, shadow deployment and shadow comparison. Existing causal and shadow gates run again on adoption checks. The card does not relax those gates or claim that a single tracker proves transfer to another population.

Regression diagnostics follow the recorded held-out score direction: lower means improve a minimizing objective, and higher means improve a maximizing objective. Trainer candidates without a recorded score retain the bounded trainers' maximizing convention. Before promotion writes any outcome or spends approval budget, the writer lock validates the complete prospective card, including the approval citation and its resource declarations. An oversized outcome refuses with `card_limit` while the candidate and approval budget remain unchanged.

## SDK

```ts
import { PmClient } from '@unbrained/pm-cli/sdk/core';
import { exportPolicyCard, replayPolicyCard, adoptPolicyCard } from 'pm-rl';

const client = new PmClient({ pmRoot: '.agents/pm', noExtensions: true });
const card = await exportPolicyCard(client, 'rl-programme-g1');
const replay = await replayPolicyCard(client, card);
console.log(replay.results); // Every cited id, version locator and verified digest.
await adoptPolicyCard(client, card); // Suitability check; no adoption side effects.
```

`PolicyCard`, `PolicyCardEvidence` and `PolicyCardRefusal` are exported types. Refusals are expected SDK errors (conflict exit 4) with stable `context.code` and a remedy in the message:

| Code | Remedy |
| --- | --- |
| `provenance_read_retryable` | Retry the same read or resume after storage recovers. EIO, EAGAIN, EBUSY, concurrent-write ENOENT and timeouts (including native `TimeoutError`) do not create terminal promotion refusals. |
| `card_missing_provenance` | Restore the original source and every cited history; complete provenance before adoption. |
| `card_invalid` | Supply an unwrapped card or a valid subject/proposal index. |
| `card_drift` | Restore the exact evidence or export a new card after the legitimate change. |
| `card_limit` | Split the experiment into bounded candidates; never remove evidence to fit. |
| `card_not_adoptable` | Keep the incumbent; complete evaluation, limits and normal promotion gates. |

Replay reconstructs the minimized explanation from certified historical records; rehashing a forged card does not validate its facts. Adoption additionally compares with a fresh export, requires a promoted Generation with complete provenance and explicit numeric limits, and walks its complete canonical ancestry back to the root seed. Every generation must retain its current card, declared content-addressed policy identity and all cited evidence; cycles, absent ancestors, absent cards and missing results refuse. Existing causal/shadow enforcement applies to every promoted ancestor. A missing history, result or source never becomes an empty successful explanation. Historical replay is not a statement that the policy remains suitable today.

Transient reads of evaluation-plan creation history and policy-card history enumeration also remain retryable. Unrelated native storage errors and coordinator validation errors preserve their original diagnostics and leave the programme resumable; they never establish a terminal policy verdict.

## Without git

Export, replay, adoption checks and automatic recursive cards work in plain-directory trackers without a Git executable. Git-backed public-history dataset construction keeps its existing provenance requirements; cards add no Git subprocesses.

The [example card](../examples/policy-card.json) comes from the validation tracker; replay also requires its cited histories.

The public-copy validation script is `test/policy-card.acceptance.ts`; aggregate measurements are in [policy-card-evidence.json](policy-card-evidence.json). It reads a permission-protected public tracker snapshot, trains two recursive generations, verifies retained candidate/promoted cards, exercises packed CLI TOON/JSON/replay/adoption, and checks every source byte remains unchanged. This is finite-snapshot recognition evidence, not a claim of general intelligence or statistically powered proposer transfer.

The measured sampled policy means are 0.59765 and 0.685825; the always-closed majority baseline is 36/41 (0.8780487804878049). The receipt keeps this limitation explicit alongside the successful provenance and lifecycle checks.


Registration, recursive receipt publication, rejection outcomes and batch card publication
also validate before their associated durable writes. Replay rejects citations outside
the historical subject's certified dependency graph before collecting resource limits.
Evaluation and shadow citations must match the subject's pinned comparison lineage.
The [write-boundary audit](policy-card-write-audit.md) inventories generation, history,
card, budget, artifact and receipt writes and documents the complete durable-state
snapshots, including the pinned SDK's derived observation-ledger exception.

A citation selects the first SDK-certified history version with the exact policy-content
projection. Its `at` field accepts an SDK version coordinate (or a historical timestamp
on replay). It never selects the latest event or hashes history length. Later comments,
ordinary notes, tags, claims, lifecycle changes and presentation edits preserve that coordinate,
the retained card and fresh-card adoption. A changed artifact, configuration, collection
evidence, evaluation verdict or approval produces different content and invalidates
adoption of the old card. Decoded metric-bearing Run notes are collection evidence,
including both legacy and compressed segments; editing, deleting or appending metric
events also changes the card identity and blocks ordinary loop resume. Card export
and resume use the same generation evidence graph. Approval references use the
SDK canonical identity, so uppercase and short aliases preserve both results. Historical replay remains
available for cards issued with this binding. Pre-fix cards bound to mutable
coordinates or excluding metric notes need re-export and retention after upgrade.

The complete [digest and provenance input inventory](policy-card-write-audit.md#digest-and-provenance-input-inventory)
records the fields and certified source of every check added by this feature.


Read-derived rejection, promotion, recovery and phase-receipt changes check the
revision captured before validation or execution inside the SDK item transaction.
A peer update causes `loop_write_conflict`; retry from current evidence after
inspecting the peer change. Promotion publishes its body and closure together and
checks the approval revision while holding the SDK approval item lock. Card and
absent-receipt publication preserve the native exclusive-create winner. Comment
receipts use the SDK's lock-scoped append idempotency. See the complete write-path
inventory in the [concurrency audit](policy-card-write-audit.md#fifth-review-concurrency-and-shared-evidence-audit).
