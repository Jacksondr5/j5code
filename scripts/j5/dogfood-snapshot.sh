#!/usr/bin/env bash
# Snapshot the dogfood server's SQLite state with VACUUM INTO, which is safe
# while the server is running and yields one consistent file. Called by
# dogfood-update.sh before every update and by the nightly snapshot timer.
# See docs/j5/dogfood-runtime.md.

set -euo pipefail

base_dir="${J5_DOGFOOD_BASE_DIR:-$HOME/.j5code}"
db_path="$base_dir/userdata/state.sqlite"
snapshot_root="${J5_DOGFOOD_SNAPSHOT_DIR:-$base_dir/db-snapshots}"
keep="${J5_DOGFOOD_SNAPSHOT_KEEP:-14}"
label="${1:-manual}"

if [[ ! -f "$db_path" ]]; then
  echo "No database at $db_path — nothing to snapshot." >&2
  exit 1
fi

snapshot_dir="$snapshot_root/$(date +%Y%m%d-%H%M%S)-$label"
mkdir -p "$snapshot_dir"
sqlite3 "$db_path" "VACUUM INTO '$snapshot_dir/state.sqlite'"
echo "Snapshot written: $snapshot_dir/state.sqlite"

# Prune the oldest snapshots beyond the retention cap (GNU head, Linux-only).
ls -1d "$snapshot_root"/*/ | sort | head -n -"$keep" | xargs -r rm -rf
