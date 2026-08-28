# Run the registrar-backed cross-agent live proof

This is the human-supervised release proof for the J5 `spawn_agent` wrapper and the existing
Codex-to-Claude ask/reply pipeline. It is not CI and must not be described as completed until its
exact-head evidence has been reviewed.

The proof seeds only one Codex parent in disposable state. The production wrapper must create the
Claude child, register its immutable home, record spawned-by provenance and placement, and then make
the child addressable through `list_participants` and `send_message`.

## Safety boundary

- Run from a clean detached worktree at one reviewed commit.
- Keep the T3 home, workspace, browser state, logs, and SQL backup under fresh `/tmp` directories.
- Never point the proof at `~/.t3`, `~/.t3/userdata`, or another running T3 home.
- Use `fnm`, the repository Node version, pnpm, and repository-local `vp`; never Bun.
- Pairing URLs, cookies, raw server logs, and provider credentials are secrets. Do not print or
  include them in the proof report.
- Capture the server PID at launch and stop only that PID. Never kill by name, path, or pattern.
- A human must approve the real provider turns and browser use before section 4.

## 1. Prepare detached source and isolated state

Replace `<REVIEWED_HEAD>` and run in Bash from a clone containing that commit.

```bash
set -euo pipefail
umask 077

REPO_ROOT="$(git rev-parse --show-toplevel)"
PROOF_HEAD="<REVIEWED_HEAD>"
PROOF_PARENT="$(mktemp -d /tmp/j5-a6-source.XXXXXX)"
PROOF_SOURCE="$PROOF_PARENT/source"
PROOF_BASE="$(mktemp -d /tmp/j5-a6-live.XXXXXX)"
PROOF_WORKSPACE="$(mktemp -d /tmp/j5-a6-workspace.XXXXXX)"
PROOF_PORT=17661
PROOF_SESSION="j5-a6-live-$PROOF_PORT"
PWCLI="${CODEX_HOME:-$HOME/.codex}/skills/playwright/scripts/playwright_cli.sh"

git -C "$REPO_ROOT" worktree add --detach "$PROOF_SOURCE" "$PROOF_HEAD"
test "$(git -C "$PROOF_SOURCE" rev-parse HEAD)" = "$PROOF_HEAD"
test -z "$(git -C "$PROOF_SOURCE" status --short)"
git -C "$PROOF_WORKSPACE" init
NODE_VERSION="$(tr -d '[:space:]' < "$PROOF_SOURCE/.nvmrc")"

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

## 2. Start the watch-free server and pair once

The raw log can contain a pairing credential, so keep it private.

```bash
start_server() {
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
  until grep -Fq "Listening on http://127.0.0.1:$PROOF_PORT" "$SERVER_LOG"; do
    if ! kill -0 "$SERVER_PID" 2>/dev/null; then
      echo "The isolated server exited before listening; inspect its private log." >&2
      exit 1
    fi
    sleep 1
  done
}

stop_server() {
  kill "$SERVER_PID"
  wait "$SERVER_PID" || true
  if lsof -nP -iTCP:"$PROOF_PORT" -sTCP:LISTEN >/dev/null; then
    echo "The selected port remains open; investigate without killing by pattern." >&2
    exit 1
  fi
}

start_server

PAIR_RAW="$PROOF_BASE/pair.raw.log"
PAIR_BROWSER_RAW="$PROOF_BASE/pair-browser.raw.log"
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

pw open "$PAIR_URL" --headed >"$PAIR_BROWSER_RAW" 2>&1
unset PAIR_URL
rm -f "$PAIR_RAW" "$PAIR_BROWSER_RAW"
pw snapshot
```

In the authenticated UI, add only `PROOF_WORKSPACE` as a project and create one Codex thread. Send
this harmless first turn:

```text
Reply with exactly: A6 parent ready. Do not run commands, edit files, or call tools.
```

Record its durable app thread id as `PARENT_THREAD_ID`, then stop the isolated server. Do not infer a
provider-native session id.

```bash
PARENT_THREAD_ID="<APP_THREAD_ID_FROM_THE_AUTHENTICATED_UI>"
test -n "$PARENT_THREAD_ID"
stop_server
```

## 3. Controlled seed of the one parent

This is the only non-production step. It creates one Squadron and one registered root placement for
the existing Codex parent in the disposable database. The Claude child must not be seeded.

```bash
NONCE="$(date -u +%Y%m%dT%H%M%SZ)"
SQUADRON_ID="squadron:a6-live:$NONCE"
PARENT_PARTICIPANT_ID="agent:j5:a2a:$(
  fnm exec --using="$NODE_VERSION" node -e \
    'process.stdout.write(encodeURIComponent(process.argv[1]))' "$PARENT_THREAD_ID"
)"
CREATED_AT="$(date -u +%Y-%m-%dT%H:%M:%S.000Z)"
SEED_SQL="$PROOF_BASE/parent-seed.sql"

