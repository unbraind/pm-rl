# Policy card write boundaries

The audit covers the complete feature diff against main, including the registration,
promotion, recursive publication and recovery call sites. Card refusals validate the
prospective source and its complete citation graph before the associated durable
write. Limits stay at 4096 canonical JSON bytes and 32 direct citations; proposal
batches stay at 32 selections. No coverage threshold changes.

| Durable write | Boundary and refusal proof |
| --- | --- |
| Generation creation and its creation history | `registerGenerationCore` constructs the complete candidate, including sealed evaluation outcomes, and calls `validatePolicyCardWrite` before schema initialization or `createOrReadIdentical`. `registration refuses every card limit` rejects both citation count and canonical byte overflow twice, comparing every durable tracker file before and after. A bounded candidate then succeeds. |
| Schema settings, schema document and workspace history | Registration initializes types only after prospective validation. Promotion reads an existing Generation and does not initialize unrelated types. The same registration and promotion snapshots include schema and `_workspace` history. |
| Promotion body update, close, item history and approval budget | `promoteGenerationCore` validates the complete promoted body, approval citation and allowance before opening its transaction journal, then revalidates under the authoritative writer lock. The SDK item transaction checks the captured candidate revision and atomically publishes the promoted body and terminal fields; it also holds the SDK approval item lock and checks the exact approval revision used to authorize budget consumption. `prospective promoted card overflow` checks two refusals against all durable tracker bytes, then consumes the unchanged one-unit budget successfully. No separate counter is written: promoted Generation provenance determines budget consumption. |
| Promotion transaction journals and compensation receipts | The pre-journal validation precedes `commitWorkspaceTransaction`. Body and closure are now one atomic SDK item mutation; no captured body is restored by compensation. The promotion refusal snapshot includes runtime transaction journals. The in-lock validation remains necessary for concurrent changes. |
| Immutable policy-card Decisions, dependency edges and their histories | `recordPolicyCard` exports and validates before creating anything. `recordRecursivePolicyCards` computes every projection and checks every known card collision before the first batch write. `recursive card batch refuses collision` checks body, type and identity collisions on a later selection and direct oversized publication without partial shared-card publication. |
| Sealed rejection outcomes, rejection comments and their histories | `recordRefusedPolicyCard` validates the prospective Generation body after capturing the current revision, before an idempotent guarded SDK body mutation and card publication. The SDK checks that revision again under its native item lock. Callers append bookkeeping comments afterwards. `prospective rejection notes` invokes the real rejection writer and requires a byte-identical durable tracker after refusal. |
| Outer recursive phase Decisions and completion histories | Outer phases validate the full completed receipt before creating/updating its Decision. Existing/running receipts capture their revision before executing work and complete through the guarded SDK item transaction; absent receipts use native exclusive creation. Newly executed promotion phases also defer their intent receipt until the promotion succeeds, so a deterministic card refusal cannot create a running promotion receipt. `recursive receipt card limits` compares all durable files around an oversized proposal phase, then retries the same key with a valid bounded result. |
| Checkpoint blobs and append-only artifact ledger roots | `encodeCheckpointArtifacts` offers a pre-publication validator over the actual encoded result. The outer controller validates all projected cards there before publishing any blob or ledger root. The recursive receipt regression includes a real prefix checkpoint and checks that a card refusal publishes neither artifacts nor receipts. |
| Recovery close and recovered candidate/promoted/refused cards | `reconcileLoopPromotion` exports the complete prospective promoted card before closing an interrupted promotion through the same guarded SDK item transaction. Verified complete/refused paths validate cards before advancing; existing real filesystem obstruction and collision tests verify resume repairs post-commit publication failures. |
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
| `prospective rejection` | Preflight before sealed rejection-outcome update. |
| `generation citations` | Pinned Plan wrapper identity check. |
| `generation citations` | Exclusion of allowances from plans and comparison receipts. |
| `generation citations` | Concrete comparison identity required; an offline plan cannot cite an undeclared shadow comparison through two missing values. |

## Digest and provenance input inventory

This inventory covers every digest/fingerprint and provenance check introduced in
the PR, including transitive package checks called by export, replay, adoption and
publication. “Immutable” means content reconstructed from a verified, append-only
SDK history version. An authorized policy change creates a new content identity;
it cannot silently change the content already cited by an earlier card.

