#!/usr/bin/env bash

set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$script_dir/../.." && pwd)"
node_version="$(<"$repo_root/.nvmrc")"

exec fnm exec --using "$node_version" node "$repo_root/apps/server/src/j5/fleet-load.ts" "$@"