case "$SQUADRON_ID$PARENT_THREAD_ID$PARENT_PARTICIPANT_ID$CREATED_AT" in
  *"'"*) echo "Generated proof identifiers must not contain a SQL quote." >&2; exit 1 ;;
esac

cat >"$SEED_SQL" <<SQL
INSERT INTO j5_a2a_squadron (id, name, created_at)
VALUES ('$SQUADRON_ID', 'A6 live proof', '$CREATED_AT');

INSERT INTO j5_a2a_comm_event (
  seq, squadron_id, kind, sender, receiver, exchange_id, correlation_id, payload, created_at
) VALUES (
  1, '$SQUADRON_ID', 'participant.joined', NULL, '$PARENT_PARTICIPANT_ID', NULL, NULL,
  json_object('participant', json_object(
    'kind', 'agent', 'id', '$PARENT_PARTICIPANT_ID', 'threadId', '$PARENT_THREAD_ID'
  )), '$CREATED_AT'
);

INSERT INTO j5_a2a_comm_command_receipt (
  command_id, squadron_id, command_type, accepted_at, result_seq
) VALUES (
  'command:j5:a2a:live-proof:parent-home:$NONCE', '$SQUADRON_ID', 'comm.append',
  '$CREATED_AT', 1
);

INSERT INTO j5_a2a_squadron_membership (
  squadron_id, participant_id, participant_kind, thread_id, joined_seq, updated_seq, payload
) VALUES (
  '$SQUADRON_ID', '$PARENT_PARTICIPANT_ID', 'agent', '$PARENT_THREAD_ID', 1, 1,
  json_object('kind', 'agent', 'id', '$PARENT_PARTICIPANT_ID', 'threadId', '$PARENT_THREAD_ID')
);

INSERT INTO j5_a2a_placement_event (
  seq, command_id, request_fingerprint, squadron_id, participant_id, kind, actor,
  actor_session_id, actor_subject, auth_method, provenance_kind, provenance_participant_id,
  provenance_source, previous_parent_id, placement_parent_id, created_at
) VALUES (
  1, 'command:j5:a2a:live-proof:parent-placement:$NONCE',
  'controlled-live-proof-parent-seed-v1', '$SQUADRON_ID', '$PARENT_PARTICIPANT_ID',
  'participant.placement_created', 'platform', NULL, NULL, NULL, 'unknown', NULL, NULL,
  NULL, NULL, '$CREATED_AT'
);

INSERT INTO j5_a2a_participant_placement (
  squadron_id, participant_id, provenance_kind, provenance_participant_id,
  provenance_source, placement_parent_id, created_event_seq, updated_event_seq
) VALUES (
  '$SQUADRON_ID', '$PARENT_PARTICIPANT_ID', 'unknown', NULL, NULL, NULL, 1, 1
);
SQL

(
  cd "$PROOF_SOURCE"
  fnm exec --using="$NODE_VERSION" node apps/server/scripts/t3-sqlite-state.ts exec \
    --base-dir "$PROOF_BASE" --file "$SEED_SQL"
)
rm -f "$SEED_SQL"
start_server
```

The state helper creates a timestamped SQLite backup before the seed transaction. Keep that backup
with the evidence until review is complete.

## 4. Drive the real wrapper and ask/reply flow

Generate non-secret evidence markers:

```bash
ASK_TOKEN="A6-LIVE-ASK-$NONCE"
REPLY_TOKEN="A6-LIVE-REPLY-$NONCE"
OBSERVED_TOKEN="A6-LIVE-OBSERVED-$NONCE"
SPAWN_CLIENT_ID="a6-live-spawn-$NONCE"
ASK_CLIENT_ID="a6-live-ask-$NONCE"
REPLY_CLIENT_ID="a6-live-reply-$NONCE"
```

Send this prompt to the existing Codex parent:

```text
This is an isolated A6 live proof. Do not edit files or run shell commands.

1. Call orchestrator_capabilities and select the available Claude Code provider instance.
2. Call spawn_agent exactly once with clientRequestId="<SPAWN_CLIENT_ID>", mode="async", that Claude provider instance, and this task:
   "This is an isolated receiver proof. Do not edit files or run shell commands. Finish this initial turn without calling tools. Later, when a cross-agent envelope contains <ASK_TOKEN>, call send_message exactly once to the sender named in the envelope, using its exchange_id, message=<REPLY_TOKEN>, and client_request_id=<REPLY_CLIENT_ID>. Do not set expect_reply, intent, or urgency."
