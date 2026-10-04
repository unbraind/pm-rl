# PM CLI/SDK 2026.10.4 certification

Item: [pm-rl-hncb](https://github.com/unbraind/pm-rl/blob/main/.agents/pm/chores/pm-rl-hncb.toon).

This candidate pins published PM CLI, pm-ops and pm-changelog 2026.10.4, refreshes npm and Bun locks, copies the canonical pm-ops launcher unchanged, and carries Dependabot #50, #53, #55, #56 and #57 including the exact CodeQL SHA. All devDependencies are exact. The peer/manifest floor stays 2026.8.28. The owner-controlled publication gate remains disabled unless the owner approves it.

## Pins

```json
{
  "@babel/core": "8.0.6",
  "@babel/eslint-parser": "8.0.6",
  "@babel/plugin-syntax-typescript": "8.0.3",
  "@types/node": "26.6.4",
  "@unbrained/pm-cli": "2026.10.4",
  "eslint": "10.12.0",
  "jiti": "2.7.0",
  "jscpd": "5.4.0",
  "pm-changelog": "2026.10.4",
  "pm-ops": "2026.10.4",
  "typescript": "7.0.2"
}
```

## Validation

- `flock /tmp/claude-1000/heavy-gate.lock npm install`: pass.
- `flock /tmp/claude-1000/heavy-gate.lock bun install`: pass.
- `flock /tmp/claude-1000/heavy-gate.lock npm run release:check`: pass, 332/332 tests, zero skipped; statements/lines/branches/functions 100/100/100/100 across all 20 authored source files; 136 documented declarations, zero duplication, identity/publish attestation/production audit/pack/changelog pass.
- `npm audit --omit=dev` and `npm audit`: zero vulnerabilities; no open Dependabot alerts.
- `npx pm health --strict-exit --require-merge-drivers`: exit 0, ok true; inherited advisory warnings `stale_in_progress_items:1` and `provenance_value_domain_invalid:claude-code:role:single_digit:138` remain visible.
- `node --test test/prepare-merge-driver.test.ts`: 9/9 passed, zero skips. Tests cover missing package.json, a dangling package link and inconclusive lookup. Launcher bytes match `node_modules/pm-ops/templates/prepare-merge-driver.ts`.
- `npx pm test pm-rl-hncb --run --only-last --progress --workspace-context snapshot --override-linked-workspace-context`: pass. The initial none/source invocation was refused before execution; snapshot context resolves that isolation constraint.

## Managed GitHub preview

`npx pm package install npm:pm-github@2026.10.4 --project` passed, and `npx pm github sync --repo unbraind/pm-rl --dry-run` returned:

```text
No pm items linked to unbraind/pm-rl (no `gh:unbraind/pm-rl#N` provenance tags).
synced: 0
skipped: 0
planned: 0

```

Zero planned writes against a tracker without GitHub-linked items is zero-case evidence. No GitHub issues were written and no scheduled sync was enabled. Installed extension files stay ignored; the managed manifest and README carry the pin for fresh clones.

## Packed real-tracker dogfood

Ran under `flock /tmp/claude-1000/heavy-gate.lock /tmp/claude-1000/dogfood-rl.sh`. Packed with `npm pack --silent --pack-destination /tmp/claude-1000`, copied this repository's complete `.agents/pm` to `/tmp/claude-1000/cert-wt/pm-rl-dogfood/.agents/pm`, then installed `/tmp/claude-1000/pm-rl-2026.7.31.tgz` and `@unbrained/pm-cli@2026.10.4` with `npm install --save-exact`. The tarball was activated with `npx -y @unbrained/pm-cli@2026.10.4 package install /tmp/claude-1000/pm-rl-2026.7.31.tgz --project`.

Both npm/npx and native Bun (`bunx --bun`) passed environment listing, run creation, metrics append and run show on the copied real tracker. Each run returned all three example metrics in step order. The scratch tracker was deleted by the script's exit trap. Exact commands and outputs:

```text
+ npx -y @unbrained/pm-cli@2026.10.4 rl env register --file examples/grid-world.json --json
+ cat env.json
{
  "action": "rl-env-register",
  "id": "pm-rl-env-grid-world-3-f18722ed5451",
  "created": true,
  "details": {
    "spec_hash": "f18722ed5451e3fc62010fd262e0f2afb5f0c88b26ef713de79d51e5ef56f44c"
  }
}
++ node -e 'console.log(JSON.parse(require("fs").readFileSync("env.json","utf8")).id)'
+ env_id=pm-rl-env-grid-world-3-f18722ed5451
+ npx -y @unbrained/pm-cli@2026.10.4 rl env list --json
{
  "action": "rl-env-list",
  "details": {
    "count": 1,
    "environments": [
      {
        "id": "pm-rl-env-grid-world-3-f18722ed5451",
        "title": "Grid World 3"
      }
    ]
  }
}
+ npx -y @unbrained/pm-cli@2026.10.4 rl run start cert-npm-run --environment pm-rl-env-grid-world-3-f18722ed5451 --algorithm PPO --config-file examples/ppo.json --json
{
  "action": "rl-run-start",
  "id": "pm-rl-cert-npm-run",
  "created": true,
  "details": {
    "environment_id": "pm-rl-env-grid-world-3-f18722ed5451",
    "spec_hash": "f18722ed5451e3fc62010fd262e0f2afb5f0c88b26ef713de79d51e5ef56f44c",
    "config_hash": "6df08c9df51fbbf91dd67277b6b7a77cb9b838901045e388faf88444e577a3e1"
  }
}
+ npx -y @unbrained/pm-cli@2026.10.4 rl run log cert-npm-run --file examples/metrics.ndjson --json
{
  "action": "rl-run-log",
  "id": "pm-rl-cert-npm-run",
  "details": {
    "appended": 3,
    "segments": 1,
    "stored_bytes": 164,
    "first_step": 0,
    "last_step": 2
  }
}
+ npx -y @unbrained/pm-cli@2026.10.4 rl run show cert-npm-run --json
{
  "action": "rl-run-show",
  "id": "pm-rl-cert-npm-run",
  "details": {
    "status": "in_progress",
    "environment_id": "pm-rl-env-grid-world-3-f18722ed5451",
    "events": [
      {
        "step": 0,
        "metric": "episode_return",
        "value": 1.25,
        "tags": {
          "seed": "7"
        }
      },
      {
        "step": 1,
        "metric": "loss",
        "value": 0.83,
        "wallClockMs": 1200,
        "tags": {
          "seed": "7"
        }
      },
      {
        "step": 2,
        "metric": "episode_return",
        "value": 8.5,
        "wallClockMs": 2400,
        "tags": {
          "seed": "7"
        }
      }
    ],
    "comments": 0
  }
}
+ bunx --bun -y @unbrained/pm-cli@2026.10.4 rl env list --json
{
  "action": "rl-env-list",
  "details": {
    "count": 1,
    "environments": [
      {
        "id": "pm-rl-env-grid-world-3-f18722ed5451",
        "title": "Grid World 3"
      }
    ]
  }
}
+ bunx --bun -y @unbrained/pm-cli@2026.10.4 rl run start cert-bun-run --environment pm-rl-env-grid-world-3-f18722ed5451 --algorithm PPO --config-file examples/ppo.json --json
{
  "action": "rl-run-start",
  "id": "pm-rl-cert-bun-run",
  "created": true,
  "details": {
    "environment_id": "pm-rl-env-grid-world-3-f18722ed5451",
    "spec_hash": "f18722ed5451e3fc62010fd262e0f2afb5f0c88b26ef713de79d51e5ef56f44c",
    "config_hash": "6df08c9df51fbbf91dd67277b6b7a77cb9b838901045e388faf88444e577a3e1"
  }
}
+ bunx --bun -y @unbrained/pm-cli@2026.10.4 rl run log cert-bun-run --file examples/metrics.ndjson --json
{
  "action": "rl-run-log",
  "id": "pm-rl-cert-bun-run",
  "details": {
    "appended": 3,
    "segments": 1,
    "stored_bytes": 164,
    "first_step": 0,
    "last_step": 2
  }
}
+ bunx --bun -y @unbrained/pm-cli@2026.10.4 rl run show cert-bun-run --json
{
  "action": "rl-run-show",
  "id": "pm-rl-cert-bun-run",
  "details": {
    "status": "in_progress",
    "environment_id": "pm-rl-env-grid-world-3-f18722ed5451",
    "events": [
      {
        "step": 0,
        "metric": "episode_return",
        "value": 1.25,
        "tags": {
          "seed": "7"
        }
      },
      {
        "step": 1,
        "metric": "loss",
        "value": 0.83,
        "wallClockMs": 1200,
        "tags": {
          "seed": "7"
        }
      },
      {
        "step": 2,
        "metric": "episode_return",
        "value": 8.5,
        "wallClockMs": 2400,
        "tags": {
          "seed": "7"
        }
      }
    ],
    "comments": 0
  }
}
+ rm -rf /tmp/claude-1000/cert-wt/pm-rl-dogfood

```

CI and substantive review receipts are assessed independently on the final PR head. This certification does not implement the durable controller described by pm-rl-apvf and does not authorize publication.
