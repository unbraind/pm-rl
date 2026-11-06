# Bounded proposal-program evolution

`pm rl proposer run` evolves a small executable proposal algorithm. The original
`rl meta run` changes recipe values, and `rl improver run` updates priors on fixed
arms. A proposer program instead changes a scoring expression, its selection
operation, feature construction and the training curriculum. It is an interpreted
capability grammar, never JavaScript, shell, a plugin or another trainer.

```sh
pm rl proposer validate --file examples/proposer-program.json --json
pm rl proposer run experiment --file examples/proposer-program.json \
  --dataset sealed-improver-data --approval resource-decision --json
```

Create the resource Decision first using the existing process and meta-search
approval contracts (`resource_budget`, `meta_budget`, and `permitted_promotions`).
The shared meta reservation ledger holds worst-case optimizer samples, proposal
process calls, outer promotions and inner/outer promotion headroom before work;
concurrent searches cannot each spend the same approved capacity.
`permitted_promotions` must cover `fits + config.generations` in addition to
capacity already consumed or reserved under that Decision, where
`fits = config.candidates * (config.generations * (development.tasks + 2 * meta.tasks) + 2 * audit.tasks)`.
The proposer run consumes this shared promotion headroom for its inner fits and
outer generations. Its conservative reservation remains held after completion,
refusal, interruption and replay; the search never refunds it.
The `resource_budget` must also cover two process attempts per fit plus all
`3 * config.generations + 2` proposal interpreters, in every resource dimension.
Preflight includes existing charges for the same Decision and the remaining
worst-case allowance. On resume, each retained programme slot replaces its planned
allowance with its recorded charge exactly once; unrelated jobs remain charged.
An undersized declaration refuses before the controller lease or any jobs.
Supply a frozen dataset from `rl improver build` with disjoint development, meta
and audit trackers. The existing public-history builder requires committed public
Git provenance. Executing a sealed dataset requires no Git repository or executable.
The example bounds two generations, two proposals per task, and 64 optimizer
updates per fit; the configuration is sealed on first execution. Retrying the
same programme resumes verified receipts. Changing its declaration requires a
new programme identity. An expired original deadline cannot be replenished by retry.

```ts
import {
  proposerEvolutionConfiguration, runProposerEvolution,
  initialProposer, proposerArtifact,
} from "pm-rl";

const initial = initialProposer();
const alternate = proposerArtifact({
  ...initial.code,
  score: { op: "add", left: { op: "rate" }, right: { op: "novelty" } },
  select: "rank",
  feature: "events",
  order: 3,
  curriculum: "balanced",
});
// client is the host-injected PmClient. Coordinates identify its existing tracker.
const report = await runProposerEvolution(client, coordinates, {
  id: "experiment", approval: "resource-decision", dataset: "sealed-improver-data",
  config: { ...proposerEvolutionConfiguration(), initial: alternate },
});
console.log(report.retained.digest, report.rollback);
```

The version-one grammar admits `zero`, empirical promotion `rate`, and `novelty`
(`1 / (trials + 1)`), combined by `add` or `multiply`. Its maximum depth is four
(at most fifteen expression nodes). Selection is cyclic or descending exact
rational rank, with seeded deterministic ties. Feature operations preserve an
arm's mask or select events, words or timing, with ngram order 1–3. Curricula are
seeded order, reverse order or training-label interleaving. Unknown keys, sparse
arrays, nonfinite values and out-of-domain counts refuse before effects. Exactly
eight recipe-arm counts are accepted, each with at most one million trials.
There are at most eight proposals, four recursive generations, 512 updates per
fit and 10,000 tasks in each dataset compartment.

Mutation consumes only actual development promotion counts. With complete arm
coverage it ranks empirical rates; with incomplete coverage it adds novelty.
The selected feature family and curriculum change with that development evidence.
This deliberately small mutation operator is not an unrestricted program synthesizer.
Every artifact binds its code, generation and parent to a SHA-256 identity.
Changing ancestry alone cannot pass; both executable code and emitted instructions
must differ, and both statistical levels must still accept measured improvement.

Controller resume revalidates each completed proposal against the expected job,
approval, reservation, checkpoint bytes, completion receipt and measured resource
charge before consuming cached instructions. A cached result must equal the
verified execution. Learner fits in both RSI controllers use the same evaluator
on fresh execution and replay, checking retained checkpoint, scores, promotion
state and recovery-attempt charges. Damaged or stale evidence produces a typed
refusal before dependent work; replay never replaces a missing completed job or
launches a recovery attempt. Unchanged evidence resumes without new charges.

