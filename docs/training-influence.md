# Measured training-slice influence

`pm rl influence run --file examples/training-influence.json --json` retrains the built-in bandit learner from the same exact initial checkpoint and seed for a baseline and each declared training intervention. A slice weight of zero omits its members; weights 2–4 repeat members in the collector's schedule. Each intervention starts from the baseline's **initial** checkpoint, not the preceding intervention. The existing REINFORCE kernel fits only sampled training rewards. Scalar and bounded vector observations are supported; other learners and class-balanced sampling are outside this schema.

The compact result names each evaluation's change in expected reward relative to the retrained baseline. Arrays follow declaration order. All results are **associations**, even when complete: no causal identification, uncertainty interval, significance, global importance ranking or promotion authority is inferred. Evaluation sets can overlap each other; training and held-out identities and exact observation content must be disjoint. Renaming a held-out observation or changing its reward does not admit it to training. Near duplicates and correlated observations remain the caller's responsibility.

## Explicit bounds

One strict versioned request schema serves the SDK, CLI, persistence and replay. Unknown fields, sparse arrays and nonfinite numbers refuse before fitting or writing. IDs use lowercase letters, digits and hyphens, up to 128 characters. Each dataset has 1–2,048 examples. Features are in [-1,1], optional vectors have 1–64 entries with identical dimensions, and two action rewards are in [0,1]. There are 1–16 slices and 1–8 evaluations with distinct names and unique, nonempty members. An omission cannot remove all training rows.

The seed is uint32; initial weight is [-20,20]; learning rate is [0.01,1]; each fit collects 1–10,000 samples and performs 1–256 optimizer updates. Budgets allow 0–17 fits, 0–100,000 collected training samples, and 0–4,352 updates. The baseline costs one fit. The declared fit/sample/update work product is capped at one million sample-updates; request bytes are capped at 512 KiB and retained envelopes at 1 MiB. Evaluation scores are finite in [0,1] and deltas in [-1,1]. Budget decisions compare exact integer counts.

The first exhausted budget stops further experiments. A zero budget produces no baseline and explicit omissions; a partly completed run retains its baseline and completed experiments with `complete:false` and `ranking:null`. This allowance is **per invocation**, not a shared account or an approval to run indefinitely. Deterministic replay performs the same bounded numerical work as a new invocation; it is verification work, not a free cached computation.

## SDK and recursive feedback

```ts
import {
  recordTrainingInfluence, readTrainingInfluence, attachTrainingInfluence,
  runRlLoop,
} from "pm-rl";

const measured = await recordTrainingInfluence(client, experiment);
const replayed = await readTrainingInfluence(client, measured.id);
const proposal = await attachTrainingInfluence(client, nextProgramme, measured.id);
await runRlLoop(client, coordinates, {
  id: "next-round", approval: approvalId, config: proposal,
});
```

`measureTrainingInfluence` is the pure SDK operation. `parseTrainingInfluence` admits requests; `replayTrainingInfluence` validates a report by reproducing its producer, including exact parameters and collection identities. `summarizeTrainingInfluence` projects an already validated producer result. `readTrainingInfluence` replays one named native Decision through SDK-certified history; the full record contains the request and every exact checkpoint. `pm rl influence show <report>` returns the compact packet in TOON or JSON.

`pm rl influence propose <report> --file next-programme.json --output evidenced-programme.json` attaches the compact evidence to the proposal. SDK callers use `attachTrainingInfluence`. The proposal must use the same ordered training and evaluation datasets; learner knobs may change. The next recursive round verifies the certified historical citation before starting, seals it into the programme identity, and retains it in every candidate's training configuration. The proposer can use measured movements as evidence; **no slice is automatically selected or ranked**. Existing propose → evaluate → gate → promote → learn behavior and budgets stay in force. Partial evidence is also carried forward honestly.

## Persistence and concurrent writers