| Check | Every input and reason for binding it |
| --- | --- |
| Citation domain digest (`domain`, `snapshot`, prospective writes) | Canonical item `id` identifies the evidence; `type` defines its interpretation; `affected_version` pins its package content identity. A Generation contributes the parsed specification listed below, excluding body headings/formatting/unknown properties. Other evidence contributes its exact sealed `body` (receipt, approval specification, plan or environment definition). A Run additionally contributes `component` (collection policy artifact), `environment` (environment identity), and the ordered decoded metric events in its certified historical `notes`, covering both legacy and compressed segments. Ordinary note text, note authors and note timestamps are excluded. The same `generationEvidence` graph defines the citation set for card projection and loop-resume drift checks. Its configuration is already sealed in its body. `fixed_version` is excluded: the SDK clears it during a routine terminal-to-active status transition. These two fields are policy evidence for Runs only; mirror fields on a Generation and generic tracker `parent` are excluded. |
| Parsed Generation body | `base_checkpoint`, `policy`, `collection_runs`, `training_config`, `environment_version`, `reward_spec_version`, `parent`, `seed`, optional `evaluation_plan`: frozen training lineage, artifact/configuration and evaluation evidence identities. `promoted`, `approval`, `proxy_score`, `held_out_score`, `gap`, `promotion_evidence`: certified promotion outcome and its approval/evaluation citation. Approval references are canonical SDK item identities, so uppercase/short aliases preserve identity. Optional `policy_evaluation`: sealed package verdict (fixed decision, reason digest and bounded diagnostics); ordinary tracker notes never supply it. The parser defines the exact projection, so unrelated JSON properties or markdown presentation cannot affect it. |
| Generation provenance equality (`source`) | `affected_version` equals `hashJson(generationProvenance(spec))`; the provenance subset is optional `evaluation_plan`, `base_checkpoint`, `policy`, `collection_runs`, `training_config`, `environment_version`, `reward_spec_version`, `parent`, `seed`. Promotion outcomes are separate certified policy content and do not rewrite this training identity. |
| Training scope digests | Generation: entire frozen `training_config`, `environment_version`, `reward_spec_version`; collection count is derived from the pinned `collection_runs`. Recursive phase: sealed receipt `input` digest plus constant null environment/reward sentinels and zero collection count. These describe the exact experiment definition, never tracker counters. |
| Completed phase provenance | Decision `type`; receipt `format`, terminal `state`, SHA-256-shaped `input`, structured `result`, and equality of `digest` with `hashJson(result)`. The receipt creator hashes the operation's fixed input and encoded result (including content-addressed checkpoint references). Running receipts never qualify. |
| Policy digest | Generation: declared content-addressed `base_checkpoint`, `policy`, complete `training_config`. Completed phase: first declared content-addressed artifact in `checkpoint`, `candidate`, `successor`, `policy`, `retained`, `incumbent`, `digest`, paired with its nearest `recipe`, `config` or `training_config`. Opaque references and unfitted selections produce null. Configuration affects the policy; evaluation diagnostics do not. |
| Proposal digest | Entire frozen training configuration plus sealed `policy_evaluation` projection for Generations; entire certified recursive `result`, or selected member of its `configs`/`recipes` array. Selection index is validated against the certified array. None of these objects comes from tracker annotations. |
| Card digest | `format`, canonical `subject`, `selection`, `policy_digest`, `proposal_digest`, numeric/fixed-vocabulary `evaluation`, `outcome`, `training_scope`, constant `allowed_actions`, fixed-vocabulary `known_regressions`, numeric `resource_limits`, and ordered `evidence` (`id`, immutable selected `at`, domain `digest`). All are derived solely from the certified content above. Resource keys and evaluation keys are explicitly whitelisted in code. Limits come only from the subject, required parents/runs/environment/approval, and pinned shadow deployment; plans and comparison receipts cannot add allowances. |
| Citation selection and replay | Current content digest is compared with SDK-certified historical content, taking the first matching durable version. The complete compact history inventory supplies addresses only; its count is checked for completeness, never hashed or used as a version identity. SDK verification must succeed before current export; every historical read independently verifies its chain. Replay checks each cited digest, subject-first ordering, unique ids, canonical card equality and byte/citation limits. Locators identify immutable content versions, never the latest history length or `updated_at`. |
| Citation graph and plan bindings | Normalized dependency ids from the certified Generation specification; canonical project id prefix is used only for id lookup. Required parent, collection, environment, approval and optional plan must exist, with only the plan's result/shadow/comparison suffixes allowed. Plan wrapper keys must be exactly `plan,incumbent_version`; type must be Plan; plan candidate/incumbent must match Generation id/parent; plan and wrapper incumbent versions must match; the full frozen declared plan hashes to `spec.evaluation_plan`; wrapper `affected_version` hashes `{comparison,incumbent_version}`. |
| Shadow/result bindings | Decision type; shadow body `generation` equals subject; complete sealed shadow definition hashes to plan `shadow` and equals shadow `affected_version`. Paired result `comparison` equals the pinned evaluation-plan digest; shadow comparison equals the concrete pinned shadow digest. Undefined comparisons refuse. |
| Adoption and ancestry | Replay plus fresh card digest equality; Generation type, promoted outcome, non-null proxy/held-out scores, parent, collection, environment/reward identities, no known regression, numeric allowances and content-addressed policy. Every ancestor's current certified spec determines its parent; visited canonical ids prevent cycles. Each ancestor requires its retained Decision at `policy-card-<digest>`, exact canonical body and matching `affected_version`, replayed citations, and normal causal/shadow enforcement. |
| Existing causal/shadow enforcement called by adoption | Certified creation snapshots pin plan/Decision body, type, affected version, candidate/incumbent identity, incumbent training provenance, cohort/seed/protocol/stop rule, shadow deployment/consent/allowance and observation/comparison identities. Creation timestamps reconstructed from creation history establish predeclaration before candidate/run creation; current timestamps and annotations do not. Existing score and verdict comparisons consume only this sealed evaluation evidence. |
| Retained-card and batch collision checks | Decision `type`, content-addressed id, exact canonical card `body`, matching `affected_version`. Required dependency edges point to the certified subject. Batch preflight checks all selection cards before its first write. |
| Rejection reason digest | Package promotion refusal reason is hashed into the sealed `policy_evaluation.reason_digest`; raw text stays outside the card. A retry compares canonical parsed Generation bodies before writing, so it does not create another policy event. |
| Checkpoint pre-publication validation | Existing checkpoint artifact content digests, encoded operation result and fixed operation input feed the prospective completed receipt. The added callback changes validation order only, before any blob or ledger publication. No tracker metadata enters these identities. |

