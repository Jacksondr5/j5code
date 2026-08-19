# Run the cross-agent messaging live proof

This is a human-run release proof for the cross-agent `join_epic`, `send_message`, and reply loop.
It is not a CI test, and it is not an instruction for an agent to start a server or browser. A human
must approve and supervise the real Codex and Claude provider turns.

The procedure was completed successfully at
`e1516b77dcb0e170ce4973523a63c071da07950d`. The commands and assertions below record that
workflow. The runbook itself has not been rerun end to end at every later commit, so record the exact
reviewed head used by each new proof.

## Safety boundaries

- Use a detached, clean worktree at one reviewed commit, with its own dependency installation.
- Put the T3 home, proof workspace, browser artifacts, logs, and screenshots under fresh `/tmp`
  directories. Never point the proof at the installed application's live T3 home or copy its settings,
  provider secrets, `.codex`, or `.claude` directories.
- Use `fnm`, the Node version in `.nvmrc`, pnpm, and the repository-local `vp`. Do not use Bun or a
  globally installed `vp`.
- Never print, paste into a report, or commit a pairing URL, token, cookie, raw server log, or provider
  credential. Pairing URLs are credentials.
- Never kill by process name, path, or pattern. Capture the server PID when it starts and stop only
  that PID. If the selected port is occupied, choose another port; do not kill its owner.
- Keep provider prompts free of credentials and repository data. Stop if either provider tries to edit
  files or run shell commands.

## 1. Prepare detached source and disposable state

Run these commands in Bash from the repository that contains the reviewed commit. Replace
`<REVIEWED_HEAD>` before running them.

```bash
set -euo pipefail
umask 077

REPO_ROOT="$(git rev-parse --show-toplevel)"
PROOF_HEAD="<REVIEWED_HEAD>"
PROOF_PARENT="$(mktemp -d /tmp/j5-a2-source.XXXXXX)"
PROOF_SOURCE="$PROOF_PARENT/source"
PROOF_BASE="$(mktemp -d /tmp/j5-a2-live.XXXXXX)"
PROOF_WORKSPACE="$(mktemp -d /tmp/j5-a2-workspace.XXXXXX)"
PROOF_PORT=17659
PROOF_SESSION="j5-a2-live-$PROOF_PORT"
PWCLI="${CODEX_HOME:-$HOME/.codex}/skills/playwright/scripts/playwright_cli.sh"

git -C "$REPO_ROOT" worktree add --detach "$PROOF_SOURCE" "$PROOF_HEAD"
test "$(git -C "$PROOF_SOURCE" rev-parse HEAD)" = "$PROOF_HEAD"
test -z "$(git -C "$PROOF_SOURCE" status --short)"
git -C "$PROOF_WORKSPACE" init

NODE_VERSION="$(tr -d '[:space:]' < "$PROOF_SOURCE/.nvmrc")"
fnm exec --using="$NODE_VERSION" node --version
(
  cd "$PROOF_SOURCE"
  fnm exec --using="$NODE_VERSION" pnpm install --frozen-lockfile
  fnm exec --using="$NODE_VERSION" pnpm exec vp run build
)

if lsof -nP -iTCP:"$PROOF_PORT" -sTCP:LISTEN >/dev/null; then
  echo "Choose an unused PROOF_PORT; do not stop the existing listener." >&2
  exit 1
fi
```

This intentionally builds with a fresh `node_modules` in the detached worktree. Do not reuse a
dependency directory from another checkout.

## 2. Start the watch-free server and hold the stability gate

The production `vp run start` path is watch-free. Keep the raw log private: startup output can contain
a pairing credential.

```bash
SERVER_LOG="$PROOF_BASE/server.raw.log"
(
  cd "$PROOF_SOURCE"
  env -u VITE_HTTP_URL -u VITE_WS_URL \
    T3CODE_HOME="$PROOF_BASE" \
    T3CODE_PORT="$PROOF_PORT" \
    T3CODE_HOST=127.0.0.1 \
    T3CODE_NO_BROWSER=true \
    T3CODE_AUTO_BOOTSTRAP_PROJECT_FROM_CWD=false \
    fnm exec --using="$NODE_VERSION" pnpm exec vp run start
) >"$SERVER_LOG" 2>&1 &
SERVER_PID=$!
echo "Captured server PID $SERVER_PID"

until grep -Fq "Listening on http://127.0.0.1:$PROOF_PORT" "$SERVER_LOG"; do
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    echo "The proof server exited before listening. Inspect the private log locally." >&2
    exit 1
  fi
  sleep 1
done

STABILITY_LINE=$(( $(wc -l < "$SERVER_LOG") + 1 ))
sleep 90
kill -0 "$SERVER_PID"
if tail -n +"$STABILITY_LINE" "$SERVER_LOG" | grep -Eq \
  'Restarting|shutdown reconciliation|terminalizedRuns'; then
  echo "The server changed lifecycle state during the 90-second gate; stop this proof." >&2
  exit 1
fi
echo "Watch-free server passed the 90-second no-restart gate."
```

