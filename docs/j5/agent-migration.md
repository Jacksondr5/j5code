---
title: "Agent migration runbook — moving a live agent into J5 with memory intact"
kind: spec
---

# Agent migration runbook

Hand-surgery to move a long-running agent — its conversation memory intact, continuing mid-thought —
from one environment into a J5 Code environment as a real Squadron citizen. Scope ruling (Jackson):
this is **not a product feature**. It is MacGyver-grade surgery — copying files and driving the app
directly is sanctioned. There is no import UI, no adopt-session code path.

Two stages, one mechanism:

- **Stage 1 — Traycer → local J5 on the Mac** (the first destination, dogfooded first).
- **Stage 2 — local J5 → the Linux box** (later; same mechanics, credentials differ).

Everything below was measured at `j5/main`, and the load-bearing claims were **proven live** on
2026-09-01, not inferred. Read-only on all real source state; work on copies.

## What is proven

| Claim                                                           | Proof                                                                                                                                                                                                                                                                                                                                                      |
| --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A copied provider session resumes with memory intact            | Bare-CLI resume of a retired agent's session answered a memory-only question verbatim.                                                                                                                                                                                                                                                                     |
| A re-selected model overrides the session's original pin        | Resumed an opus 1M-context session on `sonnet` / `Fable 5` with no "does not support this model" error.                                                                                                                                                                                                                                                    |
| Memory resumes **through the full J5 server**, not just the CLI | Grew a carrier thread in a real J5 env, swapped a retired agent's transcript under its session uuid, drove the next turn through the J5 UI — the agent answered from the transplanted memory (PR title, merge sha, and a specific refuted-finding detail present only in that agent's history). Run reached provider-turn ordinal 2: the resume arm fired. |
| J5 hands the CLI the default `~/.claude` config dir             | The carrier session landed at `~/.claude/projects/<munged-cwd>/`; auth succeeded via the macOS keychain with no credential surgery.                                                                                                                                                                                                                        |

