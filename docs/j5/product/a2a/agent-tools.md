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

**Description:** "Send one durable message. To another agent, three uses: a **plain send** when you don't need a reply; an **ask** — set expect_reply=true with a one-line intent, opening an exchange the receiver owes a reply to; a **reply** — include the exchange_id from the ask you are answering, which closes that exchange. To the human, only an ask: a plain send to a person is refused — if nobody needs to act, say it in your own thread instead. Set urgency only when asking the human. Use this tool only for participants already returned by list_participants; when creating a Peer Agent, put any reply expectation in spawn_agent's brief instead of sending a follow-up ask. Returns once the message is committed; delivery continues asynchronously — carry on with your work, and the reply arrives later as an incoming message. A caller without a registered home is refused. Reuse client_request_id to retry the same send safely."

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

**Description:** "Your address book: the participants around you — agents and the human — with the display name to recognize them by, the participant_id to address them with, and what each accepts (messages, exchanges, urgency). When you're told to message someone by name or role, resolve them here first. Your own row is marked self=true; it cannot receive messages or open exchanges from you — use schedule_task if you need a future trigger for yourself. Native threads that never received a Squadron home do not appear here and cannot be messaged. Archived agents are hidden by default; set include_archived=true to see them with archived=true. They cannot receive messages or open Exchanges. The roster changes — after you spawn, archive, unarchive, or delete an agent, call this again instead of reusing a stale listing."

| Input              | Type    | Required | Meaning                                                        |
| ------------------ | ------- | -------- | -------------------------------------------------------------- |
| `include_archived` | boolean | no       | Also list archived agents, each marked `archived`; default off |

Read-only; no events.

**Result rows:** `display_name` (the agent's thread title, or the Role name once Roles exist), `squadron_id`, `participant_id`, the participant kind, `self`, `archived`, `can_receive_message`, `can_open_exchange`, `accepts_urgency`, plus `provenance` (spawned by whom, forked from what, unrecorded, or not applicable for a person) and `placement_parent_id`. A person's row reports that it cannot receive a plain message and can be asked. A machine participant's row carries kind `machine`, its registered name as `display_name`, provenance `not-applicable`, and reports that it can receive nothing and open no Exchange. An archived agent's row, when requested, reports that it can receive nothing. Provenance and placement are carried for callers and the UI; they are not part of the description's pitch.

### `spawn_agent`

**Description:** "Spawn a Peer Agent: a full-citizen teammate with its own top-level thread, starting on your brief as its first turn. It joins your Squadron, is placed under you, and records you as its immutable spawner; it is addressable the moment this returns. In your brief, tell the new agent what it should do first and whether it should reply to you. Choose provider, model, and reasoning for the work in the brief — see orchestrator_capabilities for what's available. Reuse client_request_id to retry the same spawn safely."

**Description (contract):** "Spawn a Peer Agent: a full-citizen teammate with its own top-level
thread, starting on your brief as its first turn. It joins your Squadron, is placed under you, and
records you as its immutable spawner; it is addressable the moment this returns. In your brief,
tell the new agent what it should do first and whether it should reply to you. Choose provider,
model, and reasoning for the work in the brief — see orchestrator_capabilities for what's
available. To run a saved agent, set the `agent` parameter to its id: the spawn gets that saved
agent's instructions and runtime policy, and provider, model, and reasoning must be one of that
agent's declared routes. Reuse client_request_id to retry the same spawn safely."

| Input               | Type                                 | Required | Meaning                                           |
| ------------------- | ------------------------------------ | -------- | ------------------------------------------------- |
| `brief`             | string, non-empty                    | yes      | The first-turn prompt the new agent starts with   |
| `title`             | string                               | no       | Thread title; derived from the brief when omitted |
| `agent`             | saved agent id from the library      | no       | Role-ful spawn: the child carries that agent's    |
|                     |                                      |          | immutable assignment (SP3 below)                  |
| `provider`          | id from `orchestrator_capabilities`  | yes      | Chosen per task — no inherit default (Jackson,    |
|                     |                                      |          | 2026-08-29: inheriting is wrong more than right)  |
| `model`             | id from `orchestrator_capabilities`  | yes      | Chosen per task                                   |
| `reasoning`         | option from capabilities descriptors | yes      | Chosen per task                                   |
| `client_request_id` | string, non-empty                    | no       | Supply and reuse to make retries safe             |

**Rules.** The new agent is an ordinary root-lineage thread created through upstream's creation seam, never through delegation. Its Squadron home is the caller's, registered before creation and fail-closed if the caller's home no longer names an existing Squadron. Placement and provenance are recorded atomically with creation; then the first turn starts with the brief. The new agent's first turn also states its own participant id and Squadron as platform-provided facts, beside the brief and never inside it. Provider, model and reasoning are required and explicit even when a Role is given: a Role's allowlist constrains the choice and an out-of-list pick is an error naming the Role, never a silent default. The brief carries the task and the reply expectation; the spawner does not follow a spawn with a reply-expected `send_message` — that form is for later work owed by an existing participant. Selection guidance and brief-writing conventions live in the [Spawning Guide](../features/spawning-guide.md).

**Errors**, each naming state and next command: the caller's membership is missing or ambiguous; the caller's home no longer exists; the caller sits in a Crew (naming its Captain as the escalation and `delegate_task` for its own subagents; only a Captain grows a Crew, through the gate); creation failed.

**Events:** participant joined, home registered, placement created.

### `stop_agent`

**Role-ful spawn (built 2026-09-09, `agent` input):** the saved agent's declared routes are the
allowlist SP3 describes. The explicit provider/model/reasoning pick must equal one route target on
a provider instance that runs that driver and currently advertises the model and reasoning option;
otherwise the call refuses, naming the agent and listing its routes, and nothing is created. The
matching route becomes the child's immutable persona assignment (same snapshot and digest as a
composer launch), and its authority policy sets the child's runtime mode. The child's permissions
come from its own saved agent's policy, never from the parent's: J5 carries no parent-child
permission ceiling between Peer Agents (Jackson, 2026-09-16), since any such guard is one message
to a trusting peer away from bypass. Disabled, removed, and unknown agents refuse before creation.
A plain spawn without `agent` is unchanged and inherits the parent's runtime mode as before.