Excluded from every card content hash: `updated_at`, current/total history length,
comments, ordinary notes (including reserved-looking text), tags, assignee/claim/release state,
tracker status/status messages, titles, priorities, acceptance criteria and unrelated
custom fields. SDK chain verification still detects unauthorized materialized edits
to *any* tracker field; that storage-integrity check is distinct from binding a
legitimate metadata value into policy identity.

The two round-d regressions use real non-git trackers and a real successful promotion:
`routine tracker mutation` applies each mutation to the promoted subject, every direct
citation (including the seed) and the retained card, checking both fresh and retained
adoption after each operation. `policy relevant changes` changes artifact,
configuration, collection evidence, approval and sealed evaluation independently,
requiring old-card adoption to refuse, historical replay to succeed, and exact-content
restoration to recover the original digest without another card publication.

Prospective writes reserve the maximum SDK safe-integer version width for the new
subject citation. A transition from a one-digit to a two-digit history address cannot
make a preflighted card exceed its size limit after the durable policy write.

The resource whitelist is `samples`, `evaluation_samples`, `fit_steps`,
`training_steps`, `wall_ms`, `storage_bytes`, `compute_units`, `tokens`,
`active_calls`, `candidate_calls`, `generations`, `candidates`, `updates`,
`timeout_ms`, `optimizer_updates`, `max_optimizer_updates`, `fits`, `budget`;
only the nested `budget`, `allowance`, `resource_budget`, `config`, `adapter`
containers are traversed. The evaluation whitelist is `gain`, `gain_lower_bound`,
`margin`, `uncertainty`, `candidate_held_out_mean`, `incumbent_held_out_mean`,
`candidate_mean`, `incumbent_mean`, `samples`, `independent_units`, a SHA-256
`reason_digest`, and `decision` (`promote` or `refuse`); only `meta`, `verdict`,
`trial`, `outcome`, `policy_card_evaluation` containers are traversed. The whole
sealed evaluation object still participates in proposal/domain identity, so a
changed verdict cannot hide behind an unchanged numeric projection.

Round-d behavioral revert proofs retain the unchanged regression file and restore
production in `finally`, using an isolated text-only source copy and the pinned SDK:

| Production behavior reverted | Command pattern and result |
| --- | --- |
| `snapshot` restored to the pre-fix mutable timestamp selector, with its original timestamp read projection | `routine tracker mutation\|policy relevant changes`: both tests fail (2/2, exit 1). A comment changes the fresh digest (`ERR_ASSERTION`); after exact policy restoration, fresh adoption loses the retained card (`card_missing_provenance`). |
| `domain` again incorporates reserved-looking tracker evaluation notes, with its original note read projection | `routine tracker mutation`: fails 1/1, exit 1, `ERR_ASSERTION` at the reserved-looking native-note mutation. |

The restored production passes all four round-d regression scenarios through the
pinned PM snapshot runner with context `none`, timeout 600 seconds: complete history,
concurrent replacement/compaction, routine mutations and real policy changes. These
proofs supplement the earlier write-boundary proofs; no earlier gate or refusal
boundary was removed.

History enumeration uses the same `rethrowProvenanceRead` normalization as complete
item reads. Unclassified SDK backend errors remain retryable; native errors retain
their identity; only explicit absence/integrity classifications establish missing
provenance. `operational history enumeration` injects failures only after a real SDK
history read and asserts unchanged durable tracker bytes. Removing normalization
from the history read makes that regression fail with a permanent refusal instead
of the required retryable error. This preserves the earlier operational-read blocker
while adding the new certified-history selector.


## Fifth-review concurrency and shared evidence audit

The fifth review found two valid defects: metric-bearing Run notes did not enter
card citation identity, and rejection publication wrote a pre-validation body over
a peer update. GitHub returned zero review threads (no additional page), and all
20 submitted reviews contained no CodeRabbit review body. There is consequently
no unresolved thread id or outside-diff review finding to reply to or resolve.

