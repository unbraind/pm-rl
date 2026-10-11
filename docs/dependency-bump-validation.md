# Dependency bump contracts

Benchmark validation requests `get({ full: true })` through `getTypedItem`.
`depth: "deep"` is a presentation projection: PM CLI 2026.10.6 omits
dependency provenance, including `source_kind`, from that view. Storage and
the dependency parser still preserve those fields. Using the projection for
benchmark contamination validation falsely rejects valid records; accepting
missing roles would instead hide corruption. Complete reads preserve the
existing content identity, contamination and evaluation graph checks. Other
typed reads retain the deep body view without unnecessary full-read rollups.

The prepare hook resolves `pm-ops/merge-driver/prepare` and executes the
installed package's `templates/prepare-merge-driver.ts` as typed module input.
This avoids Node's prohibition on stripping TypeScript inside `node_modules`
and makes the dependency own its canonical installer policy. Dependency
upgrades require no copied template edits. Missing pm-ops still permits an
omit-dev install; an installed package with missing exports, template or
installer fails. Installer exit codes and signal failures remain failures.

Regression tests use real disposable trackers and the public SDK. A valid
contaminated benchmark can be registered repeatedly; a forged contamination
role is refused. Existing cases also refuse missing and ambiguous evaluation
edges, environment drift, content identity drift and contamination. Prepare
tests exercise the real installer, an independently updated template, missing
templates, broken packages and child failures.

The release gate retains all four 100% thresholds and discovers authored
TypeScript from the repository root, including operational scripts. Validation
receipts, dependency scenario SHAs and behavioral revert results are recorded
in [pm-rl-hncb](../.agents/pm/chores/pm-rl-hncb.toon).
