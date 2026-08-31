---
title: "The agent tool surface — MCP verb contracts"
kind: spec
---

# Agent tool contracts (adopted 2026-08-29)

The definition of record for every verb on the J5 agent-facing MCP surface. [`substrate.md`](substrate.md)
rules _what_ is on the surface; this doc rules _what each verb is_ — and builders implement these
contracts rather than inventing them. **The description string is part of the contract**: it is the
agent-facing UX of the tool and is decided here, not at implementation time (Jackson, 2026-08-29).
Descriptions are written for the agent that reads them mid-turn: trigger first, distinct uses named,
positive instruction over negation.

## Conventions (apply to every J5 verb)

- **Naming**: snake_case verbs, snake_case parameters. (`spawn_agent`'s frozen A6 build used
  `clientRequestId` from the delegate passthrough; the rebuilt contract below corrects it.)
- **Idempotency**: every mutating verb accepts optional `client_request_id` — upstream's own
  pattern. Supplied, the server derives a stable command id from (provider session, request key),
  so retrying the same logical call replays the original result instead of double-acting. Omitted,
  the server mints a random key and each call is a fresh command — supply and reuse the id whenever
  you might retry. (The frozen A6 verbs required it; they relax to optional in the rebuild,
  2026-08-29.)
- **Errors** (the toolsmith rule, `plan.md`): failures return `{ code, message }` where the message
  names the _actual state_ and the _next command_ — callers must never have to discover state by
  failing twice.
- **Events**: every mutation commits ledger/placement events in the same transaction as its state
  change; the return happens after the sender-side commit, and delivery/side-effects continue
  asynchronously.
- **Duplication rule**: each mutating verb's description keeps its one-clause idempotency sentence
  even though this section covers it — the description is the only text an agent reliably reads at
  call time. Nothing else is duplicated.

---

## `send_message` — built (`j5/main`); description update is a small code ticket

**Description (contract):** "Send one durable message to another agent or the human. Three uses: a
**plain send** when you don't need a reply; an **ask** — set expect_reply=true with a one-line
intent, opening an exchange the receiver owes a reply to; a **reply** — include the exchange_id
from the ask you are answering, which closes that exchange. Use this tool only for participants
already returned by list_participants; when creating a Peer Agent, put any reply expectation in
spawn_agent's brief instead of sending a follow-up ask. Set urgency only when asking the human.
Returns once the message is committed; delivery continues asynchronously — carry on with your work,
and the reply arrives later as an incoming message. Reuse client_request_id to retry the same send
safely."

_(The shipped `send_message` and `list_participants` descriptions each append the current runtime
availability contract: the tool is unavailable to a native thread without a registered home
Squadron. That fail-closed home requirement remains current.)_

| Input               | Type              | Required                         | Meaning                                                |
| ------------------- | ----------------- | -------------------------------- | ------------------------------------------------------ |
| `to`                | ParticipantId     | yes                              | Directory-listed recipient                             |
| `message`           | string, non-empty | yes                              | Body; envelope adds sender identity/Squadron           |
| `client_request_id` | string            | no (yes for retries)             | Idempotency key                                        |
| `expect_reply`      | boolean           | no                               | Opens/joins an Exchange; requires `intent`             |
| `exchange_id`       | ExchangeId        | no                               | Marks this send as the reply that closes that Exchange |
| `intent`            | string            | with `expect_reply`              | One-line summary carried in projections                |
| `urgency`           | Urgency           | opening an Exchange to the human | Inbox priority                                         |