`generationEvidence` is the only graph constructor for both card projection and
resume verification. Its certified Run snapshots include decoded metric notes;
cards with this binding replay their exact historical evidence after later changes. Cards exported before the metric-binding fix require re-export. Resume compares that same
graph against replay-verified retained cards before advancing. Interrupted outcome
publication can use a retained candidate only when its unchanged training
provenance and shared citations match the terminal outcome. A later retained
terminal outcome cannot be hidden by claiming an interrupted promotion. Routine
Run `fixed_version` changes are ignored on both paths: configuration remains bound
by the exact sealed body, and the SDK clears that lifecycle field on reopening.

| Item write path | Concurrency guard and regression |
| --- | --- |
| Generation and immutable environment/Run registration | Native SDK exclusive create; `createOrReadIdentical` verifies the real collision winner instead of updating it. |
| Rejection outcome publication | Capture current `updated_at` and body before validation; `mutateLoopItem` compares both inside SDK `mutateItem` under its native item lock. The two-writer test preserves a peer `samples=20` body and provenance, creates no card, and returns retryable `loop_write_conflict`. |
| Promotion body and lifecycle publication | Re-read and validate in the workspace transaction, then publish body, close status, close timestamp, completion timestamp and evidence in one guarded SDK item transaction. No split body/close operation or captured-body rollback exists. A peer after the read wins without being overwritten. The authoritative read refuses seed conversions, and the locked terminal mutation refuses an already-terminal candidate. |
| Promotion budget consumption | Promoted Generation provenance is the budget charge; no independent counter is written. The candidate transaction also locks the approval with the SDK native item lock and compares the revision captured by the authoritative approval read. A peer lowering capacity after that read causes conflict before consumption. Concurrent promoter budget tests still permit only the approved count. |
| Interrupted promotion close | Uses the captured current item revision and the same atomic terminal mutation. The fresh read first requires an actually promoted body; a peer before that read is preserved and causes `loop_step_drift`. A peer between read and close causes conflict, preserving its body and pending lifecycle state. |
| Immutable card publication, including recursive selections | SDK exclusive create, with content/type/version verification of an existing or concurrent winner. The collision test interleaves a peer create after the absence read and preserves the peer card while refusing `card_drift`. |
| Existing/running inner and outer phase receipts | Capture the revision before executing the operation and validate completion again in that exact revision. A peer completion between the first check and capture is honored without execution. Complete through `mutateLoopItem`; a peer during execution remains intact and causes conflict. |
| Absent/deferred phase receipts | SDK exclusive create after deterministic prospective validation; a peer creation during execution wins and is never replaced by an update. |
| Refusal and terminal comment receipts | Native SDK append with `ifAbsent: true`, performing duplicate detection under its item lock. Two writers that both read an empty comment list retain one receipt. No whole item or captured body is written. |
| Feature work documentation | Pinned repo-local PM CLI mutations, attributable to `codex-agent`; append-only item history is committed with code. |

The broader mutation matrix checks current card identity, the shared evidence
fingerprint, retained evidence verification, and actual loop resume after every
mutation. It covers every direct evidence item, type and content identities,
Generation configuration, native annotations and status, Run policy/environment,
Run lifecycle version, and both metric encodings. Evaluation Plan, result, shadow
and shadow-comparison mutations exercise both graph consumers too. All trackers
in these regressions are real SDK trackers initialized outside Git.

The SDK transaction is the storage boundary: `mutateItem` owns item locking,
canonical serialization, workflow/mutation guards, history publication and
rollback on storage failure. The package captures the expected revision before
validation/execution, checks it in the locked callback, and preserves the caller's
author. Approval dependency locks are the same SDK locks observed by ordinary
CLI and SDK peers; the controller lease alone is not treated as writer exclusion.

Revert proofs and final full-gate counts are recorded on `pm-rl-policycards`.


### Fifth-review behavioral revert receipts

Eighteen independent reverts change production behavior only in a separate
source copy. Every run exits 1 with a behavioral AssertionError. Production is
restored in `finally`; regression files stay unchanged throughout each proof:

- `test/continuation-faults.test.ts`: `ec17e98181dd36e8fabd250dab22d90bfd3702d00a9377dafb9bbab8e0ddf1cf`.
- `test/policy-card.test.ts`: `6eee08cf9e5300e8b6377c8eca17dab1539aacc800352d231a79dd7be929cfb9`.

Commands are `node --test --test-name-pattern='<pattern>' <file>`. Failed parent
wrappers are included in failed/total counts for nested scenarios.