Reports use immutable content-addressed native Decisions. Native identities use SDK normalization against the configured project prefix, including prefixes that overlap the report name. Reports explicitly unset relationship/scope defaults and clear dependencies.

There is no mutable experiment checkpoint, outbox, shared budget, journaled replay plan or new lease. Retry reads the current target and uses the SDK's native create collision handling; it never replays updates from saved input. A current record with different content or provenance refuses rather than overwriting it. Peers creating the same record return the winner and `created:false`.

Before returning a successful write, the package re-reads the current item through the SDK and refuses if its native Decision type, ownership tag, content or provenance changed. The same ownership predicate governs write read-back and report consumers. All package create paths also compare the immutable native envelope with its SDK-read birth revision, including relationships, before accepting the write. Mutable title/status annotations remain admissible. Ordinary SDK/CLI writers are **not** isolated by `commitWorkspaceTransaction`. An ordinary writer can still edit a record after the final read; returned results describe the observed revision. Compact history presentation may be oldest-first or newest-first across supported hosts; the package validates and orders durable SDK coordinates explicitly for influence reads, policy citations and promotion attribution. A historical replay is checked separately from the current native ownership envelope. Proposal citations bind a certified historical revision, so an edit or ABA restoration cannot rebind evidence to another revision. No peer-owned data is deleted or compensated. Named foreign records refuse with `influence_foreign`; this feature does not discover or parse unrelated records.

Refusals provide remedies: `influence_invalid` requires a corrected bounded request; `influence_overlap` requires disjoint datasets or a matching proposal scope; `influence_foreign` requires an owned report or fresh identity; `influence_drift` requires restored certified history or a fresh report. `influence_output_exists` requires a fresh output filename, and `influence_output_unavailable` requires an accessible output directory. Native SDK history, storage and operational errors retain their own codes. Previously persisted records in other schemas are unaffected.

## Without git

Measurement, report read/replay and proposal feedback work in plain directories and through an injected SDK client. They execute no Git command. Public-history dataset builders still require their existing committed-source provenance.

## Reproduction evidence

[Public-copy measurements](training-influence-evidence.json) cover 162 public pm-ops items (116 training, 46 held out), four fits, 2,048 samples, 32 updates and two normally gated recursive promotions that replay on resume. The fixed-seed overall expected-reward movements are +0.004185111930395058, -0.003866597213557754 and -0.0010403833570880039. The read-only copy's 332-file fingerprint stayed unchanged. These are finite-snapshot associations, not generalization claims.

The repository includes standalone reproduction runners:

```sh
node test/training-influence.acceptance.ts public-copy/.agents/pm ba05bb8b96b313b86d25896ef40880712f295881 docs/training-influence-evidence.json
node test/training-influence.revert.ts
node test/training-influence.packed.ts artifacts/pm-rl-2026.10.28.tgz docs/training-influence-packed.json
```

Supply a read-only archive of the named public commit and a captured package tarball; neither input is modified. The [behavioral revert](https://github.com/unbraind/pm-rl/blob/main/docs/training-influence-revert.json) disables slice effects only in a disposable copy and proves the movement regression fails. [Packed acceptance](https://github.com/unbraind/pm-rl/blob/main/docs/training-influence-packed.json) covers npm global, Bun global, npx, bunx and project-local host acquisition, retry, compact output, proposal feedback and partial-budget reporting with Git absent. The seeded native-state model exercises 500 operation sequences with old-input replays, JSON whitespace/CRLF transports, native annotations, relationships, custom active statuses and ambient focus. Interleaving tests inject a real competing SDK writer at every native read/write boundary of report creation and feedback.

Interrupted publication elsewhere in the package follows the same ownership rule.
Sweep plans retain all committed Runs and any committed Sweep, even if native
creation succeeded and verification failed. Process jobs retain current state and
held budget. Both report `superseded` with a reconciliation remedy; the package
never treats a failed acknowledgement as proof that no record was published.
There is no automatic deletion or reverse write to race ordinary SDK/CLI peers.
