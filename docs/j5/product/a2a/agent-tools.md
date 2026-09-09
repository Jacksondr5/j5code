---
title: "The agent tool surface — verb contracts"
kind: definition
---

# The agent tool surface

## Problem

An agent learns what it can do from its tools, and it reads a tool's description in the middle of its work, once, under pressure. If the description is written by whoever happens to implement the tool, the agent-facing product is decided by accident. This definition states each verb on the J5 agent surface — what it does, what it takes, what it returns, how it fails — and the description string is part of the contract, because the description _is_ the agent's experience of the product. [The substrate definition](substrate.md) decides which verbs exist; this one decides what each verb is.

## Definition

### Conventions for every verb

- **Naming**: snake_case verbs and parameters.
- **Idempotency**: every mutating verb accepts an optional `client_request_id`. When supplied, retrying the same logical call replays the original result instead of acting twice; when omitted, each call is a fresh command. Every mutating verb's description carries its own one-clause reminder to reuse the id, because the description is the only text an agent reliably reads at call time.
- **Errors — the toolsmith rule**: a failure returns a code and a message, and the message names the _actual state_ and the _next command_, so a caller never has to discover state by failing twice.
- **Events**: every mutation commits its ledger and placement events in the same transaction as its state change; the call returns after that commit, and delivery and other side effects continue asynchronously.
- **Descriptions** are written for the agent reading them mid-turn: trigger first, distinct uses named, positive instruction over negation, and no more than the agent needs to act.

### `send_message`

**Description:** "Send one durable message. To another agent, three uses: a **plain send** when you don't need a reply; an **ask** — set expect_reply=true with a one-line intent, opening an exchange the receiver owes a reply to; a **reply** — include the exchange_id from the ask you are answering, which closes that exchange. To the human, only an ask: a plain send to a person is refused — if nobody needs to act, say it in your own thread instead. You may have several asks open with the same person; to follow up on one that is still open, name it in regarding and your message joins it. Set urgency only when asking the human. Use this tool only for participants already returned by list_participants; when creating a Peer Agent, put any reply expectation in spawn_agent's brief instead of sending a follow-up ask. Returns once the message is committed; delivery continues asynchronously — carry on with your work, and the reply arrives later as an incoming message. Reuse client_request_id to retry the same send safely."

| Input               | Type              | Required                             | Meaning                                                                         |
| ------------------- | ----------------- | ------------------------------------ | ------------------------------------------------------------------------------- |
| `to`                | ParticipantId     | yes                                  | A recipient listed by `list_participants`; a person accepts only an ask         |
| `message`           | string, non-empty | yes                                  | The body; the envelope adds sender identity and Squadron                        |
| `expect_reply`      | boolean           | no                                   | Opens an Exchange (or, between agents, joins the open one); requires `intent`   |
| `intent`            | string            | with `expect_reply`                  | One-line summary shown wherever the Exchange is listed                          |
| `urgency`           | Urgency           | when opening an Exchange to a person | How soon the answer is needed                                                   |
| `regarding`         | ExchangeId        | no                                   | Follow up on an open Exchange you opened with this person; the message joins it |
| `exchange_id`       | ExchangeId        | no                                   | Marks this send as the reply that closes that Exchange                          |
| `client_request_id` | string            | no                                   | Reuse to retry safely                                                           |

**Result:** the message id and the Exchange's state.

**Rules.** A message to the caller itself is refused. A send to a person that is not an ask is refused; a person never opens an Exchange, so there is nothing for an agent to reply to. Between agents, a further ask to a peer that already holds an open Exchange from the caller joins it as a follow-up. To a person, a further ask opens a new Exchange and a new inbox item unless it names an open one in `regarding`, in which case it joins that Exchange and is shown beneath the original ask. An ask to a person without an urgency is refused.

