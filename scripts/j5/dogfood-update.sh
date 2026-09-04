#!/usr/bin/env bash
# Update the self-hosted J5 Code dogfood server from source and restart it.
# Run on the server box as the dogfood user; prefer a quiet fleet, since the
# restart cancels in-flight agent turns. See docs/j5/dogfood-runtime.md.

set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$script_dir/../.." && pwd)"
service="${J5_DOGFOOD_SERVICE:-j5code.service}"
port="${J5_DOGFOOD_PORT:-5773}"

cd "$repo_root"

previous_ref="$(git rev-parse --short HEAD)"
echo "Server currently at $previous_ref — the rollback target if this update goes bad."

"$script_dir/dogfood-snapshot.sh" "pre-update-$previous_ref"

git switch j5/main
git pull --ff-only origin j5/main
echo "Now at $(git rev-parse --short HEAD)."

node_version="$(<"$repo_root/.nvmrc")"
fnm install "$node_version"
package_manager="$(fnm exec --using "$node_version" node -p 'require("./package.json").packageManager.split("+")[0]')"
fnm exec --using "$node_version" npm install --global "$package_manager"
fnm exec --using "$node_version" pnpm install --frozen-lockfile
fnm exec --using "$node_version" pnpm exec vp run --filter t3 build

systemctl --user restart "$service"

for _ in $(seq 1 30); do
  if curl --connect-timeout 1 --max-time 2 -fsS "http://127.0.0.1:$port/" >/dev/null 2>&1; then
    echo "Server is answering on 127.0.0.1:$port."
    exit 0
  fi
  sleep 1
done

echo "Server did not answer after 30 probes (2s request limit, 1s retry delay). Inspect: journalctl --user -u $service -e" >&2
echo "Rollback: git checkout $previous_ref, rebuild, restore the pre-update snapshot (docs/j5/dogfood-runtime.md)." >&2
exit 1
