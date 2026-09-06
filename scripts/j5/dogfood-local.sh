#!/usr/bin/env bash
# dogfood-local.sh — run the REAL J5 Code dogfood server on this machine.
#
#   scripts/j5/dogfood-local.sh              # update to j5/main tip, snapshot, build, serve
#   scripts/j5/dogfood-local.sh --no-update  # serve the already-built runtime (fast restart)
#   scripts/j5/dogfood-local.sh --fresh      # set the state dir aside (renamed, not deleted) and start clean
#
# This is the local-first counterpart of the Linux runbook (docs/j5/dogfood-runtime.md):
# same layout, same state dir, same snapshot-before-update rule, minus systemd/Tailscale.
#
#   runtime checkout : ~/.j5code-runtime/src   (detached at origin/j5/main — the server's own
#                      copy of the source; NOT the repo your agents work in, so an agent's
#                      branch or half-edited file can never change the app you're running)
#   state            : ~/.j5code               (the REAL dogfood state; side-by-side with ~/.t3)
#   snapshots        : ~/.j5code/db-snapshots  (VACUUM INTO before every update; forward-only migrations)
#   port             : 5773 on 127.0.0.1       (same as the Linux unit)
#
# The server prints its own one-time pairing URL — open it in your browser. Ctrl-C stops the
# server; state persists. Rerunning updates to the current j5/main tip (snapshot first) and
# restarts. Restarts cancel in-flight agent turns, so update when the fleet is quiet.
#
# The Squadron's folder is your normal repo clone (e.g. ~/repos/jacksondr5/j5code); agents get
# per-thread worktrees from there. The runtime checkout above is only what the server runs from.
set -euo pipefail

REPO="${J5_REPO:-$HOME/repos/jacksondr5/j5code}"
RUNTIME="${J5_RUNTIME_DIR:-$HOME/.j5code-runtime}"
SRC="$RUNTIME/src"
STATE="${J5_DOGFOOD_BASE_DIR:-$HOME/.j5code}"
PORT="${J5_DOGFOOD_PORT:-5773}"

UPDATE=1; FRESH=0
while [ $# -gt 0 ]; do case "$1" in
  --no-update) UPDATE=0 ;;
  --fresh) FRESH=1 ;;
  *) echo "unknown flag: $1 (usage: dogfood-local.sh [--no-update] [--fresh])" >&2; exit 2 ;;
esac; shift; done

mkdir -p "$RUNTIME"

if [ "$UPDATE" = 1 ]; then
  cd "$REPO"
  git fetch -q origin j5/main
  if [ -d "$SRC" ]; then
    git -C "$SRC" checkout -q --detach "$(git rev-parse origin/j5/main)"
  else
    git worktree add --detach "$SRC" origin/j5/main
  fi
elif [ ! -d "$SRC/apps/server/dist" ]; then
  echo "No built runtime at $SRC — run once without --no-update first." >&2; exit 1
fi

cd "$SRC"
HEAD_SHA=$(git rev-parse --short=9 HEAD)
echo "== J5 Code dogfood (local) — j5/main at $HEAD_SHA =="

if [ "$FRESH" = 1 ] && [ -d "$STATE" ]; then
  ASIDE="$STATE.set-aside-$(date +%Y%m%d-%H%M%S)"
  mv "$STATE" "$ASIDE"
  echo "== --fresh: previous state set aside at $ASIDE (delete it yourself when sure) =="
fi

if [ "$UPDATE" = 1 ]; then
  if [ -f "$STATE/userdata/state.sqlite" ]; then
    J5_DOGFOOD_BASE_DIR="$STATE" "$SRC/scripts/j5/dogfood-snapshot.sh" "pre-update-$HEAD_SHA"
  fi
  fnm install >/dev/null 2>&1 || true
  fnm exec --using "$(cat .nvmrc)" pnpm install --frozen-lockfile
  fnm exec --using "$(cat .nvmrc)" pnpm exec vp run --filter t3 build
fi

mkdir -p "$STATE"
echo ""
echo "== serving j5/main ($HEAD_SHA) on http://localhost:$PORT  |  state: $STATE =="
echo "== the pairing URL prints below; Ctrl-C stops the server, state persists =="
echo ""
exec fnm exec --using "$(cat .nvmrc)" node apps/server/dist/bin.mjs serve \
  --port "$PORT" --host 127.0.0.1 --base-dir "$STATE"