Honest line, ruled and accepted: **conversation memory resumes; the J5-visible transcript starts at
transplant.** Backfilling the old transcript into the visible timeline is optional surgery, never
promised (see [Optional: visible-transcript backfill](#optional-visible-transcript-backfill)).

## The mechanism the runbook rests on

An agent's memory lives in its **provider session file**, not in J5's database:

- **Claude**: a JSONL at `<config-dir>/projects/<munged-cwd>/<session-uuid>.jsonl`. J5 stores the
  uuid in the provider-thread projection's `nativeThreadRef.nativeId` and resumes it by spawning
  `claude --resume=<uuid>` with the thread's cwd. The resume arm is taken whenever the provider
  thread already has a native ref and a prior provider turn exists (`ProviderTurnStartService`,
  `ClaudeAdapterV2`).
- **Codex**: a rollout under `<CODEX_HOME>/sessions/…`, resumed by a `thread/resume` JSON-RPC call
  keyed on the native thread uuid. Codex resolves uuid → rollout through its own internal state db
  (`sqlite/`), so a transplant must satisfy that store, not merely drop a file (measure per Codex
  bench; do not infer from error strings).

**The munge rule** (cwd → project-dir name): every `/`, `.`, and `_` becomes `-`. Measured against a
real recorded cwd, `/tmp/...` resolves to `/private/tmp/...` first — so **derive the munge from the
cwd J5 actually records, never from the path you typed.**

### The recommended technique: content-swap, not event-authoring

Do **not** hand-write J5's event chain for a thread. J5 verifies projections against the event log
at startup and, on any mismatch, **rebuilds every projection from events** — hand-written projection
rows are wiped. Instead:

1. Let the J5 server **grow a carrier thread naturally** — create it in the destination Squadron and
   run one trivial turn. J5 writes a perfect, valid event chain and mints its own session uuid.
2. **Swap the memory in**: overwrite that uuid's session file with the migrated agent's transcript
   (retarget its internal `sessionId` and `cwd` to the carrier's; leave the message/`parentUuid`
   chain intact).
3. Drive the next turn. The adapter takes the resume arm and continues the transplanted session.

This needs **zero database surgery**: the DB is untouched, so startup verify passes and no rebuild
fires. It is far less fragile than authoring provider-thread events by hand, and J5 citizenship
(Squadron home, placement, provenance) comes free from having created the carrier in the Squadron.

## Stage 1 — Traycer → local J5 on the Mac

### Operator prep (do this first, then stop)

1. Stand up the local J5 environment (`dogfood-local.sh --fresh`, or equivalent), state at
   `~/.j5code` (never `~/.t3`, never `~/.j5code` reused with `--fresh` after you start).
2. Create the destination Squadron through the first-run gate: any name (no constraints), one folder
   = your repo clone. **Then stop.** Do not create threads or agents in it — the migration
   hand-creates the carrier threads so their ids, provider refs, and placement are controlled.
3. Read back and record: the base dir, the Squadron id and project id
   (`SELECT id, name FROM j5_a2a_squadron;` `SELECT project_id FROM projection_projects;`).
4. **The carrier's cwd — RULED (Jackson): the Squadron folder itself, the repo clone on `j5/main`,
   for all five core agents. Not per-agent worktrees.** These are long-standing non-coding agents
   (they read/write docs repo-direct on `j5/main`, commission work, never build features in
   branches); worktrees would fragment their commits for no benefit, and they already share the
   clone under Traycer today. Create each carrier as a **local thread on the Squadron folder** — the
   `chat.newLocal` door (`mod+shift+n`, converted in #35), which resolves the Squadron destination
   and starts a thread on its folder. **Confirmed live:** this "current checkout" path records the
   thread's cwd as the folder itself, no worktree (the Stage-1 proof used exactly it).

   **Consequence — one munged key for all five, and it is the key memory already lives under.** With
   cwd = `~/repos/jacksondr5/j5code`, the key is `-Users-jackson-repos-jacksondr5-j5code`. Measured
   against the real source: Traycer keys auto-memory by **repo path, not worktree cwd**, so the J5
   agents' memory is _already_ one shared dir under exactly that key (12 files). The memory move is
   therefore **config-dir-only** — same key, new root (`~/.claude/projects/<key>/memory/`). The one
   exception is the Director, whose memory sits under the upstream `t3code` repo key (5 files); it
   merges into the shared dir. Collision check across every source memory dir: **only `MEMORY.md`
   collides** — it is the per-dir index, present everywhere by design — so merge the two indexes
   (concatenate entries), never overwrite; every other file (including the Director's
   `fleet-app-project.md`, the plausible-collision case) has a unique name and copies cleanly. No
   per-agent subfolder or prefix is needed. Sharing one memory dir is the status quo, not a new
   hazard.

   Two mitigations to carry forward: (i) the memory files are **not auto-loaded by J5 today** anyway
   (see [Auto-memory](#auto-memory)), so nothing depends on this dir until the adapter change lands;
   (ii) **when that adapter change lands, key auto-memory PER THREAD** — the SDK's
   `autoMemoryDirectory` is configurable per query — rather than per cwd, so cwd choice stops being
   coupled to memory identity. Write that into the adapter-change spec.

   **Git contention** with five agents on one checkout is the status quo under Traycer; noted, not
   solved here.

   (Why not the agents' old Traycer worktree paths: they exist on the Mac but are
   housekeeping-prunable and, for the Director, a worktree of upstream `t3code`; and Stage 2 forces a
   rename regardless. Moot under this ruling — the Squadron folder is the same clone they already
   use.)

**Must not, before import:** re-run any `--fresh` after the Squadron exists (wipes state); archive,
delete, or recreate the Squadron (its id changes and breaks the citizenship rows); log out of Claude
in `~/.claude` (kills the keychain auth resume relies on). Pin the runtime checkout sha and confirm
the installed Claude CLI supports the model each thread will run.

### The transplant, per agent

1. **Copy the session file** (read-only on the source): from the Traycer harness account,
   `harness-accounts/claude-code/<acct>/projects/<munged-traycer-worktree>/<uuid>.jsonl`. Keep the
   original untouched.
2. **Grow the carrier**: in the destination Squadron, create a thread on the agent's chosen cwd and
   send one trivial message (e.g. "reply READY"). Let it complete.
3. **Read the carrier's session uuid** from the DB:
   `SELECT json_extract(payload_json,'$.nativeThreadRef.nativeId') FROM
orchestration_v2_projection_provider_threads WHERE …` — and confirm `nativeConversationHeadRef`
   is null (a non-null head ref would force `--resume-session-at` at a message uuid the transplant
   lacks).
4. **Stop the server.**
5. **Swap**: overwrite `~/.claude/projects/<munge(cwd)>/<carrier-uuid>.jsonl` with the copied
   transcript, rewriting every record's `sessionId` to the carrier uuid and `cwd` to the carrier's
   recorded cwd. Back up the carrier's own turn-1 file first.
6. **Restart the server** with the same base dir. No rebuild fires (DB untouched).
7. **Verify before the first resumed turn** (Claude has no resume-failure safety net — a bad
   transplant surfaces only as a failed turn, not a graceful fallback): confirm the JSONL sits under
   the exact munged project dir for the thread's cwd, named `<carrier-uuid>.jsonl`, last record a
   clean completed state.
8. **Send the orientation message as the FIRST resumed turn** (mandatory — see below), then confirm
   memory recall on the turn after. Set the model explicitly to a currently-supported one.

### A2A history and the tool-surface change across the move

The migrated agent's transcript is full of its old Traycer coordination. Measured against a real
session: **inbound A2A** appears as user-turn text carrying the `[traycer:agent-message] from …`
prefix, and **outbound A2A** appears as `tool_use` blocks for `mcp__traycer_a2a__*` tools
(`traycer_send_message`, etc.). Two consequences:

- **None of that pre-transplant history renders in the J5 timeline** — it is model context only, per
  the honest line. The agent _remembers_ its A2A exchanges; J5 does not _display_ them.
- **The history references tools that do not exist in J5's toolset.** J5 exposes `send_message`,
  `list_participants`, `spawn_agent`, `stop_agent`, `archive_agent`, `clear_own_ask` — not the
  `mcp__traycer_a2a__*` or `traycer_*` tools the transcript is full of. **Resuming a session whose
  history contains those dead tool_use blocks works with no API error** — proven in the Stage-1
  live run (the resumed session was dense with `mcp__traycer_a2a__traycer_send_message` blocks and
  completed its turn normally). The risk is not a crash; it is the agent _reaching for a dead tool_
  on its next turn out of habit.

**Therefore a first-turn orientation message is mandatory.** Send it as the very first resumed turn,
before any real work, so the agent re-maps its tools before it acts. Template:

> You have been migrated into J5 Code, and your memory has carried over — everything you remember is
> still valid. Three things have changed and take effect now:
>
> 1. You are a Peer Agent in the J5 Squadron **"<squadron-name>"**. Your prior Traycer epic/agents
>    are not here; your peers are the participants J5 lists.
> 2. **Your tools changed.** The Traycer tools you used before (`traycer_send_message`,
>    `traycer_create_agent`, `traycer_get_transcript`, every `mcp__traycer_a2a__*`) **no longer
>    exist**. Your A2A surface is now: `list_participants` (your address book — call it first),
>    `send_message` (plain send / ask with `expect_reply` / reply with `exchange_id`), `spawn_agent`,
>    `stop_agent`, `archive_agent`, `clear_own_ask`. Do not call any `traycer_*` tool.
> 3. **The human is reached through the inbox** — `send_message` to the human participant (with
>    `urgency` when it is an ask), not a Traycer channel.
>
> Acknowledge this re-map in one line, then resume where you left off.

Adjust the tool list to the J5 toolset actually installed at migration time.

### Leave the transplanted history verbatim — do not rewrite the Traycer prefix

Jackson asked whether the `[traycer:agent-message] …` prefix in inbound history should be rewritten
to J5's envelope format. **Ruled: no. Leave history verbatim; the orientation turn does the re-map.**

Measured, so the reasoning is precise. The rewrite is **structurally safe**: the record format has
**no content hashes or checksums** (59 distinct keys, none integrity-related); the parser treats
message text as opaque; and the `uuid`/`parentUuid` chain that the CLI reconstructs the conversation
from is purely structural (487 uuids, 0 dangling refs) and untouched by editing content strings. A
JSON-escaped string edit inside a content field would not corrupt the file.

It is **semantically hazardous**, which is why it is not recommended:

- Rewriting inbound history to look like J5 envelopes **fabricates deliveries and exchange ids that
  never existed in J5's ledger** — the agent would then remember J5 exchanges the communication
  graph has no record of, and could try to reply to or clear them.
- The **outbound** side stays as it is: `mcp__traycer_a2a__*` tool_use blocks. Rewriting only the
  inbound prefix leaves the history internally inconsistent (J5-shaped envelopes answered by
  Traycer-shaped sends).
- It buys nothing the orientation turn does not: the agent needs to know its tools changed, not to
  have its past re-labeled.

If someone does it anyway (documented non-recommended option): edit only inside content strings,
never touch `uuid`/`parentUuid`/`sessionId`/structure, and expect the semantic inconsistencies
above.

### Auto-memory

Auto-memory is a **native Claude Agent SDK capability** (`autoMemoryEnabled` / `autoMemoryDirectory`),
keyed to `projects/<sanitized-cwd>/memory` under the config dir — the **same cwd-derived key** as the
session file. But **J5's Claude adapter does not currently enable it** (it passes the `claude_code`
system-prompt preset and no memory option). Consequences and options:

- Place each agent's memory dir at `~/.claude/projects/<munge(cwd)>/memory/` (copied from the
  Traycer harness account's `projects/<munged-traycer-worktree>/memory/`) so it is co-located with
  the session under the same key.
- To make it **auto-load**, either (a) enable `autoMemoryEnabled` (and optionally point
  `autoMemoryDirectory`) in J5's Claude adapter — a small code change — or (b) low-touch:
  materialize the memory files as a `CLAUDE.md` in the agent's cwd, which the `claude_code` preset
  loads natively with no code change.
- Confirm the chosen path in a Stage-1 dry run before trusting it. Conversation memory resumes
  regardless; this is only about the standalone memory _files_.

## Stage 2 — local J5 → the Linux box

Same mechanism (state dir + session files + project-key rename); what differs:

- **Credentials.** The Mac gates the Claude OAuth token in the keychain, so an isolated config dir
  reports "Not logged in" until it has its own login. On the Linux box, log in to Claude on the box
  so credentials are **file-based** in the config dir the J5 instance uses — no keychain wall. If
  the J5 instance sets `ClaudeSettings.homePath`, the session and memory go under that dir's
  `projects/<munged-cwd>/`; if not, `~/.claude`.
- **cwd and munge.** Recompute the munged project dir from the Linux cwd (different absolute path →
  different key). Move each session file and memory dir to the new key.
- **Model support.** Confirm the box's installed Claude CLI supports each thread's pinned model;
  re-select a supported model at the first resumed turn (the five core agents are Fable-pinned).

## Failure taxonomy — classify before concluding

If a resumed turn fails, it is one of three distinct classes; identify which before touching the
surgery:

1. **Model / CLI pin** — a 400 "does not support this model". Cause: the CLI can't run the requested
   model. Fix: re-select a currently-supported model at the turn; do not blame the transplant.
2. **Transplant** — session-not-found / wrong munged dir / corrupt JSONL. Cause: the file is not
   where the CLI looks, or is malformed. Fix: recheck the munge (from the recorded cwd) and the
   file.
3. **Auth** — "Not logged in · Please run /login". Cause: the config dir has no login (the macOS
   keychain does not extend to a fresh config dir). Fix: this is provider- and OS-specific; on the
   Mac use the keychain-authed `~/.claude`, on Linux establish file-based creds.

## Optional: visible-transcript backfill

To also show the migrated agent's **past transcript** in the J5 timeline (beyond the default "starts
at transplant"), two lanes exist, both real surgery:

- The legacy-import machinery's row-seed path, or direct synthetic history — a minimum of two
  `turn-item.updated` events per past exchange (`user_message` + `assistant_message`, `runId` and
  `nodeId` null), with the ordinal pre-seeded in `orchestration_v2_turn_item_positions`.
- Gotcha: a client holding a partial (paginated) timeline **silently drops** live-injected items
  whose ordinal is at or below what it already has — backfilled history appears only after a fresh
  snapshot / history-page fetch.

Recommendation: ship the default honest line; treat backfill as an optional extra, not a promise.

## Evidence

The Stage-1 DB-half proof (2026-09-01): isolated `j5/main` env; carrier thread grown and its session
swapped with a retired reviewer's real transcript; the resumed turn, driven through the J5 UI on a
re-selected model, recalled the reviewer's merged PR, its sha, and a specific refuted-finding detail
absent from the carrier's visible transcript. Screenshot and the resumed session file retained under
the run's scratch directory.
