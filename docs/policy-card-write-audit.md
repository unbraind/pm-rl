# Policy card write boundaries

The audit covers the complete feature diff against main, including the registration,
promotion, recursive publication and recovery call sites. Card refusals validate the
prospective source and its complete citation graph before the associated durable
write. Limits stay at 4096 canonical JSON bytes and 32 direct citations; proposal
batches stay at 32 selections. No coverage threshold changes.

| Durable write | Boundary and refusal proof |
| --- | --- |
| Generation creation and its creation history | `registerGenerationCore` constructs the complete candidate, including native evaluation notes, and calls `validatePolicyCardWrite` before schema initialization or `createOrReadIdentical`. `registration refuses every card limit` rejects both citation count and canonical byte overflow twice, comparing every durable tracker file before and after. A bounded candidate then succeeds. |
| Schema settings, schema document and workspace history | Registration initializes types only after prospective validation. Promotion reads an existing Generation and does not initialize unrelated types. The same registration and promotion snapshots include schema and `_workspace` history. |
| Promotion body update, close, item history and approval budget | `promoteGenerationCore` validates the complete promoted body, approval citation and allowance before opening its transaction journal, then revalidates under the authoritative writer lock before update/close. `prospective promoted card overflow` checks two refusals against all durable tracker bytes, then consumes the unchanged one-unit budget successfully. No separate counter is written: promoted Generation provenance determines budget consumption. |
| Promotion transaction journals and compensation receipts | The pre-journal validation precedes `commitWorkspaceTransaction`. The promotion refusal snapshot includes runtime transaction journals, so a compensated transaction with otherwise restored domain fields would still fail. The in-lock validation remains necessary for concurrent changes. |
| Immutable policy-card Decisions, dependency edges and their histories | `recordPolicyCard` exports and validates before creating anything. `recordRecursivePolicyCards` computes every projection and checks every known card collision before the first batch write. `recursive card batch refuses collision` checks body, type and identity collisions on a later selection and direct oversized publication without partial shared-card publication. |
| Native rejection notes, rejection comments and their histories | `recordRefusedPolicyCard` validates the prospective note before `notes(ifAbsent)` and card publication. Callers append bookkeeping comments afterwards. `prospective rejection notes` invokes the real rejection writer and requires a byte-identical durable tracker after refusal. |
| Outer recursive phase Decisions and completion histories | Outer phases validate the full completed receipt before creating/updating its Decision. Newly executed promotion phases also defer their intent receipt until the promotion succeeds, so a deterministic card refusal cannot create a running promotion receipt. `recursive receipt card limits` compares all durable files around an oversized proposal phase, then retries the same key with a valid bounded result. |
| Checkpoint blobs and append-only artifact ledger roots | `encodeCheckpointArtifacts` offers a pre-publication validator over the actual encoded result. The outer controller validates all projected cards there before publishing any blob or ledger root. The recursive receipt regression includes a real prefix checkpoint and checks that a card refusal publishes neither artifacts nor receipts. |
| Recovery close and recovered candidate/promoted/refused cards | `reconcileLoopPromotion` exports the complete prospective promoted card before closing an interrupted promotion. Verified complete/refused paths validate cards before advancing; existing real filesystem obstruction and collision tests verify resume repairs post-commit publication failures. |
| PM task receipts and documentation | Repository tracker comments, linked files/docs/tests and claim release are intentional task documentation committed with code. These are distinct from the disposable tracker snapshots used for refusal proofs. |

The read-only export, replay and adoption functions do not write domain records.
Replay first validates the certified historical subject's exact dependency graph;
only those bound citations can contribute resource declarations. Evaluation plans
must bind that subject, its incumbent and its pinned comparison identity. Paired
results and shadow records must bind that comparison/deployment. An unrelated
certified Decision, including one appended to a rehashed card, refuses with the
typed `card_invalid` error. Missing required citations use `card_missing_provenance`;
changed lineage bindings use `card_drift`.

Snapshots enumerate the disposable tracker's complete file inventory and compare
actual file bytes. They include settings, schemas, item documents, every history
stream, artifacts, budgets and all durable runtime transaction receipts. Two
explicit exclusions are necessary with the pinned SDK: `locks/` contains renewable
coordination leases, and `runtime/context-usage.jsonl` is a derived observation ledger
that the SDK unconditionally appends on ordinary current `get` calls. Neither is a
domain or approval receipt. No telemetry setting or SDK dependency was changed.
Consequently these tests certify byte-identical **durable tracker state**, not
literal equality of those two observational/coordination locations.

The validation boundary does not roll back previously completed phases, arbitrary
side effects inside a caller's operation, concurrent peer writes, or storage errors
after a successful commit. The pre-publication callback prevents package-owned
checkpoint publication on a deterministic card refusal. Existing interrupted
publication tests retain the normal resumable recovery contract. Concurrent
post-preflight changes still require the authoritative in-lock validation; an
operational failure there can retain transaction diagnostics.

## Behavioural reverts

Each proof runs `node --test --test-name-pattern="<pattern>" test/policy-card.test.ts`
in an isolated text-only source copy using the unchanged pinned SDK. Only the
named production behavior is reverted. Tests import source, and the regression
file hash is checked before and after each run; each source file is restored in
`finally`. The six-boundary baseline is also run through the pinned PM snapshot
runner with context `none` and a 600-second timeout.

| Pattern | Production behavior removed for the proof |
| --- | --- |
| `replay refuses unrelated` | Closed citation allowlist check. |
| `registration refuses every` | Prospective registration validation before generation creation. |
| `prospective promoted card overflow` | Pre-journal validation, retaining the in-lock check to expose journal-only drift. |
| `recursive card batch` | Batch collision preflight, retaining the normal immutable card collision check. |
| `recursive receipt card limits` | Deferral of the running receipt until its full card validates. |
| `recursive receipt card limits` | Artifact validator moved after blob/ledger publication. |
| `prospective rejection` | Preflight before native rejection-note append. |
| `generation citations` | Pinned Plan wrapper identity check. |
| `generation citations` | Exclusion of allowances from plans and comparison receipts. |
