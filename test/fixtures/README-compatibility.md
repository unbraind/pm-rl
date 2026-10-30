# Published compatibility oracle

Part 1 of the [#107 split](https://github.com/unbraind/pm-rl/pull/107).
The native JSON fixtures and authoring drivers are copied verbatim from that
branch. No runtime behavior changes are included.

`released-compatibility.json` was written by `pm-rl@2026.7.31`; its exact registry
integrity is recorded in `producer.integrity`. It contains 66 native text files,
30 SDK snapshots, 18 fixed Plans and 500 generated cases across 13 parser,
canonicalizer and evaluator paths. Legacy label forms include whitespace,
Unicode, separators, dot segments, NUL and long text, including a 201-byte ID.
The tests compare published hashes and actual SDK read-back, without a second
normalization model. SDK and CLI retries, fixed evaluation and promotion work
in ordinary temporary trackers outside Git.

To regenerate, verify and unpack that exact published archive into a scratch
consumer with the pinned SDK. Copy `released-compatibility-writer.ts` and
`compatibility-inputs.ts`, redirect the static package imports to the archive's
`dist/*.js`, then run the writer with a fresh tracker and output JSON path.
Keep the published runtime independent of the implementation under test.
Scan generated text for private content before committing.

`main-controller-compatibility.ts` authors 15 completed, interrupted and running
controller/loop cases with main's public APIs under three ID prefixes. Its
`write`, `exercise`, `cards` and process modes support later compatibility work.
Run it against an isolated main checkout with the pinned dependencies and
preserve native timestamps when copying its output.

`main-process-clocks.json` preserves actual main API/SDK output from Node 24.19.0
and Bun 1.3.5. The same timestamp produced 31 ms and 30 ms charges. The
`processes-capture` and `processes-reclock` driver modes author those outputs.
Cross-clock acceptance, sequential protocol, decision provenance and identity
validation changes remain in #107. Long-ID promotion also remains there: main
can read the fixture, but its transaction filename exceeds the filesystem limit.

Source checks:

```sh
node --test --test-concurrency=2 test/evaluation-compatibility.test.ts
```

Packed acceptance takes a validated archive and a local evidence destination:

```sh
node test/evaluation-compatibility.acceptance.ts package.tgz evidence.json
bun test/evaluation-compatibility.acceptance.ts package.tgz evidence.json
```

The archive is installed into the verbatim native tracker. Git is removed from
PATH for JSON/TOON reads, fixed evaluation, retries, promotion and card export.
The new declaration restrictions and dependent regressions stay on #107.