**Description:** "Stop one Peer Agent: interrupts its running turn now. The agent remains, stays readable, and can be messaged again later — stopping halts work, it retires nothing. Requires your current squadron_id. Reuse client_request_id to retry safely."

| Input               | Type          | Required                    |
| ------------------- | ------------- | --------------------------- |
| `squadron_id`       | SquadronId    | yes — the caller's Squadron |
| `participant_id`    | ParticipantId | yes — the one agent to stop |
| `client_request_id` | string        | no                          |

**Result:** exactly one of `interrupt_requested` (a running turn is being interrupted) or `already_idle` (no running turn; no side effect). An interrupt acknowledgement and an observed terminal run state are separate facts; the tool never claims a turn stopped merely because interruption was requested. Anything else is an error naming the caller's actual Squadron and the corrected retry.

**Rules.** A caller's runtime policy never gates `stop_agent`, `archive_agent`, or `archive_crew`: a read-only persona may run them, because identity (the Captain, its own Crew) and the human's confirmation token are the gates, and the sandbox guards the workspace rather than the platform's verbs (Bryant, 2026-09-14). Stop and archive are single-target; the unit cascade belongs to Crews, which stop and archive as units through their own verbs when they exist. A stop is final across restarts: a committed stop wins even if the provider has not yet acknowledged it, so a stopped run is never resumed by upstream's restart continuation.

### `archive_agent`

**Description:** "Archive one Peer Agent reversibly. Unarchive restores the same identity, but does not reopen Exchanges or replay cancelled messages. A clean archive — no open exchanges, no running turn — completes immediately. Otherwise the call refuses and lists exactly what archiving ends — the asks that will close, the turn that will stop — along with a confirmation_token; call again with that token to proceed. The archived agent leaves the active roster; its ledger and conversation stay readable forever. Requires your current squadron_id. Reuse client_request_id to retry safely."

| Input                | Type          | Required                       |
| -------------------- | ------------- | ------------------------------ |
| `squadron_id`        | SquadronId    | yes — the caller's Squadron    |
| `participant_id`     | ParticipantId | yes — the one agent to archive |
| `confirmation_token` | string        | only when confirming a refusal |
| `client_request_id`  | string        | no                             |

**Result:** exactly one of `archived` or `already_archived` (no side effect). A consequential target yields a refusal — an error carrying the list of consequences and a `confirmation_token` — never a partial outcome.