Every proposal interpreter runs in a separate Node process under the existing
process reservation and recovery APIs. It inherits no environment credentials,
receives only development counts and a safe identity, and has no filesystem
write, child-process or evaluation-data capability. Its read permission includes only
the packaged interpreter, worker, canonical identity and launcher files, the
`package.json` and `../package.json` manifests relative to the worker module,
and the job staging directory (the child working directory); it does
not load the host SDK or dependencies. The grammar contains no IO instruction. The
worker has a 96 MiB V8 heap limit, 30-second wall allowance and bounded output.
The parent independently replays the interpreter, then writes and fsyncs the
checkpoint and receipt before publishing the existing process state transition.
Candidates never choose a launcher, dataset path, evaluation criterion or resource
allowance.

Each contender receives exactly the same number of proposal slots and learner
optimizer updates, starting from the same constant learner. Proposal execution
uses zero optimizer updates and zero inference tokens. Lost-fit recovery remains
bounded by the existing two-attempt contract; its extra optimizer work is counted,
and unequal actual contender work refuses promotion. The report includes the base
and maximum optimizer allowances. Every job is also charged through the existing
resource Decision, independently of these logical comparison budgets.

The controller freezes paired plans before evaluation, uses tracker correlation
units, protects each task target with at least ten independent units and zero
empirical regression, and divides the 0.05 error budget across planned fits and
comparisons. The existing inner promotion gate and overfit limit remain active.
Cross-compartment item contamination refuses before the controller starts.
The final audit is opened for evaluation after all selection generations. A failed
audit restores the prior content-addressed program, including insufficient audit
evidence; it never deletes candidate artifacts, jobs, reservations or audit receipts.

Default TOON and JSON CLI results are compact: retained identity, generation
decisions, audit outcome and logical budget. Full typed reports and durable
step/process receipts retain the detailed evidence. `ProposerRefusal` carries
`proposer_invalid` and a remedy; runtime refusals include `proposer_capability`,
`proposer_contamination`, `proposer_cohort_limit`, `proposer_budget`,
`proposer_approval`, `proposer_drift` and `proposer_dataset_invalid`. Untyped
replay, JSON and read failures while verifying retained proposal completions
become `process_checkpoint_invalid`, with instructions to restore the original
files and staging access. Untyped staging setup failures retain settled job
evidence and give a `process_callback_failed` remedy. Untyped approval or
retained-capacity verification failures become `proposer_approval`, with
instructions to inspect and restore the original Decision and capacity receipts.
Existing typed process and controller refusals retain their codes and recovery
instructions, including `process_receipt_required` for a missing completion.
Foreign records are skipped by existing process discovery; an occupied requested identity refuses reuse.

No tracker import/export/sync format is introduced. Program JSON round trips use
the same strict producer/parser, and durable tracker state remains entirely owned
by the pm SDK. The seeded model test includes 500 sequences, older-input replay,
whitespace and CRLF, native relationships, custom statuses and ambient focus.
All 500 sequences retain native SDK replay and both read-back assertions. The
test draws inputs in the original seed order, then groups visits by the eight
controller identities to reuse each lease and one small real tracker per
identity group (62 or 63 sequences each). At most two independent identity
groups run concurrently in the same test process, using the normal SDK
per-action lifecycle and live tracker reads. Its 600-second limit is unchanged;
it asserts 2,000 program operations, 500 native replays, 1,000 read-back checks,
20 native mutations, eight real native trackers and eight controller sessions. Separate controller-resume
regressions retain interruption and lease-reacquisition coverage.

The positive control promotes actual arm selection 0 → 2 → 4 in two recursive
generations using four isolated processes and 256 independent synthetic task
units per generation. It separately checks metadata-only refusal and audit
restoration. This establishes the mechanism, not general learning efficacy.
[Public validation](proposer-public-evidence.json) reads 123 items from a read-only
non-git copy of public `unbraind/pm-rl` commit
`98065ea55cc36a3edefc6988143def9a4f12ed15`, deriving terminal roles through the SDK.
It verifies changed instructions, two real process receipts, zero extra jobs on
replay and an unchanged source fingerprint. It makes no held-out quality claim;
powered transfer evaluation remains tracked separately in `pm-rl-rsipower`.