3. After spawn_agent returns, call list_participants. Select the new agent whose participantId differs from your own.
4. Call send_message exactly once to that participant with message=<ASK_TOKEN>, expect_reply=true, intent="Prove registrar-backed Codex-to-Claude delivery", and client_request_id=<ASK_CLIENT_ID>.
5. When a cross-agent reply contains <REPLY_TOKEN>, print <OBSERVED_TOKEN> and stop. Do not send another message.

Report the spawn childThreadId, child participantId, placement parent, ask messageId, and exchangeId.
```

Substitute the marker values before sending. Wait on actual tool receipts and completed turns, never a
fixed delay. The proof fails if the child receives the ask before `spawn_agent` returns, either
provider edits files or runs commands, a tool call is duplicated, or the observed token is missing.

Capture authenticated screenshots only after pairing; never capture a pairing URL or raw log.

## 5. Verify durable registrar, placement, lineage, and delivery state

Run read-only queries while the isolated server is alive:

```bash
query() {
  fnm exec --using="$NODE_VERSION" node \
    "$PROOF_SOURCE/apps/server/scripts/t3-sqlite-state.ts" query \
    --base-dir "$PROOF_BASE" --sql "$1"
}

query "
  SELECT seq, kind, receiver,
         json_extract(payload, '$.participant.threadId') AS joined_thread_id,
         json_extract(payload, '$.text') AS message_text
  FROM j5_a2a_comm_event
  WHERE squadron_id = '$SQUADRON_ID'
  ORDER BY seq
"

query "
  SELECT participant_id, provenance_kind, provenance_participant_id,
         provenance_source, placement_parent_id, created_event_seq
  FROM j5_a2a_participant_placement
  WHERE squadron_id = '$SQUADRON_ID'
  ORDER BY created_event_seq
"

query "
  SELECT command_id, result_seq
  FROM j5_a2a_comm_command_receipt
  WHERE squadron_id = '$SQUADRON_ID'
  ORDER BY result_seq
"

query "
  SELECT thread_id,
         json_extract(payload_json, '$.lineage.parentThreadId') AS parent_thread_id,
         json_extract(payload_json, '$.lineage.relationshipToParent') AS relationship
  FROM orchestration_v2_projection_threads
  WHERE thread_id = '$PARENT_THREAD_ID'
     OR json_extract(payload_json, '$.lineage.parentThreadId') = '$PARENT_THREAD_ID'
  ORDER BY created_at
"

query "
  SELECT thread_id, provider, status
  FROM orchestration_v2_projection_runs
  WHERE thread_id = '$PARENT_THREAD_ID'
     OR thread_id IN (
       SELECT json_extract(payload, '$.participant.threadId')
       FROM j5_a2a_comm_event
       WHERE squadron_id = '$SQUADRON_ID' AND kind = 'participant.joined'
     )
  ORDER BY requested_at
"

query "
  SELECT exchange_id, status, sender_id, receiver_id, opened_seq, closed_seq
  FROM j5_a2a_exchange
  WHERE squadron_id = '$SQUADRON_ID'
"

query "
  SELECT message_id, exchange_role, status, attempts, last_error, sent_seq, delivered_seq
  FROM j5_a2a_delivery
  WHERE squadron_id = '$SQUADRON_ID'
  ORDER BY sent_seq
"
```

Required evidence:

- Exactly two `participant.joined` events: controlled Codex parent first, wrapper-created Claude child
  second. The child receipt command starts with `command:j5:a2a:spawn:`.
- Exactly two placement rows. The parent is `unknown` at root. The child is `spawned-by` with
  `provenance_source='j5_wrapper'`, provenance participant equal to the parent, and placement parent
  equal to the parent.
- The child thread lineage says `relationship='subagent'` and names the Codex parent thread.
- The real runs include Codex for the parent and `claudeAgent` for the child.
- One closed exchange, two delivered messages, one attempt each, no `last_error`, and exactly one ask
  and reply token in the ledger.

Any missing registration, `unrecorded` child, root child placement, duplicate join, wrong provenance,
or non-Claude child is a failed proof.

## 6. Clean up without touching other processes

```bash
pw close
stop_server
rm -f "$SERVER_LOG"

git -C "$REPO_ROOT" worktree remove "$PROOF_SOURCE"
rmdir "$PROOF_PARENT"
```

Keep the exact `PROOF_BASE` and `PROOF_WORKSPACE` paths until the evidence is reviewed. A human may
then move those exact disposable directories to Trash. The proof report must name the tested commit,
Node version, providers, thread and participant ids, spawn/home/placement command ids, exchange and
message ids, ordered event sequences, delivery attempts, SQL backup path, and screenshot paths. It
must not include credentials or raw pairing/server output.