**Rules.** The quiet path archives immediately when nothing would be cut short. The loud path is a refusal listing the concrete consequences — the open Exchanges that will close as dropped, the running turn that will be interrupted — plus a token bound to that list: it proves the caller saw the consequences, so a preemptive flag on the first call cannot short-circuit the confirmation. If the target's state changed since the refusal, the stale token is rejected and a fresh refusal lists the current facts. A malformed or unknown token fails closed without disclosing the target's facts, and a token for one target never authorizes another. A partial failure across stores is forward-only: committed archive and ledger facts are re-read on retry, and `already_archived` requires both the archive fact and completion of every terminal notice. The caller cannot archive itself.

Archiving is reversible and deletion is not. A person can unarchive an archived agent, which restores the same participant id, Squadron home, placement and provenance and makes it addressable again; the Exchanges that archiving closed stay closed, and deliveries that archiving cancelled are not replayed. Deleting an agent is a separate, permanent act that only a person performs; no agent verb deletes.

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

### `list_squadrons`

**Description:** "The Squadron directory for this environment: every Squadron's squadron_id, name, and the project ids it references, plus your own thread's project id so you can see which Squadron can home you. Use it to obtain the exact squadron_id before join_squadron. Read-only."

No inputs. Read-only; no events. Callable by a thread that has no Squadron home — the one listing verb that is, because it exists to bootstrap `join_squadron`.

**Result:** `caller_project_id` and `squadrons[]`, each with `squadron_id`, `name` and `project_ids`. The verb states facts and never picks: the caller compares the project ids against its own.

### `join_squadron`

**Description:** "Join a Squadron when your thread has no Squadron home yet. Pass the exact squadron_id, taken from list_squadrons; that Squadron must reference your thread's project. Your thread, conversation, worktree, and running work stay exactly as they are. Calling it again for the Squadron you already belong to returns your existing registration. Reuse client_request_id to retry safely. Warning: you cannot switch Squadrons once you're assigned, be sure you're joining the right one."

| Input               | Type       | Required | Meaning                                                               |
| ------------------- | ---------- | -------- | --------------------------------------------------------------------- |
| `squadron_id`       | SquadronId | yes      | An existing Squadron, chosen explicitly; never inferred from a folder |
| `client_request_id` | string     | no       | Reuse to retry safely                                                 |

**Result:** `squadron_id`, `participant_id`, `thread_id`, and the placement: at the Squadron root, with provenance recorded as unrecorded, because nothing spawned or forked a native thread.

**Rules.** The verb acts on the calling thread only and exists for exactly one case: a native thread that was created with no Squadron home ([Squadron](../features/squadron.md)). It establishes an original home; it is never a move, a leave, or a revival. The thread, its provider session, its worktree and any running turn are untouched — no new thread, no injected task, no interrupt. A thread already homed in the requested Squadron gets its existing registration back. Registration and placement commit in one transaction, and a retry with the same `client_request_id`, or concurrent retries with different ids, commit exactly one joined event.

**Errors**, each naming state and next command: the thread is archived or deleted; the thread already has a home in a different Squadron; the thread's identity was retired; the Squadron does not reference the thread's project; unknown Squadron.

**Events:** participant joined, placement created.

### `list_agents`

**Description (contract):** "List the saved agents in this environment: id, purpose, runtime
policy, whether each can start now, and the provider, model, and reasoning it would run on. Read
this before choosing an agent for spawn_agent or a crew roster so the choice fits the task and
the user's budget. Read-only."

No inputs. Result: `agents[]` with `id`, `display_name`, `description`, `runtime_policy`,
`availability` (`available`, `blocked`, `disabled`) and `route` (driver · model · reasoning, or
null when blocked). The same catalog Settings → Agents shows; disabled imports read as disabled,
unroutable or unenforceable agents as blocked. This is the P-B(a) spawn listing the spawning guide
asked for.

### `propose_crew`

