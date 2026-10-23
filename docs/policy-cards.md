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

The host renders compact TOON by default and JSON with `--json`. Export and replay read trackers without mutations. Each card is capped at 4 KiB and 32 direct evidence citations; overflow refuses rather than hiding citations. Tracker identifiers and timestamps are the only copied source strings. Training configurations, policy parameters, example text, titles, credentials, raw outcomes and free-text diagnostic messages stay in their original stores. Their domain contents contribute SHA-256 digests. Do not treat a hash as anonymization of low-entropy data, or publish the underlying tracker without a separate privacy review.

Each card includes a candidate digest, training-scope digest, collection count, environment and reward digests, permitted explanation actions (`inspect`, `evaluate`), numeric resource declarations, fixed regression categories, bounded numeric evaluation diagnostics and evidence locators. Unknown evaluation remains `evaluation_incomplete`; an unpromoted candidate cannot pass adoption checks. Resource declarations describe the original experiment; another backend must supply its own consent and enforce its own budget.

## Recursive coverage

Generation registration records evaluation diagnostics in native SDK notes, leaving replay-critical trainer configuration unchanged. It records the candidate card before promotion; promotion retains a new outcome card. Earlier cards stay unchanged and replay against verified history. The durable inner/outer controller records every completed recursive phase and each member of a proposed recipe/configuration batch. This covers learner trials, improver updates, causal selection outcomes, retained/rejected generations and outcome-ledger receipts. A later improver can enumerate the SDK's complete Decision inventory, select `pm-rl/policy-card/1` bodies and replay their citations before using earlier diagnostics. Checkpoint artifacts continue to own executable state. If card publication is interrupted after a committed promotion, restore storage and run the normal loop resume command; it repairs the explanation before advancing. Publication failures remain retryable operational errors.

Generation cards cite parents, collection runs, environments and promotion approvals. When present, they also cite the causal evaluation plan, paired result, shadow deployment and shadow comparison. Existing causal and shadow gates run again on adoption checks. The card does not relax those gates or claim that a single tracker proves transfer to another population.

## SDK

```ts
import { PmClient } from '@unbrained/pm-cli/sdk/core';
import { exportPolicyCard, replayPolicyCard, adoptPolicyCard } from 'pm-rl';

const client = new PmClient({ pmRoot: '.agents/pm', noExtensions: true });
const card = await exportPolicyCard(client, 'rl-programme-g1');
const replay = await replayPolicyCard(client, card);
console.log(replay.results); // Every cited id, timestamp and verified digest.
await adoptPolicyCard(client, card); // Suitability check; no adoption side effects.
```

`PolicyCard`, `PolicyCardEvidence` and `PolicyCardRefusal` are exported types. Refusals are expected SDK errors (conflict exit 4) with stable `context.code` and a remedy in the message:

| Code | Remedy |
| --- | --- |
| `card_missing_provenance` | Restore the original source and every cited history; complete provenance before adoption. |
| `card_invalid` | Supply an unwrapped card or a valid subject/proposal index. |
| `card_drift` | Restore the exact evidence or export a new card after the legitimate change. |
| `card_limit` | Split the experiment into bounded candidates; never remove evidence to fit. |
| `card_not_adoptable` | Keep the incumbent; complete evaluation, limits and normal promotion gates. |

Replay reconstructs the minimized explanation from certified historical records; rehashing a forged card does not validate its facts. Adoption additionally compares with a fresh export, requires a promoted Generation with complete provenance and explicit numeric limits, and invokes existing causal/shadow enforcement. A missing history, result or source never becomes an empty successful explanation. Historical replay is not a statement that the policy remains suitable today.

## Without git

Export, replay, adoption checks and automatic recursive cards work in plain-directory trackers without a Git executable. Git-backed public-history dataset construction keeps its existing provenance requirements; cards add no Git subprocesses.

The [example card](../examples/policy-card.json) comes from the validation tracker; replay also requires its cited histories.

The public-copy validation script is `test/policy-card.acceptance.ts`; aggregate measurements are in [policy-card-evidence.json](policy-card-evidence.json). It reads a permission-protected public tracker snapshot, trains two recursive generations, verifies retained candidate/promoted cards, exercises packed CLI TOON/JSON/replay/adoption, and checks every source byte remains unchanged. This is finite-snapshot recognition evidence, not a claim of general intelligence or statistically powered proposer transfer.

The measured sampled policy means are 0.59765 and 0.685825; the always-closed majority baseline is 36/41 (0.8780487804878049). The receipt keeps this limitation explicit alongside the successful provenance and lifecycle checks.