| Removed behavior | Regression file and pattern | Failed / total |
| --- | --- | --- |
| `recovery-fresh-promotion-state` | `test/policy-card.test.ts`: `promotion, approval fresh-state` | 2 / 4 |
| `terminal-close-refusal` | `test/policy-card.test.ts`: `promotion, approval fresh-state` | 2 / 4 |
| `fresh-seed-refusal` | `test/policy-card.test.ts`: `promotion, approval fresh-state` | 2 / 4 |
| `receipt-peer-completion-state` | `test/policy-card.test.ts`: `every receipt honors` | 1 / 1 |
| `legacy-promotion-receipt-refusal` | `test/continuation-faults.test.ts`: `one paused tiny-LM` | 2 / 46 |
| `canonical-approval-alias` | `test/policy-card.test.ts`: `one generation evidence` | 1 / 1 |
| `whole-citation-set` | `test/policy-card.test.ts`: `retained generation evidence compares` | 1 / 1 |
| `metric-note-binding` | `test/policy-card.test.ts`: `one generation evidence` | 1 / 1 |
| `shared-resume-evidence` | `test/policy-card.test.ts`: `one generation evidence` | 1 / 1 |
| `rejection-old-body` | `test/policy-card.test.ts`: `rejection publication` | 1 / 1 |
| `rejection-target-revision` | `test/policy-card.test.ts`: `rejection publication` | 1 / 1 |
| `receipt-target-revision` | `test/policy-card.test.ts`: `every receipt` | 2 / 4 |
| `promotion-recovery-target-revision` | `test/policy-card.test.ts`: `promotion, approval` | 3 / 9 |
| `approval-budget-revision` | `test/policy-card.test.ts`: `promotion, approval` | 2 / 9 |
| `card-collision-verification` | `test/policy-card.test.ts`: `card creation` | 1 / 1 |
| `deferred-receipt-exclusive-create` | `test/policy-card.test.ts`: `every receipt` | 2 / 4 |
| `no-captured-promotion-compensation` | `test/policy-card.test.ts`: `promotion, approval` | 2 / 9 |
| `comment-lock-idempotency` | `test/policy-card.test.ts`: `comment receipts` | 1 / 1 |

The compensation revert restores a captured body after a real peer update at
the SDK committing transition. The deferred-create revert switches to update
only after a native create collision, preserving the real peer interleaving.
The citation-set revert misses a later optional result. The alias revert rejects
a logically identical approval identity. The legacy receipt revert permits a
completed promotion to be treated as unfinished when retained cards are absent.

Crash drills hold real SDK reads around the guarded item transaction. They keep
committed receipt histories byte-identical, recover the native owner without
extra identity fields, and verify the promotion body and closure commit together.
The native heartbeat drill retains its original 180-second bound. Trainer-specific
diagnostics run before the shared evidence comparison, preserving the detailed
decision errors and completed-promotion `loop_step_drift` contract.

## Sixth review: decoder and concurrent transition classes

All root TypeScript JSON decoders now use `tracker-record.ts`; its bounded parser
is the only root production `JSON.parse`. This includes tracker envelopes, fenced
contracts, metric notes, history events, checkpoint files and trainer channels.
Tracker discovery additionally uses `decodeTrackerRecord`: it checks the item type,
package tag or certified legacy creation identity, canonical SDK item identity,
and exact package format before parsing, rejects bodies above 1 MiB or
64 nesting levels, and records content-free omission reasons. The shared parser
also bounds other JSON inputs at 16 MiB and 64 levels. No SDK dependency pin or
coverage threshold changed.

Cards must satisfy the complete bounded field shape, citation shape, canonical
content address and version binding before joining the retained-card inventory.
New cards carry `rl-policy-card`; unrelated Decisions with a card-like id or design
tag cannot become provenance. `discoverPolicyCards` and `skippedTrackerRecords`
expose discovery and omission receipts; loop reports include `skipped_records`.
Explicitly referenced required evidence still fails with a typed domain integrity
refusal when damaged. Known owned job/budget records must never disappear from
accounting merely because their semantic fields drifted. An immutable creation
header identifies legacy owned records even after tag removal or key reordering.
Extra-prefix copies cannot inherit a reservation or job identity. Inventory jobs
are re-read from authoritative state and foreign replacements cannot append null
entries. Omission receipts are sorted and exclude unrelated ordinary records so
replayed loop reports remain stable.

Every failed promotion attempt re-reads the authoritative candidate. A verified
peer promotion advances the chain, counts once, retains its outcome card and is
attributed with `promoted_by` from its first certified promoted history version.
Existing peer refusals preserve their sealed evaluation and reason. Rejection
publication also re-reads after CAS failure and preserves either terminal winner.
A peer completion receipt is verified against the actual candidate. A controller
fenced after a committed promotion returns its error with `authoritative_report`;
it cannot publish a local terminal refusal. Low-level stale writes include the
observed authoritative revision/status in their error context.

The seeded corpus includes foreign Decision, Task and Note bodies: Markdown,
truncated JSON, primitive/array/object shape errors, oversized and deeply nested
JSON, other-package formats with the same tag, copied cards with wrong addresses,
wrong version bindings and checksum mismatches. Seeded field mutations include
correctly hashed but malformed nested envelopes, non-finite JSON numbers and
citation limits. Resume, discovery, export, promotion and adoption preserve the
valid records and expose skipped-record reasons. Shared non-git tracker tests
cover both sides of evaluate/promote/adopt boundaries, native transition refusal
codes, a peer winning during rejection publication, and a real replaced lease.