Result: `SendMessageResult` (message id, exchange state). Errors (each naming the actual state and
the next command): sender membership (`A2ASenderNotJoinedError` family); recipient not addressable
(with the `list_participants` next-command); `expect_reply` without `intent` (an ask must carry its
one-line intent); an `exchange_id` that is unknown, already closed, or not an exchange the caller
participates in (naming the exchange's actual state); opening an exchange to the human without
`urgency`. Events: message + exchange ledger events; delivery receipts follow asynchronously.

**Contract revision (ruled 2026-08-31, self-messaging):** `to` equal to the caller's own
participant id is rejected fail-closed — self-send is never legitimate (a self-Exchange is
degenerate: the caller would owe itself a reply and the silence detector would type its own
silence against it; the real self-shaped needs have dedicated verbs). Per the toolsmith rule, the
error names the caller's own participant id and the next commands: `list_participants` to find the
intended recipient and `schedule_task` for future-self triggers. Origin:
live test — an agent asked to message "the other agent" messaged itself.

**Product sequencing note (2026-08-31):** Memo is post-v0. When Memos ship, the error and tool
description gain Memo as the notes-to-self alternative; until then, shipped copy does not name it.

## `list_participants` — built (`j5/main`); contract revision: `display_name`

**Description (contract):** "Your address book: the participants around you — agents and the human —
with the display name to recognize them by, the participant_id to address them with, and what each
accepts (messages, exchanges, urgency). When you're told to message someone by name or role, resolve
them here first. Your own row is marked self=true; it cannot receive messages or open exchanges from
you — use schedule_task if you need a future trigger for yourself. Native threads that never
received a Squadron home do not appear here and cannot be messaged. The roster changes — after you
spawn an agent, or when a participant retires, call this again instead of reusing a stale listing."

**Contract revision (found 2026-08-29):** rows carry no display name today
(`AgentParticipant = {kind, id, threadId}`), which defeats the address-book purpose — "message the
product agent" must resolve a human-recognizable name to a `participant_id`. Every row gains
**`display_name`** (the agent's thread title now; the Role name when Roles land). Small code
ticket.

**Contract revision (ruled 2026-08-31, self-messaging):** the caller's own row is marked
**`self`** — the address book must answer "which one am I" before it can answer "who else is
there" (adopts the prior art's `[self]` marker; same live-test origin as `send_message`'s
self-send rejection). The description gains a clause telling the caller its own row is marked.

**Canonical description amendment (ratified 2026-08-31, decision #72):** the exact contract above
supersedes all partial drafts. It names the self row, native threads without a home, and roster
refreshes without naming an unshipped lifecycle verb.

No inputs. Result rows: `display_name`, `squadron_id`, `participant_id`, participant kind (thread
id for agents), `can_receive_message`, `can_open_exchange`, `accepts_urgency`, plus `provenance`
(`spawned-by` / `forked-from` / `unknown` / `not-applicable` for humans / `unrecorded`) and
`placement_parent_id` — org truth carried for callers and UI; deliberately not part of the
description's pitch. Read-only; no events.

## `spawn_agent` — rebuilt contract (root-thread Peer Agent spawn; supersedes the frozen A6 build)

**Description (contract):** "Spawn a Peer Agent: a full-citizen teammate with its own top-level
thread, starting on your brief as its first turn. It joins your Squadron, is placed under you, and
records you as its immutable spawner; it is addressable the moment this returns. In your brief,
tell the new agent what it should do first and whether it should reply to you. Choose provider,
model, and reasoning for the work in the brief — see orchestrator_capabilities for what's
available. Reuse client_request_id to retry the same spawn safely."

| Input               | Type                                 | Required | Meaning                                           |
| ------------------- | ------------------------------------ | -------- | ------------------------------------------------- |
| `brief`             | string, non-empty                    | yes      | The first-turn prompt the new agent starts with   |
| `title`             | string                               | no       | Thread title; derived from the brief when omitted |
| `provider`          | id from `orchestrator_capabilities`  | yes      | Chosen per task — no inherit default (Jackson,    |
|                     |                                      |          | 2026-08-29: inheriting is wrong more than right)  |
| `model`             | id from `orchestrator_capabilities`  | yes      | Chosen per task                                   |
| `reasoning`         | option from capabilities descriptors | yes      | Chosen per task                                   |
| `client_request_id` | string, non-empty                    | no       | Supply and reuse to make retries safe             |

Result: `participant_id`, `thread_id`, `squadron_id`, `placement` (parent = caller, provenance
`spawned-by`, source `j5_spawn`). Semantics: creates an ordinary **root-lineage** thread via the
upstream creation seam (never `delegate_task`), registers the immutable Squadron home (fail-closed:
refuses before creation if the caller's home no longer names an existing Squadron), records
placement + provenance atomically, then starts the first turn with the brief. Errors:
caller-membership state (missing/ambiguous, with the `list_participants` next-command), home
integrity, creation failure — each naming state and next command. Events: `participant.joined`,
home registration, `participant.placement_created`.

**Contract revision (ruled 2026-08-31, self-messaging):** the spawned agent's first-turn context
states its own `participant_id` and Squadron as platform-provided facts — the same class as the
envelope's sender identity, composed by the platform because they are measured, not judgment. A
fresh spawn is never id-blind about itself (live-test origin: an id-blind agent messaged itself).
The spawner's brief remains untouched — this rides beside it, never inside it.

**Contract clarification (ruled 2026-08-31, SP4):** the brief carries the initial task and whether
and what reply is expected. The spawner does not follow `spawn_agent` with a reply-expected
`send_message`; that Exchange form is for later work owed by an existing participant.

> **Spawning guide (settled 2026-08-30) — [`features/spawning-guide.md`](../features/spawning-guide.md).**
> SP4 closed this contract's held slot: the description's single sentence of brief steering above
> is the entire tool-side coaching — the report-back contract travels in the brief per the guide's
> conventions, and receipt-ACKs get no written law anywhere. SP3: provider/model/reasoning stay
> required and explicit even on Role-ful spawns — a Role's allowlist constrains the choice and an
> out-of-list pick is an error naming the excluding Role, never a silent default. Provider/model
> selection guidance and brief-writing conventions live in the guide, not here.

## `stop_agent` — single-target (amends the frozen A6 cascade contract)

**Description (contract):** "Stop one Peer Agent: interrupts its running turn now. The agent
remains, stays readable, and can be messaged again later — stopping halts work, it retires
nothing. Requires your current squadron_id. Reuse client_request_id to retry safely."

| Input               | Type              | Required                               |
| ------------------- | ----------------- | -------------------------------------- |
| `client_request_id` | string, non-empty | no (supply and reuse for safe retries) |
| `squadron_id`       | SquadronId        | yes (must be the caller's Squadron)    |
| `participant_id`    | ParticipantId     | yes (the one agent to stop)            |

Result: exactly one of `interrupt_requested` (a running turn is being interrupted) or
`already_idle` (no running turn; no side effect). Anything else is an error, not an outcome —
errors name the caller's actual Squadron and the corrected retry.

**Amendment (Jackson, 2026-08-29):** the A6 build cascaded over the placement subtree; that blast
radius makes the tool less useful, so `stop_agent` and `archive_agent` are single-target. The
unit-cascade concept already has its home in the crew rulings (2026-08-21: crews spawn and archive
as units) — `stop_crew`/`archive_crew` arrive with Crews, and the A6 `PlacementCascadeService`
survives as their engine (a cascade of one is its degenerate case).

## `archive_agent` — single-target, refuse-when-consequential with confirmation token

**Description (contract):** "Retire one Peer Agent for good. A clean archive — no open exchanges,
no running turn — completes immediately. Otherwise the call refuses and lists exactly what
archiving ends — the asks that will close, the turn that will stop — along with a
confirmation_token; call again with that token to proceed. The archived agent leaves the active
roster; its ledger and conversation stay readable forever. Requires your current squadron_id.
Reuse client_request_id to retry safely."

| Input                | Type              | Required                               |
| -------------------- | ----------------- | -------------------------------------- |
| `client_request_id`  | string, non-empty | no (supply and reuse for safe retries) |
| `squadron_id`        | SquadronId        | yes (must be the caller's Squadron)    |
| `participant_id`     | ParticipantId     | yes (the one agent to archive)         |
| `confirmation_token` | string            | only when confirming a refusal         |

Semantics — the agent-facing form of the archive-flow rulings (AR1–AR4): the **quiet clean path**
archives immediately when nothing would be cut short; the **loud path** is a refusal whose error
lists the concrete consequences (open exchanges that will close as dropped, the running turn that
will be interrupted) — the toolsmith rule doing the human dialog's job — plus a
`confirmation_token`. The token is issued with the fact list and is bound to it: it proves the
caller saw the consequences, so the confirmation cannot be short-circuited by a preemptive flag on
the first call (Jackson, 2026-08-29). If the target's state changed since the refusal, the stale
token is rejected and a fresh refusal lists the current facts. Result: exactly one of `archived`
or `already_archived` (no side effect); a consequential target yields the refusal above — an error
carrying the fact list and `confirmation_token` — never a partial outcome. Errors:
not-caller's-Squadron, unknown participant, consequential-without-token (the refusal), stale token
— each naming state and next command. Events: archive + the obligation-closure events for each
ended exchange (loud in the ledger, not just the dialog).

## `clear_own_ask` — ruled, unbuilt (inbox IB1b; substrate.md "needed-but-unbuilt")

**Description (contract):** "Withdraw an ask you sent: closes your open exchange without a reply
message. Use when the answer already arrived outside the exchange — for example, the human
answered you directly in your thread — so the obligation exits their inbox honestly. Only the
exchange's sender may clear it; the closure is recorded as sender-cleared, distinct from an
answered exchange. Reuse client_request_id to retry safely."

| Input               | Type              | Required                                        |
| ------------------- | ----------------- | ----------------------------------------------- |
| `exchange_id`       | ExchangeId        | yes (an exchange the caller opened, still open) |
| `client_request_id` | string, non-empty | yes                                             |

Result: the closed exchange state (id, closure kind `sender-cleared`, closed-at). Errors (each
naming state + next command): caller is not the exchange's sender; exchange already closed
(idempotent replay returns the original result instead when `client_request_id` matches); unknown
exchange id. Events: an exchange-closure ledger event distinguishable from reply-closure
(`sender-cleared`), so inbox status, exchange projections, and the eventual A5 graph render the
withdrawal honestly.

---

## Kept upstream tools (via `J5OrchestratorSurface`)

- **`orchestrator_capabilities`** — handler overridden. Response contract: providers and models
  (ids, labels, option descriptors) for spawn targeting, plus runtime/interaction mode facts. It
  stops advertising `appOwnedSubagents`, `canRunChildTask`, and delegation features entirely; J5
  verbs are advertised by their own descriptions, not by the capabilities payload.
- **`schedule_task`, `list_scheduled_tasks`, `update_scheduled_task`, `delete_scheduled_task`** —
  consumed as-is, upstream descriptions unchanged.
- **`t3_thread_list`, `t3_thread_read`, `t3_thread_wait`** — consumed as-is (observation is
  unregulated). If upstream descriptions reference `delegate_task`, the J5 surface re-declares the
  affected tool with corrected prose.
- **`create_threads` / `t3_thread_start`** — **SETTLED-OMITTED (Director disposition, 2026-08-31,
  under ST5's delegated realization; shipped fail-closed in the J5OrchestratorSurface).** Absent by
  construction from the agent surface. Admission requires a contract amendment HERE first (corrected
  descriptions included — the shipped upstream strings steer callers toward `delegate_task`), never a
  registration change alone. Supersedes substrate.md's open row.
