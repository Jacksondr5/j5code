#!/usr/bin/env bash
# Capture J5 mobile scenes from fixture data only, for PR before/after evidence.
#
# Seeds a disposable home with the real A2A delivery seed (peer ask, human
# Inbox answer, silence notice, machine message, unknown envelope, plain MCP
# send), serves it on its own port, pairs the J5 Code Dev client through the
# test-t3-mobile helper, and pages through each seeded thread from the bottom
# up, saving one PNG per screen. No live agents run and no real data is read.
#
# Prerequisites: J5 Code Dev installed (scripts/mobile-native-client.ts ensure)
# and running against this checkout's Metro (`vp run dev:client`).

set -euo pipefail

usage() {
  echo "Usage: scripts/j5/mobile-scenes.sh --out <dir> [--keep] <agent-device-command> <target-args...>" >&2
  exit 64
}

out_dir=""
keep=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --out) out_dir="${2:-}"; shift 2 ;;
    --keep) keep=1; shift ;;
    *) break ;;
  esac
done
[[ -n "$out_dir" && $# -ge 1 ]] || usage
agent_device="$1"
shift
target_args=("$@")

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$repo_root"
mkdir -p "$out_dir"
out_dir="$(cd "$out_dir" && pwd)"

device() { "$agent_device" "$@" "${target_args[@]}"; }
scheme="$(node --input-type=module -e 'import { J5_BRANDING } from "./scripts/lib/j5-branding.ts"; process.stdout.write(J5_BRANDING.mobile.development.scheme)')"
app_id="$(node --input-type=module -e 'import { J5_BRANDING } from "./scripts/lib/j5-branding.ts"; process.stdout.write(J5_BRANDING.mobile.development.appId)')"

base_dir="$(mktemp -d "${TMPDIR:-/tmp}/j5-mobile-scenes-XXXXXX")"
server_pid=""
port=""
paired=0
# Best effort: remove this run's connection so dead scene environments do not
# pile up in the app. Each step taps the control the snapshot names.
remove_connection() {
  local ref step
  device open "$app_id" "$scheme://connections" >/dev/null || return 0
  sleep 3
  for step in ":$port/" '"trash"' '[button] "Remove"'; do
    ref="$(device snapshot -i 2>/dev/null | grep -F "$step" | grep -o '^@e[0-9]*' | head -n 1)" || true
    [[ -n "$ref" ]] || { echo "Remove the scene connection on port $port by hand." >&2; return 0; }
    device click "$ref" >/dev/null || return 0
    sleep 1
  done
}
cleanup() {
  [[ "$paired" -eq 1 ]] && remove_connection
  if [[ -n "$server_pid" ]] && kill -0 "$server_pid" 2>/dev/null; then
    kill "$server_pid" 2>/dev/null || true
    wait "$server_pid" 2>/dev/null || true
  fi
  if [[ "$keep" -eq 0 ]]; then rm -rf "$base_dir"; else echo "Kept seeded home: $base_dir" >&2; fi
}
trap cleanup EXIT

echo "Seeding fixture threads in $base_dir"
receipt="$(node apps/server/src/j5/a2a/test-support/devDeliverySeedRunner.ts --base-dir "$base_dir")"
printf '%s\n' "$receipt" > "$out_dir/seed-receipt.json"

port="$(node -e 'const s=require("node:net").createServer().listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})')"
node apps/server/src/bin.ts serve --port "$port" --host 127.0.0.1 --base-dir "$base_dir" \
  > "$out_dir/server.log" 2>&1 &
server_pid=$!
for _ in $(seq 1 120); do
  curl -s -o /dev/null "http://127.0.0.1:$port/" && break
  kill -0 "$server_pid" 2>/dev/null || { echo "The scene server exited; see $out_dir/server.log" >&2; exit 1; }
  sleep 1
done
environment_id="$(cat "$base_dir/userdata/environment-id")"

.agents/skills/test-t3-mobile/scripts/pair-client.sh \
  "$port" "$base_dir" "http://127.0.0.1:$port" "$agent_device" "${target_args[@]}"
paired=1
sleep 5

# Hide the Expo dev-client floating button so it does not cover the header.
# Simulator defaults are only reachable through simctl; other targets keep it.
udid=""
for ((i = 0; i < ${#target_args[@]}; i++)); do
  [[ "${target_args[$i]}" == "--udid" ]] && udid="${target_args[$((i + 1))]:-}"
done
hide_dev_button() {
  [[ -n "$udid" ]] || return 0
  local key
  for key in EXDevMenuIsOnboardingFinished:true EXDevMenuShowFloatingActionButton:false EXDevMenuShowsAtLaunch:false; do
    xcrun simctl spawn "$udid" defaults write "$app_id" "${key%%:*}" -bool "${key#*:}" 2>/dev/null || return 0
  done
  device open "$app_id" --relaunch >/dev/null
  sleep 8
}

hide_dev_button

# The top of a thread is reached when a scroll no longer moves the screen. The
# simulator's status bar can still repaint a few pixels, so allow that much.
same_screen() {
  if command -v magick >/dev/null; then
    local changed
    changed="$(magick compare -metric AE "$1" "$2" null: 2>&1 | cut -d' ' -f1)" || true
    awk -v n="$changed" 'BEGIN { exit !(n + 0 < 2000) }'
  else
    cmp -s "$1" "$2"
  fi
}

# Frames run from the newest message upward and stop at the top of the thread.
capture_thread() {
  local name="$1" thread_id="$2" previous="" frame
  device open "$app_id" "$scheme://threads/$environment_id/$thread_id" >/dev/null
  sleep 5
  for index in $(seq 1 12); do
    frame="$out_dir/$name-$(printf '%02d' "$index").png"
    device screenshot "$frame" --pixel-density 2 --normalize-status-bar >/dev/null
    if [[ -n "$previous" ]] && same_screen "$previous" "$frame"; then
      rm -f "$frame"
      break
    fi
    previous="$frame"
    # Half a screen per step overlaps frames, so no message falls between them.
    device scroll up 0.5 --settle >/dev/null
    sleep 1
  done
  echo "Captured $name"
}

read_thread() {
  node -e 'const r=JSON.parse(process.argv[1]);process.stdout.write(r.threads[process.argv[2]].threadId)' "$receipt" "$1"
}
# The receiver holds the peer ask, silence source, machine message and unknown
# envelope; the sender holds the Inbox answer, silence notice and plain MCP send.
capture_thread receiver "$(read_thread receiver)"
capture_thread sender "$(read_thread sender)"

echo "Scenes written to $out_dir"
