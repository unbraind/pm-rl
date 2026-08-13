# Changelog

## Unreleased

### Added

- pm rl lineage: the generation chain with each hop's promotion evidence and the invalidation frontier ([pm-rl-32a9](https://github.com/unbraind/pm-rl/blob/main/.agents/pm/features/pm-rl-32a9.toon))
- The proxy-to-held-out gap is the reward-hacking signal, measured per generation and trended across the chain ([pm-rl-zav1](https://github.com/unbraind/pm-rl/blob/main/.agents/pm/features/pm-rl-zav1.toon))
- An approved generation budget the loop cannot advance past on its own ([pm-rl-qix7](https://github.com/unbraind/pm-rl/blob/main/.agents/pm/features/pm-rl-qix7.toon))
- Generation lineage: a policy generation is an item whose parent is the generation that produced its training data ([pm-rl-81oc](https://github.com/unbraind/pm-rl/blob/main/.agents/pm/features/pm-rl-81oc.toon))
- Absorb pm 2026.8.7 merge and SDK contracts ([pm-rl-soik](https://github.com/unbraind/pm-rl/blob/main/.agents/pm/features/pm-rl-soik.toon))

### Fixed

- Review round 15: a pre-lock budget seeded the receipt, and four traversal and parsing defects ([pm-rl-g3k0](https://github.com/unbraind/pm-rl/blob/main/.agents/pm/issues/pm-rl-g3k0.toon))
- A promoted generation could store a padded or blank approval identity, consuming none of the budget it was promoted under ([pm-rl-rayz](https://github.com/unbraind/pm-rl/blob/main/.agents/pm/issues/pm-rl-rayz.toon))
- Promotion budget reservation is a read-then-write race, so concurrent promotions can exceed the approved budget ([pm-rl-cnc0](https://github.com/unbraind/pm-rl/blob/main/.agents/pm/issues/pm-rl-cnc0.toon))
- A registered seed cannot parent any candidate, and the tests hide it by writing outside the command surface ([pm-rl-qdxu](https://github.com/unbraind/pm-rl/blob/main/.agents/pm/issues/pm-rl-qdxu.toon))
- Two promotion-path checks fail open on unreadable provenance ([pm-rl-izu1](https://github.com/unbraind/pm-rl/blob/main/.agents/pm/issues/pm-rl-izu1.toon))
- Three parse and arithmetic checks accept records the module is supposed to refuse ([pm-rl-dzqc](https://github.com/unbraind/pm-rl/blob/main/.agents/pm/issues/pm-rl-dzqc.toon))
- Invalidation does not propagate to descendants, and the test asserting that it does has no descendant ([pm-rl-6fb5](https://github.com/unbraind/pm-rl/blob/main/.agents/pm/issues/pm-rl-6fb5.toon))
- isEnvironmentInvalidated reports an edit for an environment that is absent, and the fence regex is duplicated five times ([pm-rl-o9dr](https://github.com/unbraind/pm-rl/blob/main/.agents/pm/issues/pm-rl-o9dr.toon))
- The budget-exhaustion path and the sorted-run traversal were both asserted vacuously ([pm-rl-82qw](https://github.com/unbraind/pm-rl/blob/main/.agents/pm/issues/pm-rl-82qw.toon))
- asString returns the untrimmed value, so a padded identity bypasses the contamination gate ([pm-rl-k5xd](https://github.com/unbraind/pm-rl/blob/main/.agents/pm/issues/pm-rl-k5xd.toon))
- Fix release publish-before-protected-main-push ordering ([pm-rl-wlj0](https://github.com/unbraind/pm-rl/blob/main/.agents/pm/issues/pm-rl-wlj0.toon))
- The shared script launcher skipped every gate it guarded when a path could not be resolved ([pm-rl-swa0](https://github.com/unbraind/pm-rl/blob/main/.agents/pm/issues/pm-rl-swa0.toon))
- Converge changelog generation and verification on replace mode ([pm-rl-yjqx](https://github.com/unbraind/pm-rl/blob/main/.agents/pm/issues/pm-rl-yjqx.toon))
- Resolve CodeRabbit PR 7 review findings across the release gates ([pm-rl-3tdy](https://github.com/unbraind/pm-rl/blob/main/.agents/pm/issues/pm-rl-3tdy.toon))
- Release bot identity was absent from the allowlist, so the first release would break the audit permanently ([pm-rl-rgt4](https://github.com/unbraind/pm-rl/blob/main/.agents/pm/issues/pm-rl-rgt4.toon))
- Release gate omits operational scripts, full-history identities, lint, and duplication ([pm-rl-zcqf](https://github.com/unbraind/pm-rl/blob/main/.agents/pm/issues/pm-rl-zcqf.toon))
- Make fallback-author coverage assert actual PM client wiring ([pm-rl-q7xw](https://github.com/unbraind/pm-rl/blob/main/.agents/pm/issues/pm-rl-q7xw.toon))
- Gate durable PM project health in CI on pm CLI 2026.8.6 ([pm-rl-e0vc](https://github.com/unbraind/pm-rl/blob/main/.agents/pm/issues/pm-rl-e0vc.toon))
- changelog:full and changelog:check use different projections ([pm-rl-mxe0](https://github.com/unbraind/pm-rl/blob/main/.agents/pm/issues/pm-rl-mxe0.toon))
- pm CLI 2026.8.6 exposes untested fallback-author branches under the exact coverage gate ([pm-rl-tqym](https://github.com/unbraind/pm-rl/blob/main/.agents/pm/issues/pm-rl-tqym.toon))

### Other

- Promotion refuses on contamination rather than warning about it ([pm-rl-gyrj](https://github.com/unbraind/pm-rl/blob/main/.agents/pm/decisions/pm-rl-gyrj.toon))
- Mark stale in_progress items as blocked to clear stale_in_progress health warning ([pm-rl-d3ve](https://github.com/unbraind/pm-rl/blob/main/.agents/pm/chores/pm-rl-d3ve.toon))
- The changelog heading records the day it was generated, so the gate fails every following day ([pm-rl-yxhe](https://github.com/unbraind/pm-rl/blob/main/.agents/pm/chores/pm-rl-yxhe.toon))

## 2026.7.31 - 2026-07-31

### Added

- Run lifecycle ingests NDJSON in bounded pm-rl/2 segments, reads pm-rl/1, and measures sustained storage ([pm-rl-dyho](https://github.com/unbraind/pm-rl/blob/main/.agents/pm/features/pm-rl-dyho.toon))

### Other

- Metric series live in item history, never in an item body ([pm-rl-mpd9](https://github.com/unbraind/pm-rl/blob/main/.agents/pm/decisions/pm-rl-mpd9.toon))
- 100/100/100 coverage and full docstring coverage for pm-rl ([pm-rl-fpon](https://github.com/unbraind/pm-rl/blob/main/.agents/pm/tasks/pm-rl-fpon.toon))
