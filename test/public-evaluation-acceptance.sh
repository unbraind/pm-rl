#!/usr/bin/env bash
# Replay a pinned, public tracker against a fresh package archive.
set -euo pipefail

commit=${1:-4e83f2c26e93558ca8f43e6b5e39c7d3c22e9581}
[[ "$commit" =~ ^[0-9a-f]{40}$ ]]
scratch=$(mktemp -d)
cleanup() {
  if [[ -d "$scratch/source" ]]; then
    chmod -R u+w "$scratch/source"
  fi
  rm -rf -- "$scratch"
}
trap cleanup EXIT

mkdir "$scratch/source" "$scratch/home" "$scratch/tmp"
git archive "$commit" .agents/pm | tar -x -C "$scratch/source"
chmod -R a-w "$scratch/source"

export HOME="$scratch/home" TMPDIR="$scratch/tmp" GIT_CEILING_DIRECTORIES="$scratch"
export npm_config_update_notifier=false
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 NPM_CONFIG_USERCONFIG=/dev/null npm_config_userconfig=/dev/null
unset PM_PATH NODE_V8_COVERAGE
npm run build
archive="$scratch/$(npm pack --ignore-scripts --pack-destination "$scratch" --quiet)"
source="$scratch/source/.agents/pm"

for fixture in evaluation-plan worst-cohort shadow; do
  args=("$source" "$scratch/$fixture.json" "$commit" "$archive")
  if [[ "$fixture" == shadow ]]; then
    args+=(unbraind/pm-rl)
  fi
  node "test/$fixture.acceptance.ts" "${args[@]}"
  printf '%s passed against public tracker %s with Git absent from the CLI PATH\n' "$fixture" "$commit"
done