**Description (contract):** "Propose the crew you need for the brief you were given. Use it when
the user asks for a crew or the work splits into distinct responsibilities that should run at
once. Call list_agents first and pick one agent per seat, or leave agent unset for a custom seat
that runs on your own provider and model with only its instructions and the brief; name the crew
for what it is for and give each seat a short lowercase-hyphen name like code-reviewer. The user reviews the roster in this
thread, may remove or add seats, and approves or declines; you receive the decision and the roster
as a message here. Approved seats run with their own agent's permissions, which may exceed yours.
You become the crew's Captain and may command several crews at once; later requests, stops, and
archives name the crew they mean. Reuse client_request_id to retry safely. This call is itself the
human gate, so it works under every sandbox and approval policy, including approval policy never;
never refuse the brief because approvals are disabled."

Published as non-destructive (`destructiveHint: false`): the call records a pending request and
nothing spawns until a human approves it.

| Input               | Type                                            | Required | Meaning                                                                      |
| ------------------- | ----------------------------------------------- | -------- | ---------------------------------------------------------------------------- |
| `name`              | string                                          | yes      | The Crew's display name                                                      |
| `brief`             | string                                          | yes      | What every seat starts on, verbatim                                          |
| `seats`             | 1–12 of `{seat, agent?, reason, instructions?}` | yes      | Seat name, agent id from `list_agents` (none for a custom seat), why, wiring |
| `client_request_id` | string                                          | no       | Supply and reuse to make retries safe                                        |

Bounds: `name` and `seat` up to 100 characters, `reason` up to 500, `brief` and `instructions` up
to 8,000.

Result: `proposal_id`, `status` (`open`, `approving`, `declining`, `approved`, `declined`),
`crew_instance_id`, and `members` (seat, agent_id, participant_id, thread_id) once spawned.
Semantics: the caller must have a usable home and must not sit in a Crew (R20). Seats are validated
against the library before anything is recorded: unknown or disabled agents, duplicate seat names,
or more than twelve seats refuse with the next step. An open roster proposal waits for the human
gate inline above the Captain's composer (additions wait in the Inbox); approval spawns the approved roster (the human may have edited it) as persona-backed Peer
Agents under the caller, records the Crew snapshot with each member's approver and reason, and posts
a `<j5_crew_gate>` launch report into the caller's thread once every seat has started or failed to start (or a minute has passed): the roster, what the user changed against the proposal, and per seat `start=started|failed|pending`, with a `seat_failed` line carrying the run's error. Declines post the decline at once.
Human approval is the authority (Bryant, 2026-09-10): seats run with their own agent's runtime
policy, so a read-only Captain may command writing seats once a person approved them; a seat's
permissions never come from its Captain's.
There is no auto-approval: the earlier `runbook_declared` column and `auto_approved` status were
cut before shipping, since nothing wrote them and runbooks do not exist yet.

### `request_crew_member`

**Description (contract):** "Ask the user to add one seat to a crew you command when the work
needs one the roster lacks: seat name, agent id from list_agents (or none for a custom seat that
runs on your provider and model), a one-line reason, and optionally instructions and a brief for
the new seat. The user decides from their inbox; you receive the decision and the updated roster as
a message here and can keep working meanwhile. Captain-only; a member escalates to its Captain.
Reuse client_request_id to retry safely. Filing the request is the human gate itself and works
under every approval policy, including approval policy never."

| Input               | Type   | Required | Meaning                                                        |
| ------------------- | ------ | -------- | -------------------------------------------------------------- |
| `crew_instance_id`  | string | no       | Required only when the caller commands more than one live Crew |
| `seat`, `agent`     | string | yes      | New seat name and agent id                                     |
| `reason`            | string | yes      | One line the human reads before approving                      |
| `brief`             | string | no       | The new seat's brief; the Crew's brief when omitted            |
| `instructions`      | string | no       | Seat wiring text, verbatim                                     |
| `client_request_id` | string | no       | Supply and reuse to make retries safe                          |

Result: as `propose_crew`. Semantics: the caller must command the Crew; the seat name must be new;
the cap counts current members plus seats in other open requests for the same Crew. Approval
reserves the seat inside one store transaction (count, cap, version bump, and ordinal decided
together under an optimistic version check, so two approvals landing at once cannot both pass),
then spawns the seat under the Captain and posts the updated roster to the Captain. Seat ids are
deterministic, so a retry after a failed spawn finds its reservation and converges.

### Handoffs in Crews