**Errors**, each naming the actual state and the next command: the caller has no Squadron home; the recipient is not addressable (pointing at `list_participants`); the recipient is the caller (naming the caller's own id, and `schedule_task` for a future trigger to oneself); an ask without an intent; a send to a person that is not an ask (naming the legal move and the own-thread alternative); an ask to a person without urgency; an `exchange_id` or `regarding` that is unknown, already closed, or not the caller's (naming the Exchange's actual state).

**Events:** message and Exchange events in the ledger; delivery receipts follow asynchronously.

### `list_participants`

**Description:** "Your address book: the participants around you — agents and the human — with the display name to recognize them by, the participant_id to address them with, and what each accepts (messages, exchanges, urgency). When you're told to message someone by name or role, resolve them here first. Your own row is marked self=true; it cannot receive messages or open exchanges from you — use schedule_task if you need a future trigger for yourself. Native threads that never received a Squadron home do not appear here and cannot be messaged. The roster changes — after you spawn an agent, or when a participant retires, call this again instead of reusing a stale listing."

No inputs. Read-only; no events.

**Result rows:** `display_name` (the agent's thread title, or the Role name once Roles exist), `squadron_id`, `participant_id`, the participant kind, `self`, `can_receive_message`, `can_open_exchange`, `accepts_urgency`, plus `provenance` (spawned by whom, forked from what, unrecorded, or not applicable for a person) and `placement_parent_id`. A person's row reports that it cannot receive a plain message and can be asked. Provenance and placement are carried for callers and the UI; they are not part of the description's pitch.

### `spawn_agent`

**Description:** "Spawn a Peer Agent: a full-citizen teammate with its own top-level thread, starting on your brief as its first turn. It joins your Squadron, is placed under you, and records you as its immutable spawner; it is addressable the moment this returns. In your brief, tell the new agent what it should do first and whether it should reply to you. Choose provider, model, and reasoning for the work in the brief — see orchestrator_capabilities for what's available. Reuse client_request_id to retry the same spawn safely."

| Input               | Type                                     | Required | Meaning                                                             |
| ------------------- | ---------------------------------------- | -------- | ------------------------------------------------------------------- |
| `brief`             | string, non-empty                        | yes      | The first-turn prompt; carries the task and whether a reply is owed |
| `title`             | string                                   | no       | The thread title; derived from the brief when omitted               |
| `provider`          | id from `orchestrator_capabilities`      | yes      | Chosen per task — there is no inherited default                     |
| `model`             | id from `orchestrator_capabilities`      | yes      | Chosen per task                                                     |
| `reasoning`         | option from the capabilities descriptors | yes      | Chosen per task                                                     |
| `client_request_id` | string                                   | no       | Reuse to retry safely                                               |

**Result:** `participant_id`, `thread_id`, `squadron_id`, and the placement (parent is the caller; provenance is spawned-by the caller).

**Rules.** The new agent is an ordinary root-lineage thread created through upstream's creation seam, never through delegation. Its Squadron home is the caller's, registered before creation and fail-closed if the caller's home no longer names an existing Squadron. Placement and provenance are recorded atomically with creation; then the first turn starts with the brief. The new agent's first turn also states its own participant id and Squadron as platform-provided facts, beside the brief and never inside it. Provider, model and reasoning are required and explicit even when a Role is given: a Role's allowlist constrains the choice and an out-of-list pick is an error naming the Role, never a silent default. The brief carries the task and the reply expectation; the spawner does not follow a spawn with a reply-expected `send_message` — that form is for later work owed by an existing participant. Selection guidance and brief-writing conventions live in the [Spawning Guide](../features/spawning-guide.md).

**Errors**, each naming state and next command: the caller's membership is missing or ambiguous; the caller's home no longer exists; creation failed.

**Events:** participant joined, home registered, placement created.

### `stop_agent`

**Description:** "Stop one Peer Agent: interrupts its running turn now. The agent remains, stays readable, and can be messaged again later — stopping halts work, it retires nothing. Requires your current squadron_id. Reuse client_request_id to retry safely."

| Input               | Type          | Required                    |
| ------------------- | ------------- | --------------------------- |
| `squadron_id`       | SquadronId    | yes — the caller's Squadron |
| `participant_id`    | ParticipantId | yes — the one agent to stop |
| `client_request_id` | string        | no                          |

**Result:** exactly one of `interrupt_requested` (a running turn is being interrupted) or `already_idle` (no running turn; no side effect). An interrupt acknowledgement and an observed terminal run state are separate facts; the tool never claims a turn stopped merely because interruption was requested. Anything else is an error naming the caller's actual Squadron and the corrected retry.

**Rules.** Stop and archive are single-target; the unit cascade belongs to Crews, which stop and archive as units through their own verbs when they exist. A stop is final across restarts: a committed stop wins even if the provider has not yet acknowledged it, so a stopped run is never resumed by upstream's restart continuation.

### `archive_agent`

**Description:** "Retire one Peer Agent for good. A clean archive — no open exchanges, no running turn — completes immediately. Otherwise the call refuses and lists exactly what archiving ends — the asks that will close, the turn that will stop — along with a confirmation_token; call again with that token to proceed. The archived agent leaves the active roster; its ledger and conversation stay readable forever. Requires your current squadron_id. Reuse client_request_id to retry safely."

| Input                | Type          | Required                       |
| -------------------- | ------------- | ------------------------------ |
| `squadron_id`        | SquadronId    | yes — the caller's Squadron    |
| `participant_id`     | ParticipantId | yes — the one agent to archive |
| `confirmation_token` | string        | only when confirming a refusal |
| `client_request_id`  | string        | no                             |

**Result:** exactly one of `archived` or `already_archived` (no side effect). A consequential target yields a refusal — an error carrying the list of consequences and a `confirmation_token` — never a partial outcome.

**Rules.** The quiet path archives immediately when nothing would be cut short. The loud path is a refusal listing the concrete consequences — the open Exchanges that will close as dropped, the running turn that will be interrupted — plus a token bound to that list: it proves the caller saw the consequences, so a preemptive flag on the first call cannot short-circuit the confirmation. If the target's state changed since the refusal, the stale token is rejected and a fresh refusal lists the current facts. A malformed or unknown token fails closed without disclosing the target's facts, and a token for one target never authorizes another. A partial failure across stores is forward-only: committed archive and ledger facts are re-read on retry, and `already_archived` requires both the participant's departure and completion of every terminal notice. The caller cannot archive itself.

**Errors**, each naming state and next command: not the caller's Squadron; unknown participant; consequential without a token (the refusal); stale or invalid token; self-target.

**Events:** the archive, and an obligation-closure event for each Exchange it ended — loud in the ledger, not only in the dialog.

### `clear_own_ask`

**Description:** "Withdraw an ask you sent: closes your open exchange without a reply message. Use when the answer already arrived outside the exchange — for example, the human answered you directly in your thread — so the obligation exits their inbox honestly. Only the exchange's sender may clear it; the closure is recorded as sender-cleared, distinct from an answered exchange. Reuse client_request_id to retry safely."

| Input               | Type       | Required                                        |
| ------------------- | ---------- | ----------------------------------------------- |
| `exchange_id`       | ExchangeId | yes — an Exchange the caller opened, still open |
| `client_request_id` | string     | no                                              |

**Result:** the closed Exchange's state — id, closure kind `sender-cleared`, closed-at.

**Errors**, each naming state and next command: the caller is not the Exchange's sender; the Exchange is already closed; unknown Exchange.

**Events:** an Exchange-closure event distinguishable from a reply's closure, so the inbox, the Exchange projections and the communication graph render the withdrawal honestly.

### Kept upstream tools

- `orchestrator_capabilities` — providers and models (ids, labels, option descriptors) for spawn targeting, plus runtime and interaction-mode facts. It no longer advertises app-owned subagents, child tasks, or delegation; J5 verbs are advertised by their own descriptions.
- `schedule_task`, `list_scheduled_tasks`, `update_scheduled_task`, `delete_scheduled_task` — consumed as-is.
- `t3_thread_list`, `t3_thread_read`, `t3_thread_wait` — consumed as-is; if an upstream description mentions delegation, J5 re-declares that tool with corrected prose.

## Acceptance criteria

1. Every J5 verb's shipped description string is byte-identical to the description in this definition.
2. A `send_message` to a person that is not an ask is refused with an error naming the legal move; an ask to a person without urgency is refused.
3. A further ask to a person opens a new Exchange and inbox item; an ask that names an open Exchange in `regarding` joins it and is shown beneath the original ask.
4. Between agents, a further ask to a peer holding an open Exchange from the caller joins it as a follow-up.
5. A `send_message` to the caller itself is refused with an error naming the caller's own id.
6. `list_participants` marks the caller's row `self`, reports a person's row as unable to receive a plain message and able to be asked, and omits threads without a Squadron home.
7. `spawn_agent` refuses a call that omits provider, model, or reasoning, and refuses a choice outside the Role's allowlist with an error naming the Role.
8. A spawned agent's first turn contains its own participant id and Squadron.
9. `stop_agent` and `archive_agent` act on exactly one agent; neither cascades; a stopped run is never resumed after a server restart, even when restart continuation is enabled.
10. `archive_agent` on a target with open Exchanges or a running turn refuses with the list of consequences and a token; the same call with that token archives; a stale token is refused with fresh facts.
11. `clear_own_ask` closes only an Exchange the caller opened and records the closure as sender-cleared.
12. Every error from every verb names the actual state and the next command.

## History

- 2026-08-29 — contracts adopted: descriptions as part of the contract, the toolsmith rule, single-target stop and archive, the confirmation-token archive ([record](../../worklog/substrate-session-2026-08-29.md)).
- 2026-08-30 — the spawn brief carries the task and the reply expectation; one sentence of brief steering in `spawn_agent` ([record](../../worklog/spawning-guide-session-2026-08-30.md)).
- 2026-08-31 — self-send refused; the `self` row; identity facts in the spawn's first turn; `display_name` on every row; `create_threads` and `t3_thread_start` omitted ([record](../../worklog/picker-and-self-messaging-rulings-2026-08-31.md)).
- 2026-09-02 — a person receives only asks and replies ([record](../../worklog/human-addressed-sends-ruling-2026-09-02.md)).
- 2026-09-08 — a person receives asks only; the reply form toward a person is retired with the person-originated ask.
- 2026-09-05 — several open asks per person, with explicit follow-ups through `regarding`, replacing the one-ask-per-person refusal of 2026-09-02 (issue #111).
- 2026-09-05 — a committed stop wins over restart continuation (upstream integration, PR #112).
- 2026-09-07 — rewritten from a stack of dated contract revisions into current-state contracts; every verb's build state true as of this date (all six verbs shipped; `regarding` and the person follow-up rule are issue #111).
