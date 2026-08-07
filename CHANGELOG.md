# Changelog

## Unreleased

### Added

- Absorb pm 2026.8.7 merge and SDK contracts ([pm-rl-soik](https://github.com/unbraind/pm-rl/blob/main/.agents/pm/features/pm-rl-soik.toon))

### Fixed

- Make fallback-author coverage assert actual PM client wiring ([pm-rl-q7xw](https://github.com/unbraind/pm-rl/blob/main/.agents/pm/issues/pm-rl-q7xw.toon))
- Gate durable PM project health in CI on pm CLI 2026.8.6 ([pm-rl-e0vc](https://github.com/unbraind/pm-rl/blob/main/.agents/pm/issues/pm-rl-e0vc.toon))
- changelog:full and changelog:check use different projections ([pm-rl-mxe0](https://github.com/unbraind/pm-rl/blob/main/.agents/pm/issues/pm-rl-mxe0.toon))
- pm CLI 2026.8.6 exposes untested fallback-author branches under the exact coverage gate ([pm-rl-tqym](https://github.com/unbraind/pm-rl/blob/main/.agents/pm/issues/pm-rl-tqym.toon))

### Other

- Mark stale in_progress items as blocked to clear stale_in_progress health warning ([pm-rl-d3ve](https://github.com/unbraind/pm-rl/blob/main/.agents/pm/chores/pm-rl-d3ve.toon))
- The changelog heading records the day it was generated, so the gate fails every following day ([pm-rl-yxhe](https://github.com/unbraind/pm-rl/blob/main/.agents/pm/chores/pm-rl-yxhe.toon))

## 2026.7.31 - 2026-07-31

### Added

- Run lifecycle ingests NDJSON in bounded pm-rl/2 segments, reads pm-rl/1, and measures sustained storage ([pm-rl-dyho](https://github.com/unbraind/pm-rl/blob/main/.agents/pm/features/pm-rl-dyho.toon))

### Other

- Metric series live in item history, never in an item body ([pm-rl-mpd9](https://github.com/unbraind/pm-rl/blob/main/.agents/pm/decisions/pm-rl-mpd9.toon))
- 100/100/100 coverage and full docstring coverage for pm-rl ([pm-rl-fpon](https://github.com/unbraind/pm-rl/blob/main/.agents/pm/tasks/pm-rl-fpon.toon))
