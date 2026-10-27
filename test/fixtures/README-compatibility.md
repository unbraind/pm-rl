# Published version-1 compatibility oracle

`released-compatibility.json` contains portable text files and SDK snapshots
written by the published `pm-rl@2026.7.31` archive. Its registry integrity is
recorded in `producer.integrity`. No runtime cache, lock, transaction, archive or
binary is checked in. The fixture includes schema files because SDK reads must
resolve the original configured types and status roles.

The published writer registers fixed plans containing all 16 legacy label forms,
including spaces, colons, Unicode, separators, dot segments, NUL and long text.
It also writes a 201-byte native seed ID, a long fixed-plan ID and a long result
ID that the former 200-byte read restriction rejected. Ordinary generation
records retain the published whitespace behavior for parents, collections,
approval references and checkpoint/policy labels. A benchmark and EvalResult
exercise immutable-command retries with legacy checkpoint text.

`compatibility-inputs.ts` constructs raw inputs without normalizing outputs.
`released-compatibility-writer.ts` calls the published parsers, canonicalizers and
evaluator for 500 generated cases across 13 paths and records their hashes as the
reference model. Current tests compare those hashes directly, and read the
portable native files back through the real SDK. Expected normalization is never
implemented by the tests. Native fixtures read, evaluate, retry and promote
through both SDK and CLI; source item fields and seals are checked unchanged.

To regenerate, unpack the exact published archive into a scratch consumer, make
the repo-pinned SDK available there, and copy the writer with its static
`../../<module>.ts` imports redirected to that archive's `dist/<module>.js` files.
Keep `compatibility-inputs.ts` as the shared raw input factory. Execute the copied
writer with a fresh non-git tracker directory and the fixture JSON output path.
Verify the archive integrity and scan generated text for private paths before
committing. Do not replace the published runtime with the working-tree module.

Targeted checks:

```sh
node --test --test-concurrency=1 test/evaluation-compatibility.test.ts
node --test --test-concurrency=1 test/state-boundary.test.ts
```

The existing must-refuse corpus remains enforced under explicit `"write"`
validation. The paired must-allow corpus exercises the released default read
contract. A padded stored approval must consume its budget rather than becoming
uncountable or granting another promotion. Unsafe SDK/path operations name their
value and preserve an external expired-lock tripwire.

The packed-consumer acceptance runner takes the archive and output evidence:

```sh
node test/evaluation-compatibility.acceptance.ts package.tgz evidence.json
bun test/evaluation-compatibility.acceptance.ts package.tgz evidence.json
```

It installs the archive into the native fixture tracker, removes Git from PATH,
and exercises JSON/TOON reads, evaluation, old declaration/benchmark/EvalResult
retries, promotion and policy-card export. Revert receipts and exact commands
are recorded in `pm-rl-sequential`.