Do not continue if the PID exits, the listener changes, or a restart/shutdown marker appears.

## 3. Pair Playwright once

The pairing command prints a one-time credential. Capture it without displaying it, open it once, and
delete both raw pairing outputs immediately after the browser redirects away from `/pair`.

```bash
PAIR_RAW="$PROOF_BASE/pair.raw.log"
BROWSER_RAW="$PROOF_BASE/pair-browser.raw.log"
(
  cd "$PROOF_SOURCE"
  fnm exec --using="$NODE_VERSION" node apps/server/src/bin.ts pair --base-dir "$PROOF_BASE"
) >"$PAIR_RAW" 2>&1
PAIR_URL="$(sed -n 's/^Pairing URL: //p' "$PAIR_RAW" | tail -n 1)"
test -n "$PAIR_URL"

pw() {
  (
    cd "$PROOF_BASE"
    PLAYWRIGHT_CLI_SESSION="$PROOF_SESSION" "$PWCLI" "$@"
  )
}

pw open "$PAIR_URL" --headed >"$BROWSER_RAW" 2>&1
unset PAIR_URL
rm -f "$PAIR_RAW" "$BROWSER_RAW"
pw snapshot
```

Take screenshots only after pairing has redirected to the authenticated app. Browser snapshots and
screenshots must not contain the pairing URL or any credential. Use `pw snapshot` after each
navigation before using element references; references are not stable across page changes.

## 4. Create the two real provider threads

In the authenticated UI:

1. Add only `PROOF_WORKSPACE` as a project. Do not add the source worktree or a personal project.
2. Create one stock Codex thread and one stock Claude Code thread. Record the two thread IDs and the
   participant IDs returned by `join_epic`.
3. Generate unique, non-secret values for this run:

   ```bash
   NONCE="$(date -u +%Y%m%dT%H%M%SZ)"
   EPIC_ID="epic:a2-live:$NONCE"
   ASK_TOKEN="A2-LIVE-ASK-$NONCE"
   REPLY_TOKEN="A2-LIVE-REPLY-$NONCE"
   OBSERVED_TOKEN="A2-LIVE-OBSERVED-$NONCE"
   ASK_CLIENT_ID="a2-live-ask-$NONCE"
   REPLY_CLIENT_ID="a2-live-reply-$NONCE"
   printf '%s\n' "$EPIC_ID" "$ASK_TOKEN" "$REPLY_TOKEN" "$OBSERVED_TOKEN" \
     "$ASK_CLIENT_ID" "$REPLY_CLIENT_ID"
   ```

The values are evidence markers, not credentials. Substitute them into the prompts below.

Send this initial prompt to Codex:

```text
This is an isolated cross-agent messaging live proof. Do not edit files or run shell commands. Call join_epic exactly once with epic_id="<EPIC_ID>". Report the returned epicId and participantId, then stop. Later, if a cross-agent message contains <REPLY_TOKEN>, do not call send_message again; print <OBSERVED_TOKEN> and stop.
```

Send this initial prompt to Claude:

```text
This is an isolated cross-agent messaging live proof. Do not edit files or run shell commands. Call join_epic exactly once with epic_id="<EPIC_ID>". Report the returned epicId and participantId, then stop. Later, when a cross-agent message contains <ASK_TOKEN>, call send_message exactly once to the sender named in the envelope, using the envelope exchange_id, message="<REPLY_TOKEN>", and client_request_id="<REPLY_CLIENT_ID>". Do not set expect_reply, intent, or urgency. Report the reply messageId and stop.
```

Wait for both completed `join_epic` tool receipts. Then send Codex:

```text
Call list_participants. Select the only agent participant whose participantId differs from your own. Call send_message exactly once with to=<that participantId>, message="<ASK_TOKEN>", expect_reply=true, intent="Prove live Codex-to-Claude ask/reply delivery", and client_request_id="<ASK_CLIENT_ID>". Do not send anything else. Report messageId, exchangeId, exchangeState, and durableAtSeq.
```

Wait on actual turn completion and tool receipts, not a fixed delay. Confirm in the UI that:

- Codex reports one ask with a message ID and open exchange ID.
- Claude receives exactly one rendered cross-agent envelope containing the ask token and that exchange
  ID, then sends exactly one reply with the reply token.
- Codex receives exactly one rendered reply envelope, prints the observed token, and does not call
  `send_message` again.

Capture screenshots of these authenticated results only. Treat an extra message, duplicate tool call,
missing receipt, provider restart, or file/shell action as a failed proof.

## 5. Verify durable state

Run read-only queries while the server is still alive. This helper uses the repository's SQLite
inspection command against only the disposable T3 home.

```bash
query() {
  fnm exec --using="$NODE_VERSION" node \
    "$PROOF_SOURCE/apps/server/scripts/t3-sqlite-state.ts" query \
    --base-dir "$PROOF_BASE" --sql "$1"
}
```

The ledger must contain exactly eight ordered events:

