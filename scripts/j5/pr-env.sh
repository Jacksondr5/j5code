#!/usr/bin/env bash
# pr-env.sh — stand up an isolated test environment for a PR, no agents required.
#
#   scripts/j5/pr-env.sh <pr-number> [--fresh] [--branch <name>] [--peer]
#
#   scripts/j5/pr-env.sh 35            # build + serve PR #35, reusing its state dir
#   scripts/j5/pr-env.sh 35 --fresh    # same, but wipe state first (first-run gate fires again)
#   scripts/j5/pr-env.sh 0 --branch j5/main   # test main itself
#   scripts/j5/pr-env.sh 35 --peer     # two servers from one build, peered as Local and Remote
#
# What it does: fetches the PR head into a dedicated worktree under
# ~/.j5code-pr-envs/, builds the version-matched server+web bundle, and serves it
# headless on a PR-derived port with a fully isolated state dir (never ~/.j5code,
# never ~/.t3). The server prints its own one-time pairing URL — open that in your
# browser. Ctrl-C stops the server; the worktree and state persist for reruns
# (rerunning refetches the PR head, so a lane pushing a fix is one rerun away).
#
# --peer serves the same build twice. "Local" is the ordinary server: PR port, the
# usual state dir. "Remote" runs beside it on port+100 (J5_ENV_PEER_PORT) with its
# own state dir. Once both answer, the script peers them headlessly with
# `j5 a2a peer` against each state dir; that mints and revokes a temporary local
# admin session and never touches the startup pairing grants, so both pairing
# URLs stay valid. Both logs stream here, each line prefixed [Local] or [Remote].
# Pair your browser with Local's URL, then add Remote under Settings → Connections
# → Add environment with Remote's URL. Rerunning re-peers idempotently.
set -euo pipefail

REPO="${J5_REPO:-$HOME/repos/jacksondr5/j5code}"
PR="${1:?usage: pr-env.sh <pr-number> [--fresh] [--branch <name>] [--peer]}"; shift
FRESH=0; BRANCH=""; PEER=0
while [ $# -gt 0 ]; do case "$1" in
  --fresh) FRESH=1 ;;
  --branch) BRANCH="$2"; shift ;;
  --peer) PEER=1 ;;
  *) echo "unknown flag: $1" >&2; exit 2 ;;
esac; shift; done

ENVROOT="$HOME/.j5code-pr-envs/pr$PR"
SRC="$ENVROOT/src"; STATE="$ENVROOT/state"; PEER_STATE="$ENVROOT/state-remote"
PORT=$((7700 + PR % 100))   # stable per-PR port; override with J5_ENV_PORT
PORT="${J5_ENV_PORT:-$PORT}"
PEER_PORT="${J5_ENV_PEER_PORT:-$((PORT + 100))}"

# A PR-env server is never a child of the background service. Drop the launcher
# context an agent shell inherits from one, or `serve` refuses the version mismatch.
unset T3_SERVICE_LAUNCHER_CONTEXT

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

[ "$FRESH" = 1 ] && rm -rf "$STATE" "$PEER_STATE"
mkdir -p "$STATE"

if [ "$PEER" = 0 ]; then
  echo ""
  echo "== serving PR #$PR ($HEAD_SHA) on http://localhost:$PORT  |  state: $STATE =="
  echo "== the pairing URL prints below; Ctrl-C stops the server =="
  echo ""
  exec fnm exec --using "$(cat .nvmrc)" node apps/server/dist/bin.mjs serve \
    --port "$PORT" --host 127.0.0.1 --base-dir "$STATE"
fi

# ---- --peer: two servers, one build ------------------------------------------
mkdir -p "$PEER_STATE"
LOCAL_ORIGIN="http://127.0.0.1:$PORT"; REMOTE_ORIGIN="http://127.0.0.1:$PEER_PORT"
LOCAL_LOG="$ENVROOT/local.log"; REMOTE_LOG="$ENVROOT/remote.log"
: > "$LOCAL_LOG"; : > "$REMOTE_LOG"
# Run node directly so the PIDs we capture are the servers themselves (rule 1:
# stop only what you spawned, by the PID you kept).
NODE_BIN=$(fnm exec --using "$(cat .nvmrc)" sh -c 'command -v node')
if [ -t 1 ]; then C_LOCAL=$'\033[36m'; C_REMOTE=$'\033[35m'; C_PEER=$'\033[33m'; C_OFF=$'\033[0m'
else C_LOCAL=""; C_REMOTE=""; C_PEER=""; C_OFF=""; fi