Focused commands:

- `node --test --test-name-pattern='seeded foreign tracker' test/policy-card.test.ts`
- `node --test --test-name-pattern='shared tracker loop interleavings' test/policy-card.test.ts`
- `node --test --test-name-pattern='shared tracker peer refusals|lost controller claim|rejection CAS reconciliation|promotion attribution requires|peer refusal remains|guarded tracker decoder' test/policy-card.test.ts`
- `node --test --test-name-pattern='shared inner promotion headroom|malformed completed receipts|prospective rejection notes|budget and job identity drift|seeded foreign tracker' test/meta.test.ts test/policy-card.test.ts test/process.test.ts` (5/5 pass after correcting the four affected-module sweep regressions).

Behavioral revert receipts are recorded on `pm-rl-policycards`. Each proof uses an
isolated source snapshot, changes only the production discovery function or
promotion reconciliation catch, runs the unchanged regression, and restores the
production source in `finally`. Test SHA-256: `146c0564cc09ec973d358688e850ea7e1b67a56408dbbbea79e86a93a5b8a167`.
The restored snapshot must match the package source and test bytes before its
positive regression run. Full release evidence is the CI npm and Bun matrix at
the pushed head, using the unchanged `release:check` commands and thresholds.

Final sixth-review local receipts: the restored focused suite and the pinned
PM-linked suite pass 49/49, with zero skips. The shared tracker decoder has
100% lines, branches and functions in the focused native coverage run. Class 1's
production-only revert fails 1/1 with `SyntaxError`; class 2's production-only
revert passes 4/15 and fails 11/15, including the original peer-promotion refusal
and the incorrect zero count. Both fixes were restored and the source/test bytes
verified before the positive run. Typecheck, test compilation, lint, zero
clone/duplication findings and docstrings (52 source files, 403 declarations)
pass. The full npm and Bun release matrix remains the required CI evidence.

The first sixth-review CI run exposed a missing shared module in the minimal
Compose trainer image; its explicit COPY manifest now includes the decoder. A
dependency-free Node smoke test of exactly those copied sources passes without
starting Docker on the shared host. LM crash recovery now asserts the actual
child process promotion author while retaining all existing report/evidence
comparisons. Authoritative approval-capacity refusal keeps precedence over an
already-refused candidate. These checks are included in the final focused
PM-linked command, alongside peer completion, stale refusal and failed status
lookup cases. Full npm/Bun gates and real Compose tests run in CI.

Final linked command (also run with `pm test pm-rl-policycards --run --only-index 26 --progress`):

```sh
node --test --test-name-pattern='seeded foreign tracker|shared tracker loop interleavings|shared tracker peer refusals|lost controller claim|rejection CAS reconciliation|promotion attribution requires|peer refusal remains|guarded tracker decoder|peer completion receipts|stale legacy refusal|authoritative status read failures|foreign subject types|shared inner promotion headroom|budget and job identity drift|rerunning one loop id|SIGKILL inside real LM collect|approval aliases cannot spend|malformed completed receipts|legacy rejected generations|loop receipt bindings|unsealed peer candidates|mutation callback refusals' test/policy-card.test.ts test/meta.test.ts test/process.test.ts test/lm-loop.test.ts
```

The second sixth-review CI run (40078982664) passed all 836 tests on npm
Node 22/26 and Bun Node 26, but the unchanged 100% branch gate remained at
99.97% in aggregate. The local probe located the malformed receipt refusal
path; the additional legacy test exercises evaluation absence during resume. The final tests cover every
invalid completed-receipt field and a real SDK-created pre-card snapshot with
no sealed evaluation: both controllers retain the original numerical rejection
and its reason. The snapshot preserves source histories byte-for-byte and never
rewrites or repairs existing history streams. No production behavior or
threshold was changed for this coverage completion.

CI run 40082789577 passes all 837 tests in npm Node 22/26 and Bun Node 26
jobs; policy-card coverage is now 100%, while one index branch remains. The
additional receipt matrix reaches semantic validation after the shared ownership
decoder: wrong key, input and state, every malformed payload category, foreign
Task/Note envelopes, truncated/oversized/deep JSON and a same-tag foreign format.
All 15 replacements refuse without changing the candidate evaluation. Repair
through the SDK restores one promotion, identical controller reports and valid
adoption. No production code or gate threshold was changed for this matrix.

The final pinned PM suite passes 49/49 without failures, cancellations or skips
under its unchanged 600-second command limit. The broad local LCOV diagnostic
was stopped after isolating receipt binding/payload guards and is not release
evidence. Only completed npm/Bun CI release gates certify the full package.