```bash
query "
  SELECT seq, kind, sender, receiver, exchange_id,
         json_extract(payload, '$.text') AS message_text,
         json_extract(payload, '$.attempt') AS attempt
  FROM j5_a2a_comm_event
  WHERE epic_id = '$EPIC_ID'
  ORDER BY seq
"
```

The expected kinds, in order, are:

1. `participant.joined`
2. `participant.joined`
3. `exchange.opened`
4. `message.sent` with the ask token
5. `message.delivered` with attempt `1`
6. `message.sent` with the reply token
7. `exchange.closed`
8. `message.delivered` with attempt `1`

Check the closed exchange and both successful deliveries:

```bash
query "
  SELECT exchange_id, status, sender_id, receiver_id, opened_seq, closed_seq
  FROM j5_a2a_exchange
  WHERE epic_id = '$EPIC_ID'
"

query "
  SELECT message_id, exchange_role, status, attempts, last_error, sent_seq, delivered_seq
  FROM j5_a2a_delivery
  WHERE epic_id = '$EPIC_ID'
  ORDER BY sent_seq
"
```

Expect one `closed` exchange with `opened_seq=3` and `closed_seq=7`. Expect two `delivered` rows,
each with `attempts=1` and `last_error` null; their `delivered_seq` values must be `5` and `8`.

Prove that there are no alarms and both delivery ledger receipts exist:

```bash
query "
  SELECT COUNT(*) AS alarm_count
  FROM j5_a2a_comm_event
  WHERE epic_id = '$EPIC_ID' AND kind = 'message.delivery_alarm'
"

query "
  SELECT command_id, result_seq
  FROM j5_a2a_comm_command_receipt
  WHERE epic_id = '$EPIC_ID'
    AND command_id LIKE 'command:j5:a2a:delivered:%'
  ORDER BY result_seq
"
```

Expect `alarm_count=0` and exactly two delivery receipts at result sequences `5` and `8`.

Prove the two accepted upstream dispatch receipts:

```bash
query "
  SELECT command_id, aggregate_id, status, command_type, result_sequence
  FROM orchestration_command_receipts
  WHERE command_id LIKE 'command:j5:a2a:delivery:%'
    AND (command_id LIKE '%$ASK_CLIENT_ID%' OR command_id LIKE '%$REPLY_CLIENT_ID%')
  ORDER BY result_sequence
"
```

Expect exactly two rows with `status='accepted'` and `command_type='message.dispatch'`.

Finally, prove the durable injected messages contain both rendered envelopes:

```bash
query "
  SELECT message_id, thread_id,
         json_extract(payload_json, '$.creationSource') AS creation_source,
         json_extract(payload_json, '$.text') AS text
  FROM orchestration_v2_projection_messages
  WHERE json_extract(payload_json, '$.creationSource') = 'mcp'
    AND (
      json_extract(payload_json, '$.text') LIKE '%$ASK_TOKEN%'
      OR json_extract(payload_json, '$.text') LIKE '%$REPLY_TOKEN%'
    )
  ORDER BY created_at
"
```

Expect exactly two rows with `creation_source='mcp'`. Each must start with `[Cross-agent message`,
contain the corresponding evidence token, and contain the concrete exchange ID used by the reply.

Confirm that the joined agent threads ran on the two intended real providers:

```bash
query "
  WITH joined AS (
    SELECT DISTINCT json_extract(payload, '$.participant.threadId') AS thread_id
    FROM j5_a2a_comm_event
    WHERE epic_id = '$EPIC_ID' AND kind = 'participant.joined'
  )
  SELECT DISTINCT runs.thread_id, runs.provider
  FROM orchestration_v2_projection_runs AS runs
  JOIN joined ON joined.thread_id = runs.thread_id
  ORDER BY runs.provider
"
```

Expect one Codex thread and one Claude Code (`claudeAgent`) thread. Save query output and
post-pairing screenshots under `PROOF_BASE`; do not save raw credentials.

## 6. Clean up without touching other processes

Close the named Playwright session, then stop only the captured server PID:

```bash
pw close
kill "$SERVER_PID"
wait "$SERVER_PID" || true

if lsof -nP -iTCP:"$PROOF_PORT" -sTCP:LISTEN >/dev/null; then
  echo "The selected port is still open; investigate without killing by pattern." >&2
fi

rm -f "$SERVER_LOG"

git -C "$REPO_ROOT" worktree remove "$PROOF_SOURCE"
rmdir "$PROOF_PARENT"
```

Keep the exact `PROOF_BASE` and `PROOF_WORKSPACE` paths with the proof record until the evidence is
reviewed. A human may then move those exact disposable directories to Trash. Do not use a recursive
deletion command with an unset variable, glob, home directory, repository root, or workspace root.

The proof report must name the tested commit, Node version, providers, thread/participant IDs,
message/exchange IDs, ordered event sequence, delivery attempts, alarm count, and captured evidence
paths. It must not include pairing URLs, tokens, cookies, or provider credentials.
