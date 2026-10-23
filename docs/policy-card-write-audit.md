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
| Promotion body update, close, item history and approval budget | `promoteGenerationCore` validates the complete promoted body, approval citation and allowance before opening its transaction journal, then revalidates under the authoritative writer lock before update/close. `prospective promoted card overflow` checks two refusals against all durable tracker bytes, then consumes the unchanged one-unit budget successfully. No separate counter is written: promoted Generation provenance determines budget consumption. |
| Promotion transaction journals and compensation receipts | The pre-journal validation precedes `commitWorkspaceTransaction`. The promotion refusal snapshot includes runtime transaction journals, so a compensated transaction with otherwise restored domain fields would still fail. The in-lock validation remains necessary for concurrent changes. |
| Immutable policy-card Decisions, dependency edges and their histories | `recordPolicyCard` exports and validates before creating anything. `recordRecursivePolicyCards` computes every projection and checks every known card collision before the first batch write. `recursive card batch refuses collision` checks body, type and identity collisions on a later selection and direct oversized publication without partial shared-card publication. |
| Sealed rejection outcomes, rejection comments and their histories | `recordRefusedPolicyCard` validates the prospective Generation body before an idempotent body update and card publication. Callers append bookkeeping comments afterwards. `prospective rejection notes` invokes the real rejection writer and requires a byte-identical durable tracker after refusal. |
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
| Citation domain digest (`domain`, `snapshot`, prospective writes) | Canonical item `id` identifies the evidence; `type` defines its interpretation; `affected_version` pins its package content identity. A Generation contributes the parsed specification listed below, excluding body headings/formatting/unknown properties. Other evidence contributes its exact sealed `body` (receipt, approval specification, plan or environment definition). A Run additionally contributes `component` (collection policy artifact) and `environment` (environment identity). Its configuration is already sealed in its body. `fixed_version` is excluded: the SDK clears it during a routine terminal-to-active status transition. These two fields are policy evidence for Runs only; mirror fields on a Generation and generic tracker `parent` are excluded. |
| Parsed Generation body | `base_checkpoint`, `policy`, `collection_runs`, `training_config`, `environment_version`, `reward_spec_version`, `parent`, `seed`, optional `evaluation_plan`: frozen training lineage, artifact/configuration and evaluation evidence identities. `promoted`, `approval`, `proxy_score`, `held_out_score`, `gap`, `promotion_evidence`: certified promotion outcome and its approval/evaluation citation. Optional `policy_evaluation`: sealed package verdict (fixed decision, reason digest and bounded diagnostics); ordinary tracker notes never supply it. The parser defines the exact projection, so unrelated JSON properties or markdown presentation cannot affect it. |
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
comments, notes (including reserved-looking text), tags, assignee/claim/release state,
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
