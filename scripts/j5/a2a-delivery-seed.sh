#!/usr/bin/env bash

set -euo pipefail

usage() {
  echo "Usage: scripts/j5/a2a-delivery-seed.sh --base-dir <absolute-isolated-t3-home>" >&2
  echo "The target T3 server must be stopped; the runner takes one rollback write preflight and exits after emitting its JSON receipt." >&2
}

if [[ $# -ne 2 || "$1" != "--base-dir" ]]; then
  usage
  exit 64
fi

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$script_dir/../.." && pwd)"
node_version="$(<"$repo_root/.nvmrc")"

cd "$repo_root"
exec fnm exec --using "$node_version" node "$repo_root/apps/server/src/j5/a2a/test-support/devDeliverySeedRunner.ts" "$@"