There is no Crew-specific artifact verb. A seat whose definition declares an output artifact writes
it with the project `write_artifact` tool to the same handoff file every saved agent writes
(`handoffs/<agent>/<Artifact>-<task>.md`, see the [persona contract](../agent-personas/index.md));
its first turn carries `<seat_obligation>` naming that exact path. The handoff gate checks for the
file when a run ends and reminds the seat once. When a seat finishes, the seat finish notifier posts
one platform-composed `<j5_seat_finished>` notice per finished run into the Captain's thread: the seat,
its participant and thread ids, the run status (completed, failed, or cancelled), and the handoff
as `written`, `missing`, or `none declared` with its path; a written handoff up to 4,000
characters rides inline, longer ones name the path for the project `read_artifact` tool. Ids
derive from the run, so a redelivered event cannot post twice. Read-only Codex and Claude personas have `write_artifact` pre-approved for this reason, and `delegate_task` with `task_status` and `task_cancel` beside it, because a Crew member refused `spawn_agent` is sent to provider-native Subagents and a verb the sandbox then rejects is no way out:
handoffs live in application storage, never in the sandboxed workspace. (Withdrawn on 2026-09-14:
the 2026-09-10 `deliver_artifact` verb, its ledger table, and the crew-only `read_artifact` and
`list_artifacts`, which collided with the project artifact toolkit's names.)

### `stop_crew`

**Description (contract):** "Stop a Crew you command: interrupts the running turn of every seat
now. Nothing settles or is retired, and every seat can be messaged again afterwards. Captain-only.
Reuse client_request_id to retry safely."

| Input               | Type              | Required | Meaning                                        |
| ------------------- | ----------------- | -------- | ---------------------------------------------- |
| `squadron_id`       | SquadronId        | yes      | The caller's current Squadron                  |
| `crew_instance_id`  | string            | yes      | The id from the `<j5_crew_gate>` roster notice |
| `client_request_id` | string, non-empty | no       | Supply and reuse to make retries safe          |

Result: `crew_instance_id` and `members` (seat, participant_id, result: `interrupt_requested`,
`already_idle`, or `archived`). Semantics: the unit form of `stop_agent`. Only the Captain may call
it; anyone else is refused and pointed at asking the Captain; an archived Crew is refused naming
its state. Every seat with a run in flight is interrupted through the ordinary single-agent stop
(so a committed stop wins over restart continuation here too); idle seats are reported as such and
left alone; nothing settles, nothing is retired, no Exchange closes, and the seats stay addressable.
The person has the same act as a **Stop crew** control on the Crew's header on the Fleet page and on
the Captain's expander in the sidebar, shown only while a seat is running; it is not a Crew
participant, so no Captain check applies to it (Bryant, 2026-09-14).

### `archive_crew`

**Description (contract):** "Retire a whole Crew you command. Crews archive only as a unit —
members are never retired one by one. A clean archive completes immediately; otherwise the call
refuses with the facts and a confirmation_token. Before retrying with that token, check with the
user. Nothing is destroyed: worktrees, branches, and ledgers stay readable. Reuse
client_request_id to retry safely."

| Input                | Type              | Required | Meaning                                              |
| -------------------- | ----------------- | -------- | ---------------------------------------------------- |
| `squadron_id`        | SquadronId        | yes      | The caller's current Squadron                        |
| `crew_instance_id`   | string            | yes      | The id from the `<j5_crew_gate>` roster notice       |
| `confirmation_token` | string            | no       | Token from the refusal; confirms exactly those facts |
| `client_request_id`  | string, non-empty | no       | Supply and reuse to make retries safe                |

Result: `status` (`archived` or `already_archived`), `crew_instance_id`, and `members` (seat,
participant_id, per-member result). Semantics: only the Captain — the participant that launched the
Crew — may archive it (R19); anyone else is refused and pointed at asking the Captain. Facts are
read for every member before anything happens. If any member has an open Exchange or a running
turn, the call refuses with a per-seat list (`members[].open_exchanges`, `members[].running_turn`,
`already_archived`) and a signed `confirmation_token` over exactly those facts. With a matching
token, members retire in seat order through the ordinary single-agent archive with their own
confirmation already satisfied (interrupt, thread archive, participant retirement, loud Exchange
terminations to every waiter), then the Crew record is marked archived. A token stays valid when
the current facts are a subset of the confirmed ones, so a retry after a partial failure finishes
the job; new work on any seat makes it stale and yields a fresh token. Partial failures name the
seats retired so far and the seat that failed; retry with the same `client_request_id` and token.

**Members are never archived one by one (R14):** `archive_agent` refuses a target that sits in a
Crew and names the `archive_crew` call to make instead. A member that finishes with nothing owed is
reported to its Captain; the platform settles no seat, and settlement is not archive. `stop_agent` on a member is still allowed;
stopping retires nothing.

### Kept upstream tools

- `orchestrator_capabilities` — providers and models (ids, labels, option descriptors) for spawn targeting, plus runtime and interaction-mode facts. It deliberately stays silent about delegation even though `delegate_task` is back on the surface: that tool's own description carries its saved-agent use, and J5 verbs are advertised by their own descriptions.
- `delegate_task`, `task_status`, `task_cancel` — upstream's provider-owned child delegation. J5 re-declares `delegate_task` with its own description, which leads with the optional `agent` (a saved agent id from an `@agent:ID` mention or the Settings → Agents library) and presents the plain child as the fallback for cross-provider or T3-tracked work rather than the default for any subagent request. With `agent`, the server pins that agent's instructions, model route, reasoning, and runtime policy and refuses `target` and `runtimeMode`; without it, the child is upstream's plain subagent. The child is backing storage under the calling thread, not a Peer Agent; use `spawn_agent` for a participant. Its wait mode is safe where `t3_thread_wait` was not: a child that messages its parent ends its own turn, so the wait returns and the parent reads the message on its next turn (latency, never starvation).
- `schedule_task`, `list_scheduled_tasks`, `update_scheduled_task`, `delete_scheduled_task` — consumed as-is.
- `t3_thread_list`, `t3_thread_read` — consumed as-is; if an upstream description mentions delegation, J5 re-declares that tool with corrected prose.
- `t3_thread_wait` is **withdrawn** from the J5 surface. Platform notices queue behind a running turn, so a participant that blocks inside its turn waiting on another thread can never receive the notice that thread's finish produces; a Captain that waited on a seat this way starved itself of its own Crew's news (Bryant, 2026-09-14). Whatever a participant is waiting for arrives as a message once it ends its turn.

## Acceptance criteria

1. Every J5 verb's shipped description string is byte-identical to the description in this definition.
2. A `send_message` to a person that is not an ask is refused with an error naming the legal move; an ask to a person without urgency is refused.
3. A further ask to a person opens a new Exchange and inbox item; an ask that names an open Exchange in `regarding` joins it and is shown beneath the original ask.
4. Between agents, a further ask to a peer holding an open Exchange from the caller joins it as a follow-up.
5. A `send_message` to the caller itself is refused with an error naming the caller's own id.
6. `list_participants` marks the caller's row `self`, reports a person's row as unable to receive a plain message and able to be asked, and omits threads without a Squadron home.
7. `spawn_agent` refuses a call that omits provider, model, or reasoning, refuses a choice outside the Role's allowlist with an error naming the Role, and refuses a caller that sits in a Crew with an error naming escalation to its Captain.
8. A spawned agent's first turn contains its own participant id and Squadron.
9. `stop_agent` and `archive_agent` act on exactly one agent; neither cascades; a stopped run is never resumed after a server restart, even when restart continuation is enabled.
10. `archive_agent` on a target with open Exchanges or a running turn refuses with the list of consequences and a token; the same call with that token archives; a stale token is refused with fresh facts.
11. `clear_own_ask` closes only an Exchange the caller opened and records the closure as sender-cleared.
12. Every error from every verb names the actual state and the next command.
13. `list_participants` omits archived agents unless `include_archived` is set, and then marks each one `archived` and unable to receive a message or an ask.
14. Unarchiving an archived agent restores the same participant id, Squadron home, placement and provenance and makes it addressable again; the Exchanges archiving closed stay closed and no cancelled delivery is replayed.
15. `list_squadrons` can be called by a thread with no Squadron home and returns every Squadron with its project ids and the caller's own project id.
16. `join_squadron` establishes a home only for a thread that has none, only in a Squadron that references the thread's project, leaves the thread and its running work untouched, returns the existing registration when the thread is already homed there, and refuses a thread homed elsewhere, an archived or deleted thread, and a retired identity.
17. `list_agents` returns every saved agent with its availability and route; `propose_crew` and `request_crew_member` file a human gate and refuse unknown, disabled, duplicate, or over-cap seats before anything is recorded; both succeed under every sandbox and approval policy, including Codex approval policy `never`.
18. Approving a proposal spawns exactly once; a second approval finds it claimed; a spawn that fails after reserving its seats reopens the gate, and the retry converges on those seats.
19. `archive_crew` is Captain-only, refuses with per-seat facts and a token when any seat has an open Exchange or a running turn, and finishes a partial archive on retry; `archive_agent` refuses a Crew member and a Captain of a live Crew, naming the `archive_crew` call.
20. `stop_crew` is Captain-only, interrupts every seat with a running turn and reports each seat as interrupted, already idle, or archived; it settles, retires, and closes nothing, and a non-Captain or an archived Crew is refused naming the next step. The person's Stop crew control does the same through the operate scope.

## History

- 2026-08-29 — contracts adopted: descriptions as part of the contract, the toolsmith rule, single-target stop and archive, the confirmation-token archive ([record](../../worklog/2026-08-29-substrate-session.md)).
- 2026-08-30 — the spawn brief carries the task and the reply expectation; one sentence of brief steering in `spawn_agent` ([record](../../worklog/2026-08-30-spawning-guide-session.md)).
- 2026-08-31 — self-send refused; the `self` row; identity facts in the spawn's first turn; `display_name` on every row; `create_threads` and `t3_thread_start` omitted ([record](../../worklog/2026-08-31-picker-and-self-messaging-rulings.md)).
- 2026-09-02 — a person receives only asks and replies ([record](../../worklog/2026-09-02-human-addressed-sends-ruling.md)).
- 2026-09-08 — a person receives asks only; the reply form toward a person is retired with the person-originated ask.
- 2026-09-05 — several open asks per person, with explicit follow-ups through `regarding`, replacing the one-ask-per-person refusal of 2026-09-02 (issue #111).
- 2026-09-13 — the `send_message` description is the shipped string, which a test pins byte-for-byte to this definition; the sentence teaching `regarding` joins it when #111 ships, and the stale "or a reply" toward a person is removed from the runtime string.
- 2026-09-05 — a committed stop wins over restart continuation (upstream integration, PR #112).
- 2026-09-12 — archiving is reversible: unarchive restores the same identity without reopening Exchanges; deletion is a separate permanent act for people only; the address book hides archived agents unless asked (PR #132).
- 2026-09-12 — `list_squadrons` and `join_squadron` added for the one case of a native thread with no home (issue #129, PR #131).
- 2026-09-07 — rewritten from a stack of dated contract revisions into current-state contracts; every verb's build state true as of this date (all six verbs shipped; `regarding` and the person follow-up rule are issue #111).
- 2026-09-09 — `list_agents`, `propose_crew`, `request_crew_member`, and `archive_crew`: Crews composed at launch through a human gate ([record](../../worklog/2026-09-14-crews-consolidation.md)).
- 2026-09-10 — human approval is the authority for seat access; proposals and requests pre-approved for Codex under approval policy `never`; `deliver_artifact` added.
- 2026-09-14 — lifecycle verbs stay available to read-only personas by decision (Sentry S-4 closed).
- 2026-09-14 — `deliver_artifact` and the crew-only artifact reads withdrawn in favor of the shared handoff files; Codex pre-approval narrowed to a per-tool list; `archive_agent` refuses Captains of live Crews ([record](../../worklog/2026-09-14-crews-consolidation.md)).
- 2026-09-14 — `t3_thread_wait` withdrawn: blocking inside a turn starves a participant of the queued notices it is waiting for ([record](../../worklog/2026-09-14-crews-consolidation.md)).
- 2026-09-14 — `stop_crew`: the unit form of stop for the Captain over MCP and for the person as a Stop crew control; interrupts running seats only ([record](../../worklog/2026-09-14-crews-consolidation.md)).
- 2026-09-14 — `delegate_task`, `task_status`, and `task_cancel` return to the J5 surface, with a saved-agent `agent` parameter on `delegate_task` replacing the J5-only `invoke_agent` ([review](https://github.com/Jacksondr5/j5code/pull/124#issuecomment-5663559782)).
- 2026-09-15 — machine participants appear in `list_participants` as named senders that receive nothing (issue #74).