# Prefix each line with the server it came from so the two logs interleave readably.
tag() { local prefix="$1" file="$2" line; while IFS= read -r line; do
  printf '%s %s\n' "$prefix" "$line"
  [ -z "$file" ] || printf '%s\n' "$line" >> "$file"
done; return 0; }
# Runs in the calling shell (no subshell, no capture) so $! afterwards is the server's PID.
serve_bg() { # <port> <state> <prefix> <log>
  "$NODE_BIN" apps/server/dist/bin.mjs serve --port "$1" --host 127.0.0.1 --base-dir "$2" \
    > >(tag "$3" "$4") 2>&1 &
}
PIDS=()
stop_servers() {
  trap - EXIT INT TERM
  for pid in "${PIDS[@]:-}"; do [ -n "$pid" ] && kill "$pid" 2>/dev/null || true; done
  wait 2>/dev/null || true
}
# Ctrl-C stops both servers and ends the script; an ordinary exit only cleans up.
on_signal() { echo ""; echo "== stopping both servers =="; stop_servers; exit 130; }
trap stop_servers EXIT
trap on_signal INT TERM
wait_ready() { # <name> <origin> <pid>
  local i
  for i in $(seq 1 180); do
    kill -0 "$3" 2>/dev/null || { echo "== $1 exited before it was ready; see its log above ==" >&2; return 1; }
    # A bounded probe: the server binds its port before it can answer, so an
    # unbounded request would hang on the listen backlog instead of retrying.
    curl -fsS --max-time 2 -o /dev/null "$2/.well-known/t3/environment" 2>/dev/null && return 0
    sleep 0.5
  done
  echo "== $1 did not answer at $2 within 90s ==" >&2; return 1
}
environment_id() { # <origin>
  curl -fsS --max-time 10 "$1/.well-known/t3/environment" \
    | "$NODE_BIN" -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(0,"utf8")).environmentId)'
}
j5() { "$NODE_BIN" apps/server/dist/bin.mjs "$@"; }
# The issuer mints the credential the holder presents when delivering to it; the
# holder then records the issuer at its origin, proving that credential there.
peer_one_way() { # <issuer state> <issuer origin> <issuer label> <holder id> <holder state> <holder origin> <holder label>
  # Capture stdout alone: a process substitution inside $(...) would write its
  # prefixed stderr into the captured credential. Node's warnings go to a file
  # and surface only when the step fails.
  local credential errors="$ENVROOT/peer-credential.err"
  credential=$(j5 a2a peer credential --base-dir "$1" --origin "$2" --for "$4" --label "$7" --credential-only \
    2>"$errors") \
    || { echo "== $3 could not issue a peer credential for $7 ==" >&2; tag "${C_PEER}[peer]${C_OFF}" "" < "$errors"; return 1; }
  j5 a2a peer add --base-dir "$5" --origin "$6" --peer-origin "$2" --credential "$credential" --label "$3" \
    2>&1 | tag "${C_PEER}[peer]${C_OFF}" "" \
    || { echo "== $7 could not record $3 at $2 ==" >&2; return 1; }
}
# Both servers are seconds old when peering starts; a cold event loop can miss
# the hello's timeout once. Retry the whole direction: reissuing rotates the
# credential and re-adding rotates the record, so a retry leaves one clean result.
retry() { # <attempts> <pause seconds> <what> <command...>
  local attempts="$1" pause="$2" what="$3" n=1; shift 3
  until "$@"; do
    [ "$n" -ge "$attempts" ] && { echo "== $what failed after $attempts attempts ==" >&2; return 1; }
    echo "${C_PEER}[peer]${C_OFF} $what failed (attempt $n of $attempts); retrying in ${pause}s"
    sleep "$pause"; n=$((n + 1))
  done
}
pairing_url() { grep -o "http://127.0.0.1:$2[^ \"']*" "$1" | grep -iE 'pair|token' | tail -1 || true; }

echo ""
echo "== serving PR #$PR ($HEAD_SHA) twice: Local on $LOCAL_ORIGIN, Remote on $REMOTE_ORIGIN =="
echo "== state: Local $STATE  |  Remote $PEER_STATE =="
echo ""
serve_bg "$PORT" "$STATE" "${C_LOCAL}[Local]${C_OFF}" "$LOCAL_LOG"; PIDS+=($!)
serve_bg "$PEER_PORT" "$PEER_STATE" "${C_REMOTE}[Remote]${C_OFF}" "$REMOTE_LOG"; PIDS+=($!)
wait_ready Local "$LOCAL_ORIGIN" "${PIDS[0]}"
wait_ready Remote "$REMOTE_ORIGIN" "${PIDS[1]}"
LOCAL_ID=$(environment_id "$LOCAL_ORIGIN"); REMOTE_ID=$(environment_id "$REMOTE_ORIGIN")
if [ "$LOCAL_ID" = "$REMOTE_ID" ]; then
  echo "== both servers report environment $LOCAL_ID; the state dirs are not separate ==" >&2; exit 1
fi
echo "${C_PEER}[peer]${C_OFF} peering Local ($LOCAL_ID) <-> Remote ($REMOTE_ID)"
retry 5 3 "Local recording Remote" \
  peer_one_way "$PEER_STATE" "$REMOTE_ORIGIN" Remote "$LOCAL_ID" "$STATE" "$LOCAL_ORIGIN" Local
retry 5 3 "Remote recording Local" \
  peer_one_way "$STATE" "$LOCAL_ORIGIN" Local "$REMOTE_ID" "$PEER_STATE" "$REMOTE_ORIGIN" Remote

echo ""
echo "== peered. Local $LOCAL_ORIGIN ($LOCAL_ID)  <->  Remote $REMOTE_ORIGIN ($REMOTE_ID) =="
echo "== Local pairing URL:  $(pairing_url "$LOCAL_LOG" "$PORT")"
echo "== Remote pairing URL: $(pairing_url "$REMOTE_LOG" "$PEER_PORT")"
echo "== pair your browser with Local's URL, then Settings → Connections → Add environment with Remote's URL =="
echo "== Ctrl-C stops both servers =="
echo ""
while kill -0 "${PIDS[0]}" 2>/dev/null && kill -0 "${PIDS[1]}" 2>/dev/null; do sleep 1; done
echo "== a server exited; stopping the other ==" >&2
exit 1