Pending authoritative outcomes are also explicit. Typed transition errors carry
`authoritative_candidate` with the fresh canonical id, promotion flag, bounded
evaluation enum and observed revision. A peer's removed legacy evaluation stays
pending across all six concurrent-refusal codes; unrelated native errors retain
their identity. After restoring the evaluator's evidence, the peer and original
controller report one promotion with the peer's author and matching checkpoint.

CI failure diagnostics print uncovered LCOV branch locations without changing
release commands, thresholds or failure status. The step uses GitHub's documented
[failure condition](https://docs.github.com/en/actions/reference/workflows-and-actions/expressions#failure).
The YAML parses, its shell command was checked against real LCOV data, and the
repository workflow check passes 1/1 through PM in the actual Git checkout.
That Git-dependent check is separate from the 49-case non-git snapshot suite;
a snapshot lacks the tracked-file inventory required by the publication scanner.

Exact CI diagnostics located the remaining index counter at the mutation
helper's normal-completion join. A return inside try plus unconditional throw
inside catch left that join unreachable. The helper now captures its result
before unlock and returns after finally; error identity and cleanup ordering
are preserved. All 15 raw V8 ranges in the helper are entered by three real SDK
transaction tests, including dependency conflicts and native/typed callbacks.

Every typed mutation refusal now observes current metadata, not only the
loop_write_conflict code. Failed observations attach a bounded error code while
preserving the original refusal. Native and typed observation failures retain
the candidate bytes and release dependency claims; an independent writer can
retry successfully. Narrowing only this observer back to loop_write_conflict
is independently reverted in the callback regression, in addition to the two
class-level reverts above.

## Canonical identities and recoverable publication

`canonicalizeIdentifier` in `lineage.ts` is the single tracker-reference
canonicalizer. It delegates alias, prefix and case resolution to the pinned SDK.
`canonicalizeGenerationSpec` applies it to parent, approval, environment and all
collection Runs and score Environment references **before** their first set, sort, scope count or logical digest.
Artifact/checkpoint/reward/comparison digests and cohort member labels belong to
different identity domains; they are never interpreted as tracker aliases.

The complete identity-operation audit was repeated with
`rg -n 'new Set|\.sort\(|hashJson\(|normalizeItemId'` over the card, lineage,
command and evaluation-plan modules, and with set/sort searches over the recursive
controllers, shadow module and tracker decoder. The call sites are:

| Boundary | Canonical input to identity operations |
| --- | --- |
| Generation registration | Requested id and parent resolve before creation/comparison; Run aliases resolve before deduplication, sort, provenance hashing and dependency creation. Environment lookup returns the canonical SDK id. |
| Ancestry and lineage heads | Head/parent references resolve before visited/parent sets; collection references and Run environments resolve before the Run map, contamination comparison and pure deterministic lineage sorting. Both score Environment references resolve before gap comparability, held-out contamination, sealed-request retry and pinned evaluation-context comparisons. |
| Snapshot/citation lookup | Validate identifier shape, resolve with the project prefix, then read certified current/history content. Every returned citation uses the SDK canonical id. |
| Generation domain digest | Verify the original stored provenance seal before selecting historical content. Logical body/version digests use the canonical specification, including canonical Run multiplicity and order. This preserves historical integrity checks while making alias-equivalent content stable. Run Environment references also resolve before the domain digest. |
| Source/scope/dependencies | The shared specification projection resolves references before scope environment hashes, collection counts and direct dependency sets. Reject subject/self dependencies after alias resolution. Optional Plan/result/shadow ids are derived from canonical subject/SDK identities. |
| Graph bindings and allowances | Required and allowed sets use canonical dependencies. Plan candidate/incumbent and shadow-generation comparisons use the same canonicalizer, while their original signed comparison identities remain verified. Resource iteration follows sorted canonical citations. |
| Replay | Resolve cited ids before digest/duplicate/subject checks. Reconstruct the subject-first, sorted canonical citation envelope before comparing its canonical bytes; reordered or duplicate envelopes cannot acquire another portable identity. |
| Retained cards, ancestry and batches | Canonical subject/SDK card identities precede retained filters, ancestry visited sets, evidence maps, candidate-to-terminal provenance comparisons and immutable card collision checks. |
| Other set/sort/hash domains | Resource/JSON keys sort as keys; evaluation cohort ids/units use the evaluation parser's bounded label normalization; shadow member names use its manifest label domain; checkpoint/proposal rankings use content digests; skipped-record ids originate from SDK inventory. No tracker alias set is built from opaque source-body ids. |

The seeded property exercises **512 cards**, 128 for each seed `0x100`, `0x5eed`,
`0xc0ffee`, `0x7fffffff`. It mixes short/qualified aliases, mixed case, duplicate
and reordered Runs (including more than 32 raw aliases), varying resources and
unrelated malformed/foreign tracker records. Every export replays; its replayed
card and a fresh export are byte-identical canonical JSON. Rewriting only alias
spelling/order/multiplicity preserves card identity. Separate regressions reject
self citations and reordered portable envelopes.

### Durable markers and first-incomplete-step recovery

There is no detached in-memory "done" flag. Each step has an existing durable
domain record that the public retry/resume path verifies:

| Path | Idempotent steps and durable markers |
| --- | --- |
| Register | Nine byte-idempotent SDK schema declarations; immutable Generation create-or-read-identical; immutable card publication. A retry checks each declaration/source before completing missing publication. |
| Manual promote | Atomic guarded SDK Generation body+closure with sealed approval, scores and evidence; immutable promoted card. An identical request resumes from the committed Generation and publishes the missing card, without another promotion mutation or budget charge. Different approvals, scores or evidence still refuse as already promoted. |
| Evaluate/recursive phase | Completed, input-bound loop-step receipt followed by shared and selected immutable cards. A complete receipt skips evaluation and publishes any missing suffix of cards. |
| Reject | Guarded sealed Generation evaluation followed by its immutable refusal card. A retained refusal keeps the original reason and finishes publication. |
| Publish | Preflight every bounded projection/collision, then create-or-read-identical the shared card and each selection. The completed source is the batch marker; each immutable Decision marks a completed publication step. |
| Export, replay, adopt | Read-only certified operations, without a durable write or transaction marker. Retrying repeats the certification. Adoption succeeds after a publication retry repairs the retained outcome; it does not silently create authority. |

`test/policy-card-recovery-worker.ts` injects **EIO, ENOSPC and actual SIGKILL**
at all **48 logical boundaries** (144 fault cases):

- Register: before/after each of the nine schema declarations, Generation create
  and card create (22 boundaries).
- Promote and reject: before/after the atomic Generation seal and card create
  (four boundaries each).
- Evaluate: before/after the completed receipt and each of its three cards
  (eight boundaries).
- Recursive publish: before/after each of three cards (six boundaries).
- Read-only export and adoption: before/after certification (two each).

Each case clones the same real non-git baseline, verifies the precise injection
point was reached, retries, and compares all domain bodies, ids, types, statuses,
provenance/dependencies, component/environment fields, certified item-history
operation counts, and exact settings/schema bytes against the fault-free run.
A second retry must leave that complete projection unchanged. Positive outcomes
must remain adoptable and refusals must retain their original verdict. Clock
fields, SDK read-usage observations, renewable locks and transaction-attempt
journals are intentionally outside this equality: failed attempts can retain
operational diagnostics, and separate executions have different clocks. This is
domain-state equivalence, not a claim of byte-identical attempt journals.

The pinned extension test harness returns `null` for some injected native command
failures; typed provenance read retries propagate. The tests verify either
failure channel plus the durable boundary-hit receipt, then require the same
successful public retry. SIGKILL runs in a child process and bypasses cleanup;
normal SDK stale-lock recovery is exercised without deleting locks in the test.

### Independent behavioral reverts

Both proofs use a disposable text-source copy and the unchanged pinned SDK.
Only production behavior is reverted, and each source is restored in `finally`.
The unchanged regression file SHA-256 is
`171b3e13b3df8d5a42b0f4d16d59c1f83910b1305915c6ea38d016899583a285`.

- Canonical class: revert only `canonicalizeGenerationSpec` to return the original
  references; run `node --test --test-name-pattern='canonical card property'
  test/policy-card.test.ts`. The generated alias corpus fails 1/1 with
  `card_missing_provenance`; the normalizer is restored.
- Recovery class: revert only the manual handler's committed-state resume branch
  to its original `already_promoted` refusal; run `node --test
  --test-name-pattern='manual promotion post-commit retry'
  test/policy-card.test.ts`. Publication fails after the real promotion commit;
  the retry fails 1/1 with `already_promoted`. The resume branch is restored.

The restored focused self-citation/order and post-commit publication suite passes
3/3, including identical retries with Environment aliases in both scores. The larger fault matrix and mismatch test pass 146/146; the canonical property
passes 512 generated cases. Full npm/Node and Bun release/coverage evidence is
provided by the unchanged CI release gate for the pushed head.


The pinned PM snapshot runner also passes the property/fault/mismatch command
147/147 with zero failures, cancellations or skips. The focused graph and
post-commit command passes 2/2 through that runner. A final source pass adds score
Environment alias equivalence to the sealed-request regression; the corresponding
focused suite passes 3/3. Local typecheck, source/test compilation, lint,
duplication, docstring, identity and changelog checks pass without changing pins
or coverage thresholds.

Snapshot exhaustion after concurrent replacement/compaction explicitly reports
`card_missing_provenance`; an invalid requested current/history provenance seal
remains `card_drift`. The original history-compaction/current-drift regression
suite passes 3/3 through the pinned PM snapshot runner after this distinction is
preserved.

`verifiedGenerationSpec` is the shared raw-seal verifier for requested snapshots
and prospective sources. The snapshot, prospective refusal, canonical graph and
manual retry suite passes 7/7 through PM after consolidation; both production-only
class reverts still fail 1/1 with the same unchanged regression file hash.
