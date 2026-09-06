#!/usr/bin/env bash
# pr-env.sh — stand up an isolated test environment for a PR, no agents required.
#
#   scripts/j5/pr-env.sh <pr-number> [--fresh] [--branch <name>]
#
#   scripts/j5/pr-env.sh 35            # build + serve PR #35, reusing its state dir
#   scripts/j5/pr-env.sh 35 --fresh    # same, but wipe state first (first-run gate fires again)
#   scripts/j5/pr-env.sh 0 --branch j5/main   # test main itself
#
# What it does: fetches the PR head into a dedicated worktree under
# ~/.j5code-pr-envs/, builds the version-matched server+web bundle, and serves it
# headless on a PR-derived port with a fully isolated state dir (never ~/.j5code,
# never ~/.t3). The server prints its own one-time pairing URL — open that in your
# browser. Ctrl-C stops the server; the worktree and state persist for reruns
# (rerunning refetches the PR head, so a lane pushing a fix is one rerun away).
set -euo pipefail

REPO="${J5_REPO:-$HOME/repos/jacksondr5/j5code}"
PR="${1:?usage: pr-env.sh <pr-number> [--fresh] [--branch <name>]}"; shift
FRESH=0; BRANCH=""
while [ $# -gt 0 ]; do case "$1" in
  --fresh) FRESH=1 ;;
  --branch) BRANCH="$2"; shift ;;
  *) echo "unknown flag: $1" >&2; exit 2 ;;
esac; shift; done

ENVROOT="$HOME/.j5code-pr-envs/pr$PR"
SRC="$ENVROOT/src"; STATE="$ENVROOT/state"
PORT=$((7700 + PR % 100))   # stable per-PR port; override with J5_ENV_PORT
PORT="${J5_ENV_PORT:-$PORT}"

mkdir -p "$ENVROOT"
cd "$REPO"
if [ -n "$BRANCH" ]; then
  git fetch origin "$BRANCH" && REF="origin/$BRANCH"
else
  git fetch --force origin "pull/$PR/head:pr-env/$PR" && REF="pr-env/$PR"
fi
if [ -d "$SRC" ]; then
  git -C "$SRC" checkout -q --detach "$(git rev-parse "$REF")"
else
  git worktree add --detach "$SRC" "$REF"
fi
HEAD_SHA=$(git -C "$SRC" rev-parse --short=9 HEAD)
echo "== pr-env: PR #$PR at $HEAD_SHA =="

cd "$SRC"
fnm install >/dev/null 2>&1 || true
fnm exec --using "$(cat .nvmrc)" pnpm install --frozen-lockfile
fnm exec --using "$(cat .nvmrc)" pnpm exec vp run --filter t3 build

[ "$FRESH" = 1 ] && rm -rf "$STATE"
mkdir -p "$STATE"

echo ""
echo "== serving PR #$PR ($HEAD_SHA) on http://localhost:$PORT  |  state: $STATE =="
echo "== the pairing URL prints below; Ctrl-C stops the server =="
echo ""
exec fnm exec --using "$(cat .nvmrc)" node apps/server/dist/bin.mjs serve \
  --port "$PORT" --host 127.0.0.1 --base-dir "$STATE"
